import { type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { TitleBar } from './TitleBar'
import { TopNav } from './TopNav'
import { StatusBar } from './StatusBar'
import { AchievementToastContainer } from '@/components/achievements/AchievementToast'
import { FriendLaunchedToastContainer } from '@/components/community/FriendLaunchedToast'
import { usePresence } from '@/hooks/usePresence'

/**
 * App shell. Stacks: window chrome (TitleBar) → horizontal nav (TopNav) →
 * main content → status bar. Big Picture is full-bleed: it strips the
 * TopNav and StatusBar so the immersive shell owns the viewport.
 *
 * The achievement toast portal lives at the shell level so unlock
 * notifications appear regardless of which route is mounted (the
 * watcher fires from the main process even when the user is on the
 * Downloads tab while the game runs in the background).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const immersive = location.pathname.startsWith('/big-picture')
  // Drives the green/violet/orange presence dot for the current user.
  // Mounts once at the shell level so every route shares the same
  // heartbeat + idle timer (no double-firing on route change).
  usePresence()

  return (
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-bg-primary">
      <TitleBar />
      {!immersive && <TopNav />}
      <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
      {!immersive && <StatusBar />}
      <AchievementToastContainer />
      <FriendLaunchedToastContainer />
    </div>
  )
}
