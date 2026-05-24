cmake_minimum_required(VERSION 3.25)
project(nexus_overlay LANGUAGES CXX)

# Bitness — we build BOTH x64 (modern AAA, most games) and x86 (legacy
# 32-bit games : LEGO série, jeux pré-2014, certains indés). On ne peut
# pas injecter une DLL x64 dans un process x86 (et vice-versa) — donc
# il nous faut les deux paires injector+DLL.
#
# La détection se fait au runtime côté Electron : on lit le PE header
# du jeu (IMAGE_FILE_HEADER.Machine) et on choisit le bon couple
# nexus-overlay-injector + nexus-overlay.dll.
#
# Pour builder les deux : build.bat configure deux dirs séparés
# (build-x64/ et build-x86/) et CMake produit ses artefacts dans
# build-<arch>/dist/. Le script final regroupe sous
# build/dist/x64/ et build/dist/x86/.
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8 AND NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
    message(FATAL_ERROR "nexus-overlay supports x86 or x64 only. CMAKE_SIZEOF_VOID_P=${CMAKE_SIZEOF_VOID_P}")
endif()
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(NEXUS_OVERLAY_ARCH "x64")
else()
    set(NEXUS_OVERLAY_ARCH "x86")
endif()
message(STATUS "nexus-overlay building for ${NEXUS_OVERLAY_ARCH}")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Static MSVC runtime so the DLL doesn't drag in vcruntime140.dll —
# games don't always ship it and we don't want a load-time error
# during DllMain that would silently kill the injection. Trade-off :
# DLL is ~150 KB larger.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Force /MT for all targets.
if(MSVC)
    add_compile_options(/W4 /WX- /permissive- /Zc:__cplusplus /utf-8)
    add_compile_definitions(
        _CRT_SECURE_NO_WARNINGS
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        UNICODE
        _UNICODE
    )
endif()

# ─── Dear ImGui — FetchContent ───────────────────────────────────
# We pin to v1.91.5 (latest stable as of Q1 2026). Backends used :
#   - imgui_impl_win32         (input + window plumbing, all APIs)
#   - imgui_impl_dx9           (D3D9 hook)
#   - imgui_impl_dx11          (D3D10/11 hook — D3D10 uses DXGI but
#     we render via the D3D11 backend anyway, see hook_dxgi.cpp)
#   - imgui_impl_dx12          (D3D12 hook)
#   - imgui_impl_opengl3       (OpenGL hook)
#   - imgui_impl_vulkan        (Vulkan hook)
include(FetchContent)
FetchContent_Declare(
    imgui
    GIT_REPOSITORY https://github.com/ocornut/imgui.git
    GIT_TAG        v1.91.5
    GIT_SHALLOW    ON
)
FetchContent_MakeAvailable(imgui)

# ImGui doesn't ship a CMakeLists, we wrap it ourselves so each
# target can selectively link the backends it needs.
#
# Vulkan backend is GATED on Vulkan SDK detection — if VULKAN_SDK
# env var n'est pas set ou les headers vulkan/vulkan.h sont absents,
# on skip imgui_impl_vulkan.cpp (qui include vulkan/vulkan.h direct).
# Conséquence : pas d'overlay Vulkan, mais D3D9/11/12 + OpenGL marchent.
# Pour activer Vulkan : install Vulkan SDK from
# https://vulkan.lunarg.com/sdk/home#windows et re-configure.
find_package(Vulkan QUIET)

set(IMGUI_SOURCES
    ${imgui_SOURCE_DIR}/imgui.cpp
    ${imgui_SOURCE_DIR}/imgui_demo.cpp
    ${imgui_SOURCE_DIR}/imgui_draw.cpp
    ${imgui_SOURCE_DIR}/imgui_tables.cpp
    ${imgui_SOURCE_DIR}/imgui_widgets.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_win32.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_dx9.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_dx11.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_dx12.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp
)
if(Vulkan_FOUND)
    list(APPEND IMGUI_SOURCES ${imgui_SOURCE_DIR}/backends/imgui_impl_vulkan.cpp)
    set(NEXUS_OVERLAY_HAS_VULKAN ON CACHE INTERNAL "Vulkan backend enabled")
    message(STATUS "Vulkan SDK trouvé — backend Vulkan inclus")
else()
    set(NEXUS_OVERLAY_HAS_VULKAN OFF CACHE INTERNAL "Vulkan backend disabled")
    message(STATUS "Vulkan SDK absent — backend Vulkan désactivé (D3D + OpenGL OK)")
endif()

add_library(imgui STATIC ${IMGUI_SOURCES})
target_include_directories(imgui PUBLIC
    ${imgui_SOURCE_DIR}
    ${imgui_SOURCE_DIR}/backends
)
if(Vulkan_FOUND)
    target_link_libraries(imgui PUBLIC Vulkan::Vulkan)
    target_compile_definitions(imgui PUBLIC NEXUS_OVERLAY_HAS_VULKAN=1)
endif()

# ─── MinHook (vendored) ──────────────────────────────────────────
add_subdirectory(third_party/minhook)

# ─── Subprojects ─────────────────────────────────────────────────
add_subdirectory(dll)
add_subdirectory(injector)

# ─── Output copy — collect both artefacts in a single dist dir ──
add_custom_target(nexus_overlay_dist ALL
    COMMAND ${CMAKE_COMMAND} -E make_directory
        "${CMAKE_BINARY_DIR}/dist"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:nexus_overlay_dll>"
        "${CMAKE_BINARY_DIR}/dist/nexus-overlay.dll"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:nexus_overlay_injector>"
        "${CMAKE_BINARY_DIR}/dist/nexus-overlay-injector.exe"
    DEPENDS nexus_overlay_dll nexus_overlay_injector
    COMMENT "Collecting nexus-overlay artefacts into build/dist/"
)
