# Prompt: rediseño visual y de UX de Skyway

> Copia todo lo que hay debajo de la línea en una sesión de Claude Code abierta sobre este repositorio.

---

Eres un diseñador de producto senior especializado en herramientas para desarrolladores (nivel Linear, Vercel, Raycast) trabajando sobre el código real. Vas a hacer un **rediseño visual y de UX completo de Skyway**, una plataforma de despliegue auto-alojada estilo Railway que ya funciona en producción. El objetivo: que pase de "correcta" a **premium, calmada y con carácter propio**, aplicando las mejores prácticas actuales de UX de herramientas de desarrollo — sin romper ni una sola funcionalidad.

## Contexto del producto

Skyway lo usa **una sola persona (admin)** para gestionar despliegues de proyectos de varias empresas cliente: repos de GitHub, bases de datos, dominios, alertas, backups. Se usa a diario, a veces de madrugada durante un incidente: la interfaz debe transmitir **control y serenidad**, con la información crítica (estados, alertas, errores) visible de un vistazo. Toda la UI está en **español** — mantenlo.

## Stack y restricciones (no negociables)

- React 18 + Vite + **Tailwind CSS 3** (extiende `web/tailwind.config.js`, no lo sustituyas por CSS-in-JS), iconos `lucide-react`, estado con TanStack Query + SSE.
- **No toques la lógica**: `web/src/api.ts`, los `useQuery`/`useMutation`, los `EventSource` (SSE), las rutas ni nada de `server/`. Solo maquetación, estilos, estructura visual de componentes y microinteracciones.
- **Sin dependencias pesadas**: nada de librerías de componentes (MUI, Chakra...) ni de animación grandes. CSS/Tailwind transitions y, como mucho, una librería de primitivas headless ligera si de verdad la necesitas. El bundle actual es ~90 KB gzip; no lo dupliques.
- **Auto-contenido**: sin fuentes ni assets por CDN. Si usas una tipografía (recomiendo Inter Variable o Geist), inclúyela como asset local en `web/src/assets/` con `@font-face`.
- Tema **oscuro como primario** (es el hábitat natural del producto). Modo claro: opcional, solo si te da tiempo tras terminar todo lo demás.

## Mapa del código (léelo antes de tocar nada)

```
web/src/
  index.css                    tokens/utilidades base (.input, .card, scrollbar)
  tailwind.config.js           paleta actual: ink #0a0b0f, panel #12141a, panel2 #171a22,
                               line #262a35, txt #e7e9f0, sub #9aa0b0, acc #8b5cf6 (violeta),
                               acc2 #22d3ee, ok #34d399, warn #fbbf24, err #f87171
  components/ui.tsx            primitivas: Button, Field, Modal, ConfirmModal, Tabs,
                               StatusDot, Spinner, CopyButton, Toasts
  components/Layout.tsx        topbar (logo, stats host, campana alertas, escudo, ajustes)
  pages/Dashboard.tsx          proyectos agrupados por empresa + filtros + importar Railway
  pages/Project.tsx            canvas de servicios + drawer + variables compartidas + informe import
  pages/Security.tsx           puntuación A–E, hallazgos, auditoría, sesiones
  pages/Alerts.tsx             lista de alertas con severidades
  pages/Settings.tsx           dominios/TLS/IP, GitHub, alertas y canales, sistema/disco
  pages/Login.tsx, Setup.tsx   auth
  components/ServiceCard.tsx   tarjeta de servicio (estado, métricas, réplicas, alertas)
  components/ServiceDrawer.tsx drawer 560px con pestañas
  components/tabs/             DeploymentsTab (logs en vivo + diagnóstico), VariablesTab,
                               BackupsTab, MetricsTab (gráficas SVG propias), LogsTab,
                               ServiceSettingsTab (formularios largos)
  components/DomainsEditor.tsx asistente de dominios con verificación DNS
  components/RailwayImportModal.tsx  wizard de importación
  components/ExecModal.tsx     terminal de un comando
  components/MetricChart.tsx   gráfica de área SVG pura
  components/LogViewer.tsx     visor de logs con autoscroll
```

## Debilidades actuales (diagnóstico honesto)

Paleta correcta pero plana (todo son cajas `panel` con borde `line`, sin jerarquía de elevación); tipografía sin escala definida (todo text-sm/text-xs); sin transiciones ni estados de carga elegantes (spinners genéricos, nada de skeletons); estados vacíos pobres; formularios largos sin agrupación visual clara (ServiceSettingsTab); sin atajos de teclado ni paleta de comandos; foco de teclado casi invisible; sin responsive real por debajo de ~1100px (el drawer es fijo de 560px).

## Sistema de diseño a construir (fase 1)

1. **Tokens**: escala tipográfica (display/título/cuerpo/caption/mono), escala de espaciado consistente (4/8), radios unificados, y **3 niveles de elevación** (fondo → superficie → superficie elevada) con sombras sutiles y/o bordes con gradiente — que las jerarquías se lean sin pensar.
2. **Color semántico**: mantén el violeta como identidad, pero define estados completos (hover/active/focus/disabled) y fondos tintados por severidad (ok/warn/err/info) coherentes en chips, alertas, hallazgos y diagnósticos — hoy cada sitio lo improvisa parecido pero no igual. Verifica **contraste WCAG AA** en todos los pares texto/fondo.
3. **Movimiento**: sistema único de transiciones (150–250 ms, ease-out) para hover, apertura de drawer/modales (slide+fade), acordeones y cambios de estado. Respeta `prefers-reduced-motion`.
4. **Primitivas** (`ui.tsx`): rediseña Button (jerarquía clara primario/secundario/ghost/peligro), inputs con estados de foco visibles y validación inline, Modal con animación, Tabs con indicador animado, tooltips accesibles, y añade **Skeleton** para sustituir spinners en listas/tarjetas.

## Mejoras de UX concretas (fase 2 — checklist)

- **Paleta de comandos (⌘K / Ctrl+K)**: saltar a proyecto/servicio, acciones rápidas (desplegar, ver alertas, ajustes). Es la mejora de usabilidad estrella en herramientas dev.
- **Atajos**: `g p` proyectos, `g s` seguridad, `g a` alertas, `Esc` cierra drawer/modales, `?` muestra ayuda de atajos.
- **Skeletons** en dashboard, canvas, listas de despliegues/alertas (nada de spinners a pantalla completa).
- **Estados vacíos con propósito**: ilustración ligera (SVG inline propio), explicación de una frase y CTA directo.
- **LogViewer pro**: búsqueda/filtrado inline, toggle de wrap, saltar a inicio/fin, colorear niveles (error/warn) por heurística, botón copiar. Mantén el autoscroll inteligente que ya existe.
- **Drawer**: redimensionable o al menos 2 anchos, y **responsive**: por debajo de 900px pasa a pantalla completa con transición; el canvas a 1 columna; topbar colapsa stats.
- **Formularios (ServiceSettingsTab)**: agrupa en secciones con jerarquía visual real, sticky del botón Guardar con indicador de cambios sin guardar ("tienes cambios sin guardar"), y estados de error inline.
- **Feedback optimista**: toasts rediseñados (con icono de severidad, acción opcional tipo "Deshacer"/"Desplegar ahora", apilado máx 3), botones con estado de éxito momentáneo (check) tras guardar.
- **Jerarquía de estados unificada**: un único componente StatusBadge (estado + réplicas + pulso en transitorios) usado en tarjetas, drawer, listas — hoy hay 3 variantes artesanales.
- **Accesibilidad**: focus ring visible en TODO elemento interactivo, roles/aria en tabs/modales/menús, orden de tabulación lógico, contraste AA verificado.
- **Gráficas** (MetricChart): mantén la lógica SVG; mejora ejes/rejilla/tooltip con el nuevo sistema. Si tienes disponible una skill de dataviz, cárgala antes de tocarlas y valida la paleta sobre la superficie oscura nueva.

## Método de trabajo (obligatorio)

1. Lee `README.md` y navega el código listado arriba antes de escribir nada.
2. Trabaja por fases: **tokens → primitivas → Layout/Dashboard → Project+drawer → pestañas → páginas restantes**. Commit al final de cada fase con la app compilando.
3. Tras cada fase: `npm run typecheck && npm run build` en verde, y **verifica visualmente**: arranca el server (`DATA_DIR=./data-dev PORT=4100 node server/dist/index.js` tras compilar) y captura pantallas con Playwright (Chromium está preinstalado; hay patrones de script en la historia del repo) — mira las capturas y corrige lo que desentone ANTES de seguir. El criterio es tu propio ojo sobre el resultado real, no el código.
4. No cambies textos en español salvo para mejorarlos; no renombres rutas ni props públicas de componentes salvo necesidad clara.
5. Al terminar: sube la versión menor en los package.json, actualiza el README si cambia algo de cara al usuario, commit y push a la rama actual.

## Criterios de aceptación

- Cero regresiones funcionales (todos los flujos: login, crear proyecto/servicio, desplegar, variables, dominios, backups, alertas, seguridad, importar de Railway).
- La app se siente **de otra categoría**: jerarquía visual clara, movimiento sutil y consistente, cero saltos de layout al cargar.
- Usable con teclado de punta a punta; paleta de comandos operativa.
- Responsive digno hasta ~700px de ancho.
- Bundle final < 150 KB gzip de JS.
- Capturas finales de: dashboard, proyecto con drawer abierto (despliegues con logs), seguridad, alertas, ajustes, y móvil (~800px).
