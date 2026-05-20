import { type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { TitleBar } from './TitleBar'
import { TopNav } from './TopNav'
import { StatusBar } from './StatusBar'
import { AchievementToastContainer } from '@/components/achievements/AchievementToast'
import { FriendLaunchedToastContainer } from '@/components/community/FriendLaunchedToast'
import { CloudSaveToastContainer } from '@/components/cloud/CloudSaveToast'
import { usePresence } from '@/hooks/usePresence'

/**
 * Shell de l'application — empile titlebar / topnav / main / statusbar.
 * Ajout v0.4 : décor aurora animé en arrière-plan (deux blobs gradient
 * qui flottent lentement), donne un fond vivant sans nuire à la lisibilité.
 * Big Picture reste full-bleed (pas de nav, pas de statusbar).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const immersive = location.pathname.startsWith('/big-picture')
  usePresence()

  return (
    <div className="relative flex flex-col w-screen h-screen overflow-hidden bg-bg-primary">
      {/* L'aurora statique vient déjà du body (background-image dans
          index.css). Ici on superpose seulement deux blobs flottants
          pour le mouvement. transform: translate3d force un layer GPU
          dédié et évite le re-paint des siblings sous le blur. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -left-32 w-[360px] h-[360px] rounded-full opacity-30 animate-float"
        style={{
          background: 'radial-gradient(circle, rgba(124,92,255,0.55), transparent 70%)',
          filter: 'blur(56px)',
          transform: 'translate3d(0,0,0)',
          willChange: 'transform',
          animationDuration: '12s',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -right-40 w-[440px] h-[440px] rounded-full opacity-20 animate-float"
        style={{
          background: 'radial-gradient(circle, rgba(255,122,200,0.5), transparent 70%)',
          filter: 'blur(72px)',
          transform: 'translate3d(0,0,0)',
          willChange: 'transform',
          animationDuration: '16s',
          animationDelay: '2s',
        }}
      />

      <div className="relative flex flex-col w-full h-full z-10">
        <TitleBar />
        {!immersive && <TopNav />}
        <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
        {!immersive && <StatusBar />}
        <AchievementToastContainer />
        <FriendLaunchedToastContainer />
        <CloudSaveToastContainer />
      </div>
    </div>
  )
}
