import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { useAuthStore } from './stores/auth.store'
import { useThemeStore } from './stores/theme.store'
import { useAddonStore } from './stores/addon.store'
import { useDownloadStore } from './stores/download.store'
import { useLibraryStore } from './stores/library.store'
import { useSocialStore } from './stores/social.store'
import { useSettingsStore } from './stores/settings.store'
import { useNotificationsStore } from './stores/notifications.store'
import { useCloudStore } from './stores/cloud.store'
import { useApplyTheme } from './hooks/useApplyTheme'
import { useThemePreset } from './hooks/useThemePreset'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { UpdatePopup } from './components/common/UpdatePopup'
import { CommandPalette } from './components/common/CommandPalette'
import { ChangelogDialog } from './components/common/ChangelogDialog'
import { KeyboardShortcutsDialog } from './components/common/KeyboardShortcutsDialog'

export default function App() {
  const restore = useAuthStore((s) => s.restoreSession)
  const user = useAuthStore((s) => s.user)
  const loadCustom = useThemeStore((s) => s.loadCustom)
  const loadAddons = useAddonStore((s) => s.load)
  const loadDownloads = useDownloadStore((s) => s.load)
  const loadDownloadSettings = useDownloadStore((s) => s.loadSettings)
  const loadLibrary = useLibraryStore((s) => s.load)
  const loadFriends = useSocialStore((s) => s.loadFriends)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const blurStrengthPx = useSettingsStore((s) => s.blurStrengthPx)

  // Theme preset is applied BEFORE useApplyTheme so the per-user
  // custom theme layers on top of the preset's CSS variables. Without
  // this order the per-user accent could be overwritten by the preset
  // re-applying on remount.
  useThemePreset()
  useApplyTheme()
  // Raccourcis clavier globaux : Ctrl+H, Ctrl+L, Ctrl+D, Ctrl+,, etc.
  useGlobalShortcuts()

  useEffect(() => {
    void restore()
    void loadCustom()
    void loadAddons()
    void loadDownloadSettings()
    // Offline-first cloud bootstrap. Runs in parallel with the local
    // restore — if the cloud is reachable AND we have a saved token,
    // friends/presence/threads warm up by the time the user navigates
    // to /community. If the network is down or no token is saved, we
    // land in 'offline' / 'disconnected' and the local library remains
    // fully usable.
    void useCloudStore.getState().bootConnect()
  }, [restore, loadCustom, loadAddons, loadDownloadSettings])

  useEffect(() => {
    if (user) {
      void loadDownloads(user.id)
      void loadLibrary(user.id)
      void loadFriends(user.id)
    }
  }, [user, loadDownloads, loadLibrary, loadFriends])

  useEffect(() => {
    document.body.classList.toggle('no-animations', !animationsEnabled)
  }, [animationsEnabled])

  useEffect(() => {
    document.documentElement.style.setProperty('--blur-strength', `${blurStrengthPx}px`)
  }, [blurStrengthPx])

  useEffect(() => {
    const downloadStore = useDownloadStore.getState()
    const notifStore = useNotificationsStore.getState()
    const unsubProgress = window.nexus.downloads.onProgress((data) => downloadStore.applyProgress(data))
    const unsubState = window.nexus.downloads.onState((data) => {
      downloadStore.applyState(data)
      // Surface state transitions as in-app notifications. We push only
      // on terminal transitions (completed / error) — paused/resumed are
      // user-driven and don't deserve a bell ping.
      if (data.status === 'completed') {
        const row = downloadStore.downloads.find((d) => d.id === data.id)
        notifStore.push({
          kind: 'download_completed',
          title: 'Téléchargement terminé',
          body: row?.gameTitle ?? null,
          link: '/downloads',
          thumbnailUrl: row?.coverUrl ?? null,
        })
      } else if (data.status === 'error') {
        const row = downloadStore.downloads.find((d) => d.id === data.id)
        notifStore.push({
          kind: 'download_error',
          title: 'Échec du téléchargement',
          body: row?.gameTitle ?? data.error ?? null,
          link: '/downloads',
          thumbnailUrl: row?.coverUrl ?? null,
        })
      }
    })
    const unsubAdded = window.nexus.downloads.onAdded((data) => downloadStore.applyAdded(data))
    const unsubRemoved = window.nexus.downloads.onRemoved((data) => downloadStore.applyRemoved(data.id))

    const libraryStore = useLibraryStore.getState()
    const unsubRunning = window.nexus.library.onRunning((data) => libraryStore.applyRunning(data))
    // When a torrent / http finishes, main process auto-creates a library row
    // and pushes it here so the user sees the new game in /library without
    // having to reload the app.
    const unsubLibAdded = window.nexus.library.onAddedFromDownload((game) => {
      libraryStore.applyAddedFromDownload(game)
      notifStore.push({
        kind: 'library_added',
        title: 'Nouveau jeu dans la bibliothèque',
        body: game.title,
        link: '/library',
        thumbnailUrl: game.coverUrl,
      })
    })

    // Achievement unlocks already trigger native toasts via Electron's
    // Notification API; we also mirror them into the in-app bell so the
    // user has a persistent history.
    const unsubAch = window.nexus.achievements.onUnlocked((data) => {
      notifStore.push({
        kind: 'achievement_unlocked',
        title: 'Succès débloqué',
        body: data.apiName,
        link: null,
        thumbnailUrl: null,
      })
    })

    // Live presence patching — when ANY user's presence changes (the
    // current user's own focus/blur OR a friend going in_game) the
    // main process broadcasts here. The social store applies it in-
    // place so PresenceDot, NavAvatar, and the friend list re-render
    // without a refetch.
    const socialStore = useSocialStore.getState()
    const unsubPres = window.nexus.social.onPresenceChanged((data) => {
      socialStore.applyPresence(data.userId, data.status, data.lastActiveAt)
    })

    // Cloud lifecycle. Status updates flip the badge + warm/wipe
    // caches; envelope events feed the live message / friend /
    // activity stores via applyEvent's dispatcher.
    const cloudStore = useCloudStore.getState()
    const unsubCloudStatus = window.nexus.cloud.onStatusChange((data) => {
      cloudStore.applyStatus({
        status: data.status,
        user: data.user,
        reason: data.reason,
      })
    })
    const unsubCloudEvent = window.nexus.cloud.onEvent((env) => {
      cloudStore.applyEvent(env)
      // Mirror cloud envelope events into the notification bell so
      // friend reqs, accepts, incoming chat, and review likes show up
      // in the same dropdown the user already pulls down for downloads
      // and achievements. We deliberately do NOT push for the current
      // user's OWN echoes (e.g. message:new with senderId === me) —
      // the cloud broadcasts those for multi-device sync, not for
      // self-notification. dedupe is handled inside the store.
      const me = cloudStore.user?.id ?? null
      switch (env.type) {
        case 'friend:added': {
          notifStore.push({
            kind: 'friend_added',
            title: 'Nouvel ami',
            body: env.data.user.displayName ?? env.data.user.username,
            link: `/community/profile/${env.data.user.id}`,
            thumbnailUrl: env.data.user.avatarPath ?? null,
          })
          break
        }
        case 'friend:request': {
          // Server emits this when a new incoming request lands.
          // Tolerant of an undefined event shape — older servers
          // might not ship the `request` envelope yet.
          const data = (env as unknown as { data?: {
            fromUser?: { id?: string; username?: string; displayName?: string; avatarPath?: string | null }
          } }).data
          if (data?.fromUser) {
            notifStore.push({
              kind: 'friend_request_received',
              title: 'Demande d\'ami',
              body: data.fromUser.displayName ?? data.fromUser.username ?? null,
              link: '/community/friends',
              thumbnailUrl: data.fromUser.avatarPath ?? null,
            })
          }
          break
        }
        case 'message:new': {
          const msg = env.data
          if (msg.senderId !== me) {
            const peer = cloudStore.friends.find((f) => f.id === msg.senderId)
            notifStore.push({
              kind: 'message_received',
              title: peer?.displayName ?? peer?.username ?? 'Nouveau message',
              body: msg.content.slice(0, 120),
              link: `/community/chat/${msg.senderId}`,
              thumbnailUrl: peer?.avatarPath ?? null,
            })
          }
          break
        }
        case 'activity:new': {
          // Most activity events are friend "joue à X" entries —
          // those clutter the bell. We only surface the explicit
          // ones the user typically wants to know about.
          const kind = env.data.kind
          if (kind === 'review_liked') {
            notifStore.push({
              kind: 'review_liked',
              title: 'Quelqu\'un a aimé ton avis',
              body: null,
              link: `/community/profile/${env.data.userId}`,
              thumbnailUrl: null,
            })
          }
          break
        }
      }
    })

    // Native-toast click → navigate. The main process emits 'nav:goto'
    // when the user clicks a Windows toast (new message, friend
    // launched a game, update available). Calling router.navigate
    // outside React-tree is fine: it's the same instance the
    // RouterProvider holds.
    const unsubNav = window.nexus.window.onNavGoto((link) => {
      try {
        void router.navigate(link)
      } catch {
        /* link can be malformed if a future server pushes new shapes — ignore */
      }
    })

    // Toast actions — clicked toasts with link `action:<verb>` end
    // up here instead of nav:goto. update-now re-fires the cached
    // update check so the UpdatePopup pops to the foreground (it
    // subscribes to update:available which check() re-emits).
    const unsubToastAction = window.nexus.window.onToastAction((verb) => {
      if (verb === 'update-now') {
        void window.nexus.update.check()
      }
    })

    // Mirror main-process debug log entries into the renderer
    // DevTools console. Free real-time tail for anyone who opens
    // Ctrl+Shift+I — no need to dig into the .log file on disk
    // when chasing a regression in the WS pipeline.
    const unsubDbg = window.nexus.debug.onLog((entry) => {
      // eslint-disable-next-line no-console
      console.log(`%c[${entry.tag}]%c ${entry.msg}`, 'color:#7dd3fc', '', entry.data ?? '')
    })

    // Update popup → also mirror to the bell so the user has a
    // persistent record (the toast itself is transient).
    const unsubUpd = window.nexus.update.onAvailable((info) => {
      notifStore.push({
        kind: 'update_available',
        title: 'Mise à jour disponible',
        body: `Nexus Launcher ${info.latestVersion}`,
        link: null,
        thumbnailUrl: null,
      })
    })

    return () => {
      unsubProgress()
      unsubState()
      unsubAdded()
      unsubRemoved()
      unsubRunning()
      unsubLibAdded()
      unsubAch()
      unsubPres()
      unsubCloudStatus()
      unsubCloudEvent()
      unsubUpd()
      unsubNav()
      unsubToastAction()
      unsubDbg()
    }
  }, [])

  // UpdatePopup is rendered alongside the router so it floats above
  // every route. Subscribes to `update:available` and shows a toast
  // in the bottom-right when the GitHub poller finds a new version.
  return (
    <>
      <RouterProvider router={router} />
      <UpdatePopup />
      {/* Global Ctrl/Cmd+K command palette — searches library,
          catalogues and friends. Mounted outside RouterProvider so
          the keyboard listener binds once for the whole session. */}
      <CommandPalette />
      {/* Cheat-sheet des raccourcis clavier — Ctrl+/ depuis n'importe où. */}
      <KeyboardShortcutsDialog />
      {/* "Quoi de neuf" — auto-pops the first time the user launches
          a build that's newer than the version they last saw. Reads
          __NEXUS_VERSION__ + localStorage to make the call, so this
          mount has zero cost in steady-state (returns null until a
          version bump). */}
      <ChangelogDialog autoOpen />
    </>
  )
}
