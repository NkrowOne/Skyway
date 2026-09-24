# Auditoría de rendimiento y calidad del código — Skyway v0.33.0 (24-09-2026)

Revisión extensa del servidor (`server/`) y del panel (`web/`) con dos objetivos:
encontrar dónde se gasta tiempo, memoria y llamadas a Docker sin necesidad, y
dejar el código más fácil de mantener. Lo aplicado va en la PR #37 junto con
esta auditoría; lo que no se ha tocado queda en el §5 con su razón y su coste
estimado, para decidirlo con criterio y no de pasada.

Complementa a [AUDITORIA.md](AUDITORIA.md) (seguridad) y a
[AUDITORIA-FACTURACION.md](AUDITORIA-FACTURACION.md) (clientes y facturación).
El detalle de cada módulo está en [FUNCIONALIDAD.md](FUNCIONALIDAD.md).

## 0. Resumen

- **Lo que más pesaba**: `stats` de Docker. El daemon tardaba ~1 s por
  contenedor porque cada consulta le pedía dos muestras separadas un segundo.
  Con treinta contenedores y ocho consultas a la vez, cada muestreo completo
  rondaba los 4 s, y el panel, el monitor y el stream de métricas viven de ese
  muestreo. Ahora se pide en modo `one-shot` (contesta al instante) y la CPU se
  calcula restando la lectura anterior: el mismo criterio que `docker stats`.
- **En la web**, cada foto del stream (2,5 s) repintaba la página del proyecto
  entera, las N tarjetas y el drawer con su pestaña abierta, y el stream seguía
  vivo con la pestaña del navegador oculta. Ahora la foto vive fuera del estado
  de React y cada pieza se suscribe a lo suyo; el stream se cierra al ocultar
  la pestaña y se reabre al volver.
- **Robustez**: `docker system df` sin tope podía parar el monitor entero para
  siempre, y un `df` fallido escribía «0 bytes» en el histórico y hacía oscilar
  las alertas de disco (con aviso por Discord o correo cada cinco minutos).
- **Seguridad**: el comando pre-deploy ejecutaba la CLI de `docker` con las
  variables del servicio como entorno del proceso de Skyway: una variable
  llamada `PATH`, `LD_PRELOAD` o `DOCKER_HOST` cambiaba qué binario se ejecuta
  con el socket de Docker en la mano. Corregido y con prueba.
- **Sin regresiones**: `npm run typecheck`, `npm run lint`, `npm test` y
  `npm run build` en verde. Pruebas: de 192 a 205 en el servidor y de 27 a 31
  en la web, todas para lo puro (fórmula de CPU, almacén de métricas en vivo,
  partición del entorno pre-deploy, confinamiento de rutas).

## 1. Alcance y método

- Se leyó el código completo de `server/src` (≈32.000 líneas) y de `web/src`
  (≈27.000), repartido en cuatro revisiones independientes: bucles de fondo y
  base de datos; capa HTTP y pipeline de despliegue; panel React; y calidad de
  los módulos de dominio (despliegue, plantillas, correo, PDF, IA, Railway,
  GitHub). Cada hallazgo se verificó leyendo el código antes de contarlo.
- Lo cuantificable se midió: el coste de `prepare()` de better-sqlite3 con un
  banco de pruebas en memoria (200.000 iteraciones), y los tamaños del bundle
  con `vite build`. Lo que depende de un daemon de Docker real (el tiempo de
  `stats`) no se ha podido medir en el entorno de la auditoría: la cifra de
  «~1 s por contenedor» sale del comportamiento documentado del daemon y de los
  comentarios del propio código, que ya la habían medido.
- Cada cambio se hizo con el diff mínimo que resuelve el problema, sin tocar
  la API pública salvo donde se indica, y se validó con la CI del repositorio.

## 2. Estado de partida

**Verificación** (rama `main` en 76ba86d): 192 pruebas de servidor, 27 de web,
typecheck, lint y build en verde.

**Bundle de la web** (`vite build`): 76 ficheros JS, `vendor` 205,7 kB,
`index` 104,3 kB (36,2 kB gzip), `Workspace` 75,5 kB, CSS 67,8 kB. Carga
diferida por ruta ya presente (18 páginas con `lazy()`), y dentro del drawer
del servicio por pestaña.

**SQLite**: WAL, `synchronous=NORMAL`, `busy_timeout` 5 s, caché de 64 MB,
`mmap` de 256 MB, `foreign_keys` activas. 26 índices (todos los predicados
calientes cubiertos, salvo `usage_events(ts)` para la poda diaria). Retención:
disponibilidad 92 días, consumo y contadores 90 días, alertas resueltas 90
días; **despliegues y auditoría sin retención** (§5.1).

**Bucles de fondo** (todos con guarda contra solape, temporizadores con
`unref()` y parada ordenada al apagar):

| Bucle | Periodo | Qué hace |
|---|---|---|
| Monitor | 30 s | foto de Docker con consumo, alertas, muestras de disponibilidad y consumo; cada 10 ticks la ronda de disco (`docker system df`); poda diaria |
| Planificador | 10 min | backups programados, facturación automática, precios de IA |
| Auto-deploy | 60 s (mín. 15) | cabeza de la rama por API con ETag o `git ls-remote`, 4 a la vez |
| Stream de métricas | 2,5 s por pestaña | foto compartida con consumo (`wait`), servicios del proyecto, host |
| Log de despliegue | 3 s por despliegue | volcado del log acumulado a SQLite |
| SSE | 15 s por canal | `:ping` de mantenimiento |

**Sondeo del panel** (react-query; todos se pausan con la pestaña oculta):
`/projects` 8 s, `/projects/:id` 4 s (20 s con el stream vivo), `/services/:id`
8 s, `/monitor/overview` 6 s, `/websites` 8 s, `/alerts` 15 s, `/system` 30 s,
despliegues 3 s mientras hay uno activo. Presupuesto típico con un proyecto
abierto y su drawer: ~20 peticiones/min.

**Coste medido de `prepare()`** (better-sqlite3 11.10, SQLite 3.49, en memoria):

| Consulta | `prepare` en cada llamada | Sentencia cacheada |
|---|---|---|
| `SELECT … WHERE id = ?` | 12,9 µs | 2,9 µs |
| `SELECT … WHERE project_id = ? ORDER BY …` (10 filas) | 40,5 µs | 27,9 µs |

## 3. Hallazgos y cambios aplicados

### 3.1 Docker: `stats` en modo `one-shot` (`docker/cpu.ts`, `docker/containers.ts`)

Docker expone la CPU como contadores acumulados. Sin `one-shot`, el daemon toma
dos muestras separadas un segundo para poder restar, y eso convertía cada
muestreo completo del servidor en «un segundo por contenedor». Ahora:

- `stats` se pide con `one-shot: true` y contesta al instante.
- El porcentaje se calcula restando la lectura anterior del mismo contenedor
  (por nombre e id: un contenedor recreado no comparte contadores). El
  intervalo real entre muestreos (2,5–30 s) da una media más estable que un
  segundo suelto.
- La primera lectura de cada contenedor —o de uno recreado, o con los
  contadores a cero— sigue pidiendo las dos muestras para no inventar el valor.
  Solo ocurre una vez por contenedor y proceso.
- Las líneas base de contenedores que dejan de muestrearse se olvidan a los
  10 minutos.

Efecto esperado con 30 contenedores y 8 consultas a la vez: de ~4 s por
muestreo completo a unas décimas de segundo; el stream de métricas, el monitor
y la vista de Monitor comparten ese muestreo. Pruebas en `test/cpu.test.ts`.

### 3.2 Base de datos: caché de sentencias preparadas (`db.ts`)

Los 239 sitios que hacían `db.prepare(sql)` en cada llamada compilaban el SQL
cada vez. Ahora pasan por `stmt(sql)`, que memoriza la sentencia (tope de 1000
entradas por las listas `IN (?,…)` de tamaño variable) y se vacía al abrir y
cerrar la base. Ninguna sentencia usa modos con estado (`pluck`, `raw`,
`iterate`), así que compartirlas es seguro. Ahorro: ~10 µs por consulta; en un
tick del monitor con 40 servicios (~150 consultas) son ~1,5 ms; en una petición
del panel general, ~0,3 ms. Modesto, pero gratis y uniforme.

### 3.3 Consultas N+1 eliminadas

| Dónde | Antes | Ahora |
|---|---|---|
| muestreador (`sampler.collect`) | `listServices` por proyecto en cada muestreo | `listServicesForProjects` |
| monitor (`tick`) | `listDeployments(id, 1)` por servicio y tick | `latestDeploymentsByService` (una consulta) |
| planificador, disco, auto-deploy | `listServices` por proyecto | `listServicesForProjects` |
| Monitor y Sitios | `openAlertCountsByService` por proyecto en cada sondeo | `openAlertCountsByServiceForProjects` (por lotes) |
| acceso de miembros | `userHasProject` por proyecto en cada sondeo (panel, Sitios, Monitor, asistente) | `accessibleProjectRows`: las asignaciones se leen una vez |
| poda diaria de `usage_events` | barrido completo | índice `idx_usage_events_ts` |

### 3.4 `docker system df` (`disk.ts`, `routes/monitor.ts`, `routes/system.ts`)

- **Tope de 2 minutos** con `AbortSignal`: sin él, una llamada colgada dejaba
  la ronda de disco —y con ella el tick del monitor, que la esperaba— parada
  para siempre. El tick además ejecuta la ronda con su propio tope (3 min) y
  sin solaparla consigo misma.
- **Un `df` fallido ya no vale cero**: antes se cacheaban 60 s de ceros, el
  monitor los escribía en el histórico de disco y daba por resueltas las
  alertas de cuota, que volvían a saltar (y a avisar) cinco minutos después.
  Ahora la recogida falla, se conserva la foto anterior y la ronda se salta.
- **Los totales de Docker** (imágenes, contenedores, volúmenes, caché) salen
  del mismo `df` cacheado: `/api/monitor/disk` (admin) y
  `/api/system/docker-usage` lanzaban cada uno un segundo `df` sin tope por
  petición.
- Con un driver de log sin fichero se deja de pedir un `inspect` por
  contenedor en cada ronda.

### 3.5 Monitor (`monitor.ts`)

- **Una transacción por tick**: cada servicio escribía su muestra de
  disponibilidad y la de consumo como confirmaciones sueltas (con 40 servicios,
  80 cada 30 s). El bucle es síncrono, así que va entero en `transaction()`.
- **La misma foto no cuenta dos veces**: un muestreo lento devuelve la foto
  cacheada, y el stream puede renovarla justo antes del tick; se evalúan las
  alertas igual, pero la telemetría solo se escribe con una foto nueva.

### 3.6 Muestreador (`docker/sampler.ts`)

- **Abortar al vencer**: el tope de 8 s por consulta resolvía con un hueco,
  pero la petición seguía viva en el socket hasta los 30 s del cliente, y el
  pool (8) arrancaba otras encima justo cuando el daemon iba lento. Ahora se
  aborta con `AbortSignal` (también en `getRuntime`/`getStats`).
- **Invalidar un servicio no tira la foto**: desplegar incrementaba la época y
  descartaba cualquier muestreo en marcha; en una racha de despliegues el panel
  se quedaba sin foto fresca y Docker muestreando sin parar. Ahora el servicio
  se marca y, si un muestreo que empezó antes termina después, ese servicio se
  repara otra vez; el resto de la foto se conserva.
- `withTimeout` y `pooled` estaban copiados en tres módulos; viven en `util.ts`.

### 3.7 Planificador (`scheduler.ts`)

El `exec` del volcado va por el cliente de Docker sin tope: un contenedor
colgado dejaba el ciclo entero (backups, facturación, corte por impago) parado
hasta reiniciar. Cada volcado programado tiene ahora un plazo de 12 minutos
(`withDeadline`), tras el cual se da por fallido con su alerta.

### 3.8 Capa HTTP

- `os.cpus()` construía la lista de núcleos en cada tick del stream (2,5 s por
  pestaña) y en cada `/api/system`; ahora es una constante del módulo.
- `GET /api/help/issues` recorre hasta 60 servicios sin límite de peticiones;
  lleva el mismo `rateLimit` que `/ask`.
- `routes/workspaces.ts` usaba el `scrypt` síncrono (~50 ms bloqueando el
  bucle) donde el resto de rutas ya usan la versión asíncrona.

### 3.9 Seguridad: entorno del comando pre-deploy (`deploy/predeployenv.ts`)

`runPreDeploy` lanzaba la CLI de `docker` con `{ ...process.env, ...variables }`
y reenviaba cada clave con `--env CLAVE` (la CLI la lee de su propio entorno).
Un miembro del proyecto podía definir `PATH`, `LD_PRELOAD`, `DOCKER_HOST`,
`DOCKER_CONFIG` o `GIT_SSH_COMMAND` y elegir qué binario ejecuta Skyway, con el
socket de Docker montado. Ahora las claves reservadas van como
`--env CLAVE=VALOR` (el contenedor las recibe igual; el proceso de Skyway
nunca) y el resto sigue como antes. Prueba en `test/predeployenv.test.ts`. El
mismo comando tiene ya un tope de 30 minutos, como el clon, el build y el pull.

También: `rootDir` se confinaba con un `startsWith` sin separador (tres copias,
dos incorrectas) y `dockerfilePath` no se confinaba al contexto del build;
`paths.ts` (`insideDir`) lo resuelve en los dos sitios, con prueba.

### 3.10 Pipeline de despliegue (`deploy/deployer.ts`)

El log de un build se volcaba entero a SQLite cada 3 s **y** cada 8 kB de
salida: un build parlanchín de 400 kB reescribía ~50 veces una fila de
~200 kB. El disparador por bytes está ahora limitado a una vez por segundo; el
temporizador y el volcado final no cambian.

### 3.11 Pasarela de IA (`routes/aigateway.ts`)

Al desconectarse el cliente a mitad de una respuesta en streaming, Skyway
seguía leyendo la respuesta de Gemini hasta el final (hasta 300 s) y esos
tokens se facturaban al workspace; además se escribía en el socket sin mirar
si admitía más. Ahora la petición se aborta al cerrarse la respuesta y se
respeta la contrapresión (`drain`).

### 3.12 Panel (`web/`)

- **Almacén de métricas en vivo** (`livemetrics.ts`): la foto del stream vive
  fuera del estado de React con `useSyncExternalStore`. Las tarjetas se
  suscriben a su servicio, la cabecera del drawer a su estado y réplicas, la
  pestaña Métricas a la foto entera. Al publicar se conserva la identidad de
  las entradas que no cambian: un servicio parado no vuelve a pintar nada, y el
  drawer con una consulta de 500 filas o el listado de archivos abierto ya no
  se repinta cada 2,5 s. Prueba en `test/livemetrics.test.ts`.
- **Stream cerrado con la pestaña oculta** (`pages/Project.tsx`): el sondeo de
  react-query se pausaba solo, pero el SSE seguía vivo y cada pestaña de
  proyecto en segundo plano mantenía al servidor muestreando Docker cada 2,5 s.
  Se cierra al ocultarse y se reabre al volver. El ritmo del sondeo de respaldo
  se lee de una ref en vez de un estado espejo.
- **Consola de despliegue congelada** (bug real, `DeploymentsTab.tsx`): tras
  una reconexión del `EventSource`, el manejador de `snapshot` cancelaba el
  `requestAnimationFrame` sin poner `raf = 0`, y las líneas nuevas no volvían a
  pintarse hasta el `done`.
- **Riesgo de pérdida de variables** (`VariablesTab.tsx`,
  `SharedVarsModal.tsx`): si la carga fallaba, el editor aparecía vacío y
  «Guardar» enviaba un conjunto vacío que sustituía las variables reales. Ahora
  se muestra el error con reintento y no se puede guardar sin datos.
- **Sondeos**: Monitor pedía `/monitor/overview` cada 6 s también en las
  vistas Servidor y Espacio (que solo usan `host.*`), y cada sondeo forzaba un
  muestreo con consumo; ahora 30 s fuera de la tabla de servicios. `/system`
  se sondea cada 120 s cuando la píldora CPU/RAM está oculta (< 1100 px).
- **Gráficas**: `HistoryChart` reserializaba todos los trazados SVG en cada
  movimiento del puntero; los trazados se memorizan por tramo. En Monitor, los
  formateadores y umbrales de las tres gráficas del host eran objetos nuevos en
  cada render y anulaban su `memo` diez veces por minuto.
- **Bundle**: los iconos de `lucide-react` compartidos por varias páginas
  diferidas salían como ~33 microchunks de 300–1000 bytes (una petición cada
  uno, relevante por un túnel SSH en HTTP/1.1); van en un chunk `icons`. De 76
  a 46 ficheros JS; `index` baja de 104,3 a 90,1 kB (32,5 kB gzip) y el chunk
  `icons` pesa 47,9 kB (9,0 kB gzip), cacheado entre despliegues. La primera
  carga hace una petición más y pesa unos 6 kB gzip más; a cambio, hasta 30
  peticiones menos por sesión. El chunk de la ruta probable (panel o proyecto)
  se precarga mientras se resuelve `/auth/me`, quitando un viaje de la cascada
  de arranque.

## 4. Lo que estaba bien (para no volver a mirarlo)

- Todos los mapas de larga vida se podan (monitor, contadores de red,
  auto-deploy, ETags, líneas base de CPU, canales SSE, limitadores).
- Ningún `execSync`/`spawnSync` en `server/src`; el `fs` síncrono se limita al
  arranque y a listados pequeños.
- zod en toda ruta con cuerpo; `requireAuth` por plugin; webhooks con HMAC.
- SSE con contrapresión (pausa/reanuda el stream de Docker), limpieza al
  cerrar y cierre ordenado al apagar.
- Claves de react-query sin duplicados; sin `import * as` de iconos; SVG de
  logos inlinados en build; tipografía con `unicode-range`.
- Aritmética de facturación en céntimos enteros con un único redondeo; PDF con
  offsets reales; correo con dot-stuffing y RFC 2047/2231 correctos.

## 5. Pendiente (no aplicado en esta PR), por prioridad

Cada punto lleva por qué no se ha hecho aquí y una estimación de esfuerzo.

### 5.1 Datos que crecen sin límite

- **`deployments` guarda `logs` (≤400 kB) y `runtime_logs` (≤256 kB) en la
  misma fila y nunca se borra**: 20 servicios × 3 despliegues/día ≈ 12–36 MB al
  día, es decir, varios GB al año de `skyway.db`, con el coste asociado en la
  copia diaria (`VACUUM INTO`, síncrona) y en el `integrity_check` del arranque.
  Propuesta: tabla `deployment_logs` aparte y retención (p. ej. últimos 50 por
  servicio o 90 días). Es una migración de esquema y una política de borrado:
  decisión de producto. Esfuerzo: medio.
- **`audit_log` sin retención**, incluidos los `login_failed` de un ataque de
  fuerza bruta. Propuesta: 90 días para `login_failed`, 365 para el resto,
  dentro de la poda diaria. Esfuerzo: bajo; decisión de producto (obligaciones
  de conservación).
- **`VACUUM INTO` y `integrity_check` bloquean el proceso**: segundos con una
  base grande, una vez al día y en cada arranque (el panel no escucha hasta
  terminar). better-sqlite3 ofrece `db.backup()` asíncrono por lotes de
  páginas; `quick_check` o comprobar después de `listen`. Esfuerzo: bajo.

### 5.2 Rutas lentas o pesadas

- **`DELETE` de proyecto y de servicio paran y borran contenedores en serie**
  dentro de la petición (10 s de gracia por contenedor): con réplicas, minutos
  antes de responder, y el navegador o el proxy pueden cortar antes. Propuesta:
  pool de 4–8 con `Promise.allSettled` o responder 202 y terminar en segundo
  plano. Es una ruta destructiva: mejor con su propia PR y pruebas. Esfuerzo:
  medio.
- **Descargas de logs completos** (`/logs/download`) cargan en memoria hasta
  30 MB y los desmultiplexan de forma síncrona (cientos de ms sin atender a
  nadie). Propuesta: `Transform` en streaming reutilizando el patrón de
  `followLogs`. Esfuerzo: medio.
- **`GET /api/projects` transporta la `config` completa** de cada servicio
  cada 8 s cuando el panel solo usa nombre, tipo e icono. Trimarla cambia la
  respuesta de una ruta documentada para agentes (`CONTROL-REMOTO.md`), así que
  requiere decidir el contrato (p. ej. `?summary=1`). Esfuerzo: bajo.
- **Listados de administración con una consulta por fila** (`/workspaces`,
  `/users`, `/products`, `/plans`): impacto bajo (páginas de admin);
  `GROUP BY` por lotes. Esfuerzo: bajo.
- **`/help/issues`** resuelve el entorno de cada servicio con sus hermanos
  (hasta ~720 consultas puntuales por apertura): memorizar por proyecto.
  Esfuerzo: bajo.
- **Búsqueda de despliegues por lista truncada**: `previousBuilder` mira los
  últimos 25 despliegues y `cleanupOldImages` los últimos 50; tras esa racha
  de fallos consecutivos pueden cambiar de builder o purgar etiquetas que aún
  sirven para rollback. Propuesta: consultas dirigidas
  (`lastSuccessfulDeployment`, `recentSuccessfulImageTags`). Esfuerzo: bajo.

### 5.3 Mantenibilidad

- El prólogo «cargar servicio → 404 → comprobar acceso → 403» está copiado
  ~43 veces (siete helpers locales idénticos); un `requireServiceAccess` en
  `auth.ts` los sustituye. Ya hay una divergencia (`help.ts` contesta 404
  donde el resto 403). Esfuerzo: medio (diff grande, riesgo bajo).
- El mapeo de errores de Docker/GitHub a códigos HTTP es distinto en cada
  ruta (400, 500 o 503 para el mismo socket caído). Dar `statusCode` a
  `GithubError`/`BillingError` y un `dockerErrorReply` común. Esfuerzo: bajo.
- Duplicados con reglas divergentes: descubrimiento y parseo de `.env`
  (`envimport.ts` frente a `needs.ts`: distinta lista de ficheros y parser, y
  por tanto «variables esperadas» que no coinciden con las importadas);
  `requireRunning` ×3 con tres mensajes; regex `HOSTNAME` copiada en
  `railway/importer.ts`; cuatro copias de «spawn + salida + tope», dos de
  ellas escuchando `exit` en vez de `close` (pueden perder el SHA);
  `resolveGitPort` escribe una `config` leída antes de un build de minutos
  (pierde lo guardado desde el panel mientras tanto). Esfuerzo: bajo cada uno.
- `datamigrate` hace `docker pull` sin tope, sin `assertImageRef` y fuera del
  registro de cancelación; `stackdeploy` deja un despliegue en verde si falla
  el post-init (sin `finished_at`, sin evento `done`, sin alerta). Esfuerzo:
  bajo; conviene probarlo con una pila real.
- Tipos: `ServiceRow.config` como unión discriminada por `type` quitaría 31
  casts; `parseRepoConfig` debería fusionar con `EMPTY`. Código muerto:
  `filesSupported`, `listAppInstallations`, `forgetHeadCache`, un mensaje de
  `diagnose.ts` que nadie produce.
- Pruebas: sin ninguna en `deployer`, `builder`, `railwayconfig`, `diagnose`,
  `queue`, `stackdeploy`, `stacks`, `templates`, `needs`, `datamigrate`,
  `mailer`, `invoicepdf`, `aiprices`, `aigateway`. Candidatos puros y baratos:
  `explainExitCode`, `parseToml`, `buildKeyFor`, `declaredArgs`, `renderStackEnv`,
  `parsePricingHtml`, `renderInvoicePdf`, `construirMime`.

### 5.4 Web

- `Workspace.tsx` (75 kB) carga cinco pestañas y seis modales aunque se vea
  una; `lazy()` por pestaña. Esfuerzo: bajo.
- La página de alertas pide `/alerts` dos veces cada 15 s (lista y campana con
  parámetros distintos). Esfuerzo: bajo.
- `CommandPalette` (⌘K) vive en `Layout.tsx` y arrastra los 19 logos SVG (~30
  kB) al chunk inicial; extraerla a su fichero y cargarla en la primera
  apertura con `useLatch`. Esfuerzo: bajo.

### 5.5 Autorización y auditoría (informativo)

- `DELETE /api/services/:id?volumes=true`, crear pilas y `deploy-all` pasan
  con `assertProjectAccess` (cualquier miembro), mientras renombrar o borrar el
  proyecto exigen `assertProjectManage`. Si borrar un servicio con sus
  volúmenes se considera «estructura», debería alinearse.
- `PATCH /api/services/:id` audita solo el nombre aunque cambie dominios,
  puertos o réplicas; `PUT /api/settings` audita sin detalle; marcar leídas o
  resolver alertas no se audita.

## 6. Cómo verificar y cómo medir en producción

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

- **Muestreo de Docker**: con `LOG_LEVEL=debug` no hay traza específica; la
  forma directa es cronometrar `GET /api/monitor/overview` con muchos
  servicios (antes ~1 s por contenedor entre 8; ahora decenas de ms).
- **Tamaño de la base**: `ls -l /data/skyway.db*` y
  `SELECT COUNT(*), SUM(LENGTH(logs)+LENGTH(runtime_logs)) FROM deployments;`
  para decidir la retención del §5.1.
- **Bundle**: `npm run build -w web` imprime cada chunk con su gzip.
- **Repintados en el panel**: React DevTools → Profiler con la página de un
  proyecto abierta: tras este cambio, un tick del stream solo repinta las
  tarjetas cuyo servicio cambió y el resumen de la cabecera.
