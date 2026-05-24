// =====================================================================
//  nexus-overlay-injector.exe
//
//  Standalone .exe that does ONE thing : inject nexus-overlay.dll
//  into a target process via the classic CreateRemoteThread +
//  LoadLibraryW pattern.
//
//  Usage :
//    nexus-overlay-injector.exe --pid=<target> --dll=<path> --launcher-pid=<self>
//
//  Args :
//    --pid=N           target process id (the game we want to overlay)
//    --dll=PATH        absolute path to nexus-overlay.dll
//    --launcher-pid=N  the Electron launcher's pid — passed to the DLL
//                      via env var NEXUS_LAUNCHER_PID so it knows which
//                      named pipe to connect to
//    --retry-ms=N      time between retries while waiting for game's
//                      window to be created (default 250 ms, max 15 s)
//
//  Exit codes :
//    0  → injected successfully
//    1  → bad arguments
//    2  → OpenProcess failed (insufficient privileges / pid invalid)
//    3  → VirtualAllocEx / WriteProcessMemory failed
//    4  → CreateRemoteThread failed
//    5  → remote LoadLibraryW returned NULL (DLL load failed inside target)
//    6  → timeout waiting for game's primary window
//
//  Bootstrap-launcher resolution :
//    Many AAA games (LEGO Marvel, EA App titles, UE5 titles using a
//    pre-launcher) spawn a stub .exe that doesn't render any window
//    itself — it just forks the real game executable (often a
//    DX11/DX12 variant) as a child process and exits. If we only wait
//    for a window owned by the pid we were handed, we time out forever.
//
//    Fix : at each retry tick we walk the process tree starting at the
//    target pid (using TH32CS_SNAPPROCESS + th32ParentProcessID edges)
//    and consider EVERY descendant a valid injection target. As soon
//    as any descendant has a visible top-level window we use that pid
//    instead. The original pid may have already exited — that's fine,
//    the parent edge remains stale-but-readable in the snapshot until
//    the child also dies, which is plenty of time.
// =====================================================================
#include <windows.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <queue>
#include <unordered_set>

namespace {

struct Args {
    DWORD       target_pid    = 0;
    DWORD       launcher_pid  = 0;
    std::string dll_path;
    int         retry_ms      = 250;
    // 45 s — bumped from 15 s. LEGO games + EA App titles + UE5 stubs
    // sometimes pop their first window 20-30 s after launch (DRM check,
    // shader compile, splash screen on first run). 15 s caused false
    // timeouts on slow disks. The injector is fire-and-forget so a
    // longer wait costs nothing if the game is fast.
    int         max_wait_ms   = 45000;
};

bool parse_args(int argc, char** argv, Args& out) {
    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        if (strncmp(a, "--pid=", 6) == 0) {
            out.target_pid = static_cast<DWORD>(std::atoi(a + 6));
        } else if (strncmp(a, "--dll=", 6) == 0) {
            out.dll_path = a + 6;
        } else if (strncmp(a, "--launcher-pid=", 15) == 0) {
            out.launcher_pid = static_cast<DWORD>(std::atoi(a + 15));
        } else if (strncmp(a, "--retry-ms=", 11) == 0) {
            out.retry_ms = std::atoi(a + 11);
        } else if (strncmp(a, "--max-wait-ms=", 14) == 0) {
            out.max_wait_ms = std::atoi(a + 14);
        }
    }
    return out.target_pid != 0 && !out.dll_path.empty();
}

// True if `pid` owns a top-level visible window. We exclude windows
// that have an owner (popup dialogs of an actual main window) since
// those aren't the game's render target.
bool pid_has_main_window(DWORD pid) {
    struct Ctx { DWORD pid; bool found; } ctx{ pid, false };
    auto pump = [](HWND hwnd, LPARAM lp) -> BOOL {
        auto* c = reinterpret_cast<Ctx*>(lp);
        DWORD owner = 0;
        GetWindowThreadProcessId(hwnd, &owner);
        if (owner == c->pid && IsWindowVisible(hwnd) &&
            GetWindow(hwnd, GW_OWNER) == nullptr) {
            c->found = true;
            return FALSE;
        }
        return TRUE;
    };
    EnumWindows(pump, reinterpret_cast<LPARAM>(&ctx));
    return ctx.found;
}

// Collect every descendant pid of `root` via the parent edges in a
// snapshot. The root itself is included. Stale-parent edges (parent
// already dead) are common for orphaned children — we still follow
// them because that's exactly the case we need to handle for
// bootstrap launchers that exit after spawning the game.
std::vector<DWORD> collect_descendants(DWORD root) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return { root };
    std::vector<PROCESSENTRY32W> all;
    PROCESSENTRY32W pe{ sizeof(pe) };
    if (Process32FirstW(snap, &pe)) {
        do { all.push_back(pe); } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);

    std::vector<DWORD> out;
    std::unordered_set<DWORD> visited;
    std::queue<DWORD> q;
    q.push(root);
    while (!q.empty()) {
        DWORD pid = q.front(); q.pop();
        if (!visited.insert(pid).second) continue;
        out.push_back(pid);
        for (const auto& p : all) {
            if (p.th32ParentProcessID == pid) q.push(p.th32ProcessID);
        }
    }
    return out;
}

// Wait until SOME process in the target's descendant tree has a
// visible main window — and return that pid. This is the bootstrap-
// launcher resolution described in the file header : the pid we were
// handed (LEGOMarvel.exe stub, EA pre-launcher, etc.) often doesn't
// render anything itself but spawns the real game process as a child.
// We're done as soon as any node in the tree has a window we can
// subclass.
//
// Returns 0 on timeout.
DWORD wait_for_window_in_tree(DWORD root_pid, int max_wait_ms, int retry_ms) {
    int waited = 0;
    while (waited < max_wait_ms) {
        // Re-snapshot every tick — the tree can grow as new children
        // are spawned during launch (intro splash → main game).
        auto tree = collect_descendants(root_pid);
        for (DWORD pid : tree) {
            if (pid_has_main_window(pid)) {
                if (pid != root_pid) {
                    fprintf(stdout,
                        "[injector] resolved bootstrap pid %lu → game pid %lu\n",
                        root_pid, pid);
                }
                return pid;
            }
        }
        Sleep(retry_ms);
        waited += retry_ms;
    }
    return 0;
}

// Set an env var in the target process. We can't directly SET env in
// another process without injecting — but the DLL reads
// NEXUS_LAUNCHER_PID at startup which means we need it in the env
// BEFORE LoadLibraryW. Hack : we set it in OUR env, then the DLL
// inherits it from us via the remote thread's stack/heap copy of
// the env block.
//
// Wait, that's wrong. CreateRemoteThread doesn't copy our env. The
// proper approach is to inject a TINY second DLL that just calls
// SetEnvironmentVariable before LoadLibraryW. Too much complexity.
//
// Simpler : write the launcher pid into a registry key in HKCU
// that the DLL reads on startup. Or, even simpler : pass it via the
// pipe name itself (we already do — pipe path includes the pid).
// The DLL just reads it from the file %TEMP%\nexus-overlay-target-<game_pid>.txt
// which the injector writes before LoadLibraryW.
//
// We use that last approach since it's deterministic per-game.
bool drop_launcher_pid_hint(DWORD game_pid, DWORD launcher_pid) {
    wchar_t temp_dir[MAX_PATH];
    if (GetTempPathW(MAX_PATH, temp_dir) == 0) return false;
    wchar_t path[MAX_PATH];
    swprintf_s(path, L"%snexus-overlay-target-%lu.txt", temp_dir, game_pid);
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    char buf[32]; int n = sprintf_s(buf, "%lu", launcher_pid);
    DWORD written = 0;
    WriteFile(h, buf, n, &written, nullptr);
    CloseHandle(h);
    return true;
}

bool inject(const Args& a) {
    DWORD real_pid = wait_for_window_in_tree(a.target_pid, a.max_wait_ms, a.retry_ms);
    if (real_pid == 0) {
        fprintf(stderr,
            "[injector] timeout waiting for main window of pid %lu (or any descendant)\n",
            a.target_pid);
        return false;
    }
    // Drop the launcher-pid hint under the RESOLVED pid — the DLL is
    // loaded into that process and reads %TEMP%\nexus-overlay-target-<own_pid>.txt
    // to find which named pipe to connect to.
    drop_launcher_pid_hint(real_pid, a.launcher_pid);

    HANDLE proc = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE |
        PROCESS_VM_READ | PROCESS_QUERY_INFORMATION,
        FALSE, real_pid);
    if (!proc) {
        fprintf(stderr, "[injector] OpenProcess(%lu) failed : 0x%lx\n",
                real_pid, GetLastError());
        std::exit(2);
    }

    // Write the DLL path into the target.
    std::wstring wpath(a.dll_path.begin(), a.dll_path.end()); // ASCII safe
    SIZE_T bytes = (wpath.size() + 1) * sizeof(wchar_t);
    LPVOID remote_path = VirtualAllocEx(proc, nullptr, bytes,
                                        MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote_path) {
        fprintf(stderr, "[injector] VirtualAllocEx failed : 0x%lx\n", GetLastError());
        CloseHandle(proc);
        std::exit(3);
    }
    if (!WriteProcessMemory(proc, remote_path, wpath.c_str(), bytes, nullptr)) {
        fprintf(stderr, "[injector] WriteProcessMemory failed : 0x%lx\n", GetLastError());
        VirtualFreeEx(proc, remote_path, 0, MEM_RELEASE);
        CloseHandle(proc);
        std::exit(3);
    }

    // Resolve LoadLibraryW in the TARGET's kernel32 (same address as
    // ours since kernel32 is ASLR'd identically per session).
    LPTHREAD_START_ROUTINE load_library =
        reinterpret_cast<LPTHREAD_START_ROUTINE>(
            GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW"));
    if (!load_library) {
        fprintf(stderr, "[injector] GetProcAddress(LoadLibraryW) returned NULL\n");
        VirtualFreeEx(proc, remote_path, 0, MEM_RELEASE);
        CloseHandle(proc);
        std::exit(4);
    }

    HANDLE thread = CreateRemoteThread(proc, nullptr, 0, load_library,
                                       remote_path, 0, nullptr);
    if (!thread) {
        fprintf(stderr, "[injector] CreateRemoteThread failed : 0x%lx\n",
                GetLastError());
        VirtualFreeEx(proc, remote_path, 0, MEM_RELEASE);
        CloseHandle(proc);
        std::exit(4);
    }

    WaitForSingleObject(thread, 10000);
    DWORD exit_code = 0;
    GetExitCodeThread(thread, &exit_code);  // = HMODULE of the loaded DLL

    CloseHandle(thread);
    VirtualFreeEx(proc, remote_path, 0, MEM_RELEASE);
    CloseHandle(proc);

    if (exit_code == 0) {
        fprintf(stderr, "[injector] remote LoadLibraryW returned NULL — DLL load failed inside target\n");
        std::exit(5);
    }
    fprintf(stdout, "[injector] DLL injected at HMODULE 0x%p in pid %lu\n",
            reinterpret_cast<void*>(static_cast<uintptr_t>(exit_code)), real_pid);
    return true;
}

} // namespace

int main(int argc, char** argv) {
    Args a;
    if (!parse_args(argc, argv, a)) {
        fprintf(stderr,
            "nexus-overlay-injector — inject nexus-overlay.dll into a game process\n\n"
            "Usage : nexus-overlay-injector --pid=<game_pid> --dll=<path-to-dll>\n"
            "        [--launcher-pid=<electron_pid>] [--retry-ms=N] [--max-wait-ms=N]\n");
        return 1;
    }
    inject(a);
    return 0;
}
