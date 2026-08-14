/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        card: '#141414',
        'card-2': '#1a1a1a',
        crimson: {
          DEFAULT: '#E63946',
          dark: '#c1121f',
          light: '#ff5a6a',
          50: '#fff1f2',
          100: '#ffe1e3',
          200: '#ffc8cc',
          300: '#ffa0a8',
          400: '#ff5a6a',
          500: '#E63946',
          600: '#c1121f',
          700: '#9d0a16',
          800: '#7a0810',
          900: '#5c070d',
        },
        success: {
          DEFAULT: '#2A9D8F',
          dark: '#1f7268',
          light: '#4ec0b2',
        },
        ink: '#F1FAEE',
        muted: '#8a8a8a',
        line: '#262626',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        crimson: '0 10px 40px -10px rgba(230,57,70,0.35)',
        card: '0 8px 30px -12px rgba(0,0,0,0.6)',
      },
      animation: {
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.35s cubic-bezier(0.16,1,0.3,1)',
        'scan': 'scan 2.5s linear infinite',
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.5', transform: 'scale(0.85)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scan: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
    },
  },
  plugins: [],
};
