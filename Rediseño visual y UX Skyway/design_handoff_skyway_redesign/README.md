# Handoff: Rediseño visual y UX de Skyway

Paquete de implementación para Claude Code. Objetivo: aplicar el rediseño premium al repo real
**NkrowOne/Skyway** (rama `claude/railway-like-deployment-platform-bc3kzq`) sin romper ninguna
funcionalidad.

## Overview

Skyway es una plataforma de despliegue auto-alojada estilo Railway (React 18 + Vite + Tailwind CSS 3,
iconos `lucide-react`, TanStack Query + SSE). Este rediseño la lleva de "correcta" a premium y calmada:
nueva paleta seria (violeta #6e56cf sobre superficies oklch), jerarquía de elevación de 3 niveles,
primitivas rediseñadas, paleta de comandos ⌘K, atajos de teclado, LogViewer pro, formularios agrupados
con guardado sticky, StatusBadge unificado y responsive real hasta ~400px.

## Sobre los ficheros de diseño

Los `.dc.html` de esta carpeta son **referencias de diseño en HTML** (prototipos de alta fidelidad),
NO código de producción. La tarea es **recrear estas pantallas dentro de `web/src/` del repo Skyway**
usando sus patrones existentes: Tailwind (extendiendo `web/tailwind.config.js`, nunca CSS-in-JS),
`lucide-react`, y sin tocar `web/src/api.ts`, los `useQuery`/`useMutation`, los `EventSource` (SSE),
las rutas ni nada de `server/`. Solo maquetación, estilos, estructura visual y microinteracciones.
Los estilos en los HTML están inline y usan `var(--color-*)`: la tabla de tokens de abajo los traduce
a la config de Tailwind.

## Fidelidad

**Alta (hifi).** Colores, tipografía, espaciados, radios, sombras y copys son finales. Recrear
pixel-perfect con las utilidades de Tailwind del propio repo.

## Tokens de diseño → `web/tailwind.config.js`

Sustituir la paleta actual (`ink/panel/panel2/line/txt/sub/acc/acc2/ok/warn/err`) por:

```js
colors: {
  bg:        'oklch(14% 0.01 280)',   // fondo de página (antes ink #0a0b0f)
  surface:   'oklch(18% 0.013 280)',  // tarjetas / drawer (antes panel)
  surface2:  'oklch(22% 0.016 280)',  // superficie elevada / hover (antes panel2)
  line:      'oklch(28% 0.018 280)',  // bordes hairline (antes line)
  txt:       'oklch(96% 0.005 280)',  // texto principal
  sub:       'oklch(70% 0.015 280)',  // texto secundario (fg-muted)
  subtle:    'oklch(55% 0.015 280)',  // texto terciario / placeholders (fg-subtle)
  acc:       '#6e56cf',               // violeta de marca (antes #8b5cf6 — ahora más serio)
  'acc-soft':'#b9a7ee',               // violeta claro para iconos sobre tinte de marca
  ok:        'oklch(74% 0.16 142)',   // success
  warn:      'oklch(80% 0.15 80)',    // warning
  err:       'oklch(64% 0.22 25)',    // danger
  info:      'oklch(70% 0.13 220)',   // info (reemplaza el cian acc2 en usos semánticos)
},
```

Reglas de uso:
- **Fondos tintados por severidad**: `color-mix(in oklab, <tono> 13-16%, transparent)` — en Tailwind 3,
  usar el plugin de opacidad (`bg-ok/15`) sobre los tonos oklch, o clases utilitarias propias.
  Un único patrón para chips, alertas, hallazgos y diagnósticos.
- **Elevación (3 niveles)**: bg (página) → surface (border line, shadow `0 1px 2px rgba(0,0,0,.3)`)
  → surface2/overlays (shadow `0 24px 64px -16px rgba(0,0,0,.8)`); hover de tarjetas: borde
  `color-mix(acc 55%, line)` + `translateY(-1px)` + sombra tintada de marca.
- **Radios unificados**: controles 10px (`--radius`), tarjetas 12px, overlays 14px, pills 9999px.
- **Tipografía**: display 24/600/-.02em · título 20/600/-.015em · sección 14/600 · cuerpo 13-14 ·
  caption 11-12 · mono (font-mono del stack) para slugs, IPs, commits, rutas, logs; números con
  `font-variant-numeric: tabular-nums`.
- **Espaciado**: escala 4/8 estricta (4, 8, 10, 12, 14, 16, 20, 24, 28, 40).
- **Movimiento**: transiciones 150–220ms ease-out (hover, tabs, color); drawer: slide+fade 220ms;
  overlays: fade 150ms + panel scale/translate 180ms; toasts: translateY 200ms. Respetar
  `prefers-reduced-motion` (media query global que anula duraciones).
- **Focus**: `outline: 2px solid acc/70; outline-offset: 2px` en TODO elemento interactivo
  (focus-visible), incluidas tarjetas-enlace y chips.
- Contraste AA verificado en todos los pares texto/fondo listados.

## Pantallas

### 1. Topbar global (`components/Layout.tsx`) — en todas las pantallas
- Altura 56px, bg surface, border-b line, padding 0 20px.
- Logo: chip 28px radius 8 con `linear-gradient(135deg, acc, oklch(42% 0.16 295))`, icono rocket 15
  blanco, sombra tintada; "Skyway" 14/650. En páginas internas: breadcrumb `Skyway › <página>` con
  chevron y pill de empresa (border line, bg bg, 11px).
- Botón buscador ⌘K: flex hasta 300px, border line, bg bg, radius 10, texto subtle 13
  "Buscar o saltar a…", kbd `⌘K` (mono 11, bg surface2, border line, radius 5). En pantallas internas
  se compacta a icono+kbd; en móvil solo icono.
- Stats host: pill (radius full, border line, bg bg, 12px sub) con dot ok con glow:
  `CPU 0.42/8 · RAM 9.3 GB libres`. Se oculta <1100px (topbar colapsa stats).
- Iconos: campana (badge contador: 15px, bg err, borde 2px surface, 9px/700 blanco), escudo, ajustes,
  logout — botones 32px, radius 10, sub→txt on hover con bg surface2.

### 2. Dashboard (`pages/Dashboard.tsx`)
- Contenedor max-w 1120px, padding 40/24.
- Header: h1 24/600 "Proyectos" + descripción sub 14; acciones: Button secondary "Importar de Railway"
  (icono train-front) + primary "Nuevo proyecto".
- Chips de filtro: pills 12px con contador; activa: border acc/55 + bg acc/16 + texto acc-soft;
  inactivas: border line + bg surface + sub; `white-space: nowrap`.
- Secciones por empresa: label 12/600 uppercase tracking .09em sub + contador subtle + hairline flex-1.
- Tarjeta de proyecto: surface, radius 12, p 20, shadow nivel 1. Cabecera: chip icono 36px radius 10
  (bg acc/16, icono boxes acc-soft) + a la derecha pills de estado del proyecto: "N activos"
  (bg ok/14, texto ok, dot) y si hay alertas "N" con bell-ring (bg err/15, texto err). Nombre 15/600;
  meta "N servicios · <slug mono 11 subtle>"; pie "Último despliegue hace X" 11 subtle.
  Hover: borde acc, lift -1px, sombra tintada. Grid `repeat(auto-fill, minmax(280px, 1fr))` gap 16.
- **Paleta de comandos (⌘K / Ctrl+K)**: overlay `rgba(0,0,0,.55)` + blur 3px; panel 580px a 15vh,
  surface, radius 14, sombra nivel 3. Fila búsqueda: icono search + input 15px + kbd esc. Grupos
  "Proyectos" y "Acciones rápidas" (label 11 uppercase subtle). Fila: icono + texto 14 + meta derecha;
  seleccionada: bg acc/14 + barra izquierda 2px acc + kbd ↵. Footer: bg bg, border-t, kbds
  `↑↓ navegar · ↵ abrir · esc cerrar · ? atajos`.
- **Ayuda de atajos (`?`)**: modal 420px con lista tecla→acción: ⌘K paleta, `g p` proyectos,
  `g s` seguridad, `g a` alertas, `esc` cierra drawer/modales, `?` ayuda.

### 3. Proyecto + drawer (`pages/Project.tsx`, `ServiceCard.tsx`, `ServiceDrawer.tsx`)
- Canvas: título 20/600 + "Red privada" con slug en chip mono copiable; acciones: iconos
  pencil/trash ghost + secondary "Variables compartidas" / "Desplegar todo" + primary "Nuevo servicio".
- Grid servicios `repeat(auto-fill, minmax(250px, 1fr))` gap 14.
- **ServiceCard**: chip 36px con logo oficial del módulo (ver Assets): GitHub (bg txt/9, icono txt)
  para repos, PostgreSQL (bg rgba(51,103,145,.28), icono #93bce2), Redis (bg rgba(220,56,44,.16),
  icono #e0837b). Nombre 14/600 + subtítulo mono 11 subtle (repo corto / imagen:tag).
  **StatusBadge unificado** (un solo componente, sustituye las 3 variantes artesanales): pill bg
  <tono>/14, texto tono, dot 5px (pulse en transitorios), texto opcional réplicas "· 2/2".
  Métricas: "CPU x% · RAM x MB" tabular; si CPU en alerta, valor warn/600. Dominio: globe + texto
  sub con ellipsis (NO cian). Alerta: badge sólido flotante top-right "1 alerta" (bg err sólido,
  blanco, bell-ring) + borde de tarjeta err/45. Selección: borde acc/70 + ring
  `0 0 0 1px acc/40` + sombra tintada.
- **Drawer**: ancho `min(600px, 100vw - 64px)` (toggle a 840px con botón move-horizontal); border-l
  line, bg surface, sombra -12px; entrada slide+fade 220ms; `Esc` y X lo cierran; **<900px pasa a
  pantalla completa** (ver Móvil). Header: chip 38px con logo del servicio + nombre 16/650 +
  StatusBadge + subtítulo mono; acciones: primary sm "Desplegar" (rocket) + secondary sm
  Reiniciar/Detener + ghost terminal + link dominio (sub, ellipsis, max 190px).
- Tabs: 13px, activa 600 + subrayado 2px acc animado (transition left/width); inactivas sub.
- **Despliegues**: tarjetas bg bg radius 12; fila: pill de estado — vigente "Activo" (bg ok/14 texto
  ok), histórico "Completado"/"Fallido" en gris neutro (bg surface2, texto sub), fallido vigente en
  err — + commit 13/500 + meta mono 11 subtle (trigger · sha · hace X · duración) + icono rollback.
  Abierta: borde acc/30; error: caja err/8 border err/35; diagnóstico: caja warn/6 con lightbulb +
  título warn/600 + causa sub + "Cómo arreglarlo:" ok/600. Terminal: header bar surface2 con
  "BUILD & DEPLOY" mono 10 uppercase + copiar; cuerpo `oklch(11% 0.008 280)`, mono 11.5/1.7.
- **Variables**: tabla contenida (radius 12, border line, bg bg): columna clave mono 38% con border-r,
  valor mono (referencias `${{…}}` en info, secretos como puntos subtle), iconos copiar/borrar por
  fila, fila final "+ Añadir variable". Chips de sugerencias mono. Panel "Referencias disponibles"
  con grupos y chips info copiables. Footer: "Sin cambios" + Button primary disabled.
- **Backups** (solo BD): card "Backups automáticos" (icono calendar-clock, selects Frecuencia/
  Conservar + Guardar), línea "Último backup hace 3 h · DATA_DIR/backups" + primary sm "Crear backup
  ahora"; lista contenida con archive icon, fichero mono, meta, iconos descargar/restaurar/borrar.
- **Métricas** (`MetricChart.tsx` — mantener lógica SVG): línea 2px, área 12-14% opacidad, rejilla
  line al 50%, ejes mono 9 subtle, valor actual 15/600 tabular. CPU en acc #6e56cf, memoria en info.
  Tiles de red con chip icono tintado (recibido ok, enviado info). Pie "Muestras cada 2,5s…".
- **Logs (LogViewer pro)**: toolbar = input de filtro (icono search, mono 12) + toggles wrap
  (activo: bg acc/14 texto acc) + ir-a-inicio + ir-a-fin + copiar + descargar; línea de estado
  "1.243 líneas · réplica 1 de 2 · error y warn coloreados". Viewer bg `oklch(11% 0.008 280)`,
  heurística de niveles: líneas con error→err, warn→warn. Pill "Siguiendo" (autoscroll inteligente
  existente) flotante bottom-right con dot pulsante ok.
- **Ajustes (ServiceSettingsTab)**: secciones como cards (radius 12, bg bg) con cabecera
  icono-chip 28px + título 13/600 + descripción 11 subtle: General (logo GitHub), Dominios (globe
  info; fila de dominio con pill "DNS correcto" ok + acciones; caja subdominio automático con borde
  dashed acc/40 + sparkles; input dominio propio), Recursos y réplicas (cpu; grid 4; nota réplicas
  acc/7), Auto-deploy (logo GitHub; URL/secreto mono copiables), Zona de peligro (borde err/30,
  bg err/4, Button danger). **Barra sticky inferior**: border-t, bg surface/92 + blur, dot warn
  pulsante + "Tienes cambios sin guardar" + ghost "Descartar" + primary "Guardar cambios".
- **Toast rediseñado**: bottom-right 340px, surface2, radius 12, sombra nivel 3; icono de severidad
  (check-circle-2 ok), título 13/600, cuerpo 12 sub, acción opcional "Desplegar ahora →" acc/600,
  X para cerrar; apilado máx 3; botones con check de éxito momentáneo tras guardar.

### 4. Seguridad (`pages/Security.tsx`)
- Hero: anillo SVG de puntuación 88px (track line, progreso en el tono de la nota — C=warn;
  dasharray 238.7, offset proporcional a score) con letra 26/700 + "55/100" mono; pills de recuento
  (1 crítico err/14, 2 avisos warn/13, 1 informativo info/13); explicación del cálculo 12 sub.
- Hallazgos: `<details>` cards; crítico con borde err/35 y abierto por defecto; summary = pill
  severidad + título 14/600 + link proyecto acc; cuerpo = detalle sub + "Cómo arreglarlo:" ok/600.
- Cuenta y sesiones: card con icono key-round; grid 2 contraseñas + botones primary/secondary.
- Auditoría: card con icono scroll-text + select filtro; tabla radius 10: thead sticky surface2
  11 uppercase tracking; fechas e IPs mono 11 subtle; "Login fallido" en err/500 con fila bg err/4.

### 5. Alertas (`pages/Alerts.tsx`)
- Header + **control segmentado** Activas/Historial: contenedor border line bg bg radius 10 p 3;
  activa: bg surface2 + contador pill err.
- Tarjeta de alerta: icono-chip 34px por tipo/severidad (rocket err = deploy fallido, cpu warn = CPU
  alta, archive neutro = resueltas); título 14/600 + pill severidad + pill tipo (surface2 sub) +
  fecha mono 11; mensaje 13 sub; explicación en caja bg bg border line con icono lightbulb warn
  (sin emoji); acciones: "Ir al servicio →" acc/600 + ghost "Marcar resuelta". Resueltas: opacity
  .65 + "Resuelta <fecha>" con check ok. Activa crítica: borde err/35.

### 6. Ajustes globales (`pages/Settings.tsx`)
- max-w 780px. Secciones-card con cabecera icono+título+descripción: Dominios y TLS (globe info;
  pill "autodetectada" ok junto a IP), GitHub (logo oficial; pill "Conectado" ok con check),
  Alertas y notificaciones (bell-ring warn; grid 3 umbrales + canales; pills "configurado" ok),
  Sistema (cpu acc; pills Docker/Nixpacks ok con dot; grid stat-tiles CPU/Memoria/Disco/Skyway
  label 11 subtle + valor 14/600 tabular; fila uso Docker + secondary "Liberar espacio").
- Barra sticky inferior: "Los cambios se aplican al guardar" subtle + primary "Guardar ajustes".

### 7. Login (`pages/Login.tsx`, `Setup.tsx`)
- Fondo con `radial-gradient` de marca muy sutil arriba. Card 400px, radius 14, p 32/28, sombra
  nivel 3. Logo 52px gradiente + "Entrar en Skyway" 19/650 + subtítulo sub. Campos con focus ring
  (borde acc + `0 0 0 3px acc/25`), toggle de ojo en contraseña. Button primary lg full-width.
  Pie: shield-check + "Intentos limitados por IP · actividad en auditoría" 11.5 subtle.

### 8. Responsive (ver `Rediseño - Móvil.dc.html`)
- **<1100px**: topbar oculta stats; buscador ⌘K → icono.
- **~780px (tablet)**: dashboard a 2 columnas; chips scrollables con nowrap; acciones compactadas
  (Railway → botón texto "Importar").
- **<900px**: el drawer pasa a **pantalla completa** con transición; cabecera con botón atrás
  "‹ citas-online"; tabs con scroll horizontal; acciones táctiles ≥44px (botón Desplegar flex-1 +
  cuadrados 44px). Canvas a 1 columna: tarjetas de servicio en fila única (logo 38px + nombre +
  "CPU · RAM" + StatusBadge).
- Objetivo: usable hasta ~400px; hit targets ≥44px en móvil.

## Interacciones y comportamiento

- ⌘K/Ctrl+K abre/cierra paleta; Esc cierra paleta/ayuda/drawer/modales; `?` ayuda de atajos;
  `g p`/`g s`/`g a` navegación. Listeners globales en Layout; ignorar cuando el foco está en inputs.
- Skeletons (dashboard, canvas, listas de despliegues/alertas) en vez de spinners a pantalla
  completa: bloques surface2 con shimmer, misma silueta que el contenido final.
- Estados vacíos con propósito: ilustración SVG ligera propia + una frase + CTA directo
  (proyecto vacío → "Añadir servicio"; sin alertas → check ok "Todo en orden").
- Cero saltos de layout al cargar (reservar alturas con skeletons).
- Accesibilidad: roles/aria en tabs (`role=tablist/tab/tabpanel`), modales (`role=dialog`,
  focus trap, retorno de foco), menús; orden de tabulación lógico; focus ring visible en todo.

## Estado (solo UI, sin tocar data-fetching)

- `cmdOpen`, `helpOpen` (Layout) · `selectedService` vía searchParams como ahora · `tab` del drawer ·
  `openDeploymentId` · `drawerWide` (persistir en localStorage) · `dirty` por formulario (aviso
  sticky) · pila de toasts (máx 3, con acción opcional).

## Assets

- Iconos UI: `lucide-react` (ya en el stack) — mismos nombres usados en los HTML.
- Logos oficiales de módulos: `icons/*.svg` (simple-icons, CC0): github, postgresql, redis, docker,
  wordpress, mysql, mongodb, n8n. Importarlos como componentes SVG locales (sin CDN). Colores de
  chip indicados en la sección ServiceCard.
- Tipografía: si se desea, Inter Variable como asset local en `web/src/assets/` con @font-face;
  fallback system-ui (los mocks usan la pila del sistema).
- `tokens/_ds_bundle.css`: fuente canónica de los tokens oklch (buscar `--color-` en `:root`).

## Ficheros de esta carpeta

- `Rediseño - Dashboard.dc.html` — dashboard + paleta ⌘K + ayuda `?` (interactivos)
- `Rediseño - Proyecto.dc.html` — canvas + drawer con las 6 pestañas (clic en tarjetas/tabs; Esc cierra)
- `Rediseño - Seguridad.dc.html` · `Rediseño - Alertas.dc.html` · `Rediseño - Ajustes.dc.html` ·
  `Rediseño - Login.dc.html`
- `Rediseño - Móvil.dc.html` — tablet 780px, móvil 400px y drawer fullscreen
- `lucide.js` — mapa nombre→path de todos los iconos usados (referencia)
- `icons/` — logos oficiales SVG · `tokens/_ds_bundle.css` — tokens

## Método de trabajo sugerido (del brief original)

Fases con commit al final de cada una y `npm run typecheck && npm run build` en verde:
1. Tokens (`tailwind.config.js` + `index.css`: .input, .card, focus ring, keyframes, reduced-motion)
2. Primitivas (`ui.tsx`): Button (primary/secondary/ghost/danger), Field con validación inline,
   Modal animado, Tabs con indicador, Skeleton, StatusBadge nuevo, Toasts rediseñados, tooltips
3. Layout + Dashboard (+ paleta ⌘K y atajos)
4. Project + ServiceCard + drawer (anchos + fullscreen móvil)
5. Pestañas del drawer (Deployments, Variables, Backups, Metrics, LogViewer pro, Settings sticky)
6. Security, Alerts, Settings, Login + responsive final
Verificación visual con Playwright tras cada fase; criterio: cero regresiones funcionales,
bundle < 150 KB gzip (sin librerías nuevas: todo es Tailwind + CSS).
