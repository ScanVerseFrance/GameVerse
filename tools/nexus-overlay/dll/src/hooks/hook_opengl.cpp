// =====================================================================
//  hook_opengl.cpp — wglSwapBuffers hook
//
//  OpenGL doesn't have a vtable to patch ; the swap function lives
//  in opengl32.dll as a flat C export. We use MinHook on the
//  exported address directly — simpler than the COM hooks.
//
//  wglSwapBuffers signature :
//    BOOL WINAPI wglSwapBuffers(HDC hdc)
//
//  imgui_impl_opengl3 needs a current GL context, which the game
//  has set when wglSwapBuffers is called. We just :
//    1. New frame
//    2. Draw
//    3. Render via imgui_impl_opengl3_RenderDrawData
//    4. Forward to original wglSwapBuffers
//
//  imgui_impl_opengl3 uses GLAD for function loading internally so
//  we don't need a separate GL loader at our end ; it picks up the
//  context via wglGetCurrentContext().
// =====================================================================
#include "hook_opengl.h"
#include "../renderer.h"
#include "../overlay_state.h"
#include "../frame_pipe.h"
#include "../renderers/texture_renderer_gl.h"
#include "../nlog.h"

#include <windows.h>
#include <gl/GL.h>

#include "MinHook.h"
#include "imgui.h"
#include "backends/imgui_impl_win32.h"
#include "backends/imgui_impl_opengl3.h"

namespace nexus::hooks {

namespace {

using SwapBuffersFn = BOOL (WINAPI*)(HDC);
SwapBuffersFn g_orig_swap_buffers = nullptr;

bool       g_imgui_initialized = false;
HWND       g_game_hwnd      = nullptr;
WNDPROC    g_orig_wndproc   = nullptr;

// v0.5.1 Phase 2 — GL texture renderer (idem D3D11 path)
nexus::renderers::TextureRendererGL g_tex_renderer;
bool g_tex_init_tried = false;
std::uint32_t g_last_consumed_frame_id = 0;

LRESULT CALLBACK overlay_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    const bool overlay_visible = nexus::OverlayState::instance().visible();

    // Let ImGui process the message first (still used as Phase 1
    // fallback when DLL frame_pipe is not yet connected). When ImGui
    // returns non-zero AND overlay is visible, it means ImGui owns
    // this input — swallow.
    LRESULT r = nexus::renderer::wndproc_handler(hwnd, msg, wp, lp);
    if (r != 0 && overlay_visible) return r;

    // v0.5.1 fix — Steam-like input blocking. When the overlay is
    // visible (Shift+Tab pressed by user), the game must receive NO
    // keyboard / mouse / wheel input until the overlay closes. The
    // existing ImGui-delegating logic above only fires when ImGui
    // wants the event ; in Phase 2 (Electron offscreen texture) ImGui
    // is not drawn at all → ImGui returns 0 → game receives every
    // keystroke. We patch this by hard-swallowing all input messages
    // whenever the overlay is visible, regardless of ImGui's verdict.
    //
    // The user can still see the overlay window (a separate top-level
    // BrowserWindow), click on it to focus, and type normally —
    // Windows' click-to-focus delivers events to the overlay's HWND,
    // not via this WndProc.
    if (overlay_visible) {
        switch (msg) {
            // Keyboard
            case WM_KEYDOWN:
            case WM_KEYUP:
            case WM_SYSKEYDOWN:
            case WM_SYSKEYUP:
            case WM_CHAR:
            case WM_DEADCHAR:
            case WM_SYSCHAR:
            case WM_SYSDEADCHAR:
            case WM_UNICHAR:
            case WM_IME_CHAR:
            case WM_IME_COMPOSITION:
                return 0;
            // Mouse
            case WM_LBUTTONDOWN:
            case WM_LBUTTONUP:
            case WM_LBUTTONDBLCLK:
            case WM_RBUTTONDOWN:
            case WM_RBUTTONUP:
            case WM_RBUTTONDBLCLK:
            case WM_MBUTTONDOWN:
            case WM_MBUTTONUP:
            case WM_MBUTTONDBLCLK:
            case WM_XBUTTONDOWN:
            case WM_XBUTTONUP:
            case WM_XBUTTONDBLCLK:
            case WM_MOUSEMOVE:
            case WM_MOUSEWHEEL:
            case WM_MOUSEHWHEEL:
                return 0;
            // Raw input — some games bypass standard messages (Dark
            // Souls, racing sims). Swallow too.
            case WM_INPUT:
                return 0;
            default:
                break;
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
}

void init_imgui(HWND hwnd) {
    if (!ImGui::GetCurrentContext()) {
        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        ImGui::StyleColorsDark();
        ImGuiIO& io = ImGui::GetIO();
        io.IniFilename = nullptr;
        io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    }
    ImGui_ImplWin32_Init(hwnd);
    // GLSL #version 130 = OpenGL 3.0+. Most games from the last
    // decade support 4.x ; 1.30 is the safest baseline that ImGui's
    // backend supports.
    ImGui_ImplOpenGL3_Init("#version 130");
}

BOOL WINAPI swap_buffers_detour(HDC hdc) {
    static uint64_t frame_counter = 0;
    static bool last_visible = false;
    frame_counter++;
    if (!g_imgui_initialized) {
        HWND hwnd = WindowFromDC(hdc);
        if (hwnd) {
            nexus::nlog::log("ogl: init attempt, WindowFromDC=%p", hwnd);
            install_wndproc_hook(hwnd);
            init_imgui(hwnd);
            g_imgui_initialized = true;
            nexus::nlog::log("ogl: ImGui initialized + WndProc subclass installed");
        }
    }
    if (g_imgui_initialized) {
        bool vis = nexus::OverlayState::instance().visible();
        // Log à chaque changement de l'état visible (transition).
        if (vis != last_visible) {
            nexus::nlog::log("ogl: visible CHANGED %d -> %d (frame=%llu)", last_visible, vis, frame_counter);
            last_visible = vis;
        }
        // Log périodique tous les 60 frames pour confirmer rendu actif.
        if (frame_counter % 60 == 0) {
            nexus::nlog::log("ogl: frame=%llu visible=%d rendered=%d", frame_counter, vis, vis ? 1 : 0);
        }
        if (vis) {
            ImGui_ImplOpenGL3_NewFrame();
            ImGui_ImplWin32_NewFrame();
            ImGui::NewFrame();
            nexus::renderer::draw_frame();
            ImGui::Render();
            ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        }
    }
    return g_orig_swap_buffers(hdc);
}

} // namespace

bool install_opengl() {
    HMODULE gl = GetModuleHandleW(L"opengl32.dll");
    if (!gl) {
        OutputDebugStringW(L"[nexus-overlay/opengl] opengl32.dll not loaded\n");
        return false;
    }
    auto fn = reinterpret_cast<void*>(GetProcAddress(gl, "wglSwapBuffers"));
    if (!fn) {
        OutputDebugStringW(L"[nexus-overlay/opengl] wglSwapBuffers not exported\n");
        return false;
    }
    if (MH_CreateHook(fn, &swap_buffers_detour,
                      reinterpret_cast<void**>(&g_orig_swap_buffers)) != MH_OK) return false;
    if (MH_EnableHook(fn) != MH_OK) return false;
    OutputDebugStringW(L"[nexus-overlay/opengl] hook installed\n");
    return true;
}

void uninstall_opengl() {
    if (g_imgui_initialized) {
        ImGui_ImplOpenGL3_Shutdown();
        ImGui_ImplWin32_Shutdown();
        g_imgui_initialized = false;
    }
    if (g_orig_wndproc && g_game_hwnd && IsWindow(g_game_hwnd)) {
        SetWindowLongPtrW(g_game_hwnd, GWLP_WNDPROC,
                          reinterpret_cast<LONG_PTR>(g_orig_wndproc));
        g_orig_wndproc = nullptr;
    }
}

} // namespace nexus::hooks
