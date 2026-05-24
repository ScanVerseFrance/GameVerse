// =====================================================================
//  hook_dxgi.cpp — IDXGISwapChain::Present + ResizeBuffers hooks
//
//  Covers D3D 10 / 11 / 12 because they all use IDXGISwapChain for
//  frame presentation. The hook works via vtable patch :
//
//    IDXGISwapChain vtable[0..N] :
//      [0]  QueryInterface
//      [1]  AddRef
//      [2]  Release
//      [3]  SetPrivateData
//      [4]  SetPrivateDataInterface
//      [5]  GetPrivateData
//      [6]  GetParent
//      [7]  GetDevice
//      [8]  Present                          ← we patch this
//      [9]  GetBuffer
//      [10] SetFullscreenState
//      [11] GetFullscreenState
//      [12] GetDesc
//      [13] ResizeBuffers                    ← also patched (we MUST
//                                              release/recreate the
//                                              RTV on resize)
//      [14] ResizeTarget
//      [15] GetContainingOutput
//      [16] GetFrameStatistics
//      [17] GetLastPresentCount
//
//  Process at init :
//   1. Create a dummy D3D11 device + dummy swap chain on a temp
//      HWND (1×1 invisible). This gives us a valid vtable to grab
//      from — getting the address of Present without an instance
//      requires a real DXGI swap chain by design.
//   2. Cast the swap chain to a void** to read its vtable.
//   3. MinHook CreateHook on vtable[8] (Present) and vtable[13]
//      (ResizeBuffers), then enable.
//   4. Tear down the dummy device — the vtable pointer is shared
//      across ALL swap chains in the process, so our hook now
//      catches the GAME's swap chain even though we never saw it.
//
//  On first real Present we :
//   - QueryInterface for ID3D11Device / ID3D12Device to detect API
//   - Init imgui_impl_dx11 or imgui_impl_dx12 (D3D10 routes through
//     dx11 — anyone running a D3D10-only game in 2026 is doing
//     archaeology, not gaming)
//   - Install a WndProc hook (SetWindowLongPtr) on the swap chain's
//     output HWND so we can capture mouse + keyboard
// =====================================================================
#include "hook_dxgi.h"
#include "../renderer.h"
#include "../overlay_state.h"
#include "../frame_pipe.h"
#include "../renderers/texture_renderer_dx11.h"
#include "../nlog.h"
#include "../ipc.h"
#include <cstdio>

#include <windows.h>
#include <d3d11.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#include "MinHook.h"
#include "imgui.h"
#include "backends/imgui_impl_win32.h"
#include "backends/imgui_impl_dx11.h"
#include "backends/imgui_impl_dx12.h"

using Microsoft::WRL::ComPtr;

namespace nexus::hooks {

namespace {

using PresentFn       = HRESULT (STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using ResizeBuffersFn = HRESULT (STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);
using Present1Fn      = HRESULT (STDMETHODCALLTYPE*)(IDXGISwapChain1*, UINT, UINT, const DXGI_PRESENT_PARAMETERS*);

PresentFn       g_orig_present        = nullptr;
ResizeBuffersFn g_orig_resize_buffers = nullptr;
Present1Fn      g_orig_present1       = nullptr;

// Backend state — populated by the first Present call.
enum class Backend { None, D3D11, D3D12 };
Backend g_backend = Backend::None;

// D3D11 state
ComPtr<ID3D11Device>        g_d3d11_device;
ComPtr<ID3D11DeviceContext> g_d3d11_context;
ComPtr<ID3D11RenderTargetView> g_d3d11_rtv;

// D3D12 state — needed because dx12 has a different lifecycle.
ComPtr<ID3D12Device>        g_d3d12_device;
ComPtr<ID3D12CommandQueue>  g_d3d12_cmd_queue; // we INTERCEPT this from the game's swap chain via a separate hook
struct D3D12FrameContext {
    ComPtr<ID3D12CommandAllocator>     allocator;
    ComPtr<ID3D12Resource>             back_buffer;
    D3D12_CPU_DESCRIPTOR_HANDLE        rtv_descriptor{};
};
ComPtr<ID3D12CommandQueue>           g_d3d12_queue;
ComPtr<ID3D12GraphicsCommandList>    g_d3d12_cmdlist;
ComPtr<ID3D12DescriptorHeap>         g_d3d12_rtv_heap;
ComPtr<ID3D12DescriptorHeap>         g_d3d12_srv_heap;
std::vector<D3D12FrameContext>       g_d3d12_frames;

// HWND we hook for input. The first swap chain we see, we grab its
// output window and install a WndProc subclass.
HWND       g_game_hwnd        = nullptr;
WNDPROC    g_orig_wndproc     = nullptr;

bool g_imgui_initialized = false;

// v0.5.1 Phase 2 — D3D11 texture renderer (uploads RGBA frames from
// Electron offscreen window, draws fullscreen quad over game). When
// frame_pipe est connecté → on UTILISE ce renderer au lieu d'ImGui.
nexus::renderers::TextureRendererDX11 g_tex_renderer;
std::uint32_t g_last_consumed_frame_id = 0;

// v0.5.2 Phase 2 — forward un message Win32 d'input vers Electron via
// send_event JSON. Electron route ensuite via forwardInputToOverlay →
// sendInputEvent sur la window offscreen → React reçoit les events.
//
// On inclut la taille du viewport (game backbuffer) dans chaque event
// pour qu'Electron puisse calculer le ratio React/Game et mapper les
// coords correctement (la React rend à offscreen size, stretched à
// viewport size par texture_renderer).
std::atomic<uint32_t> g_game_viewport_w{1920};
std::atomic<uint32_t> g_game_viewport_h{1080};

void forward_input_to_electron(UINT msg, WPARAM wp, LPARAM lp) {
    static std::atomic<int> log_count{0};
    bool log_this = log_count.fetch_add(1) < 10;
    char buf[384];
    int x = (int)(short)LOWORD(lp);
    int y = (int)(short)HIWORD(lp);
    uint32_t vw = g_game_viewport_w.load();
    uint32_t vh = g_game_viewport_h.load();
    if (log_this && msg != WM_MOUSEMOVE) {
        nexus::nlog::log("dxgi: forward_input msg=0x%x wp=0x%llx x=%d y=%d",
            (unsigned)msg, (unsigned long long)wp, x, y);
    }
    // IMPORTANT — mouse events sont AUSSI envoyés par key_poll_thread_proc
    // dans dllmain.cpp via GetCursorPos + GetAsyncKeyState. Si on les
    // forwardait ici AUSSI on aurait 2 events identiques à 1-4ms d'écart
    // → React process le click 2x → un toggle button (panel open/close)
    // s'ouvre puis se referme immédiatement → user voit "rien".
    //
    // On garde le swallow des mouse messages (return 0 dans overlay_wndproc)
    // pour que le jeu ne les voie pas, mais on ne forward QUE les keys ici.
    // Le mouse forwarding est centralisé dans le key_poll thread (qui
    // marche AUSSI pour les jeux DirectInput exclusive où WndProc ne voit
    // pas les events souris du tout — LEGO Marvel par ex.).
    switch (msg) {
        case WM_MOUSEMOVE:
        case WM_LBUTTONDOWN: case WM_LBUTTONDBLCLK: case WM_LBUTTONUP:
        case WM_RBUTTONDOWN: case WM_RBUTTONDBLCLK: case WM_RBUTTONUP:
        case WM_MBUTTONDOWN: case WM_MBUTTONDBLCLK: case WM_MBUTTONUP:
        case WM_XBUTTONDOWN: case WM_XBUTTONDBLCLK: case WM_XBUTTONUP:
        case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
            // Skip — key_poll thread (dllmain.cpp) handle ces events.
            (void)buf; (void)x; (void)y; (void)vw; (void)vh;
            return;
        default: break;
    }
    switch (msg) {
        case WM_MOUSEMOVE:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseMove","x":%d,"y":%d,"vw":%u,"vh":%u})", x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_LBUTTONDOWN: case WM_LBUTTONDBLCLK:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseDown","x":%d,"y":%d,"button":"left","vw":%u,"vh":%u})", x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_LBUTTONUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseUp","x":%d,"y":%d,"button":"left","vw":%u,"vh":%u})", x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_RBUTTONDOWN: case WM_RBUTTONDBLCLK:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseDown","x":%d,"y":%d,"button":"right","vw":%u,"vh":%u})", x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_RBUTTONUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseUp","x":%d,"y":%d,"button":"right","vw":%u,"vh":%u})", x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_MBUTTONDOWN: case WM_MBUTTONDBLCLK:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseDown","x":%d,"y":%d,"button":"middle","vw":%u,"vh":%u})", x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_MBUTTONUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseUp","x":%d,"y":%d,"button":"middle","vw":%u,"vh":%u})", x, y, vw, vh);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_MOUSEWHEEL: {
            short delta = GET_WHEEL_DELTA_WPARAM(wp);
            // lp en mouseMove est client coords, en wheel c'est screen coords
            POINT pt = { x, y };
            HWND target_hwnd = g_game_hwnd;
            if (target_hwnd) ScreenToClient(target_hwnd, &pt);
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"mouseWheel","x":%ld,"y":%ld,"deltaY":%d})",
                pt.x, pt.y, (int)delta);
            nexus::ipc::send_event_async(buf);
            break;
        }
        case WM_KEYDOWN: case WM_SYSKEYDOWN:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"keyDown","keyCode":"VK_%lu"})", (unsigned long)wp);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_KEYUP: case WM_SYSKEYUP:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"keyUp","keyCode":"VK_%lu"})", (unsigned long)wp);
            nexus::ipc::send_event_async(buf);
            break;
        case WM_CHAR: case WM_SYSCHAR:
            std::snprintf(buf, sizeof(buf),
                R"({"type":"input","kind":"char","keyCode":"%lu"})", (unsigned long)wp);
            nexus::ipc::send_event_async(buf);
            break;
        default: break;
    }
}

LRESULT CALLBACK overlay_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    const bool overlay_visible = nexus::OverlayState::instance().visible();
    const bool phase2_active = nexus::frame_pipe::is_connected();

    // Phase 1 (ImGui interne) : route à ImGui d'abord.
    if (!phase2_active) {
        LRESULT r = nexus::renderer::wndproc_handler(hwnd, msg, wp, lp);
        if (r != 0 && overlay_visible) return r;
    }

    if (overlay_visible) {
        // Phase 2 : forward les inputs à Electron (sera dispatché à la
        // React UI offscreen via sendInputEvent).
        if (phase2_active) {
            forward_input_to_electron(msg, wp, lp);
        }
        // Hard-swallow tous les inputs gameplay : ils ne doivent JAMAIS
        // atteindre le jeu pendant que l'overlay est visible.
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

// Sub-class the game's window so we can intercept input. We only do
// this once (lazy on first Present).
void install_wndproc_hook(HWND hwnd) {
    if (g_orig_wndproc) return;
    g_game_hwnd    = hwnd;
    g_orig_wndproc = reinterpret_cast<WNDPROC>(
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC,
                          reinterpret_cast<LONG_PTR>(overlay_wndproc)));
}

void init_imgui_common(HWND hwnd) {
    if (ImGui::GetCurrentContext()) return;
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::StyleColorsDark();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr;  // don't write imgui.ini in the game folder
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    ImGui_ImplWin32_Init(hwnd);
}

bool init_d3d11_backend(IDXGISwapChain* swap_chain) {
    HRESULT hr = swap_chain->GetDevice(IID_PPV_ARGS(&g_d3d11_device));
    if (FAILED(hr) || !g_d3d11_device) return false;
    g_d3d11_device->GetImmediateContext(&g_d3d11_context);

    // Create the RTV for the back buffer — needed by imgui_impl_dx11.
    ComPtr<ID3D11Texture2D> back_buffer;
    swap_chain->GetBuffer(0, IID_PPV_ARGS(&back_buffer));
    if (back_buffer) {
        g_d3d11_device->CreateRenderTargetView(back_buffer.Get(), nullptr,
                                               g_d3d11_rtv.GetAddressOf());
    }

    ImGui_ImplDX11_Init(g_d3d11_device.Get(), g_d3d11_context.Get());
    g_backend = Backend::D3D11;
    return true;
}

bool init_d3d12_backend(IDXGISwapChain* swap_chain) {
    // D3D12 init is significantly heavier — we need :
    //   - the device
    //   - a command queue (game's, captured separately ; for v1 we
    //     just bail and let the user enable borderless windowed
    //     mode which falls back to our Electron overlay)
    //   - RTV / SRV descriptor heaps
    //   - one allocator + back-buffer ref per back-buffer (≥2)
    //
    // Properly hooking D3D12 requires also intercepting
    // ExecuteCommandLists on the queue to know the queue handle.
    // That's another vtable patch + ~80 lines.
    //
    // For Phase 1 we DETECT D3D12, log it, and skip the overlay :
    // the Electron borderless window still works for these games as
    // long as they don't run in DX12 exclusive fullscreen (rare —
    // most modern UE5/Unity games are borderless by default).
    HRESULT hr = swap_chain->GetDevice(IID_PPV_ARGS(&g_d3d12_device));
    if (FAILED(hr) || !g_d3d12_device) return false;
    OutputDebugStringW(L"[nexus-overlay/dxgi] D3D12 detected — proper backend init TBD (Phase 2). "
                       L"For now falls back to Electron borderless overlay.\n");
    g_backend = Backend::D3D12;
    // We DON'T return true — the D3D12 backend is not fully wired
    // in Phase 1. The hook stays installed (so we can detect the
    // game and surface the limitation to the user via IPC).
    return false;
}

// Forward declaration of the shared rendering core.
HRESULT do_present_rendering(IDXGISwapChain* swap_chain);

namespace dxgi_diag {
    uint64_t frame_counter = 0;
    bool last_visible = false;
}

// === Hook handler — Present (vtable[8] of IDXGISwapChain) ============
HRESULT STDMETHODCALLTYPE present_detour(IDXGISwapChain* swap_chain,
                                         UINT sync_interval, UINT flags) {
    do_present_rendering(swap_chain);
    return g_orig_present(swap_chain, sync_interval, flags);
}

// === Hook handler — Present1 (vtable[22] of IDXGISwapChain1) =========
HRESULT STDMETHODCALLTYPE present1_detour(IDXGISwapChain1* swap_chain1,
                                          UINT sync_interval, UINT flags,
                                          const DXGI_PRESENT_PARAMETERS* params) {
    do_present_rendering(swap_chain1);
    return g_orig_present1(swap_chain1, sync_interval, flags, params);
}

// === Shared rendering core, called by both present_detour & present1
HRESULT do_present_rendering(IDXGISwapChain* swap_chain) {
    dxgi_diag::frame_counter++;
    // Log à chaque changement de l'état visible
    bool current_vis = nexus::OverlayState::instance().visible();
    if (current_vis != dxgi_diag::last_visible) {
        nexus::nlog::log("dxgi: visible CHANGED %d -> %d (frame=%llu, init=%d)",
            dxgi_diag::last_visible, current_vis,
            dxgi_diag::frame_counter, g_imgui_initialized);
        dxgi_diag::last_visible = current_vis;
    }
    // Log périodique tous les 60 frames
    if (dxgi_diag::frame_counter % 60 == 0) {
        nexus::nlog::log("dxgi: frame=%llu visible=%d imgui_init=%d backend=%d",
            dxgi_diag::frame_counter, current_vis, g_imgui_initialized,
            (int)g_backend);
    }
    // Track game viewport size for input coord mapping. La React rend
    // à offscreen_size (DIP), stretched par texture_renderer à game
    // backbuffer size. Pour mapper un click game → React on multiplie
    // par (offscreen / viewport).
    {
        DXGI_SWAP_CHAIN_DESC d{};
        swap_chain->GetDesc(&d);
        if (d.BufferDesc.Width) g_game_viewport_w.store(d.BufferDesc.Width);
        if (d.BufferDesc.Height) g_game_viewport_h.store(d.BufferDesc.Height);
    }
    if (!g_imgui_initialized) {
        // First call — figure out which device class this swap chain
        // belongs to and init the matching ImGui backend.
        DXGI_SWAP_CHAIN_DESC desc{};
        swap_chain->GetDesc(&desc);
        nexus::nlog::log("dxgi: init attempt, hwnd=%p w=%u h=%u",
            desc.OutputWindow, desc.BufferDesc.Width, desc.BufferDesc.Height);
        if (desc.OutputWindow) {
            install_wndproc_hook(desc.OutputWindow);
            init_imgui_common(desc.OutputWindow);
        }
        if (init_d3d11_backend(swap_chain)) {
            g_imgui_initialized = true;
            nexus::nlog::log("dxgi: D3D11 backend initialized successfully");
        } else if (init_d3d12_backend(swap_chain)) {
            g_imgui_initialized = false;
            nexus::nlog::log("dxgi: D3D12 detected but NOT initialized (Phase 2 TBD)");
        } else {
            nexus::nlog::log("dxgi: NEITHER D3D11 NOR D3D12 backend init succeeded");
        }
    }

    if (g_imgui_initialized && g_backend == Backend::D3D11) {
        // v0.5.1 Phase 2 : si le frame_pipe est connecté, on dessine
        // la React UI rendue offscreen par Electron via le texture
        // renderer (no visible() gate — c'est la React qui contrôle
        // sa propre visibilité via opacity:0 quand fermé).
        if (nexus::frame_pipe::is_connected()) {
            // Init lazy au 1er Present.
            static bool tex_init_tried = false;
            if (!tex_init_tried) {
                tex_init_tried = true;
                g_tex_renderer.init(g_d3d11_device.Get());
            }
            // Pull la dernière frame si nouvelle.
            nexus::frame_pipe::Frame f;
            if (nexus::frame_pipe::pop_frame(f, g_last_consumed_frame_id)) {
                g_tex_renderer.update_texture(
                    g_d3d11_context.Get(), f.rgba.data(),
                    f.width, f.height);
                g_last_consumed_frame_id = f.frame_id;
            }
            // Draw seulement si on a déjà reçu au moins une frame.
            DXGI_SWAP_CHAIN_DESC desc{};
            swap_chain->GetDesc(&desc);
            if (g_d3d11_rtv && g_tex_renderer.has_texture()) {
                g_tex_renderer.draw(g_d3d11_context.Get(),
                                    g_d3d11_rtv.Get(),
                                    desc.BufferDesc.Width,
                                    desc.BufferDesc.Height);
            }
        } else if (nexus::OverlayState::instance().visible()) {
            // Fallback ImGui Phase 1 (pipe pas encore connecté ;
            // p.ex. injection avant Electron offscreen ready).
            ImGui_ImplDX11_NewFrame();
            ImGui_ImplWin32_NewFrame();
            ImGui::NewFrame();
            nexus::renderer::draw_frame();
            ImGui::Render();
            if (g_d3d11_rtv) {
                g_d3d11_context->OMSetRenderTargets(1, g_d3d11_rtv.GetAddressOf(), nullptr);
            }
            ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
        }
    }
    return S_OK; // caller (present_detour / present1_detour) calls the orig
}

HRESULT STDMETHODCALLTYPE resize_buffers_detour(IDXGISwapChain* swap_chain,
                                                UINT buffer_count, UINT width, UINT height,
                                                DXGI_FORMAT format, UINT flags) {
    // The game is changing back-buffer size (alt-tab in fullscreen,
    // resolution change, etc.). Our cached RTV is now invalid — drop
    // it BEFORE calling the original Resize. After the resize we
    // re-create lazily on next Present.
    g_d3d11_rtv.Reset();
    HRESULT hr = g_orig_resize_buffers(swap_chain, buffer_count, width, height, format, flags);
    if (SUCCEEDED(hr) && g_d3d11_device) {
        ComPtr<ID3D11Texture2D> back_buffer;
        swap_chain->GetBuffer(0, IID_PPV_ARGS(&back_buffer));
        if (back_buffer) {
            g_d3d11_device->CreateRenderTargetView(back_buffer.Get(), nullptr,
                                                   g_d3d11_rtv.GetAddressOf());
        }
    }
    return hr;
}

// Grab the IDXGISwapChain vtable by creating a one-shot dummy device.
bool capture_vtable(void**& vtable_out) {
    // Hidden, 1×1 window. We never show it ; ::WS_POPUP avoids the
    // taskbar entry.
    WNDCLASSEXW wc{};
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = DefWindowProcW;
    wc.hInstance     = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"nexus-overlay-probe";
    RegisterClassExW(&wc);
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"probe", WS_POPUP,
                                0, 0, 1, 1, nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) return false;

    DXGI_SWAP_CHAIN_DESC scd{};
    scd.BufferCount       = 1;
    scd.BufferDesc.Width  = 1;
    scd.BufferDesc.Height = 1;
    scd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    scd.BufferUsage       = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scd.OutputWindow      = hwnd;
    scd.SampleDesc.Count  = 1;
    scd.Windowed          = TRUE;
    scd.SwapEffect        = DXGI_SWAP_EFFECT_DISCARD;

    ComPtr<ID3D11Device>        dev;
    ComPtr<ID3D11DeviceContext> ctx;
    ComPtr<IDXGISwapChain>      sc;
    D3D_FEATURE_LEVEL           fl;
    const D3D_FEATURE_LEVEL fls[] = { D3D_FEATURE_LEVEL_11_0 };
    HRESULT hr = D3D11CreateDeviceAndSwapChain(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
        fls, _countof(fls), D3D11_SDK_VERSION, &scd,
        &sc, &dev, &fl, &ctx);
    if (FAILED(hr)) {
        // Fall back to WARP if no hardware renderer (CI / VMs).
        hr = D3D11CreateDeviceAndSwapChain(
            nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0,
            fls, _countof(fls), D3D11_SDK_VERSION, &scd,
            &sc, &dev, &fl, &ctx);
    }
    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);
    if (FAILED(hr) || !sc) return false;

    // Cast through void** to access the C-style vtable pointer.
    vtable_out = *reinterpret_cast<void***>(sc.Get());
    return true;
}

} // namespace

// Capture le vtable d'IDXGISwapChain1 via DXGIFactory2::CreateSwapChainForHwnd.
// IDXGISwapChain1 hérite d'IDXGISwapChain donc les 18 premiers slots sont
// les mêmes ; Present1 est à l'index 22.
bool capture_swapchain1_vtable(void**& vtable_out) {
    WNDCLASSEXW wc{};
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = DefWindowProcW;
    wc.hInstance     = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"nexus-overlay-probe2";
    RegisterClassExW(&wc);
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"probe2", WS_POPUP,
                                0, 0, 1, 1, nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) return false;

    ComPtr<ID3D11Device>        dev;
    ComPtr<ID3D11DeviceContext> ctx;
    D3D_FEATURE_LEVEL           fl;
    const D3D_FEATURE_LEVEL fls[] = { D3D_FEATURE_LEVEL_11_0 };
    HRESULT hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
        fls, _countof(fls), D3D11_SDK_VERSION,
        &dev, &fl, &ctx);
    if (FAILED(hr)) {
        hr = D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0,
            fls, _countof(fls), D3D11_SDK_VERSION,
            &dev, &fl, &ctx);
    }
    if (FAILED(hr) || !dev) {
        DestroyWindow(hwnd);
        UnregisterClassW(wc.lpszClassName, wc.hInstance);
        return false;
    }

    ComPtr<IDXGIFactory2> factory;
    hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr) || !factory) {
        DestroyWindow(hwnd);
        UnregisterClassW(wc.lpszClassName, wc.hInstance);
        return false;
    }

    DXGI_SWAP_CHAIN_DESC1 desc1{};
    desc1.Width       = 1;
    desc1.Height      = 1;
    desc1.Format      = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc1.SampleDesc.Count = 1;
    desc1.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc1.BufferCount = 2;
    desc1.SwapEffect  = DXGI_SWAP_EFFECT_FLIP_DISCARD;

    ComPtr<IDXGISwapChain1> sc1;
    hr = factory->CreateSwapChainForHwnd(dev.Get(), hwnd, &desc1, nullptr, nullptr, &sc1);
    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);
    if (FAILED(hr) || !sc1) return false;

    vtable_out = *reinterpret_cast<void***>(sc1.Get());
    return true;
}

bool install_dxgi() {
    void** vtable = nullptr;
    if (!capture_vtable(vtable)) {
        OutputDebugStringW(L"[nexus-overlay/dxgi] failed to capture vtable\n");
        return false;
    }

    void* present_addr        = vtable[8];   // IDXGISwapChain::Present
    void* resize_buffers_addr = vtable[13];  // IDXGISwapChain::ResizeBuffers

    if (MH_CreateHook(present_addr, &present_detour,
                      reinterpret_cast<void**>(&g_orig_present)) != MH_OK) {
        OutputDebugStringW(L"[nexus-overlay/dxgi] MH_CreateHook(Present) failed\n");
        return false;
    }
    if (MH_CreateHook(resize_buffers_addr, &resize_buffers_detour,
                      reinterpret_cast<void**>(&g_orig_resize_buffers)) != MH_OK) {
        OutputDebugStringW(L"[nexus-overlay/dxgi] MH_CreateHook(ResizeBuffers) failed\n");
        return false;
    }

    // Hook ALSO IDXGISwapChain1::Present1 (vtable[22]) — used by ANGLE,
    // UE5, Cocos2d-x and most modern engines. The legacy Present hook
    // alone misses these calls.
    void** vtable1 = nullptr;
    if (capture_swapchain1_vtable(vtable1)) {
        void* present1_addr = vtable1[22]; // IDXGISwapChain1::Present1
        if (MH_CreateHook(present1_addr, &present1_detour,
                          reinterpret_cast<void**>(&g_orig_present1)) != MH_OK) {
            nexus::nlog::log("MH_CreateHook(Present1) failed");
        } else {
            nexus::nlog::log("hooked IDXGISwapChain1::Present1 at %p", present1_addr);
        }
    } else {
        nexus::nlog::log("failed to capture IDXGISwapChain1 vtable (Present1 NOT hooked)");
    }

    if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
        OutputDebugStringW(L"[nexus-overlay/dxgi] MH_EnableHook failed\n");
        return false;
    }
    OutputDebugStringW(L"[nexus-overlay/dxgi] hook installed\n");
    nexus::nlog::log("dxgi hook fully installed; Present=%p Present1=%p",
        present_addr, vtable1 ? vtable1[22] : nullptr);
    return true;
}

void uninstall_dxgi() {
    if (g_imgui_initialized && g_backend == Backend::D3D11) {
        ImGui_ImplDX11_Shutdown();
    }
    if (ImGui::GetCurrentContext()) {
        ImGui_ImplWin32_Shutdown();
    }
    if (g_orig_wndproc && g_game_hwnd && IsWindow(g_game_hwnd)) {
        SetWindowLongPtrW(g_game_hwnd, GWLP_WNDPROC,
                          reinterpret_cast<LONG_PTR>(g_orig_wndproc));
        g_orig_wndproc = nullptr;
    }
    g_d3d11_rtv.Reset();
    g_d3d11_context.Reset();
    g_d3d11_device.Reset();
    g_d3d12_device.Reset();
    g_imgui_initialized = false;
    g_backend = Backend::None;
}

} // namespace nexus::hooks
