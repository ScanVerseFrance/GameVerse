#include "nlog.h"
#include <windows.h>
#include <cstdio>
#include <cstdarg>
#include <mutex>
#include <unordered_map>
#include <string>

namespace nexus::nlog {

namespace {
std::mutex g_mutex;
FILE* g_file = nullptr;
bool g_init_tried = false;
std::unordered_map<std::string, int> g_counters;

void ensure_open() {
    if (g_init_tried) return;
    g_init_tried = true;
    wchar_t temp_dir[MAX_PATH];
    if (GetTempPathW(MAX_PATH, temp_dir) == 0) return;
    wchar_t path[MAX_PATH];
    swprintf_s(path, L"%snexus-overlay-dll-%lu.log", temp_dir, GetCurrentProcessId());
    // Append mode si dllmain a déjà créé le fichier
    _wfopen_s(&g_file, path, L"a");
}

void write_prefix() {
    SYSTEMTIME st; GetLocalTime(&st);
    fprintf(g_file, "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
}
}

void log(const char* fmt, ...) {
    std::lock_guard<std::mutex> lk(g_mutex);
    ensure_open();
    if (!g_file) return;
    write_prefix();
    va_list args; va_start(args, fmt);
    vfprintf(g_file, fmt, args);
    va_end(args);
    fputc('\n', g_file);
    fflush(g_file);
}

void log_once(const char* tag, int max_calls, const char* fmt, ...) {
    std::lock_guard<std::mutex> lk(g_mutex);
    int& cnt = g_counters[tag];
    if (cnt >= max_calls) return;
    cnt++;
    ensure_open();
    if (!g_file) return;
    write_prefix();
    fprintf(g_file, "[%s #%d] ", tag, cnt);
    va_list args; va_start(args, fmt);
    vfprintf(g_file, fmt, args);
    va_end(args);
    fputc('\n', g_file);
    fflush(g_file);
}

}
