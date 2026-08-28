/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // En táctil el hover «se pega» tras cada toque: solo se emite donde hay puntero real.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: {
        /*
         * Paleta «sala de control»: grafito neutro + color como señal.
         * El croma del neutro es muy bajo (0.007–0.012) a propósito: si las
         * superficies ya están teñidas, los estados dejan de destacar. Todos los
         * pares de contraste están medidos contra WCAG AA (ver docs/DISENO.md).
         */
        bg: 'oklch(16% 0.007 255 / <alpha-value>)', // fondo de página
        surface: 'oklch(19.5% 0.008 255 / <alpha-value>)', // tarjetas / drawer
        surface2: 'oklch(23.5% 0.009 255 / <alpha-value>)', // superficie elevada / hover
        surface3: 'oklch(27.5% 0.010 255 / <alpha-value>)', // pulsado / selección de fila
        line: 'oklch(30% 0.010 255 / <alpha-value>)', // bordes hairline
        line2: 'oklch(36% 0.012 255 / <alpha-value>)', // borde acentuado / hover
        txt: 'oklch(97% 0.004 255 / <alpha-value>)', // texto principal — 16.8:1
        sub: 'oklch(77.5% 0.010 255 / <alpha-value>)', // texto secundario — 8.98:1
        subtle: 'oklch(64% 0.012 255 / <alpha-value>)', // terciario / placeholders — 5.44:1 (antes 4.07, fallaba AA)
        /*
         * Azul de instrumento. Dos pasos porque un solo tono no puede ser a la vez
         * fondo de botón (necesita blanco legible encima: 4.84:1) y texto sobre
         * oscuro (8.57:1). Es la única familia de marca de la interfaz.
         */
        acc: 'oklch(55% 0.135 250 / <alpha-value>)', // superficie de acción
        'acc-soft': 'oklch(76% 0.110 250 / <alpha-value>)', // acento sobre oscuro: enlaces, iconos
        ok: 'oklch(74% 0.150 152 / <alpha-value>)',
        warn: 'oklch(79.5% 0.140 80 / <alpha-value>)',
        err: 'oklch(65.5% 0.195 25 / <alpha-value>)',
        info: 'oklch(76% 0.110 250 / <alpha-value>)', // informativo = el mismo azul: una familia, no dos
        term: 'oklch(12.5% 0.006 255 / <alpha-value>)', // fondo de terminales/logs
        term2: 'oklch(17% 0.007 255 / <alpha-value>)', // cromo de la consola (cabecera, canalón, barra)
        /*
         * Serie categórica para gráficas. Escalonada en luminosidad (Δ≈0.10 entre
         * series consecutivas) para que se distingan también en escala de grises
         * y con daltonismo, no solo por tono.
         */
        'chart-1': 'oklch(58.4% 0.135 248 / <alpha-value>)',
        'chart-2': 'oklch(68.9% 0.150 352 / <alpha-value>)',
        'chart-3': 'oklch(72.7% 0.145 152 / <alpha-value>)',
        'chart-4': 'oklch(81.3% 0.105 296 / <alpha-value>)',
        'chart-5': 'oklch(86.1% 0.130 80 / <alpha-value>)',
        'chart-6': 'oklch(89.4% 0.090 196 / <alpha-value>)',
      },
      borderRadius: {
        // Radios unificados: controles 8px, tarjetas 12px, overlays 16px.
        md: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '16px',
      },
      fontFamily: {
        sans: ['Inter Variable', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      fontSize: {
        /*
         * Escala de 7 pasos. Antes había 20+ tamaños arbitrarios y casi todo
         * caía en 11–13px: de ahí la sensación de interfaz plana. Cada paso
         * lleva su interlineado y su tracking (los tamaños pequeños necesitan
         * algo de aire entre letras; los grandes, lo contrario).
         */
        micro: ['10.5px', { lineHeight: '14px', letterSpacing: '0.02em' }],
        xs: ['11.5px', { lineHeight: '16px', letterSpacing: '0.005em' }],
        sm: ['13px', { lineHeight: '18px', letterSpacing: '0' }],
        base: ['14px', { lineHeight: '21px', letterSpacing: '-0.006em' }],
        lg: ['16px', { lineHeight: '23px', letterSpacing: '-0.011em' }],
        xl: ['20px', { lineHeight: '27px', letterSpacing: '-0.017em' }],
        '2xl': ['26px', { lineHeight: '32px', letterSpacing: '-0.022em' }],
      },
      boxShadow: {
        /*
         * En oscuro las sombras casi no se ven: la separación la hace el borde.
         * Por eso solo quedan tres, y las dos grandes son para cosas que flotan
         * de verdad (overlays). Se acabaron las sombras teñidas de marca.
         */
        lvl1: '0 1px 2px rgba(0,0,0,.35)',
        lvl2: '0 4px 12px -4px rgba(0,0,0,.5)',
        lvl3: '0 24px 64px -16px rgba(0,0,0,.75)',
        // Alias histórico: varios sitios lo usaban sin estar definido (no pintaba nada).
        modal: '0 24px 64px -16px rgba(0,0,0,.75)',
        toast: '0 16px 40px -12px rgba(0,0,0,.65)',
        drawer: '-16px 0 40px -28px rgba(0,0,0,.7)',
      },
      screens: {
        nav: '1100px', // topbar: stats de host visibles a partir de aquí
        drawer: '900px', // el drawer es panel lateral a partir de aquí; debajo, pantalla completa
      },
    },
  },
  plugins: [],
};
