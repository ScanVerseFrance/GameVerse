// =====================================================================
//  borderless.cpp — implémentation du force-borderless-windowed.
//
//  Adapté de Codeusa/Borderless-Gaming (MIT) :
//  https://github.com/Codeusa/Borderless-Gaming/blob/master/BorderlessGaming.Logic/Windows/Manipulation.cs
//
//  Différences avec l'original :
//    • C++ natif (pas C#) — direct Win32 calls
//    • Pas de UI / favorites — toujours appliqué quand le DLL est
//      injecté (l'opt-out se ferait via une env var côté Electron)
//    • Pas de gestion taskbar / mouse cursor (out of scope ici)
//    • Ajout SetFullscreenState(FALSE) côté DXGI (pas dans l'original
//      qui ne touche pas aux swap chains)
//    • Ajout Reset(Windowed=TRUE) côté D3D9 (idem)
// =====================================================================
#include "borderless.h"
#include "nlog.h"

#include <atomic>
#include <chrono>
#include <thread>
#include <dxgi.h>
#include <wrl/client.h>

namespace nexus::borderless {

namespace {

std::atomic<HWND>             g_hwnd{nullptr};
std::atomic<IDXGISwapChain*>  g_swap_chain{nullptr};
std::atomic<IDirect3DDevice9*> g_d3d9_device{nullptr};

// On track la dernière HWND traitée pour éviter de re-loguer à chaque
// re-apply (seulement quand la HWND change).
std::atomic<HWND> g_last_logged{nullptr};

// True une fois qu'on a réussi à apply au moins une fois — sert à
// raccourcir le polling après le 1er succès.
std::atomic<bool> g_applied_once{false};

// Set par le watcher quand il veut un D3D9 Reset(Windowed=TRUE).
// Consumé par hook_d3d9::present_detour qui appelle
// maybe_trigger_d3d9_windowed_reset au début du present (= sur le
// rendering thread, le seul endroit safe pour appeler Reset).
std::atomic<bool> g_d3d9_pending_windowed_reset{false};
// True après qu'on a confirmé que le device tourne en exclusive
// fullscreen — on évite de re-trigger si Windowed est déjà TRUE.
std::atomic<bool> g_d3d9_windowed_confirmed{false};

// Disable globalement si l'user a opt-out via env var
// NEXUS_DISABLE_BORDERLESS (lu une fois au init).
bool g_disabled = false;
bool g_disabled_checked = false;

bool is_disabled() {
    if (!g_disabled_checked) {
        char buf[8]{};
        DWORD len = GetEnvironmentVariableA("NEXUS_DISABLE_BORDERLESS", buf, sizeof(buf));
        g_disabled = (len > 0 && (buf[0] == '1' || buf[0] == 't' || buf[0] == 'T'));
        g_disabled_checked = true;
        if (g_disabled) {
            nexus::nlog::log("borderless: DISABLED via NEXUS_DISABLE_BORDERLESS env var");
        }
    }
    return g_disabled;
}

// True si la window a déjà un style "minimal" (déjà borderless). Permet
// d'éviter de re-apply inutilement (et de re-déclencher SetWindowPos
// qui peut blinker visuellement).
bool window_is_already_borderless(HWND hwnd) {
    LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    // Si aucun des "decoration bits" n'est set, on considère déjà borderless.
    const LONG_PTR decorations =
        WS_CAPTION | WS_THICKFRAME | WS_SYSMENU |
        WS_MAXIMIZEBOX | WS_MINIMIZEBOX;
    return (style & decorations) == 0;
}

// Apply le style borderless + resize fullscreen. Strict portage de
// MakeWindowBorderless de Borderless Gaming, avec ajout du SetFullscreenState
// côté DXGI si on a la swap chain capturée.
bool apply_borderless(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return false;

    LONG_PTR style    = GetWindowLongPtrW(hwnd, GWL_STYLE);
    LONG_PTR ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

    // Log la 1ère fois qu'on voit la HWND — utile pour debug même si
    // la window est déjà borderless (le vrai problème peut être côté
    // swap chain D3D9/DXGI en exclusive mode).
    HWND last = g_last_logged.exchange(hwnd);
    if (last != hwnd) {
        nexus::nlog::log("borderless: target hwnd=%p style=0x%llx ex=0x%llx already_borderless=%d",
            (void*)hwnd,
            (unsigned long long)style, (unsigned long long)ex_style,
            (int)window_is_already_borderless(hwnd));
    }

    // Strip decorations — exactement les bits que Borderless Gaming
    // remove (Manipulation.cs:MakeWindowBorderless).
    if (!window_is_already_borderless(hwnd)) {
        LONG_PTR new_style = style & ~(
            WS_CAPTION | WS_THICKFRAME | WS_SYSMENU |
            WS_MAXIMIZEBOX | WS_MINIMIZEBOX
        );
        LONG_PTR new_ex_style = ex_style & ~(
            WS_EX_DLGMODALFRAME | WS_EX_COMPOSITED | WS_EX_WINDOWEDGE |
            WS_EX_CLIENTEDGE | WS_EX_LAYERED | WS_EX_STATICEDGE |
            WS_EX_TOOLWINDOW | WS_EX_APPWINDOW
        );

        SetWindowLongPtrW(hwnd, GWL_STYLE,   new_style);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex_style);

        // Resize to primary monitor full size — same as Borderless
        // Gaming FullScreen mode. SWP_FRAMECHANGED CRUCIAL — sans, le
        // style change n'est pas visuellement appliqué tant que la
        // window n'est pas redessinée.
        int screen_w = GetSystemMetrics(SM_CXSCREEN);
        int screen_h = GetSystemMetrics(SM_CYSCREEN);
        SetWindowPos(
            hwnd, HWND_TOP,
            0, 0, screen_w, screen_h,
            SWP_SHOWWINDOW | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING |
            SWP_FRAMECHANGED
        );

        nexus::nlog::log("borderless: applied style strip to hwnd=%p new_style=0x%llx new_ex=0x%llx %dx%d",
            (void*)hwnd,
            (unsigned long long)new_style, (unsigned long long)new_ex_style,
            screen_w, screen_h);
    }

    // Switch le swap chain DXGI en présentation windowed si on l'a.
    // TOUJOURS check même si le style est déjà borderless — le vrai
    // problème pour alt-tab est ici, pas dans le style.
    IDXGISwapChain* sc = g_swap_chain.load();
    if (sc) {
        BOOL is_fs = FALSE;
        HRESULT hr = sc->GetFullscreenState(&is_fs, nullptr);
        if (SUCCEEDED(hr) && is_fs) {
            HRESULT hr2 = sc->SetFullscreenState(FALSE, nullptr);
            nexus::nlog::log("borderless: DXGI SetFullscreenState(FALSE) hr=0x%08lx",
                (unsigned long)hr2);
        }
    }

    // [REMOVED] D3D9 device Reset(Windowed=TRUE) — trop risqué.
    // Forcer un Reset cassait les resources D3DPOOL_DEFAULT du jeu
    // (LEGO Marvel crash). Le pause-on-focus-loss est maintenant
    // géré via le WM_ACTIVATE/WM_KILLFOCUS swallow dans la WndProc
    // subclass (hook_d3d9.cpp + hook_dxgi.cpp::overlay_wndproc).
    // Le jeu pense toujours avoir le focus → ne pause jamais sur
    // alt-tab, et on a pas besoin de toucher au swap chain.

    g_applied_once.store(true);
    return true;
}

} // namespace

void set_target_hwnd(HWND hwnd) {
    g_hwnd.store(hwnd);
}

void set_target_swap_chain(IDXGISwapChain* sc) {
    g_swap_chain.store(sc);
}

void set_target_d3d9_device(IDirect3DDevice9* dev) {
    g_d3d9_device.store(dev);
}

// [STUB] Garde l'API pour compat avec reset_detour mais ne fait
// plus rien — le force-windowed-via-Reset est trop dangereux pour D3D9
// (cassait les resources DEFAULT pool du jeu, crash silencieux).
// Le pause-on-focus-loss est maintenant géré au niveau WndProc via
// swallow des WM_ACTIVATE/WM_KILLFOCUS, ce qui marche pour tous les
// jeux sans toucher au device graphique.
void maybe_force_d3d9_windowed(D3DPRESENT_PARAMETERS* /*params*/) {
    // no-op
}

bool maybe_trigger_d3d9_windowed_reset(IDirect3DDevice9* /*device*/) {
    // no-op — voir commentaire maybe_force_d3d9_windowed
    return false;
}

void run_watcher(const std::atomic<bool>& shutdown) {
    if (is_disabled()) {
        nexus::nlog::log("borderless: watcher exiting (disabled)");
        return;
    }
    nexus::nlog::log("borderless: watcher thread starting");

    using namespace std::chrono;
    auto started = steady_clock::now();

    // Phase 1 : poll rapide jusqu'à ce qu'une HWND soit set ET qu'on
    // arrive à apply au moins une fois. Max 60s d'attente (le jeu a
    // largement le temps de créer sa window pendant ça, intro + shader
    // compile + DRM compris).
    while (!shutdown.load()) {
        HWND h = g_hwnd.load();
        if (h && apply_borderless(h)) break;
        if (duration_cast<seconds>(steady_clock::now() - started).count() > 60) {
            nexus::nlog::log("borderless: gave up waiting for hwnd after 60s");
            return;
        }
        std::this_thread::sleep_for(milliseconds(250));
    }

    // Phase 2 : re-apply toutes les 2s pendant 30s. Le jeu peut
    // re-fullscreen pendant l'intro / chargement (UE5 fait souvent ça
    // au shader precompile).
    auto phase2_end = steady_clock::now() + seconds(30);
    while (!shutdown.load() && steady_clock::now() < phase2_end) {
        HWND h = g_hwnd.load();
        if (h) apply_borderless(h);
        std::this_thread::sleep_for(seconds(2));
    }

    // Phase 3 : maintenance — re-apply toutes les 10s indéfiniment.
    // Catch les re-fullscreens manuels (alt-enter, options graphiques
    // changées en cours de jeu, etc.). 10s = compromis entre latence
    // de récupération et CPU (negligeable de toute façon, c'est juste
    // un Get/SetWindowLong).
    while (!shutdown.load()) {
        HWND h = g_hwnd.load();
        if (h) apply_borderless(h);
        std::this_thread::sleep_for(seconds(10));
    }

    nexus::nlog::log("borderless: watcher thread exiting");
}

} // namespace nexus::borderless
