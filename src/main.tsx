import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/common/AppErrorBoundary'
import { ToastOverlayPage } from './pages/toast/ToastOverlayPage'
import { UninstallPage } from './pages/uninstall/UninstallPage'
import OverlayApp from './overlay/OverlayApp'
import { RemotePlayHost } from './remote-play/RemotePlayHost'
import { RemotePlayGuest } from './remote-play/RemotePlayGuest'
import './index.css'

// Expose the launcher version on `window.__NEXUS_VERSION__` so the
// error boundary can include it in copy-to-clipboard bug reports
// without having to thread package.json through Vite separately.
;(window as unknown as { __NEXUS_VERSION__?: string }).__NEXUS_VERSION__ =
  '0.5.4'

// Toast overlay mode — detected from the URL hash. The toast window
// service in electron/main loads index.html#/toast-overlay; when we
// see that we paint ONLY the floating toast stack, no app shell, no
// router, no error boundary. Stays out of the main launcher bundle
// only at the React tree level (the JS payload is shared, which is
// fine — Electron caches it).
const isToastOverlay =
  typeof window !== 'undefined' &&
  window.location.hash.startsWith('#/toast-overlay')

// Uninstall window — the launcher process is spawned with
// `--uninstall` from the registry's UninstallString; main.ts loads
// this same bundle with the `#/uninstall` hash so we render the
// minimal confirm UI instead of the full launcher shell.
const isUninstall =
  typeof window !== 'undefined' &&
  window.location.hash.startsWith('#/uninstall')

// Steam-style in-game overlay — chargé dans une 2ᵉ BrowserWindow
// transparente alwaysOnTop par overlay.service avec `?mode=overlay`
// dans la query string. Le shell launcher reste hors champ ; on rend
// uniquement OverlayApp.
const isOverlay =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('mode') === 'overlay'

// Remote Play Together — Phase B P2P streaming. Two new modes :
//   remote-play-host  : hidden BrowserWindow, captures + sends video
//   remote-play-guest : fullscreen viewer, receives + displays video,
//                       captures local gamepad, sends back
const remotePlayMode = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('mode')
  : null
const isRemotePlayHost = remotePlayMode === 'remote-play-host'
const isRemotePlayGuest = remotePlayMode === 'remote-play-guest'

// Flag the body so index.css can override the global dark
// --bg-primary fill — without this the transparent Electron window
// shows a giant opaque rectangle behind the toast cards.
if (isToastOverlay && typeof document !== 'undefined') {
  document.body.classList.add('toast-overlay')
}
// Idem pour l'overlay in-game : body transparent, on désactive le
// --bg-primary global.
if (isOverlay && typeof document !== 'undefined') {
  document.body.classList.add('game-overlay')
}

// Unhandled-rejection trap → write to console (DevTools-visible).
// Without this, a rejected promise from an IPC call leaves the user
// staring at a frozen view with no feedback. The error boundary
// won't catch async errors so this is the only signal at runtime.
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledrejection]', e.reason)
})
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[uncaught-error]', e.error ?? e.message)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isToastOverlay ? (
      <ToastOverlayPage />
    ) : isUninstall ? (
      <UninstallPage />
    ) : isRemotePlayHost ? (
      <AppErrorBoundary>
        <RemotePlayHost />
      </AppErrorBoundary>
    ) : isRemotePlayGuest ? (
      <AppErrorBoundary>
        <RemotePlayGuest />
      </AppErrorBoundary>
    ) : isOverlay ? (
      <AppErrorBoundary>
        <OverlayApp />
      </AppErrorBoundary>
    ) : (
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    )}
  </React.StrictMode>
)
