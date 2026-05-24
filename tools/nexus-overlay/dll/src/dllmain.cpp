// =====================================================================
//  nexus-overlay.dll — entry point
//
//  Loaded via CreateRemoteThread + LoadLibraryW from
//  nexus-overlay-injector.exe (or directly from Nexus Input bridge).
//  At PROCESS_ATTACH we :
//
//    1. Spin a worker thread (because DllMain has heavy restrictions
//       on what you can do — no LoadLibrary calls, no synchronization,
//       no GUI). The worker does the actual hook installation.
//
//    2. Detect which graphics API the game is currently using by
//       checking which D3D/OpenGL/Vulkan DLL is already loaded in
//       the process. We use GetModuleHandle (cheap, non-blocking) ;
//       the first match wins. If a game uses multiple APIs (rare —
//       Source 2 can switch between DX11 and Vulkan), we re-probe
//       periodically.
//
//    3. Install the matching MinHook detour on the API's Present
//       function. The detour first lets the original render the
//       game frame, then composites our ImGui overlay before the
//       swap chain flips.
//
//    4. Start the named-pipe IPC client thread that pulls the cloud
//       state (current game, friends, panel-open flag) from the
//       Electron main process.
//
//  At PROCESS_DETACH we tear down hooks + threads cleanly. Most
//  games never detach (they exit hard), but some launchers (Steam
//  itself, Epic) may FreeLibrary us on game-exit.
// =====================================================================
#include <windows.h>
#include <psapi.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <cstdio>
#include <mutex>

#include "MinHook.h"
#include "overlay_state.h"
#include "ipc.h"
#include "frame_pipe.h"
#include "renderer.h"
#include "nlog.h"
#include "hooks/hook_dxgi.h"
#include "hooks/hook_d3d9.h"
#include "hooks/hook_opengl.h"
#ifdef NEXUS_OVERLAY_HAS_VULKAN
#include "hooks/hook_vulkan.h"
#endif

namespace {

HMODULE g_self_module = nullptr;
std::atomic<bool> g_shutdown{false};
std::thread g_worker;
std::thread g_ipc_thread;
std::thread g_frame_thread;
std::thread g_key_hook_thread;
std::thread g_key_poll_thread;
HHOOK       g_keyboard_hook = nullptr;
DWORD       g_key_hook_thread_id = 0;

// Polling thread — check GetAsyncKeyState toutes les 30ms pour détecter
// Shift+Tab (rising edge). Bulletproof : GetAsyncKeyState lit l'état
// global du clavier depuis le kernel, contourne TOUTES les couches
// (DirectInput exclusive, autres WH_KEYBOARD_LL hooks, GeForce Experience,
// AMD Adrenalin, RTSS, etc.). C'est exactement la technique Steam
// Overlay utilise pour Shift+Tab.
//
// Le hook WH_KEYBOARD_LL reste utilisé pour SWALLOW les inputs quand
// l'overlay est visible (sinon WASD bouge le perso derrière) — mais
// la détection du toggle ne dépend plus du hook.
// Forward declaration — viewport tracking est dans hook_d3d9.cpp et
// hook_dxgi.cpp. Pour le polling, on lit l'écran via GetSystemMetrics
// en fallback. Le hook overrider les valeurs précises depuis le swap chain.
namespace hooks_viewport {
    // Lit le viewport courant. Default = primary monitor res.
    void get(uint32_t& w, uint32_t& h) {
        w = static_cast<uint32_t>(GetSystemMetrics(SM_CXSCREEN));
        h = static_cast<uint32_t>(GetSystemMetrics(SM_CYSCREEN));
    }
}

// Force le curseur OS à être visible. ShowCursor maintient un compteur
// interne — counter >= 0 = curseur visible. Les jeux DirectInput
// exclusive font souvent ShowCursor(FALSE) plusieurs fois pour le
// cacher. On bump jusqu'à >= 0.
void force_show_cursor() {
    int safety = 0;
    while (ShowCursor(TRUE) < 0 && safety++ < 32) {}
    ClipCursor(nullptr);  // déclippe (le jeu peut avoir capped la souris au centre)
}

// Inverse : drop le compteur ShowCursor jusqu'à -1 pour cacher le
// curseur. Appelé quand l'overlay se ferme pour rendre la souris au jeu.
void force_hide_cursor() {
    int safety = 0;
    while (ShowCursor(FALSE) >= 0 && safety++ < 32) {}
}

void key_poll_thread_proc() {
    bool prev_shift_tab = false;
    bool prev_escape    = false;
    bool prev_visible   = false;
    bool prev_lbutton   = false;
    bool prev_rbutton   = false;
    bool prev_mbutton   = false;
    POINT prev_mouse_pos{ -1, -1 };
    int loop_count = 0;

    while (!g_shutdown.load()) {
        const bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        const bool tab   = (GetAsyncKeyState(VK_TAB)   & 0x8000) != 0;
        const bool esc   = (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;
        const bool cur_shift_tab = shift && tab;
        const bool visible = nexus::OverlayState::instance().visible();

        // Rising edge Shift+Tab → toggle.
        if (cur_shift_tab && !prev_shift_tab) {
            nexus::nlog::log("key_poll: Shift+Tab edge → toggle (loop=%d)", loop_count);
            nexus::ipc::send_event_async(R"({"type":"event","name":"toggle-visible"})");
        }
        // Rising edge Escape PENDANT overlay visible → close.
        if (esc && !prev_escape && visible) {
            nexus::nlog::log("key_poll: Escape edge (overlay visible) → close");
            nexus::ipc::send_event_async(R"({"type":"event","name":"toggle-visible"})");
        }

        // Transition visible 0→1 : force le curseur OS à être visible
        // + déclippe (LEGO Marvel et autres jeux DirectInput exclusive
        // cap la souris au centre de l'écran). Sans ça, l'user voit
        // l'overlay mais ne peut pas bouger la souris pour cliquer.
        if (visible && !prev_visible) {
            nexus::nlog::log("key_poll: visible 0→1 — force_show_cursor + unclip");
            force_show_cursor();
        }
        // Transition 1→0 : redonne le curseur au jeu.
        if (!visible && prev_visible) {
            nexus::nlog::log("key_poll: visible 1→0 — force_hide_cursor");
            force_hide_cursor();
            // Reset mouse state pour éviter qu'on envoie un fake mouseUp
            // quand on rouvre — le jeu aurait pu changer l'état boutons
            // pendant qu'on était fermé.
            prev_lbutton = prev_rbutton = prev_mbutton = false;
            prev_mouse_pos = { -1, -1 };
        }

        // Mouse polling PENDANT visible — forward à Electron pour que
        // la React UI reçoive mouseMove/Down/Up. Même mécanisme que
        // WH_KEYBOARD_LL : GetAsyncKeyState contourne DirectInput
        // exclusive, on reçoit l'état boutons même quand le jeu les
        // intercepte normalement.
        if (visible) {
            POINT pos{};
            if (GetCursorPos(&pos)) {
                // Convert screen → game window client coords. Le jeu
                // est forcément foreground quand l'user a Shift+Tab'd
                // l'overlay (il a focus), donc GetForegroundWindow()
                // donne le HWND du jeu sans coupler avec les hooks.
                HWND hwnd = GetForegroundWindow();
                POINT client_pos = pos;
                if (hwnd) ScreenToClient(hwnd, &client_pos);

                uint32_t vw = 0, vh = 0;
                hooks_viewport::get(vw, vh);

                // Mouse move — uniquement si position a changé. On
                // tronque à >0 (parfois ScreenToClient retourne < 0
                // si curseur hors fenêtre, on clamp à 0 pour éviter
                // les events négatifs).
                if (client_pos.x != prev_mouse_pos.x ||
                    client_pos.y != prev_mouse_pos.y) {
                    char buf[256];
                    int x = client_pos.x < 0 ? 0 : client_pos.x;
                    int y = client_pos.y < 0 ? 0 : client_pos.y;
                    std::snprintf(buf, sizeof(buf),
                        R"({"type":"input","kind":"mouseMove","x":%d,"y":%d,"vw":%u,"vh":%u})",
                        x, y, vw, vh);
                    nexus::ipc::send_event_async(buf);
                    prev_mouse_pos = client_pos;
                }

                // Mouse buttons — edges seulement.
                const bool lb = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
                const bool rb = (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;
                const bool mb = (GetAsyncKeyState(VK_MBUTTON) & 0x8000) != 0;
                auto send_btn = [&](const char* button, bool down,
                                    int x, int y, uint32_t vw_, uint32_t vh_) {
                    char buf[256];
                    std::snprintf(buf, sizeof(buf),
                        R"({"type":"input","kind":"%s","x":%d,"y":%d,"button":"%s","vw":%u,"vh":%u})",
                        down ? "mouseDown" : "mouseUp",
                        x, y, button, vw_, vh_);
                    nexus::ipc::send_event_async(buf);
                };
                int x = client_pos.x < 0 ? 0 : client_pos.x;
                int y = client_pos.y < 0 ? 0 : client_pos.y;
                if (lb != prev_lbutton) {
                    nexus::nlog::log("key_poll: LBUTTON edge %d (x=%d y=%d)", (int)lb, x, y);
                    send_btn("left", lb, x, y, vw, vh);
                    prev_lbutton = lb;
                }
                if (rb != prev_rbutton) {
                    send_btn("right", rb, x, y, vw, vh);
                    prev_rbutton = rb;
                }
                if (mb != prev_mbutton) {
                    send_btn("middle", mb, x, y, vw, vh);
                    prev_mbutton = mb;
                }
            }
        }

        prev_shift_tab = cur_shift_tab;
        prev_escape    = esc;
        prev_visible   = visible;
        loop_count++;

        // Log un heartbeat toutes les 300 itérations (≈ 9s) pour
        // confirmer que le thread tourne.
        if (loop_count % 300 == 0) {
            nexus::nlog::log("key_poll: heartbeat #%d (shift=%d tab=%d esc=%d visible=%d)",
                loop_count, (int)shift, (int)tab, (int)esc, (int)visible);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(16));  // ~60Hz
    }
    nexus::nlog::log("key_poll: thread exiting");
}

// Low-level keyboard hook proc — called by Windows for EVERY keystroke
// across the system, but only when g_keyboard_hook is installed. Runs
// in the context of g_key_hook_thread.
//
// What we intercept :
//   • Shift+Tab : toggle l'overlay. Swallow le keystroke pour qu'il
//     n'atteigne pas le jeu (sinon LEGO Marvel par exemple recule).
//   • Escape (overlay ouvert) : close. Swallow.
//   • Tout le reste (overlay ouvert) : swallow pour que le jeu ne
//     reçoive pas les frappes pendant qu'on tape dans la React UI.
//
// Pourquoi WH_KEYBOARD_LL et pas SetWindowsHookEx(WH_KEYBOARD) :
//   WH_KEYBOARD est délivré APRÈS DirectInput → on rate les jeux
//   exclusive. WH_KEYBOARD_LL est délivré au niveau OS, AVANT que
//   l'app appelle GetKeyState / DirectInput::GetDeviceData.
LRESULT CALLBACK low_level_keyboard_proc(int nCode, WPARAM wParam, LPARAM lParam) {
    // Diag — confirme que le hook reçoit des callbacks. Log les 5
    // premiers + toutes les 200 frappes pour ne pas spammer.
    static std::atomic<int> hook_counter{0};
    int cnt = hook_counter.fetch_add(1);
    if (cnt < 5 || cnt % 200 == 0) {
        auto* k = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
        nexus::nlog::log("keyboard_hook: callback #%d nCode=%d wParam=%lu vk=0x%lx",
            cnt, nCode, (unsigned long)wParam,
            k ? (unsigned long)k->vkCode : 0UL);
    }
    if (nCode != HC_ACTION) {
        return CallNextHookEx(nullptr, nCode, wParam, lParam);
    }
    auto* kbd = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    const bool is_keydown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    const bool is_keyup   = (wParam == WM_KEYUP   || wParam == WM_SYSKEYUP);
    const bool visible    = nexus::OverlayState::instance().visible();

    if (is_keydown) {
        const bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        // Shift+Tab → toggle (que l'overlay soit visible ou non).
        if (shift && kbd->vkCode == VK_TAB) {
            nexus::nlog::log("keyboard_hook: Shift+Tab detected → toggle");
            nexus::ipc::send_event_async(R"({"type":"event","name":"toggle-visible"})");
            return 1;  // swallow — game must not receive
        }
        // Escape ferme l'overlay s'il est ouvert. Pas de swallow sinon
        // (Escape sert au jeu pour ouvrir son propre menu).
        if (visible && kbd->vkCode == VK_ESCAPE) {
            nexus::nlog::log("keyboard_hook: Escape detected → close overlay");
            nexus::ipc::send_event_async(R"({"type":"event","name":"toggle-visible"})");
            return 1;
        }
    }
    // Overlay ouvert : swallow tous les keystrokes pour qu'ils n'atteignent
    // pas le jeu (sinon WASD bouge le perso derrière). Les inputs React
    // arrivent quand même via ipc::forward_input_to_electron côté WndProc
    // subclass (qui forward AVANT swallow).
    if (visible && (is_keydown || is_keyup)) {
        return 1;
    }
    return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

void install_keyboard_hook() {
    g_key_hook_thread_id = GetCurrentThreadId();
    g_keyboard_hook = SetWindowsHookExW(
        WH_KEYBOARD_LL, low_level_keyboard_proc, g_self_module, 0);
    if (!g_keyboard_hook) {
        nexus::nlog::log("keyboard_hook: SetWindowsHookEx FAILED err=%lu",
                         GetLastError());
    } else {
        nexus::nlog::log("keyboard_hook: installed OK (tid=%lu)", g_key_hook_thread_id);
    }
}

void uninstall_keyboard_hook() {
    if (g_keyboard_hook) {
        UnhookWindowsHookEx(g_keyboard_hook);
        g_keyboard_hook = nullptr;
        nexus::nlog::log("keyboard_hook: uninstalled");
    }
}

// Wrapper local pour ne pas avoir à écrire nexus::nlog::log partout.
inline void nlog(const char* fmt, ...) {
    char buf[1024];
    va_list args; va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    nexus::nlog::log("%s", buf);
}

enum class GraphicsApi {
    Unknown,
    D3D9,
    DXGI,     // DXGI covers D3D10 / D3D11 / D3D12 — same IDXGISwapChain
    OpenGL,
    Vulkan,
};

GraphicsApi detect_api() {
    // Probe order matters : DXGI is by far the most common (every
    // game made in the last decade), then Vulkan (modern), then
    // legacy D3D9, then OpenGL (rare on PC in 2026 — mostly
    // emulators + indie pixel-art).
    if (GetModuleHandleW(L"d3d11.dll")  != nullptr) return GraphicsApi::DXGI;
    if (GetModuleHandleW(L"d3d12.dll")  != nullptr) return GraphicsApi::DXGI;
    if (GetModuleHandleW(L"d3d10.dll")  != nullptr) return GraphicsApi::DXGI;
    if (GetModuleHandleW(L"vulkan-1.dll") != nullptr) return GraphicsApi::Vulkan;
    if (GetModuleHandleW(L"d3d9.dll")   != nullptr) return GraphicsApi::D3D9;
    if (GetModuleHandleW(L"opengl32.dll") != nullptr) return GraphicsApi::OpenGL;
    return GraphicsApi::Unknown;
}

const wchar_t* api_name(GraphicsApi a) {
    switch (a) {
        case GraphicsApi::D3D9:   return L"D3D9";
        case GraphicsApi::DXGI:   return L"DXGI (D3D10/11/12)";
        case GraphicsApi::OpenGL: return L"OpenGL";
        case GraphicsApi::Vulkan: return L"Vulkan";
        default:                  return L"unknown";
    }
}

// Wait until at least one supported graphics DLL has been loaded by
// the host process. Some games defer DLL loading until shaders are
// compiled (UE5 with PSO precompilation) — we don't want to install
// the wrong hook in that window. Poll every 250ms for up to 30s,
// then give up gracefully.
GraphicsApi wait_for_graphics_api() {
    constexpr auto kPollInterval = std::chrono::milliseconds(250);
    constexpr int  kMaxAttempts  = 120; // = 30s
    for (int i = 0; i < kMaxAttempts; ++i) {
        if (g_shutdown.load()) return GraphicsApi::Unknown;
        GraphicsApi api = detect_api();
        if (api != GraphicsApi::Unknown) return api;
        std::this_thread::sleep_for(kPollInterval);
    }
    return GraphicsApi::Unknown;
}

void install_hook(GraphicsApi api) {
    bool ok = false;
    switch (api) {
        case GraphicsApi::DXGI:   ok = nexus::hooks::install_dxgi();   break;
        case GraphicsApi::D3D9:   ok = nexus::hooks::install_d3d9();   break;
        case GraphicsApi::OpenGL: ok = nexus::hooks::install_opengl(); break;
#ifdef NEXUS_OVERLAY_HAS_VULKAN
        case GraphicsApi::Vulkan: ok = nexus::hooks::install_vulkan(); break;
#else
        case GraphicsApi::Vulkan:
            OutputDebugStringW(L"[nexus-overlay] Vulkan détecté mais backend non compilé (rebuild avec Vulkan SDK)\n");
            return;
#endif
        default: return;
    }
    if (!ok) {
        OutputDebugStringW(L"[nexus-overlay] hook install failed\n");
    }
}

void uninstall_all_hooks() {
    nexus::hooks::uninstall_dxgi();
    nexus::hooks::uninstall_d3d9();
    nexus::hooks::uninstall_opengl();
#ifdef NEXUS_OVERLAY_HAS_VULKAN
    nexus::hooks::uninstall_vulkan();
#endif
    MH_Uninitialize();
}

DWORD WINAPI worker_thread(LPVOID) {
    nlog("worker_thread started, pid=%lu", GetCurrentProcessId());
    OutputDebugStringW(L"[nexus-overlay] DLL attached, worker started\n");

    if (MH_Initialize() != MH_OK) {
        nlog("MH_Initialize failed");
        OutputDebugStringW(L"[nexus-overlay] MinHook init failed\n");
        return 1;
    }
    nlog("MH_Initialize OK");

    // Wait for ANY supported graphics DLL to be loaded.
    bool found_any = false;
    for (int i = 0; i < 120 && !g_shutdown.load(); ++i) {
        if (GetModuleHandleW(L"d3d11.dll") || GetModuleHandleW(L"d3d12.dll") ||
            GetModuleHandleW(L"d3d10.dll") || GetModuleHandleW(L"d3d9.dll")  ||
            GetModuleHandleW(L"opengl32.dll") || GetModuleHandleW(L"vulkan-1.dll")) {
            found_any = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
    if (!found_any) {
        nlog("no graphics API loaded after 30s");
        MH_Uninitialize();
        return 0;
    }

    // Log which modules are loaded for diagnosis.
    nlog("modules loaded: d3d11=%d d3d12=%d d3d10=%d d3d9=%d opengl32=%d vulkan-1=%d",
        GetModuleHandleW(L"d3d11.dll") != nullptr,
        GetModuleHandleW(L"d3d12.dll") != nullptr,
        GetModuleHandleW(L"d3d10.dll") != nullptr,
        GetModuleHandleW(L"d3d9.dll") != nullptr,
        GetModuleHandleW(L"opengl32.dll") != nullptr,
        GetModuleHandleW(L"vulkan-1.dll") != nullptr);

    // Install hooks for ALL detected APIs simultaneously. The one that
    // actually gets called (game's real renderer) will fire its hook;
    // others are inert. This is robust against false-positive detection
    // (Windows often loads d3d11.dll for non-rendering reasons).
    if (GetModuleHandleW(L"d3d11.dll") || GetModuleHandleW(L"d3d12.dll") || GetModuleHandleW(L"d3d10.dll")) {
        bool ok = nexus::hooks::install_dxgi();
        nlog("install_dxgi: %s", ok ? "OK" : "FAIL");
    }
    if (GetModuleHandleW(L"d3d9.dll")) {
        bool ok = nexus::hooks::install_d3d9();
        nlog("install_d3d9: %s", ok ? "OK" : "FAIL");
    }
    if (GetModuleHandleW(L"opengl32.dll")) {
        bool ok = nexus::hooks::install_opengl();
        nlog("install_opengl: %s", ok ? "OK" : "FAIL");
    }
#ifdef NEXUS_OVERLAY_HAS_VULKAN
    if (GetModuleHandleW(L"vulkan-1.dll")) {
        bool ok = nexus::hooks::install_vulkan();
        nlog("install_vulkan: %s", ok ? "OK" : "FAIL");
    }
#endif

    // Start IPC client thread — pulls state from Electron main.
    g_ipc_thread = std::thread([]() {
        nlog("ipc thread starting");
        nexus::ipc::run(g_shutdown);
        nlog("ipc thread exiting");
    });

    // v0.5.1 Phase 2 — start frame_pipe client thread. Reads RGBA
    // pixels streamed from Electron's offscreen React overlay.
    g_frame_thread = std::thread([]() {
        nexus::frame_pipe::run(g_shutdown);
    });

    // Low-level keyboard hook — intercepte Shift+Tab AVANT que le jeu
    // ne le voie via DirectInput / RawInput. Indispensable pour les
    // jeux fullscreen exclusive (LEGO série, Source 1, jeux DirectInput8)
    // où Electron's globalShortcut.register() reçoit le keystroke
    // trop tard (ou jamais). Steam et Discord font exactement pareil.
    //
    // SetWindowsHookEx(WH_KEYBOARD_LL) doit tourner sur un thread avec
    // une message pump — d'où le std::thread dédié qui pump des MSG
    // jusqu'au shutdown. La hook proc tourne dans le contexte de ce
    // thread, peut donc lire OverlayState et appeler ipc::send_event_async
    // sans risque de loader lock.
    g_key_hook_thread = std::thread([]() {
        nlog("keyboard hook thread starting");
        install_keyboard_hook();
        // Message pump — Windows dispatch les hook callbacks via cette pump.
        MSG msg;
        while (!g_shutdown.load() && GetMessageW(&msg, nullptr, 0, 0) > 0) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        uninstall_keyboard_hook();
        nlog("keyboard hook thread exiting");
    });

    // Polling thread Shift+Tab — backup bulletproof si WH_KEYBOARD_LL
    // est intercepté par un autre soft (GeForce Experience, RTSS, etc.).
    // GetAsyncKeyState lit l'état clavier global directement depuis le
    // kernel, donc fonctionne TOUJOURS quelque soit le mode DirectInput
    // ou les hooks tiers.
    g_key_poll_thread = std::thread(key_poll_thread_proc);

    // Park the worker thread until shutdown is signalled. We could
    // exit here (the hook + IPC threads survive) but keeping the
    // worker alive gives us a clean handle to join() at detach.
    while (!g_shutdown.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    return 0;
}

void on_attach(HMODULE self) {
    g_self_module = self;
    // CRT init guarantees globals are constructed BEFORE DllMain
    // runs — but we still spawn a separate thread for the heavy
    // work (loader lock + win32 sync calls aren't safe inside
    // DllMain itself).
    DisableThreadLibraryCalls(self);  // we don't need DLL_THREAD_*
    g_worker = std::thread(worker_thread, nullptr);
    g_worker.detach();  // never join — process death cleans up
}

void on_detach() {
    g_shutdown.store(true);
    // Réveille le keyboard hook thread (qui bloque sur GetMessage)
    // pour qu'il puisse voir g_shutdown et sortir proprement.
    if (g_key_hook_thread_id) {
        PostThreadMessageW(g_key_hook_thread_id, WM_NULL, 0, 0);
    }
    if (g_ipc_thread.joinable())      g_ipc_thread.join();
    if (g_frame_thread.joinable())    g_frame_thread.join();
    if (g_key_hook_thread.joinable()) g_key_hook_thread.join();
    if (g_key_poll_thread.joinable()) g_key_poll_thread.join();
    nexus::renderer::shutdown();
    uninstall_all_hooks();
    OutputDebugStringW(L"[nexus-overlay] DLL detached\n");
}

} // namespace

// =====================================================================
//  DllMain — kept MINIMAL. All heavy work happens in worker_thread.
// =====================================================================
BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID /*lpReserved*/) {
    switch (ul_reason_for_call) {
        case DLL_PROCESS_ATTACH: on_attach(hModule); break;
        case DLL_PROCESS_DETACH: on_detach();        break;
    }
    return TRUE;
}

HMODULE nexus_self_module() { return g_self_module; }
