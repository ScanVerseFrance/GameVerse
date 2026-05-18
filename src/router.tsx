import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { createHashRouter, Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from './stores/auth.store'
import { useCloudStore } from './stores/cloud.store'
import AppLayout from './components/layout/AppLayout'
import { CloudAuthGate } from './components/cloud/CloudAuthGate'
import { LoadingSpinner } from './components/ui/LoadingSpinner'

// v0.1.1: the separate local LoginPage / RegisterPage / ForgotPage
// routes were removed. Creating or signing into a Nexus Cloud account
// is now the SINGLE auth flow — the cloud user gets mirrored into the
// local DB automatically (see cloud.store::mirrorCloudToLocal), so
// the rest of the launcher still sees a populated useAuthStore.user
// without the user ever filling a second form.
const HomePage = lazy(() => import('./pages/home/HomePage'))
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))
const PrivacyPage = lazy(() => import('./pages/settings/PrivacyPage'))
const ThemesPage = lazy(() => import('./pages/themes/ThemesPage'))
const AddonsPage = lazy(() => import('./pages/addons/AddonsPage'))
const DiscoverPage = lazy(() => import('./pages/discover/DiscoverPage'))
const GamePage = lazy(() => import('./pages/game/GamePage'))
const JsonGamePage = lazy(() => import('./pages/game/JsonGamePage'))
const DownloadsPage = lazy(() => import('./pages/downloads/DownloadsPage'))
const LibraryPage = lazy(() => import('./pages/library/LibraryPage'))
const CommunityPage = lazy(() => import('./pages/community/CommunityPage'))
const ProfilePage = lazy(() => import('./pages/community/ProfilePage'))
const ProfileEditPage = lazy(() => import('./pages/community/ProfileEditPage'))
const FriendsPage = lazy(() => import('./pages/community/FriendsPage'))
const ChatPage = lazy(() => import('./pages/community/ChatPage'))
const BigPicturePage = lazy(() => import('./pages/big-picture/BigPicturePage'))

function FullScreenBoot() {
  return (
    <div className="w-full h-screen flex items-center justify-center bg-bg-primary">
      <LoadingSpinner size="lg" />
    </div>
  )
}

function lazyElement(Component: LazyExoticComponent<ComponentType>) {
  return (
    <Suspense fallback={<FullScreenBoot />}>
      <Component />
    </Suspense>
  )
}

function AuthGate() {
  // Single gate, single source of truth: Nexus Cloud.
  //
  // The local useAuthStore.user is populated automatically once cloud
  // auth resolves (cloud.store::mirrorCloudToLocal upserts the local
  // row and issues a local session token). So:
  //   - while local restoreSession() is still loading → spinner
  //   - if cloud is still connecting (first boot) → spinner inside
  //     CloudAuthGate (it shows "Connexion à Nexus Cloud…")
  //   - if cloud is 'disconnected' (no token saved) → CloudAuthGate
  //     surfaces the register/login form
  //   - 'connected' or 'offline' (token valid but no network) AND a
  //     local user row exists → app
  //
  // v0.2.2: ALSO gate on `user` being non-null. Before, a successful
  // cloud connect + failed local-mirror (e.g. UNIQUE-constraint race
  // from a leftover v0.1.x guest row) would land in AppLayout with
  // useAuthStore.user = null — pages depending on user.id stayed
  // empty forever. Now we stay on the cloud gate which keeps trying.
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const cloudStatus = useCloudStore((s) => s.status)
  if (status === 'loading') return <FullScreenBoot />
  if (cloudStatus !== 'connected' && cloudStatus !== 'offline') {
    return <CloudAuthGate />
  }
  if (!user) {
    // Cloud is up but local user wasn't materialised — pause here
    // rather than hand AppLayout a null user that crashes deep
    // components.
    return <CloudAuthGate />
  }
  return (
    <AppLayout>
      <Suspense fallback={<FullScreenBoot />}>
        <Outlet />
      </Suspense>
    </AppLayout>
  )
}

export const router = createHashRouter([
  // Legacy local auth routes (`/login`, `/register`, `/forgot`) were
  // removed in v0.1.1 — every entrypoint funnels through AuthGate
  // which shows CloudAuthGate when needed. Any leftover deep link
  // gets caught by the catchall at the bottom.
  {
    path: '/',
    element: <AuthGate />,
    children: [
      { index: true, element: lazyElement(HomePage) },
      { path: 'discover', element: lazyElement(DiscoverPage) },
      { path: 'library', element: lazyElement(LibraryPage) },
      { path: 'downloads', element: lazyElement(DownloadsPage) },
      { path: 'community', element: lazyElement(CommunityPage) },
      { path: 'community/friends', element: lazyElement(FriendsPage) },
      { path: 'community/profile/:userId', element: lazyElement(ProfilePage) },
      { path: 'community/profile/:userId/edit', element: lazyElement(ProfileEditPage) },
      { path: 'community/chat', element: lazyElement(ChatPage) },
      { path: 'community/chat/:peerId', element: lazyElement(ChatPage) },
      { path: 'big-picture', element: lazyElement(BigPicturePage) },
      { path: 'addons', element: lazyElement(AddonsPage) },
      { path: 'themes', element: lazyElement(ThemesPage) },
      { path: 'settings', element: lazyElement(SettingsPage) },
      { path: 'settings/privacy', element: lazyElement(PrivacyPage) },
      { path: 'game/:addonId/:gameId', element: lazyElement(GamePage) },
      { path: 'json-game/:gameId', element: lazyElement(JsonGamePage) },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
