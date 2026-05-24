#include "ipc.h"
#include "overlay_state.h"
#include "nlog.h"

#include <windows.h>
#include <string>
#include <vector>
#include <cstdio>
#include <chrono>
#include <thread>
#include <mutex>
#include <condition_variable>

// ─── tiny JSON parser ────────────────────────────────────────────
//
// We don't pull in a heavyweight library (nlohmann::json adds ~250 KB
// to the DLL). The Electron server emits a flat, well-known schema,
// so a hand-rolled scanner is enough. Just enough to read :
//
//   {"type":"state","data":{"visible":true,"username":"Kazu",
//                            "game":{"title":"…","steamAppId":123,"coverUrl":"…"},
//                            "friends":[{"id":"…","name":"…","status":"in_game","gameTitle":"…","avatarUrl":"…"}, ...]}}
//
// Functions are intentionally narrow ; they bail on the first
// malformed character. Worst case the DLL keeps last-known state.
//
namespace {

// Extracts the bare string value associated with a JSON key. Returns
// empty string when not found. Does NOT unescape — Electron's
// payload is ASCII-clean and we never compare these strings against
// game logic, only display them.
std::string extract_string(const std::string& s, const std::string& key, size_t start = 0) {
    std::string needle = "\"" + key + "\"";
    size_t k = s.find(needle, start);
    if (k == std::string::npos) return {};
    size_t colon = s.find(':', k + needle.size());
    if (colon == std::string::npos) return {};
    size_t q1 = s.find('"', colon + 1);
    if (q1 == std::string::npos) return {};
    // Find the matching closing quote, tolerating backslash escapes.
    size_t q2 = q1 + 1;
    while (q2 < s.size() && s[q2] != '"') {
        if (s[q2] == '\\' && q2 + 1 < s.size()) q2 += 2;
        else                                    q2 += 1;
    }
    if (q2 >= s.size()) return {};
    return s.substr(q1 + 1, q2 - q1 - 1);
}

int extract_int(const std::string& s, const std::string& key, size_t start = 0) {
    std::string needle = "\"" + key + "\"";
    size_t k = s.find(needle, start);
    if (k == std::string::npos) return 0;
    size_t colon = s.find(':', k + needle.size());
    if (colon == std::string::npos) return 0;
    size_t p = colon + 1;
    while (p < s.size() && (s[p] == ' ' || s[p] == '\t')) ++p;
    return std::atoi(s.c_str() + p);
}

bool extract_bool(const std::string& s, const std::string& key, size_t start = 0) {
    std::string needle = "\"" + key + "\"";
    size_t k = s.find(needle, start);
    if (k == std::string::npos) return false;
    size_t colon = s.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t p = colon + 1;
    while (p < s.size() && (s[p] == ' ' || s[p] == '\t')) ++p;
    return s.compare(p, 4, "true") == 0;
}

void parse_state_into_globals(const std::string& json) {
    nexus::OverlayState& st = nexus::OverlayState::instance();

    st.set_visible(extract_bool(json, "visible"));
    st.set_username(extract_string(json, "username"));

    nexus::GameInfo g;
    g.title       = extract_string(json, "title");
    g.steamAppId  = extract_int   (json, "steamAppId");
    g.coverUrl    = extract_string(json, "coverUrl");
    st.set_game(std::move(g));

    // Friends array — naive scan : find each "{ ... }" between "friends":[ ... ]
    std::vector<nexus::Friend> friends;
    size_t a = json.find("\"friends\"");
    if (a != std::string::npos) {
        size_t bracket = json.find('[', a);
        size_t end     = json.find(']', bracket);
        if (bracket != std::string::npos && end != std::string::npos) {
            size_t i = bracket + 1;
            while (i < end) {
                size_t open  = json.find('{', i);
                if (open == std::string::npos || open >= end) break;
                size_t close = json.find('}', open);
                if (close == std::string::npos || close > end) break;
                std::string entry = json.substr(open, close - open + 1);

                nexus::Friend f;
                f.id        = extract_string(entry, "id");
                f.name      = extract_string(entry, "name");
                f.avatarUrl = extract_string(entry, "avatarUrl");
                f.gameTitle = extract_string(entry, "gameTitle");
                std::string status = extract_string(entry, "status");
                if      (status == "in_game") f.status = nexus::Friend::Status::InGame;
                else if (status == "online")  f.status = nexus::Friend::Status::Online;
                else if (status == "away")    f.status = nexus::Friend::Status::Away;
                else                          f.status = nexus::Friend::Status::Offline;
                if (!f.id.empty()) friends.push_back(std::move(f));
                i = close + 1;
            }
        }
    }
    st.set_friends(std::move(friends));
}

std::wstring read_launcher_pid_hint() {
    // The injector drops %TEMP%\nexus-overlay-target-<our_pid>.txt
    // containing the launcher's pid before CreateRemoteThread. We
    // read it here (in the game process) to know which named pipe
    // to connect to. Falls back to "0" if not found.
    wchar_t temp_dir[MAX_PATH];
    if (GetTempPathW(MAX_PATH, temp_dir) == 0) return L"0";
    wchar_t path[MAX_PATH];
    swprintf_s(path, L"%snexus-overlay-target-%lu.txt", temp_dir, GetCurrentProcessId());

    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return L"0";
    char buf[32]{};
    DWORD got = 0;
    ReadFile(h, buf, sizeof(buf) - 1, &got, nullptr);
    CloseHandle(h);
    DeleteFileW(path); // one-shot — we don't want it sitting in temp
    wchar_t wbuf[32]{};
    MultiByteToWideChar(CP_ACP, 0, buf, -1, wbuf, sizeof(wbuf)/sizeof(wbuf[0]));
    return wbuf[0] ? std::wstring(wbuf) : std::wstring(L"0");
}

std::wstring pipe_name() {
    // Per-launcher pipe so multiple Nexus instances (e.g. dev + prod)
    // don't collide. The launcher pid is read from the hint file the
    // injector dropped just before CreateRemoteThread.
    static std::wstring cached;
    if (cached.empty()) {
        cached = L"\\\\.\\pipe\\nexus-overlay-" + read_launcher_pid_hint();
    }
    return cached;
}

bool write_frame(HANDLE h, const std::string& payload) {
    uint32_t len = static_cast<uint32_t>(payload.size());
    DWORD written = 0;
    if (!WriteFile(h, &len, 4, &written, nullptr) || written != 4) return false;
    if (!WriteFile(h, payload.data(), len, &written, nullptr) || written != len) return false;
    return true;
}

static std::atomic<int> rf_log_count{0};
bool read_frame(HANDLE h, std::string& out, DWORD timeout_ms) {
    uint32_t len = 0;
    DWORD got = 0;
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeout_ms);
    DWORD avail = 0;
    bool log_this_call = rf_log_count.fetch_add(1) < 5;
    while (avail < 4) {
        if (!PeekNamedPipe(h, nullptr, 0, nullptr, &avail, nullptr)) {
            DWORD err = GetLastError();
            if (log_this_call) nexus::nlog::log("read_frame: PeekNamedPipe FAILED, GLE=%lu", err);
            return false;
        }
        if (avail >= 4) break;
        if (std::chrono::steady_clock::now() > deadline) {
            if (log_this_call) nexus::nlog::log("read_frame: deadline exceeded, avail=%lu", avail);
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    // Lit 16 bytes au lieu de 4 — on log les premiers bytes pour
    // diagnose si on tombe pas mal alignés dans le stream.
    char raw[16] = {0};
    if (!ReadFile(h, raw, 4, &got, nullptr) || got != 4) {
        DWORD err = GetLastError();
        if (log_this_call) nexus::nlog::log("read_frame: ReadFile(header) FAILED, got=%lu GLE=%lu", got, err);
        return false;
    }
    memcpy(&len, raw, 4);
    if (log_this_call) {
        DWORD peek_after = 0;
        PeekNamedPipe(h, nullptr, 0, nullptr, &peek_after, nullptr);
        nexus::nlog::log("read_frame: header bytes=%02x %02x %02x %02x → len=%u (avail_after=%lu)",
            (unsigned char)raw[0], (unsigned char)raw[1], (unsigned char)raw[2], (unsigned char)raw[3],
            len, peek_after);
    }
    if (len == 0 || len > 1024 * 1024) {
        if (log_this_call) nexus::nlog::log("read_frame: invalid len=%u (rejected)", len);
        return false;
    }

    out.resize(len);
    DWORD remaining = len;
    char* p = out.data();
    while (remaining > 0) {
        if (!ReadFile(h, p, remaining, &got, nullptr)) {
            DWORD err = GetLastError();
            if (log_this_call) nexus::nlog::log("read_frame: ReadFile(body) FAILED, GLE=%lu", err);
            return false;
        }
        if (got == 0) {
            if (log_this_call) nexus::nlog::log("read_frame: ReadFile(body) returned 0 bytes");
            return false;
        }
        p         += got;
        remaining -= got;
    }
    return true;
}

HANDLE open_pipe_blocking(const std::wstring& name, const std::atomic<bool>& shutdown) {
    constexpr auto kRetryDelay = std::chrono::milliseconds(500);
    while (!shutdown.load()) {
        HANDLE h = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE,
                               0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h != INVALID_HANDLE_VALUE) return h;
        DWORD err = GetLastError();
        if (err == ERROR_PIPE_BUSY) {
            // Server is up but all instances are in use ; back off
            // and retry.
            WaitNamedPipeW(name.c_str(), 2000);
            continue;
        }
        // Server not running yet — wait. Pipe SHOULD be up before
        // injection but DllMain may run before our IPC server
        // accept-loop is ready on slow boots.
        std::this_thread::sleep_for(kRetryDelay);
    }
    return INVALID_HANDLE_VALUE;
}

std::mutex g_send_mutex;

} // namespace

namespace nexus::ipc {

void run(const std::atomic<bool>& shutdown) {
    const std::wstring name = pipe_name();
    nexus::nlog::log("ipc::run starting");
    OutputDebugStringW((L"[nexus-overlay/ipc] target pipe : " + name + L"\n").c_str());

    HANDLE pipe = open_pipe_blocking(name, shutdown);
    if (pipe == INVALID_HANDLE_VALUE) {
        nexus::nlog::log("ipc::run: open_pipe_blocking returned INVALID_HANDLE");
        return;
    }
    nexus::nlog::log("ipc::run: initial pipe opened OK");

    constexpr auto kPollInterval = std::chrono::milliseconds(500);
    uint64_t poll_count = 0;
    uint64_t reconnect_count = 0;
    while (!shutdown.load()) {
        if (!write_frame(pipe, R"({"type":"get-state"})")) {
            reconnect_count++;
            if (reconnect_count <= 5 || reconnect_count % 50 == 0) {
                nexus::nlog::log("ipc: write_frame FAILED (reconnect #%llu)", reconnect_count);
            }
            CloseHandle(pipe);
            pipe = open_pipe_blocking(name, shutdown);
            if (pipe == INVALID_HANDLE_VALUE) return;
            continue;
        }
        std::string reply;
        if (!read_frame(pipe, reply, 3000)) {
            reconnect_count++;
            if (reconnect_count <= 5 || reconnect_count % 50 == 0) {
                nexus::nlog::log("ipc: read_frame FAILED (reconnect #%llu, GetLastError=%lu)",
                    reconnect_count, GetLastError());
            }
            CloseHandle(pipe);
            pipe = open_pipe_blocking(name, shutdown);
            if (pipe == INVALID_HANDLE_VALUE) return;
            continue;
        }
        poll_count++;
        if (poll_count <= 3 || poll_count % 20 == 0) {
            nexus::nlog::log("ipc: poll #%llu OK, reply.size=%zu, first 80 chars: %.80s",
                poll_count, reply.size(), reply.c_str());
        }
        parse_state_into_globals(reply);
        std::this_thread::sleep_for(kPollInterval);
    }
    CloseHandle(pipe);
}

void send_event(const char* json_payload) {
    if (!json_payload) return;
    std::lock_guard<std::mutex> lk(g_send_mutex);
    HANDLE h = CreateFileW(pipe_name().c_str(),
                           GENERIC_READ | GENERIC_WRITE,
                           0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    write_frame(h, json_payload);
    std::string ack;
    read_frame(h, ack, 1000);
    CloseHandle(h);
}

// ─── Async event queue + worker thread ───────────────────────────
//
// send_event_async() : push le payload sur une queue, signal le
// worker, retourne IMMÉDIATEMENT. Le worker drain la queue et fait
// CreateFile + WriteFile + CloseHandle pour chaque event (PAS de
// read pour l'ack — fire-and-forget). Critique pour les events
// appelés depuis la WndProc hookée du jeu : un send synchrone qui
// attend l'ack bloque le message pump du jeu plusieurs secondes.
namespace {
std::mutex g_async_mutex;
std::condition_variable g_async_cv;
std::vector<std::string> g_async_queue;
std::thread g_async_thread;
std::atomic<bool> g_async_shutdown{false};
std::atomic<bool> g_async_started{false};

void async_worker() {
    std::vector<std::string> batch;
    while (!g_async_shutdown.load()) {
        {
            std::unique_lock<std::mutex> lk(g_async_mutex);
            g_async_cv.wait_for(lk, std::chrono::milliseconds(50), [] {
                return !g_async_queue.empty() || g_async_shutdown.load();
            });
            if (g_async_shutdown.load()) return;
            batch.swap(g_async_queue);
        }
        for (const auto& payload : batch) {
            HANDLE h = CreateFileW(pipe_name().c_str(),
                                   GENERIC_WRITE,
                                   0, nullptr, OPEN_EXISTING, 0, nullptr);
            if (h == INVALID_HANDLE_VALUE) continue;
            // Fire-and-forget : on écrit le frame et on ferme. Aucune
            // attente d'ack — le serveur Electron va processer
            // l'event et drop la réponse silencieusement.
            write_frame(h, payload);
            CloseHandle(h);
        }
        batch.clear();
    }
}
}

void send_event_async(const char* json_payload) {
    if (!json_payload) return;
    // Lazy-start le worker thread au premier appel.
    bool expected = false;
    if (g_async_started.compare_exchange_strong(expected, true)) {
        g_async_thread = std::thread(async_worker);
        g_async_thread.detach();
    }
    {
        std::lock_guard<std::mutex> lk(g_async_mutex);
        // Cap la queue pour éviter qu'elle explose si Electron lag.
        // 1000 events = ~16 secondes de mousemove 60Hz. Plus que ça
        // on drop les plus anciens (le user n'aura jamais besoin de
        // 1000 events queued).
        if (g_async_queue.size() >= 1000) {
            g_async_queue.erase(g_async_queue.begin(),
                g_async_queue.begin() + 500);
        }
        g_async_queue.emplace_back(json_payload);
    }
    g_async_cv.notify_one();
}

} // namespace nexus::ipc
