import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/common/AppErrorBoundary'
import './index.css'

// Expose the launcher version on `window.__NEXUS_VERSION__` so the
// error boundary can include it in copy-to-clipboard bug reports
// without having to thread package.json through Vite separately.
;(window as unknown as { __NEXUS_VERSION__?: string }).__NEXUS_VERSION__ =
  '0.2.7'

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
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
)
