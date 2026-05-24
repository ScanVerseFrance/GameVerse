// =====================================================================
//  hook_vulkan.cpp — vkQueuePresentKHR hook
//
//  Vulkan presents through `vkQueuePresentKHR`, which is loaded via
//  `vkGetDeviceProcAddr` per-device. We hook the FLAT export from
//  vulkan-1.dll (it's also a proper export despite the strict
//  loader rules) ; this catches all device queues uniformly.
//
//  Note : the proper Vulkan way to overlay would be to write our
//  own Vulkan LAYER and ship a .json manifest in the layer search
//  path. That's cleaner (no inject required, just a registry key
//  per game) but it requires admin/install setup per-machine.
//
//  Hook approach has the same constraints as DXGI Phase 1 : we
//  need to track per-frame resources (image views, descriptors,
//  pipelines for ImGui). For Phase 1 we DETECT Vulkan and log it,
//  then defer to the Electron borderless overlay. Phase 2 will
//  implement the proper imgui_impl_vulkan integration.
//
//  In practice, Vulkan games on Windows in 2026 are mostly :
//   - Doom Eternal / The Talos Principle 2 (id Tech 7)
//   - Red Dead Redemption 2 (RAGE engine, swappable DX12)
//   - Star Citizen (Vulkan since 2024)
//   - Most Unity HDRP titles
//  Almost all of them ALSO support DX12 fallback. The user can
//  toggle the API in the game settings as a workaround.
// =====================================================================
#include "hook_vulkan.h"

#include <windows.h>

#include "MinHook.h"

namespace nexus::hooks {

namespace {

using QueuePresentFn = uint32_t (*)(void* queue, const void* present_info);
QueuePresentFn g_orig_queue_present = nullptr;

uint32_t queue_present_detour(void* queue, const void* present_info) {
    // Phase 1 : the hook is installed (so we DON'T no-op the present)
    // and we just forward. Phase 2 will :
    //   - keep a VkInstance + VkDevice cache resolved at first call
    //     via vkGetInstanceProcAddr / vkGetDeviceProcAddr
    //   - allocate descriptor pools per swap chain image
    //   - call ImGui_ImplVulkan_NewFrame + Render before passing
    //     control back to the game's actual queue present
    return g_orig_queue_present(queue, present_info);
}

} // namespace

bool install_vulkan() {
    HMODULE vk = GetModuleHandleW(L"vulkan-1.dll");
    if (!vk) {
        OutputDebugStringW(L"[nexus-overlay/vulkan] vulkan-1.dll not loaded\n");
        return false;
    }
    auto fn = reinterpret_cast<void*>(GetProcAddress(vk, "vkQueuePresentKHR"));
    if (!fn) {
        OutputDebugStringW(L"[nexus-overlay/vulkan] vkQueuePresentKHR not exported\n");
        return false;
    }
    if (MH_CreateHook(fn, &queue_present_detour,
                      reinterpret_cast<void**>(&g_orig_queue_present)) != MH_OK) return false;
    if (MH_EnableHook(fn) != MH_OK) return false;
    OutputDebugStringW(L"[nexus-overlay/vulkan] hook installed (Phase 1 — render TBD)\n");
    return true;
}

void uninstall_vulkan() {
    // No allocation done in Phase 1, nothing to free.
}

} // namespace nexus::hooks
