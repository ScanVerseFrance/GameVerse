#include "frame_pipe.h"
#include "nlog.h"

#include <windows.h>
#include <chrono>
#include <thread>
#include <cstdio>
#include <cstring>

// Reuse the launcher PID resolver from ipc.cpp. We don't include
// ipc.h to avoid coupling; the env var fallback in resolve_pipe_name
// is sufficient.

namespace nexus::frame_pipe {

namespace {

constexpr std::size_t HEADER_SIZE = 16; // 4 u32

std::mutex   g_mutex;
Frame        g_latest;
std::atomic<bool> g_connected{false};

// Read the launcher PID — same logic as in ipc.cpp. We re-implement
// it here standalone to keep frame_pipe a self-contained module.
DWORD read_launcher_pid_hint() {
    // Try env var first (faster, set by injector).
    char buf[32]{};
    DWORD len = GetEnvironmentVariableA("NEXUS_LAUNCHER_PID", buf, sizeof(buf));
    if (len > 0 && len < sizeof(buf)) {
        DWORD pid = static_cast<DWORD>(std::atoi(buf));
        if (pid > 0) return pid;
    }
    // Fallback : hint file dropped by injector at
    // %TEMP%\nexus-overlay-target-<our_pid>.txt
    char temp_dir[MAX_PATH]{};
    GetTempPathA(MAX_PATH, temp_dir);
    char hint_path[MAX_PATH]{};
    std::snprintf(hint_path, sizeof(hint_path),
                  "%snexus-overlay-target-%lu.txt",
                  temp_dir, GetCurrentProcessId());
    HANDLE f = CreateFileA(hint_path, GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return 0;
    char content[32]{};
    DWORD read = 0;
    ReadFile(f, content, sizeof(content) - 1, &read, nullptr);
    CloseHandle(f);
    return static_cast<DWORD>(std::atoi(content));
}

// Read exactly `count` bytes from the pipe into buf, looping on
// partial reads. Returns false on EOF / error.
bool read_exact(HANDLE h, std::uint8_t* buf, std::size_t count) {
    std::size_t total = 0;
    while (total < count) {
        DWORD chunk = 0;
        BOOL ok = ReadFile(h, buf + total,
                           static_cast<DWORD>(count - total), &chunk, nullptr);
        if (!ok || chunk == 0) return false;
        total += chunk;
    }
    return true;
}

std::uint32_t le_u32(const std::uint8_t* p) {
    return static_cast<std::uint32_t>(p[0]) |
           (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) |
           (static_cast<std::uint32_t>(p[3]) << 24);
}

// Connect-loop : retries every 500ms until we get the pipe or
// shutdown is requested. Returns INVALID_HANDLE_VALUE on shutdown.
HANDLE connect_loop(const std::atomic<bool>& shutdown) {
    int retry = 0;
    while (!shutdown.load()) {
        DWORD launcher_pid = read_launcher_pid_hint();
        if (launcher_pid == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            continue;
        }
        char pipe_name[128]{};
        std::snprintf(pipe_name, sizeof(pipe_name),
                      "\\\\.\\pipe\\nexus-overlay-frames-%lu",
                      static_cast<unsigned long>(launcher_pid));
        HANDLE h = CreateFileA(pipe_name, GENERIC_READ | GENERIC_WRITE,
                                0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
            nexus::nlog::log("frame_pipe: connected after %d retries", retry);
            return h;
        }
        DWORD err = GetLastError();
        if (retry < 3 || retry % 20 == 0) {
            nexus::nlog::log("frame_pipe: CreateFile failed retry=%d err=%lu", retry, err);
        }
        retry++;
        // Pipe not up yet — Electron might still be booting, or the
        // user hasn't pressed Shift+Tab so no offscreen window. Retry.
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    return INVALID_HANDLE_VALUE;
}

} // namespace

void run(const std::atomic<bool>& shutdown) {
    nexus::nlog::log("frame_pipe: run() started");
    int session = 0;
    while (!shutdown.load()) {
        HANDLE h = connect_loop(shutdown);
        if (h == INVALID_HANDLE_VALUE) break;
        g_connected.store(true);
        session++;
        nexus::nlog::log("frame_pipe: session #%d started", session);
        int frames_this_session = 0;

        std::uint8_t header[HEADER_SIZE];
        std::vector<std::uint8_t> tmp;
        while (!shutdown.load()) {
            if (!read_exact(h, header, HEADER_SIZE)) {
                nexus::nlog::log("frame_pipe: header read FAILED (err=%lu) after %d frames",
                    GetLastError(), frames_this_session);
                break;
            }
            std::uint32_t fid    = le_u32(header + 0);
            std::uint32_t w      = le_u32(header + 4);
            std::uint32_t hgt    = le_u32(header + 8);
            std::uint32_t stride = le_u32(header + 12);
            std::size_t payload_size = static_cast<std::size_t>(stride) * hgt;
            // Sanity cap — refuse > 64 MB (≈ 4K RGBA). Means the
            // header is corrupted, abort the connection.
            if (payload_size == 0 || payload_size > 64 * 1024 * 1024) {
                nexus::nlog::log("frame_pipe: bad payload_size=%zu (fid=%u w=%u h=%u stride=%u) — dropping",
                    payload_size, fid, w, hgt, stride);
                break;
            }
            tmp.resize(payload_size);
            if (!read_exact(h, tmp.data(), payload_size)) {
                nexus::nlog::log("frame_pipe: payload read FAILED (err=%lu, fid=%u, want=%zu) after %d frames",
                    GetLastError(), fid, payload_size, frames_this_session);
                break;
            }

            // Swap into shared latest_frame.
            {
                std::lock_guard<std::mutex> lk(g_mutex);
                g_latest.frame_id = fid;
                g_latest.width    = w;
                g_latest.height   = hgt;
                g_latest.stride   = stride;
                g_latest.rgba.swap(tmp);
                tmp.resize(payload_size); // re-prepare next-read buffer
            }
            frames_this_session++;
            if (frames_this_session <= 3 || frames_this_session % 100 == 0) {
                nexus::nlog::log("frame_pipe: frame #%d received fid=%u w=%u h=%u",
                    frames_this_session, fid, w, hgt);
            }
        }

        g_connected.store(false);
        CloseHandle(h);
        nexus::nlog::log("frame_pipe: session #%d ended after %d frames",
            session, frames_this_session);
        // Reconnect after a short pause to absorb temporary disconnects
        // (Electron reload during HMR, etc.).
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    g_connected.store(false);
    nexus::nlog::log("frame_pipe: run() exiting");
}

bool pop_frame(Frame& out, std::uint32_t since_frame_id) {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (g_latest.frame_id == 0 || g_latest.frame_id == since_frame_id) {
        return false;
    }
    out.frame_id = g_latest.frame_id;
    out.width    = g_latest.width;
    out.height   = g_latest.height;
    out.stride   = g_latest.stride;
    out.rgba     = g_latest.rgba; // copy
    return true;
}

bool is_connected() { return g_connected.load(); }

} // namespace nexus::frame_pipe
