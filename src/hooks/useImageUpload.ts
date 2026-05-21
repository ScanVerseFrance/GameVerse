import { useRef, useState } from 'react'

/**
 * Opens a hidden `<input type="file">` and resolves with the picked image
 * as a data URL (≤10 MB). Used by the profile page so the user can swap
 * their avatar / banner with a single click on the existing image without
 * routing through the Settings page.
 *
 * Limit ladder:
 *   - 10 MB hard cap (same as Settings → Compte)
 *   - accepted MIME types: image/png, image/jpeg, image/gif, image/webp
 *   - returns `null` when cancelled or invalid; the caller is responsible
 *     for surfacing errors to the user.
 */
const MAX_BYTES = 10 * 1024 * 1024
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

export function useImageUpload() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const resolverRef = useRef<((v: { dataUrl: string } | null) => void) | null>(null)
  const [error, setError] = useState<string | null>(null)

  function clearError() {
    setError(null)
  }

  function pick(): Promise<{ dataUrl: string; mime: string } | null> {
    return new Promise((resolve) => {
      if (!inputRef.current) {
        // Lazily create a detached input — keeps the DOM clean and the
        // hook usable without rendering a hidden node in every consumer.
        const el = document.createElement('input')
        el.type = 'file'
        el.accept = ACCEPT
        el.style.display = 'none'
        document.body.appendChild(el)
        inputRef.current = el
      }
      const el = inputRef.current
      const cb = resolve as (v: { dataUrl: string; mime: string } | null) => void
      resolverRef.current = cb as (v: { dataUrl: string } | null) => void
      el.value = ''
      el.onchange = async () => {
        const f = el.files?.[0]
        if (!f) {
          cb(null)
          return
        }
        if (f.size > MAX_BYTES) {
          setError(`Fichier trop volumineux (max ${Math.round(MAX_BYTES / 1024 / 1024)} Mo).`)
          cb(null)
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const url = typeof reader.result === 'string' ? reader.result : null
          if (!url) {
            setError('Lecture du fichier échouée.')
            cb(null)
            return
          }
          setError(null)
          // Surface the MIME so the caller can decide whether to open
          // the cropper (skipped for animated formats — see ProfilePage).
          cb({ dataUrl: url, mime: f.type || 'application/octet-stream' })
        }
        reader.onerror = () => {
          setError('Lecture du fichier échouée.')
          cb(null)
        }
        reader.readAsDataURL(f)
      }
      el.click()
    })
  }

  return { pick, error, clearError }
}
