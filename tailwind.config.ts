import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-body)', 'Inter', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', '"JetBrains Mono"', 'monospace'],
      },
      colors: {
        'bg-primary': 'var(--bg-primary)',
        'bg-secondary': 'var(--bg-secondary)',
        'bg-tertiary': 'var(--bg-tertiary)',
        'bg-card': 'var(--bg-card)',
        'bg-hover': 'var(--bg-hover)',
        'bg-elevated': 'var(--bg-elevated)',
        'fg-primary': 'var(--text-primary)',
        'fg-secondary': 'var(--text-secondary)',
        'fg-muted': 'var(--text-muted)',
        'fg-faint': 'var(--text-faint)',
        'accent-primary': 'var(--accent-primary)',
        'accent-secondary': 'var(--accent-secondary)',
        'accent-tertiary': 'var(--accent-tertiary)',
        success: 'var(--success)',
        'success-soft': 'var(--success-soft)',
        warning: 'var(--warning)',
        'warning-soft': 'var(--warning-soft)',
        error: 'var(--error)',
        'error-soft': 'var(--error-soft)',
        info: 'var(--info)',
        'border-soft': 'var(--border)',
        'border-strong': 'var(--border-strong)',
        glass: 'var(--glass)',
        'glass-border': 'var(--glass-border)',
        'surface-soft': 'var(--surface-soft)',
        'surface-soft-hover': 'var(--surface-soft-hover)',
        'surface-medium': 'var(--surface-medium)',
        'surface-strong': 'var(--surface-strong)',
        'surface-soft-border': 'var(--surface-soft-border)',
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': '40px',
      },
      backgroundImage: {
        'accent-gradient': 'var(--accent-gradient)',
        'accent-gradient-soft': 'var(--accent-gradient-soft)',
      },
      boxShadow: {
        glow: '0 0 32px -8px var(--accent-glow)',
        'glow-strong': '0 0 48px -8px var(--accent-glow), 0 0 16px -4px var(--accent-glow)',
        soft: '0 8px 32px -8px rgba(0, 0, 0, 0.4)',
        lift: '0 16px 48px -16px rgba(0, 0, 0, 0.6)',
        'lift-strong': '0 24px 64px -16px rgba(0, 0, 0, 0.7)',
        inset: 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down': {
          '0%': { opacity: '0', transform: 'translateY(-12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'gradient-shift': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(124, 92, 255, 0.5)' },
          '50%': { boxShadow: '0 0 0 8px rgba(124, 92, 255, 0)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 240ms ease-out',
        'slide-up': 'slide-up 280ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-down': 'slide-down 280ms cubic-bezier(0.22, 1, 0.36, 1)',
        'scale-in': 'scale-in 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        shimmer: 'shimmer 1.6s linear infinite',
        'gradient-shift': 'gradient-shift 16s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2.4s ease-in-out infinite',
        float: 'float 4s ease-in-out infinite',
      },
      backdropBlur: {
        xs: '4px',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.22, 1, 0.36, 1)',
        'out-back': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
}

export default config
