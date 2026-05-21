import { type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { TitleBar } from './TitleBar'
import { TopNav } from './TopNav'
import { StatusBar } from './StatusBar'
import { AchievementToastContainer } from '@/components/achievements/AchievementToast'
import { FriendLaunchedToastContainer } from '@/components/community/FriendLaunchedToast'
import { CloudSaveToastContainer } from '@/components/cloud/CloudSaveToast'
import { MiniPlayer } from '@/components/ui/MiniPlayer'
import { ExtendedPlayer } from '@/components/ui/ExtendedPlayer'
import { InAppToastContainer } from '@/components/common/InAppToastContainer'
import { HomeBackground } from '@/components/layout/HomeBackground'
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
  // La musique de profil est un cosmétique attaché à un profil — elle
  // n'a de sens que SUR ce profil. ScanVerse parité : on ne monte
  // Mini/Extended player que sur /community/profile/:id, sinon le
  // lecteur "bave" sur les autres pages (Découvrir, Bibliothèque, etc.)
  // où il n'a aucun rapport avec ce que l'user est en train de faire.
  const showMusicPlayer = location.pathname.startsWith('/community/profile/')
  usePresence()

  return (
    <div className="relative flex flex-col w-screen h-screen overflow-hidden bg-bg-primary">
      {/* v0.3.4 — Fond animé global (parité ScanVerse Personnalisation
          → "Fond animé de la page d'accueil"). HomeBackground se
          rend à null quand l'utilisateur n'a rien choisi, donc
          gratuit en steady-state. Posé EN PREMIER pour rester
          derrière l'aurora + le contenu (z-0 vs z-10). */}
      <HomeBackground />
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
        {/* InAppToast = toasts ScanVerse-style pour les feedbacks
            d'action user (save profil OK / KO, etc.). Différent des
            toasts ci-dessus qui sont des notifs systèmes. */}
        <InAppToastContainer />
        {/* Profile-music mini player — UNIQUEMENT sur les pages de
            profil. Le player se monte/démonte avec la route ; le
            MusicContext (qui vit au-dessus de AppLayout) garde son
            état → si l'user revient sur le même profil, le track
            reprend où il en était. */}
        {showMusicPlayer && <MiniPlayer />}
        {showMusicPlayer && <ExtendedPlayer />}
      </div>
    </div>
  )
}
