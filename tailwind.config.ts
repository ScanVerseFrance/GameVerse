import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-body)', 'Syne', 'Inter', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Syne', 'Inter', 'sans-serif'],
        mono: ['var(--font-mono)', '"JetBrains Mono"', 'monospace'],
      },
      colors: {
        'bg-primary': 'var(--bg-primary)',
        'bg-secondary': 'var(--bg-secondary)',
        'bg-tertiary': 'var(--bg-tertiary)',
        'bg-card': 'var(--bg-card)',
        'bg-hover': 'var(--bg-hover)',
        'fg-primary': 'var(--text-primary)',
        'fg-secondary': 'var(--text-secondary)',
        'fg-muted': 'var(--text-muted)',
        'accent-primary': 'var(--accent-primary)',
        'accent-secondary': 'var(--accent-secondary)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        error: 'var(--error)',
        'border-soft': 'var(--border)',
        glass: 'var(--glass)',
        'glass-border': 'var(--glass-border)',
        'surface-soft': 'var(--surface-soft)',
        'surface-soft-hover': 'var(--surface-soft-hover)',
        'surface-medium': 'var(--surface-medium)',
        'surface-strong': 'var(--surface-strong)',
        'surface-soft-border': 'var(--surface-soft-border)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      backgroundImage: {
        'accent-gradient': 'var(--accent-gradient)',
      },
      boxShadow: {
        glow: '0 0 30px -8px var(--accent-primary)',
        soft: '0 8px 32px -8px rgba(0, 0, 0, 0.4)',
        lift: '0 16px 48px -16px rgba(0, 0, 0, 0.6)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'gradient-shift': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
      },
      animation: {
        'fade-in': 'fade-in 240ms ease-out',
        'slide-up': 'slide-up 280ms ease-out',
        shimmer: 'shimmer 1.4s linear infinite',
        'gradient-shift': 'gradient-shift 16s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

export default config
