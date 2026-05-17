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
import { useApplyTheme } from './hooks/useApplyTheme'

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

  useApplyTheme()

  useEffect(() => {
    void restore()
    void loadCustom()
    void loadAddons()
    void loadDownloadSettings()
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

    return () => {
      unsubProgress()
      unsubState()
      unsubAdded()
      unsubRemoved()
      unsubRunning()
      unsubLibAdded()
      unsubAch()
      unsubPres()
    }
  }, [])

  return <RouterProvider router={router} />
}
