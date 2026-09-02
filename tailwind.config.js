/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d0f14',
        card: '#131720',
        'card-2': '#191f2c',
        'card-3': '#21293a',
        crimson: {
          DEFAULT: '#e11d48',
          dark: '#be123c',
          light: '#fb7185',
          50: '#fff1f2',
          100: '#ffe4e6',
          200: '#fecdd3',
          300: '#fda4af',
          400: '#fb7185',
          500: '#e11d48',
          600: '#be123c',
          700: '#9f1239',
          800: '#881337',
          900: '#4c0519',
          950: '#2b020c',
        },
        success: {
          DEFAULT: '#10b981',
          dark: '#059669',
          light: '#34d399',
        },
        warning: {
          DEFAULT: '#f59e0b',
          dark: '#d97706',
          light: '#fbbf24',
        },
        ink: '#f8fafc',
        'ink-muted': '#cbd5e1',
        muted: '#64748b',
        line: '#202636',
        'line-bright': '#2e374d',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        crimson: '0 4px 20px -4px rgba(225,29,72,0.25)',
        card: '0 4px 20px -2px rgba(0,0,0,0.4)',
        subtle: '0 1px 3px 0 rgba(0,0,0,0.3)',
      },
      animation: {
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.25s cubic-bezier(0.16,1,0.3,1)',
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.4', transform: 'scale(0.9)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
