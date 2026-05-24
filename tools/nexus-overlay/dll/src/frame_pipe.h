// =====================================================================
//  frame_pipe.h — binary pipe client that receives RGBA frames from
//  Electron's offscreen overlay window.
//
//  Pipe path : \\.\pipe\nexus-overlay-frames-<launcher_pid>
//
//  Frame protocol (Electron → DLL) :
//    [frame_id u32 LE]
//    [width u32 LE]
//    [height u32 LE]
//    [stride u32 LE]
//    [rgba bytes : width * height * 4]
//
//  The pipe stays open for the lifetime of the DLL. A background
//  thread blocks on ReadFile, decodes the header + pixel payload,
//  swaps the frame into `latest_frame` (mutex-protected). Renderer
//  side (D3D11/GL) pulls the buffer in its Present hook.
//
//  Memory : we keep ONE buffer always sized to (width*height*4) +
//  reallocate only on dimension change. Frames are written into the
//  same buffer in-place so the renderer can always read the latest
//  without needing a queue.
// =====================================================================
#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <vector>

namespace nexus::frame_pipe {

struct Frame {
    std::uint32_t frame_id   = 0;
    std::uint32_t width      = 0;
    std::uint32_t height     = 0;
    std::uint32_t stride     = 0;       // bytes per row
    std::vector<std::uint8_t> rgba;     // BGRA8 (Electron natively); the
                                        // renderer swizzles in shader if needed
};

// Background worker — pulled in from dllmain. Loop tries to connect
// to the named pipe, then ReadFiles frames until socket dies. Exits
// when shutdown is signalled.
void run(const std::atomic<bool>& shutdown);

// Snapshot the latest frame into `out`. Returns true if a frame is
// available (since boot or since the last consumed `seen_frame_id`).
// O(1) + a memcpy of width*height*4 bytes (held in shared buffer).
//
// Renderer pattern :
//   if (frame_pipe::pop_frame(my_frame, last_seen)) {
//       upload_texture(my_frame.rgba.data(), my_frame.width, my_frame.height);
//       last_seen = my_frame.frame_id;
//   }
//   // draw cached texture each Present.
bool pop_frame(Frame& out, std::uint32_t since_frame_id);

// Is the pipe currently connected to Electron's server ? Used by
// the Present hook to decide whether to attempt drawing (no
// connection = no React overlay available, skip).
bool is_connected();

} // namespace nexus::frame_pipe
