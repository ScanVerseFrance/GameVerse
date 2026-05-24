#include "texture_renderer_gl.h"

#include <windows.h>
#include <gl/GL.h>
#include <cstring>
#include <cstdio>
#include <cstddef>


// === GL 3.0+ entry points we need (not in legacy gl.h) ===============
// We resolve these via wglGetProcAddress at init. Typedefs are
// copied from <GL/glcorearb.h> to avoid pulling the whole header.

using GLchar    = char;
using GLsizeiptr = std::ptrdiff_t;
using GLintptr  = std::ptrdiff_t;

#define GL_FRAGMENT_SHADER         0x8B30
#define GL_VERTEX_SHADER           0x8B31
#define GL_COMPILE_STATUS          0x8B81
#define GL_LINK_STATUS             0x8B82
#define GL_ARRAY_BUFFER            0x8892
#define GL_STATIC_DRAW             0x88E4
#define GL_BGRA                    0x80E1
#define GL_TEXTURE0                0x84C0
#define GL_CLAMP_TO_EDGE           0x812F
#define GL_FUNC_ADD                0x8006
#define GL_BLEND_DST_ALPHA         0x80CA
#define GL_BLEND_SRC_ALPHA         0x80CB

typedef GLuint   (APIENTRY* PFNGLCREATESHADERPROC)(GLenum);
typedef void     (APIENTRY* PFNGLSHADERSOURCEPROC)(GLuint, GLsizei, const GLchar* const*, const GLint*);
typedef void     (APIENTRY* PFNGLCOMPILESHADERPROC)(GLuint);
typedef void     (APIENTRY* PFNGLGETSHADERIVPROC)(GLuint, GLenum, GLint*);
typedef void     (APIENTRY* PFNGLGETSHADERINFOLOGPROC)(GLuint, GLsizei, GLsizei*, GLchar*);
typedef GLuint   (APIENTRY* PFNGLCREATEPROGRAMPROC)();
typedef void     (APIENTRY* PFNGLATTACHSHADERPROC)(GLuint, GLuint);
typedef void     (APIENTRY* PFNGLLINKPROGRAMPROC)(GLuint);
typedef void     (APIENTRY* PFNGLGETPROGRAMIVPROC)(GLuint, GLenum, GLint*);
typedef void     (APIENTRY* PFNGLUSEPROGRAMPROC)(GLuint);
typedef GLint    (APIENTRY* PFNGLGETUNIFORMLOCATIONPROC)(GLuint, const GLchar*);
typedef void     (APIENTRY* PFNGLUNIFORM1IPROC)(GLint, GLint);
typedef void     (APIENTRY* PFNGLDELETESHADERPROC)(GLuint);
typedef void     (APIENTRY* PFNGLDELETEPROGRAMPROC)(GLuint);
typedef void     (APIENTRY* PFNGLGENVERTEXARRAYSPROC)(GLsizei, GLuint*);
typedef void     (APIENTRY* PFNGLBINDVERTEXARRAYPROC)(GLuint);
typedef void     (APIENTRY* PFNGLGENBUFFERSPROC)(GLsizei, GLuint*);
typedef void     (APIENTRY* PFNGLBINDBUFFERPROC)(GLenum, GLuint);
typedef void     (APIENTRY* PFNGLBUFFERDATAPROC)(GLenum, GLsizeiptr, const void*, GLenum);
typedef void     (APIENTRY* PFNGLENABLEVERTEXATTRIBARRAYPROC)(GLuint);
typedef void     (APIENTRY* PFNGLVERTEXATTRIBPOINTERPROC)(GLuint, GLint, GLenum, GLboolean, GLsizei, const void*);
typedef void     (APIENTRY* PFNGLACTIVETEXTUREPROC)(GLenum);
typedef void     (APIENTRY* PFNGLDELETEVERTEXARRAYSPROC)(GLsizei, const GLuint*);
typedef void     (APIENTRY* PFNGLDELETEBUFFERSPROC)(GLsizei, const GLuint*);

static PFNGLCREATESHADERPROC            glCreateShader            = nullptr;
static PFNGLSHADERSOURCEPROC            glShaderSource            = nullptr;
static PFNGLCOMPILESHADERPROC           glCompileShader           = nullptr;
static PFNGLGETSHADERIVPROC             glGetShaderiv             = nullptr;
static PFNGLGETSHADERINFOLOGPROC        glGetShaderInfoLog        = nullptr;
static PFNGLCREATEPROGRAMPROC           glCreateProgram           = nullptr;
static PFNGLATTACHSHADERPROC            glAttachShader            = nullptr;
static PFNGLLINKPROGRAMPROC             glLinkProgram             = nullptr;
static PFNGLGETPROGRAMIVPROC            glGetProgramiv            = nullptr;
static PFNGLUSEPROGRAMPROC              glUseProgram              = nullptr;
static PFNGLGETUNIFORMLOCATIONPROC      glGetUniformLocation      = nullptr;
static PFNGLUNIFORM1IPROC               glUniform1i               = nullptr;
static PFNGLDELETESHADERPROC            glDeleteShader            = nullptr;
static PFNGLDELETEPROGRAMPROC           glDeleteProgram           = nullptr;
static PFNGLGENVERTEXARRAYSPROC         glGenVertexArrays         = nullptr;
static PFNGLBINDVERTEXARRAYPROC         glBindVertexArray         = nullptr;
static PFNGLGENBUFFERSPROC              glGenBuffers              = nullptr;
static PFNGLBINDBUFFERPROC              glBindBuffer              = nullptr;
static PFNGLBUFFERDATAPROC              glBufferData              = nullptr;
static PFNGLENABLEVERTEXATTRIBARRAYPROC glEnableVertexAttribArray = nullptr;
static PFNGLVERTEXATTRIBPOINTERPROC     glVertexAttribPointer     = nullptr;
static PFNGLACTIVETEXTUREPROC           glActiveTexture           = nullptr;
static PFNGLDELETEVERTEXARRAYSPROC      glDeleteVertexArrays      = nullptr;
static PFNGLDELETEBUFFERSPROC           glDeleteBuffers           = nullptr;

#pragma comment(lib, "opengl32.lib")

namespace nexus::renderers {

namespace {

template <class F>
bool resolve(F& fn, const char* name) {
    fn = reinterpret_cast<F>(wglGetProcAddress(name));
    return fn != nullptr;
}

// GLSL 130 = OpenGL 3.0 — supporté par Cocos2d-x et la plupart des
// engines anciens / récents. Plus haut (#version 330) cassait sur
// Geometry Dash qui tourne en GL compat 3.0.
const char* kVS = R"GLSL(
#version 130
out vec2 vUV;
void main() {
    // Fullscreen quad via vertex ID — 4 verts, TRIANGLE_STRIP.
    vec2 p = vec2((gl_VertexID == 1 || gl_VertexID == 3) ? 1.0 : -1.0,
                  (gl_VertexID >= 2)                     ? -1.0 :  1.0);
    vUV = vec2(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
    gl_Position = vec4(p, 0.0, 1.0);
}
)GLSL";

const char* kPS = R"GLSL(
#version 130
in  vec2 vUV;
out vec4 oColor;
uniform sampler2D uTex;
void main() {
    // v0.5.1 Phase 2 fix — pas de swizzle ici. Le driver fait déjà
    // la conversion BGRA→RGBA via glTexImage2D(internal=GL_RGBA,
    // src=GL_BGRA). Si on swizzle aussi côté shader, on inverse R/B
    // → le violet (accent-primary) ressort en orange. C'est ce qui
    // a causé le bug "deux notifs de couleurs différentes" :
    // dedicated toast-window (OS) = violet correct, offscreen via
    // DLL = orange faux.
    oColor = texture(uTex, vUV);
}
)GLSL";

GLuint compile(GLenum type, const char* src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024]{};
        glGetShaderInfoLog(s, sizeof(log), nullptr, log);
        OutputDebugStringA("[nexus-overlay/gl] shader compile failed: ");
        OutputDebugStringA(log);
        OutputDebugStringA("\n");
        glDeleteShader(s);
        return 0;
    }
    return s;
}

} // namespace

bool TextureRendererGL::resolve_proc_addresses() {
    static bool resolved = false;
    if (resolved) return true;
    bool ok = true;
    ok &= resolve(glCreateShader,            "glCreateShader");
    ok &= resolve(glShaderSource,            "glShaderSource");
    ok &= resolve(glCompileShader,           "glCompileShader");
    ok &= resolve(glGetShaderiv,             "glGetShaderiv");
    ok &= resolve(glGetShaderInfoLog,        "glGetShaderInfoLog");
    ok &= resolve(glCreateProgram,           "glCreateProgram");
    ok &= resolve(glAttachShader,            "glAttachShader");
    ok &= resolve(glLinkProgram,             "glLinkProgram");
    ok &= resolve(glGetProgramiv,            "glGetProgramiv");
    ok &= resolve(glUseProgram,              "glUseProgram");
    ok &= resolve(glGetUniformLocation,      "glGetUniformLocation");
    ok &= resolve(glUniform1i,               "glUniform1i");
    ok &= resolve(glDeleteShader,            "glDeleteShader");
    ok &= resolve(glDeleteProgram,           "glDeleteProgram");
    ok &= resolve(glGenVertexArrays,         "glGenVertexArrays");
    ok &= resolve(glBindVertexArray,         "glBindVertexArray");
    ok &= resolve(glGenBuffers,              "glGenBuffers");
    ok &= resolve(glBindBuffer,              "glBindBuffer");
    ok &= resolve(glBufferData,              "glBufferData");
    ok &= resolve(glEnableVertexAttribArray, "glEnableVertexAttribArray");
    ok &= resolve(glVertexAttribPointer,     "glVertexAttribPointer");
    ok &= resolve(glActiveTexture,           "glActiveTexture");
    ok &= resolve(glDeleteVertexArrays,      "glDeleteVertexArrays");
    ok &= resolve(glDeleteBuffers,           "glDeleteBuffers");
    resolved = ok;
    return ok;
}

bool TextureRendererGL::init() {
    if (initialized_) return true;
    if (!resolve_proc_addresses()) {
        OutputDebugStringW(L"[nexus-overlay/gl] proc address resolve failed\n");
        return false;
    }

    GLuint vs = compile(GL_VERTEX_SHADER,   kVS);
    GLuint fs = compile(GL_FRAGMENT_SHADER, kPS);
    if (!vs || !fs) return false;
    program_ = glCreateProgram();
    glAttachShader(program_, vs);
    glAttachShader(program_, fs);
    glLinkProgram(program_);
    GLint linked = 0;
    glGetProgramiv(program_, GL_LINK_STATUS, &linked);
    glDeleteShader(vs);
    glDeleteShader(fs);
    if (!linked) {
        OutputDebugStringW(L"[nexus-overlay/gl] program link failed\n");
        return false;
    }

    // VAO + VBO empty — fullscreen-quad is generated via gl_VertexID
    // in the VS, so no real vertex data is needed. Still need a VAO
    // bound for the draw to be valid in core profile.
    glGenVertexArrays(1, &vao_);
    glBindVertexArray(vao_);
    glBindVertexArray(0);

    // Texture id allocation (size set later in update_texture).
    glGenTextures(1, &texture_id_);
    glBindTexture(GL_TEXTURE_2D, texture_id_);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S,     GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T,     GL_CLAMP_TO_EDGE);
    glBindTexture(GL_TEXTURE_2D, 0);

    initialized_ = true;
    return true;
}

void TextureRendererGL::release() {
    if (program_   && glDeleteProgram)      glDeleteProgram(program_);
    if (texture_id_)                        glDeleteTextures(1, &texture_id_);
    if (vao_      && glDeleteVertexArrays)  glDeleteVertexArrays(1, &vao_);
    if (vbo_      && glDeleteBuffers)       glDeleteBuffers(1, &vbo_);
    program_     = 0;
    texture_id_  = 0;
    vao_         = 0;
    vbo_         = 0;
    texture_w_   = 0;
    texture_h_   = 0;
    initialized_ = false;
}

void TextureRendererGL::update_texture(const std::uint8_t* rgba,
                                       std::uint32_t width,
                                       std::uint32_t height) {
    if (!initialized_ || !rgba || width == 0 || height == 0) return;
    glBindTexture(GL_TEXTURE_2D, texture_id_);
    if (width != texture_w_ || height != texture_h_) {
        // Resize via full alloc.
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA,
                     static_cast<GLsizei>(width),
                     static_cast<GLsizei>(height),
                     0, GL_BGRA, GL_UNSIGNED_BYTE, rgba);
        texture_w_ = width;
        texture_h_ = height;
    } else {
        glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0,
                        static_cast<GLsizei>(width),
                        static_cast<GLsizei>(height),
                        GL_BGRA, GL_UNSIGNED_BYTE, rgba);
    }
    glBindTexture(GL_TEXTURE_2D, 0);
}

void TextureRendererGL::draw(std::uint32_t viewport_w, std::uint32_t viewport_h) {
    if (!initialized_ || !texture_w_) return;

    // === Save state ===
    GLint  old_program   = 0;  glGetIntegerv(0x8B8D /*GL_CURRENT_PROGRAM*/, &old_program);
    GLint  old_vao       = 0;  glGetIntegerv(0x85B5 /*GL_VERTEX_ARRAY_BINDING*/, &old_vao);
    GLint  old_texture   = 0;  glGetIntegerv(GL_TEXTURE_BINDING_2D, &old_texture);
    GLint  old_active    = 0;  glGetIntegerv(0x84E0 /*GL_ACTIVE_TEXTURE*/, &old_active);
    GLboolean old_blend  = glIsEnabled(GL_BLEND);
    GLboolean old_depth  = glIsEnabled(GL_DEPTH_TEST);
    GLboolean old_cull   = glIsEnabled(GL_CULL_FACE);
    GLboolean old_scissor= glIsEnabled(GL_SCISSOR_TEST);
    GLint old_blend_src  = 0;  glGetIntegerv(GL_BLEND_SRC,        &old_blend_src);
    GLint old_blend_dst  = 0;  glGetIntegerv(GL_BLEND_DST,        &old_blend_dst);
    GLint old_viewport[4]{}; glGetIntegerv(GL_VIEWPORT, old_viewport);
    // v0.5.1 — sauve aussi le FBO courant. Cocos2d-x (Geometry Dash)
    // utilise des FBO pour le post-process ; sans binder le default
    // framebuffer 0 explicitement, notre draw va dans le wrong FBO
    // et ne s'affiche pas sur le swap chain → clignotement.
    GLint old_draw_fbo   = 0;  glGetIntegerv(0x8CA6 /*GL_DRAW_FRAMEBUFFER_BINDING*/, &old_draw_fbo);
    GLint old_read_fbo   = 0;  glGetIntegerv(0x8CAA /*GL_READ_FRAMEBUFFER_BINDING*/, &old_read_fbo);

    // === Setup our state ===
    // Bind default framebuffer = back buffer (le seul que wglSwapBuffers
    // va swap au front buffer visible).
    // 0x8D40 = GL_FRAMEBUFFER. On utilise la GL_FRAMEBUFFER (read+draw)
    // qui marche sur GL 3.0+.
    // PFNGLBINDFRAMEBUFFERPROC is needed but Cocos2d-x context exposes
    // it. We resolve it lazily.
    static auto bindFB = (void(APIENTRY*)(GLenum, GLuint))wglGetProcAddress("glBindFramebuffer");
    if (bindFB) bindFB(0x8D40 /*GL_FRAMEBUFFER*/, 0);

    glViewport(0, 0, static_cast<GLsizei>(viewport_w), static_cast<GLsizei>(viewport_h));
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glDisable(GL_SCISSOR_TEST);

    glUseProgram(program_);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, texture_id_);
    GLint loc = glGetUniformLocation(program_, "uTex");
    if (loc >= 0) glUniform1i(loc, 0);
    glBindVertexArray(vao_);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glBindVertexArray(0);

    // === Restore ===
    glActiveTexture(static_cast<GLenum>(old_active));
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(old_texture));
    glUseProgram(static_cast<GLuint>(old_program));
    glBindVertexArray(static_cast<GLuint>(old_vao));
    if (!old_blend)  glDisable(GL_BLEND);
    if (old_depth)   glEnable(GL_DEPTH_TEST);
    if (old_cull)    glEnable(GL_CULL_FACE);
    if (old_scissor) glEnable(GL_SCISSOR_TEST);
    glBlendFunc(static_cast<GLenum>(old_blend_src), static_cast<GLenum>(old_blend_dst));
    glViewport(old_viewport[0], old_viewport[1], old_viewport[2], old_viewport[3]);
    if (bindFB) {
        bindFB(0x8CA8 /*GL_DRAW_FRAMEBUFFER*/, (GLuint)old_draw_fbo);
        bindFB(0x8CA9 /*GL_READ_FRAMEBUFFER*/, (GLuint)old_read_fbo);
    }
}

} // namespace nexus::renderers
