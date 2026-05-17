import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { createHashRouter, Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from './stores/auth.store'
import AppLayout from './components/layout/AppLayout'
import { LoadingSpinner } from './components/ui/LoadingSpinner'

const LoginPage = lazy(() => import('./pages/auth/LoginPage'))
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage'))
const ForgotPage = lazy(() => import('./pages/auth/ForgotPage'))
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
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  if (status === 'loading') return <FullScreenBoot />
  if (!user) return <Navigate to="/login" replace />
  return (
    <AppLayout>
      <Suspense fallback={<FullScreenBoot />}>
        <Outlet />
      </Suspense>
    </AppLayout>
  )
}

function GuestGate() {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  if (status === 'loading') return <FullScreenBoot />
  if (user) return <Navigate to="/" replace />
  return (
    <Suspense fallback={<FullScreenBoot />}>
      <Outlet />
    </Suspense>
  )
}

export const router = createHashRouter([
  {
    element: <GuestGate />,
    children: [
      { path: '/login', element: lazyElement(LoginPage) },
      { path: '/register', element: lazyElement(RegisterPage) },
      { path: '/forgot', element: lazyElement(ForgotPage) },
    ],
  },
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
