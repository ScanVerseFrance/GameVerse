import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  hue: number
  alpha: number
}

export function AnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let particles: Particle[] = []
    let lastScale = 1

    function resize() {
      if (!canvas || !ctx) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(dpr, dpr)
      lastScale = dpr
    }

    function spawn() {
      if (!canvas) return
      const W = canvas.clientWidth
      const H = canvas.clientHeight
      const count = Math.min(70, Math.max(20, Math.floor((W * H) / 22000)))
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.2,
        vy: (Math.random() - 0.5) * 0.2,
        r: 1 + Math.random() * 2.6,
        hue: 250 + Math.random() * 40,
        alpha: 0.35 + Math.random() * 0.4,
      }))
    }

    function step() {
      if (!canvas || !ctx) return
      const W = canvas.clientWidth
      const H = canvas.clientHeight
      ctx.clearRect(0, 0, W, H)

      const grd = ctx.createLinearGradient(0, 0, W, H)
      grd.addColorStop(0, 'rgba(91, 163, 43, 0.10)')
      grd.addColorStop(0.5, 'rgba(136, 192, 87, 0.06)')
      grd.addColorStop(1, 'rgba(102, 192, 244, 0.08)')
      ctx.fillStyle = grd
      ctx.fillRect(0, 0, W, H)

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < -10) p.x = W + 10
        if (p.x > W + 10) p.x = -10
        if (p.y < -10) p.y = H + 10
        if (p.y > H + 10) p.y = -10

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${p.hue}, 85%, 70%, ${p.alpha})`
        ctx.shadowColor = `hsla(${p.hue}, 85%, 60%, 0.6)`
        ctx.shadowBlur = 14
        ctx.fill()
      }
      ctx.shadowBlur = 0

      ctx.lineWidth = 0.6
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i]
          const b = particles[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < 13000) {
            const t = 1 - d2 / 13000
            ctx.strokeStyle = `hsla(258, 80%, 70%, ${0.15 * t})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      raf = requestAnimationFrame(step)
    }

    const ro = new ResizeObserver(() => {
      resize()
      spawn()
    })
    resize()
    spawn()
    ro.observe(canvas)
    step()
    void lastScale

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div className="absolute inset-0 bg-bg-primary" />
      <div
        className="absolute -inset-40 opacity-50"
        style={{
          background:
            'radial-gradient(circle at 20% 30%, rgba(91, 163, 43, 0.28), transparent 40%), radial-gradient(circle at 80% 70%, rgba(102, 192, 244, 0.22), transparent 45%), radial-gradient(circle at 60% 20%, rgba(136, 192, 87, 0.18), transparent 50%)',
          filter: 'blur(40px)',
          animation: 'gradient-shift 16s ease-in-out infinite',
        }}
      />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <div className="absolute inset-0 bg-gradient-to-t from-bg-primary/80 via-transparent to-bg-primary/40" />
    </div>
  )
}
