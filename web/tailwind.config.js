/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0a0b0f',
        panel: '#12141a',
        panel2: '#171a22',
        line: '#262a35',
        txt: '#e7e9f0',
        sub: '#9aa0b0',
        acc: '#8b5cf6',
        acc2: '#22d3ee',
        ok: '#34d399',
        warn: '#fbbf24',
        err: '#f87171',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
