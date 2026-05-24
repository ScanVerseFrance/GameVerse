// =====================================================================
//  hook_dxgi.h — IDXGISwapChain::Present hook (D3D 10 / 11 / 12)
//
//  All three Direct3D versions use IDXGISwapChain from DXGI for
//  frame presentation. We install ONE detour on the Present
//  vtable slot ; at first call we QueryInterface the swap chain's
//  device to determine which D3D version we got, then init the
//  matching ImGui backend (Dx10/11/12 share via Dx11 for our
//  purposes, Dx12 needs its own backend due to bind-less resources).
// =====================================================================
#pragma once
namespace nexus::hooks {

bool install_dxgi();
void uninstall_dxgi();

} // namespace nexus::hooks
