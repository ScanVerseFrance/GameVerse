// =====================================================================
//  hook_d3d9.cpp — IDirect3DDevice9::Present hook
//
//  D3D9 lifecycle :
//    IDirect3DDevice9 vtable (excerpt) :
//      [16] Reset
//      [17] Present
//      [42] EndStateBlock
//
//  We grab the vtable by spinning a temporary 1×1 hidden device,
//  then MinHook patches the slot. Same pattern as the DXGI hook.
//
//  Phase 1 vs Phase 2 — comme hook_dxgi.cpp, on supporte les deux :
//    Phase 1 (ImGui interne)  : utilisé en fallback quand le pipe
//                                des frames Electron n'est pas
//                                connecté (dev mode sans Electron).
//                                On dessine la vieille UI ImGui via
//                                nexus::renderer::draw_frame().
//    Phase 2 (React composite) : quand frame_pipe::is_connected(),
//                                on upload les pixels BGRA reçus
//                                d'Electron dans un IDirect3DTexture9
//                                (D3DUSAGE_DYNAMIC, A8R8G8B8) et on
//                                le draw en fullscreen via
//                                ImDrawList::AddImage. C'est la vraie
//                                UI Nexus que l'user voit.
//
//  D3D9 reste rare en 2026 mais critique pour les jeux pré-2014 :
//  LEGO série, Skyrim original, GTA IV (D9), tous les Source 1, etc.
// =====================================================================
#include "hook_d3d9.h"
#include "../renderer.h"
#include "../overlay_state.h"
#include "../nlog.h"
#include "../ipc.h"
#include "../frame_pipe.h"
#include "../borderless.h"

#include <windows.h>
#include <d3d9.h>
#include <wrl/client.h>
#include <atomic>
#include <cstdio>
#include <cstring>

#include "MinHook.h"
#include "imgui.h"
#include "backends/imgui_impl_win32.h"
#include "backends/imgui_impl_dx9.h"

using Microsoft::WRL::ComPtr;

// imgui_impl_win32 expose ce handler global ; il faut sa déclaration
// avant overlay_wndproc pour qu'ImGui voie les inputs Phase 1.
extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND, UINT, WPARAM, LPARAM);

namespace nexus::hooks {

namespace {

using PresentFn = HRESULT (WINAPI*)(IDirect3DDevice9*, const RECT*, const RECT*,
                                    HWND, const RGNDATA*);
using ResetFn   = HRESULT (WINAPI*)(IDirect3DDevice9*, D3DPRESENT_PARAMETERS*);

PresentFn g_orig_present = nullptr;
ResetFn   g_orig_reset   = nullptr;

bool    g_imgui_initialized = false;
HWND    g_game_hwnd       = nullptr;
WNDPROC g_orig_wndproc    = nullptr;
ComPtr<IDirect3DDevice9> g_device;

// ── Phase 2 React texture state ────────────────────────────────────
// Le pipeline DXGI utilise un texture_renderer_dx11 standalone (shader
// fullscreen quad), mais pour D3D9 on réutilise la stack ImGui : on
// upload les pixels dans un IDirect3DTexture9 dynamique et on demande
// à ImDrawList::AddImage de le draw. Coût négligeable, code minuscule.
IDirect3DTexture9* g_react_texture = nullptr;
uint32_t g_react_tex_w  = 0;
uint32_t g_react_tex_h  = 0;
uint32_t g_last_frame_id = 0;

// Viewport courant — capturé depuis le swap chain à chaque Present.
// Servi à Electron dans le payload input (vw/vh) pour le coord mapping
// React (offscreen) ↔ game viewport. Atomics car écrit dans le hook
// thread et lu dans la WndProc subclass.
std::atomic<uint32_t> g_d9_viewport_w{1920};
std::atomic<uint32_t> g_d9_viewport_h{1080};

// Diagnostic frame counter — logue toutes les 60 frames pour qu'on
// sache que le hook tourne (pareil que hook_dxgi.cpp).
std::atomic<uint64_t> g_d9_frame_counter{0};
std::atomic<bool>     g_d9_last_visible{false};

// ── Phase 2 input forwarding (copie du pattern DXGI) ───────────────
// Convertit un message Win32 en envelope JSON et push via le pipe
// async. Identique au forward_input_to_electron de hook_dxgi.cpp.
void forward_input_to_electron(UINT msg, WPARAM wp, LPARAM lp) {
    char buf[384];
    int x = (int)(short)LOWORD(lp);
    int y = (int)(short)HIWORD(lp);
    uint32_t vw = g_d9_viewport_w.load();
    uint32_t vh = g_d9_viewport_h.load();
    // Skip mouse — déjà envoyé par key_poll_thread_proc (dllmain.cpp).
    // Sans ce skip, chaque clic est dispatché 2x à React → toggle button
    // s'ouvre puis se referme immédiatement. Voir hook_dxgi.cpp pour les
    // détails. La WndProc subclass continue à SWALLOW les mouse messages
    // (return 0 plus bas) pour que le jeu ne les voie pas.
    switch (msg) {
        case WM_MOUSEMOVE:
        case WM_LBUTTONDOWN: case WM_LBUTTONDBLCLK: case WM_LBUTTONUP:
        case WM_RBUTTONDOWN: case WM_RBUTTONDBLCLK: case WM_RBUTTONUP:
        case WM_MBUTTONDOWN: case WM_MBUTTONDBLCLK: case WM_MBUTTONUP:
        case WM_XBUTTONDOWN: case WM_XBUTTONDBLCLK: case WM_XBUTTONUP:
        case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
            (void)buf; (void)x; (void)y; (void)vw; (void)vh;
            return;
        default: break;
    }
    switch (msg) {
        case WM_MOUSEMOVE:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseMove","x":%d,"y":%d,"vw":%u,"vh":%u})",
                x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_LBUTTONDOWN: case WM_LBUTTONDBLCLK:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseDown","x":%d,"y":%d,"button":"left","vw":%u,"vh":%u})",
                x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_LBUTTONUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseUp","x":%d,"y":%d,"button":"left","vw":%u,"vh":%u})",
                x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_RBUTTONDOWN: case WM_RBUTTONDBLCLK:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseDown","x":%d,"y":%d,"button":"right","vw":%u,"vh":%u})",
                x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_RBUTTONUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseUp","x":%d,"y":%d,"button":"right","vw":%u,"vh":%u})",
                x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_MBUTTONDOWN: case WM_MBUTTONDBLCLK:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseDown","x":%d,"y":%d,"button":"middle","vw":%u,"vh":%u})",
                x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_MBUTTONUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseUp","x":%d,"y":%d,"button":"middle","vw":%u,"vh":%u})",
                x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_MOUSEWHEEL: {
            short delta = GET_WHEEL_DELTA_WPARAM(wp);
            POINT pt = { x, y };
            if (g_game_hwnd) ScreenToClient(g_game_hwnd, &pt);
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseWheel","x":%ld,"y":%ld,"deltaY":%d})",
                pt.x, pt.y, (int)delta);
            nexus::ipc::send_event_async(buf);
            break;
        }
        case WM_KEYDOWN: case WM_SYSKEYDOWN:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"keyDown","keyCode":"VK_%lu"})",
                (unsigned long)wp);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_KEYUP: case WM_SYSKEYUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"keyUp","keyCode":"VK_%lu"})",
                (unsigned long)wp);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_CHAR: case WM_SYSCHAR:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"char","keyCode":"%lu"})",
                (unsigned long)wp);
            nexus::ipc::send_event_async(buf);
            break;
        default: break;
    }
}

LRESULT CALLBACK overlay_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    const bool overlay_visible = nexus::OverlayState::instance().visible();
    const bool phase2_active   = nexus::frame_pipe::is_connected();

    // Anti pause-on-focus-loss SURGICAL — voir hook_dxgi.cpp pour la
    // doc complète. Seul WM_ACTIVATEAPP=FALSE est forgé en TRUE pour
    // que la game loop ne pause pas. Le reste (WM_ACTIVATE,
    // WM_NCACTIVATE, WM_KILLFOCUS) passe normalement pour ne pas
    // casser l'alt-tab au niveau OS.
    if (msg == WM_ACTIVATEAPP && wp == FALSE) {
        return CallWindowProcW(g_orig_wndproc, hwnd, msg, TRUE, lp);
    }

    // Phase 1 : laisser ImGui consommer les inputs avant le jeu.
    if (!phase2_active) {
        if (ImGui::GetCurrentContext() != nullptr) {
            LRESULT r = ImGui_ImplWin32_WndProcHandler(hwnd, msg, wp, lp);
            if (r != 0 && overlay_visible) return r;
        }
    }

    if (overlay_visible) {
        // Phase 2 : forward à Electron pour que React reçoive l'event
        // via sendInputEvent / executeJavaScript dans la window
        // offscreen.
        if (phase2_active) {
            forward_input_to_electron(msg, wp, lp);
        }
        // Hard-swallow les inputs gameplay pour qu'ils n'atteignent
        // JAMAIS le jeu pendant que l'overlay est ouvert. Sinon le
        // perso bouge derrière, on tire avec le clic gauche, etc.
        switch (msg) {
            case WM_KEYDOWN: case WM_KEYUP:
            case WM_SYSKEYDOWN: case WM_SYSKEYUP:
            case WM_CHAR: case WM_DEADCHAR:
            case WM_SYSCHAR: case WM_SYSDEADCHAR:
            case WM_UNICHAR: case WM_IME_CHAR:
            case WM_IME_COMPOSITION:
            case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_LBUTTONDBLCLK:
            case WM_RBUTTONDOWN: case WM_RBUTTONUP: case WM_RBUTTONDBLCLK:
            case WM_MBUTTONDOWN: case WM_MBUTTONUP: case WM_MBUTTONDBLCLK:
            case WM_XBUTTONDOWN: case WM_XBUTTONUP: case WM_XBUTTONDBLCLK:
            case WM_MOUSEMOVE: case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
            case WM_INPUT:
                return 0;
            default: break;
        }
    }
    return CallWindowProcW(g_orig_wndproc, hwnd, msg, wp, lp);
}

void install_wndproc_hook(HWND hwnd) {
    if (g_orig_wndproc || !hwnd) return;
    g_game_hwnd = hwnd;
    g_orig_wndproc = reinterpret_cast<WNDPROC>(
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC,
                          reinterpret_cast<LONG_PTR>(overlay_wndproc)));
    nexus::nlog::log("[d3d9] WndProc subclassed on HWND %p", (void*)hwnd);
    // Active le force-borderless dès qu'on a une HWND. Le watcher
    // appliquera le style change au prochain tick. Pas d'effet si
    // NEXUS_DISABLE_BORDERLESS=1 dans l'env du jeu.
    nexus::borderless::set_target_hwnd(hwnd);
}

void init_imgui(HWND hwnd, IDirect3DDevice9* device) {
    if (g_imgui_initialized) return;
    if (!ImGui::GetCurrentContext()) {
        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        ImGui::StyleColorsDark();
        ImGuiIO& io = ImGui::GetIO();
        io.IniFilename = nullptr;
        io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
        // Curseur software ImGui — le jeu D3D9 capture souvent le
        // curseur OS, donc on dessine le nôtre. Visible uniquement
        // dans la frame ImGui Phase 1/2, ce qui est exactement quand
        // on en a besoin.
        io.MouseDrawCursor = true;
    }
    ImGui_ImplWin32_Init(hwnd);
    ImGui_ImplDX9_Init(device);
    g_imgui_initialized = true;
    nexus::nlog::log("[d3d9] ImGui initialized");
}

// Capture la résolution du backbuffer pour qu'Electron puisse mapper
// les coords React (offscreen) → viewport jeu. On lit GetSwapChain(0)
// puis GetPresentParameters — la swap chain par défaut est créée par
// le device et survit aux Reset (sauf si le jeu en crée d'autres).
void capture_viewport(IDirect3DDevice9* device) {
    ComPtr<IDirect3DSwapChain9> sc;
    if (FAILED(device->GetSwapChain(0, &sc)) || !sc) return;
    D3DPRESENT_PARAMETERS pp{};
    if (FAILED(sc->GetPresentParameters(&pp))) return;
    if (pp.BackBufferWidth)  g_d9_viewport_w.store(pp.BackBufferWidth);
    if (pp.BackBufferHeight) g_d9_viewport_h.store(pp.BackBufferHeight);
}

// Phase 2 : upload des pixels React fraîchement reçus du pipe dans
// un IDirect3DTexture9 dynamique. Reuse le même texture si la taille
// n'a pas changé (cas commun — la fenêtre Electron offscreen garde
// sa résolution).
void update_react_texture(IDirect3DDevice9* device) {
    nexus::frame_pipe::Frame frame;
    if (!nexus::frame_pipe::pop_frame(frame, g_last_frame_id)) return;
    if (frame.width == 0 || frame.height == 0 || frame.rgba.empty()) return;

    // (Re)create si dim changée OU si on a perdu la texture (post-Reset).
    if (g_react_texture == nullptr ||
        g_react_tex_w != frame.width ||
        g_react_tex_h != frame.height) {
        if (g_react_texture) {
            g_react_texture->Release();
            g_react_texture = nullptr;
        }
        HRESULT hr = device->CreateTexture(
            frame.width, frame.height, 1, D3DUSAGE_DYNAMIC,
            D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &g_react_texture, nullptr);
        if (FAILED(hr) || !g_react_texture) {
            nexus::nlog::log("[d3d9] CreateTexture failed hr=0x%08lx (w=%u h=%u)",
                (unsigned long)hr, frame.width, frame.height);
            g_react_texture = nullptr;
            return;
        }
        g_react_tex_w = frame.width;
        g_react_tex_h = frame.height;
        nexus::nlog::log("[d3d9] React texture created %ux%u", frame.width, frame.height);
    }

    // Lock + upload row-by-row (pitch peut différer du width*4).
    // Electron envoie BGRA top-down, exactement le layout natif de
    // D3DFMT_A8R8G8B8 — pas besoin de swizzle.
    D3DLOCKED_RECT locked{};
    HRESULT hr = g_react_texture->LockRect(0, &locked, nullptr, D3DLOCK_DISCARD);
    if (FAILED(hr)) {
        nexus::nlog::log("[d3d9] LockRect failed hr=0x%08lx", (unsigned long)hr);
        return;
    }
    const size_t row_bytes = static_cast<size_t>(frame.width) * 4;
    for (uint32_t y = 0; y < frame.height; y++) {
        std::memcpy(
            reinterpret_cast<uint8_t*>(locked.pBits) + y * locked.Pitch,
            frame.rgba.data() + y * row_bytes,
            row_bytes);
    }
    g_react_texture->UnlockRect(0);

    g_last_frame_id = frame.frame_id;
}

// Draw l'overlay React en fullscreen via une window ImGui invisible
// + un ImDrawList::AddImage. NoInputs pour que les clicks tombent
// dans le WndProc subclass (qui les forward à Electron).
void draw_react_overlay() {
    if (!g_react_texture) return;
    const float vw = static_cast<float>(g_d9_viewport_w.load());
    const float vh = static_cast<float>(g_d9_viewport_h.load());
    ImGui::SetNextWindowPos(ImVec2(0, 0));
    ImGui::SetNextWindowSize(ImVec2(vw, vh));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);
    ImGui::Begin("##nexus_overlay_phase2", nullptr,
        ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing |
        ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoInputs |
        ImGuiWindowFlags_NoBackground);
    ImGui::GetWindowDrawList()->AddImage(
        reinterpret_cast<ImTextureID>(g_react_texture),
        ImVec2(0, 0), ImVec2(vw, vh));
    ImGui::End();
    ImGui::PopStyleVar(2);
}

HRESULT WINAPI present_detour(IDirect3DDevice9* device, const RECT* src, const RECT* dst,
                              HWND override_hwnd, const RGNDATA* dirty_region) {
    g_d9_frame_counter.fetch_add(1);

    // [REMOVED] D3D9 Reset(Windowed=TRUE) trigger — trop risqué.
    // Forcer un Reset depuis notre thread cassait les resources
    // D3DPOOL_DEFAULT du jeu (LEGO Marvel crash silencieusement après
    // le Reset, plus jamais de Present). Le pause-on-focus-loss est
    // maintenant géré via WM_ACTIVATE/WM_KILLFOCUS swallow dans
    // overlay_wndproc — beaucoup plus safe et fonctionne pour TOUS
    // les jeux peu importe l'API graphique.

    // Diagnostic log toutes les 60 frames pour qu'on sache que le hook
    // tourne (et qu'on voie passer les changements visible).
    const uint64_t frame = g_d9_frame_counter.load();
    if (frame % 60 == 0) {
        nexus::nlog::log("[d3d9] frame=%llu visible=%d imgui_init=%d phase2=%d react_tex=%d vp=%ux%u",
            (unsigned long long)frame,
            (int)nexus::OverlayState::instance().visible(),
            (int)g_imgui_initialized,
            (int)nexus::frame_pipe::is_connected(),
            (int)(g_react_texture != nullptr),
            g_d9_viewport_w.load(), g_d9_viewport_h.load());
    }

    if (!g_imgui_initialized) {
        // Trouve la HWND à subclass — override_hwnd si fourni, sinon
        // hFocusWindow depuis les CreationParameters.
        HWND hwnd = override_hwnd;
        if (!hwnd) {
            D3DDEVICE_CREATION_PARAMETERS params{};
            if (SUCCEEDED(device->GetCreationParameters(&params))) {
                hwnd = params.hFocusWindow;
            }
        }
        if (hwnd) {
            install_wndproc_hook(hwnd);
            init_imgui(hwnd, device);
            g_device = device;
        }
        // Expose le device au module borderless — il s'en sert pour
        // déclencher un Reset(Windowed=TRUE) sur le rendering thread
        // si le jeu a démarré en exclusive fullscreen.
        nexus::borderless::set_target_d3d9_device(device);
    }

    capture_viewport(device);

    if (g_imgui_initialized) {
        const bool overlay_visible = nexus::OverlayState::instance().visible();
        const bool phase2 = nexus::frame_pipe::is_connected();

        // Log les transitions visible 0↔1 pour debug.
        bool prev = g_d9_last_visible.exchange(overlay_visible);
        if (prev != overlay_visible) {
            nexus::nlog::log("[d3d9] visible CHANGED %d -> %d (frame=%llu, phase2=%d)",
                (int)prev, (int)overlay_visible,
                (unsigned long long)frame, (int)phase2);
        }

        // Phase 2 : upload pixels même quand overlay invisible — la
        // texture reste prête pour le prochain show, et c'est cheap.
        if (phase2) {
            update_react_texture(device);
        }

        if (overlay_visible) {
            ImGui_ImplDX9_NewFrame();
            ImGui_ImplWin32_NewFrame();
            ImGui::NewFrame();
            if (phase2) {
                draw_react_overlay();
            } else {
                // Phase 1 fallback : vieille UI ImGui interne.
                nexus::renderer::draw_frame();
            }
            ImGui::EndFrame();
            device->BeginScene();
            ImGui::Render();
            ImGui_ImplDX9_RenderDrawData(ImGui::GetDrawData());
            device->EndScene();
        }
    }

    return g_orig_present(device, src, dst, override_hwnd, dirty_region);
}

HRESULT WINAPI reset_detour(IDirect3DDevice9* device, D3DPRESENT_PARAMETERS* params) {
    // Force-borderless : mutate params->Windowed = TRUE AVANT de
    // forward au device. C'est le seul moyen propre de switcher un
    // device D3D9 en windowed (le device a été créé en exclusive,
    // on intercepte le Reset pour le passer en windowed sans crash).
    // No-op si NEXUS_DISABLE_BORDERLESS=1.
    nexus::borderless::maybe_force_d3d9_windowed(params);

    // Reset invalide TOUTES les ressources D3DPOOL_DEFAULT — notre
    // texture React aussi. On la release ici, le prochain Present la
    // recrée from scratch via update_react_texture().
    if (g_react_texture) {
        g_react_texture->Release();
        g_react_texture = nullptr;
        g_react_tex_w = 0;
        g_react_tex_h = 0;
        g_last_frame_id = 0;
    }
    if (g_imgui_initialized) {
        ImGui_ImplDX9_InvalidateDeviceObjects();
    }
    HRESULT hr = g_orig_reset(device, params);
    if (SUCCEEDED(hr) && g_imgui_initialized) {
        ImGui_ImplDX9_CreateDeviceObjects();
        // Update viewport tracker — Reset peut changer la résolution
        // (alt-tab fullscreen → windowed, par exemple).
        if (params && params->BackBufferWidth) g_d9_viewport_w.store(params->BackBufferWidth);
        if (params && params->BackBufferHeight) g_d9_viewport_h.store(params->BackBufferHeight);
    }
    return hr;
}

// Try every reasonable CreateDevice combo until one succeeds. Some
// drivers refuse SOFTWARE_VERTEXPROCESSING (Intel iGPUs older than
// HD 4000), some refuse D3DFMT_UNKNOWN (Optimus laptops), and
// D3DCREATE_FPU_PRESERVE is needed on Wine. We try in this order :
//
//   1. HAL + HARDWARE_VERTEXPROCESSING + X8R8G8B8     ← fastest, most common
//   2. HAL + SOFTWARE_VERTEXPROCESSING + X8R8G8B8     ← old fallback
//   3. HAL + MIXED_VERTEXPROCESSING + X8R8G8B8        ← some Optimus
//   4. NULLREF + SOFTWARE_VERTEXPROCESSING            ← no GPU needed,
//                                                       intended exactly for
//                                                       vtable scraping
//   5. REF + SOFTWARE_VERTEXPROCESSING                ← reference rasterizer
//
// The vtable layout is identical for all device types — we only need
// the pointer table, never call the device methods for real rendering.
bool try_create_device(IDirect3D9* d3d, HWND hwnd, D3DDEVTYPE devtype,
                       DWORD behavior, D3DFORMAT fmt,
                       ComPtr<IDirect3DDevice9>& out) {
    D3DPRESENT_PARAMETERS pp{};
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.hDeviceWindow = hwnd;
    pp.BackBufferWidth = 1;
    pp.BackBufferHeight = 1;
    pp.BackBufferFormat = fmt;
    pp.BackBufferCount = 1;
    HRESULT hr = d3d->CreateDevice(
        D3DADAPTER_DEFAULT, devtype, hwnd, behavior, &pp, &out);
    if (SUCCEEDED(hr) && out) {
        nexus::nlog::log(
            "[d3d9] CreateDevice OK : devtype=%d behavior=0x%lx fmt=%d",
            (int)devtype, (unsigned long)behavior, (int)fmt);
        return true;
    }
    nexus::nlog::log(
        "[d3d9] CreateDevice FAIL : devtype=%d behavior=0x%lx fmt=%d hr=0x%08lx",
        (int)devtype, (unsigned long)behavior, (int)fmt, (unsigned long)hr);
    return false;
}

bool capture_vtable(void**& vtable_out) {
    // Tiny hidden window for the dummy device.
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"nexus-overlay-d9-probe";
    if (!RegisterClassExW(&wc)) {
        DWORD err = GetLastError();
        if (err != ERROR_CLASS_ALREADY_EXISTS) {
            nexus::nlog::log("[d3d9] RegisterClassExW failed err=%lu", err);
            return false;
        }
    }
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"", WS_POPUP,
                                0, 0, 1, 1, nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) {
        nexus::nlog::log("[d3d9] CreateWindowExW failed err=%lu", GetLastError());
        UnregisterClassW(wc.lpszClassName, wc.hInstance);
        return false;
    }

    ComPtr<IDirect3D9> d3d{Direct3DCreate9(D3D_SDK_VERSION)};
    if (!d3d) {
        nexus::nlog::log("[d3d9] Direct3DCreate9 returned NULL (SDK_VERSION=%u)",
                         (unsigned)D3D_SDK_VERSION);
        DestroyWindow(hwnd);
        UnregisterClassW(wc.lpszClassName, wc.hInstance);
        return false;
    }
    nexus::nlog::log("[d3d9] Direct3DCreate9 OK");

    ComPtr<IDirect3DDevice9> dev;
    bool ok =
        try_create_device(d3d.Get(), hwnd, D3DDEVTYPE_HAL,
                          D3DCREATE_HARDWARE_VERTEXPROCESSING,
                          D3DFMT_X8R8G8B8, dev)
        || try_create_device(d3d.Get(), hwnd, D3DDEVTYPE_HAL,
                             D3DCREATE_SOFTWARE_VERTEXPROCESSING,
                             D3DFMT_X8R8G8B8, dev)
        || try_create_device(d3d.Get(), hwnd, D3DDEVTYPE_HAL,
                             D3DCREATE_MIXED_VERTEXPROCESSING,
                             D3DFMT_X8R8G8B8, dev)
        || try_create_device(d3d.Get(), hwnd, D3DDEVTYPE_HAL,
                             D3DCREATE_SOFTWARE_VERTEXPROCESSING,
                             D3DFMT_UNKNOWN, dev)
        || try_create_device(d3d.Get(), hwnd, D3DDEVTYPE_NULLREF,
                             D3DCREATE_SOFTWARE_VERTEXPROCESSING,
                             D3DFMT_X8R8G8B8, dev)
        || try_create_device(d3d.Get(), hwnd, D3DDEVTYPE_REF,
                             D3DCREATE_SOFTWARE_VERTEXPROCESSING,
                             D3DFMT_X8R8G8B8, dev);

    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);
    if (!ok || !dev) {
        nexus::nlog::log("[d3d9] capture_vtable: all CreateDevice attempts failed");
        return false;
    }

    vtable_out = *reinterpret_cast<void***>(dev.Get());
    nexus::nlog::log("[d3d9] vtable captured at %p", (void*)vtable_out);
    return true;
}

} // namespace

bool install_d3d9() {
    void** vt = nullptr;
    if (!capture_vtable(vt)) {
        nexus::nlog::log("[d3d9] install_d3d9: vtable capture failed");
        return false;
    }
    // IDirect3DDevice9 vtable slot indices :
    //   16 → Reset
    //   17 → Present
    void* reset_addr   = vt[16];
    void* present_addr = vt[17];
    nexus::nlog::log("[d3d9] vtable: present=%p reset=%p", present_addr, reset_addr);

    MH_STATUS s = MH_CreateHook(present_addr, &present_detour,
                                reinterpret_cast<void**>(&g_orig_present));
    if (s != MH_OK) {
        nexus::nlog::log("[d3d9] MH_CreateHook(present) failed: %d", (int)s);
        return false;
    }
    s = MH_CreateHook(reset_addr, &reset_detour,
                      reinterpret_cast<void**>(&g_orig_reset));
    if (s != MH_OK) {
        nexus::nlog::log("[d3d9] MH_CreateHook(reset) failed: %d", (int)s);
        return false;
    }
    s = MH_EnableHook(present_addr);
    if (s != MH_OK) {
        nexus::nlog::log("[d3d9] MH_EnableHook(present) failed: %d", (int)s);
        return false;
    }
    s = MH_EnableHook(reset_addr);
    if (s != MH_OK) {
        nexus::nlog::log("[d3d9] MH_EnableHook(reset) failed: %d", (int)s);
        return false;
    }
    nexus::nlog::log("[d3d9] hook installed OK");
    return true;
}

void uninstall_d3d9() {
    if (g_react_texture) {
        g_react_texture->Release();
        g_react_texture = nullptr;
    }
    if (g_imgui_initialized) {
        ImGui_ImplDX9_Shutdown();
        ImGui_ImplWin32_Shutdown();
    }
    if (g_orig_wndproc && g_game_hwnd && IsWindow(g_game_hwnd)) {
        SetWindowLongPtrW(g_game_hwnd, GWLP_WNDPROC,
                          reinterpret_cast<LONG_PTR>(g_orig_wndproc));
        g_orig_wndproc = nullptr;
    }
    g_device.Reset();
    g_imgui_initialized = false;
}

} // namespace nexus::hooks
