// =====================================================================
//  renderer.h — ImGui frame dispatch shared by all per-API hooks.
//
//  Each hook (DXGI / D3D9 / OpenGL / Vulkan) handles its own ImGui
//  backend init + render call. They all funnel through draw_frame()
//  which builds the actual UI (logo top, friends list, chat, …)
//  from the shared OverlayState.
// =====================================================================
#pragma once
#include <windows.h>

namespace nexus::renderer {

// Called from inside the hooked Present callback. Wraps :
//   ImGui::NewFrame() → draw UI → ImGui::Render()
// Assumes the backend's *_NewFrame() has already been invoked by
// the caller (each hook owns its own backend lifecycle).
void draw_frame();

// Win32 message procedure forwarded to ImGui so input (mouse,
// keyboard) routes correctly when the overlay is visible.
// Returns non-zero when ImGui WANTS the input ; the hooked WndProc
// should swallow the message in that case.
LRESULT wndproc_handler(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);

void shutdown();

} // namespace nexus::renderer
