#include "texture_renderer_dx11.h"

#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <cstring>

#pragma comment(lib, "d3dcompiler.lib")

namespace nexus::renderers {

namespace {

// Vertex shader : generates 3 vertices forming a fullscreen triangle
// from SV_VertexID, no input layout required. UV is computed inline.
constexpr const char* kVS = R"(
struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
VSOut main(uint vid : SV_VertexID) {
    VSOut o;
    // (id=0) → (-1,-1), (id=1) → (3,-1), (id=2) → (-1,3)
    // Covers screen with one extra triangle ; the GPU clips outside.
    float2 uv = float2((vid << 1) & 2, vid & 2);
    o.uv  = uv;
    o.pos = float4(uv * 2.0 - 1.0, 0.0, 1.0);
    // Flip Y because Electron's bitmap is top-down but D3D NDC is
    // y-up.
    o.pos.y = -o.pos.y;
    return o;
}
)";

// Pixel shader : samples the BGRA texture and outputs RGBA. The HLSL
// reads `Sample` as float4 in the texture's native channel order, so
// for a BGRA8 texture the float4.rgb is actually B,G,R. We swizzle
// to .bgr in output to recover RGBA on the back buffer.
//
// Alpha-blending is configured via the blend state ; here we just
// pass-through the color with its alpha so the OM stage can do the
// SRC_ALPHA / INV_SRC_ALPHA blend.
constexpr const char* kPS = R"(
Texture2D    tex : register(t0);
SamplerState smp : register(s0);
struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
float4 main(VSOut input) : SV_TARGET {
    float4 c = tex.Sample(smp, input.uv);
    return float4(c.b, c.g, c.r, c.a); // BGRA → RGBA swizzle
}
)";

template <class T>
void safe_release(T*& p) {
    if (p) { p->Release(); p = nullptr; }
}

bool compile_shader(const char* src, const char* entry, const char* target,
                    ID3DBlob** out_blob) {
    ID3DBlob* err = nullptr;
    HRESULT hr = D3DCompile(src, std::strlen(src), nullptr, nullptr, nullptr,
                            entry, target, 0, 0, out_blob, &err);
    if (FAILED(hr)) {
        if (err) {
            OutputDebugStringA((const char*)err->GetBufferPointer());
            err->Release();
        }
        return false;
    }
    if (err) err->Release();
    return true;
}

} // namespace

bool TextureRendererDX11::init(ID3D11Device* device) {
    if (device_) return true; // already initialized
    device_ = device;

    // Compile shaders.
    ID3DBlob* vs_blob = nullptr;
    ID3DBlob* ps_blob = nullptr;
    if (!compile_shader(kVS, "main", "vs_5_0", &vs_blob)) return false;
    if (!compile_shader(kPS, "main", "ps_5_0", &ps_blob)) {
        vs_blob->Release();
        return false;
    }
    device_->CreateVertexShader(vs_blob->GetBufferPointer(),
                                vs_blob->GetBufferSize(), nullptr, &vs_);
    device_->CreatePixelShader(ps_blob->GetBufferPointer(),
                               ps_blob->GetBufferSize(), nullptr, &ps_);
    vs_blob->Release();
    ps_blob->Release();
    if (!vs_ || !ps_) { release(); return false; }

    // Sampler — bilinear, clamp (we cover the whole screen exactly so
    // wrap/clamp doesn't matter, but clamp is safer if quad is offset).
    D3D11_SAMPLER_DESC sd{};
    sd.Filter         = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU       = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressV       = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressW       = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.MinLOD         = 0;
    sd.MaxLOD         = D3D11_FLOAT32_MAX;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    device_->CreateSamplerState(&sd, &sampler_);

    // Blend state — straight alpha (Electron paint produces straight
    // alpha BGRA, not premultiplied).
    D3D11_BLEND_DESC bd{};
    bd.RenderTarget[0].BlendEnable           = TRUE;
    bd.RenderTarget[0].SrcBlend              = D3D11_BLEND_SRC_ALPHA;
    bd.RenderTarget[0].DestBlend             = D3D11_BLEND_INV_SRC_ALPHA;
    bd.RenderTarget[0].BlendOp               = D3D11_BLEND_OP_ADD;
    bd.RenderTarget[0].SrcBlendAlpha         = D3D11_BLEND_ONE;
    bd.RenderTarget[0].DestBlendAlpha        = D3D11_BLEND_INV_SRC_ALPHA;
    bd.RenderTarget[0].BlendOpAlpha          = D3D11_BLEND_OP_ADD;
    bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    device_->CreateBlendState(&bd, &blend_);

    // Rasterizer — no culling so the fullscreen triangle isn't
    // discarded depending on winding order, no scissor (we cover the
    // whole RT).
    D3D11_RASTERIZER_DESC rd{};
    rd.FillMode        = D3D11_FILL_SOLID;
    rd.CullMode        = D3D11_CULL_NONE;
    rd.DepthClipEnable = FALSE;
    device_->CreateRasterizerState(&rd, &raster_);

    // Depth/stencil disabled — overlay must always pass.
    D3D11_DEPTH_STENCIL_DESC dsd{};
    dsd.DepthEnable    = FALSE;
    dsd.StencilEnable  = FALSE;
    device_->CreateDepthStencilState(&dsd, &depth_);

    if (!sampler_ || !blend_ || !raster_ || !depth_) {
        release();
        return false;
    }
    return true;
}

void TextureRendererDX11::release() {
    safe_release(srv_);
    safe_release(texture_);
    safe_release(vs_);
    safe_release(ps_);
    safe_release(sampler_);
    safe_release(blend_);
    safe_release(raster_);
    safe_release(depth_);
    device_     = nullptr;
    texture_w_  = 0;
    texture_h_  = 0;
}

void TextureRendererDX11::update_texture(ID3D11DeviceContext* ctx,
                                          const std::uint8_t* rgba,
                                          std::uint32_t width,
                                          std::uint32_t height) {
    if (!device_ || !ctx || !rgba || width == 0 || height == 0) return;
    if (width != texture_w_ || height != texture_h_) {
        // Recreate at the new size.
        safe_release(srv_);
        safe_release(texture_);
        D3D11_TEXTURE2D_DESC td{};
        td.Width            = width;
        td.Height           = height;
        td.MipLevels        = 1;
        td.ArraySize        = 1;
        td.Format           = DXGI_FORMAT_B8G8R8A8_UNORM; // Electron BGRA
        td.SampleDesc.Count = 1;
        td.Usage            = D3D11_USAGE_DYNAMIC;
        td.BindFlags        = D3D11_BIND_SHADER_RESOURCE;
        td.CPUAccessFlags   = D3D11_CPU_ACCESS_WRITE;
        if (FAILED(device_->CreateTexture2D(&td, nullptr, &texture_))) return;
        D3D11_SHADER_RESOURCE_VIEW_DESC sd{};
        sd.Format              = DXGI_FORMAT_B8G8R8A8_UNORM;
        sd.ViewDimension       = D3D11_SRV_DIMENSION_TEXTURE2D;
        sd.Texture2D.MipLevels = 1;
        device_->CreateShaderResourceView(texture_, &sd, &srv_);
        texture_w_ = width;
        texture_h_ = height;
    }
    if (!texture_) return;
    D3D11_MAPPED_SUBRESOURCE m{};
    if (SUCCEEDED(ctx->Map(texture_, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
        // Copy row-by-row to handle a stride mismatch (Electron =
        // width*4, GPU pitch may include padding).
        const std::uint32_t row = width * 4;
        std::uint8_t* dst = static_cast<std::uint8_t*>(m.pData);
        const std::uint8_t* src = rgba;
        for (std::uint32_t y = 0; y < height; ++y) {
            std::memcpy(dst, src, row);
            dst += m.RowPitch;
            src += row;
        }
        ctx->Unmap(texture_, 0);
    }
}

void TextureRendererDX11::draw(ID3D11DeviceContext* ctx,
                                ID3D11RenderTargetView* rtv,
                                std::uint32_t viewport_w,
                                std::uint32_t viewport_h) {
    if (!ctx || !rtv || !srv_ || !vs_ || !ps_) return;

    // === Save state we're about to overwrite, restore at end. The
    //     game's pipeline must come out untouched ; otherwise the
    //     next draw call paints with our shaders / texture. ===
    ID3D11RenderTargetView* old_rtv     = nullptr;
    ID3D11DepthStencilView* old_dsv     = nullptr;
    ctx->OMGetRenderTargets(1, &old_rtv, &old_dsv);

    ID3D11VertexShader* old_vs = nullptr;
    ID3D11PixelShader*  old_ps = nullptr;
    ctx->VSGetShader(&old_vs, nullptr, nullptr);
    ctx->PSGetShader(&old_ps, nullptr, nullptr);

    ID3D11SamplerState* old_sampler = nullptr;
    ctx->PSGetSamplers(0, 1, &old_sampler);

    ID3D11ShaderResourceView* old_srv = nullptr;
    ctx->PSGetShaderResources(0, 1, &old_srv);

    ID3D11BlendState* old_blend = nullptr;
    float old_blend_factor[4]{};
    UINT  old_sample_mask = 0;
    ctx->OMGetBlendState(&old_blend, old_blend_factor, &old_sample_mask);

    ID3D11RasterizerState* old_raster = nullptr;
    ctx->RSGetState(&old_raster);

    ID3D11DepthStencilState* old_depth = nullptr;
    UINT old_stencil_ref = 0;
    ctx->OMGetDepthStencilState(&old_depth, &old_stencil_ref);

    D3D11_PRIMITIVE_TOPOLOGY old_topo;
    ctx->IAGetPrimitiveTopology(&old_topo);

    UINT old_vp_count = 1;
    D3D11_VIEWPORT old_vp{};
    ctx->RSGetViewports(&old_vp_count, &old_vp);

    ID3D11InputLayout* old_input_layout = nullptr;
    ctx->IAGetInputLayout(&old_input_layout);

    // === Bind our state ===
    ctx->OMSetRenderTargets(1, &rtv, nullptr);
    ctx->IASetInputLayout(nullptr);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetShader(vs_, nullptr, 0);
    ctx->PSSetShader(ps_, nullptr, 0);
    ctx->PSSetShaderResources(0, 1, &srv_);
    ctx->PSSetSamplers(0, 1, &sampler_);
    float bf[4] = {0, 0, 0, 0};
    ctx->OMSetBlendState(blend_, bf, 0xFFFFFFFF);
    ctx->RSSetState(raster_);
    ctx->OMSetDepthStencilState(depth_, 0);

    D3D11_VIEWPORT vp{};
    vp.Width    = static_cast<float>(viewport_w);
    vp.Height   = static_cast<float>(viewport_h);
    vp.MinDepth = 0;
    vp.MaxDepth = 1;
    ctx->RSSetViewports(1, &vp);

    ctx->Draw(3, 0); // 1 fullscreen triangle (SV_VertexID 0/1/2)

    // === Restore ===
    ctx->OMSetRenderTargets(1, &old_rtv, old_dsv);
    safe_release(old_rtv);
    safe_release(old_dsv);
    ctx->VSSetShader(old_vs, nullptr, 0);
    safe_release(old_vs);
    ctx->PSSetShader(old_ps, nullptr, 0);
    safe_release(old_ps);
    ctx->PSSetSamplers(0, 1, &old_sampler);
    safe_release(old_sampler);
    ctx->PSSetShaderResources(0, 1, &old_srv);
    safe_release(old_srv);
    ctx->OMSetBlendState(old_blend, old_blend_factor, old_sample_mask);
    safe_release(old_blend);
    ctx->RSSetState(old_raster);
    safe_release(old_raster);
    ctx->OMSetDepthStencilState(old_depth, old_stencil_ref);
    safe_release(old_depth);
    ctx->IASetPrimitiveTopology(old_topo);
    ctx->IASetInputLayout(old_input_layout);
    safe_release(old_input_layout);
    ctx->RSSetViewports(old_vp_count, &old_vp);
}

} // namespace nexus::renderers
