// =====================================================================
//  borderless.h — auto force-windowed-borderless pour le jeu host.
//
//  Pourquoi : beaucoup de jeux en exclusive fullscreen se mettent en
//  pause quand on perd le focus (alt-tab). Ça bloque le scénario
//  Remote Play Together où l'overlay/guest window vole le focus pour
//  recevoir les inputs. Solution = forcer le jeu en borderless windowed
//  AUTOMATIQUEMENT à l'injection, comme le fait Borderless Gaming
//  (Codeusa/Borderless-Gaming, MIT).
//
//  Avantages vs réel windowed via les options du jeu :
//    • Marche pour TOUS les jeux (même les vieux sans option windowed)
//    • Aucune action user requise — c'est appliqué dès l'injection
//    • Garde l'apparence fullscreen (window couvre tout l'écran sans
//      titre ni bordure) — l'user voit pas la différence
//    • Plus de pause-on-focus-loss, alt-tab seamless
//
//  Inconvénients connus :
//    • Certains jeux re-fullscreen activement à l'init (intro vidéo,
//      changement résolution) → on re-applique périodiquement
//    • Jeux qui poussent le mode exclusive DXGI peuvent avoir des
//      glitches visuels brefs au switch — invisible pour l'user
//      dans 99% des cas
//
//  Stratégie :
//    1. Watcher thread démarre au worker_thread init.
//    2. Poll g_target_hwnd toutes les 250ms jusqu'à ce qu'une HWND
//       soit set (par hook_dxgi.cpp ou hook_d3d9.cpp via
//       borderless::set_target_hwnd() au moment du subclass WndProc).
//    3. Apply borderless (style flags + SetWindowPos fullscreen size).
//    4. Re-apply toutes les 2s pendant les premiers 30s (le jeu peut
//       re-fullscreen lors de l'intro / shader compile).
//    5. Ensuite re-apply toutes les 10s indéfiniment (le jeu peut
//       décider de re-fullscreen plus tard, alt-tab in/out…).
//
//  Lien avec les hooks graphiques :
//    • hook_dxgi.cpp doit appeler `set_target_swap_chain(IDXGISwapChain*)`
//      pour qu'on puisse call SetFullscreenState(FALSE). Sinon la
//      window est borderless mais le swap chain reste exclusive →
//      conflits visuels.
//    • hook_d3d9.cpp force Windowed=TRUE dans le Reset detour
//      (intercept du params avant de call l'original). C'est lui qui
//      gère D3D9 windowed switching, on a juste à le déclencher.
// =====================================================================
#pragma once

#include <windows.h>
#include <atomic>
#include <d3d9.h>

// Forward decl plutôt que include lourd
struct IDXGISwapChain;

namespace nexus::borderless {

// Set par les hooks au moment du subclass WndProc. Le watcher thread
// poll cette atomic pour savoir quand commencer à appliquer.
void set_target_hwnd(HWND hwnd);

// Set par hook_dxgi.cpp dans le 1er present. On l'utilise pour appeler
// SetFullscreenState(FALSE) — bascule le swap chain en présentation
// windowed même si le jeu l'avait créé en exclusive.
void set_target_swap_chain(IDXGISwapChain* sc);

// Set par hook_d3d9.cpp dans le 1er present. On l'utilise pour
// déclencher un Reset() avec Windowed=TRUE.
void set_target_d3d9_device(IDirect3DDevice9* dev);

// Helper appelé par hook_d3d9.cpp::reset_detour AVANT de forward au
// device original. Mutate params->Windowed à TRUE si le force-borderless
// est activé.
void maybe_force_d3d9_windowed(D3DPRESENT_PARAMETERS* params);

// Helper appelé par hook_d3d9.cpp::present_detour à CHAQUE Present.
// Si un Reset(Windowed=TRUE) a été requis par le watcher, on l'exécute
// ici (sur le rendering thread = obligatoire pour Reset). Retourne
// true si on a effectivement fait un reset (le caller peut skip la
// frame courante pour éviter d'utiliser un device dans un état
// transitoire).
bool maybe_trigger_d3d9_windowed_reset(IDirect3DDevice9* device);

// Worker loop — lancé dans son propre thread depuis dllmain.cpp.
// Termine quand shutdown.load() == true.
void run_watcher(const std::atomic<bool>& shutdown);

} // namespace nexus::borderless
