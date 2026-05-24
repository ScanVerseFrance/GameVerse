// =====================================================================
//  texture_renderer_gl.h — OpenGL counterpart of texture_renderer_dx11.
//  Uploads RGBA bytes to a GL texture and draws as fullscreen quad
//  with alpha blending on top of the game's framebuffer.
//
//  Same shape as the D3D11 renderer : init() on first Present,
//  update_texture() when a new frame arrives, draw() each Present.
//  Saves & restores the GL state we touch so the game's draw calls
//  after wglSwapBuffers continue normally.
//
//  Constraints :
//   - Pure GL 3.0+ (VAO + shaders). Cocos2d-x games typically use a
//     compat profile with legacy fixed pipeline available, but we
//     keep ours modern to avoid disturbing the matrix stack etc.
//   - GL function pointers are resolved via wglGetProcAddress on
//     first init. We don't link against an extension loader (glad,
//     GLEW) to keep the DLL tiny.
// =====================================================================
#pragma once
#include <cstdint>

namespace nexus::renderers {

class TextureRendererGL {
public:
    bool init();
    void release();

    // Uploads RGBA pixels to the GPU texture.
    void update_texture(const std::uint8_t* rgba,
                        std::uint32_t width,
                        std::uint32_t height);

    // Draws the cached texture covering the entire viewport.
    void draw(std::uint32_t viewport_w, std::uint32_t viewport_h);

    bool has_texture() const { return texture_w_ > 0; }

private:
    bool resolve_proc_addresses();

    unsigned int texture_id_ = 0;
    unsigned int program_    = 0;
    unsigned int vao_        = 0;
    unsigned int vbo_        = 0;
    std::uint32_t texture_w_ = 0;
    std::uint32_t texture_h_ = 0;
    bool         initialized_ = false;
};

} // namespace nexus::renderers
