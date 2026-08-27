/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // En táctil el hover «se pega» tras cada toque: solo se emite donde hay puntero real.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: {
        // Paleta seria y viva: Obsidian & Midnight Slate con Electric Indigo
        bg: 'oklch(13% 0.015 265 / <alpha-value>)', // fondo de página
        surface: 'oklch(17.5% 0.02 265 / <alpha-value>)', // tarjetas / drawer
        surface2: 'oklch(21.5% 0.026 265 / <alpha-value>)', // superficie elevada / hover
        line: 'oklch(26.5% 0.028 265 / <alpha-value>)', // bordes hairline
        txt: 'oklch(96.5% 0.008 265 / <alpha-value>)', // texto principal
        sub: 'oklch(72% 0.025 265 / <alpha-value>)', // texto secundario
        subtle: 'oklch(56% 0.025 265 / <alpha-value>)', // texto terciario / placeholders
        acc: '#7c5dfa', // violeta eléctrico de marca
        'acc-soft': '#b8a5fc', // violeta claro para iconos sobre tinte de marca
        ok: 'oklch(76% 0.17 155 / <alpha-value>)',
        warn: 'oklch(80% 0.16 75 / <alpha-value>)',
        err: 'oklch(65% 0.23 25 / <alpha-value>)',
        info: 'oklch(74% 0.14 240 / <alpha-value>)', // azul cielo vivo
        term: 'oklch(10% 0.012 265 / <alpha-value>)', // fondo de terminales/logs
        term2: 'oklch(14.5% 0.016 265 / <alpha-value>)', // cromo de la consola (cabecera, canalón, barra)
      },
      borderRadius: {
        // Radios unificados: controles 10px, tarjetas 12px, overlays 14px.
        lg: '10px',
        xl: '12px',
        '2xl': '14px',
      },
      fontFamily: {
        sans: ['Inter Variable', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      boxShadow: {
        // Elevación de 3 niveles (nivel 1 con brillo interior superior: tacto de superficie).
        lvl1: '0 1px 2px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.03)',
        lvl3: '0 24px 64px -16px rgba(0,0,0,.8)',
        toast: '0 16px 40px -12px rgba(0,0,0,.7)',
        'card-hover': '0 12px 32px -16px color-mix(in oklab, #6e56cf 35%, rgba(0,0,0,.7))',
        'card-selected': '0 0 0 1px color-mix(in oklab, #6e56cf 40%, transparent), 0 8px 24px -12px color-mix(in oklab, #6e56cf 40%, transparent)',
        drawer: '-12px 0 32px -20px rgba(0,0,0,.6)',
      },
      screens: {
        nav: '1100px', // topbar: stats de host visibles a partir de aquí
        drawer: '900px', // el drawer es panel lateral a partir de aquí; debajo, pantalla completa
      },
    },
  },
  plugins: [],
};
