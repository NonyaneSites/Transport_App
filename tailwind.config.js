/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#18181b',
        card: '#222225',
        'card-2': '#2b2b30',
        'card-3': '#35353b',
        crimson: {
          DEFAULT: '#b9572c',
          dark: '#a34b26',
          light: '#e6a17e',
          50: '#fff7f0',
          100: '#fce9db',
          200: '#f5cdb2',
          300: '#edb18e',
          400: '#e6a17e',
          500: '#b9572c',
          600: '#a34b26',
          700: '#874023',
          800: '#703821',
          900: '#492c20',
          950: '#30231e',
        },
        success: {
          DEFAULT: '#34836a',
          dark: '#286b56',
          light: '#8ec9b2',
        },
        warning: {
          DEFAULT: '#c59347',
          dark: '#916829',
          light: '#e4c18b',
        },
        ink: '#f4f4f5',
        'ink-muted': '#d4d4d8',
        muted: '#a1a1aa',
        line: '#3f3f46',
        'line-bright': '#57575f',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        crimson: '0 4px 20px -4px rgba(185,87,44,0.12)',
        card: '0 4px 20px -2px rgba(0,0,0,0.22)',
        subtle: '0 1px 3px 0 rgba(0,0,0,0.18)',
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
