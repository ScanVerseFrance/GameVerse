/**
 * Panel "Remote Play Together" de l'overlay — UI d'invitation à un
 * ami pour jouer en local co-op via streaming.
 *
 * Phase A (cette itération) : UI invite + signaling via cloud WS.
 *   - Liste des amis "in_game" (eux DOIVENT être en jeu pour recevoir)
 *   - Bouton "Inviter" → envoie un envelope `remote_play:invite` au
 *     friend via cloud WS
 *   - L'ami reçoit une toast "X t'invite à jouer à Lego Marvel"
 *   - Accept/Decline propagés via cloud WS
 *
 * Phase B (next session, voir tasks #65) : WebRTC peer-to-peer +
 * capture écran + injection ViGEm pour la manette du joueur 2.
 *
 * Pour l'instant le bouton "Inviter" envoie le signal et l'UI montre
 * "Invitation envoyée, en attente". L'étape suivante (streaming)
 * arrivera dans une session dédiée.
 */
import { useEffect, useState } from 'react'
import { Play, Send, Loader2, AlertTriangle, Ban, Sparkles } from '@/lib/icons'
import type { LibraryGame } from '@/types/library.types'
import { useCloudStore } from '@/stores/cloud.store'
import { useAuthStore } from '@/stores/auth.store'
import { PanelShell } from './OverlayFriendsPanel'

interface InviteState {
  friendId: string
  status: 'sending' | 'sent' | 'accepted' | 'declined' | 'error'
  error?: string
}

// Sentinel id pour la rangée "Test solo" — distinct des vrais friendIds
// pour qu'on puisse stocker son état d'invite indépendamment dans la
// map `invites`. Le loopback IPC accepte n'importe quel `fromUserId`
// donc on utilise l'id de l'user lui-même côté backend.
const SELF_LOOPBACK_KEY = '__self_loopback__'

export function OverlayRemotePlayPanel({ game }: { game: LibraryGame | null }) {
  const me = useAuthStore((s) => s.user)
  const cloudStatus = useCloudStore((s) => s.status)
  const friends = useCloudStore((s) => s.friends)
  const presences = useCloudStore((s) => s.presences)
  const [invites, setInvites] = useState<Record<string, InviteState>>({})
  // v0.5.1 fix — Remote Play Together n'est dispo QUE pour les jeux
  // dont la category Steam 44 est positive. On query le flag depuis
  // game_artwork / steam_catalogue (résolu via Steam appdetails).
  const [compat, setCompat] = useState<{
    checking: boolean
    compatible: boolean
    resolved: boolean
  }>({ checking: false, compatible: false, resolved: false })
  useEffect(() => {
    if (!game?.steamAppId || game.steamAppId <= 0) {
      setCompat({ checking: false, compatible: false, resolved: true })
      return
    }
    setCompat({ checking: true, compatible: false, resolved: false })
    void window.nexus.overlay
      .isRemotePlayCompatible(game.steamAppId)
      .then((res) => {
        setCompat({
          checking: false,
          compatible: !!res.compatible,
          resolved: !!res.resolved,
        })
      })
      .catch(() => {
        // IPC rejette = handler down (rare en prod, possible pendant
        // HMR dev). On bascule en "ne supporte pas" gracieusement
        // plutôt que de laisser le panel coincé sur le spinner.
        setCompat({ checking: false, compatible: false, resolved: true })
      })
  }, [game?.steamAppId])

  // Subscribe aux réponses d'invitation (accept/decline) qui arrivent
  // via cloud WS envelope remote_play:response.
  useEffect(() => {
    const unsub = window.nexus.cloud.onEvent((env) => {
      const e = env as { type: string; data?: { fromUserId?: string; accepted?: boolean } }
      if (e.type !== 'remote_play:response') return
      const fid = e.data?.fromUserId
      if (!fid) return
      const accepted = !!e.data?.accepted
      setInvites((prev) => ({
        ...prev,
        [fid]: {
          friendId: fid,
          status: accepted ? 'accepted' : 'declined',
        },
      }))
      // Phase B — quand l'invitation est acceptée, on est le HOST.
      // On spawn la window invisible qui capture le jeu et envoie
      // l'offer WebRTC au guest. Le guest a déjà sa window ouverte
      // (déclenchée chez lui par App.tsx au moment où il clique
      // accepter), donc il attend l'offer.
      if (accepted && game && fid !== '__self_loopback__') {
        void window.nexus.remotePlay.openHost(fid, {
          gameId: game.id,
          gameTitle: game.title,
          steamAppId: game.steamAppId ?? null,
          coverUrl: game.coverUrl ?? null,
        })
      }
    })
    return unsub
  }, [game])

  async function sendInvite(friendId: string): Promise<void> {
    if (!me || !game) return
    // Court-circuit pour la rangée "Test solo" — au lieu de POST
    // /v1/remote-play/invite (qui ne fonctionnera pas, on s'auto-invite),
    // on déclenche le loopback IPC qui broadcast les MÊMES envelopes
    // localement. La state machine UI passe par sending → sent → accepted
    // (ou declined) exactement comme avec un vrai ami.
    if (friendId === SELF_LOOPBACK_KEY) {
      await runSelfLoopback(true)
      return
    }
    setInvites((prev) => ({
      ...prev,
      [friendId]: { friendId, status: 'sending' },
    }))
    try {
      const res = await window.nexus.cloud.remotePlayInvite?.({
        toUserId: friendId,
        gameTitle: game.title,
        gameId: game.id,
        steamAppId: game.steamAppId ?? null,
        coverUrl: game.coverUrl ?? null,
      })
      if (res?.ok) {
        setInvites((prev) => ({
          ...prev,
          [friendId]: { friendId, status: 'sent' },
        }))
      } else {
        setInvites((prev) => ({
          ...prev,
          [friendId]: {
            friendId,
            status: 'error',
            error: res?.error ?? 'Échec de l\'envoi',
          },
        }))
      }
    } catch (err) {
      setInvites((prev) => ({
        ...prev,
        [friendId]: {
          friendId,
          status: 'error',
          error: (err as Error).message,
        },
      }))
    }
  }

  // Test solo — déclenche la chaîne invite/response localement (pas de
  // call réseau). Sert à valider la state machine UI sans avoir besoin
  // d'un second compte ni d'un ami in_game.
  //   accept=true  → après 1.5s, on reçoit `remote_play:response` avec
  //                  accepted=true → bouton passe à "Accepté ✓"
  //   accept=false → idem mais "Refusé"
  // Solo Phase B test — ouvre LES DEUX windows (host hidden + guest
  // small windowed) sur la même machine. La signalisation WebRTC
  // bypass le cloud et route en local (cf cloud:remotePlaySignal IPC
  // handler qui détecte les peerId sentinels `__self_test_*`).
  //
  // Permet de tester capture + WebRTC + display + gamepad solo sans
  // 2 comptes. Le host capture le 1er window dispo si le jeu n'est
  // pas lancé (fallback dans pickBestSource).
  async function runSoloPhaseBTest(): Promise<void> {
    if (!game) return
    const meta = {
      gameId: game.id,
      gameTitle: game.title,
      steamAppId: game.steamAppId ?? null,
      coverUrl: game.coverUrl ?? null,
    }
    // Ouvre guest D'ABORD pour qu'il puisse subscriber au signaling
    // local AVANT que host ne commence à beacon. Le host attend de
    // toute façon le 'guest-ready' avant de send l'offer, mais
    // ouvrir guest en premier réduit la latence.
    await window.nexus.remotePlay.openGuest('__self_test_host__', meta)
    // Petit delay pour laisser la window guest mount + subscribe
    setTimeout(() => {
      void window.nexus.remotePlay.openHost('__self_test_guest__', meta)
    }, 800)
  }

  async function runSelfLoopback(accept: boolean): Promise<void> {
    if (!me || !game) return
    const meName = me.displayName ?? me.username ?? 'Moi'
    setInvites((prev) => ({
      ...prev,
      [SELF_LOOPBACK_KEY]: {
        friendId: SELF_LOOPBACK_KEY,
        status: 'sending',
      },
    }))
    try {
      const res = await window.nexus.cloud.remotePlaySimulateLoopback?.({
        // fromUserId est le sender simulé. On utilise SELF_LOOPBACK_KEY
        // (pas meId) pour que l'envelope `remote_play:response` qu'on
        // recevra du backend re-match notre clé dans `invites`. Le
        // subscribe `onEvent` plus haut indexe par data.fromUserId.
        fromUserId: SELF_LOOPBACK_KEY,
        fromName: `${meName} (test solo)`,
        gameTitle: game.title,
        gameId: game.id,
        steamAppId: game.steamAppId ?? null,
        coverUrl: game.coverUrl ?? null,
        accept,
        delayMs: 1500,
      })
      if (res?.ok) {
        setInvites((prev) => ({
          ...prev,
          [SELF_LOOPBACK_KEY]: {
            friendId: SELF_LOOPBACK_KEY,
            status: 'sent',
          },
        }))
      } else {
        setInvites((prev) => ({
          ...prev,
          [SELF_LOOPBACK_KEY]: {
            friendId: SELF_LOOPBACK_KEY,
            status: 'error',
            error: res?.error ?? 'Loopback indisponible',
          },
        }))
      }
    } catch (err) {
      setInvites((prev) => ({
        ...prev,
        [SELF_LOOPBACK_KEY]: {
          friendId: SELF_LOOPBACK_KEY,
          status: 'error',
          error: (err as Error).message,
        },
      }))
    }
  }

  if (!game) {
    return (
      <PanelShell title="Remote Play Together" icon={<Play className="w-5 h-5" />}>
        <div className="flex-1 flex items-center justify-center text-fg-muted text-sm py-12">
          Lance un jeu pour pouvoir inviter un ami à jouer en co-op.
        </div>
      </PanelShell>
    )
  }

  if (cloudStatus !== 'connected') {
    return (
      <PanelShell title="Remote Play Together" icon={<Play className="w-5 h-5" />}>
        <div className="flex-1 flex items-center justify-center text-fg-muted text-sm py-12">
          Connecte-toi à Nexus Cloud pour inviter un ami.
        </div>
      </PanelShell>
    )
  }

  // Gate compat Steam category 44 — Remote Play Together n'est pas
  // supporté par tous les jeux. Steam expose une category dédiée que
  // chaque dev coche s'il a configuré le streaming co-op via leur SDK.
  // Si le jeu n'a pas ce flag, on ne montre PAS le bouton "Inviter".
  if (compat.checking) {
    return (
      <PanelShell title="Remote Play Together" icon={<Play className="w-5 h-5" />}>
        <div className="flex-1 flex items-center justify-center text-fg-muted text-sm py-12 gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Vérification de la compatibilité…
        </div>
      </PanelShell>
    )
  }
  if (!compat.compatible) {
    return (
      <PanelShell title="Remote Play Together" icon={<Play className="w-5 h-5" />}>
        <div className="flex-1 flex flex-col items-center justify-center text-fg-muted text-sm py-12 gap-3 px-8 text-center">
          <Ban className="w-10 h-10 text-fg-faint" />
          <div>
            <p className="text-fg-secondary font-semibold mb-1">
              {game.title} ne supporte pas Remote Play Together
            </p>
            <p className="text-xs text-fg-muted leading-relaxed">
              Seuls les jeux Steam avec la catégorie « Remote Play Together »
              (configurée par le développeur) peuvent être joués en
              streaming co-op. Pour la liste officielle, va sur la page
              Steam des « Jeux compatibles Remote Play Together ».
            </p>
            {!compat.resolved && (
              <p className="text-[10px] text-fg-muted/70 mt-3 italic">
                Métadonnées Steam pas encore résolues pour ce jeu.
                Réessaie dans quelques secondes (le fetch tourne en arrière-plan).
              </p>
            )}
          </div>
        </div>
      </PanelShell>
    )
  }

  // On affiche TOUS les amis — l'user invite qui il veut, l'ami reçoit
  // une toast quoi qu'il fasse. Steam fait pareil (la liste n'est pas
  // limitée aux amis "in-game").

  return (
    <PanelShell title="Remote Play Together" icon={<Play className="w-5 h-5" />}>
      {/* Banner d'avertissement Phase B */}
      <div className="px-5 py-3 border-b border-amber-400/30 bg-amber-400/5">
        <p className="text-[11px] text-amber-200/90 leading-snug flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Phase 1 : envoi d'invitations + reconnaissance joueur 2.
            Le streaming vidéo + routage manette virtuelle (ViGEm)
            arrive dans une mise à jour suivante.
          </span>
        </p>
      </div>

      <div className="px-5 py-3 border-b border-white/5">
        <p className="text-xs text-fg-secondary">
          Inviter un ami à jouer à{' '}
          <span className="font-semibold text-accent-primary">{game.title}</span>
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {/* Rangée "Test solo" — loopback local pour valider la chaîne
            UI sans 2e compte. Toujours visible quand l'user est loggé. */}
        {me && (
          <div className="mb-2 px-3 py-2 rounded-md border border-accent-secondary/30 bg-accent-secondary/5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-accent-secondary/20 border border-accent-secondary/40 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4 text-accent-secondary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-fg-primary truncate">
                  Test solo (loopback)
                </p>
                <p className="text-[10px] text-fg-muted truncate">
                  Simule un invite + accept local, sans 2e compte.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <InviteButton
                  state={invites[SELF_LOOPBACK_KEY]}
                  onSend={() => void runSelfLoopback(true)}
                />
                {/* Bouton "Refuser" pour tester le path decline aussi */}
                {!invites[SELF_LOOPBACK_KEY] && (
                  <button
                    type="button"
                    onClick={() => void runSelfLoopback(false)}
                    title="Simuler un refus"
                    className="h-8 px-2 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-fg-muted text-[10px] font-semibold inline-flex items-center"
                  >
                    Refus
                  </button>
                )}
              </div>
            </div>
            {/* Phase B — spawn les 2 windows en local pour tester le
                streaming WebRTC + capture + gamepad sans 2 comptes. */}
            <div className="mt-2 pt-2 border-t border-accent-secondary/20 flex items-center justify-between gap-2">
              <p className="text-[10px] text-fg-muted leading-tight">
                Phase B (P2P stream + manette virtuelle) — ouvre 2 windows en
                local, le guest sera une petite fenêtre en haut à gauche.
              </p>
              <button
                type="button"
                onClick={() => void runSoloPhaseBTest()}
                className="h-8 px-3 rounded-md bg-accent-secondary/30 hover:bg-accent-secondary/50 border border-accent-secondary/60 text-accent-secondary text-xs font-semibold inline-flex items-center gap-1.5 shrink-0"
              >
                Test stream solo
              </button>
            </div>
          </div>
        )}
        {friends.length === 0 ? (
          <p className="text-sm text-fg-muted text-center py-8">
            Aucun ami à inviter.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {friends.map((f) => {
              const inv = invites[f.id]
              const presence = presences[f.id]
              const inGame =
                presence?.status === 'in_game' && presence.richPresence?.gameTitle
              return (
                <li
                  key={f.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 transition-colors"
                >
                  <div className="w-9 h-9 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
                    {f.avatarPath ? (
                      <img
                        src={f.avatarPath}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-xs font-bold text-white">
                        {(f.displayName ?? f.username).slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-fg-primary truncate">
                      {f.displayName ?? f.username}
                    </p>
                    {inGame && (
                      <p className="text-[10px] text-accent-secondary truncate">
                        Joue à {presence.richPresence?.gameTitle}
                      </p>
                    )}
                  </div>
                  <InviteButton
                    state={inv}
                    onSend={() => void sendInvite(f.id)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </PanelShell>
  )
}

function InviteButton({
  state,
  onSend,
}: {
  state: InviteState | undefined
  onSend: () => void
}) {
  if (!state) {
    return (
      <button
        type="button"
        onClick={onSend}
        className="h-8 px-3 rounded-md bg-accent-primary/20 hover:bg-accent-primary/30 border border-accent-primary/50 text-accent-primary text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
      >
        <Send className="w-3 h-3" />
        Inviter
      </button>
    )
  }
  if (state.status === 'sending') {
    return (
      <span className="h-8 px-3 inline-flex items-center gap-1.5 text-xs text-fg-muted">
        <Loader2 className="w-3 h-3 animate-spin" />
        Envoi…
      </span>
    )
  }
  if (state.status === 'sent') {
    return (
      <span className="h-8 px-3 inline-flex items-center gap-1.5 text-xs text-amber-200">
        En attente
      </span>
    )
  }
  if (state.status === 'accepted') {
    return (
      <span className="h-8 px-3 inline-flex items-center gap-1.5 text-xs text-emerald-300 font-semibold">
        Accepté ✓
      </span>
    )
  }
  if (state.status === 'declined') {
    return (
      <span className="h-8 px-3 inline-flex items-center gap-1.5 text-xs text-fg-muted">
        Refusé
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onSend}
      className="h-8 px-3 rounded-md bg-error/20 hover:bg-error/30 border border-error/50 text-error text-xs font-semibold inline-flex items-center gap-1.5"
      title={state.error ?? 'Erreur'}
    >
      Réessayer
    </button>
  )
}
