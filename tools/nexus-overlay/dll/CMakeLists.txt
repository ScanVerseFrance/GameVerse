set(NEXUS_DLL_SOURCES
    src/dllmain.cpp
    src/nlog.cpp
    src/overlay_state.cpp
    src/ipc.cpp
    src/frame_pipe.cpp
    src/renderer.cpp
    src/borderless.cpp
    src/hooks/hook_dxgi.cpp
    src/hooks/hook_d3d9.cpp
    src/hooks/hook_opengl.cpp
    src/renderers/texture_renderer_dx11.cpp
    src/renderers/texture_renderer_gl.cpp
)
if(NEXUS_OVERLAY_HAS_VULKAN)
    list(APPEND NEXUS_DLL_SOURCES src/hooks/hook_vulkan.cpp)
endif()

add_library(nexus_overlay_dll SHARED ${NEXUS_DLL_SOURCES})

set_target_properties(nexus_overlay_dll PROPERTIES
    OUTPUT_NAME "nexus-overlay"
    PREFIX ""        # we want "nexus-overlay.dll" not "libnexus-overlay.dll"
    SUFFIX ".dll"
)

target_include_directories(nexus_overlay_dll PRIVATE src)

target_link_libraries(nexus_overlay_dll PRIVATE
    minhook
    imgui
    # Graphics SDK libs — the hooks link against ALL of them but use
    # delay-loading so the DLL doesn't actually require these to be
    # present at process attach. The game already has the ones it uses
    # loaded ; we just hook into them.
    d3d9
    dxgi
    d3d11
    d3d12
    opengl32
    # System libs
    user32
    gdi32
    kernel32
)
if(NEXUS_OVERLAY_HAS_VULKAN)
    target_link_libraries(nexus_overlay_dll PRIVATE vulkan-1)
    target_compile_definitions(nexus_overlay_dll PRIVATE NEXUS_OVERLAY_HAS_VULKAN=1)
endif()

# Delay-load graphics DLLs so injection into a game that uses only
# (say) D3D11 doesn't fail with "vulkan-1.dll not found".
if(MSVC)
    target_link_options(nexus_overlay_dll PRIVATE
        /DELAYLOAD:d3d9.dll
        /DELAYLOAD:d3d11.dll
        /DELAYLOAD:d3d12.dll
    )
    if(NEXUS_OVERLAY_HAS_VULKAN)
        target_link_options(nexus_overlay_dll PRIVATE /DELAYLOAD:vulkan-1.dll)
    endif()
    target_link_libraries(nexus_overlay_dll PRIVATE delayimp)
endif()
