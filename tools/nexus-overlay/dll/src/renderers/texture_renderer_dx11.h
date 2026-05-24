// =====================================================================
//  texture_renderer_dx11.h — uploads a CPU RGBA buffer to a D3D11
//  shader-resource texture and draws it as a fullscreen quad with
//  alpha blending on top of the game's back buffer.
//
//  Lifecycle :
//    1. On first Present after init, init(device, context, rtv).
//    2. Each Present, if the frame_id changed, update_texture(...).
//    3. Each Present, draw() blits the texture onto the back buffer.
//    4. On ResizeBuffers, release() drops the SRV/texture so we can
//       re-create at the new size.
//
//  Pipeline :
//    Fullscreen triangle from a constant-buffer-less VS (computes
//    pos from SV_VertexID), PS samples the texture with bilinear.
//    No vertex buffer, no input layout — minimal state to disturb
//    the game's pipeline. Save+restore RTV, blend state, depth
//    stencil so the game's draw call after Present continues
//    seamlessly.
// =====================================================================
#pragma once

#include <cstdint>

// Include d3d11.h direct plutôt que forward-declare : les forward-decls
// à l'intérieur d'un namespace créent des types distincts (nexus::renderers::IXXX
// vs ::IXXX) et MSVC refuse la conversion. d3d11.h ajoute ~150K de
// déclarations mais c'est précompilé par le projet de toute façon.
#include <d3d11.h>

namespace nexus::renderers {

class TextureRendererDX11 {
public:
    bool init(ID3D11Device* device);
    void release();

    // Uploads RGBA pixels to the GPU texture, growing the texture
    // if the dimensions changed. `rgba` is `width * height * 4`
    // bytes, top-down, BGRA8 layout (Electron getBitmap output).
    void update_texture(ID3D11DeviceContext* ctx,
                        const std::uint8_t* rgba,
                        std::uint32_t width,
                        std::uint32_t height);

    // Draws the cached texture as a fullscreen quad on `rtv`.
    // Saves & restores state so the game's next draw call is
    // unaffected.
    void draw(ID3D11DeviceContext* ctx,
              ID3D11RenderTargetView* rtv,
              std::uint32_t viewport_w,
              std::uint32_t viewport_h);

    bool has_texture() const { return texture_w_ > 0; }

private:
    ID3D11Device*                device_   = nullptr;
    ID3D11Texture2D*             texture_  = nullptr;
    ID3D11ShaderResourceView*    srv_      = nullptr;
    ID3D11VertexShader*          vs_       = nullptr;
    ID3D11PixelShader*           ps_       = nullptr;
    ID3D11SamplerState*          sampler_  = nullptr;
    ID3D11BlendState*            blend_    = nullptr;
    ID3D11RasterizerState*       raster_   = nullptr;
    ID3D11DepthStencilState*     depth_    = nullptr;
    std::uint32_t                texture_w_= 0;
    std::uint32_t                texture_h_= 0;
};

} // namespace nexus::renderers
