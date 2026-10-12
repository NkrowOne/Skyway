# Skyway — Referencia de funcionalidad completa

> Documento de referencia único y exhaustivo, pensado para ser **consultado por
> un LLM** (o por una persona). Describe qué hace Skyway, cómo está organizado el
> código, el modelo de datos, el modelo de seguridad y **toda la API REST**.
>
> Skyway es una plataforma de despliegue auto-alojada estilo Railway: despliega
> repos de GitHub y bases de datos sobre Docker, en un único servidor, con panel
> web, métricas en vivo, dominios con TLS, backups y alertas.
>
> Versión de este documento: 0.40.0. Si el código y este documento discrepan,
> gana el código (`server/src/`).

---

## 1. Mapa del código

```
server/src/
  index.ts              arranque: initDb, red edge, monitor, scheduler, auto-deploy, listen
  app.ts                ensamblado Fastify: cabeceras de seguridad, rutas, SPA
  config.ts             configuración por entorno (puertos, dirs, trustProxy)
  db.ts                 esquema y acceso SQLite (better-sqlite3, WAL)
  types.ts              tipos compartidos (filas, configs de servicio…)
  util.ts               id/token/slug, hashPassword (scrypt), hmac, safeEqual
  auth.ts               sesiones JWT (cookie httpOnly), tokens API, roles, rate-limit
  apitokens.ts          emisión de tokens de API `sky_…` (`emitirTokenApi`): la comparten Mi perfil y `tools/token.ts`
  audit.ts              registro de auditoría (actor, acción, IP)
  modules.ts            catálogo de módulos (capacidades que un plan/workspace activa)
  quota.ts              cuota efectiva, asignación agregada de recursos y módulos por workspace
  company.ts            perfil fiscal de la empresa emisora + claves de Stripe (en settings)
  stripe.ts             cliente mínimo de Stripe (Checkout Session + verificación de firma de webhook)
  mailway.ts            cliente de la API de integraciones de Mailway (correo): configuración en settings,
                        dirección interna del panel si lo despliega Skyway, token de gestión `mwt_…` (Bearer),
                        proyecto de Mailway en Skyway, hosts reservados de la instancia (actuales y anteriores), referencias
                        externas (`clientRefFor`: la de la cuenta o la del proyecto; `acceptedClientRefs`), marca blanca
                        (webmail con el dominio del cliente), webmail automático del cliente, enlaces de
                        bienvenida, cambio de dominio del correo (API de Mailway `/api/domain-migrations`) y fichero de
                        zona (`stripWebRecords` retira los registros web del dominio raíz y de www; `appendWebRecords`
                        añade los de los servicios del proyecto y el del webmail)
  mailwaycuentas.ts     un cliente de Mailway por cuenta: migración de los vínculos de antes (perezosa al abrir
                        el correo y al arrancar, `migrarVinculosACuentas`) y nombre del cliente igual al de la
                        cuenta (`alinearNombreCliente`, `sincronizarNombreCuenta`)
  mailwayconfig.ts      probar y guardar la conexión con Mailway (`probarConexionMailway`, `guardarConfigMailway`):
                        validación de la URL, del token y del servicio del panel, y auditoría; la comparten
                        Ajustes → Correo (Mailway) y la herramienta de terminal `tools/mailway.ts`
  mailconnect.ts        correo visto desde un servicio: cliente vinculado del proyecto (`ownedSummary`), nombres
                        con los que el servicio recibe el correo (`mailConnectNames`) y alta de la credencial
                        (`connectServiceMail`); lo comparten «Conectar a un servicio» y el plan de integraciones.
                        Turno por servicio de los cambios de su credencial (`withMailCredentialLock`), que también
                        respeta la renovación automática
  mailwayrenovacion.ts  renovación automática de las contraseñas de aplicación que Mailway invalida al cambiar
                        de motor: nueva contraseña, variables, nuevo despliegue y revocación de la invalidada
                        (pasada del planificador y al abrir el correo del proyecto quien lo gestiona)
  mailenv.ts            tabla de alias de las variables de correo (`SMTP_PASSWORD`, `MAIL_PASSWORD`,
                        `EMAIL_HOST_PASSWORD`… → papel) y su valor por papel
  managedenv.ts         cuándo puede Skyway escribir una variable: nunca si alguien la ha puesto a mano
  manifest.ts           esquema estricto (zod) del manifiesto `skyway.json` (docs/MANIFIESTO.md)
  integrations.ts       plan de integraciones de una web (manifiesto o detección): construcción sin efectos,
                        aplicación con aprobación y reconciliación en cada despliegue
  mailwaytraefik.ts     puente de Traefik para Mailway: lee sus rutas, las sanea (solo Host() hacia
                        contenedores de Mailway, sin dominios de Skyway) y guarda la última buena; con la
                        misma cadencia, la lista de nombres de marca blanca de toda la instancia en
                        cualquier estado (`mailwayWhitelabelHosts`, última buena si Mailway no responde)
  domainguard.ts        qué dominios puede asignarse un servicio: únicos en el servidor, nunca el del
                        panel (`SKYWAY_DOMAIN`) ni, fuera del proyecto de Mailway, los de Mailway (también
                        los nombres de marca blanca que esperan DNS) ni los que redirigen o se prepublican
                        en un cambio de dominio de otro proyecto; y qué nombre puede ser el webmail
                        de un cliente (`webmailHostError`: ni de un servicio ni del panel)
  domainmigration.ts    asistente «Cambiar de dominio» de un proyecto (§6.1): plan, preparar, comprobar,
                        pasar, volver, cancelar, dar de baja y terminar, con el correo en Mailway
  envreplace.ts         sustitución de variables del cambio de dominio (módulo puro): mapa exacto de
                        hosts y direcciones, huella del plan y bloque de URL de WordPress
  redirecciones.ts      prepublicación y redirecciones del cambio de dominio en el proveedor HTTP de
                        Traefik (prioridad 1) y comprobación local del certificado (`comprobarTlsLocal`)
  pricing.ts            cálculo de precios por tramos (graduated/volume) del catálogo
  aigateway.ts          gateway de IA: config (clave de Gemini del operador, modelos), medición de tokens,
                        streaming SSE, API compatible con OpenAI y coste/margen por modelo
  aiprices.ts           autoactualización de la tarifa de Gemini: lee la tarifa vigente (fuente propia,
                        página de Google o catálogo interno), la convierte a la moneda del operador y
                        refresca `ai_model_prices` conservando el margen de cada modelo
  billingauto.ts        automatización: corte por impago (dunning), reactivación y factura automática del ciclo
  billingsettings.ts    ajustes de automatización (auto-generar/auto-emitir el ciclo, umbrales de morosidad)
  security.ts           escáner de seguridad (hallazgos + nota)
  variables.ts          resolución de ${{Servicio.VAR}} y ${{shared.VAR}}; variables de sistema (INTERNAL_URL, PUBLIC_URL…)
  needs.ts              detección de dependencias del repo (librerías, schema.prisma, .env.example), del correo
                        (librerías y variables) y del manifiesto `skyway.json`, y propuestas de variables
  templates.ts          plantillas de BBDD (postgres/redis/mysql/mongo/minio) y qué variables de conexión exporta cada una
  stacks.ts             pilas de aplicaciones multi-servicio (Supabase, WordPress, Ghost, n8n, Metabase)
  dbconsole.ts          consola de consultas (psql/mysql/mongosh/redis-cli vía exec)
  files.ts              explorador de archivos por contenedor (tar sobre socket)
  backups.ts            volcado/restauración de BBDD (dump dentro del contenedor)
  sysbackup.ts          snapshots del propio skyway.db (VACUUM INTO + retención)
  disk.ts               uso de disco por servicio y del host
  purge.ts              borrado completo de proyectos y servicios (siempre con sus datos) y «Datos sin
                        proyecto»: regla de volúmenes huérfanos, listado y limpieza (§3.1)
  domains.ts            IP del servidor + verificación DNS de dominios (`clasificarDns`; distingue el proxy
                        de Cloudflare por sus rangos IPv4 publicados)
  dominioprincipal.ts   regla del dominio principal (`ordenarDominios`/`dominioPrincipal`): www primero,
                        el resto en su orden y el subdominio generado al final; y la pareja con o sin www
                        (`parejaWww`, `completarParejasWww`, `limpiarSinPareja`); sin dependencias (§5.5)
  cloudflare.ts         cliente mínimo de la API de Cloudflare (verificar token, zona de un nombre, leer
                        registros, crear uno, borrar uno concreto y quitar el proxy de uno; sin un método
                        general para cambiar), portado del de Mailway
  cloudflareconfig.ts   token de Cloudflare del administrador en `settings` (`cloudflare.token`, nunca se
                        devuelve): probar, guardar, borrar y vista; la comparten Ajustes → Cloudflare y
                        `tools/cloudflare.ts`
  cloudflaredns.ts      DNS automático de los dominios nuevos de servicios, SOLO en peticiones de un
                        administrador: registro A hacia la IP del servidor sin pisar nada, reserva de
                        los nombres creados y su limpieza (§7.13)
  notify.ts             envío a Discord/Telegram/webhook
  alerts.ts             creación/resolución de alertas (con dedupe) + notificación
  metrics.ts            deltas de red por réplica + agrupado del histórico de consumo
  monitor.ts            bucle 30 s: caídas, bucles de reinicio, CPU/RAM, uptime, disco, histórico
  scheduler.ts          bucle 10 min: backups programados de BBDD + snapshot diario del panel + renovación de
                        las contraseñas de aplicación invalidadas por Mailway (`mailwayrenovacion.ts`)
  autodeploy.ts         bucle ~1 min: sondea la cabeza de la rama (API con ETag, o git ls-remote) y despliega si cambió;
                        línea base y última comprobación persistidas (`autodeploy_state`)
  tls.ts                TLS efectivo: ajuste del panel + correo de Let's Encrypt REAL de Traefik (docker inspect)
  paneldomain.ts        dominios del panel (`SKYWAY_DOMAIN`, `SKYWAY_DOMAIN_EXTRA`) y routers de los adicionales
  datamigrate.ts        copia de datos desde una base externa (Railway) a una gestionada, con log en vivo
  events.ts             bus en memoria: logs de despliegue y feed de despliegues del proyecto (SSE)
  sse.ts                utilidad Server-Sent Events
  docker/
    client.ts           instancia dockerode + ping cacheado
    networks.ts         red edge (Traefik) y red privada por proyecto
    containers.ts       crear/arrancar/parar (parada limpia: `pararConGracia`), stats, logs, exec, réplicas, labels
    resources.ts        listar volúmenes y quién los monta; borrar volumen, red e imagen informando
                        del error (409 si están en uso) en vez de callarlo
    sampler.ts          muestreador único de Docker: una foto compartida (bajo demanda, con
                        coalescencia) que consumen panel, streams, monitor y vistas de estado
  deploy/
    builder.ts          clone (git) + build (Dockerfile o Nixpacks), enmascara secretos
    deployer.ts         orquestador: build → intercambio (sin corte o una sola copia) → validación → rollback;
                        identidad por copia y limpieza de restos de intercambios
    estrategia.ts       estrategia de despliegue («Una sola copia» / «Sin corte»), gracia de parada y comando al parar
    queue.ts            cola serializada por servicio + semáforo de builds
    stackdeploy.ts      despliegue por etapas de una pila: espera de arranque + SQL de inicialización
    railwayconfig.ts    lectura de railway.json / railway.toml (config-as-code)
    diagnose.ts         diagnóstico de fallos y explicación de códigos de salida
    envimport.ts        detección e importación del .env / .env.example del repo (con validación)
  help/                 ayuda para clientes: FAQ (faq.ts), reglas sobre logs de la app (runtime.ts)
                        y asistente determinista + detección de errores por servicio (assistant.ts)
  github/client.ts      API de GitHub: validar tokens, listar repos y ramas, cabeza de rama con ETag, leer un fichero del repo
  github/app.ts         GitHub App: alta por manifiesto, tokens de instalación, repos por instalación
  github/resolve.ts     con qué credencial se clona cada servicio (App → conector → token global)
  railway/client.ts     cliente GraphQL de Railway (solo en memoria)
  railway/importer.ts   análisis y ejecución de la importación desde Railway
  routes/               una ruta por área (ver §7 API)
  tools/                herramientas de terminal del servidor, sin red ni sesión (ver §9):
    reset-password.ts   restablecer la contraseña de un usuario (último recurso)
    token.ts            crear (con caducidad) y revocar tokens de API; la usa el instalador de Mailway
    mailway.ts          conectar Mailway como Ajustes → Correo, con el token `mwt_…` por la entrada estándar
    cloudflare.ts       guardar el token de Cloudflare del administrador como Ajustes → Cloudflare, por la entrada estándar
    aviso.ts            enviar un texto por los canales de alertas, como «Enviar notificación de prueba»; la usa `skyway update --auto`
    argumentos.ts       opciones `--clave valor`, mensajes de error y E/S comunes (inyectable en las pruebas)

web/src/
  main.tsx, App.tsx     arranque React + router
  api.ts                cliente fetch (/api, cookies same-origin) + EventSource
  types.ts              tipos del cliente (espejo de server/types)
  utils.ts              formateadores, etiquetas de estado/acción
  hooks.ts              useLocalStorage, useMediaQuery…
  pages/                Dashboard, Proyecto, Monitor, Sitios, Estado, Ajustes, Ayuda…
  components/           canvas de servicios, drawer con pestañas, gráficas
  components/GithubSource.tsx    selector unificado de cuenta de GitHub (App + tokens) y de repo
  components/GithubModal.tsx     conexiones de GitHub del proyecto
  components/GithubAppPanel.tsx  alta y gestión de la GitHub App (Ajustes)
  components/DeployBadge.tsx     señales de «hay una versión saliendo» (cinta y franja)
  components/DataMigrationModal.tsx  copia de datos desde una base externa
  components/MailModal.tsx       correo del proyecto (Mailway): activación, dominios, buzones, conectar servicios
  components/MailwaySettings.tsx conexión con Mailway (Ajustes → Correo)
  components/CloudflareSettings.tsx  token de Cloudflare del administrador (Ajustes → Cloudflare)
  components/DnsAutoResult.tsx   avisos y chips del DNS automático en Cloudflare (servicios, pilas, correo)
  cambioDominio.ts               tipos y llamadas del asistente «Cambiar de dominio»
  components/cambio-dominio/     asistente «Cambiar de dominio» (Qué cambia, Preparar, En transición, Terminado)
  components/tabs/      Despliegues, Consultas, Variables, Backups, Archivos,
                        Métricas, Logs, Ajustes del servicio
```

---

## 2. Arquitectura en ejecución

- **Servidor**: Node 22+/TypeScript/Fastify. Estado en SQLite (`/data/skyway.db`,
  modo WAL). Habla con Docker por `dockerode` + CLI (`docker build/pull`, `git`,
  `nixpacks`).
- **Web**: React + Vite + Tailwind. El servidor sirve la web compilada en
  producción (`web/dist`) con fallback SPA. Logs y métricas por SSE.
- **Docker**: Skyway monta `/var/run/docker.sock` y orquesta los contenedores de
  las apps directamente sobre el Docker del host.
- **Redes Docker**:
  - `skyway-edge`: compartida con Traefik; se conectan aquí los servicios con
    dominio para que Traefik les enrute tráfico.
  - `skyway-<proyecto>`: red privada por proyecto; los servicios se resuelven
    entre sí por su *slug* (`postgres:5432`, `redis:6379`…). Cada servicio
    anuncia la suya en **Ajustes → Dirección interna**, con el puerto ya puesto.
- **Traefik** (en el `docker-compose`): enruta por dominio y emite TLS con
  Let's Encrypt. Se activa por *labels* que Skyway pone en cada contenedor. Con
  TLS configurado, el puerto 80 no sirve contenido: redirige a HTTPS con un 301.
  - **Router con huella** (`traefikRouter` en `docker/containers.ts`): el router
    de un servicio se llama `skyway-<proyecto>-<servicio>-<huella>`, donde la
    huella son 8 caracteres del sha256 de sus hosts (en minúsculas, sin
    repetidos y ordenados); la regla se escribe con ese mismo orden. El
    servicio de Traefik (`skyway-<proyecto>-<servicio>`, explícito en la
    etiqueta `service` del router) y los middlewares (`…-https`, `…-retry`)
    conservan el nombre base. Así, durante un relevo, dos versiones con los
    mismos hosts generan el mismo router (Traefik los fusiona) y dos con hosts
    distintos, routers distintos que conviven: con un nombre fijo, Traefik
    borraba el router definido dos veces de forma distinta y todos los nombres
    del servicio daban 404 mientras convivían las dos versiones.
  - **Proveedor HTTP** (`GET /api/traefik/mailway`, que Traefik lee cada 15 s):
    además de las rutas saneadas de Mailway y los routers de
    `SKYWAY_DOMAIN_EXTRA`, sirve lo propio del cambio de dominio
    (`redirecciones.ts`), sin desplegar nada: la **prepublicación** (el nombre
    nuevo hacia el servicio `@docker` del contenedor en marcha, solo cuando su
    DNS ya apunta aquí, para que el certificado exista antes de pasar) y las
    **redirecciones** del nombre viejo al nuevo (`redirectRegex` que conserva la
    ruta y la consulta; temporal, 302/307, hasta `permanent_from` = pasar + 7
    días, y permanente, 301/308, después, calculado en cada lectura). Todo con
    prioridad 1 y nombres `skyway-…` que Mailway no puede usar. Un nombre lo
    publica, por este orden, **el servicio que lo tenga en sus dominios** (sus
    etiquetas tienen la prioridad por defecto, siempre mayor), **la
    prepublicación** y, solo si no lo reclama ninguno de los dos, **la
    redirección**; un ciclo de redirecciones sin servir se rompe quitando la
    más antigua.

### Muestreo de Docker (docker/sampler.ts)

Todo lo que necesita saber el estado real de los contenedores —la ficha del
proyecto, la del servicio, el stream de métricas de cada pestaña, el monitor, la
vista de Monitor, la página de estado y la de webs— lee de **una sola foto
compartida**, no pregunta a Docker por su cuenta. Importa porque el socket de
Docker atiende en serie: con varios consumidores preguntando en paralelo se
convertía en el cuello de botella y el panel se movía a tirones.

- **Bajo demanda**: no hay temporizador de fondo. Cada consumidor dice cuánta
  antigüedad tolera (2 s el stream de métricas, 4 s las fichas, 5 s las vistas
  de conjunto, 15 s el monitor) y si la foto vigente sirve, se la lleva sin
  tocar Docker.
- **El consumo es opcional** (`{ stats: true }`). Solo lo piden los tres que
  lo miran: el stream de métricas, la vista de Monitor y el vigilante de fondo.
  Las fichas de proyecto y servicio, Sitios y la página de estado solo enseñan
  estados. Hay dos cachés, porque una foto con consumo vale para todo pero una
  sin consumo no vale a quien lo necesita.
- **`stats` en modo `one-shot`** (`docker/cpu.ts`). Sin él, el daemon toma dos
  muestras separadas un segundo para poder calcular la CPU, y ese segundo por
  contenedor era lo que hacía lento cada muestreo (treinta contenedores, unos
  cuatro segundos con ocho consultas a la vez). Con `one-shot` contesta al
  instante con una sola muestra y el porcentaje se calcula restando la lectura
  anterior del mismo contenedor (misma fórmula que `docker stats`, sobre el
  intervalo real entre muestreos). La primera lectura de cada contenedor —y la
  de uno recreado o con los contadores a cero— sigue pidiendo las dos muestras,
  para dar un valor correcto desde el principio.
- **Nunca bloquea con la caché caliente**: si la foto está pasada pero sirve, se
  entrega al instante y el muestreo se lanza por detrás. Solo se espera en el
  arranque en frío y justo después de una acción que invalidó la foto, que es
  cuando el usuario sí quiere el estado recién mirado.
- **Con coalescencia**: las peticiones que llegan mientras hay un muestreo en
  marcha se enganchan a él. Da igual cuántas pestañas haya abiertas.
- **Invalidación explícita**: desplegar, arrancar, parar, reiniciar o borrar
  descarta la foto para que el cambio se vea en la lectura siguiente y no al
  caducar. Con un servicio concreto solo se vuelve a mirar ese servicio y se
  parchea en la foto; un muestreo que arrancó antes de la invalidación se
  guarda igual y ese servicio se repara otra vez por si trajo el estado
  anterior (antes se tiraba la foto entera y, en una racha de despliegues, el
  panel se quedaba sin foto fresca mientras Docker muestreaba sin parar).
- **Un fallo de Docker no es un cambio de estado**: si el daemon no responde por
  una réplica, se marca inalcanzable y el monitor salta ese ciclo en vez de
  disparar una alerta de caída falsa.
- **Con tope de tiempo**: el cliente de Docker se construye sin `timeout` y una
  llamada al socket puede no volver nunca. Cada consulta tiene 8 s y el muestreo
  entero 20 s; al vencer se devuelve una foto vacía marcada como «Docker no
  disponible». Es lo que impide que un solo cuelgue —de un contenedor de un
  proyecto— deje sin panel a todos los demás de forma permanente.
- **Una foto sin datos no se guarda**: si el daemon no respondía, la foto no se
  cachea, para que la lectura siguiente vuelva a intentarlo en cuanto se
  recupere en vez de esperar a que caduque.
- **Una sola verdad por respuesta**: quien pinta varios servicios pide la foto
  una vez y saca de ella tanto los estados como el indicador de «Docker
  disponible». Preguntarlo por separado daba respuestas que se contradecían.

La foto se fecha **al empezar** a muestrear, no al terminar: un muestreo tarda
lo suyo y, fechándolo al final, se serviría como recién hecho y quien pide datos
cada 2,5 s recibiría dos veces la misma lectura.

El stream de métricas, además, **no solapa ciclos**: si uno tarda más que el
intervalo, el siguiente se descarta en lugar de apilarse encima.

### Apagado ordenado (index.ts)

`SIGTERM`/`SIGINT` cierran en orden: primero los streams SSE —que por definición
no terminan solos y dejarían a `fastify.close()` esperando—, luego las
peticiones en vuelo y por último la base de datos, cuyo cierre hace el
*checkpoint* final del WAL. Hay un margen de 10 s tras el cual se sale a la
fuerza. Un rechazo de promesa sin capturar se registra con su traza y el
servidor sigue en pie; una excepción sin capturar se registra como fatal y sale
con código 1, que es lo que permite a Docker levantarlo limpio.

### Pipeline de despliegue (deploy/deployer.ts)

1. `triggerDeploy(serviceId, trigger)` crea una fila `deployments` en estado
   `queued`, **la anuncia en el feed del proyecto** (ver más abajo) y la encola.
   La cola (`queue.ts`) **serializa por servicio** (un deploy a la vez por
   servicio) y limita los builds globales con un semáforo (`BUILD_CONCURRENCY`;
   por defecto, núcleos − 1 acotado a [2, 4]).
2. **Build/obtención de imagen**:
   - `database` → `docker pull` de la imagen de la plantilla. La **versión
     efectiva** (`cfg.version` o el default de la plantilla) decide a la vez el
     tag y la ruta de montaje del volumen: Postgres <18 monta
     `/var/lib/postgresql/data` y 18+ monta `/var/lib/postgresql` (la imagen
     oficial 18+ **se niega a arrancar** con la ruta antigua, aunque el volumen
     esté vacío). Antes de arrancar Postgres se inspecciona el volumen
     (best-effort, con busybox): si contiene datos de otra versión mayor u otro
     layout, el despliegue falla con el remedio concreto en vez de dejar el
     contenedor en bucle de reinicio. Además, en cada despliegue se completan
     las variables de conexión de la plantilla que falten (DATABASE_URL, host,
     credenciales…) sin tocar las existentes, de modo que la URL interna existe
     siempre aunque el servicio venga de una versión antigua o se borraran a
     mano.
   - `image` → `docker pull` de la imagen indicada.
   - `git` → **reutilización de imagen** primero: se consulta la cabeza de la
     rama por la API de GitHub y, si ese commit ya se construyó con éxito y con
     la misma huella de compilación (`build_key`: repo, rootDir, Dockerfile y
     build-args), se reutiliza su imagen sin clonar ni compilar. Es el caso
     normal al redesplegar por un cambio de variables. `force` en el endpoint de
     despliegue (botón «Reconstruir») lo salta.
     Si hay que construir: clone superficial (`--depth 1 --branch --no-tags`) +
     build con **Dockerfile** si existe (BuildKit, con `BUILDKIT_INLINE_CACHE` y
     `--cache-from` de la última imagen correcta; si el plugin buildx faltara,
     se degrada al builder clásico con un aviso en el log), o **Nixpacks** si no.
     La **config-as-code** del repo (`railway.json` / `railway.toml`, ver §5.3)
     manda sobre los ajustes del panel, igual que en Railway. El token para
     clonar se resuelve en `github/resolve.ts` (ver §5.4).
   - rollback → reutiliza una imagen ya construida (`image_tag`), si sigue viva,
     junto con la config-as-code del despliegue que la construyó. Si la imagen
     ya se purgó, `POST /deployments/:id/rollback` responde 409 `image_purged`
     sin crear despliegue ni alerta, y se puede **reconstruir ese commit**
     (`POST /services/:id/deploy {commit}`: clon superficial de la rama y
     `git fetch --depth 1 origin <sha>`, sin reutilizar imagen).
3. **Comando previo** (`deploy.preDeployCommand` de la config-as-code): se
   ejecuta con la imagen y las variables nuevas contra la red del proyecto,
   **antes** de tocar la versión en marcha. Es donde suelen ir las migraciones;
   si falla —o no termina en 30 minutos— el despliegue se aborta y lo que
   estaba sirviendo sigue igual. El comando viaja en una variable de entorno,
   nunca interpolado en el shell. Las variables con nombre reservado para la
   propia CLI de Docker (`PATH`, `HOME`, `LD_*`, `DOCKER_*`, `GIT_*`, `NODE_*`,
   `SSL_CERT_*`, `*_PROXY`…) se le pasan al contenedor como `--env CLAVE=VALOR`
   y nunca entran en el entorno del proceso `docker` (`deploy/predeployenv.ts`):
   con ellas en el entorno, quien edita variables elegía qué binario ejecuta
   Skyway con el socket de Docker en la mano.
4. **Despliegue del contenedor** (intercambio con validación):
   - **Estrategia** (`deploy/estrategia.ts`): antes de tocar la versión en
     marcha, el desplegador decide **una vez por despliegue** cómo sustituirla y
     lo escribe en el registro («Estrategia: una sola copia (sin dominio,
     healthcheck ni llamadas de otros servicios). Parada: SIGTERM y 30 s de
     gracia.», con «comando al parar,» delante del SIGTERM si lo hay). Hay dos:
     - **Sin corte** (`overlap`): la versión nueva arranca y se valida mientras la
       anterior sigue atendiendo; durante unos segundos hay dos copias. Es lo
       correcto para una web o una API.
     - **Una sola copia** (`recreate`): se detiene la versión anterior (con parada
       limpia) y después arranca la nueva; unos segundos sin servicio y nunca dos
       copias a la vez. Es lo que necesita un bot de polling (Telegram, Discord…:
       dos copias pidiendo actualizaciones reciben un 409) o un worker (dos copias
       procesarían el mismo trabajo).

     La elige `estrategiaDespliegue`, con estas reglas **en este orden**:
     1. base de datos → una sola copia (motivo `base_de_datos`, no elegible);
     2. volúmenes o puerto público → una sola copia (motivo `estado`, no
        elegible: dos procesos no pueden escribir el mismo volumen ni publicar el
        mismo puerto del host; gana a «sin corte» elegido);
     3. la elegida en Ajustes del servicio (`deployStrategy`, motivo `elegida`);
     4. automática: un **bot de Telegram o Discord sin dominio** (biblioteca
        detectada en el repositorio, `needs.bots`: telegraf, grammy,
        python-telegram-bot, aiogram, discord.js, discord.py…) → una sola copia
        (motivo `bot`), **aunque tenga healthcheck o lo llamen otros
        servicios**: con dos copias el bot falla él mismo durante el relevo
        (Telegram responde 409 a una de las dos y la copia nueva puede no pasar
        la validación; en Discord, las dos contestan a cada mensaje). Con dominio
        puede recibir webhooks y sigue la regla 5. Slack, Twilio, WhatsApp y
        Stripe reciben webhooks o solo envían: no cambian nada;
     5. automática: **sin dominio, sin ruta de healthcheck y sin que otro servicio
        del proyecto lo llame por la red interna** → una sola copia (motivo
        `sin_trafico`); si no, sin corte (motivo `con_trafico`). La ruta de
        healthcheck es la de Ajustes **o la del repositorio** (`railway.json` o
        `railway.toml`), que es la que valida el despliegue y manda sobre la de
        Ajustes: un healthcheck dice que el servicio atiende y que se quiere
        validar sin cortar. El desplegador usa la del commit que despliega; fuera
        de él (Ajustes, Reiniciar, el cambio de dominio) se usa la de la versión
        en marcha (`healthcheckDelRepositorio`: la del último despliegue correcto
        o la del que construyó su imagen), y la API la devuelve en
        `deploy.repoHealthcheckPath`.

     «Sin puerto» no sirve para reconocer un bot: un servicio de repositorio
     siempre tiene puerto interno (3000 por defecto). Por eso cuentan el
     healthcheck y las llamadas internas: una API interna que otro servicio llama
     con `${{api.INTERNAL_URL}}` no debe quedarse sin servicio en cada despliegue.
     Un servicio de imagen **sin puerto** no tiene router de Traefik ni sonda, así
     que un dominio o un healthcheck que conserve (los de un servicio importado
     de Railway sin puerto conocido) no cuentan.
     «Lo llama otro servicio» (`llamadoPorOtros`) mira lo que Skyway guarda: las
     variables compartidas del proyecto y, de los **demás** servicios, sus
     variables, sus build args y su comando de arranque. Cuenta una referencia
     `${{<nombre o slug>.INTERNAL_URL|INTERNAL_HOST|INTERNAL_PORT|RAILWAY_PRIVATE_DOMAIN}}`;
     la dirección escrita a mano `<slug>:<puerto>` o `<slug>.railway.internal`
     donde empieza una dirección (al principio del valor o tras `//`, `@`, `=`,
     un espacio, una coma, un punto y coma, comillas, un paréntesis o un
     corchete); la URL sin puerto `http://<slug>/…` o `http://<slug>` (un
     nombre sin puntos justo detrás de `//` solo puede ser un host interno); y
     el slug a secas en una variable cuyo nombre acaba en `HOST`,
     `HOSTNAME`, `DOMAIN`, `ADDR` o `ADDRESS` (`API_HOST=api`, que es como deja
     la importación de Railway un `${{api.RAILWAY_PRIVATE_DOMAIN}}`). Lo que solo
     se parece no cuenta: `https://api.example.com`, `scope=api:read`, un trozo
     de ruta como `https://x.com/v1/api:1234`, `http://apis/` o `${{api.PUBLIC_URL}}` (que entra
     por el dominio). Una variable compartida cuenta aunque solo la use el propio
     servicio: llega a todos y no se sabe quién la lee. **Una llamada escrita en
     el código o en un fichero de la imagen** (un `proxy_pass http://api:3000` en
     `nginx.conf`, una reescritura de Next.js) **no se detecta**: en ese caso,
     elige «Sin corte» en Ajustes del servicio. Los servicios sin dominio que ya
     existían pasan a «una sola copia» en su siguiente despliegue; Ajustes enseña
     la estrategia efectiva y su motivo, y todo se puede elegir salvo las reglas
     1 y 2. Para que ese cambio no se note solo después del corte, al arrancar
     por primera vez esta versión Skyway crea **una vez** (ajuste
     `avisoEstrategiaUnaSolaCopia`) una alerta en el panel, sin canales externos,
     por cada servicio ya desplegado al que la regla automática da «una sola
     copia» (tipo `estrategia_una_sola_copia`: ««bot» se desplegará con una sola
     copia», con cómo volver a «Sin corte» y la gracia nueva). Un despliegue
     correcto no la resuelve.

     La estrategia se aplica en `deployContainer`, por el que pasan **todos** los
     despliegues: push y sondeo, despliegue manual, volver atrás, reintento tras
     un reinicio, «Desplegar todos», la pestaña Correo, el plan de integraciones,
     la renovación de credenciales, las pilas, la importación de Railway y cada
     paso del cambio de dominio (pasar, volver, cancelar y dar de baja). El
     comando previo (punto 3) se ejecuta antes de parar nada: es una orden
     puntual, no una copia del servicio.
   - **Validación**: healthcheck HTTP 2xx si hay ruta de healthcheck; si no, y
     el servicio recibe tráfico (dominio o puerto público), una **sonda TCP** a
     su puerto interno (`nc -z` desde el contenedor auxiliar `busybox`, mismo
     plazo) más el periodo de gracia; sin tráfico (un worker), solo el periodo
     de gracia de 5 s. Antes bastaba con que el proceso siguiera vivo, y una app
     que escuchaba en otro puerto se daba por buena con el dominio en 502. Si el
     repositorio declara una política de reinicio que reintenta
     (`restartPolicyType`), una caída al arrancar no es un fallo en ninguno de
     los tres casos: se espera a que Docker la reinicie (hasta 90 s), salvo que
     sea definitiva (`on-failure` con código 0 o con los reintentos agotados).
   - **Sin corte**: se arranca la versión nueva en paralelo como copia de
     validación (`--next`, sin tráfico y con `SKYWAY_VALIDATION=1`), se
     **valida** y se detiene con parada limpia (antes se borraba con SIGKILL),
     con una gracia corta: la del servicio hasta 10 s como mucho
     (`GRACIA_VALIDACION_MAXIMA`), porque nunca ha atendido. Se retira **antes**
     del relevo, mientras la versión anterior sigue en servicio: así nunca hay
     tres copias a la vez (antes se paraba en segundo plano con la gracia
     completa, y convivía con la anterior y la nueva: el triple de memoria y
     hasta 30 s más de despliegue). Después de validar se
     intercambia réplica a réplica (rolling update). La
     versión anterior de cada réplica **no se retira hasta que la copia nueva
     atiende**: la misma sonda contra su nombre de contenedor en la red del
     proyecto o, si la imagen declara `HEALTHCHECK`, hasta que Docker la marca
     `healthy` (Traefik no le envía tráfico antes). Esa espera dura lo que
     Docker puede tardar en decidir con el `HEALTHCHECK` de la imagen
     (`start_period + (interval + timeout) × retries`) si es mayor que el plazo
     del healthcheck del servicio: el primer chequeo no llega hasta pasado el
     `interval`. Las etiquetas de Traefik llevan un middleware `retry` (3
     intentos): mientras la copia nueva arranca, una conexión rechazada se
     reintenta y el balanceo la lleva a la anterior. Si no se pudo comprobar
     nada (sin dominio ni healthcheck), el registro lo dice en vez de anunciar
     «sin interrupción». Una réplica nueva que falla se detiene con parada
     limpia y se retira; la versión anterior de cada réplica y las réplicas
     sobrantes se detienen con parada limpia, se archiva su registro y se
     retiran.
   - **Una sola copia** (sustituye a la rama «con estado» de antes y la
     generaliza a N réplicas): las copias anteriores (nombres exactos
     `<servicio>` y `<servicio>-rN`) se renombran a `--prev` y se detienen
     **todas, en paralelo y con parada limpia, antes de arrancar ninguna
     nueva**; se archiva su registro. Si alguna se detuvo con SIGKILL al agotar
     la gracia, esa gracia fue tiempo sin servicio: además del aviso del
     registro, una alerta del servicio en el panel (tipo `parada_forzada`, sin
     canales externos: ««bot» no atiende SIGTERM», con cómo arreglarlo); se
     cierra sola en el primer despliegue cuya parada no necesite SIGKILL, no en
     cualquier despliegue correcto. Después arrancan las nuevas: la 1 con la
     validación completa (y la política de reinicio del repositorio), de la 2 a
     la N esperando a que estén listas. Si cualquier copia nueva falla, se añade
     al registro su salida, se detienen y retiran las nuevas y se **restauran
     todas las anteriores** (vuelven a su nombre y se arrancan): «La versión
     nueva falló (…). Se restauró la versión anterior automáticamente.» (sin
     versión anterior: «El contenedor terminó inesperadamente (…). Consulta el
     registro del servicio.»). Si van bien, se retiran las `--prev`. El
     registro lo dice al empezar («Una sola copia: se detiene la versión
     anterior antes de arrancar la nueva…») y al terminar («Versión nueva en
     marcha (una sola copia: la anterior se detuvo antes de arrancarla).»). Con
     una réplica y volúmenes se comporta exactamente como antes. Varias réplicas
     siguen exigiendo un servicio sin volúmenes ni puerto público. Una parada no
     se puede interrumpir a mitad: «Cancelar» durante la parada de la versión
     anterior surte efecto al terminarla, y la versión anterior se restaura.
   - **Parada limpia** (`pararConGracia` en `docker/containers.ts`): toda
     parada de una copia de un servicio sigue el mismo orden. Si el contenedor
     está en marcha y el servicio tiene **comando al parar** (`stopCommand`), se
     ejecuta dentro con `docker exec` y la orden fija `eval "$SKYWAY_STOP_CMD"`
     (el texto viaja en la variable `SKYWAY_STOP_CMD`, nunca interpolado en un
     shell del host ni del contenedor), con la gracia como plazo; si falla o
     vence el plazo, se registra (código y últimas 20 líneas) y se sigue. Si la
     imagen no tiene `sh` (distroless, scratch), Docker responde 126/127 con el
     error del runtime OCI: el registro lo dice así («⚠ La imagen de <nombre> no
     incluye «sh»: el comando al parar no se puede ejecutar y se continúa con
     SIGTERM…») en vez de un «código 127» que parece un fallo del comando. El comando al parar **no** se ejecuta en la copia de
     validación `--next` (ni en sus restos) ni en la réplica nueva que falla en
     «sin corte»: la versión anterior sigue en servicio, y el comando podría
     deshacer lo que ella registró (el webhook de un bot). Con «sin corte», el
     de la versión anterior se ejecuta cuando la nueva ya está en servicio: el
     registro y Ajustes lo advierten y recomiendan «Una sola copia» si el
     comando da de baja algo compartido. Después, **SIGTERM** y, si el proceso no termina en la
     **gracia**, **SIGKILL** (`docker stop -t <gracia>`). La gracia es la del
     servicio (`stopGraceSeconds`, 0–600); si no la tiene,
     `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` del entorno resuelto (solo dígitos,
     hasta 600); si no, **30 s** (antes, 10 s fijos). En una **base de datos**
     la variable de Railway no se aplica (en Skyway las variables compartidas
     también llegan a las bases, y un valor pensado para que un bot se pare
     rápido las dejaría con SIGKILL en cada parada) y la gracia nunca baja de
     **10 s**. Se fija además como `StopTimeout` del contenedor al crearlo, de
     modo que un `docker stop` ajeno a Skyway o el apagado del daemon den el
     mismo plazo. Solo un 404 cuenta como «el contenedor no existe»: si la
     consulta falla por otro motivo, el contenedor se para igualmente, sin el
     comando, y un fallo de la parada se propaga a quien la pidió. En «una sola
     copia», si alguna copia anterior no se puede detener, se restauran todas y
     el despliegue falla con «No se pudo detener la versión anterior (…): sigue
     en servicio y no se ha arrancado la nueva.»; un «Cancelar» a mitad deja el
     despliegue como **cancelado** («Despliegue cancelado: restaurando la
     versión anterior…»), no como fallido, y si la restauración falla el error
     lo dice en vez de afirmar que se restauró.
     Se usa con la versión anterior (en las dos estrategias), la copia
     `--next` (también al fallar o cancelarse; con su gracia corta), la réplica
     nueva que falla, las réplicas sobrantes, los restos de intercambios,
     «Detener» y «Reiniciar». «Detener» para todas las copias a la vez;
     «Reiniciar» sigue la estrategia: con «sin corte», réplica a réplica (cada
     una vuelve a arrancar antes de parar la siguiente, así que siempre queda
     una en servicio, como antes de la parada limpia); con «una sola copia»,
     para todas a la vez y no arranca ninguna hasta que se han parado todas. Si la parada
     termina con el código 137, sin `OOMKilled` y tras agotar la gracia, el
     registro avisa: «⚠ <nombre> no terminó con SIGTERM en <N> s y se detuvo con
     SIGKILL. Si la aplicación es el proceso principal del contenedor, tiene que
     atender SIGTERM (cerrar y salir): sin un manejador, el sistema descarta la
     señal. Si el comando de arranque es una sola orden, empiézalo con «exec».
     Aumenta la gracia de parada en Ajustes del servicio solo si el proceso ya
     atiende SIGTERM y necesita más tiempo para cerrar.». Hay dos causas
     habituales. La primera: el proceso principal (PID 1) es la propia
     aplicación y no tiene manejador de SIGTERM; el kernel descarta las señales
     sin manejador que llegan al PID 1, así que Node sin
     `process.on('SIGTERM', …)` o Python sin `signal.signal(signal.SIGTERM, …)`
     siguen en marcha hasta el SIGKILL. La segunda: el comando de arranque va
     envuelto en `sh -c` (Skyway lo envuelve así cuando la imagen no tiene un
     shell como entrypoint) y el shell se queda como PID 1 sin reenviar la señal,
     como hacen busybox y Alpine; con `exec`, la aplicación sustituye al shell
     (y entonces tiene que atender SIGTERM, como en el primer caso). Subir la
     gracia no arregla ninguna de las dos: con «una sola copia», la gracia se
     suma al tiempo sin servicio, así que en un proceso que no atiende SIGTERM
     conviene **bajarla**. No se activa `Init` (tini) de forma general: rompe
     imágenes que necesitan ser el PID 1 (s6-overlay). El borrado de servicios y
     proyectos (`purge.ts`) no cambia: 10 s de cortesía antes de borrar.
   - **Configuración del repositorio al volver a desplegar una imagen**: un
     despliegue que reutiliza una imagen sin compilar (vuelta atrás, pestaña
     Correo, cambio de dominio, su reintento) lee la config-as-code del
     despliegue que la construyó y ahora la **copia a su fila**
     (`deployments.repo_config`); `deploymentForImage` prefiere los despliegues
     con configuración guardada. Antes, la fila sin configuración del despliegue
     más reciente de esa imagen tapaba a la que la construyó: la siguiente vuelta
     a esa imagen arrancaba sin el comando de arranque ni el healthcheck del
     repositorio, y el build siguiente la tomaba por un despliegue de antes de
     railway.json (`previousBuilder`, que ahora también busca el que construyó
     la imagen) y podía cambiar de constructor.
   - **Registro de la versión anterior**: se archiva **después** de pararla, de
     modo que conserva lo que escribe al recibir SIGTERM (antes se archivaba
     antes de parar y se perdía el cierre).
   - **Monitor**: justo antes de parar la versión anterior (y antes de cada
     parada de réplicas) el desplegador llama a `markManualAction`: el monitor
     solo perdona caídas durante 3 minutos tras una acción manual, y un build
     largo seguido de «parar y arrancar» abría una alerta de caída falsa.
   - **Identidad por copia**: cada contenedor recibe `SKYWAY_INSTANCE_ID` (un
     UUID nuevo por contenedor creado: distinto en cada réplica, en `--next` y
     en cada despliegue), `SKYWAY_REPLICA` (1…N; `--next` lleva 1),
     `SKYWAY_REPLICAS` (réplicas configuradas), `SKYWAY_VALIDATION=1` solo en
     `--next` y `RAILWAY_REPLICA_ID` igual a la instancia salvo que la defina el
     usuario (§5.5). Las etiquetas `skyway.instance` y `skyway.replica` lo
     repiten en el contenedor. `SKYWAY_DEPLOYMENT` y `RAILWAY_DEPLOYMENT_ID`
     siguen siendo el id del despliegue, iguales en todas sus copias. Un
     «Reiniciar» conserva el contenedor y, con él, su identidad.
   - **Restos de intercambios** (`--next`/`--prev` que deja un intercambio
     cortado por una caída o un apagado de Skyway; Docker termina por su cuenta
     una parada a medias). `limpiarRestosIntercambio` los trata con parada
     limpia: un `--next` se detiene y se retira. Un `--prev` cuya copia base
     existe se decide por la etiqueta `skyway.deployment` de las dos: si la base
     es de un despliegue que no terminó bien y el de la `--prev` está en
     `success` (Skyway cayó mientras validaba la versión nueva), se detiene y se
     retira la base y la `--prev` vuelve a su nombre, porque es la versión que
     funcionaba; en otro caso se detiene y se retira la `--prev`. Un `--prev`
     sin base vuelve a su nombre. La copia que vuelve a su nombre se arranca,
     salvo que el servicio esté detenido a propósito (`stopped_at`) o que la
     limpieza la pida «Detener». Se ejecuta:
     al **arrancar Skyway** (con Docker disponible, `limpiarIntercambiosAlArrancar`
     busca los contenedores `skyway.managed=true` cuyo nombre acaba en `--next`
     o `--prev` y encola la limpieza en la cola de cada servicio, `deploy:<id>`,
     **antes** que el reintento automático del despliegue cortado, sin esperar a
     las paradas; los restos de servicios que ya no existen se dejan y se
     registra un aviso; si hubo restos, queda en la auditoría como
     `swap_leftovers_cleaned`); al principio de cada despliegue (sustituye a
     `recoverStaleSwap`); y en **Detener, Iniciar y Reiniciar** si el servicio
     no tiene un despliegue en cola o en marcha (con uno en marcha, sus
     `--next`/`--prev` son suyos y no se tocan). La de estas acciones también
     pasa por la cola `deploy:<id>` y la acción espera a que termine: así nunca
     coincide con la del arranque sobre los mismos restos.
   - Antes de arrancar se inyectan las **variables de compatibilidad Railway**
     (§5.5) sin pisar ninguna definida por el usuario. Si el entorno define
     `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`, el registro indica (ℹ) que Skyway no
     la aplica y remite a Ajustes del servicio → Despliegue y parada; si hay
     varias réplicas y el servicio no recibe tráfico (motivo `sin_trafico`),
     también avisa de que hay N copias en marcha a la vez de forma permanente
     (y, con el motivo `bot`, de que un bot de polling o del gateway de Discord
     solo admite una). Otros avisos (ℹ) de la estrategia: un bot de Telegram o
     Discord que pasa solo a «una sola copia» (y, si tiene healthcheck o lo
     llaman, que no responderán durante el relevo y que, si recibe webhooks a
     través de otro servicio, conviene «Sin corte»); uno con dominio que queda
     «sin corte» (si pide actualizaciones en vez de recibir webhooks, recibe un
     409: conviene «Una sola copia»); un servicio con puerto interno que pasa
     solo a «una sola copia» (una llamada escrita en el código o en un
     `proxy_pass` de otro servicio no se detecta; en ese caso, «Sin corte»); y
     «sin corte» con comando al parar (el de la versión anterior se ejecuta con
     la nueva ya en servicio).
   - Rutas que la imagen declara con `VOLUME` y que el servicio no monta: aviso
     en el registro (su contenido se reinicia en cada despliegue y el anterior
     queda en un volumen anónimo huérfano) y se anotan en `config.imageVolumes`
     para que Ajustes ofrezca «Añadir volumen». Nunca se crea el volumen solo:
     con volúmenes el intercambio deja de ser sin corte.
5. **Post**: un deploy correcto resuelve las alertas del servicio (salvo la del
   sondeo del auto-deploy, `autodeploy_failing`) y purga imágenes antiguas (se
   conservan las de las **5 últimas** versiones correctas por servicio para
   rollback; ajuste `keepImages`, de 1 a 50). Un
   fallo genera una alerta con diagnóstico (`diagnose.ts`). Cada despliegue
   anota la **revisión de configuración** del servicio que aplica
   (`deployments.config_rev`, ver «Cambios sin desplegar» en §6).
6. **Reinicios**: un apagado de Skyway corta los despliegues en marcha (y un
   arranque marca como fallidos los que quedaron en cola o a medias); todos
   quedan con `interrupted = 1`. Al arrancar, cada servicio cuyo **último**
   despliegue quedó cortado recibe la alerta `deploy_interrupted` y **un**
   reintento automático (origen `reintento`; una vuelta atrás se reintenta como
   vuelta atrás, y un despliegue del cambio de dominio o de la pestaña Correo
   que llevaba imagen —la versión en marcha, o la que ya había construido— se
   reintenta con esa imagen, sin compilar la cabeza de la rama; si esa imagen es
   la del último despliegue correcto, el registro dice «Se vuelve a desplegar la
   imagen en marcha…» y no «Rollback a la imagen…»), encolado detrás de la limpieza de los restos de intercambios
   del servicio (punto 4). Si el reintento también se corta, solo la alerta: un build que
   tumba Skyway reintentado siempre sería un bucle de reinicios. Las alertas
   `deploy_failed` y `deploy_interrupted` de una vuelta atrás guardan en
   `alerts.rollback_to` el despliegue correcto al que se volvía, y Alertas
   ofrece «Volver a esta versión» en lugar de «Desplegar» (que desplegaría la
   cabeza de la rama).

**Prueba real con Docker** (`scripts/prueba-real-bots.mjs`, §9). Arranca un
Skyway propio (carpeta de datos temporal, puerto 4999 solo en 127.0.0.1) y mide
con `docker events` cuántas copias de cada servicio hay en marcha a la vez y
con qué código termina cada una: un bot de imagen sin puerto ni dominio, un bot
de repositorio local (vuelta atrás y sondeo de la rama) y una web con
healthcheck a la que una sonda en la red del proyecto pide cada 0,1 s. Cubre
volver a desplegar, réplicas, comando al parar (también con comillas, con
código distinto de 0, sin terminar y en una imagen sin `sh`), SIGKILL al agotar
la gracia, Reiniciar, Detener e Iniciar con restos, «sin corte» elegido a mano,
caídas de Skyway (`SIGKILL` y apagado ordenado) durante la parada de la versión
anterior, durante la validación de la nueva y con dos réplicas, versión rota,
Cancelar, «Desplegar todos» y la web sin corte también tras una caída. Al
terminar retira el proyecto, los contenedores, las imágenes y las redes que ha
creado. Sin Traefik, la sonda entra por el alias de la red del proyecto, y el
DNS de Docker reparte entre las copias: alguna petición suelta puede fallar en
el instante en que una copia entra o sale (también antes de «una sola copia»
y la parada limpia); un corte serían decenas seguidas.

**Feed de despliegues.** Cada cambio de fase (encolado, construyendo,
desplegando, terminado) se publica en un bus en memoria (`events.ts`) que
alimenta `GET /api/projects/:id/deploys/stream` y viaja también por el stream de
métricas del proyecto (§7.5). El panel lo usa para anunciar «hay una versión
nueva saliendo» en la rejilla de servicios, en la cabecera del proyecto y en las
tarjetas del panel general, sin esperar al refresco periódico. En el historial
del servicio, **lo que está saliendo va por encima del activo**.

---

## 3. Modelo de datos (SQLite)

| Tabla | Claves / campos relevantes |
| --- | --- |
| `users` | `id`, `email` (único), `password_hash` (scrypt `s2:salt:hash`), `role` (`admin`/`owner`/`member`), `workspace_id` (owner/member), `session_epoch` |
| `user_projects` | `(user_id, project_id)` — proyectos asignados a un miembro |
| `plans` | `id`, `name`, `slug`, `price_cents`, `currency`, `interval`, cuotas incluidas (`cpu_cores`, `memory_mb`, `disk_mb`, `max_projects`, `max_services`, `max_members`), `modules` (JSON), `is_default`, `archived`, `discount_pct` (descuento comercial % de las cuentas del plan) |
| `workspaces` | `id`, `name`, `slug`, `plan_id`, overrides de cuota (mismos campos, null = hereda del plan), `modules_override` (concesión del admin), `owner_disabled_modules` (acotado del propietario), `status` (`active`/`suspended`), `billing_email`, `billing_tax_id` (NIF/CIF del cliente), `billing_address` (domicilio fiscal del cliente), `billing_country` (ISO 3166-1 alfa-2, `ES` por defecto), `billing_day`, `discount_pct` (descuento % de la cuenta; null = hereda del plan), `plan_since` (contratación del plan vigente: ancla del aniversario de las cuotas anuales), `last_billed_period_end` (ancla de facturación: fin de lo último facturado), `notes`, y estado de morosidad (`ai_suspended`, `dunning_stage` 0→3, `dunning_since`, `last_dunning_action_at`, `dunning_exempt`) |
| `workspace_plan_periods` | historial de plan **por tramos**: `id`, `workspace_id`, `plan_id` (null = sin plan en ese intervalo), `from_ms`, `to_ms` (null = tramo vigente), y una copia congelada de la tarifa (`plan_name`, `price_cents`, `currency`, `interval`) que solo se usa si el plan se borró del catálogo. Se abre en el alta y se parte en cada cambio de plan, en la misma transacción que `workspaces.plan_id`: el ciclo factura **cada tramo a su precio**, prorrateado por los días servidos |
| `workspace_invoices` | `id`, `workspace_id`, `series_id` (FK `invoice_series`), `number` (nº correlativo por serie/ejercicio, p. ej. `FRA-2026-0001`), `invoice_type` (`normal`/`simplificada`/`rectificativa`), `rectifies_invoice_id`+`rectify_reason` (si rectificativa), `period_start/end`, `operation_date` (fecha de operación si difiere de la expedición), `status` (`draft`/`issued`/`paid`/`void`), `currency`, `subtotal_cents` (base imponible), `tax_cents`, `tax_rate` (tipo por defecto), `tax_breakdown` (JSON: bases y cuotas **por tipo de IVA**), `vat_regime` (general/exento/inversión SP…), `legal_mentions`, `irpf_rate`+`irpf_cents` (retención), `total_cents`, `lines` (JSON, con `taxRate` por línea), `plan_name`, `issuer_snapshot` (datos fiscales del emisor congelados al emitir), `client_name`+`client_tax_id`+`client_address` (destinatario congelado al emitir), `payment_method` (`bank_transfer`/`stripe`/`card`/`cash`/`other`), `stripe_session_id`, `stripe_url`, `issued_at`, `paid_at`, `locked` (1 = emitida, inmutable), `notes` |
| `invoice_series` | `id`, `code`, `year` (ejercicio; reinicio anual), `prefix`, `padding`, `next_seq` (incremento atómico al emitir), `kind` (`ordinaria`/`rectificativa`/`simplificada`), `UNIQUE(code, year)`. Sustituye al contador global; las rectificativas usan serie propia |
| `catalog_products` | catálogo multimodular: `id`, `name`, `slug`, `category` (`web`/`ia`/`app`/`hosting`/`bbdd`/`dominio`/`soporte`/`custom`), `billing_model` (`flat_one_off`/`subscription`/`metered`/`tiered`), `price_cents`, `currency`, `interval`, `unit`, `unit_size` (nº de unidades del medidor por unidad de precio; p. ej. 1000000 → precio por 1M tokens con céntimos enteros), `meter` (medidor de uso), `tier_mode` (`graduated`/`volume`), `tax_rate`, `irpf_rate`, `tax_exempt`, `modules` (JSON), `description`, `active`, `archived` |
| `catalog_price_tiers` | tramos de precio de un producto `tiered`: `id`, `product_id`, `up_to` (null = último), `unit_cents`, `flat_cents`, `sort` |
| `workspace_subscriptions` | suscripciones/add-ons por cuenta: `id`, `workspace_id`, `product_id`, `service_id` (opcional), `qty`, `unit_cents` (congelado al contratar; null = sigue catálogo), `currency`, `interval`, `status` (`active`/`paused`/`cancelled`), `anchor_day`, `started_at`, `cancelled_at` |
| `pending_charges` | cargos puntuales pendientes del próximo ciclo: `id`, `workspace_id`, `product_id`, `label`, `kind`, `qty`, `unit_cents`, `tax_rate`, `irpf_rate`, `status` (`pending`/`invoiced`/`cancelled`), `invoice_id` |
| `usage_events` | ingesta cruda de consumo (idempotente): `id`, `idempotency_key` (único), `subject_type` (`workspace`/`service`), `subject_id`, `meter`, `quantity`, `product_id`, `ts`, `metadata` |
| `usage_meter_hourly` | agregado horario del uso para tarifar: `PK(subject_id, meter, hour)`, `quantity` |
| `invoice_ledger` | **reservada** (Verifactu, RD 1007/2023): libro inmutable encadenado por huella SHA-256 — `id`, `seq`, `invoice_id`, `record_type` (`alta`/`anulacion`), `huella`, `huella_anterior`, `qr_url`, `sif_mode`, `estado_remision`… Se crea vacía para no exigir migración al activar Verifactu; la lógica llega en fase posterior |
| `invoice_events_log` | **reservada** (Verifactu): registro de eventos del SIF encadenado por huella |
| `workspace_api_keys` | claves de API por cuenta para el proxy de IA: `id`, `workspace_id`, `name`, `key_hash` (sha256, único; el secreto `skai_…` solo se muestra al crear), `prefix`, `provider`, `allowed_models` (JSON), `status` (`active`/`suspended`/`revoked`), `budget_cents_month`, `spend_cents_cycle`, `rate_limit_rpm`, `last_used_at`, `expires_at`, `revoked_at`. El prefijo **no** empieza por `sky_`: nunca se resuelve como token de panel |
| `ai_model_prices` | coste del operador por modelo y margen objetivo: `model` (PK), `cost_micros_in`/`cost_micros_cache`/`cost_micros_out` (micro-céntimos por millón de tokens), `margin_pct` (margen objetivo s/ venta, guía el PVP sugerido), `currency`, `source` (`auto` = lo mantiene la sincronización con la tarifa de Google, `manual` = fijado por el operador y respetado), `synced_at`, `updated_at`. Informativo; no interviene en la factura |
| `passkeys` | credencial WebAuthn: `credential_id`, `public_key`, `counter`, `rp_id`… |
| `api_tokens` | `token_hash` (sha256 hex), `prefix`, `expires_at` — tokens `sky_…` |
| `settings` | pares clave/valor: `jwtSecret`, `githubToken`, `rootDomain`, `letsencryptEmail`, `serverIp`, `serverIpv6` (opcional: sin ella, cualquier AAAA de un dominio cuenta como ajeno), canales de alerta, `importReport:<projectId>`, `billingProfile` (perfil fiscal del emisor, JSON: razón social, NIF, domicilio, IVA por defecto, `defaultIrpfRate`, `sifMode` veri/no-veri, IBAN…), claves de Stripe (`stripeSecretKey`, `stripeWebhookSecret`, `stripePublishableKey` — las secretas nunca se devuelven), gateway de IA (`ai.geminiApiKey` — clave del operador, nunca devuelta; `ai.allowedModels`, `ai.geminiBaseUrl`), autoactualización de la tarifa de IA (`ai.prices.auto` por defecto activada, `ai.prices.url` fuente propia, `ai.prices.currency` por defecto EUR, `ai.prices.fx`/`ai.prices.fxAt` cambio USD→moneda, `ai.prices.defaultMarginPct`, `ai.prices.autoAllow`, `ai.prices.lastAt`/`ai.prices.last` resultado del último pase), dunning (`billing.dunningGraceDays` por defecto 14, `billing.dunningCancelDays` por defecto 44), Mailway (`mailway.baseUrl`, `mailway.serviceId`, `mailway.token` — token de gestión, nunca devuelto —, `mailway.traefikToken` y `mailway.traefikCache`, última configuración de Traefik saneada; `mailway.defaultPlanId`, plan con el que se crea el cliente si no lo elige un administrador; `mailway.hosts`, hosts públicos que anuncia la instancia; `mailway.containerHosts`, hosts de las reglas `Host(…)` de las etiquetas de Traefik de los contenedores `mailway-mail`, `mailway-webmail` y `mailway-panel`; `mailway.previousHosts`, nombres que fueron de la instancia (`[{host, lastSeen}]`) y siguen reservados hasta que el administrador los libera; `mailway.whitelabelHosts`, última lista buena de nombres de marca blanca de todos los clientes en cualquier estado, reservados para los servicios; `mailway.previousClient:<projectId>`, cliente que tenía el proyecto antes de desactivar el correo)… |
| `projects` | `id`, `name`, `slug` (único), `workspace_id` (cuenta de cliente), `client` (reflejo denormalizado del nombre del workspace para la UI), página de estado (`status_token`, `status_enabled`, `status_notice`) |
| `services` | `id`, `project_id`, `name`, `slug`, `type` (`git`/`database`/`image`), `config` (JSON), `config_rev` (revisión de la configuración: sube con cada cambio guardado que exige redesplegar) |
| `env_vars` | `(service_id, key)` → `value` — variables por servicio |
| `project_vars` | `(project_id, key)` → `value` — variables compartidas |
| `deployments` | `status`, `trigger`, `commit_sha/msg`, `image_tag`, `logs`, `error`, `diagnosis`, `build_key` (huella de las entradas de compilación, para reutilizar imagen), `repo_config` (config-as-code del repo en ese commit, JSON), `build_vars` (digest `{NOMBRE: hash}` de las variables que entraron en ese build; nunca el valor), `force_build`, `target_commit` (commit concreto pedido al reconstruir), `config_rev` (revisión de configuración que aplicó), `interrupted` (1 = cortado por un reinicio de Skyway, pendiente de tratar al arrancar; 2 = tratado) |
| `autodeploy_state` | por servicio git con auto-deploy: `last_seen_sha` (última cabeza de la rama ya tratada, la línea base del sondeo), `checked_at`/`ok_at` (última comprobación y última correcta), `error` y `failing_since` (racha de fallos al leer la rama). Se borra al desactivar el auto-deploy y cae en cascada con el servicio |
| `audit_log` | `ts`, `actor`, `action`, `target_*`, `detail`, `ip` |
| `alerts` | `severity`, `type`, `title`, `message`, `explanation`, `dedupe_key`, `resolved_at`, `read_at`, `rollback_to` (despliegue correcto al que volvía una vuelta atrás fallida o interrumpida) |
| `uptime_hourly` | `(service_id, hour)` → `up`, `total` — histórico de disponibilidad |
| `service_metrics_hourly` | `(service_id, hour)` → sumas y máximos de CPU/RAM, bytes de red del periodo (delta) y foto de disco — histórico de consumo (~90 d) |
| `host_metrics_hourly` | `hour` → carga, RAM y disco del host (sumas, máximos y última foto) — histórico de consumo del servidor (~90 d) |
| `github_connectors` | `id`, `project_id`, `name`, `token` (en claro: se necesita para clonar; jamás sale por la API), `gh_login`, `token_type`, `created_by`, `last_used_at` — cae en cascada con el proyecto |
| `mailway_links` | correo del proyecto: `project_id` (PK, cae en cascada con el proyecto), `client_id` (cliente de Mailway; índice normal, no único: lo **comparten los proyectos de una misma cuenta**, nunca proyectos de cuentas distintas), `client_name` (copia del nombre en Mailway), `created_by`, `created_at`, `legacy_credentials` (1 = vínculo anterior a compartir clientes: las credenciales de envío con el nombre de antes que haya en su cliente son de este proyecto). En Mailway el cliente lleva la referencia externa de la cuenta, `skyway:workspace:<workspaceId>`, o, en un proyecto sin cuenta (y en el cliente propio que conserve un proyecto de una cuenta), `skyway:project:<projectId>`; es la fuente de verdad. Si falta la fila de un proyecto con cliente propio, `GET /api/projects/:id/mail` la recupera; con la referencia de la cuenta no (la comparten todos sus proyectos): al activar el correo se vincula de nuevo al mismo cliente. No guarda credenciales. La migración `mailway_links_shared_v1` retiró el índice único anterior |
| `service_managed_env` | variables que escribió Skyway por su cuenta (correo, plan de integraciones, importación del `.env` del repositorio): `(service_id, key)` → `origin` (`mail.smtp.password`, `postgres.DATABASE_URL`, `generate`, `value`, `self.public_url`, `import`…), `value_hash` (SHA-256 del valor escrito, nunca el valor), `updated_at`. Si el valor actual ya no casa con el hash, la variable es de quien la cambió y no se vuelve a tocar. Cae en cascada con el servicio |
| `mailway_renovaciones` | renovación automática de la contraseña de aplicación SMTP de un servicio cuando Mailway la invalida al cambiar de motor (`mailwayrenovacion.ts`): `service_id` (PK, cae en cascada con el servicio), `status` (`renewed` hecha, `waiting` se hará cuando se pueda, `failed` no se ha podido), `reason` (por qué espera o ha fallado, texto de la interfaz), `renewed_at`, `app_password_id` (la que creó Skyway y tienen las variables: con ella, un intento que no llegó a revocar la invalidada no crea otra), `mailbox`, `deployment_id` (el despliegue que la aplica), `updated_at`. Sin secretos. «Conectar a un servicio» por SMTP la borra |
| `domain_migrations` | cambio de dominio de un proyecto (§6.1): `id`, `project_id` (cascada), `from_domain`, `to_domain`, `estado` (`preparando`/`lista`/`pasando`/`pasada`/`volviendo`/`dando_de_baja`/`terminada`/`cancelada`; **un solo cambio abierto por proyecto**, índice parcial), `paso`, `error`, `solo_web`, `hosts_json` (`[{serviceId, from, to, modo: redirigir/servir/no_cambiar}]`), `env_json` (`{excluidas, huella}`), `mailway_client_id`, `mailway_migration_id` (el estado del correo vive en Mailway), `servicios_json` (`{serviceId: {deploymentId, estado, error}}`), `pasada_at`, `terminada_at` |
| `domain_migration_snapshots` | valores anteriores al pasar, **en claro** como `env_vars`, para deshacer clave a clave: `(migration_id, ambito, service_id, key)` → `valor_original`, `valor_escrito` (`ambito`: `service`/`project`/`build`, o `domains` con la lista de dominios del servicio). Se purgan al volver, al terminar, al dar de baja y al cancelar |
| `domain_redirects` | redirecciones del nombre viejo al nuevo: `host` (PK), `project_id` (cascada; sobreviven al borrado del servicio), `to_host`, `migration_id`, `permanent_from`, `created_at` |
| `domain_prepublished` | nombres nuevos servidos antes de pasar: `host` (PK), `project_id`, `service_id` (cascada), `migration_id`, `dns_ok_at` (solo se publican con él), `created_at` |
| `github_installations` | instalaciones de la GitHub App: `id`, `installation_id`, `account_login`, `account_type`, `repo_selection`, `project_id` (null = global del administrador), `created_by`, `last_used_at`, `suspended`. **No guarda credenciales**: el token de clonado se emite bajo demanda y caduca en una hora |

`config` de servicio (ver `types.ts`): `GitConfig`, `DatabaseConfig`, `ImageConfig`
comparten `domains`, `hostPort`, `cpus`, `memoryMb`, `diskMb`, `healthcheckPath`,
`volumes`, `replicas`; git añade `repoUrl`, `githubInstallationId`, `connectorId`,
`branch`, `rootDir`, `dockerfilePath`, `builder`, `startCmd`, `buildCmd`, `port`,
`portAuto`, `buildArgs`, `webhookSecret`, `autoDeploy`, `needs` (detección del último
despliegue) e `integrationsPending` (variables que el `skyway.json` pide y esperan
aprobación); database añade `template`, `version`, `backupSchedule`, `backupRetention`.

### 3.1 Borrado de proyectos y servicios, y datos sin proyecto (`purge.ts`)

Borrar un proyecto o un servicio borra **siempre** sus datos; no hay opción para
conservarlos (hasta la 0.35 los volúmenes solo se borraban con `?volumes=true`,
una casilla que venía desmarcada). Un volumen que sobrevive a su proyecto es
peligroso: los volúmenes se nombran por slug (`skyway-<proyecto>-<servicio>-data`,
`skyway-<proyecto>__<prefijo>__<clave>` en las pilas) y se crean con
`Binds "nombre:ruta"`, sin etiquetas, así que un proyecto nuevo con el mismo
nombre y un servicio con el mismo nombre montaba los datos viejos.

Orden del borrado (la API exige la confirmación con el nombre, §7.3 y §7.4, y
Docker disponible: sin él responde 503 sin tocar nada):

1. Marca sus servicios como «eliminándose» (`markServicesDeleting`): mientras
   dura el borrado, un despliegue nuevo (webhook de GitHub, autodeploy,
   `deploy-all`, botón) nace cancelado y uno que estaba construyendo se cancela
   antes de crear el contenedor. Cancela los despliegues en cola o en marcha y
   espera hasta 15 s a que terminen (uno a medias volvería a crear contenedor,
   red y volumen).
2. Retira sus contenedores por etiqueta (réplicas y restos de intercambios) con
   sus volúmenes **anónimos** (`v: true`; nunca afecta a los que tienen nombre).
   Si falla la parada, se intenta igualmente la retirada forzada. **Si un
   despliegue no termina de cancelarse, o algún contenedor no se puede enumerar
   o retirar, el borrado se interrumpe aquí con 409** y la lista de motivos en
   `warnings`, sin tocar volúmenes ni filas: seguir dejaba un contenedor sin
   proyecto, sirviendo su dominio y montando su volumen (que por estar en uso no
   aparece en «Datos sin proyecto»). Reintentar es seguro.
3. Borra los volúmenes que declaran (`serviceVolumeNames`: el de datos de una
   base de datos y los de `config.volumes`), salvo los que declare un servicio
   que se queda —las pilas comparten volumen entre servicios; con otro proyecto
   es una coincidencia de nombres y se avisa—, los que empiecen por el prefijo
   de un servicio (`skyway-<p>-<s>-`) o de un proyecto (`skyway-<p>__`) de
   **otro proyecto** (por la ambigüedad de los guiones, `a` + `b-c` y `a-b` + `c`
   generan los mismos nombres: sin esto, borrar el primero se llevaba una ruta
   quitada del segundo, aunque fuera de otra cuenta; se conserva con aviso) y
   los que monte otro contenedor.
4. Borra las imágenes que Skyway construyó para ellos (`skyway/<p>-<s>:…` de sus
   despliegues) que ningún otro servicio referencia; nunca las de los servicios
   de imagen. Sin `force`: una imagen en uso no se borra (aviso).
5. Borra sus copias de seguridad en disco (`DATA_DIR/backups/<serviceId>`).
6. Proyecto: borra su red (nunca `skyway-edge`, la de Traefik, aunque el
   proyecto se llame «edge»).
7. En la base del panel: cierra (resuelve y marca como leídas) sus alertas,
   borra el informe de importación (`importReport:<id>`, lleva comandos con
   contraseñas) y el cliente de correo anterior, olvida `mailway.serviceId` si
   era uno de sus servicios, **libera sus reservas de dominio** y borra la fila
   (el resto cae en cascada).
8. Barre los restos de lo que se acaba de borrar que no figuraban en su
   configuración (una ruta quitada en Ajustes, volúmenes de un proyecto anterior
   con el mismo nombre borrado sin sus datos), con la regla de los huérfanos.

Lo que no se puede retirar a partir del paso 3 vuelve en `warnings` para
hacerlo a mano, y su texto queda también en el detalle de la auditoría
(`project_deleted`, `service_deleted`, recortado). Se conservan
a propósito el registro de auditoría (el detalle de `project_deleted` lleva el
slug), las métricas y el uso para facturación (caducan a los ~90 días), el
cliente de correo y sus buzones en Mailway (se suelta la referencia) y los
registros DNS de Cloudflare.

**Reservas de dominio** (`cloudflare_dns_records`, `mailway_dns_reservas`): no se
borran, porque el registro A sigue existiendo en Cloudflare y apuntando a este
servidor; pasan a `project_id = NULL`. Con NULL ningún proyecto coincide, así que
solo el administrador puede volver a asignarse el nombre (`domainguard.ts`), igual
que antes, y Ajustes → Cloudflare lo muestra como «Sin uso · proyecto eliminado».
Al arrancar la 0.36, una migración única (`migrations:deleted_project_refs_v1`)
hace lo mismo con las reservas que dejaron los borrados anteriores (las que
apuntan a un proyecto que ya no existe) y cierra las alertas abiertas de
proyectos o servicios que ya no existen.

**Datos sin proyecto** (Ajustes, solo administrador con sesión): volúmenes y
copias de seguridad que dejaron los borrados anteriores. Un volumen es huérfano
solo si se cumplen todas:

- nombre exacto de Skyway: `^skyway-[a-z0-9]+(-[a-z0-9]+)+-data([2-9]|[1-9][0-9]+)?$`
  o `^skyway-<slug>__<slug>__<slug>$` (los de Compose llevan `_`: `skyway_skyway-data`
  no encaja, y `skyway-data` tampoco);
- controlador `local` y **sin etiquetas** (las llevan los de Compose —Skyway,
  Traefik, Mailway— y los anónimos);
- no lo declara ningún servicio vivo (de ningún tipo; también `volumeName`);
- no lo monta **ningún contenedor**, aunque esté parado;
- no empieza por `skyway-<proyecto>-<servicio>-` de un servicio vivo ni por
  `skyway-<proyecto>__` de un proyecto vivo (rutas quitadas, ambigüedad de los
  guiones: `acme` + `prod-web` y `acme-prod` + `web` dan el mismo nombre).

Las copias huérfanas son las carpetas `backups/svc_<16 hex>` cuyo servicio ya no
existe (nunca `backups/skyway`, las del panel). Nunca es automático: el listado
solo propone y el borrado exige escribir «eliminar»; el servidor **recalcula** la
lista en ese momento y cada nombre pedido debe seguir siendo huérfano (el resto
vuelve en `skipped` con el motivo). Cada borrado se audita
(`orphan_volume_deleted`, `orphan_backup_deleted`). Cada carpeta de copias
muestra el nombre de su copia más reciente (`latestFile`, que lleva el proyecto
y el servicio). Nunca se usa `docker volume
prune`. Si se va a restaurar una copia del panel que incluya esos proyectos, no
deben eliminarse antes. Quedan fuera los volúmenes anónimos que dejaron
contenedores ya retirados (no se pueden atribuir; los redespliegues siguen
retirando el contenedor anterior sin ellos, porque son la única copia que
quedaría de los datos de una imagen cuyo `VOLUME` no se configuró como ruta
persistente), las imágenes `skyway/…` de proyectos borrados antes de la 0.36
(no son datos: se pueden reconstruir y ningún proyecto nuevo las hereda) y dos
instancias de Skyway contra el mismo Docker (los de la otra parecerían
huérfanos).

---

## 4. Modelo de seguridad

- **Contraseñas**: hash **scrypt** (`crypto.scryptSync`, N=16384, salt de 16 B,
  64 B de salida), formato `s2:salt:hash`, comparación en tiempo constante
  (`timingSafeEqual`). Nunca se guardan ni registran en claro. (`util.ts`)
- **Sesiones**: JWT **HS256** (algoritmo fijado en firma y verificación) en cookie
  `httpOnly`, `SameSite=Lax`, `Secure` sobre HTTPS, TTL 30 días. El `session_epoch`
  del usuario invalida todas las cookies previas al cambiar/restablecer contraseña.
  Rotar `jwtSecret` (Panel de seguridad) invalida **todas** las sesiones.
- **Tokens de API** (`sky_…`): se guardan **hasheados** (sha256); el valor en
  claro solo se muestra al crearlos. Heredan los permisos del usuario, son
  revocables y caducables, y quedan auditados. Crear tokens/passkeys exige
  **sesión de navegador** (`requireSession`), no un token: un token robado no
  puede fabricarse acceso persistente. La única otra vía es la terminal del
  servidor (`tools/token.ts`, §9), sin endpoint HTTP: quien la ejecuta ya
  controla el Docker en el que corre Skyway.
- **Roles**: `admin` (control total del servidor), `owner` (propietario de un
  workspace: gestiona sus proyectos, crea sub-usuarios en él, acota sus módulos y
  ve su facturación; nunca toca ajustes del servidor, otros workspaces, su propia
  cuota ni la concesión de módulos) y `member` (limitado a los proyectos que se le
  asignan dentro de su workspace). `assertProjectAccess` protege cada recurso de
  proyecto; `assertProjectManage`/`assertWorkspaceAccess` protegen la estructura y
  la cuenta. La creación de sub-usuarios exige **sesión de navegador**
  (`requireSession`), como los tokens/passkeys.
- **Cuota agregada y módulos**: cada workspace tiene una cuota (CPU, RAM, disco,
  proyectos, servicios, usuarios) acotada a **todos sus proyectos en total**
  (`quota.ts`). Se comprueba al crear proyectos/servicios/usuarios y al subir los
  recursos de un servicio; un workspace **suspendido** detiene despliegues y
  operaciones nuevas. El admin la amplía/recorta en vivo; el propietario solo
  **acota** (desactiva) los módulos concedidos, nunca los amplía. La comprobación
  de cuota es atómica (lectura+escritura síncrona, sin `await` intermedio) y
  cubre todas las dimensiones. Las gates de módulo se aplican de verdad a
  propietarios y miembros (el admin las traspasa): bases de datos, consola de
  datos, archivos, backups, terminal, réplicas, dominios y conectores de GitHub.
- **Token de Cloudflare del operador**: lo guarda el administrador (Ajustes →
  Cloudflare o `tools/cloudflare.ts`) y da acceso a **sus** zonas. Solo se usa
  en peticiones de un administrador (cookie o token `sky_` de un admin): para
  un propietario o un miembro no se lee el token, no se consulta la IP y no
  sale ninguna petición a Cloudflare, ni directa ni a través de Mailway (el alta
  de correo de quien no es admin va con `autoDns: false` y `?soloCliente=1`, y
  la del admin solo pide `autoDns` a un Mailway que declara
  `features.cloudflareSoloCrear`).
  Al editar un servicio solo se procesan los dominios **nuevos** respecto a la
  base de quien edita (`domainsBase`): un administrador que guarda el servicio
  de un cliente, aunque sea con un formulario anterior a un cambio del cliente,
  no crea los registros de los dominios que puso el cliente. Los nombres
  creados quedan reservados al proyecto para el que se crearon hasta que el
  administrador borra su registro (también si Cloudflare lo creó pero su
  respuesta se perdió: al reintentarlo, un A hacia este servidor con el
  comentario «Skyway» se anota). Lo mismo con los nombres A, AAAA o CNAME que
  Mailway crea para el administrador (autoconfiguración y webmail del correo,
  tabla `mailway_dns_reservas`): siguen apuntando aquí aunque se borre el
  dominio de correo o se desconecte Mailway, y solo su proyecto (o el
  administrador, que puede reasignarlos) puede asignárselos. Nunca se modifica un registro y solo se
  borra, a petición del administrador, uno que creó Skyway y nadie ha cambiado
  (§7.13).
- **Anti fuerza bruta**: límite por IP (8 intentos / 15 min) en login por
  contraseña y por passkey. La IP real se obtiene respetando el proxy **solo**
  de rangos privados/loopback (`config.trustProxy`), de modo que un cliente en
  internet no puede falsear `X-Forwarded-For` para evadir el límite. Lo mismo
  vale para `X-Forwarded-Host` y `X-Forwarded-Proto` (HSTS, cookie `Secure`,
  guarda CSRF y URLs públicas del panel): solo cuentan si los envía un proxy
  de confianza.
- **IP real detrás del proxy de Cloudflare** (`docker-compose.yml`): Traefik
  respeta el `X-Forwarded-For` que manda Cloudflare solo en el 443 y solo si la
  conexión viene de sus rangos publicados (`CLOUDFLARE_IPV4` y
  `CLOUDFLARE_IPV6` en `domains.ts`; una prueba comprueba que coinciden con el
  compose). Las apps reciben así la IP del visitante: la primera de
  `X-Forwarded-For` empezando por la derecha que no sea de Cloudflare ni de la
  red de Docker (lo de su izquierda lo puede escribir el visitante).
  `X-Real-Ip` sigue siendo la del nodo de Cloudflare, y `CF-Connecting-IP` solo
  es fiable si la petición llega de Cloudflare: cualquiera que conecte
  directamente puede escribirla. De cualquier otra IP, Traefik borra las
  cabeceras `X-Forwarded-*` como siempre. En el 80 no se confía en nadie: con
  el modo SSL/TLS «Flexible», Cloudflare entra por ahí diciendo «https» y, si
  se le creyera, la web se serviría sin cifrar entre Cloudflare y el servidor
  en lugar del bucle que Skyway detecta y avisa. El panel no cambia: su
  `trustProxy` solo confía en rangos privados, así que detrás de Cloudflare
  su límite de intentos cuenta la IP del nodo de Cloudflare, como antes, y
  nadie puede falsearla.
- **Cabeceras de seguridad** (todas las respuestas, `app.ts`): `Content-Security-Policy`
  (mismo origen; sin scripts externos ni inline), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` restrictiva y
  `Strict-Transport-Security` sobre HTTPS. Única excepción de la CSP:
  `form-action` admite además `https://github.com`, porque crear la GitHub App
  exige que el navegador envíe el manifiesto por POST a github.com (no hay forma
  servidor-a-servidor). No afecta a scripts, estilos ni peticiones.
- **Saltos a GitHub**: el estado anti-CSRF de crear e instalar la App viaja
  **firmado** (HS256 con el secreto de sesión, 30 min) en vez de guardado, y al
  volver se comprueba además que la sesión sea la del mismo usuario. Las rutas de
  retorno exigen sesión de navegador; las de creación, además, rol admin.
- **Webhooks**: firma **HMAC-SHA256** verificada con comparación en tiempo
  constante sobre el cuerpo crudo. El de la GitHub App usa el secreto que GitHub
  generó al crearla, y antes de desplegar comprueba que el proyecto del servicio
  tenga conectada **esa** instalación (si no, cualquiera que instalase la App en
  un repo homónimo dispararía despliegues ajenos). El webhook de Stripe añade
  tolerancia temporal (anti-replay) y solo actúa si Stripe confirma
  `payment_status == paid`; las claves de Stripe se guardan en `settings` y nunca
  se devuelven en claro.
- **Consola de BBDD y explorador de archivos**: todo corre **dentro** del
  contenedor con exec; las consultas/rutas viajan como variables de entorno del
  exec, **nunca interpoladas en el shell**. La consola tiene modo solo-lectura
  por defecto (reforzado en el propio motor). El mismo patrón cubre el comando
  previo al despliegue y la copia de datos entre bases: el comando y las URLs de
  conexión viajan por entorno y el shell los lee con `"$VAR"`. En el comando
  previo, además, los nombres que la CLI de Docker respeta en su entorno no se
  le entregan como entorno (ver «Pipeline de despliegue»). El comando al parar
  (`stopCommand`) sigue el mismo patrón: viaja en `SKYWAY_STOP_CMD` del exec y se
  ejecuta con la orden fija `eval "$SKYWAY_STOP_CMD"` dentro del contenedor del
  servicio. A diferencia del comando de arranque, que solo corre al desplegar,
  se ejecuta en el contenedor en marcha en cada parada, también al pulsar
  Reiniciar: equivale a la terminal (`POST /services/:id/exec`) y tiene sus
  mismas protecciones. Guardarlo exige el módulo «Terminal de comandos» y un
  workspace no suspendido (la administración lo salta), y el cambio queda en la
  auditoría como `service_stop_command`, con los primeros 120 caracteres.
  `rootDir` y `dockerfilePath` se confinan al repositorio clonado (`paths.ts`).
- **Superficie crítica**: quien accede a Skyway controla el Docker del host. El
  `docker-compose` publica la UI solo en `127.0.0.1:4000` (acceso por dominio+TLS
  vía Traefik, o túnel SSH). Recomendado: contraseña fuerte, dominio con TLS o
  VPN, y revisar la auditoría.

Ver el informe **[AUDITORIA.md](AUDITORIA.md)** para el detalle de hallazgos.

---

## 5. Tipos de servicio y sus opciones

Los tres tipos se editan con `PATCH /api/services/:id` (campo `config`). Cambiar
un campo de *redeploy* marca `needsRedeploy: true`; los recursos (CPU/RAM) se
aplican **en caliente**.

| Opción | git | image | database | Notas |
| --- | --- | --- | --- | --- |
| `repoUrl`, `branch`, `rootDir`, `dockerfilePath`, `startCmd` | ✓ | — | — | build del repo |
| `buildCmd` | ✓ | — | — | comando de compilación con Nixpacks (equivale al «Build Command» de Railway) |
| `builder` | ✓ | — | — | `auto` (def.), `dockerfile` o `nixpacks`. Elegirlo manda sobre `railway.json` (§5.3) |
| `portAuto` | ✓ | — | — | interno: marca que el puerto lo puso Skyway y nadie lo eligió. Ver «Puerto interno» abajo |
| `githubInstallationId` | ✓ | — | — | instalación de la GitHub App con la que clonar (§5.4) |
| `connectorId` | ✓ | — | — | conector con token personal para clonar (null = token global) |
| `buildArgs` | ✓ | — | — | `--build-arg` |
| `image` | — | ✓ | — | imagen pública |
| `template`, `version` | — | — | ✓ | postgres/redis/mysql/mongo/minio |
| `port` (interno) | ✓ (def. 3000) | opcional (null = **worker**) | fijo por plantilla | Traefik enruta a este puerto |
| `domains` | ✓ | ✓ | — | Traefik + TLS; cada dominio registrable o con www nuevo llega con su pareja con o sin www (§5.5) |
| `dominiosSinPareja` | ✓ | ✓ | — | dominios cuya pareja con o sin www se ha descartado; solo los de `domains` a los que les falta (§5.5). No pide volver a desplegar |
| `hostPort` (público) | ✓ | ✓ | ✓ (⚠ expone BBDD) | salta Traefik |
| `cpus`, `memoryMb` | ✓ | ✓ | ✓ | en caliente |
| `diskMb` | ✓ | ✓ | ✓ | cuota orientativa, vigilada por el monitor |
| `healthcheckPath` | ✓ | ✓ | — | validación del deploy |
| `volumes` | ✓ | ✓ | fijo (su volumen) | conserva nombre al editar |
| `replicas` (1–10) | ✓ | ✓ | 1 | requiere sin volúmenes ni hostPort; con «una sola copia», todas se detienen antes de arrancar las nuevas |
| `deployStrategy` | ✓ | ✓ | — | «Al desplegar»: `recreate` («Una sola copia») u `overlap` («Sin corte»); ausente = automática (§2). Con volúmenes o puerto público, siempre una sola copia. No pide volver a desplegar: vale desde el siguiente despliegue |
| `stopGraceSeconds` | ✓ | ✓ | ✓ (10–600) | gracia de parada (SIGTERM → SIGKILL), entero 0–600; ausente = `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` o 30 (§2). En una base de datos, de 10 a 600 y sin la variable de Railway: ausente = 30. Las paradas de Skyway leen siempre el valor actual; el `StopTimeout` del contenedor se actualiza en el siguiente despliegue. No pide volver a desplegar |
| `stopCommand` | ✓ | ✓ | — | comando al parar (hasta 1000 caracteres): se ejecuta dentro del contenedor antes del SIGTERM, con la gracia como plazo (§2). Guardarlo exige el módulo «Terminal de comandos» (§4). No pide volver a desplegar |
| `autoDeploy` | ✓ | — | — | sondeo de la rama; despliega al haber commit nuevo (opt-out) |
| `needs` | ✓ | — | — | interno: dependencias detectadas en el repo en el último despliegue (§5.5), con el correo y el `skyway.json`. Se reescribe en cada clonado |
| `integrationsPending` | ✓ | — | — | interno: variables que el `skyway.json` pide y esperan aprobación (§5.7): las bases, de cualquiera con acceso al proyecto; el correo, de quien lo gestiona. La tarjeta del servicio muestra «Pendiente de aprobar» |
| `backupSchedule`, `backupRetention` | — | — | ✓ | diario/semanal ~04:00 |
| `alertsMuted` | ✓ | ✓ | ✓ | silencia alertas del servicio |

**Worker/módulo sin HTTP**: un servicio `image` con `port: null` (o un `git` cuyo
proceso no escucha) corre en segundo plano; sin puerto no se crea router de
Traefik y la validación del deploy usa el periodo de gracia en vez del healthcheck.
Esto reproduce el comportamiento de un *worker* de Railway. Sin dominio, sin
healthcheck y sin otros servicios que lo llamen, se despliega con **una sola
copia** (§2): la versión anterior se detiene antes de arrancar la nueva.

**Ajustes → Despliegue y parada** (servicios de repositorio y de imagen; en una
base de datos, solo la gracia):

- **Al desplegar**: «Automático (recomendado) — ahora: Una sola copia» (o «Sin
  corte», según la regla del §2 aplicada al formulario y a `deploy.calledByOthers`,
  `deploy.repoHealthcheckPath` y `deploy.botLibraries` del servidor; la ayuda
  dice qué la decide, también la ruta de healthcheck del repositorio o la
  biblioteca de bots), «Una sola copia: se detiene la versión anterior antes de arrancar
  la nueva; unos segundos sin servicio. Recomendado para bots y workers.» y «Sin
  corte: la versión nueva se valida antes de retirar la anterior; durante unos
  segundos hay dos copias.». Con volúmenes o puerto público el selector está
  deshabilitado: «Con volúmenes o puerto público, la versión anterior siempre se
  detiene antes de arrancar la nueva.».
- **Gracia de parada (s)**: 0–600, con la gracia efectiva como marcador
  (`deploy.stopGraceSeconds`) y la ayuda «SIGTERM y, si el proceso no termina en
  este plazo, SIGKILL. Vacío: 30 s o RAILWAY_DEPLOYMENT_DRAINING_SECONDS.». En
  una base de datos, de 10 a 600 (vacío: 30 s).
- **Comando al parar** (texto monoespaciado): «Opcional. Se ejecuta dentro del
  contenedor antes del SIGTERM, con el mismo plazo.». Nunca pasa por un shell
  del host. Como corre en el contenedor en marcha en cada parada, guardarlo
  exige el módulo «Terminal de comandos», igual que la terminal (§4).
- **Réplicas sin tráfico**: con más de una réplica y un servicio que no recibe
  tráfico (la regla daría `sin_trafico`), Ajustes avisa en ámbar: «Este servicio
  no recibe tráfico (sin dominio, healthcheck ni llamadas de otros servicios):
  con N réplicas hay N copias en marcha a la vez de forma permanente. Un bot de
  polling (Telegram, Discord…) solo admite una; un worker tiene que repartir el
  trabajo con SKYWAY_REPLICA y SKYWAY_REPLICAS o usar una cola.»; para un bot de
  Telegram o Discord sin dominio, que esas réplicas son copias del bot y solo
  admite una. El registro del despliegue lo repite (ℹ). La nota de réplicas («siempre queda una réplica en
  servicio») solo aparece con «sin corte»; con «una sola copia»: «Con una sola
  copia, todas las réplicas se detienen antes de arrancar las nuevas.».

Los servicios `image` admiten además dos campos que rellenan las pilas y que la
API devuelve tal cual: `icon` (marca con la que el panel pinta el servicio, en vez
de adivinarla por el nombre de la imagen) y `stack` (pila de la que salió).

### 5.1 Pilas de aplicaciones (`stacks.ts`)

Una **pila** es una plantilla que crea **varios servicios coordinados de una vez**,
igual que el catálogo de bases de datos pero para aplicaciones completas. Se elige
en «Nuevo servicio → Aplicación completa».

| Pila | Servicios | Entrada pública |
| --- | --- | --- |
| **Supabase** | `db` (supabase/postgres), `rest` (PostgREST), `auth` (GoTrue), `realtime`, `meta` (postgres-meta), `imgproxy`, `storage`, `studio`, `kong` | `kong` (API + Studio) |
| **WordPress + MySQL** | `db` (MySQL gestionado), `app` | `app` |
| **Ghost + MySQL** | `db` (MySQL gestionado), `app` | `app` |
| **n8n + PostgreSQL** | `db` (Postgres gestionado), `app` | `app` |
| **Metabase + PostgreSQL** | `db` (Postgres gestionado), `app` | `app` |

Cómo funciona:

- **Nombres**: todos los servicios se llaman `<prefijo>-<clave>` (`supabase-db`,
  `supabase-kong`…). El prefijo se elige al crear la pila y se numera entero si
  alguno de esos nombres ya existe, así que dos instancias no se pisan.
- **Secretos**: los genera el servidor (contraseña de Postgres, `JWT_SECRET`, las
  claves `ANON_KEY`/`SERVICE_ROLE_KEY` firmadas HS256 con ese secreto, credenciales
  del Studio…) y viven **una sola vez**, en las variables del servicio *ancla* de
  la pila (el `db` en Supabase). El resto los referencia con `${{<ancla>.CLAVE}}`:
  rotar uno es editarlo ahí y redesplegar. **No** van a las variables compartidas
  del proyecto a propósito: esas se inyectan en el entorno de *todos* los
  servicios, incluidos los que se desplieguen después, y una clave `service_role`
  —que se salta el RLS— no tiene por qué acabar dentro de una imagen de terceros.
- **Bases de datos**: cuando la pila usa un motor estándar, el servicio es un
  `database` normal de Skyway, con sus copias de seguridad y su consola de datos.
  La de Supabase es una imagen propia (`supabase/postgres`), no una plantilla.
- **Ficheros de configuración**: no hay bind mounts, así que lo que el compose
  oficial montaría como fichero (la configuración declarativa de Kong) viaja en una
  variable de entorno y el comando de arranque la escribe antes de levantar el
  proceso.
- **Orden de arranque**: los servicios se despliegan **por etapas**; entre una y
  otra Skyway espera a que la base acepte conexiones de verdad (sondeo con
  `pg_isready`/`mysqladmin ping` dentro del contenedor) y aplica el SQL de
  inicialización que la pila necesite. Sin eso, lo que cuelga de la base arrancaría
  en bucle y su primer despliegue se daría por fallido.
- **Dominio**: es opcional. Con dominio, las URLs públicas de la pila son
  `https://<dominio>` (o `http://` si no hay TLS configurado) y lo recibe el
  servicio de entrada. Sin dominio, apuntan al alias interno del proyecto y la pila
  solo es accesible desde dentro.

La pila de Supabase se crea con el **alta pública de usuarios cerrada**
(`GOTRUE_DISABLE_SIGNUP=true`): con dominio, `/auth/v1/signup` queda expuesto a
internet, y como no hay SMTP configurado las altas se autoconfirman, así que
abrirlo de fábrica permitiría registrarse con cualquier correo ajeno ya
«verificado». Se abre cuando la aplicación lo necesite, desde las variables del
servicio `auth`.

### 5.2 Plantillas de Railway dentro de un proyecto

Además del catálogo propio, se puede instalar **cualquier plantilla del catálogo
público de Railway** dentro de un proyecto existente, pegando su URL
(`railway.com/new/template/<código>`) o su código. El catálogo de Railway es
público: no hace falta token.

- **Se respeta lo que dice la plantilla**: cada servicio se crea con la imagen o
  el repositorio que declara. A diferencia de la importación de un proyecto
  ajeno, aquí **no** se sustituye una imagen por una base de datos gestionada de
  Skyway: el «Postgres» de una plantilla suele ser una imagen propia con sus
  roles y extensiones, y cambiarlo rompería todo lo que cuelga de él.
- **Se adapta el cableado**: las variables mágicas de Railway se traducen igual
  que en la importación de proyectos (§6), y las referencias entre servicios se
  reescriben al **slug** del destino — el nombre original puede llevar espacios o
  comillas (`${{"Supabase Studio".JWT_SECRET}}`), que el resolutor de Skyway no
  admite, y además los servicios se renombran con el prefijo de la instalación.
- **Orden de arranque**: bases de datos primero (con sondeo real de arranque),
  después las aplicaciones y la puerta de entrada al final. No se deduce del
  grafo de referencias: en una plantilla real ese grafo es cíclico, porque las
  variables sirven para cablear, no para ordenar.
- **Los buckets de Railway se resuelven en local**, y por este orden. Primero se
  intenta lo simple: si la aplicación que usa el bucket sabe guardar en disco, se
  le activa ese modo y se le monta un volumen — el bucket deja de hacer falta y
  hay un contenedor menos. Hoy se conoce el de **Supabase Storage**
  (`STORAGE_BACKEND=file`); ampliar la lista es añadir una entrada a
  `FILE_BACKENDS` en `railway/template.ts`. Si alguien sigue necesitando hablar S3
  —porque no sabemos desactivárselo—, entonces se levanta un **MinIO** en el
  proyecto, con el bucket ya creado en su volumen y las credenciales cableadas en
  las variables que la plantilla referencia (`${{S3.ACCESS_KEY_ID}}` y compañía),
  cuyos nombres se leen de la plantilla en vez de adivinarse. En los dos casos los
  ficheros acaban en un volumen del servidor y nada sale de él.
- **Lo que no tiene equivalente se dice antes de crear nada**: variables que la
  plantilla deja en tu mano, servicios que exponen más de un dominio, o
  referencias a servicios que no existen.

Lo que la pila de Supabase **no** incluye: **Edge Functions** (requiere montar el
código de las funciones dentro del contenedor), el pooler **supavisor** (se conecta
directamente a Postgres) y **analytics/logflare** — y por tanto la pestaña de Logs
del Studio, que viene desactivada.

---

### 5.3 Config-as-code de Railway (`railway.json` / `railway.toml`)

Un proyecto traído de Railway suele llevar su configuración dentro del
repositorio, y allí **manda sobre el panel** —esa es la precedencia de Railway y
Skyway la reproduce—. Se busca en el directorio raíz del servicio (monorepos) y
después en la raíz del repo; se admiten JSON y un subconjunto de TOML.

| Clave | Efecto en Skyway |
| --- | --- |
| `build.builder` | `DOCKERFILE` exige Dockerfile; `NIXPACKS`/`RAILPACK` lo ignoran aunque exista. Ver más abajo la precedencia |
| `build.buildCommand` | `NIXPACKS_BUILD_CMD` al construir sin Dockerfile |
| `build.dockerfilePath` | Dockerfile alternativo (también con la variable `RAILWAY_DOCKERFILE_PATH`, que va por delante) |
| `deploy.startCommand` | comando de arranque del contenedor |
| `deploy.preDeployCommand` | se ejecuta antes del intercambio; si falla, el despliegue se aborta |
| `deploy.healthcheckPath`, `deploy.healthcheckTimeout` | validación del despliegue |
| `deploy.restartPolicyType`, `restartPolicyMaxRetries` | política de reinicio de Docker (`NEVER`→`no`, `ON_FAILURE`→`on-failure`, `ALWAYS`→`unless-stopped`) |
| `deploy.numReplicas` | **no se aplica**: las réplicas consumen cuota del workspace y se fijan en Ajustes. Se avisa en el log |
| `deploy.cronSchedule` | **no se aplica**: Skyway aún no ejecuta servicios programados. Se avisa en el log |
| `deploy.drainingSeconds`, `deploy.overlapSeconds` | **no se aplican**: se leen y solo se indican en el registro (ℹ). La gracia de parada se fija en Ajustes del servicio → Despliegue y parada o con la variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`; el solape de Railway no tiene equivalente (§5.5) |
| `build.watchPatterns` | sin efecto |

La configuración leída se guarda con el despliegue (`deployments.repo_config`),
de modo que reutilizar una imagen o hacer rollback recupera **la configuración
de ese commit**, no la del último.

**Qué constructor se usa**, de más prioridad a menos:

1. El ajuste `builder` del servicio (Ajustes → Constructor), si no es `auto`.
   Es una decisión explícita y gana a todo lo demás, incluido `railway.json`.
   Sirve para tener un repo válido para Docker y para Railway a la vez y
   decidir en Skyway con cuál se construye, sin tocar el repositorio.
2. `build.builder` del fichero de configuración del repo, **salvo** que pida
   Nixpacks sobre un servicio cuyo último despliegue correcto se hizo con el
   Dockerfile: ahí se mantiene el Dockerfile y se avisa en el log. Cambiar de
   constructor cambia el comando de arranque y el entorno entero, y eso no debe
   pasarle solo por añadir un fichero a un servicio que ya va. Para forzarlo,
   se elige a mano (punto 1).
3. La regla de siempre: Dockerfile si lo hay, Nixpacks si no.

Si el fichero pide Nixpacks, hay Dockerfile y `nixpacks` no está instalado en el
servidor, se construye con el Dockerfile y se avisa. Elegido a mano, en cambio,
el despliegue falla con el motivo: no se entrega en silencio una imagen distinta
de la pedida.

**Puerto interno.** Skyway inyecta `PORT` y confía en que la aplicación lo
respete; cuando no lo hace y escucha en otro sitio, el proceso sigue vivo, el
despliegue sale verde y el dominio da 502. Desde la v0.31 el desplegador
contrasta el puerto configurado con el `EXPOSE` de la imagen construida:

- Si no coinciden, **siempre se avisa en el log** y el diagnóstico de un
  healthcheck fallido señala el desajuste concreto.
- Solo se **adopta** el de la imagen en el primer despliegue de un servicio cuyo
  puerto nadie eligió (`portAuto`), que nunca ha desplegado bien y cuya imagen
  expone un único puerto. Se deja escrito en el log y se guarda en los ajustes:
  a partir de ahí es una decisión, no una suposición.
- Un puerto elegido a mano, o un servicio que ya despliega bien, **no se toca
  nunca**. `EXPOSE` se hereda de la imagen base y miente a menudo.

**Dominio sin puerto.** Un servicio de imagen puede no tener puerto interno (así
se declara un worker), pero entonces no se le pueden poner etiquetas de Traefik:
no hay router, no hay certificado y el dominio responde 404. Antes se guardaba
sin más y el log decía «Dominios activos». Ahora la API rechaza crear esa
combinación, el log del despliegue la explica, el panel avisa junto al dominio y
el escáner de seguridad la marca en los servicios que ya la tenían.

**Variables que entraron en el build.** Skyway reutiliza la imagen cuando el
commit y la huella de compilación no han cambiado, sin llegar a clonar. Con
Dockerfile, qué variables entran lo deciden los `ARG` que declare el repo, y eso
no se sabe sin clonar: por eso cada despliegue guarda en `build_vars` un digest
de las que consumió. Al reutilizar se comparan; si alguna cambió, se compila de
nuevo y se dice cuál. Los despliegues anteriores a este registro no tienen
`build_vars` y se reutilizan como siempre: actualizar Skyway no recompila nada.

### 5.4 Credenciales de GitHub

Tres caminos, resueltos en un único sitio (`github/resolve.ts`) para que el
despliegue, el sondeo y el webhook usen siempre la misma credencial:

1. **GitHub App** (recomendado). El administrador la crea desde Ajustes con el
   flujo de manifiesto de GitHub: el navegador envía a github.com un formulario
   ya relleno (permisos `contents:read` y `metadata:read`, evento `push`, URL del
   webhook y retornos) y GitHub devuelve un código de un solo uso que Skyway
   canjea por el id de la App, su clave privada y el secreto del webhook. A
   partir de ahí, cada cuenta u organización se conecta pulsando «Conectar con
   GitHub» y eligiendo allí qué repositorios ve Skyway.
   La conexión **no caduca** y no guarda credenciales: para clonar se emite un
   token de instalación de una hora, cacheado en memoria y renovado con margen.
   Una instalación puede ser **del proyecto** (la conecta el cliente) o
   **global** (la conecta el administrador y sirve para todos). Una instalación
   ya conectada a otro proyecto o al servidor solo la reasigna el administrador
   (el id que GitHub devuelve al instalar es adivinable). El nombre y el slug de
   la App se **refrescan desde GitHub** (como mucho una vez cada 5 min):
   renombrarla allí ya no deja en 404 su enlace ni el de «Conectar cuenta». El
   enlace para elegir repos es la página real de ajustes de la instalación
   (`github.com/settings/installations/<id>` u
   `github.com/organizations/<login>/settings/installations/<id>`).
   La App **solo ve los repos de las cuentas donde está instalada**: un repo
   ajeno donde el usuario es solo colaborador no aparece en su lista.
2. **Conector con token personal** (`connectorId`): lo anterior, disponible para
   cuentas donde no se puede instalar una App y para repos ajenos donde se es
   colaborador (un token **clásico** con permiso `repo` ve todo lo que ve el
   usuario; uno fine-grained, solo lo concedido). El token se guarda y se
   enmascara en los logs.
3. **Token global** (`settings.githubToken`): el atajo del administrador.

Un servicio sin cuenta elegida busca una instalación que ya vea la cuenta del
repositorio antes de caer al token global. Una instalación de OTRO proyecto no
vale aunque se escriba su id a mano.

En el panel, el selector de repos admite además **pegar la URL o escribir
`owner/repo`**: si no está en la lista se comprueba al momento con la cuenta
elegida (rutas `…/repos/lookup`) y, si esa cuenta no lo ve, el error explica el
motivo y qué hacer. Bajo el campo de URL (al crear un servicio o en sus ajustes)
un aviso dice si la cuenta elegida, el token global o nadie va a poder clonarlo.

### 5.5 Variables de sistema y de compatibilidad con Railway

**Variables de sistema.** Skyway calcula de cada servicio, sin que nadie las
escriba, por dónde se le llama dentro del proyecto y por qué dominio se le llega
desde fuera (`systemVars` en `variables.ts`):

| Variable | Valor | Cuándo existe |
| --- | --- | --- |
| `INTERNAL_HOST` | slug del servicio (su nombre DNS en la red del proyecto) | siempre |
| `INTERNAL_PORT` | puerto interno (plantilla en BBDD; elegido en imagen; elegido o 3000 en repo) | si tiene puerto |
| `INTERNAL_URL` | `http://<slug>:<puerto>` | repo/imagen con puerto (una BBDD ya exporta su `DATABASE_URL`, `REDIS_URL`…) |
| `PUBLIC_DOMAIN` | dominio principal del servicio (ver abajo) | si tiene dominio |
| `PUBLIC_URL` | `https://<dominio principal>` (o `http://` sin Let's Encrypt) | si tiene dominio |

**Dominio principal.** Con varios dominios, el que se publica como dirección de
la web (`PUBLIC_DOMAIN`, `PUBLIC_URL`, `RAILWAY_PUBLIC_DOMAIN`,
`RAILWAY_STATIC_URL`, `self.public_url` del manifiesto) lo decide una regla
fija, sin selector manual (`dominioprincipal.ts`): primero un dominio propio con
`www.`; después el resto de dominios propios en el orden guardado; el subdominio
generado (`<slug>.<dominio raíz>`) al final, salvo que sea el único. Antes era
el primero de la lista, que se guardaba en el orden en que se añadían: quien
daba de alta `ejemplo.com` y después `www.ejemplo.com` dejaba la URL pública
sin www (y con ella la URL canónica, las redirecciones y la indexación). La
lista se guarda ya en ese orden al crear o editar el servicio y al importarlo de
Railway, y el despliegue y el resolutor aplican la regla al leer: un servicio
guardado con el orden antiguo publica el principal correcto en el siguiente
despliegue. Reordenar no es añadir ni quitar: ni el DNS automático (§7.13) ni la
comprobación de `domainsBase` lo cuentan como cambio, y el enrutado de Traefik
sigue atendiendo todos los dominios. Ajustes → Dominios enseña la lista en ese
orden con el chip «Principal» en el primero (con dos dominios o más).

**Pareja con o sin www.** Una web pública responde con y sin www, así que la
pareja no es una sugerencia: cada dominio propio **nuevo** que sea un dominio
registrable (`ejemplo.com`) o su www (`www.ejemplo.com`) se guarda con la otra
mitad (`completarParejasWww`; un subdominio más profundo como
`app.ejemplo.com` y lo que cuelga del dominio raíz de la plataforma no tienen
pareja; los sufijos de dos niveles más habituales, como `.com.es` o `.co.uk`,
están en una lista corta). Lo hace el servidor al crear el servicio, en el
PATCH, en las pilas y plantillas de Railway con `domain` y en la importación de
Railway (la vista previa ya la enseña, con una nota), así que la API, la línea
de comandos y las importaciones se comportan igual que el panel. Solo se
completan los dominios nuevos de cada cambio: guardar otra cosa o reordenar un
servicio antiguo al que le falta la pareja no la añade (ni pide volver a
desplegar ni llama a Cloudflare). La pareja que no se puede asignar (la usa
otro servicio, es del panel, de Mailway o está reservada) se omite sin error.
La renuncia expresa se guarda en `config.dominiosSinPareja` (los dominios cuya
pareja no se quiere): solo dominios de `domains` a los que les falta la pareja
(`limpiarSinPareja`; lo demás se descarta al guardar), así que nunca es mayor
que la lista de dominios (y la petición admite 200 como mucho). La pareja
añadida es un dominio nuevo más: pasa la misma comprobación de dominios y el
mismo DNS automático (§7.13), así que con Cloudflare configurado los dos
registros se crean en el mismo guardado.

Se usan de dos formas: **otro servicio las referencia** (`${{api.INTERNAL_URL}}`,
`${{web.PUBLIC_URL}}`) y el resolutor las aplica cuando el servicio apuntado no
tiene esa variable guardada; y **el propio servicio las recibe** en su entorno
al desplegar, calculadas con el puerto y los dominios de ese despliegue. Una
variable guardada con el mismo nombre gana siempre, en los dos casos. La
pestaña Variables las enseña en «Referencias del proyecto» con trazo discontinuo,
y Ajustes → Dirección interna ofrece la referencia lista para copiar: al cambiar
el puerto o el dominio se actualiza sola, cosa que un `http://api:3000` pegado a
mano no hace.

**Conectar a…** Cada plantilla de base de datos declara en `templates.ts` qué
variables de conexión exporta y con qué papel (`conn`: `main`, `host`, `port`,
`user`, `password`, `database`) y el juego mínimo que otro servicio necesita para
engancharse (`connect`: la URL; en MinIO, endpoint y credenciales). Es la única
tabla: la lee el panel, el importador de Railway y la detección de dependencias.
`GET /services/:id/env` devuelve por cada servicio del proyecto ese `connect`
(en una app con puerto, `INTERNAL_URL`), y la pestaña Variables lo convierte en
un botón «Conectar a <servicio>» que inserta de golpe las referencias que falten:
`DATABASE_URL=${{postgres.DATABASE_URL}}` para una base, `API_URL=${{api.INTERNAL_URL}}`
para otra app. Se aplican, como todo, al guardar y redesplegar.

**Detección de dependencias.** Al clonar un repositorio, antes de construir,
`needs.ts` mira en sitios fijos (en `rootDir` y en la raíz, sin recorrer el
árbol) qué motores usa y qué variables espera:

- Librerías inequívocas: `package.json` (`pg`, `ioredis`, `mongoose`, `mysql2`,
  `minio`, `@aws-sdk/client-s3`…), `requirements.txt`/`pyproject.toml`
  (`psycopg2`, `redis`, `pymongo`, `boto3`…), `go.mod`, `Gemfile`,
  `composer.json`. Un ORM multi-motor (typeorm, sqlalchemy, doctrine) no cuenta:
  no dice qué base hay detrás.
- `prisma/schema.prisma`: el `provider` da el motor y `env("…")` la variable.
- `docker-compose.yml`: las imágenes `postgres`, `redis`, `mysql`, `mongo`, `minio`.
- `.env.example` (o `.env.sample`, `.env.template`, `.env.dist`): los nombres de
  variable que la app espera. Un `REDIS_URL` delata Redis aunque la librería no
  esté en la lista; `DATABASE_URL` a secas asume PostgreSQL y lo dice.
- **Correo**: la web envía correo si depende (en producción) de una librería de
  envío —`nodemailer`, `resend`, `@sendgrid/mail`, `postmark`, `emailjs`,
  `mailgun.js`; `Flask-Mail`, `fastapi-mail`, `django-anymail`, `sendgrid`;
  `phpmailer/phpmailer`, `symfony/mailer`; `gomail`, `go-mail`; las gemas `mail`,
  `pony`, `postmark`…— o si su `.env.example` nombra variables de correo: cualquier
  `SMTP_*` y las de papel conocido de `MAIL_*`, `EMAIL_*`, `MAILER_*` y
  `MAILWAY_API_*` (`mailenv.ts`; un `EMAIL_VERIFICATION` suelto o las variables
  propias de Mailway, como `MAILWAY_SECRET`, no cuentan). Se guarda como `needs.mail`
  con el **modo sugerido** (API si pide `MAILWAY_API_KEY` o `MAILWAY_API_URL`; SMTP
  si no) y los **nombres exactos** que espera, con su papel. Esas variables no
  salen como «missing»: las escribe «Correo → Conectar a un servicio» (§6), y la
  pestaña Variables avisa de las que faltan.
- `skyway.json`: el manifiesto opcional de la web (§5.7). Si existe, manda sobre
  la detección.

El resultado se guarda en `config.needs` del servicio y se cuenta en el log del
despliegue («Dependencias detectadas…», «⚠ Faltan variables para esas
dependencias…»). `GET /services/:id/env` lo convierte en `suggestions`
(clave a crear, referencia lista si el proyecto ya tiene esa base, o `value:
null` si hay que crearla), `missing` (variables esperadas sin propuesta
automática) y `needs` (motores con su pista). Los nombres se casan por papel:
`DB_HOST` → `${{Postgres.PGHOST}}`, `S3_ACCESS_KEY` → `${{MinIO.MINIO_ROOT_USER}}`,
`NEXTAUTH_URL` → `${{<este servicio>.PUBLIC_URL}}` si tiene dominio. La pestaña
Variables lo pinta como aviso con «Añadir», «Añadir todas» y «Crear <motor> y
conectar» (crea la base en el proyecto y añade las referencias de golpe). Nada de
esto escribe una variable por su cuenta: todo se propone y se aplica al guardar y
redesplegar.

Lo mismo **antes de crear el servicio**: al elegir repositorio y rama en «Nuevo
servicio → Repositorio de GitHub», `GET /projects/:id/github/needs` pide a GitHub
(con la credencial que vaya a clonar) solo los ficheros candidatos que el árbol
del repo dice que existen (incluido `skyway.json`), los pasa por la misma
detección y devuelve las propuestas y el **plan de integraciones** (§5.7) contra
lo que ya hay en el proyecto. El asistente enseña el plan —bases que se crean o
se reutilizan, correo, secretos, URL propia y variables vacías— con una casilla
por recurso, y un solo botón: «Crear, aplicar el plan y desplegar». El servidor
vuelve a leer el repositorio, aplica el plan con los permisos de quien crea el
servicio y lanza el primer despliegue con todo puesto. Si GitHub no responde, el
alta sigue igual y el plan se puede aplicar después desde Variables. `env` en
`POST /projects/:projectId/services` sigue disponible para quien llame a la API.

**Compatibilidad con Railway.** En cada despliegue se rellenan las variables
mágicas de Railway con el
equivalente de Skyway, **sin pisar nunca** un valor definido por el usuario, para
que una aplicación migrada que las lea siga funcionando:

`RAILWAY_PROJECT_NAME`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_NAME`,
`RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME`,
`RAILWAY_DEPLOYMENT_ID`, `RAILWAY_REPLICA_ID` (por copia: igual que
`SKYWAY_INSTANCE_ID`; antes era el id del despliegue, el mismo en todas las
réplicas), `RAILWAY_PRIVATE_DOMAIN` (el alias
del servicio en la red del proyecto), `RAILWAY_TCP_PROXY_PORT`,
`RAILWAY_PUBLIC_DOMAIN` y `RAILWAY_STATIC_URL` (si el servicio tiene dominio: el principal),
`RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_MESSAGE` y `RAILWAY_GIT_BRANCH`.

Dos variables de Railway que gobiernan el relevo de versiones se tratan aparte:

- **`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` se lee**: si el servicio no tiene
  gracia de parada propia (`stopGraceSeconds`), su valor del entorno resuelto
  (solo dígitos, hasta 600; otro valor se descarta) es la gracia entre SIGTERM y
  SIGKILL (§2). Es exactamente lo que significa en Railway, y una app migrada
  que la fijó espera ese plazo. Ajustes indica de dónde sale la gracia
  (`deploy.stopGraceSource`: `servicio`, `railway` o `defecto`). Las bases de
  datos no la leen: en Skyway las variables compartidas también les llegan (en
  Railway, no), y su gracia nunca baja de 10 s.
- **`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` no se aplica.** En Railway, sin
  volúmenes, la versión nueva arranca antes y la anterior sigue activa esos
  segundos después de que la nueva esté lista (con un volumen, Railway detiene
  antes la anterior): alarga el solape, y con `0` no significa «una sola
  copia». Aplicarla solo serviría para que dos copias convivieran más tiempo, lo
  contrario de lo que necesita un bot. Si el entorno la define, el registro del
  despliegue lo indica (ℹ «Skyway no aplica RAILWAY_DEPLOYMENT_OVERLAP_SECONDS:
  …») y remite a Ajustes del servicio → Despliegue y parada, donde se elige la
  estrategia. Las claves `deploy.drainingSeconds` y `deploy.overlapSeconds` de
  `railway.json` solo se indican en el registro (§5.3).

**Variables de Skyway en cada copia.** Además de las de sistema, Skyway pone en
cada contenedor:

| Variable | Valor |
| --- | --- |
| `SKYWAY_PROJECT` | slug del proyecto |
| `SKYWAY_SERVICE` | slug del servicio |
| `SKYWAY_DEPLOYMENT` | id del despliegue (el mismo en todas sus copias) |
| `SKYWAY_INSTANCE_ID` | UUID nuevo por contenedor creado: distinto en cada réplica, en la copia de validación `--next` y en cada despliegue. Un «Reiniciar» conserva el contenedor y, con él, su valor |
| `SKYWAY_REPLICA` | índice de la réplica, de `1` a `N` (`--next` lleva `1`) |
| `SKYWAY_REPLICAS` | número de réplicas configuradas |
| `SKYWAY_VALIDATION` | `1` solo en la copia de validación `--next` (estrategia «sin corte»): una app puede evitar efectos de arranque (registrar un webhook, empezar a pedir actualizaciones, lanzar tareas) mientras se valida |

Sirven para que un worker con varias réplicas reparta el trabajo
(`SKYWAY_REPLICA` de `SKYWAY_REPLICAS`) y para distinguir en los registros o en
un servicio externo qué copia hizo qué. Para repartir por índice, el worker
tiene que ir con «una sola copia»: con «sin corte», durante el intercambio
conviven la copia anterior y la nueva con el mismo índice (y `--next` lleva el
1), así que ese tramo se procesaría dos veces. El contenedor lleva además las
etiquetas `skyway.instance` y `skyway.replica`.

### 5.6 Copia de datos desde una base externa

`datamigrate.ts` vuelca una base de datos externa —la de Railway, normalmente—
sobre una base gestionada del proyecto. Es el último paso de una migración y
antes obligaba a entrar por SSH al servidor.

- Motores: **PostgreSQL, MySQL y MongoDB**. Redis (caché) y MinIO quedan fuera.
- Se ejecuta en un contenedor efímero de la imagen del propio motor, dentro de la
  red del proyecto. La URL de origen y las credenciales de destino viajan como
  **variables de entorno**, nunca interpoladas en el shell.
- Volcado a fichero y después restauración (no tubería): `sh` no siempre admite
  `pipefail`, y con tubería un volcado que muere a medias devolvería el éxito del
  restore dejando la base a medio copiar.
- Una copia por servicio, con comprobación previa del origen, log en vivo por
  SSE, cancelación y tope de una hora.
- El destino **se sobrescribe**: la interfaz lo advierte.

---

### 5.7 Plan de integraciones y manifiesto `skyway.json`

Formato completo, reglas y ejemplos en **[MANIFIESTO.md](MANIFIESTO.md)**.

Una web puede declarar en `skyway.json` (raíz del repositorio o de su `rootDir`;
versión 1, zod estricto, máximo 64 KB, sin comandos ni rutas) las bases que
necesita (`postgres`, `redis`), el correo (`mode`, `mailbox`) y sus variables:
`{from: 'postgres.url'|'redis.url'|'mail.<papel>'|'self.public_url'}`,
`{generate: {bytes}}` o `{value}` (texto no secreto, sin `${{…}}`). Nunca `PORT`
ni `SKYWAY_*`. Sin manifiesto, el plan sale de la detección (§5.5).

`integrations.ts` construye el **plan sin efectos** (`buildPlan`): por cada
variable, de dónde sale, si es privilegiada y su estado (`apply`, `done`,
`manual` —puesta a mano, no se toca— o `blocked`, con el motivo); por cada
recurso, si se crea o se reutiliza (bases del **mismo proyecto**; buzón en el
dominio del cliente de correo del proyecto con la **propiedad comprobada**).
Aplicarlo (`applyPlan`):

- **Sin preguntar**: secretos generados (hex, nunca se regeneran; sí sustituyen
  el valor de ejemplo importado del repositorio), la URL propia
  (`${{<slug>.PUBLIC_URL}}`, solo con dominio), valores literales y huecos vacíos.
- **Con aprobación** (nunca en un despliegue, solo cuando una persona lo
  aprueba): crear o conectar una base lo aprueba **cualquiera con acceso al
  proyecto**, con la regla de crearla a mano (módulo «Bases de datos» y cuota,
  `dbCreateBlock`); crear el buzón y la credencial de correo (los mismos nombres
  y la misma credencial que «Conectar a un servicio»), **quien gestiona el
  proyecto** (administrador o propietario). Lo que quien aplica no puede
  aprobar queda pendiente. Cada recurso del plan dice si quien lo consulta puede
  aprobarlo (`canApprove`).
- **Ligada a lo revisado**: el plan lleva la huella de lo privilegiado
  (`fingerprint`: recursos y variables con su origen) y aprobar exige enviarla
  (`expect`). Sin ella, lo privilegiado queda pendiente; si no coincide (un push
  cambió el manifiesto entre ver el plan y aprobarlo), `…/integrations/apply`
  responde 409 con el plan nuevo sin aplicar nada, y el alta deja lo privilegiado
  pendiente. Reutilizar en SMTP un buzón que ya existe pide además
  `confirmMailboxAccess` (`confirmation` en el recurso): su contraseña de
  aplicación abre todo el buzón por IMAP.
- Se respetan los módulos («Bases de datos», «Correo»), la cuota de servicios y
  la suspensión de la cuenta. **Nunca** se pisa una variable puesta a mano
  (`managedenv.ts` + `service_managed_env`; lo importado del `.env.example` sin
  tocar no cuenta como puesto a mano). El correo no se aplica si la conexión
  quedaría a medias (servidor, puerto, usuario o URL de la API puestos a mano
  con otro valor). Un manifiesto no válido no aplica nada.
- Un bloqueo por servicio impide dos aplicaciones a la vez (409).

En **cada despliegue** (`reconcileOnDeploy`, tras clonar o, si se reutiliza la
imagen del mismo commit, con el manifiesto que se guardó al clonarlo) se vuelve
a leer el manifiesto: lo inofensivo nuevo se aplica y entra en ese build (si es
una variable de compilación y la imagen se iba a reutilizar, se compila de
nuevo); lo privilegiado
nuevo se anota en `integrationsPending` («Cambios pendientes de aprobar» en la
tarjeta del servicio y en Variables → Integraciones) y el registro avisa: «⚠
skyway.json pide cambios que requieren aprobación (…). El despliegue continúa
con lo ya aprobado». Nunca se escriben valores en el registro ni en la auditoría.

## 6. Áreas funcionales (resumen)

- **Despliegues**: build en vivo (SSE), historial, cancelación, rollback a
  cualquiera de las imágenes conservadas (el historial marca `imageAvailable` y,
  sin imagen, ofrece reconstruir el commit), diagnóstico de fallos en español.
- **Auto-deploy** (servicios git). Tres vías, todas gobernadas por el mismo
  interruptor `autoDeploy` (opt-out, en Ajustes del servicio):
  1. **Webhook de la GitHub App** (`/api/webhooks/github/app`): el camino rápido.
     La App lo registra sola al crearse, así que cualquier repo conectado
     despliega al hacer push sin configurar nada. Un push se reparte entre todos
     los servicios que apuntan a ese repo y esa rama **y cuyo proyecto tenga
     conectada esa instalación**.
  2. **Webhook por servicio** (`/api/webhooks/github/:serviceId`, HMAC con el
     `webhookSecret` del servicio): para quien use tokens. Ajustes del servicio
     da su URL con el dominio del panel (no el del túnel SSH) y no lo ofrece si
     el servicio clona con una instalación de la App, que ya recibe los push.
  3. **Sondeo** cada ~1 min (el primero, a los 10 s de arrancar): pregunta la
     cabeza de la rama por la API de GitHub con ETag (un 304 no consume cuota ni
     arranca un proceso) y cae a `git ls-remote` si no hay credencial o el repo
     no es de GitHub. Es la red de seguridad: funciona sin dominio público y sin
     tocar GitHub. La línea base («última cabeza tratada») se guarda en
     `autodeploy_state`: un push hecho con Skyway parado (un `skyway update`) se
     despliega al arrancar, y un reinicio tras una vuelta atrás no vuelve a
     desplegar la cabeza. Solo la primera comprobación de un servicio (auto-deploy
     recién activado) fija la línea base sin desplegar. Si no puede leer la rama,
     guarda el error (Ajustes → Despliegue automático lo muestra con la última
     comprobación) y, tras 15 minutos seguidos, lanza la alerta
     `autodeploy_failing` con el remedio; se cierra sola al recuperarse o al
     desactivar el auto-deploy. Un despliegue correcto no la cierra (no dice
     que la rama vuelva a poder leerse).

  Las tres vías comparten estado: un commit ya desplegado (o desplegándose) no
  se repite, y con un despliegue vivo que aún no ha clonado no se encola otro:
  clonará la cabeza actual. Si el vivo ya clonó otro commit, el push nuevo se
  encola detrás. En los webhooks, un commit que falló o se canceló sí se
  repite, para que «Redeliver» en GitHub lo relance; el sondeo, en cambio, no
  relanza un commit ya intentado aunque fallara (un despliegue manual roto de
  una cabeza nueva se reconstruiría solo al minuto, y fallaría igual).
- **Cambios sin desplegar**: cada servicio tiene una revisión de configuración
  (`services.config_rev`) que sube al guardar sus variables, las compartidas del
  proyecto, un campo que exige redesplegar, el `.env` importado, el plan de
  integraciones o Correo → Conectar, y también al guardar los dominios o el
  puerto de **otro** servicio cuyas variables de sistema referencia
  (`${{web.PUBLIC_URL}}`, `${{api.INTERNAL_URL}}`…): se compara el entorno
  resuelto de los demás servicios antes y después de guardar, y los que cambian
  quedan con cambios sin desplegar. Si es mayor que la del último despliegue
  correcto, `pendingChanges` es `true` en `GET /services/:id` y en cada servicio
  de `GET /projects/:id`: la tarjeta, el panel del servicio y `skyway status` lo
  muestran, también tras cerrar el panel o recargar. Las escrituras del propio
  despliegue (importación del `.env`, manifiesto) no cuentan: van en él.
- **Variables**: por servicio y compartidas por proyecto; referencias
  `${{Servicio.VAR}}` y `${{shared.VAR}}` resueltas al desplegar. Cada servicio
  tiene además variables de sistema (`INTERNAL_URL`, `PUBLIC_URL`…) que Skyway
  calcula de su puerto y su dominio (§5.5).
  `${{Servicio.VAR}}` y `${{shared.VAR}}` resueltas al desplegar.
- **Importación del `.env` del repositorio** (`deploy/envimport.ts`): al construir
  un servicio git se buscan `.env.example`, `.env.sample`, `.env.template`,
  `.env.dist`, `.env.defaults`, `example.env` y `.env` (este último manda) en el
  directorio raíz del servicio y en la raíz del repo. Cada clave se valida
  (nombre, reservadas como `PORT`/`RAILWAY_*`, ya definida en el servicio o en las
  compartidas, tratada en una pasada anterior) y su valor se clasifica: útil →
  se **importa**; vacío o de ejemplo (`changeme`, `<…>`, `your-…`) → queda
  **pendiente** de rellenar; apunta a `localhost` → se ignora (dentro del
  contenedor no existe). Nunca pisa una variable existente, escribe solo claves
  en el log y deja un aviso en la campana. Lo importado se apunta en
  `service_managed_env` con origen `import` (y el hash del valor): mientras nadie
  lo cambie, «Conectar a un servicio» y el plan de integraciones lo tratan como
  escrito por Skyway y lo sustituyen (el `MAIL_HOST=mailpit` del `.env.example`
  de Laravel no es una decisión de nadie). El informe se guarda en la config del
  servicio (`envImport`, sin valores) y se puede desactivar por servicio
  (`autoImportEnv: false`). Desde Variables → «Importar del repositorio» se hace
  lo mismo sin clonar (API de contenidos de GitHub), con vista previa.
- **Ayuda para clientes** (`help/`, página «Ayuda»): FAQ en español buscable por
  categorías y un **asistente determinista** (sin LLM) que responde con las
  preguntas coincidentes y, si la pregunta describe un fallo, **revisa el servicio**:
  último despliegue fallido (reutiliza `diagnose.ts`), estado del contenedor,
  referencias `${{…}}` sin resolver, variables pendientes del `.env` y patrones en
  la cola de logs de la aplicación (variable ausente, conexión rechazada, puerto
  ocupado, módulo no encontrado, memoria…). Cada hallazgo trae causa, arreglo,
  el detalle del registro (con secretos tapados) y enlaces a la pestaña del
  servicio. «Detectar errores» pasa la misma revisión a todos los servicios
  accesibles.
- **Pilas de aplicaciones**: Supabase, WordPress, Ghost, n8n y Metabase con todos
  sus servicios, secretos generados y arranque ordenado (§5.1).
- **Consola de consultas** (Consultas): explorador de tablas/colecciones/claves,
  ejecución con export CSV/JSON, snippets, historial, solo-lectura por defecto.
- **Explorador de archivos** (Archivos): navegar, descargar, subir, crear
  carpeta y borrar dentro de cada contenedor, **sin FTP ni credenciales** (va por
  el socket de Docker). Ver §7.7.
- **Métricas en vivo** (SSE): CPU, memoria y red por servicio (agregando réplicas)
  y del host, cada 2,5 s.
- **Histórico de consumo**: el monitor persiste cada 30 s el consumo por servicio
  y del host en cubos horarios (CPU y RAM con media y **pico**, bytes de red del
  periodo, foto de disco), conservados ~90 días. En la pestaña Métricas del
  servicio se ve a 24 h / 7 d / 30 d como **bandas media→pico** —que revelan la
  irregularidad, no solo el promedio—, la CPU en **núcleos** y **% del límite**
  (no un porcentaje suelto), la red como tráfico transferido divergente
  (enviado/recibido) y el disco frente a su cuota. El Monitor añade la vista
  **Servidor** con el histórico de carga, RAM y disco del host.
- **Monitor global**: todos los servicios con estado, consumo, disco, uptime 24 h,
  reinicios y alertas; buscador de logs entre todos los contenedores.
- **Alertas y notificaciones**: caídas, bucles de reinicio, CPU/RAM sostenidas,
  cuota de disco, deploy y backup fallidos; por Discord/Telegram/webhook y campana.
- **Backups**: volcado comprimido de postgres/mysql/mongo en un clic o programado
  con retención; descarga, restauración y borrado. Además, **snapshot diario del
  propio `skyway.db`** (usuarios, proyectos, variables) con retención de 7,
  creación manual y descarga desde Ajustes, y **verificación de integridad** de
  la BD del panel al arrancar (alerta crítica si falla).
- **Borrado con datos**: eliminar un proyecto o un servicio borra siempre sus
  volúmenes, imágenes compiladas y copias de seguridad, tras escribir su nombre
  para confirmar. Ajustes → **Datos sin proyecto** lista los volúmenes y copias
  que dejaron los borrados anteriores y los elimina tras escribir «eliminar»
  (§3.1).
- **Dominios y TLS**: verificación DNS en vivo, subdominios con comodín, TLS
  automático con Let's Encrypt vía Traefik y redirección de HTTP a HTTPS en todo
  servicio con dominio. Dominio principal automático (www primero, §5.5). El
  editor muestra los dominios en una lista con el estado del DNS (punto de color
  y etiqueta: «Configurado», «Esperando DNS», «Apunta a otra IP», «Proxy de
  Cloudflare») y, si falta algo, el registro A que hay que crear (tipo, nombre y
  valor, con botón de copiar). La pareja con o sin www se añade con el dominio
  (§5.5): al escribir un dominio registrable o su www aparece debajo del campo la
  casilla «Añadir también www.ejemplo.com» (o «ejemplo.com»), marcada por
  defecto; desmarcarla es la renuncia expresa. Quitar una mitad de la pareja pide
  confirmación («Si quitas www.ejemplo.com, la web no responderá en esa
  dirección») y guarda la renuncia en el dominio que se conserva. Un dominio al
  que le falta la pareja (por renuncia o por ser de antes) lo indica en su fila
  con una línea ámbar («Sin www.ejemplo.com: la web no responde con www.») y un
  botón «Añadir», que también retira la renuncia. El subdominio generado se
  ofrece como fila sugerida al final de la lista. La comprobación del DNS de
  cada dominio que aún no es correcto se repite sola: cada 15 s los dos
  primeros minutos, después cada minuto y hasta 30 minutos, solo con la pestaña
  visible y con el intervalo alargado según el número de dominios para no pasar
  de 20 comprobaciones por minuto (el tope del servidor es 30).
  **Proxy de Cloudflare** (nube naranja), la forma recomendada de servir una
  web: desde fuera, un dominio con el proxy solo resuelve a IP de Cloudflare.
  Para el administrador, si la zona está en su Cloudflare, se pregunta a la API
  (solo lectura) a dónde lleva el registro: si apunta a este servidor la fila
  dice «Configurado» con el proxy y, con HTTPS, se pide la portada a través de
  Cloudflare para detectar el bucle del modo SSL/TLS «Flexible» («Bucle en
  Cloudflare», error, con cómo pasar a «Completo (estricto)»); si apunta a otro
  sitio, «Apunta a otra IP» con lo que hay en Cloudflare. Si no se puede saber
  (otra cuenta de Cloudflare, sin token, o quien mira no es administrador), la
  fila dice «Proxy de Cloudflare» en tono neutro y no se repite la
  comprobación. Para el administrador, la API manda sobre el proxy: el DNS
  público tarda unos minutos en reflejar que se ha activado o quitado. Con su
  zona en su cuenta, el administrador ve en el detalle del dominio «Activar
  proxy en Cloudflare» (dominio sin el proxy, con HTTPS y que cubra el
  certificado gratuito de Cloudflare: la zona y un nivel de subdominio; nunca
  el subdominio generado) o «Desactivar proxy en Cloudflare» (dominio con el
  proxy, también en el bucle del modo «Flexible» como arreglo rápido; para un
  servicio que no funciona detrás de él: subidas de más de 100 MB o peticiones
  de más de 100 s en el plan gratuito de Cloudflare) (§7.13).
- **Página de estado pública**: dashboard compartible por token (sin login), con
  disponibilidad 90 días, incidencias y aviso de mantenimiento; token rotable.
- **Importador de Railway**: analiza un proyecto por la API oficial y recrea
  servicios, variables (con referencias), dominios y volúmenes; genera los
  comandos de copia de datos. Las variables que apuntaban a bases de datos de
  Railway también importadas se **reconectan solas** como referencias
  `${{Base.VAR}}` al servicio nuevo (por host privado/proxy público, o por
  esquema si es inequívoco); solo lo no mapeable genera aviso. El token viaja
  solo en memoria.
  Las **variables mágicas de Railway** que las plantillas usan para cablear sus
  servicios entre sí se traducen a lo que existe aquí: `RAILWAY_PRIVATE_DOMAIN`
  y `RAILWAY_TCP_PROXY_DOMAIN` → el slug del servicio destino (su nombre DNS en
  la red del proyecto), `RAILWAY_TCP_PROXY_PORT` y `PORT` → su puerto interno,
  `RAILWAY_PUBLIC_DOMAIN`/`RAILWAY_STATIC_URL` → su dominio principal (§5.5), `RAILWAY_PROJECT_NAME`
  y `RAILWAY_ENVIRONMENT` → los de aquí, y `${{secret(n)}}` → un secreto generado.
  Las referencias que **no** van a resolver —un servicio que no se importó, una
  variable que la plantilla de base de datos de Skyway no exporta, un destino sin
  dominio— se avisan una a una en el informe: sin eso el contenedor arrancaría con
  el texto `${{...}}` literal como host, sin que nada fallase.
- **Cuentas y clientes, cuotas y facturación**: cada cliente es un **workspace**
  con una cuota de recursos (CPU, RAM, disco, proyectos, servicios, usuarios)
  acotada a todos sus proyectos en total, un **plan** de usos incluidos, un
  conjunto de **módulos** (capacidades) activables, y su **facturación** (facturas
  del plan o a medida). El admin gestiona todo y redimensiona la cuota en vivo; el
  **propietario** administra su cuenta (proyectos, sub-usuarios, acotado de
  módulos) y ve su facturación. Suspender una cuenta detiene despliegues y
  operaciones nuevas. La UI vive en «Cuentas y clientes» con medidores de cuota en
  vivo. Detalle de datos en §3, seguridad en §4 y API en §7.2.1.
- **Multi-empresa y usuarios/roles**: proyectos por cliente; admins, propietarios y miembros.
- **Conectores de GitHub por proyecto**: cada cliente conecta su cuenta (token)
  y asigna sus repos a los servicios con selector de repo y rama; el admin ve y
  revoca todos los conectores desde Ajustes. Sin conector se usa el token global.
- **Correo (Mailway)**: Skyway se conecta con la instancia de Mailway del
  operador (Ajustes → Correo) mediante un **token de gestión de administrador**
  y, desde el botón «Correo» de cada proyecto, permite activar el correo con
  **un cliente de Mailway por cuenta**: los proyectos de una cuenta (workspace)
  que activan el correo comparten el cliente de la cuenta (referencia externa
  `skyway:workspace:<id>`, con el nombre de la cuenta), con sus dominios,
  buzones y plan; los que nunca lo activan no crean nada, y un proyecto sin
  cuenta tiene el suyo (`skyway:project:<id>`, con el nombre del proyecto). El
  nombre del cliente sigue al de la cuenta: al renombrarla (en segundo plano,
  sin bloquear el cambio; un fallo queda en la auditoría) y, si difieren, al
  abrir el correo de uno de sus proyectos. Los vínculos de antes (un cliente
  propio por proyecto) pasan al cliente de la cuenta sin perder nada al abrir
  el correo del proyecto y, en segundo plano, al arrancar: si la cuenta aún no
  tiene cliente, ese mismo cliente pasa a serlo (referencia y nombre de la
  cuenta); si ya tenía otro, no se fusiona ni se mueve nada: el proyecto
  conserva el suyo, sigue funcionando y el panel lo indica («Este proyecto
  tiene su propio cliente en Mailway»), y queda registrado una vez en la
  auditoría (`mailway_client_kept`). Las credenciales de envío de los
  servicios de un proyecto de una cuenta llevan también el slug del proyecto
  (`skyway:tienda/web`, `Skyway · tienda/web`): dos proyectos de la cuenta con
  un servicio «web» no se revocan la credencial al volver a conectarse. Añadir
  dominios con sus registros DNS (verificación, aplicación en **Cloudflare**
  con vista previa de cambios y conflictos, o **fichero de zona** para
  importarlo, sin registros A/AAAA/CNAME/HTTPS/SVCB del dominio raíz ni de
  www, que sustituirían la web), con los **dominios registrables de los
  servicios del proyecto como sugerencias** (lista de sufijos públicos,
  `tldts`; sin los de la plataforma ni los que ya tiene el cliente), el
  **webmail con el dominio del cliente** en `webmail.<dominio>` (marca blanca
  de Mailway: registro DNS, comprobación «Esperando DNS → Emitiendo
  certificado → En servicio», Cloudflare y webmail principal; nunca con el
  nombre de un servicio de Skyway ni el del panel), crear buzones (contraseña
  visible una sola vez, sugerencias info/contacto/no-reply y **enlace de
  configuración** de dispositivos) y **conectar un
  servicio**: SMTP (contraseña de aplicación propia) o API de envío (clave
  `mw_…`). Las variables se escriben **con los nombres que espera el servicio** —los
  de su `skyway.json` o, por la tabla de alias de `mailenv.ts`, los de su
  `.env.example`: `SMTP_PASSWORD`/`SMTP_PASS`/`MAIL_PASSWORD`/`EMAIL_HOST_PASSWORD`,
  `SMTP_FROM`/`MAIL_FROM`/`EMAIL_FROM`/`DEFAULT_FROM_EMAIL`,
  `SMTP_USER`/`MAIL_USERNAME`/`EMAIL_HOST_USER`, `EMAIL_USE_TLS=true`,
  `MAIL_ENCRYPTION=tls`, `EMAIL_SERVER`/`MAILER_DSN` como URL `smtp://…`— y, para
  lo que no nombra, con los de siempre (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
  `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`; en API, `MAILWAY_API_URL`,
  `MAILWAY_API_KEY`, `MAIL_FROM`). Se **fusionan** con las existentes, **nunca
  se pisa una variable puesta a mano** con otro valor (ni se tapa una compartida
  del proyecto: van en `kept`) y, si la credencial no cabe en ninguna, no se crea
  (409). Tampoco se conecta a medias: si el servidor, el puerto, el usuario o la
  URL de la API están puestos a mano con otro valor, escribir la credencial la
  mandaría a otro proveedor, así que responde 409 con esos nombres sin crear
  nada. Lo importado del `.env.example` y sin tocar es de Skyway y se sustituye.
  La pestaña lo enseña antes de conectar (`…/mail/connect/preview`) y la
  respuesta solo lista nombres. Volver a conectar un servicio **revoca la
  credencial anterior** del mismo tipo que Skyway creó para él (`skyway:<servicio>`
  o `Skyway · <servicio>`; en un proyecto de una cuenta, `skyway:<proyecto>/<servicio>`)
  y actualiza lo que Skyway escribió (también lo de
  antes de llevar la cuenta de lo escrito); las credenciales vigentes se listan
  y se revocan desde la misma pestaña. Como el servicio en marcha sigue con la
  credencial revocada hasta que se vuelve a desplegar, al volver a conectar un
  servicio que ya tiene una credencial de Skyway en ese modo (la pestaña lo
  sabe con los nombres de la vista previa, `credentialNames`) la casilla
  «Volver a desplegar ahora» aparece **marcada** (salvo si el servicio está
  detenido desde el panel: desplegar lo pondría en marcha, así que queda
  desmarcada y el aviso explica que, para arrancarlo, hay que desplegarlo y no
  usar «Iniciar», que arrancaría el contenedor con la credencial revocada;
  «Conectar» espera a la vista previa y, si falla, se avisa de la revocación en
  general) y el aviso lo explica («…
  Sin volver a desplegar, el servicio no podrá enviar correo hasta el próximo
  despliegue», y en SMTP, que cada intento con la contraseña revocada cuenta
  para el bloqueo automático de IPs del servidor de correo), en ámbar si se
  desmarca. Volver a desplegar desde aquí usa la imagen en marcha, sin compilar
  la cabeza de la rama (§7.12). Si se conecta sin desplegar y se ha revocado
  una credencial, el resultado lo avisa y ofrece «Desplegar ahora», que hace lo
  mismo que la casilla (`POST …/mail/redeploy`: la versión en marcha con las
  variables nuevas; antes era un despliegue normal, que compilaba la cabeza de
  la rama, podía publicar commits que nadie había pedido y, si la compilación
  fallaba, dejaba el servicio con la credencial revocada). La API no cambia: en
  `POST …/mail/connect`, `redeploy` sigue siendo `false` si no se envía.
  **Bots y workers**: para un servicio que solo envía se recomienda el modo
  **API**: la clave `mw_…` solo envía desde su buzón, con los límites del plan y
  un registro por clave, y no da acceso a su contenido; la contraseña de
  aplicación del modo SMTP permite también leer el buzón por IMAP. La pestaña lo
  dice en el modo SMTP y, si el servicio no tiene dominio ni healthcheck
  (`sinDominio`), lo recomienda expresamente. `MAILWAY_API_URL` es la dirección
  **base** de Mailway: para enviar, `POST {MAILWAY_API_URL}/v1/send` con la
  cabecera `Authorization: Bearer {MAILWAY_API_KEY}` y un JSON con `to`,
  `subject` y `text` o `html`; con la cabecera `Idempotency-Key`, un reintento no
  envía el mensaje dos veces (la pestaña trae un ejemplo con `curl`). El **fichero de zona** añade, en
  secciones propias, los registros A de los servicios del **mismo proyecto**
  que cuelgan del dominio (hacia la IP pública de Ajustes; sin ella, se omiten
  con un aviso), comentados con la instrucción de borrar antes el registro del
  hosting anterior (importar añade y no sustituye), y el del webmail del
  cliente. **Traslados**: antes de añadir un dominio se mira dónde recibe hoy
  el correo; si es en otro proveedor, se pide confirmación y el DNS automático
  del administrador queda desmarcado. La tarjeta avisa mientras el MX siga
  fuera (y de qué pasa con lo que se envía al dominio desde aquí), pide
  confirmación antes de descargar el fichero de zona, copia el SPF combinado
  en lugar del del motor y, con Mailway posterior a la 1.2, Cloudflare permite elegir los
  conflictos uno a uno («Hacer el cambio de proveedor») y deshacer el último
  cambio.
  **Cambio de motor de Mailway**: al pasar de Stalwart 0.15 a 0.16, Mailway no
  puede conservar las contraseñas de aplicación del motor anterior: las marca
  como invalidadas (`invalidatedAt` en las contraseñas del resumen del cliente,
  anunciado con `features.appPasswordInvalidation` y `engine.api` en
  `/api/integrations/info`) y dejan de funcionar. Los servicios conectados por
  SMTP las llevan en sus variables, así que Skyway **las renueva solo**
  (`mailwayrenovacion.ts`) en el ciclo de 10 minutos del planificador (con
  Mailway configurado y Docker disponible; un solo resumen por cliente de
  Mailway en cada pasada, ninguna petición si ningún servicio lleva una
  contraseña de Skyway) y al abrir el correo del proyecto quien lo gestiona.
  Para cada servicio cuyas variables llevan, sin tocar, la contraseña que
  escribió Skyway y que Mailway ha invalidado, y en este orden: crea una nueva
  para el mismo buzón; escribe la credencial (y lo que ya es de Skyway: nunca
  una variable puesta a mano ni una que no estuviera) y anota la renovación en
  la misma transacción; vuelve a desplegar el servicio con el despliegue de
  siempre (origen `mailway_renovacion`; uno que nunca se ha desplegado la
  recibe en su primer despliegue); revoca la invalidada; lo audita
  (`mailway_app_password_renewed`) y avisa en la campana y por los canales de
  alertas (`mail_password_renewed`). Nunca retira una credencial antes de
  tener guardada la nueva: si Mailway no la crea, no cambia nada, lo indica
  (alerta `mail_password_renewal_failed`) y lo reintenta en la pasada
  siguiente; si el despliegue falla, las credenciales nuevas se quedan y el
  fallo avisa como cualquier otro (`deploy_failed`). Con el servicio detenido
  a mano, un despliegue en curso o la cuenta o el cliente suspendidos, espera
  sin crear nada y lo hace cuando se puede. Si el servidor, el puerto o el
  usuario están puestos a mano con otro valor (o, en una conexión anterior a
  llevar la cuenta de lo escrito, no coinciden con los de Mailway), no la
  renueva y explica por qué. Es idempotente (la contraseña que creó queda
  anotada: si no llegó a revocar la invalidada, la pasada siguiente solo la
  revoca) y comparte con «Conectar a un servicio» y el plan de integraciones
  el turno por servicio de los cambios de credencial: a la vez, dejan una sola
  contraseña vigente, la de las variables. «Conectar a un servicio» indica
  cuándo se renovó («Contraseña de aplicación renovada automáticamente el …
  tras la actualización del servidor de correo») o por qué no se ha podido, y
  marca las contraseñas invalidadas. Los servicios conectados por la API de
  envío no se tocan: Mailway vuelve a emitir por su cuenta la credencial
  interna de cada clave. Con un Mailway anterior, sin el anuncio ni el campo,
  ninguna contraseña se da por invalidada.
  **Webmail propio**: Mailway da a cada dominio del cliente su webmail en
  `webmail.<dominio>` automáticamente (registro DNS en Cloudflare con proxy,
  certificado…). La pestaña «Dominios» enseña los webmail de marca del cliente
  (estado «Esperando DNS», «Emitiendo certificado», «En servicio» o «Con
  error», el principal y el enlace en servicio) y el interruptor «Crear el
  webmail automáticamente» del cliente: apagarlo pide confirmación (los que
  Mailway creó solo dejan de funcionar, con su registro DNS, y los titulares
  vuelven al webmail general); encenderlo los crea de nuevo. Si el interruptor
  global de Mailway está apagado, se avisa de que no tiene efecto. Con un
  Mailway sin la función (`features.webmailAutomatico` ausente) la sección no
  aparece. **Configuración inicial**: «Enviar configuración inicial» crea el
  enlace de bienvenida de Mailway para la persona de contacto del cliente (con
  él crea su propio acceso al panel de Mailway y entra en un asistente para
  añadir el dominio y los buzones): correo propuesto (el de contacto del
  cliente o el del propietario de la cuenta), nombre opcional y validez (1, 3,
  7 o 30 días); el enlace se muestra al crearlo con su caducidad y un «Enviar
  por correo» (`mailto:` con asunto y texto), y la lista de enlaces recientes
  permite volver a ver uno pendiente y revocarlo. Con un Mailway que no
  declara `features.invites` el botón no aparece y sus rutas responden 409 sin
  llamarle. Ambos son ajustes del cliente de correo: en una cuenta, valen para
  todos sus proyectos.
  Aislamiento: como el token es de administrador, **cada dominio y buzón se
  comprueba contra el resumen del cliente vinculado** antes de actuar (si no es
  suyo, 404 sin llegar a Mailway) y la referencia externa del cliente tiene que
  ser exactamente una de las del proyecto: la de su cuenta o la suya propia.
  Solo comparten cliente proyectos de la **misma cuenta**: vincular a un
  proyecto el cliente de otra cuenta, de otro proyecto o de otra integración
  responde 409 (también en Mailway: `409 external_ref_in_use` si la referencia
  de la cuenta ya es de otro cliente). Un miembro con acceso a un proyecto ve
  el correo de la cuenta (es el mismo cliente), pero solo los nombres de los
  proyectos a los que tiene acceso. El plan lo elige el administrador (el
  propietario recibe el predeterminado de Ajustes → Correo), los buzones los
  crean el propietario o el administrador (los nombres reservados —postmaster,
  abuse, admin, hostmaster, webmaster, root…— solo el administrador) y, con la
  cuenta suspendida, no se crea nada. Desactivar el correo solo retira el
  vínculo de ese proyecto: el cliente de una cuenta conserva la referencia de
  la cuenta (también al desactivarlo el último proyecto, o al borrarlo), y
  volver a activarlo vincula el proyecto al mismo cliente con sus dominios. Un
  cliente propio se recuerda y, al reactivar, se puede **recuperar ese mismo
  cliente**. La desvinculación en Mailway es condicional (`DELETE
  /api/integrations/clients/:id/link?externalRef=skyway:project:<id>`): si
  entretanto el cliente se ha vinculado a otra referencia, Mailway responde
  409 `external_ref_mismatch` y no lo toca. Borrar una cuenta suelta en
  segundo plano, igual de condicional, la referencia `skyway:workspace:<id>`
  de su cliente (que sigue en Mailway con sus buzones).
  Módulo de plan `mail` («Correo»).
  **Puente de Traefik**: Traefik lee `GET /api/traefik/mailway` (proveedor HTTP,
  cada 15 s); Skyway obtiene la configuración de Mailway y la **sanea** (solo
  reglas `Host()` hacia contenedores `mailway-…` o del proyecto de Mailway,
  comparados por nombre completo, nunca un dominio del panel o de un servicio de
  Skyway, solo redirecciones a HTTPS y el emisor `le`) y, si Mailway no responde
  o se quita el token, sirve la última configuración buena: solo «Desconectar
  Mailway» retira las rutas. A la inversa, ningún servicio de un cliente puede
  asignarse un dominio que publique Mailway, los de su panel y webmail ni un
  nombre de marca blanca de cualquier cliente, también mientras espera DNS: en
  cada lectura el puente obtiene además la lista completa
  (`GET /api/whitelabel/domains` sin `clientId`), conserva la última buena si
  Mailway no responde y «Desconectar Mailway» la vacía; el webmail creado desde
  un proyecto se reserva al darlo de alta.
- **Passkeys (WebAuthn)** y **tokens de API** para automatización/agentes.

### 6.1 Cambiar de dominio (`domainmigration.ts`)

Asistente del proyecto (botón «Cambiar de dominio», solo la administración o el
propietario del workspace) para pasar la web y, si el proyecto tiene el correo
en Mailway 1.3+, el correo de `dominio.es` a `dominio2.es` sin perder nada.
Fases: **Qué cambia → Preparar → En transición → Terminado**
(`preparando ⇄ lista → pasando → pasada → dando_de_baja → terminada`; desde
`pasada`, «Volver» lleva a `volviendo → lista`; antes de pasar, «Cancelar» a
`cancelada`). Un proyecto tiene un solo cambio abierto.

- **Plan** (sin efectos): mapa de nombres por defecto (cada dominio de un
  servicio que no es base de datos igual a `dominio.es` o que cuelga de él,
  salvo `webmail.`, `autoconfig.`, `autodiscover.`, `mta-sts.` y `mail.`, pasa
  al mismo nombre bajo `dominio2.es`) con tres modos por nombre: **redirigir**
  (el nuevo sustituye al viejo en su sitio y el viejo redirige), **servir** (el
  viejo se sigue sirviendo al final de la lista, sin redirigir: APIs y
  webhooks) y **no cambiar**. Cada nombre nuevo pasa `domainClaimError`. El
  correo: plan de Mailway (`POST /api/domain-migrations/plan`, con
  `soloCliente` para quien no es administrador, tras comprobar con
  `ownedSummary` que el cliente y el dominio son del proyecto). Las variables:
  `envreplace.ts` con un **mapa exacto** (hosts servidos y direcciones que se
  mudan; `db.dominio.es` o una dirección que no está en Mailway no se cambian y
  se enseñan como nota), sin tocar referencias `${{…}}` ni los usuarios para
  entrar en el correo (también con un prefijo propio delante del nombre
  conocido, como `TG_SMTP_LOGIN`, `BOT_SMTP_USER` o `MYAPP_EMAIL_HOST_USER`, que
  salen como nota «usuario para entrar»); los argumentos de compilación se
  planifican sin enseñar su valor. `servicios` lista los que se volverán a
  desplegar con sus `motivos` (`dominios`, `variables`, `compartidas`,
  `remitente`, `referencias`) y `reinicio` (se despliega con una sola copia,
  `estrategiaEfectiva`: la confirmación de «Pasar» avisa de que esos servicios
  se detienen antes de arrancar la versión nueva, unos segundos sin servicio);
  `webhooks`, los servicios con webhooks en nombres que redirigen (ver
  «Webhooks» más abajo). WordPress recibe en `WORDPRESS_CONFIG_EXTRA` un bloque que fija
  `WP_HOME`/`WP_SITEURL` (sin él, un bucle de redirecciones). La huella
  combinada (`expect`) cubre nombres, variables y los buzones y alias de
  Mailway: si algo cambia, 409 `plan_changed`.
- **Preparar** no despliega nada: guarda el cambio, **prepublica** los nombres
  nuevos (§2, proveedor HTTP; se publican en cuanto `checkDomain` da `ok`), abre
  el cambio en Mailway con `origen: 'skyway'` (desde ese momento solo Skyway lo
  pasa, vuelve, cancela o da de baja) y reserva al proyecto los nombres que
  Mailway crea en Cloudflare (en cada respuesta, no solo al crear: el webmail
  se crea al probarse la propiedad y el MX con «Cambiar el MX»; un nombre ya
  reservado no se mueve). Un cambio que Mailway ya tenía abierto con el mismo
  origen y destino pero que no abrió este proyecto (desde el panel de Mailway
  o desde otro proyecto: crear lo devolvería) no se adopta: el plan lo
  bloquea y preparar, o vincular un alta sin confirmar, responde 409
  `migration_exists`. Si Mailway lo rechaza (4xx), el cambio se borra
  entero; si no responde (plazo, red o 5xx), pudo crearlo igualmente y nadie
  podría cerrarlo desde su panel, así que el cambio se conserva con el error y
  la compuerta del correo pendiente: la comprobación lo busca en Mailway
  (`GET /api/domain-migrations?clientId=&domainId=`, por `referenciaExterna`)
  y lo vincula, o lo vuelve a pedir (crear es idempotente); «Cancelar» lo busca
  y lo cancela allí. Para la administración, DNS automático de los nombres
  nuevos (§7.13). El asistente comprueba cada 30 s: DNS de los nombres nuevos
  (bloquea; a la administración, un nombre con el proxy de Cloudflare se
  comprueba con su API, como en `POST /domains/check`; sin ella no se sabe a
  dónde lleva, así que vale solo si ya se comprobó y, si no, no se prepublica y
  se explica cómo seguir), certificado servido por Traefik con SNI
  (`comprobarTlsLocal`; bloquea si no es válido, no si no se puede comprobar o
  no hay TLS; un CAA que no autoriza a Let's Encrypt lo deja pendiente con el
  registro que falta) y correo de Mailway en `listo` (bloquea). Si el dominio nuevo recibe hoy en otro
  proveedor, el fichero de zona trae su MX comentado (importar lo añadiría al
  actual en vez de sustituirlo) y, con la zona en Cloudflare, «Cambiar el MX a
  este servidor» se lo pide a Mailway tras la pre-recepción.
- **Pasar** (`expect` = huella de las variables de la confirmación): primero el
  correo en Mailway. Si falla, la web no se toca y el estado lo decide el de
  Mailway: `pasando` con el error si Mailway se quedó a medias (ofrece
  «Reintentar» y «Volver»), `lista` si sigue `listo`, y si ya había pasado (la
  respuesta se perdió) se sigue con la web. Al reintentar con el correo ya
  pasado, las direcciones que cambian en las variables salen del plan inverso
  de Mailway (sin efectos), que lista los buzones y alias en el dominio nuevo.
  Después, en **una transacción**: instantánea y dominios en su
  sitio (el primero es el principal: `PUBLIC_URL` pasa al nuevo), variables
  (`writeManagedEnv` si las escribió Skyway y nadie las cambió, conservando su
  origen; el resto con `patchEnv`/`patchProjectVars`; `buildArgs` en la
  configuración), remitentes de correo gestionados (`refrescarVariablesCorreo`;
  el **usuario SMTP no cambia**: el buzón entra con el anterior hasta la baja),
  redirecciones (`permanent_from` = ahora + 7 días; antes se borran las que
  salían de los nombres nuevos) y `bumpConfigRev`. Los servicios cuyo entorno
  resuelto cambia por los dominios nuevos (los que referencian a otro con
  `${{api.PUBLIC_URL}}`…) entran también en los afectados, con motivo
  `referencias`: se compara el entorno resuelto de los servicios antes y
  después de escribir. Fuera de ella, un
  despliegue normal de cada servicio afectado (`cambio-de-dominio`); al
  terminar bien se retira su prepublicación y, si falla, el contenedor anterior
  sigue sirviendo y la interfaz ofrece «Reintentar este servicio».
- **Volver**: Mailway `rollback` y, en una transacción, los dominios viejos en
  su sitio **y los nuevos como secundarios** (una redirección permanente ya
  guardada en un navegador no puede acabar en error), las variables clave a
  clave solo si su valor actual es el que escribió el cambio (si no, el aviso
  «No se ha restaurado X: cambió después del cambio de dominio.»), remitentes de
  vuelta y sin redirecciones; después se despliegan los servicios afectados
  (también, como al pasar, los que referencian la dirección de un servicio que
  vuelve a cambiar de nombre).
  Los nombres viejos que el contenedor en marcha ya no tiene se **prepublican**
  (con el DNS dado por bueno) hasta que el despliegue termine bien: sin ello
  nadie los serviría mientras tanto, ni nunca si el despliegue falla. Un nombre
  nuevo que el servicio ya no tiene solo se vuelve a añadir si sigue libre
  (`domainClaimError`): si otro proyecto se lo ha asignado, se avisa y no se
  añade (dos servicios con el mismo host se repartirían su tráfico).
- **Cancelar** (antes de pasar): Mailway primero (puede negarse con
  `migration_new_mx_here`, que se enseña tal cual, y entonces nada cambia);
  después se retira la prepublicación. Tras un «Volver», quien había
  actualizado su usuario entra con el de `dominio2.es`, y al cancelar Mailway
  le devuelve el de `dominio.es`: las aplicaciones que envían con esos buzones
  reciben el usuario y el remitente de `dominio.es` y se despliegan con la
  imagen en marcha, como en la baja (si su despliegue falla, «Reintentar este
  servicio» sigue disponible en el cambio cancelado). Los registros DNS creados
  se conservan, reservados al proyecto.
- **Dar de baja** (con correo, `confirm` = dominio anterior): si hay buzones
  que usan aplicaciones de Skyway, antes de tocarlas se mide el MX del dominio
  anterior: si apunta al servidor de correo de Mailway (por nombre o por IP),
  409 `migration_old_mx_here` sin cambiar nada (Mailway lo mide de todos modos
  al dar de baja, pero cuando las aplicaciones ya tienen el usuario nuevo). En
  segundo plano,
  buzón a buzón, los que usan aplicaciones de Skyway (`skyway:…`) **o** tienen
  usos sin gestionar en el proyecto (ver más abajo) pasan al usuario nuevo si
  siguen pendientes (`login-update`) y, justo después, sus servicios reciben el
  usuario y el remitente nuevos y se despliegan **con la imagen en marcha** (15
  min como máximo; un despliegue fallido se reintenta una vez, ver «Baja y
  “Actualizar ahora”»). Lo que decide si un servicio está al
  día son sus variables, no que el buzón siga pendiente: una respuesta perdida
  o una baja a medias dejan el buzón al día y la aplicación con el usuario
  anterior. Solo con **todos** los servicios del cambio desplegados, Mailway da
  de baja el dominio anterior. Si algo falla, el estado lo decide Mailway:
  `dando_de_baja` con el error si su baja quedó a medias (con «Reintentar»),
  `pasada` si sigue `pasado`; si ya lo había dado de baja, se cierra. Las
  redirecciones se quedan.
  **Terminar** hace lo mismo en el caso «solo la web». **Quitar las
  redirecciones** las borra (recomendado: no antes de 12 meses).
- **Webhooks y «Servir también»**: un servicio con indicios de recibir webhooks
  —por sus variables (propias, de compilación y las esperadas del
  `.env.example`): `TELEGRAM_*`/`TG_*` (Telegram), `DISCORD_*`, `SLACK_*`,
  `WHATSAPP_*`, `TWILIO_*`, `STRIPE_*` (con o sin prefijo público), y
  `BOT_TOKEN`, `*_BOT_TOKEN` o cualquier variable con `WEBHOOK` en el nombre
  (webhook genérico); o por sus dependencias (`needs.bots`, §5.5: `telegraf`,
  `grammy`, `node-telegram-bot-api`, `python-telegram-bot`, `aiogram`,
  `discord.js`, `discord.py`, `discordgo`, `@slack/bolt`, `slack-bolt`, las SDK
  de Twilio y de Stripe…; en npm, solo las de producción; en Python, los
  nombres se comparan normalizados según PEP 503 y se leen también las
  dependencias de Poetry de `[tool.poetry.dependencies]` y del grupo `main`,
  no las de desarrollo)— sale en `webhooks`
  del plan y de la vista si algún nombre que **redirige** al pasar le llega:
  uno de los suyos, o uno del cambio que aparece en su entorno resuelto (un bot
  sin dominio con `WEBHOOK_URL=${{api.PUBLIC_URL}}/tg` recibe en el nombre de
  `api`). Cada entrada (`WebhookEnRiesgo`) lleva el servicio, los proveedores,
  las evidencias («TELEGRAM_BOT_TOKEN», «package.json: telegraf») y los
  nombres (`hosts[{serviceId, from, to}]`). El aviso dice que el servicio
  «puede recibir» webhooks en esos nombres (usar la biblioteca o tener el token
  no dice que los reciba: puede solo enviar notificaciones de Telegram, SMS de
  Twilio o cobrar con Stripe Checkout sin webhooks), que Telegram y Stripe no
  siguen redirecciones (un webhook registrado con la URL anterior deja de
  recibir al pasar) y, del resto, que «puede dejar de recibir»; la salida es
  volver a registrarlo con la URL nueva después de pasar o **«Servir también»**
  el nombre anterior (modo `servir`: se sigue sirviendo, sin redirigir). Con
  Stripe añade que el endpoint nuevo tiene otro secreto de firma
  (`STRIPE_WEBHOOK_SECRET`), y entonces el aviso general de Stripe de
  `avisos` («Stripe → Webhooks: crea el endpoint…») no sale: eran dos avisos
  del mismo endpoint; sale si ningún servicio con Stripe queda en riesgo. Con la
  cuenta suspendida, «Servir también» después de pasar responde 403
  `account_suspended`, como pasar. Un bot
  de polling sin dominio ni URL hacia un nombre del proyecto no sale: no recibe
  webhooks. Tampoco los **webhooks de salida** (los que el servicio llama, no
  los que recibe): ni las variables `SLACK_…WEBHOOK(_URL)` o
  `DISCORD_…WEBHOOK(_URL)`, ni las de cualquier nombre cuyo valor resuelto
  apunta a `hooks.slack.com`, `discord(app).com/api/webhooks`,
  `*.webhook.office.com`, `outlook.office.com/webhook` o `chat.googleapis.com`.
  La detección por dependencias (`needs.bots`) se rellena al desplegar: un
  servicio desplegado con una versión anterior de Skyway solo avisa por sus
  variables hasta su siguiente despliegue. «Servir también» está disponible en la vista previa (vuelve a pedir
  el plan con esos nombres en `servir`), con el cambio preparado (`preparando` o
  `lista`, en los dos sentidos) y **también después de pasar** (`pasada`, solo
  de redirigir a servir; la vista solo enseña entonces los nombres que siguen
  redirigiendo): en una transacción, el nombre anterior se añade al final de
  los dominios del servicio, se borra su redirección, se prepublica (con el DNS
  dado por bueno: ya apuntaba aquí) para que nadie lo deje sin servir mientras
  despliega y sube `config_rev`; después el servicio se despliega con la imagen
  en marcha. Los nombres de un mismo servicio van juntos (la web manda una
  petición por servicio): una transacción y un solo despliegue. Antes de pasar
  se admite servir también el nombre que seguirá siendo el principal del
  servicio, con el mismo aviso que la vista previa; después de pasar se
  rechaza con 409 `host_principal` (cambiaría su `PUBLIC_URL`, que ya es la
  nueva). Auditoría `domain_migration_host_mode` («<nombre>: redirigir →
  servir»).
- **Servicios que usan la dirección de otro**: un servicio que no cambia de
  nombre pero referencia uno que sí (`${{api.PUBLIC_URL}}`,
  `${{web.PUBLIC_DOMAIN}}`…) se vuelve a desplegar al pasar y al volver, con
  motivo `referencias` (««bot» se vuelve a desplegar porque usa la dirección de
  un servicio que cambia de nombre.»). El plan lo predice resolviendo su entorno
  con los dominios de después (`resolveServiceEnv(s, { dominios })`).
- **Usuarios de correo que Skyway no gestiona**: el usuario para entrar se
  reconoce también con un prefijo propio (`mailRoleLoose`: `TG_SMTP_LOGIN`,
  `BOT_SMTP_USER`…), dentro de una URL SMTP (el usuario, decodificado:
  `smtp://bot%40dominio.es:…@…`) y en las variables a las que apunta un usuario
  SMTP (`SMTP_USER=${{shared.MAIL_LOGIN_COMUN}}`, `${{mailer.SMTP_USER}}`,
  siguiendo hasta 5 referencias encadenadas): son usuario, no cambian al pasar
  (salen como nota «usuario para entrar») y se ponen al día al actualizar el
  buzón o en la baja. Los usos se buscan en el **entorno resuelto** de cada
  servicio, con el nombre de la variable del servicio. En `pasada` y `dando_de_baja`, la vista enseña
  en `usuariosSinGestionar` (por buzón del cambio: `mailboxId`, `email`,
  `login`, `pendiente` y `usos`) las variables del proyecto, de servicio o
  compartidas, cuyo usuario es la dirección anterior o la nueva del buzón y que
  no son la variable de usuario que Skyway escribió con una credencial
  `skyway:*` de ese buzón: una contraseña de aplicación creada a mano, una
  variable con un nombre propio, una URL… Cada uso dice el servicio, la
  variable, el usuario y su estado: `cambiara` (entra hoy y dejará de entrar al
  actualizar el buzón o en la baja) o `no_entra` (ya no es el usuario del
  buzón). El asistente los agrupa en «Servicios que envían con un usuario que
  cambia» con **«Actualizar y desplegar»** por buzón, que es «Actualizar ahora»
  (`…/login-update`): además de las credenciales `skyway:*`, reescribe esas
  variables con el usuario nuevo (en una URL, codificado; lo que escribió
  Skyway conserva su origen) y despliega con la imagen en marcha los servicios
  cuyo entorno resuelto cambia (se guarda el de todos los que no son bases de
  datos antes de reescribir y se compara después): así entran también los que
  toman el usuario de otra variable y, con una compartida, los que la heredan
  sin definirla (Skyway no puede saber si la usan). Un servicio que nunca se ha
  desplegado bien solo queda con cambios sin desplegar (`bumpConfigRev`). Las
  confirmaciones (la baja, «Actualizar ahora» y «Actualizar y desplegar») solo
  nombran los usos que se reescriben; los que ya llevan la dirección nueva
  salen aparte («Ya usan … y entrarán en cuanto se actualice el buzón, sin
  volver a desplegar»). La baja y cancelar tras un «Volver»
  hacen lo mismo con todos los buzones con credenciales `skyway:*` **o** con
  usos sin gestionar.
- **Contraseñas de aplicación creadas a mano**: con un Mailway que lo informa,
  cada buzón del plan y de la vista trae `appsManuales` (las contraseñas de
  aplicación activas que no son `skyway:*`; un Mailway anterior no lo manda y
  no se avisa; Mailway ya descarta las revocadas y las invalidadas). Si un
  buzón pendiente las tiene, la vista lo enseña en `appsManuales`
  (`{mailboxId, email, apps, usadoEnProyecto}`) como aviso informativo: las
  aplicaciones de fuera de Skyway que las usan tendrán que entrar con la
  dirección nueva tras actualizar el buzón o tras la baja. Sale también si
  algún servicio del proyecto usa el buzón (`usadoEnProyecto`): Skyway pone al
  día ese servicio, pero no puede saber si la misma contraseña la usa además
  algo de fuera. Las confirmaciones de «Actualizar ahora» y «Actualizar y
  desplegar» de ese buzón lo repiten. Antes de preparar, el paso «Qué cambia»
  del asistente lo dice en la lista de buzones («Contraseñas de aplicación
  creadas a mano (…): tendrán que entrar con la dirección nueva»), además del
  aviso general de Mailway.
- **Baja y «Actualizar ahora» sin servicios que dejen de enviar**: el orden se
  mantiene (usuario en Mailway → variables → despliegue con la imagen en
  marcha). Desplegar antes con el usuario nuevo solo sería seguro con un único
  servicio por buzón y con Mailway respondiendo: con dos servicios, si uno
  falla, el otro ya estaría entrando con un usuario que aún no existe; y si
  Mailway no responde después de desplegar, el servicio nuevo tampoco entra. En
  su lugar: «una sola copia» por defecto en los bots retira la causa más
  probable del fallo (el 409 de dos copias); un despliegue que falla (no uno
  cancelado) se **reintenta una vez** automáticamente con la misma imagen; y si
  vuelve a fallar, alerta **crítica** `mail_login_deploy_failed` del servicio
  (««<servicio>» no puede enviar correo»: «El usuario de correo de
  «<servicio>» ha cambiado a <nuevo> y su despliegue ha fallado dos veces: el
  contenedor en marcha sigue entrando con <anterior>, que ya no es válido.»,
  con la solución «Abre «Cambiar de dominio» en el proyecto y pulsa «Reintentar
  este servicio». Si vuelve a fallar, revisa el registro del despliegue.») y el
  error del servicio en el cambio: «El despliegue ha fallado dos veces y
  «<servicio>» no puede enviar correo: su usuario ya es <a> y el contenedor en
  marcha sigue con <de>. Pulsa «Reintentar este servicio».». La baja no sigue
  (Mailway no da de baja el dominio anterior) y su error lo repite. La alerta
  se cierra sola con el siguiente despliegue correcto del servicio. Lo usan la
  baja (que espera), «Actualizar ahora» y cancelar (en segundo plano). Cada
  despliegue guarda con el servicio del cambio lo que necesita su seguimiento
  (`correo: {de, a, imageTag, reintento}`): si Skyway se reinicia a mitad,
  `marcarCambiosInterrumpidos` lo retoma al arrancar. Si hay un reintento
  automático del arranque en curso, cuenta como el reintento (si falla, la
  alerta salta sin volver a desplegar); si no queda ningún despliegue en
  curso, la alerta `mail_login_deploy_failed` salta al momento, con el texto
  «no ha terminado bien tras un reinicio de Skyway».
- **Servicios**: el estado de cada despliegue del cambio es el real
  (`estadoServicio`): un despliegue posterior correcto del servicio (manual, o
  el reintento automático del arranque) resuelve uno fallido. Cancelar,
  terminar y dar de baja exigen todos desplegados (409
  `migration_services_pending`): antes, «Reintentar este servicio», que
  reutiliza la imagen en marcha si el despliegue fallido también lo hacía (el
  reintento automático tras un reinicio, también). Un servicio eliminado no
  bloquea: sus despliegues se borran con él y ninguno resolvería su error.
- **El proyecto y su correo**: con un cambio abierto que incluye el correo, ni
  se elimina el proyecto ni se desactiva su correo (409 `migration_open`): el
  cambio de Mailway (origen `skyway`) quedaría abierto sin que nadie pudiera
  cerrarlo desde su panel.
- **Correo de la cuenta**: los proyectos de una cuenta comparten su cliente de
  Mailway, así que el dominio de correo y sus buzones son de toda la cuenta y
  el cambio de Mailway los muda todos; el asistente, en cambio, solo actualiza
  y despliega los servicios de su proyecto. Mientras otro proyecto vinculado al
  mismo cliente tenga variables de correo (usuario, remitente o URL SMTP, del
  servicio o compartidas) con una dirección del dominio anterior, el plan lo
  bloquea (salvo «Solo la web»), la vista no ofrece la baja y lo explica, y la
  baja y «Actualizar ahora» responden 409 `migration_shared_mail` sin cambiar
  nada: tras la baja, esas aplicaciones se quedarían con un usuario o un
  remitente que ya no existen. Las credenciales de los servicios se reconocen
  con los nombres de `credentialNames` (`skyway:<proyecto>/<servicio>` en una
  cuenta y, en un vínculo de antes de compartir los clientes,
  `skyway:<servicio>`). La renovación automática de las contraseñas de
  aplicación (`mailwayrenovacion.ts`) escribe el usuario del motor (`login`):
  entre «Pasar» y la baja, la dirección anterior.
- Las acciones guardan el estado intermedio antes de empezar y son
  idempotentes («Reintentar»); un mutex en memoria por proyecto las serializa.
  Al arrancar, `marcarCambiosInterrumpidos` deja con error los que cortó el
  reinicio y vuelve a seguir los despliegues en curso (o el reintento
  automático que lanzó el arranque en su lugar).
- Auditoría: `domain_migration_created`, `…_switched`, `…_rolled_back`,
  `…_cancelled`, `…_retired`, `…_finished`, `…_service_retried`,
  `…_mx_changed`, `…_host_mode` y `domain_redirects_removed` (proyecto,
  `dominio.es → dominio2.es`; en `…_host_mode`, el nombre y el cambio de modo);
  `service_env_replaced` con los nombres de las claves, nunca los valores;
  `mailway_mailbox_login_updated`.

---

## 7. Referencia de la API REST

Convenciones: base `/api`. Autenticación por **cookie** de sesión o **`Authorization: Bearer sky_…`**.
Niveles: **público** · **auth** (sesión o token) · **session** (solo cookie) ·
**admin** (rol admin) · **+access** (además, acceso al workspace del recurso).
Los cuerpos son JSON salvo indicación; la subida de archivos es binaria.

### 7.1 Autenticación y cuenta
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/auth/me` | público | `needsSetup` + usuario actual |
| POST | `/auth/setup` | público¹ | crea el primer admin (¹solo si no hay usuarios) |
| POST | `/auth/login` | público (rate-limit) | login por email+contraseña |
| POST | `/auth/logout` | auth | cierra sesión |
| POST | `/auth/password` | session | cambia la contraseña (invalida otras sesiones) |
| GET | `/auth/passkeys` | auth | lista passkeys propias |
| POST | `/auth/passkeys/options` | session | opciones de registro WebAuthn |
| POST | `/auth/passkeys` | session | registra una passkey (409 si ya estaba registrada) |
| DELETE | `/auth/passkeys/:id` | session | borra una passkey (solo desde el navegador: un token de API no puede desarmar el segundo factor) |
| POST | `/auth/passkey-login/options` | público (rate-limit) | opciones de login con passkey |
| POST | `/auth/passkey-login` | público (rate-limit) | login con passkey (sin email) |

### 7.2 Tokens de API y usuarios
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/tokens` | auth | lista tokens del usuario (`last_used_at` se actualiza como mucho cada 60 s) |
| POST | `/tokens` | session | crea token (`{name, expiresDays?}`) → devuelve el valor una vez |
| DELETE | `/tokens/:id` | session | revoca un token (solo desde el navegador: un token no puede revocar a otros) |
| GET | `/users` | admin | lista usuarios |
| POST | `/users` | admin | crea usuario (`{email, password, role, projectIds, workspaceId?}`): un miembro puede nacer dentro de una cuenta de cliente (sus proyectos deben ser de esa cuenta; cuenta la cuota de usuarios); un administrador no admite cuenta (400) |
| PATCH | `/users/:id` | admin | cambia rol / proyectos / contraseña / **cuenta** (`workspaceId`, `null` = sin cuenta). Es la única vía para mover un usuario de cuenta: se retiran sus proyectos salvo que lleguen los de la cuenta nueva en la misma petición; respeta la cuota de destino (409); un propietario no puede quedar sin cuenta; nadie cambia la suya propia. Auditado como `user_workspace_changed` |
| DELETE | `/users/:id` | admin | elimina usuario (deja ≥1 admin) |

Desde la terminal del servidor, `tools/token.js` crea tokens iguales a los de `POST /tokens` (de un
administrador y con caducidad obligatoria) y los revoca, sin HTTP (§9).

### 7.2.1 Cuentas de cliente, planes y facturación
Niveles: **manage** = admin o propietario del workspace del recurso; **admin** = solo administrador de plataforma.

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/modules` | auth | catálogo de módulos (capacidades) para las etiquetas de la UI |
| GET | `/workspaces` | auth | admin: todas; propietario: la suya; miembro: ninguna. Incluye cuota, asignación y módulos |
| POST | `/workspaces` | admin | crea una cuenta (`{name, planId?, billingEmail?, billingDay?}`); un plan archivado no se contrata (400), aquí ni en el PATCH |
| GET | `/workspaces/:id` | manage | cuenta + proyectos + sub-usuarios + `planHistory` (tramos de plan con su tarifa y sus fechas) |
| PATCH | `/workspaces/:id` | admin | **live resize**: cuota, plan, concesión de módulos, estado (suspender), facturación. Cambiar de plan cierra el tramo vigente del historial y abre otro en la misma transacción. Cambiar el nombre renombra también, en segundo plano, el cliente de correo de la cuenta en Mailway (`PATCH /api/clients/:id`), si lo tiene; un fallo no deshace nada y se audita (`mailway_client_rename_failed`) |
| DELETE | `/workspaces/:id` | admin | elimina la cuenta y sus sub-usuarios; sus proyectos quedan sin asignar. En segundo plano suelta en Mailway la referencia `skyway:workspace:<id>` de su cliente de correo, solo si todavía la lleva (el cliente y sus buzones siguen en Mailway) |
| PATCH | `/workspaces/:id/modules` | manage | el propietario **acota** (desactiva) módulos concedidos (`{disabled}`) |
| GET | `/workspaces/:id/usage?days=` | manage | uso agregado (núcleo·h, GB·h, picos) del periodo |
| GET | `/workspaces/:id/usage/series?days=` | manage | serie temporal de uso por cubos (para gráficas) + top de proyectos por consumo |
| POST | `/workspaces/:id/members` | manage (session) | crea un sub-usuario del workspace (el propietario solo crea miembros) |
| PATCH | `/workspaces/:id/members/:userId` | manage | cambia rol/proyectos/contraseña de un sub-usuario |
| DELETE | `/workspaces/:id/members/:userId` | manage | elimina un sub-usuario del workspace |
| GET | `/plans` | admin | lista de planes (con nº de cuentas que lo usan) |
| POST | `/plans` | admin | crea un plan (usos incluidos + precio + `discount_pct` opcional) |
| PATCH | `/plans/:id` | admin | edita un plan (409 al cambiar la moneda de uno contratado) |
| DELETE | `/plans/:id` | admin | borra un plan (bloqueado si alguna cuenta lo usa) |
| GET | `/workspaces/:id/invoices` | manage | facturas de la cuenta (con `due_at`, el vencimiento congelado) + datos del emisor (perfil fiscal), del cliente y si Stripe está activo |
| POST | `/workspaces/:id/invoices/generate` | admin | genera la factura del ciclo (plan + uso) con el IVA del perfil |
| POST | `/workspaces/:id/invoices` | admin | crea un borrador a medida (`{lines[], taxRate?, irpfRate?, vatRegime?, operationDate?, notes?}`); cada línea admite su propio `taxRate`; 400 si `periodEnd ≤ periodStart` |
| PATCH | `/invoices/:id` | admin | edita el borrador o transiciona el estado. **El contenido fiscal solo es editable en borrador**; una factura emitida es inmutable (409). Al emitir (`issued`/`paid`) congela emisor y destinatario, asigna nº de serie del ejercicio y bloquea (`locked`). Transiciones válidas: `draft→issued→paid`, `→void`; nunca vuelve a borrador. Anular una factura con rectificativa viva → 409 (sería un doble abono) |
| DELETE | `/invoices/:id` | admin | **solo borradores**; una factura emitida se conserva (409): debe anularse o rectificarse, nunca borrarse |
| POST | `/invoices/:id/rectify` | admin | crea una **factura rectificativa** (borrador, serie REC) que corrige una emitida (`{reason, lines?, operationDate?}`); sin `lines` es anulación total, con `lines` correctas factura la diferencia; enlaza por `rectifies_invoice_id` |
| POST | `/invoices/:id/stripe-link` | admin | emite la factura (alta antes del cobro) y crea/reutiliza el enlace de pago Stripe; 400 si el total es ≤ 0 (antes de emitir), 409 si ya se está generando; el enlace guardado se renueva si Stripe lo da por caducado (`reused: true` solo si sigue abierto) |

**Motor de factura conforme (RD 1619/2012).** El total se recomputa siempre en
servidor: la cuota de IVA se agrupa por tipo y se redondea **una vez por base de
tipo** (`tax_breakdown`), no por línea; el IRPF se retiene sobre la base
imponible; `total = base + IVA − retención`. La numeración es correlativa por
serie y ejercicio (`invoice_series`), asignada atómicamente al emitir. Una factura
emitida es **inmutable** y se **conserva** (no se borra ni se puede borrar su
cuenta si tiene facturas). El catálogo multimodular (productos web/IA/hosting/BBDD,
suscripciones y uso medido) está descrito en §7.2.2.

**Rectificativas y regímenes especiales (art. 15 RD 1619/2012).** Una factura
emitida solo se corrige emitiendo una **rectificativa** (`invoice_type =
'rectificativa'`, serie **REC** propia): revierte la original y aplica —si se
indican— las líneas correctas, de modo que el neto es la corrección (rectificación
por diferencias); sin líneas correctas, anula la original por completo. Queda
enlazada por `rectifies_invoice_id`, guarda el `rectify_reason` y una mención legal
con la factura rectificada; la original permanece intacta. Los **regímenes de IVA**
(`vat_regime`) aplican la mención legal obligatoria y ponen el IVA a cero cuando
corresponde: exención por exportación (art. 21) o entrega intracomunitaria
(art. 25), inversión del sujeto pasivo (art. 84), recargo de equivalencia, no
sujeción y otras exenciones. Reservado: la estructura Verifactu (cadena de hash,
QR, registros de alta/anulación y remisión a la AEAT — no obligatoria hasta 2027,
RDL 15/2025).

### 7.2.1 Contabilidad de la empresa y facturación (nosotros como emisor)
Perfil fiscal, resumen contable y cobros con Stripe. **Solo admin.** Las claves
secretas de Stripe se guardan en `settings` y nunca se devuelven (se exponen como
booleanos, igual que el token de GitHub).

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/billing/profile` | admin | perfil fiscal del emisor (IVA/IRPF por defecto, modo Verifactu) + estado de Stripe (claves como booleanos) |
| PUT | `/billing/profile` | admin | actualiza el perfil fiscal (incl. `defaultIrpfRate`, `sifMode`); las claves de Stripe se guardan solo si se envían (`''` las borra) |
| GET·PUT | `/billing/automation` | admin | automatización: `autoGenerate` (generar el borrador del ciclo), `autoIssue` (emitirlo automáticamente; opt-in, off por defecto) y umbrales de morosidad (`dunningGraceDays` ≤ `dunningCancelDays`) |
| GET | `/accounting/summary?months=` | admin | totales (facturado/cobrado/pendiente/borrador/anulado), serie mensual de ingresos y desglose por cliente |
| GET | `/accounting/invoices?status=` | admin | todas las facturas de todos los clientes (nº, tipo, NIF, base, IVA, IRPF) |
| GET | `/accounting/export.csv` | admin | libro registro de facturas emitidas en CSV (nº, tipo, NIF receptor, base, IVA, IRPF, total; guardas anti-inyección de fórmulas) |

### 7.2.2 Catálogo multimodular, suscripciones y uso
Facturación de servicios (web, IA, hosting, BBDD, dominios, soporte, a medida)
con distintos modelos de precio. El catálogo lo gestiona el admin; las
suscripciones y cargos se contratan por cuenta y se ensamblan en el borrador del
ciclo (`/invoices/generate`).

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/products` | auth | catálogo de productos (con sus tramos y si están en uso) |
| POST | `/products` | admin | crea un producto (`{name, category, billingModel, priceCents, meter?, tierMode?, tiers?, taxRate?, …}`); `metered`/`tiered` exigen `meter` (400), también al editar |
| PATCH | `/products/:id` | admin | edita un producto y sus tramos |
| DELETE | `/products/:id` | admin | borra el producto; si está contratado se **archiva** (conserva el histórico) |
| GET | `/workspaces/:id/subscriptions` | manage | suscripciones y cargos pendientes de la cuenta |
| POST | `/workspaces/:id/subscriptions` | admin | suscribe la cuenta a un producto recurrente/por uso (`{productId, qty?, unitCents?}`); **rechaza los de pago único** (`flat_one_off`), que se añaden como cargo |
| PATCH | `/subscriptions/:subId` | admin | cambia cantidad/precio/estado (pausar, cancelar) |
| DELETE | `/subscriptions/:subId` | admin | elimina la suscripción |
| POST | `/workspaces/:id/charges` | admin | añade un pago único al próximo ciclo (`{label?, qty?, unitCents?, taxRate?, productId?}`); con `productId` de catálogo autocompleta concepto, precio e IVA (una sola vez, no recurrente) |
| DELETE | `/charges/:chargeId` | admin | cancela un cargo puntual pendiente |
| POST | `/usage` | +access | ingesta idempotente de consumo IA/lógico (`{idempotencyKey, subjectType, subjectId, meter, quantity, ts?}`); exige acceso al workspace del sujeto |

**Medición y generación.** Los medidores de infraestructura (`cpu_core_hour`,
`mem_gb_hour`) se derivan de `service_metrics_hourly`; los lógicos/IA
(`ai_tokens_in`, `ai_tokens_cache_in`, `ai_tokens_out`, `ai_requests`, `ai_bytes`,
`unit`) se ingieren por `/usage` o por el gateway. Al generar el borrador del
ciclo se suman: plan + suscripciones activas (recurrentes fijas, por uso medido y
por tramos graduated/volume) + cargos puntuales pendientes; el IVA se desglosa por
tipo y los cargos se marcan como facturados.

### 7.2.3 Gateway de IA (Gemini) — proxy con medición por cliente
Skyway actúa de **proxy multiplexado** ante Gemini: guarda una clave de proyecto
del operador (en `settings`, nunca expuesta) y emite una clave `skai_…` por cuenta
que abre **solo** el proxy (jamás el panel). Tras cada respuesta lee `usageMetadata`
y registra el consumo (`ai_tokens_in`/`ai_tokens_cache_in`/`ai_tokens_out`/`ai_requests`),
que se factura con los productos de IA del catálogo. El corte (impago o manual) es
inmediato y reversible: se hace sobre la clave de Skyway, sin tocar Google.

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| POST | `/gw/v1beta/models/<modelo>:generateContent` | clave `skai_` (auth propia) | proxya a Gemini con la clave del operador; valida modelo (allowlist fail-closed), mide `usageMetadata` y registra el uso |
| POST | `/gw/v1beta/models/<modelo>:streamGenerateContent` | clave `skai_` | igual, en **streaming SSE** (`?alt=sse` reenviado byte a byte); mide el último `usageMetadata` al cerrar |
| POST | `/gw/v1beta/openai/chat/completions` | clave `skai_` | API **compatible con OpenAI** (streaming y no-streaming); el `usage` se mapea a la medición existente |
| GET | `/gw/v1beta/models` | clave `skai_` | modelos permitidos para esa clave |
| GET | `/workspaces/:id/keys` | manage | claves de IA de la cuenta (prefijo, estado, uso; nunca el secreto) |
| POST | `/workspaces/:id/keys` | manage (session) | emite una clave; el secreto `skai_…` se devuelve **una sola vez** |
| PATCH | `/workspaces/:id/keys/:keyId` | admin | edita nombre/modelos/presupuesto/límite/caducidad |
| POST | `/workspaces/:id/keys/:keyId/block`·`/unblock` | admin | corte / reactivación manual (instantáneo) |
| DELETE | `/workspaces/:id/keys/:keyId` | manage | revoca la clave (irreversible) |
| GET·PUT | `/ai/gateway/config` | admin | clave de Gemini (enmascarada), host y modelos permitidos |
| GET | `/ai/gateway/prices` | admin | coste del operador por modelo (`ai_model_prices`), margen objetivo, **PVP sugerido** (coste/(1−margen)), PVP de referencia del catálogo, estado de la autoactualización (`sync`) y tarifa de lista conocida (`list_usd`) |
| PUT·DELETE | `/ai/gateway/prices/:model` | admin | fija/borra coste (€/M: entrada, cache, salida) y `marginPct` (margen objetivo s/ venta) de un modelo. Tocar el coste marca la fila `manual`; cambiar solo el margen la deja en `auto`; borrarla la devuelve al automático |
| POST | `/ai/gateway/prices/sync` | admin+sesión | refresca la tarifa contra Google ahora mismo y devuelve el resultado (altas, actualizados, respetados a mano, sin tarifa, modelos nuevos detectados) |
| PUT | `/ai/gateway/prices/config` | admin | ajustes de la autoactualización: `auto`, `url` (fuente propia), `currency`, `fxRate`, `defaultMarginPct`, `autoAllow` |
| GET | `/workspaces/:id/alerts` | manage | avisos de la cuenta (facturación, uso, morosidad) |

**Automatización (scheduler, bucle de 10 min → `billingauto.ts`, ajustes en
`billingsettings.ts`).** Si `autoGenerate` está activo (por defecto), en el día de
facturación de cada cuenta se **genera el borrador** del ciclo completo anterior
(idempotente por `(workspace, period_start)`). Por defecto **no se emite** —la emisión
es un acto legal irreversible y la confirma un humano—; si el operador activa
`autoIssue` (opt-in, off por defecto) el borrador se **emite** solo (número de serie +
bloqueo) y se avisa por alerta. Todo es configurable desde Contabilidad →
«Automatización de facturación». Después se evalúa la **morosidad**: una factura
emitida y no cobrada pasa a
vencida a los `paymentTermsDays`, dispara recordatorio, y a los `dunningGraceDays`
**suspende** las claves de IA y pausa las suscripciones (alerta crítica), y a los
`dunningCancelDays` las **revoca**/cancela. Todo es idempotente (solo avanza de
etapa) y se aísla por cuenta. Al **cobrarse** (webhook de Stripe o marca manual)
se **reactiva** automáticamente si ya no queda ninguna factura vencida. Las
alertas por cuenta reutilizan `alerts` (con `workspace_id`).

**Seguridad del gateway.** La clave de cliente usa una vía de autenticación
separada (`requireProxyKey`, en un hook `onRequest` **antes** de leer el cuerpo,
nunca `requireAuth`) y un prefijo que **no** empieza por `sky_`, de modo que no
puede alcanzar el panel ni el `docker.sock` del host; se valida en cada petición
(sin caché → suspender surte efecto al instante). La clave de Gemini del operador
nunca se registra ni se reenvía, y las cabeceras de Google no se propagan al
cliente. La URL upstream se construye en servidor a partir del modelo validado (no
se refleja el path del cliente → anti-SSRF).

**Presupuesto y límite por clave.** Cada clave admite `budget_cents_month` (tope de
gasto del ciclo) y `rate_limit_rpm` (peticiones por minuto, token-bucket en
memoria). El proxy acumula el gasto tarifado del cliente en `spend_cents_cycle`
(sumando fracciones de céntimo para no perder peticiones pequeñas) y **rechaza**
con 402 al superar el presupuesto y con 429 al superar el ritmo; el contador se
reancla al inicio de cada ciclo. Es un guardarraíl (importe aproximado); el importe
final de factura lo fija el catálogo al cerrar el ciclo.

**Streaming y compatibilidad.** Además de `generateContent`, el proxy admite
`streamGenerateContent` (SSE nativo de Gemini, `?alt=sse`, reenviado tal cual al
cliente) y una **API compatible con OpenAI** (`/gw/v1beta/openai/chat/completions`,
streaming y no-streaming) para reutilizar SDKs existentes apuntando el `baseURL` al
gateway. En ambos casos se lee el **último** bloque de uso del flujo y se factura
igual que en la vía no-streaming; el presupuesto/límite se comprueban antes de abrir
el flujo. La `usage` de OpenAI se traduce a un `usageMetadata` sintético
(`prompt_tokens`→entrada, `cached_tokens`→cache, `completion_tokens`→salida).

**Precios de IA por cliente.** En la ficha del cliente, el panel «Precios de IA de
este cliente» da de alta en un clic las suscripciones a los productos de IA del
catálogo (al precio global) y permite fijar un **precio propio por medidor**. Se
apoya en el override `unit_cents` de la suscripción (vacío = precio global del
catálogo; restablecer lo vuelve a vaciar). Un precio propio queda excluido del
descuento por cuenta (ya es un precio pactado). No cambia la lógica de facturación.

**Coste y margen (informativo).** `ai_model_prices` guarda el **coste del operador**
por modelo (lo que cobra Google, en micro-céntimos por millón de tokens: entrada,
cache y salida) y un **margen objetivo** sobre venta (`margin_pct`). Contabilidad
muestra ese coste, el **PVP sugerido** = coste/(1−margen/100) (para copiarlo al
producto de IA del catálogo) y el **margen actual** frente al PVP de referencia del
catálogo (primer producto de IA activo de cada medidor). Es una guía de precios: no
interviene en la factura; el PVP real lo fija el catálogo por medidor.

**Autoactualización de la tarifa (`aiprices.ts`).** El coste no se teclea: Skyway lo
trae de la tarifa vigente de Google **una vez al día** (tic del `scheduler`, o
«Actualizar ahora» en Contabilidad) y recalcula el PVP sugerido con el margen que ya
tuviera cada modelo. Detalles del pase:

- **Fuentes, por orden**: la que configure el operador (`ai.prices.url`, un JSON
  `{modelo: {in, cache, out}}` en USD/Mtok), la **página oficial** de precios y el
  **catálogo interno** con fecha (red de seguridad sin conexión). El catálogo solo
  rellena huecos de una lectura parcial; nunca la pisa. De la página se toma la
  tarifa *estándar* (no batch) y, en los precios por tramo, la del contexto corto.
- **Nunca inventa un precio**: el modelo sin tarifa en ninguna fuente se deja como
  esté y se reporta en `missing` (p. ej. un modelo permitido que Google no tarifa
  por token). Una lectura de la página con menos de tres modelos se descarta entera.
- **Moneda**: Google tarifa en USD y el coste se guarda en `ai.prices.currency`
  (EUR por defecto) usando la referencia del BCE, cacheada en `ai.prices.fx`. Sin
  cambio fiable la sincronización **falla con aviso** en vez de guardar dólares como
  si fueran euros; el operador puede fijar el cambio a mano. Cambiar de moneda
  descarta el cambio guardado.
- **El margen es del operador**: se conserva intacto en cada pase y solo se estrena
  (`ai.prices.defaultMarginPct`) en un modelo que aparece por primera vez.
- **Manual manda**: editar el coste de un modelo marca su fila `manual` y la
  sincronización deja de tocarla (borrarla la devuelve al automático). Cambiar solo
  el margen la mantiene en `auto`.
- **Altas de Google**: se listan los modelos que la clave del operador ya puede usar
  y tienen tarifa conocida, pero **no** se permiten solos salvo que se active
  `ai.prices.autoAllow` (fail-closed: permitir un modelo sin tarifa sería tarifar a
  ciegas). Cada pase queda en auditoría (`ai_prices_synced`).

**Descuento comercial por plan y por cuenta.** Los planes llevan un `discount_pct`
que rebaja las facturas de todas sus cuentas; cada cuenta puede fijar su propio
`discount_pct` (null = hereda el del plan). Al generar el borrador del ciclo, el
descuento efectivo (`cuenta ?? plan ?? 0`) se aplica **sobre la base antes del IVA**
empujando una línea de descuento **por cada tipo impositivo** presente, de modo que
el desglose de IVA sigue cuadrando (la cuota se redondea una vez sobre la base ya
descontada) y ninguna base queda negativa. Se excluyen del descuento las líneas con
**precio negociado por cliente** (`unit_cents` de la suscripción), para no rebajar
dos veces un precio ya pactado. En una factura a medida el descuento se añade a mano
como línea negativa; una factura emitida es inmutable y conserva su descuento.

### 7.3 Proyectos, variables compartidas y GitHub
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/projects` | auth | proyectos accesibles (con meta); la `config` de cada servicio sale sin `webhookSecret` y con los valores de `buildArgs` tapados |
| POST | `/projects` | admin/owner | crea proyecto (`{name, client?, workspaceId?}`); el propietario en su workspace, dentro de la cuota (409 si su cuenta ya no existe) |
| GET | `/projects/:id` | +access | proyecto + servicios con runtime y `pendingChanges` (cambios sin desplegar) + `activeDeploys` (despliegues vivos por servicio); `config` sin `webhookSecret` y con `buildArgs` tapados |
| PATCH | `/projects/:id` | manage | renombra; el admin además reasigna de workspace |
| DELETE | `/projects/:id?confirm=<nombre>` | manage | elimina el proyecto con **todos sus datos** (§3.1): contenedores, volúmenes de todos sus servicios, imágenes construidas, copias de seguridad, red y alertas abiertas; libera sus reservas de dominio. `confirm` es el nombre visible exacto o el slug; sin él o si no coincide, 400 sin borrar nada. Sin Docker, 503 sin borrar nada; 409 si ya se está borrando; 409 `migration_open` con un cambio de dominio abierto que incluye el correo (§6.1); y 409 con `{error, warnings}` sin borrar volúmenes ni filas si un contenedor no se pudo retirar o un despliegue no terminó de cancelarse (reintentar es seguro). Lo que no se pudo retirar después va en `warnings` → `{ok, warnings, removed: {services, volumes[], images, backups}}`. Ya no existe la opción `volumes` |
| POST | `/projects/:id/deploy-all` | +access | despliega repos e imágenes del proyecto |
| GET | `/projects/:id/vars` | +access | variables compartidas |
| PUT | `/projects/:id/vars` | +access | reemplaza variables compartidas; responde `affected` |
| PATCH | `/projects/:id/vars` | +access | aplica solo los cambios `{set, unset}` sobre las actuales (lo que usa el panel); responde `{vars, needsRedeploy, affected}` con los servicios que hay que volver a desplegar (cada uno con su `type`: el panel ofrece desplegar las apps y deja las bases de datos aparte, sin marcar, porque reiniciarlas corta el servicio y las variables compartidas rara vez les afectan) |
| GET | `/projects/:id/connectors` | +access | conectores del proyecto (sin tokens) + `hasGlobalToken` |
| POST | `/projects/:id/connectors` | +access | conecta un token (`{name, token}`; se verifica contra GitHub) |
| DELETE | `/connectors/:id` | +access | elimina un conector (sus servicios vuelven al token global) |
| POST | `/connectors/:id/test` | +access | revalida el token guardado contra GitHub |
| GET | `/connectors/:id/repos` | +access | repos visibles con ese token (para el selector; hasta 1000, propios, de colaborador y de organización) |
| GET | `/connectors/:id/repos/lookup?repo=` | +access | comprueba UN repo escrito a mano (`owner/repo` o URL) con ese token → `{repo}`; 404 con explicación si el token no lo ve |
| GET | `/connectors/:id/branches?repo=owner/repo` | +access | ramas del repo (hasta 500, la por defecto primero) |
| GET | `/connectors` | admin | todos los conectores de todos los proyectos (control central) |

**GitHub App** (§5.4). Es el camino recomendado y convive con los conectores:

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/github/app` | auth | estado de la App (`configured`, slug, `webhookUrl` con el dominio del panel, `panelReachable`); nombre y slug refrescados desde GitHub (≤ 1 vez/5 min). Para el admin, `webhookUrlActual`: la URL que tiene la App en GitHub (`GET /app/hook/config`, ≤ 1 vez/min) o `webhookUrlError` |
| POST | `/github/app/webhook-url` | admin+sesión | apunta el webhook de la App en GitHub al dominio del panel (`PATCH /app/hook/config`); la URL la decide el servidor. 400 `panel_not_public` si el panel no tiene dominio público. Audita `github_app_webhook_updated` |
| POST | `/github/app/manifest` | admin+sesión | manifiesto y URL de acción para crear la App desde el navegador (`{org?}`) |
| GET | `/github/app/setup?code&state` | admin+sesión | retorno de GitHub: canjea el código y guarda las credenciales |
| POST | `/github/app/disconnect` | admin+sesión | olvida las credenciales (la App sigue existiendo en GitHub) |
| GET | `/github/app/install?projectId=` | +access | 302 a GitHub para instalar la App (sin `projectId`, instalación global; solo admin) |
| GET | `/github/app/installed?installation_id&state` | auth | retorno de la instalación: registra la cuenta conectada. Sin `state` válido, un administrador con sesión la registra como global; una instalación ya conectada a otro proyecto o al servidor la reasigna solo el admin (`?github=instalacion_ajena`) |
| GET | `/projects/:id/github/installations` | +access | instalaciones usables desde el proyecto (las suyas y las globales) |
| GET | `/projects/:id/github/lookup?repo=` | +access | comprueba un repo sin cuenta elegida: con el token global si lo hay, si no como anónimo → `{repo, credential: 'global'|'public'}`; 404 con explicación |
| GET | `/github/installations` | admin | todas las instalaciones (vista central) |
| POST | `/github/installations/:rowId/sync` | +access\* | refresca desde GitHub (repos elegidos, suspensión) |
| DELETE | `/github/installations/:rowId` | +access\* | quita la conexión (la App sigue instalada en GitHub) |
| GET | `/github/installations/:rowId/repos` | +access | repos que la instalación deja ver (`?projectId=` opcional: con una instalación global, acota el permiso a ese proyecto) |
| GET | `/github/installations/:rowId/repos/lookup?repo=` | +access | comprueba UN repo escrito a mano (`owner/repo` o URL) con la instalación → `{repo}`; 404 con explicación si la App no lo ve (`?projectId=` opcional) |
| GET | `/github/installations/:rowId/branches?repo=owner/repo` | +access | ramas del repo (hasta 500; `?projectId=` opcional, igual que arriba) |

\* Las instalaciones **globales** solo las gestiona el administrador.

**Conectores con token personal**: cualquier usuario con acceso al workspace
(clientes incluidos) conecta un token de su cuenta; al crear o editar un servicio
`git` elige la cuenta y el repo/rama. El token se guarda en el servidor, nunca se
devuelve, y solo se usa para listar repos y clonar. Todo queda auditado
(`connector_created`/`connector_deleted`, `github_installation_connected`/
`github_installation_removed`) y el admin lo controla desde Ajustes.

### 7.4 Servicios
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/templates` | auth | plantillas de BBDD disponibles, con sus variables de conexión (`conn`) |
| GET | `/stacks` | auth | catálogo de pilas de aplicaciones (§5.1) |
| POST | `/projects/:projectId/stacks` | +access | crea una pila entera: `{stack, prefix?, domain?}` → `{stack, prefix, publicUrl, services[], dns?}`; atómica (409 si choca un nombre); `domain` como en crear servicio (409 si ya lo usa otro servicio o está reservado), con su pareja con o sin www (§5.5) y la pila configurada con el principal (`publicUrl`); `services[].config` sin `webhookSecret`. `dns`: DNS automático del dominio (§7.13, solo admin con token) |
| POST | `/railway-templates/preview` | auth | vista previa de una plantilla pública de Railway: `{template, prefix?}` → `{plan}` (no crea nada); 20 por minuto y usuario, después 429 |
| POST | `/projects/:projectId/railway-templates` | +access | instala la plantilla en el proyecto: `{template, prefix?, domain?}` (§5.2); mismas garantías que las pilas, también `dns?` |
| POST | `/projects/:projectId/services` | +access | crea servicio (git/database/image); cada dominio debe ser un nombre de host válido (RFC 1123, se guarda en minúsculas y en el orden del dominio principal, §5.5), aquí y en el PATCH; se admiten acentos y «ñ» (se guardan en ASCII, *punycode*: `panadería.es` → `xn--panadera-i2a.es`, como en Mailway) y la URL pegada (se quitan esquema, ruta, puerto y punto final); cada dominio registrable o con www se guarda con su pareja con o sin www salvo los de `dominiosSinPareja` (opcional, máx. 200; la pareja que no se puede asignar se omite sin error, §5.5), y **no puede estar asignado a otro servicio** ni ser el del panel (`SKYWAY_DOMAIN`); fuera del proyecto de Mailway y salvo para el admin, tampoco uno de Mailway (su URL pública, panel, webmail, servidor de correo, los de las rutas de Traefik de sus contenedores, los que fueron suyos y el administrador no ha liberado, un dominio que publica en Traefik o un nombre de marca blanca de cualquier cliente, también esperando DNS) → 409 (`domainguard.ts`); en `git`, `env` opcional: variables con las que nace, antes del primer despliegue (§5.5), y `plan: {skip?, expect?, confirmMailboxAccess?}` opcional: aplica el plan de integraciones del repositorio antes del primer despliegue (§5.7; `skip` ⊂ `postgres`, `redis`, `mysql`, `mongo`, `minio`, `mail`, `empty`, validado antes de crear nada; `expect` es la huella del plan de `github/needs`: sin ella, o si el repositorio ya pide otra cosa, lo privilegiado queda pendiente) y la respuesta añade `plan: {result, plan, error}`. Para un administrador con el token de Cloudflare configurado, la respuesta añade `dns` con el resultado del DNS automático de cada dominio (§7.13). El nombre (aquí y en el PATCH, como el del proyecto) no admite saltos de línea ni caracteres de control → 400 |
| GET | `/services/:id` | +access | servicio + runtime + último deploy; conserva `webhookSecret`, los valores de `buildArgs` salen tapados (`•••`). Añade `pendingChanges`, `autoDeploy` (servicios git con auto-deploy: `{pollSeconds, checkedAt, okAt, error, failingSince, lastSeenSha}`), `webhook` (`{url, coveredByApp}`: URL del webhook manual con el dominio del panel y si ya lo cubre la GitHub App) y `deploy` (`ServiceDeployInfo`: `{strategy: 'overlap'\|'recreate', reason: 'elegida'\|'base_de_datos'\|'estado'\|'sin_trafico'\|'con_trafico', automatic, calledByOthers, stopGraceSeconds, stopGraceSource: 'servicio'\|'railway'\|'defecto'}`: estrategia efectiva y su motivo, si otro servicio lo llama por la red interna y la gracia de parada efectiva con su origen, calculada con el entorno resuelto; §2) |
| PATCH | `/services/:id` | +access | edita `name`/`config` (recursos en caliente, en todas las réplicas); cada dominio **nuevo** registrable o con www llega con su pareja con o sin www salvo que esté en `config.dominiosSinPareja` (§5.5; la lista de renuncias se guarda limpia y, enviada sin `domains`, solo se filtra contra los actuales); los dominios **nuevos** pasan la misma comprobación que al crear (409), los que ya tenía el servicio se conservan; `domainsBase` opcional (lista de los dominios de los que parte quien edita): si no coincide con los actuales, unos `config.domains` iguales a la base se ignoran (se conservan los actuales) y unos distintos dan 409 («han cambiado mientras los editabas»); solo los nuevos pasan por el DNS automático, y solo con `domainsBase` (`dns`, §7.13, solo admin); la lista se guarda en el orden del dominio principal (§5.5), y un cambio solo de orden no cuenta como dominio nuevo (ni pide volver a desplegar si, ordenada, la lista queda igual); responde con `buildArgs` tapados, y un valor `•••` recibido conserva el build arg que ya había. `config` admite además `deployStrategy` (`'auto'`\|`'overlap'`\|`'recreate'`; `'auto'` lo deja sin fijar; se ignora en bases de datos), `stopGraceSeconds` (entero 0–600, también como cifras en texto; `null` o `""` lo dejan sin fijar; otro tipo da 400; en una base de datos, de 10 a 600: un valor menor da 400) y `stopCommand` (texto de hasta 1000 caracteres o `null`; vacío o `null` lo quita; se ignora en bases de datos; guardar uno nuevo exige el módulo «Terminal de comandos» y un workspace no suspendido, 403 si no, salvo a la administración, y queda en la auditoría como `service_stop_command` con los primeros 120 caracteres): ninguno pide volver a desplegar (la estrategia vale desde el siguiente despliegue y las paradas leen siempre la configuración actual). Al guardar `domains` o `port`, los demás servicios del proyecto cuyo entorno resuelto cambia (los que lo referencian con `${{<servicio>.PUBLIC_URL}}`, `INTERNAL_URL`…) quedan con cambios sin desplegar (`bumpConfigRev`) |
| DELETE | `/services/:id?confirm=<nombre>` | +access | elimina el servicio con **todos sus datos** (§3.1), salvo los volúmenes que comparta con otro servicio del proyecto; `confirm` (nombre o slug), 503 y los dos 409 como en proyectos → `{ok, warnings, removed: {volumes[], images, backups}}` |
| POST | `/services/:id/deploy` | +access | dispara despliegue manual (`{force: true}` recompila sin reutilizar imagen; `{commit: <SHA de 40>}` reconstruye ese commit, solo git) |
| POST | `/services/:id/{start,stop,restart}` | +access | acciones sobre el contenedor. Si el servicio no tiene un despliegue en cola o en marcha, antes retiran (o devuelven a su nombre) los restos de intercambios `--next`/`--prev` con parada limpia (un error ahí se registra y no impide la acción). `stop` detiene todas las réplicas en paralelo con parada limpia (comando al parar, SIGTERM y la gracia, después SIGKILL; §2), archiva su registro después de pararlas y responde además `forced: string[]`, las copias que no terminaron con SIGTERM a tiempo y se detuvieron con SIGKILL (el panel lo avisa). `restart` detiene a la vez todas las copias con la misma parada limpia y vuelve a arrancar cada contenedor (el mismo: conserva su identidad, §2), y también responde `forced`. Las dos responden cuando termina la parada: con un comando al parar y una gracia largos puede tardar hasta el doble de la gracia. Si un proxy corta antes la conexión (el de Cloudflare espera 100 s), la parada sigue en el servidor hasta el final; el estado se ve al recargar |
| GET | `/services/:id/env` | +access | variables (crudas, resueltas, referencias con `vars`/`auto`/`connect`) y propuestas de la detección de dependencias (`needs`, `suggestions`, `missing`, `mail`, `manifest`, §5.5) |
| GET | `/services/:id/integrations` | +access | plan de integraciones del servicio sin efectos (§5.7) → `{plan, pending}`; `plan` null si no es de repositorio. `plan.fingerprint` es la huella que exige aprobar; cada recurso trae `canApprove` y `confirmation` |
| POST | `/services/:id/integrations/apply` | +access | `{skip?, expect?, confirmMailboxAccess?, redeploy?}` → `{result: {applied, pending, kept, blocked, created, errors}, plan, needsRedeploy, deploymentId}`. Lo inofensivo lo aplica cualquiera con acceso; las bases también; el correo solo **manage** (si no, `pending`). Lo privilegiado exige `expect` = `plan.fingerprint` del plan revisado (sin él, `pending`; si no coincide, **409** `{error, plan}` sin aplicar nada); reutilizar en SMTP un buzón existente exige además `confirmMailboxAccess`. Nunca pisa variables puestas a mano. 409 si ya se está aplicando. 10/min. Audita `service_integrations_applied` (nombres, nunca valores) |
| PUT | `/services/:id/env` | +access | reemplaza variables del servicio (la lista entera) |
| PATCH | `/services/:id/env` | +access | aplica solo los cambios `{set, unset}` sobre las variables actuales: lo que otro haya escrito entretanto (importación del `.env`, secretos del manifiesto, credenciales de Correo) se conserva. 400 `invalid_key` con un nombre no válido; responde `{vars, needsRedeploy}` |
| POST | `/services/:id/env/import-repo` | +access | importa el `.env`/`.env.example` del repositorio de GitHub sin clonar: `{apply?: boolean}`; sin `apply` es vista previa (`report.imported[].value` relleno, nada se escribe); con `apply: true` crea las variables válidas, persiste el informe sin valores en `config.envImport` y devuelve `needsRedeploy`. Solo servicios git de GitHub (400 en el resto); 10 por minuto y usuario; auditado como `service_env_imported` |

### 7.5 Despliegues (logs por SSE)
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/services/:id/deployments` | +access | historial (25); en los servicios git, cada despliegue correcto lleva `imageAvailable` (si su imagen sigue en el servidor; ausente si Docker no responde) |
| GET | `/deployments/:id` | +access | detalle (incluye logs) |
| POST | `/deployments/:id/cancel` | +access | cancela uno en curso |
| POST | `/deployments/:id/rollback` | +access | redespliega una imagen anterior (solo git); 409 `image_purged` (con `commit`) si la imagen ya no está en el servidor, sin crear despliegue ni alerta |
| GET | `/deployments/:id/logs/stream` | +access | **SSE** de build/deploy |
| GET | `/projects/:id/deploys/stream` | +access | **SSE** del feed de despliegues del proyecto (evento `snapshot` + un `deploy` por cambio de fase). Independiente: pensado para agentes y automatizaciones que solo quieren los despliegues |
| GET | `/services/:id/logs/stream` | +access | **SSE** de logs de ejecución de todas las réplicas (cada línea con su cursor de tiempo, que viaja también como `id` del evento; las réplicas 2..n llevan prefijo `[rN]`). Si el contenedor se sustituye o se para, avisa (`notice`) y se vuelve a enganchar solo. Al reconectar, `Last-Event-ID` reanuda desde ese cursor |
| GET | `/services/:id/logs/tail` | +access | páginado hacia atrás: solo líneas **estrictamente** anteriores a un cursor (`?limit=&before=`) para cargar historial al subir. Docker filtra por segundos enteros: se pide de más y se recorta, y `hasMore` dice si queda historial |
| GET | `/services/:id/logs/download` | +access | descarga íntegra del log del contenedor como adjunto de texto (`?timestamps=1` para incluir sellos) |
| GET | `/projects/:id/metrics/stream` | +access | **SSE** de métricas en vivo del proyecto: `metrics` cada 2,5 s y, por la misma conexión, los despliegues (`deploys` al conectar + un `deploy` por cambio de fase). El panel abre solo esta, no las dos |
| GET | `/services/:id/metrics/history` | +access | histórico de consumo del servicio (`?hours=`): CPU/RAM (media y pico), red y disco |

### 7.5.1 Copia de datos desde una base externa (§5.6)
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/services/:id/data-migration` | manage | si el motor lo admite y estado de la copia en curso |
| POST | `/services/:id/data-migration/test` | manage | comprueba que el origen responde (`{sourceUrl}`, máximo 2048 caracteres) |
| POST | `/services/:id/data-migration` | manage | lanza la copia (`{sourceUrl}`, máximo 2048 caracteres); el destino se sobrescribe |
| POST | `/services/:id/data-migration/cancel` | manage | corta la copia en marcha |
| GET | `/services/:id/data-migration/stream` | manage | **SSE** del log de la copia |

### 7.6 Consola de base de datos
La tienen las bases que crea Skyway (postgres, mysql, mongo, redis) y, además,
los servicios de tipo imagen que **son** un PostgreSQL —el `db` de la pila
Supabase, un `postgres:16` suelto, una plantilla de Railway—, reconocidos por el
icono que declara la pila o por el nombre de la imagen. El detalle del servicio
(`GET /services/:id`) lo dice en `dbConsole`, y el panel enseña la pestaña según
eso.

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/services/:id/db/overview` | +access | esquema, tamaños y snippets |
| POST | `/services/:id/db/query` | +access | ejecuta (`{query, allowWrite}`); 60 por minuto y usuario, después 429 |
| GET | `/services/:id/db/browse-query` | +access | consulta sugerida (`?object=&mode=data\|describe`) |

### 7.7 Explorador de archivos (gestor tipo FTP)
Sin FTP ni credenciales: va por el socket de Docker con la sesión del panel. El
contenedor debe existir y estar en ejecución. Rutas absolutas; los `..` se
resuelven contra la raíz. Cada escritura queda auditada.

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/services/:id/files?path=/` | +access | lista un directorio del contenedor |
| GET | `/services/:id/files/download?path=/abs/fichero` | +access | descarga un archivo (máx. 50 MB) |
| POST | `/services/:id/files/upload?path=/dir&name=fichero` | +access | sube binario `octet-stream` (máx. 100 MB) |
| POST | `/services/:id/files/mkdir` | +access | crea carpeta (`{path}`) |
| POST | `/services/:id/files/delete` | +access | borra (`{path, recursive?}`) |

Implementación: listar/crear/borrar usan `ls`/`mkdir`/`rm` vía exec; descargar y
subir usan la API de archivos de Docker (`getArchive`/`putArchive`) con un códec
tar mínimo propio (sin dependencias). Si la imagen no tiene shell (scratch/
distroless), el explorador lo indica y no está disponible.

### 7.8 Operaciones, backups y sistema
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| POST | `/services/:id/exec` | +access | ejecuta un comando (`sh -c`) en el contenedor (60 s; 20 por minuto y usuario, después 429) |
| GET | `/services/:id/backups` | +access | lista backups |
| POST | `/services/:id/backups` | +access | crea backup (dump dentro del contenedor) |
| GET | `/services/:id/backups/:file/download` | +access | descarga un backup |
| POST | `/services/:id/backups/:file/restore` | +access | restaura (`{confirm:true}`) |
| DELETE | `/services/:id/backups/:file` | +access | borra un backup |
| GET | `/health` | público | estado + versión |
| GET | `/system` | auth | versión, docker, nixpacks, host, disco (`dataDir` solo para admin) |
| GET | `/system/docker-usage` | admin | uso de Docker (imágenes/volúmenes/caché), del mismo `df` cacheado 60 s que Monitor |
| POST | `/system/prune` | admin | libera imágenes colgantes y caché de build |
| GET | `/system/orphans` | admin + session | datos sin proyecto (§3.1) → `{docker, volumes: [{name, sizeBytes, createdAt}], volumesError, backups: [{serviceId, files, sizeBytes, updatedAt}], confirmWord}`. Un token de API, aunque sea de administrador, recibe 403 |
| POST | `/system/orphans/purge` | admin + session | `{confirm: "eliminar", volumes?: string[], backups?: string[]}`: recalcula y borra solo lo que sigue siendo huérfano → `{deleted: {volumes, backups}, skipped: [{kind, name, reason}], failed: [{kind, name, error}]}`. 400 sin la palabra o sin nada que borrar; 503 si hay volúmenes y Docker no responde. Audita cada borrado |
| GET | `/system/backups` | admin | snapshots del propio skyway.db (+ retención) |
| POST | `/system/backups` | admin | crea un snapshot ahora (VACUUM INTO) |
| GET | `/system/backups/:file/download` | admin + session | descarga un snapshot (.db restaurable). Exige sesión de navegador: lleva en claro los secretos que la API nunca devuelve (token de Cloudflare, de Mailway, de GitHub…) |
| DELETE | `/system/backups/:file` | admin | borra un snapshot |
| GET | `/settings` | admin | ajustes (secretos como booleanos) + `traefikAcme: {status: ok/missing/invalid/unknown, email}` (correo real de Traefik) + `defaults.keepImages` |
| PUT | `/settings` | admin | guarda ajustes (dominio, TLS, token GitHub, alertas, `keepImages` 1–50 o vacío → 400 `invalid_keep_images`); `rootDomain` debe ser un nombre de host válido o vacío; `serverIpv6`, una IPv6 sin identificador de zona (`fe80::1%eth0` da 400: ningún DNS la publica) o vacía |
| POST | `/settings/github/test` | admin | valida el token de GitHub |
| DELETE | `/settings/github` | admin | borra el token de GitHub |
| POST | `/settings/alerts/test` | admin | envía notificación de prueba |

### 7.9 Seguridad, alertas y monitor
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/security` | admin | hallazgos, nota y logins fallidos 24 h |
| GET | `/audit` | admin | registro de auditoría (`?limit=&action=`, `action` de hasta 80 caracteres) |
| POST | `/security/rotate-sessions` | admin | invalida todas las sesiones |
| GET | `/alerts` | auth | alertas del ámbito del usuario (`?open=&limit=`) |
| POST | `/alerts/read-all` | auth | marca todas como leídas |
| POST | `/alerts/:id/resolve` | auth | resuelve una alerta accesible |
| GET | `/monitor/overview` | auth | todos los servicios accesibles con estado/consumo |
| GET | `/monitor/logs/search` | auth | busca texto en logs (`?q=&tail=&projectId=`); 4 contenedores a la vez y 15 s en total (`timedOut`, `truncated`); 10 por minuto y usuario, después 429 |
| GET | `/monitor/disk` | auth | disco por servicio (+ host/Docker si admin) |
| GET | `/monitor/host-history` | auth | histórico de carga, RAM y disco del host (`?hours=`) |
| GET | `/websites` | auth | vista de sitios web (servicios con dominio) |

### 7.10 Dominios, estado público, importación y webhooks
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/domains/server-ip` | auth | `{ip, source, ipv6}`: IP del servidor (configurada o detectada) y la IPv6 de Ajustes (`null` si no se ha indicado) |
| GET | `/domains/config` | auth | `{rootDomain, tls, tlsBlocked}`: lo que necesita el editor de dominios de cualquier usuario (los ajustes completos siguen siendo solo admin). `tls` es el TLS efectivo; `tlsBlocked`, que está activado en el panel pero Traefik tiene un correo que Let's Encrypt rechaza (vacío no cuenta) |
| GET | `/projects/:id/github/needs` | +access | dependencias del repo antes de crearlo (`repo`, `branch`, `rootDir?`, `source?`, `name?`): `needs`, `suggestions`, `missing`, `mail`, `manifest`, `envFile` (§5.5) y `plan`, el plan de integraciones sin efectos (§5.7) |
| POST | `/domains/check` | auth | verifica DNS de un dominio (`{domain}`) → `{check: {domain, status, resolvedIps, resolvedIpv6, expectedIp, zone, name, caa, message, viaCloudflare?}}`; `status`: `ok`, `wrong_ip` (el A no es el del servidor, hay **otro A además del suyo** —el del hosting anterior, que un importador de zona no sustituye— o, sin el proxy de Cloudflare, un **AAAA que no es la IPv6 del servidor**: los visitantes con IPv6 y Let's Encrypt irían allí), `cloudflare_proxy` (resuelve solo a IP del proxy de Cloudflare y no se ha podido ver a dónde lleva), `cloudflare_flexible` (con el proxy apunta aquí, pero Cloudflare entra en el bucle de redirecciones del modo SSL/TLS «Flexible»), `caa` (apunta aquí, pero el CAA más cercano —el del nombre o el de su padre más próximo que tenga— no autoriza a `letsencrypt.org`; solo con HTTPS configurado; `caa = {name, issuers}` y el mensaje da el registro exacto, `0 issue "letsencrypt.org"`; un CAA que no se pudo consultar no lo impide), `no_record` o `unknown`; `message` es siempre una sola frase. `zone`/`name`: la zona del dominio y el nombre del registro según la lista de sufijos públicos (`www.panaderia.com.es` → zona `panaderia.com.es`, nombre `www`; `@` para el propio dominio; `null` si no se sabe); el editor los usa en las instrucciones. Solo para el administrador, un nombre con el proxy se comprueba con la API de Cloudflare (solo lectura, `verificarEnCloudflare`: sigue un CNAME hasta tres saltos y el comodín más cercano) y, si apunta aquí, sale `ok` con `viaCloudflare: true` (o `cloudflare_flexible`, si con HTTPS la portada pedida a través de Cloudflare redirige a sí misma); si apunta a otro sitio, `wrong_ip`. La API manda sobre el proxy mientras el DNS público se pone al día: un nombre que aún resuelve a la IP del servidor pero ya tiene el proxy sale con `viaCloudflare: true`, y uno que aún resuelve a Cloudflare pero ya no lo tiene, `ok` sin él. Para cualquier otro no sale ninguna petición a Cloudflare ni a la web; 30 por minuto y usuario, después 429 (el editor repite sola la comprobación de los dominios pendientes por debajo de ese tope) |
| GET | `/public/status/:token` | público | página de estado pública (cacheada) |
| GET | `/projects/:id/status-page` | +access | config de la página de estado |
| POST | `/projects/:id/status-page` | admin | activa/desactiva y aviso |
| POST | `/projects/:id/status-page/rotate` | admin | rota el token del enlace |
| GET | `/projects/:id/import-report` | +access | informe de importación de Railway |
| DELETE | `/projects/:id/import-report` | +access | borra el informe (auditado como `import_report_deleted`) |
| POST | `/import/railway/projects` | admin | lista proyectos de Railway (`{token}`) |
| POST | `/import/railway/analyze` | admin | plan de importación (sin valores de variables) |
| POST | `/import/railway/run` | admin | ejecuta la importación; los dominios propios que ya usa otro servicio (o el panel) se omiten con una nota en el informe. `dnsDomains` (opcional): los dominios que el admin marca en la vista previa para el DNS automático (§7.13); solo esos, y solo si el proyecto importado los sirve, reciben su registro (los demás los eligió quien los puso en Railway, que no exige demostrar la propiedad) y la respuesta añade `dns`. Los que aún apuntan a Railway son conflictos y no se tocan |
| POST | `/webhooks/github/app` | público (HMAC de la App) | webhook **único** de la GitHub App: reparte cada push entre los servicios que apuntan a ese repo y esa rama y cuyo proyecto tenga conectada esa instalación; también sincroniza altas, bajas y suspensiones de instalaciones |
| POST | `/webhooks/github/:serviceId` | público (HMAC) | auto-deploy por servicio en push (firma verificada); respeta `autoDeploy` y deduplica como el de la App: commit ya desplegado o en curso, o un despliegue vivo que aún no ha clonado → `ignored`; complementa al sondeo interno de `autodeploy.ts` |
| POST | `/webhooks/stripe` | público (firma Stripe) | marca la factura como pagada al confirmarse el cobro; firma `Stripe-Signature` verificada (HMAC-SHA256 con tolerancia temporal anti-replay); exige `payment_status == paid`; idempotente |

### 7.11 Ayuda y asistente
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/help/faq` | auth | `{categories, entries}`: preguntas frecuentes en español con categoría, palabras clave y enlaces internos |
| POST | `/help/ask` | auth | `{question, serviceId?}` → `{answer, matches, issues, links}`. Determinista: busca en la FAQ (acentos y plurales normalizados) y, si la pregunta indica un fallo, revisa el servicio indicado (o el que nombre la pregunta) a fondo; sin servicio, revisa en ligero todos los accesibles. 30 por minuto y usuario; 404 si el servicio no es accesible |
| GET | `/help/issues?serviceId=` | auth | `{issues, scanned}`: con `serviceId`, revisión profunda (incluye la cola de logs de la app); sin él, revisión ligera de hasta 60 servicios accesibles (despliegue fallido, contenedor caído o reiniciándose, referencias sin resolver, variables pendientes) |

### 7.12 Correo (Mailway)
Los errores de Mailway se devuelven con su mensaje: 400/404/409/429 tal cual y el
resto como **502** (nunca 401, que la interfaz interpretaría como sesión caducada).
Sin Mailway configurado o sin correo activado en el proyecto: **409**. Las rutas
de proyecto exigen además el módulo `mail` en la cuenta (los administradores lo
traspasan). «manage» = administrador o propietario de la cuenta del proyecto.

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/traefik/mailway` | público¹ | configuración dinámica **saneada** para el proveedor HTTP de Traefik, más la prepublicación y las redirecciones del cambio de dominio y los routers de `SKYWAY_DOMAIN_EXTRA` (§2; `{}` si no hay nada, también sin Mailway). ¹Responde 404 si la petición trae `X-Forwarded-*`/`X-Real-IP`/`Forwarded` (llegó desde internet a través de Traefik). Siempre 200: si Mailway falla, la última buena (memoria → `settings`), vuelta a sanear. En cada lectura obtiene también, en paralelo y con plazo de 5 s, todos los nombres de marca blanca de la instancia (`GET /api/whitelabel/domains`), que ningún servicio de un cliente puede asignarse; si falla, se conserva la lista anterior |
| GET | `/mailway/status` | auth | `{configured, panelUrl}` (la interfaz decide si muestra «Correo») |
| GET | `/mailway/config` | admin | `{configured, baseUrl, serviceId, serviceName, internalUrl, hasToken, panelUrl, defaultPlanId, traefik:{routers, dropped, syncedAt, error}, previousHosts:[{host, lastSeen}]}`. Nunca devuelve el token. `previousHosts`: nombres que fueron de la instancia y siguen reservados |
| DELETE | `/mailway/previous-hosts/:host` | admin + session | libera un nombre anterior de Mailway (un servidor de correo o un webmail que ya no se usan): desde entonces, cualquier servicio puede asignárselo → `{ok, config}`; 404 si no estaba. Audita `mailway_host_released` |
| PUT | `/mailway/config` | admin + session | `{baseUrl?, token?, serviceId?, defaultPlanId?}` (`''` borra). `token` debe empezar por `mwt_`. Si cambian la URL o el servicio, 400 cuando el dominio de la URL lo sirve un servicio de Skyway que no es del proyecto de Mailway (el token viajaría hasta él). Quitar el token **no** retira las rutas de Traefik. Audita `mailway_config_updated` (campos, sin valores). Desde la terminal del servidor hace lo mismo `tools/mailway.js conectar` (§9), con el actor `sistema` |
| POST | `/mailway/disconnect` | admin + session | borra dirección, token, servicio, plan predeterminado y hosts, **retira las rutas de Mailway de Traefik** (y su copia guardada) y libera los nombres de marca blanca reservados. Los hosts de la instancia (y el de la URL) pasan a `previousHosts`: su DNS sigue apuntando aquí. Los vínculos de los proyectos se conservan. Audita `mailway_disconnected` |
| GET | `/mailway/plans` | admin | `{plans, defaultPlanId}` para elegir el plan predeterminado |
| POST | `/mailway/test` | admin | `{baseUrl?, token?, serviceId?}` opcionales (probar sin guardar) → `{ok, info:{version, brandName, mailHostname, webmailUrl, panelUrl, role, email, features}, warnings}`; avisa si el token no es de administrador. Las URLs que no son http(s) llegan como `null`. 12/min |
| GET | `/projects/:id/mail` | auth + access | `{moduleEnabled, configured, canManage, isAdmin, accountSuspended, linked, notice?, panelUrl, features, link?, summary?, account?, suggestedDomains, renewals?}`. Recupera el vínculo si Mailway tiene un cliente con la referencia propia del proyecto (con la de su cuenta no: la comparten todos sus proyectos); si el cliente ya no existe o ya no lleva exactamente esa referencia, `notice` lo explica (sin `summary`) y se puede desactivar. `summary.apiKeys[]` incluye `senderMailboxId` y `createdBySkyway`; `summary.appPasswords[]`, `invalidatedAt` (la invalidó un cambio de motor de Mailway; `null` si no o con un Mailway anterior). `renewals` = `{[serviceId]: {status:'renewed'\|'waiting'\|'failed', reason, renewedAt, mailbox, deployment:{id, status}\|null}}`: renovaciones automáticas de las contraseñas de aplicación de sus servicios (ver «Correo (Mailway)»). Si quien la pide gestiona el proyecto, antes renueva las invalidadas de los servicios del proyecto (espera como mucho 8 s; si Mailway tarda, sigue en segundo plano) y devuelve el resumen de después; un intento fallido no se repite en esta ruta hasta pasado un minuto. `features.webmailAutomatico` = interruptor global del webmail automático de Mailway (`null` si no lo tiene) y `summary.webmail` = `{automatico, domains:[{hostname, status, detail, automatico, isPrimary, url, conflict}]}` (`null` con un Mailway sin la función; solo nombres que cuelgan de un dominio del cliente, sin identificadores de Mailway; `url` solo en servicio y sin conflicto). En un proyecto de una cuenta, `account` = `{workspaceName, shared, projects, ownClient}`: si el cliente es el de la cuenta, los otros proyectos de la cuenta que lo usan (solo los que el usuario puede ver) y, si el proyecto conserva su propio cliente porque la cuenta ya tenía otro, `ownClient.workspaceClientName`; al leerlo, el vínculo de antes pasa al cliente de la cuenta y el nombre del cliente se alinea con el de la cuenta (ver «Correo (Mailway)»). `suggestedDomains` (máx. 8): dominios registrables de los dominios de los servicios del proyecto según la lista de sufijos públicos (`api.empresa.com` → `empresa.com`; nada bajo sufijos privados como `github.io`), sin los que ya tiene el cliente, el origen de un cambio de dominio con correo que no esté cancelado (§6.1) ni los de la plataforma (registrables de `SKYWAY_DOMAIN`, del `rootDomain` y de los hosts de Mailway); `[]` sin módulo, sin Mailway o con `notice` |
| GET | `/projects/:id/mail/options` | manage | `{plans, clients, defaultPlanId, canChoosePlan, defaultName, previous, workspace}`: el administrador ve todos los planes y los clientes (con `available`/`linkedTo`: no se puede elegir uno vinculado a un proyecto de otra cuenta ni con la referencia de otro proyecto, otra cuenta u otra integración); el propietario, solo el plan que se le asignará. `previous` = `{clientName, available, reason}` del cliente anterior del proyecto. En un proyecto de una cuenta, `workspace` = `{name, client}`: `defaultName` es el nombre de la cuenta y, si la cuenta ya tiene cliente (`client` = `{name, planName}`), no hay clientes que elegir, ni plan, ni cliente anterior |
| POST | `/projects/:id/mail/link` | manage | `{mode:'create', name?(2-80), planId?, contactEmail?}` (ensure por referencia externa; `planId` distinto del predeterminado → 403 salvo admin; sin nombre, el del proyecto o «Proyecto X» si tiene 1 carácter), `{mode:'previous'}` (recupera el cliente anterior si su referencia está libre; 409 si otra integración lo tiene) o `{mode:'existing', clientId}` (solo admin; 409 si está vinculado a un proyecto de otra cuenta o lleva la referencia de otro proyecto, otra cuenta u otra integración). En un proyecto de una cuenta: si la cuenta ya tiene cliente (`skyway:workspace:<id>`), el proyecto se vincula a él (`created: false`, sin crear nada; otro `clientId` o cliente anterior → 409); si no, el cliente creado, recuperado o vinculado pasa a ser el de la cuenta (referencia de la cuenta con `PUT …/link` y nombre de la cuenta; el `name` del cuerpo no cuenta). Si otro cliente ya tiene la referencia de la cuenta, el `409 external_ref_in_use` de Mailway se traslada con su mensaje. 403 con la cuenta suspendida |
| DELETE | `/projects/:id/mail/link` | manage | retira solo el vínculo de este proyecto → `{ok, released, workspaceClient}`. El cliente de una cuenta conserva la referencia de la cuenta (`workspaceClient: true`), aunque fuera el último proyecto: al volver a activar el correo, el proyecto se vincula al mismo cliente. Un cliente propio, como siempre: suelta su referencia en Mailway **solo si todavía la lleva** (si es de otra integración no se toca) y se recuerda para recuperarlo. Skyway deja de renovar las contraseñas de aplicación de sus servicios: olvida lo anotado y resuelve sus avisos. 409 `migration_open` con un cambio de dominio abierto que incluye el correo (§6.1) |
| GET | `/projects/:id/mail/domain-check` | auth + access | `?domain=`: dónde recibe hoy el correo un dominio, **antes** de darlo de alta (no da de alta nada) → `{domain, recepcion: 'otro'\|'aqui'\|'sin_mx'\|'desconocido', mx[], dnsAutomatico}`. Lo mide Skyway (MX públicos frente al servidor de correo de Mailway). `dnsAutomatico`: al administrador se le ofrece el DNS automático. La interfaz pide confirmación con `otro` (añadirlo no mueve el correo, pero el DNS automático, el fichero de zona y lo que se envía al dominio desde aquí sí le afectan). 30/min |
| POST | `/projects/:id/mail/domains` | auth + access | `{domain, autoDns?}` → `{domain, cloudflare, cloudflareReason}` (201). `autoDns` solo cuenta para el administrador: `true` lo pide, `false` no; **sin él, si el MX del dominio apunta a otro proveedor —o no se puede saber, porque el DNS no responde o no se conoce el servidor de correo— no se pide** y `cloudflareReason` lo explica (un Mailway hasta la 1.2 crearía su SPF y un DMARC `p=reject` que rompen el correo saliente del proveedor actual, de la web en otro hosting y de herramientas como Mailchimp). Comprueba la referencia del cliente; 403 con la cuenta suspendida, 409 con el cliente suspendido en Mailway. Para un administrador se envía `autoDns: true` solo si Mailway tiene Cloudflare (`features.cloudflare`) y declara `features.cloudflareSoloCrear` (1.1 o posterior): Mailway crea en Cloudflare los registros que faltan (también con las cuentas de la instancia) sin modificar ninguno existente (ni el SPF, ni un proxy), y `cloudflare` = `{applied, errors, skipped}` o `cloudflareReason` explica por qué no. Con un Mailway anterior no se pide y `cloudflareReason` dice que hay que actualizarlo; sin Cloudflare en Mailway no se pide ni se avisa. Para quien no es admin va con `autoDns: false` y `?soloCliente=1` (`cloudflare: null`): el alta de un cliente nunca escribe en las zonas del operador. Cada dominio incluye `recepcionExterna` (`true`/`false` con Mailway posterior a la 1.2; `null` con uno anterior) y, en cada comprobación DNS, `suggested`: el valor con el que **sustituir** el registro existente (el SPF actual con lo que le falta, el que calcula Mailway o, con uno anterior, Skyway: los mecanismos del propuesto que faltan, delante de su `all`, con `a:<servidor de correo>` en lugar de `mx` mientras la comprobación del MX de ese nombre no sea correcta, porque con el MX en otro proveedor `mx` autorizaría a ese proveedor y no a este servidor). Con un Mailway que ya lo calcula (el que informa `recepcionExterna`), Skyway no inventa ninguno si no lo manda. La tarjeta copia en cada fila SPF el valor de su nombre en lugar del SPF del motor. Cada dominio incluye también `ownershipVerifiedAt`, `ownershipPending` y `ownershipRecord` (`{type, name, content}`, el TXT que prueba la propiedad): mientras la propiedad esté pendiente, Mailway responde 409 `domain_ownership_pending` al crear buzones y la interfaz muestra «Propiedad pendiente» con el TXT |
| POST | `/projects/:id/mail/domains/:domainId/verify` | auth + access | vuelve a comprobar el DNS |
| GET | `/projects/:id/mail/domains/:domainId/dns` | auth + access | `{records:[{type,name,content}]}` |
| GET | `/projects/:id/mail/domains/:domainId/conflicto` | auth + access | ¿recibe ya el correo en otro proveedor? (lo mide Mailway, `GET /api/domains/:id/conflicto`) → `{hayOtroProveedor, mxActuales[], spfActual, dmarcPolitica, avisoMtaSts}`, solo campos conocidos y acotados. La tarjeta del dominio lo consulta mientras no está verificado y avisa de qué pasa con lo que se envía a ese dominio desde este servidor: con `recepcionExterna: true` (Mailway posterior a la 1.2), se entrega en el proveedor actual; con `false` (MX de los dos proveedores, o aún sin medir) o con un Mailway anterior (`null`), se queda en los buzones de aquí o se rechaza. Actualizar Mailway solo se le propone al administrador. También pide confirmación antes de descargar el fichero de zona. 60/min |
| GET | `/projects/:id/mail/domains/:domainId/cloudflare` | auth + access | plan de cambios `{available, reason, account, zone, changes[], summary, porRegistro, copia}`. Con Mailway posterior a la 1.2 cada conflicto trae `reemplazable` y `alCambiar` (el MX ajeno y el SPF y el DMARC que se crean con él), `porRegistro: true` y `copia` (`{createdAt, borrados[]}` o `null`: lo que borró el último cambio); con uno anterior, `porRegistro: false`, `reemplazable: null` y `copia: null`. Si quien pide no es admin, se envía `?soloCliente=1`: Mailway solo usa las cuentas de Cloudflare del cliente, nunca las de la instancia. Además, si el dominio quedó asociado en Mailway a una cuenta que no es del cliente (la de la instancia, tras el DNS automático del admin), Skyway responde `available: false` con el motivo **sin pedir el plan** (solo consulta `GET /api/cloudflare/accounts?clientId=` del propio cliente), salvo que el cliente tenga alguna cuenta propia y Mailway declare `cloudflareSoloCrear`: entonces Mailway ignora la de la instancia y prueba las del cliente. Con un Mailway anterior, el motivo remite al administrador (conectar una cuenta propia no lo resolvería) |
| POST | `/projects/:id/mail/domains/:domainId/cloudflare/apply` | manage | `{replaceConflicts?, replace?}` → `{applied, errors, domain}`. `replace` (`["MX:empresa.com", …]`, Mailway posterior a la 1.2) elige uno a uno los conflictos que se reemplazan; la interfaz lo usa con `porRegistro` y ofrece «Hacer el cambio de proveedor» (solo el MX y lo que va con él; autodiscover o el `mail.` del hosting se conservan). Un Mailway anterior lo ignora y no reemplaza nada (con `?soloCliente=1` para quien no es admin; 409 sin llamar a Mailway si el dominio está asociado a una cuenta que no es del cliente, con la misma excepción que el plan) |
| POST | `/projects/:id/mail/domains/:domainId/cloudflare/undo` | manage | deshace el último cambio en Cloudflare (Mailway posterior a la 1.2, `POST /api/domains/:id/cloudflare/undo`): recrea lo reemplazado y retira lo creado en su lugar → `{restaurados, retirados, domain}`. Mismas reglas que aplicar (`?soloCliente=1` y bloqueo por cuenta ajena para quien no es admin). Audita `mailway_dns_undone`. 10/min |
| GET | `/projects/:id/mail/domains/:domainId/zonefile` | auth + access | fichero de zona BIND de Mailway (`?nivel=obligatorios\|recomendados\|completo`, recomendados por defecto; otro valor → 400) como `text/plain` adjunto `<dominio>-mailway-<nivel>.txt`, para importarlo en Cloudflare (DNS → Registros → Importar y exportar). Skyway **retira los registros A, AAAA, CNAME, HTTPS y SVCB del dominio raíz y de `www`** que pudiera traer Mailway (nombres absolutos, relativos, `@`, `$ORIGIN`, líneas sin propietario y paréntesis) y, si retira alguno, lo indica en un comentario al principio. Después **añade, en secciones propias**, los registros web de los servicios del **mismo proyecto** cuyos dominios cuelgan de la zona (A hacia la IP pública configurada en Ajustes; sin ella se omiten y un comentario lo dice), **comentados** (`; nombre. 3600 IN A ip`) con la instrucción de borrar antes el A/AAAA/CNAME actual de ese nombre y quitar el `; `: el importador de Cloudflare añade y no sustituye, y sobre el A del hosting anterior dejaría dos y el tráfico se repartiría, y el del **webmail del cliente** si está dado de alta (el registro recomendado que indica Mailway; si el nombre no se puede utilizar, un comentario explica por qué con el motivo genérico, también si lo descarga un administrador: el fichero se entrega al cliente). Nunca menciona dominios, servicios ni proyectos de otros, ni repite un nombre que el fichero ya trae; todo texto libre de un comentario va en una sola línea (sin saltos ni caracteres de control). 20/min |
| GET | `/projects/:id/mail/domains/:domainId/webmail` | auth + access | `{hostname, webmail, conflict}`: el webmail del dominio en `webmail.<dominio>` (marca blanca de Mailway). `webmail` = `null` o `{hostname, kind, status:'pending_dns'\|'issuing'\|'active'\|'error', detail, lastCheckedAt, activatedAt, createdAt, isPrimary, url, instructions[]}` (`url` solo en servicio, formada por Skyway; `instructions` = registro CNAME recomendado o A que indica Mailway). `conflict` = motivo por el que el nombre no se puede utilizar (`webmailHostError`) o `null`. El dominio propio se busca entre los del cliente vinculado (`GET /api/whitelabel/domains?clientId=`, filtrados también por cliente en Skyway) |
| POST | `/projects/:id/mail/domains/:domainId/webmail` | manage | da de alta `webmail.<dominio>` (nombre fijado por Skyway, no por quien llama) para el cliente vinculado (`POST /api/whitelabel/domains {hostname, clientId, kind:'webmail'}`) → 201 `{webmail}`. 403 con la cuenta suspendida, 409 con el cliente suspendido, 409 si el nombre lo sirve **cualquier servicio de Skyway** (solo el admin ve cuál), es el del panel (`SKYWAY_DOMAIN`) o de la instancia de Mailway, 409 si ya existe. La propiedad del dominio la exige Mailway: 400 `domain_not_verified` con su mensaje (también `whitelabel_limit`, 5 por cliente). El nombre queda reservado al momento (sin esperar a la lectura del puente): ningún servicio de un cliente puede asignárselo. Audita `mailway_webmail_created`. Si lo configura un **administrador** y Mailway tiene Cloudflare (`features.cloudflare`) y declara `features.cloudflareSoloCrear`, crea además su registro como `/webmail/cloudflare` (sin `soloCliente` y con `soloCrear`: no reemplaza ni modifica un registro existente, ni le quita el proxy) y la respuesta añade `cloudflare`/`cloudflareReason`; con un Mailway anterior no se pide y `cloudflareReason` lo explica; para los demás, nunca. 10/min |
| POST | `/projects/:id/mail/domains/:domainId/webmail/verify` | auth + access | comprueba DNS y HTTPS en Mailway y avanza el estado (Esperando DNS → Emitiendo certificado → En servicio) → `{webmail, conflict}`. 404 si no está configurado. 30/min |
| POST | `/projects/:id/mail/domains/:domainId/webmail/cloudflare` | manage | crea en Cloudflare el registro del webmail (`?soloCliente=1` para quien no es admin, como en los dominios) → `{applied, errors, skipped, webmail}`; nunca sustituye un registro existente con otro valor (`skipped`). 409 si el nombre lo sirve un servicio de Skyway. Audita `mailway_webmail_dns_applied`. 10/min |
| POST | `/projects/:id/mail/domains/:domainId/webmail/primary` | manage | lo marca como webmail principal del cliente (el que usan sus enlaces y datos de conexión) → `{webmail}`; 400 `webmail_not_active` de Mailway si no está en servicio. Audita `mailway_webmail_primary` |
| PUT | `/projects/:id/mail/webmail-automatico` | manage | `{activo: boolean}` → `{automatico, global, domains}` (`domains` con la forma de `summary.webmail.domains`). Interruptor del webmail automático del cliente vinculado (`PUT /api/clients/:id/webmail-automatico`): encendido, Mailway prepara al momento `webmail.<dominio>` de cada dominio con la propiedad comprobada (y Skyway reserva esos nombres sin esperar al puente); apagado, retira los que creó solo, con su registro DNS. Con el interruptor global apagado se guarda sin efecto (`global: false`). Encenderlo exige la cuenta y el cliente activos (403/409); apagarlo, no. 409 sin llamar a Mailway si no declara `features.webmailAutomatico`. Audita `mailway_webmail_automatico`. 10/min |
| GET | `/projects/:id/mail/invites` | manage | `{invites:[{id, email, name, createdAt, expiresAt, openedAt, acceptedAt, revokedAt, status:'pending'\|'accepted'\|'expired'\|'revoked', recoverable}], suggestedEmail, clientName}`: enlaces de bienvenida del cliente (los 50 más recientes, sin URL) y el correo que se propone para uno nuevo (el de contacto del cliente en Mailway o, si no tiene, el del propietario de la cuenta). Esta ruta y las tres siguientes responden 409 sin llamar a Mailway si el Mailway conectado no declara `features.invites` |
| POST | `/projects/:id/mail/invites` | manage | `{email, name?(≤80), ttlHours?(1-720, 168 por defecto)}` → 201 `{invite:{id, url, email, name, expiresAt, existingUser}}`: enlace de bienvenida de la persona de contacto (crea su acceso al panel de Mailway y entra en la puesta en marcha); sirve una vez y sustituye al pendiente de ese correo. La URL se devuelve aquí y nunca se audita. 403 con la cuenta suspendida; 409 con el cliente suspendido o si el correo ya es de otra cuenta de Mailway (`user_exists`, sin decir de cuál). Audita `mailway_invite_created`. 10/min |
| GET | `/projects/:id/mail/invites/:inviteId/url` | manage | `{invite:{id, url, email, name, expiresAt, existingUser:null}}` de un enlace pendiente; 404 si ya no es válido (`invite_invalid`), 409 si Mailway ya no conserva la URL (`invite_not_recoverable`). Audita `mailway_invite_viewed`. 20/min |
| DELETE | `/projects/:id/mail/invites/:inviteId` | manage | revoca un enlace pendiente → `{ok, revoked:true}`; uno caducado o ya revocado → `{ok, revoked:false}` sin llamar a Mailway; uno aceptado → 409. Audita `mailway_invite_revoked` |
| POST | `/projects/:id/mail/mailboxes` | manage | `{domainId, localPart, displayName?(≤80)}` → `{mailbox, password}` (la contraseña, **una sola vez**). `localPart` como en Mailway: `a-z0-9._-`, sin `+`. Los nombres reservados (abuse, admin, administrator, hostmaster, postmaster, root, security, ssladmin, webmaster) solo los crea un admin (403) |
| POST | `/projects/:id/mail/mailboxes/:mailboxId/password` | manage | nueva contraseña (una vez); los dispositivos deben reconfigurarse |
| POST | `/projects/:id/mail/mailboxes/:mailboxId/setup-link` | auth + access | `{includePassword?, password?}` → `{url, expiresAt, hasPassword}`; la contraseña solo se incluye si se aporta, y entonces exige **manage** y un tope de 5 cada 10 min por usuario (Mailway la comprueba). La URL no se audita |
| DELETE | `/projects/:id/mail/mailboxes/:mailboxId` | manage | revoca antes las claves de API `Skyway · …` con ese buzón como remitente y elimina el buzón → `{ok, revokedApiKeys}`; si queda otra clave activa, 409 de Mailway |
| DELETE | `/projects/:id/mail/app-passwords/:appId` | manage | revoca una contraseña de aplicación del cliente (404 si no es suya). Audita `mailway_app_password_revoked` |
| DELETE | `/projects/:id/mail/api-keys/:keyId` | manage | revoca una clave de API del cliente (404 si no es suya). Audita `mailway_api_key_revoked` |
| GET | `/projects/:id/mail/connect/preview` | auth + access | `?serviceId&mode` → `{mode, suggestedMode, keys, kept, secretPlaced, conflicts, credentialNames, sinDominio, roleNames}`: con qué nombres recibiría el servicio el correo (los de su `skyway.json` o su `.env.example` por alias; los de siempre para lo que no nombra), cuáles se conservarían por tener un valor puesto a mano y, en `conflicts`, las de conexión (servidor, puerto, URL de la API) puestas a mano con otro valor, que harían responder 409 a la conexión. `credentialNames`: los nombres con los que Skyway reconoce la credencial de ese servicio en ese modo (en SMTP, `skyway:<slug>`; en API, `Skyway · <slug>`; en un proyecto de una cuenta, con `<proyecto>/<slug>`; con un vínculo anterior a compartir el cliente, también el nombre de antes): una credencial vigente con uno de ellos se revocará al conectar, y la pestaña marca entonces «Volver a desplegar ahora». `sinDominio`: el servicio no tiene dominios ni ruta de healthcheck (casi siempre un bot o un worker), y la pestaña recomienda el modo API. `roleNames`: qué variable lleva cada papel (`api_url`, `api_key`, `from`…; la primera si hay varias): la ayuda y el ejemplo del modo API usan esos nombres. Sin crear nada; 404 si el servicio es de otro proyecto |
| POST | `/projects/:id/mail/connect` | manage | `{serviceId, mailboxId, mode:'smtp'\|'api', redeploy?}` → `{ok, keys, kept, needsRedeploy, deploymentId, revoked, rebuild}` (`rebuild`: había otros cambios sin desplegar al conectar; `…/mail/redeploy` lo recibe). El servicio debe ser del proyecto y no de base de datos. Escribe con los nombres de la vista previa y **nunca pisa una variable puesta a mano** (van en `kept`); si la credencial no cabe en ninguna variable, o si el servidor, el puerto, el usuario o la URL de la API están puestos a mano con otro valor (conexión a medias), 409 sin crearla. Revoca antes la credencial del mismo tipo que Skyway creó para el servicio (`skyway:<slug>` o `Skyway · <slug>`; en un proyecto de una cuenta, cuyo cliente comparten sus proyectos, `skyway:<proyecto>/<slug>` o `Skyway · <proyecto>/<slug>`, y también la del nombre de antes si el vínculo es anterior a compartirlo; ≤ 60 caracteres, con un sufijo de los identificadores si hay que recortar). Nunca devuelve ni audita los valores. Con `redeploy`, despliegue con disparador `mailway`: de la imagen en marcha, sin compilar, si el servicio es de repositorio, tiene un despliegue correcto cuya imagen sigue en el disco, no tenía cambios sin desplegar antes de conectar y no hay otro despliegue en cola o en curso; si no, un despliegue normal (auditado «con la versión en marcha» cuando la fija; un reinicio de Skyway a mitad lo reintenta con la misma imagen) (sin él, `false` por defecto en la API, el servicio sigue con la credencial anterior, ya revocada, hasta el siguiente despliegue: `needsRedeploy` y `revoked` lo indican). En modo API, `MAILWAY_API_URL` es la dirección base de Mailway: el servicio envía con `POST {MAILWAY_API_URL}/v1/send`, cabecera `Authorization: Bearer {MAILWAY_API_KEY}` y JSON `{to, subject, text\|html}` (`Idempotency-Key` opcional para reintentar sin duplicar; referencia en `docs/API.md` de Mailway). Va con el turno de las credenciales del servicio (`withMailCredentialLock`): si la renovación automática está cambiando la suya, espera a que termine y lee el resumen después. Por SMTP, borra lo anotado de una renovación anterior y resuelve su alerta |
| POST | `/projects/:id/mail/redeploy` | manage | `{serviceId, rebuild?}` → **202** `{deployment, imagenEnMarcha}`. «Desplegar ahora» del resultado de conectar sin volver a desplegar: lo mismo que la casilla, un despliegue con disparador `mailway` de la imagen en marcha (las mismas condiciones que `…/mail/connect` con `redeploy`); con `rebuild` (lo que devolvió conectar: había otros cambios sin desplegar) o sin imagen en marcha, un despliegue normal. 404 si el servicio es de otro proyecto; 403 con la cuenta suspendida. Audita `mailway_service_redeploy`. 20/min |

Todas las rutas con `:domainId`/`:mailboxId`/`:appId`/`:keyId` comprueban antes,
con el resumen del cliente vinculado, que el recurso es de ese cliente: si no,
**404** sin llamar a Mailway (tampoco a la marca blanca ni al fichero de zona).
Las de `:inviteId`, con la lista de enlaces del cliente vinculado: un enlace de
otro cliente responde 404 sin llegar a su ruta. El cliente sale siempre del
vínculo del proyecto (el interruptor del webmail y los enlaces de bienvenida
son del cliente: en una cuenta, de todos sus proyectos).
Las rutas del webmail no reciben identificadores de marca blanca: el nombre se
deriva del dominio y el dominio propio se busca entre los del cliente
vinculado, y lo que devuelve Mailway tiene que ser de ese cliente y ese nombre
(502 si no). Si la referencia externa del cliente no es
exactamente una de las del proyecto —la de su cuenta, `skyway:workspace:<id>`,
o la suya, `skyway:project:<id>`— (vacía incluida), **409** en todas las rutas
de proyecto (también si el proyecto ha pasado a otra cuenta). El 401 de Mailway se traslada como 502 con su motivo (token
revocado, caducado o de un usuario desactivado). Las URLs que llegan de Mailway
(panel, webmail, enlaces) solo se devuelven si son http(s). Borrar un proyecto
suelta en segundo plano la referencia de su cliente en Mailway (solo si todavía
es la suya).

### 7.13 Cloudflare (DNS automático del administrador)
El operador conecta **una vez** su token de API de Cloudflare (permisos «Zone ·
Zone · Read» y «Zone · DNS · Edit»; la clave global se rechaza). Se guarda en
`settings` (`cloudflare.token`) y **nunca se devuelve**: solo su pista (últimos
4 caracteres) y las zonas que ve. El instalador de Mailway lo deja puesto con
`tools/cloudflare.js conectar` (§9).

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/cloudflare/config` | admin | `{configured, hint, zones: {names (máx. 100), total, checkedAt} \| null, lastError: {message, at} \| null, createTokenUrl}` |
| PUT | `/cloudflare/config` | admin + session | `{token}`: lo verifica en Cloudflare (usuario o cuenta `cfat_`; activo y con al menos una zona) **antes** de guardarlo; si falla, 400 con el motivo y no se guarda nada → `{ok, config}`. Audita `cloudflare_token_saved` o `cloudflare_token_replaced` (número de zonas, sin el token); guardar el mismo token no deja otra entrada |
| DELETE | `/cloudflare/config` | admin + session | borra el token, las zonas y el último fallo → `{ok, config}`. Audita `cloudflare_token_removed`. Los registros ya creados se conservan |
| POST | `/cloudflare/test` | admin | `{token?}`: prueba el indicado sin guardarlo o, sin él, el guardado (y refresca sus zonas y `lastError`) → `{ok, zones}`. 12/min |
| GET | `/cloudflare/records` | admin | registros que ha creado el DNS automático → `{records: [{domain, zone, content, project: {id, name} \| null, usedBy: {id, name, project} \| null, createdAt, replaced: [{type, content, proxied}] \| null, replacedCreated: boolean \| null}]}` (`replaced`: lo que sustituyó un reemplazo y se puede restaurar; `replacedCreated`: si el A lo creó el reemplazo y restaurar lo retira, o ya estaba y se conserva) |
| GET | `/services/:id/cloudflare-dns/replace` | admin | `?domain=`: revisión del reemplazo del registro de la web del hosting anterior (no toca nada) → `{plan: {domain, zone, ip, actuales: [{id, type, content, proxied, ttl}], conservaA, proxied, avisos[], motivo}}` (`proxied`: el A nuevo lleva el proxy de Cloudflare); `motivo` dice por qué no se puede (nombre de la plataforma, reservado a otro proyecto, nada que reemplazar). 404 si el dominio no está guardado en el servicio. 30/min |
| POST | `/services/:id/cloudflare-dns/replace` | admin + session | `{domain, records: [{id, type: A\|AAAA\|CNAME, content}]}` (los de la revisión) → `{dns: [{domain, action: 'created', message}]}`. 409 si los registros del nombre ya no son exactamente esos o si el nombre no se puede reemplazar. Un lote atómico; guarda copia. Audita `cloudflare_dns_replaced`. 10/min |
| POST | `/cloudflare/records/:domain/restore` | admin + session | deshace un reemplazo: recrea los registros anteriores (proxy, TTL y comentario) y retira el A de Skyway si lo creó el reemplazo, en un lote → `{ok, result: {restaurados, retirado}, records}`. 404 sin copia, 409 si el nombre tiene otros registros de dirección (no cuenta un AAAA hacia `serverIpv6`, que ya estaba y se conserva) o el A se ha modificado. Libera la reserva si el A era de Skyway. Audita `cloudflare_dns_restored`. 10/min |
| POST | `/services/:id/cloudflare-dns` | admin | `{domain}`: repite el DNS automático de **ese** dominio del servicio (tras un `error`, un `conflict` resuelto a mano o un `skipped` por zona o IP) → `{dns}`. 404 si el dominio no está en el servicio, 400 sin token. Nunca recorre los demás dominios del servicio. 30/min |
| POST | `/services/:id/cloudflare-proxy` | admin + session | `{domain, proxied?}`: «Activar proxy en Cloudflare» (`proxied: true`) o «Desactivar proxy en Cloudflare» (sin `proxied` o `false`). Pone o quita el proxy de los registros **A** de **ese** nombre exacto que apuntan a la IP del servidor, enviando solo `proxied` (ni el destino ni el tipo cambian), y vuelve a comprobar el DNS con la API de Cloudflare → `{result: {domain, changed, message}, check}`. Al activarlo, si algún A/AAAA de ese nombre apunta a otro sitio (otra IP, o un AAAA), 409 sin modificar ninguno (con el proxy, Cloudflare repartiría el tráfico entre ellos); al desactivarlo, lo mismo con los que tienen proxy. Activarlo sin HTTPS configurado (correo de Let's Encrypt), 409: Cloudflare solo podría entregar la web en el modo «Flexible». Activarlo en un nombre que no cubre el certificado gratuito de Cloudflare (más de un nivel por debajo de la zona), 409: los visitantes verían un error de certificado. Un CNAME, 409; sin zona en el Cloudflare del token o sin registro A, 404; sin token o sin IP del servidor, 400; 404 si el dominio no está guardado en el servicio. `changed: 0` si ya estaban así. Audita `cloudflare_proxy_enabled` o `cloudflare_proxy_disabled` («dominio: N registro(s)»). Son las únicas modificaciones de un registro existente y siempre son un clic expreso: el DNS automático al guardar sigue sin tocar lo que existe. 10/min |
| DELETE | `/cloudflare/records/:domain` | admin | borra en Cloudflare el registro creado y libera el nombre → `{ok, result: 'deleted'\|'gone'\|'released', records}`. 409 si el dominio sigue asignado a un servicio o si el registro se ha modificado en Cloudflare y sigue apuntando a la IP (no se toca y sigue reservado); si ya no existe (`gone`) o apunta a otro sitio (`released`), solo se libera el nombre. Audita `cloudflare_dns_record_deleted`. 30/min |

**DNS automático** (`cloudflaredns.ts`). Tras dar de alta dominios **nuevos**
(crear un servicio con `domains`, añadirlos con el PATCH, una pila o una
plantilla de Railway con `domain`, los que marca el administrador en la
importación de Railway; la pareja con o sin www que añade el servidor, §5.5,
cuenta como un dominio nuevo más de esa petición), y **solo si
quien hace la petición es administrador** (cookie o token `sky_` de un admin) y
hay token, para cada dominio que **escribe esa petición**:

- Al crear un servicio, los de su cuerpo (no los que tenga el servicio al
  releerlo tras aplicar el plan: mientras se consulta GitHub, el cliente del
  proyecto podría añadirle un nombre de las zonas del operador).
- En el PATCH, solo con `domainsBase` (los dominios de los que parte quien
  edita; Ajustes los envía siempre): son nuevos los que no estaban ni en la
  base de datos ni en esa base. Sin `domainsBase` no se usa el token y cada
  dominio nuevo vuelve como `skipped` explicándolo: no se puede distinguir un
  dominio que escribe el administrador de uno que el cliente quitó entre su
  lectura y el guardado.

1. `findZoneFor`: sin zona en ese Cloudflare → `skipped` («Sin zona en tu Cloudflare»).
2. Registros A/AAAA/CNAME con ese nombre: alguno que no sea un A hacia la IP del
   servidor (o un AAAA hacia `serverIpv6`, si está indicada) → `conflict`, no
   se toca nada (el mensaje remite a «Reemplazar en Cloudflare»); solo A hacia
   la IP → `kept`.
3. Si el nombre no tiene **ningún** registro (de cualquier tipo: con un TXT o
   un MX, un comodín ya no se le aplica), manda el comodín más cercano de la
   zona (`*.padre`, luego `*.abuelo`…): si alguno de sus A/AAAA/CNAME apunta a
   otro sitio → `conflict` (crear el A cambiaría a dónde va hoy el tráfico);
   si es el del padre y ya apunta a la IP → `kept`.
4. Si no, se crea un A hacia la IP (TTL automático, comentario «Skyway») →
   `created`. Con HTTPS configurado (correo de Let's Encrypt), con el proxy de
   Cloudflare (`proxied: true`): Let's Encrypt valida igualmente porque
   Cloudflare deja pasar `/.well-known/acme-challenge/` hasta el servidor. Sin
   HTTPS, sin proxy (`proxied: false`): Cloudflare solo podría entregar la web
   en el modo «Flexible». Tampoco en un nombre que no cubre el certificado
   gratuito de Cloudflare (la zona y un nivel de subdominio):
   `api.tienda.ejemplo.com` daría un error de certificado con el proxy
   (`cubiertoPorCertificadoCloudflare`). Un A que ya existía no se toca, tenga o no el proxy
   (`kept` lo dice).

Sin IP del servidor (Ajustes o autodetectada) → `skipped` sin llamar a
Cloudflare. Un error del token (no válido o revocado —Cloudflare responde
403/9109 «Invalid access token» en `/zones`—, desactivado o restringido a
otras IP) corta el resto con `error` y se anota en `lastError`; el plazo
agotado también corta el resto, pero no se anota (no es un fallo del token). Plazo total de 20 s
(8 s por petición): **nunca** hace fallar ni bloquea la petición, que añade
`dns: [{domain, action: 'created'|'kept'|'conflict'|'skipped'|'error',
message}]`. Audita `cloudflare_dns_applied` (`servicio`/`proyecto`, «dominio:
resultado», sin el token). Para propietarios y miembros **no se llama a
Cloudflare** ni a la detección de IP, y la respuesta no lleva `dns`. Los
dominios de correo los configura Mailway con sus propias cuentas (`autoDns`,
§7.12).

**Reserva de los nombres creados.** Cada registro creado se anota
(`cloudflare_dns_records`: dominio, zona, id del registro, IP, proyecto y, tras un reemplazo, la copia de lo sustituido en `replaced`). El
registro sigue apuntando al servidor aunque el dominio se quite del servicio o
se borre el proyecto, y Let's Encrypt valida por HTTP: sin reserva, otro
cliente podría asignarse ese nombre del operador y obtener su certificado. Por
eso `domainClaimError` rechaza (409) ese nombre para propietarios y miembros de
cualquier otro proyecto; el administrador puede asignarlo a otro proyecto y la
reserva pasa a ese proyecto. La reserva dura hasta que el administrador borra
el registro en Ajustes → Cloudflare (`DELETE /cloudflare/records/:domain`).

**Reemplazo del registro del hosting anterior** (traer una web a Skyway). El
alta automática nunca toca un registro existente, pero el administrador puede
sustituir, tras revisarlos, los A/AAAA/CNAME **de ese nombre exacto** que no
apuntan aquí por el A hacia la IP del servidor (botón «Reemplazar en
Cloudflare» junto al dominio: tras un conflicto del DNS automático o, para un
dominio ya guardado sin ese resultado —añadido otro día o con el asistente—,
cuando la comprobación del DNS dice que apunta a otra IP; un dominio guardado
sin registro ofrece «Crear en Cloudflare»). En dos pasos: la revisión
(`GET /services/:id/cloudflare-dns/replace?domain=`) no toca nada y enseña los
registros, el proxy y los avisos; la confirmación
(`POST …/replace`, con sesión de navegador) repite los registros revisados
(`{domain, records: [{id, type, content}]}`) y, si la zona ya no coincide,
responde 409 sin tocar nada. El cambio va en **un solo lote atómico** de
Cloudflare (`/dns_records/batch`: borrados y alta, o nada). También se retiran
los AAAA del hosting anterior (con ellos, los visitantes con IPv6 y Let's
Encrypt seguirían llegando allí); el A nuevo sigue la regla del DNS automático
(con el proxy de Cloudflare si la plataforma tiene HTTPS y el certificado
gratuito de Cloudflare cubre el nombre; la revisión lo dice en `proxied`) y la
revisión avisa si el anterior tenía el proxy y el nuevo no lo llevará. Nunca se reemplazan el
dominio del panel (`SKYWAY_DOMAIN`), el `rootDomain`, los nombres de Mailway
(actuales, anteriores, publicados o de marca blanca) ni un nombre reservado a
otro proyecto; nunca MX, TXT ni otros nombres. Lo borrado se guarda en
`cloudflare_dns_records.replaced` (tipo, contenido, proxy, TTL y comentario);
un segundo reemplazo del mismo nombre (otro AAAA o CNAME añadido después) se
suma a esa copia en lugar de sustituirla, para no perder el registro del
hosting original. **Restaurar** en Ajustes → Cloudflare
(`POST /cloudflare/records/:domain/restore`) lo vuelve a crear y retira el A de
Skyway (si lo creó el reemplazo) en otro lote, solo si el nombre sigue como lo
dejó el reemplazo; un AAAA hacia `serverIpv6`, que el reemplazo conservó, se
queda. Audita `cloudflare_dns_replaced` y
`cloudflare_dns_restored` (con los valores, que son direcciones públicas).

### 7.14 Cambio de dominio (§6.1)
Todas bajo `/projects/:id/domain-migrations`, con acceso y **gestión** del
proyecto (administración o propietario del workspace; un miembro → 403).
Errores `{error, code}`, también los de las guardas, zod y el límite de
peticiones (`forbidden`, `invalid_request`, `rate_limited`…); los de Mailway
(400, 404, 409, 429 y 503) se trasladan con su código (`migration_new_mx_here`,
`migration_old_mx_here`, `dns_unknown`…). Cerrar el cambio con un servicio sin
desplegar: 409 `migration_services_pending`.

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/plan` | `{fromDomain, toDomain, soloWeb?, hosts?, excluidas?}` → `PlanSkyway {hosts[{serviceId, from, to, modo, serviceName, error}], dnsWeb, correoDisponible: si/no_vinculado/sin_dominio/mailway_antiguo, correo, variables{cambios, notas, wordpress, huella}, servicios[{serviceId, nombre, reinicio, motivos}], webhooks, avisos, bloqueos, expect}`. `motivos` ⊂ `dominios`, `variables`, `compartidas`, `remitente`, `referencias`; `reinicio` = se despliega con una sola copia. `webhooks` = `WebhookEnRiesgo[]` (`{serviceId, serviceName, proveedores, evidencias, hosts[{serviceId, from, to}]}`; proveedores `telegram`, `discord`, `slack`, `whatsapp`, `twilio`, `stripe` o `webhook`): servicios con webhooks en nombres que redirigen; «Servir también» vuelve a pedir el plan con esos nombres en `hosts` con `modo: 'servir'`. Con un Mailway que lo informa, cada buzón de `correo` trae `appsManuales`. Sin efectos. 30/min |
| POST | `/projects/:id/domain-migrations` | `{fromDomain, toDomain, soloWeb?, hosts, excluidas, expect}` → 201 `MigracionSkyway` (+ `dns` del DNS automático), o 200 si ya estaba abierto con el mismo origen y destino. 409 `plan_changed` si `expect` no es la huella del plan, `migration_blocked` con el primer bloqueo, `migration_exists` con otro cambio abierto (también si Mailway devuelve uno que no abrió este proyecto) |
| GET | `/projects/:id/domain-migrations` | `{abierta, anteriores (últimas 5), dominios}`; `?ligera=1` sin consultar a Mailway (el aviso de la página del proyecto) |
| GET | `/:mid` | `MigracionSkyway {estado, paso, error, hosts[{…, dns, certificado}], compuertas[dns_web, certificados, correo], servicios[{despliegue, estado, error}], redirecciones, correo (vista de Mailway en vivo, caché de 10 s), variables (antes de pasar), alPasar (con `motivos`), webhooks, usuariosSinGestionar, appsManuales, ipServidor, avisos, puede*, fechas}`. `webhooks` como en el plan (en `preparando` y `lista`; en `pasada`, solo los nombres que siguen redirigiendo). `usuariosSinGestionar` (en `pasada` y `dando_de_baja`; vacío en el resto) = `[{mailboxId, email, login, pendiente, usos[{ambito: 'service'\|'project', serviceId, serviceName, key, usuario, estado: 'cambiara'\|'no_entra'}]}]`. `appsManuales` = `[{mailboxId, email, apps, usadoEnProyecto}]`: buzones pendientes con contraseñas de aplicación creadas a mano; `usadoEnProyecto` si además lo usa algún servicio del proyecto (§6.1). El error de un servicio cuyo despliegue de correo ha fallado dos veces lo explica (alerta `mail_login_deploy_failed`) |
| POST | `/:mid/check` | vuelve a medir (DNS, certificados y correo) y deja `lista` o `preparando`; con un alta en Mailway sin confirmar, la busca y la vincula. 60/min |
| POST | `/:mid/mx` | cambia el MX del dominio nuevo a este servidor en su zona de Cloudflare (Mailway `POST /:id/mx`, con `soloCliente` fuera de la administración). Solo en `preparando`/`lista`, con la pre-recepción hecha (409 `migration_state`) y la zona en Cloudflare (400 `cloudflare_unavailable`). 10/min |
| POST | `/:mid/switch` | `{expect}` (huella de `variables`) → 202. 409 `migration_not_ready`, `plan_changed` |
| POST | `/:mid/rollback` | → 202 |
| POST | `/:mid/cancel` | → 200 (tras un «Volver», pone al día las aplicaciones que envían con los buzones que recuperan su usuario de `dominio.es`) |
| POST | `/:mid/retire` | `{confirm}` → 202 (la baja sigue en segundo plano). 400 `confirm_mismatch`; 409 `migration_old_mx_here` antes de tocar las aplicaciones si el MX anterior apunta al servidor de correo; 409 `migration_shared_mail` si otro proyecto de la cuenta envía con el dominio anterior (§6.1) |
| POST | `/:mid/finish` | `{confirm}` → 200 (solo la web) |
| POST | `/:mid/redirects/remove` | `{confirm}` → 200 (en `terminada`) |
| POST | `/:mid/hosts/mode` | `{serviceId (1–100), from, modo: 'servir'\|'redirigir'}` → la vista, **202** si lanzó un despliegue y 200 si no. `from` es un nombre o una lista de 1 a 50 nombres del mismo servicio (una transacción y un solo despliegue). «Servir también» de nombres del cambio: en `preparando`/`lista` cambia su modo en los dos sentidos (se admite servir el nombre que seguirá siendo el principal, con aviso); en `pasada`, solo de `redirigir` a `servir` (añade los nombres anteriores al final de los dominios del servicio, borra sus redirecciones, los prepublica, sube `config_rev` y despliega el servicio con la imagen en marcha). 409 `migration_state` (estado que no lo admite, un nombre que no cambia o `redirigir` tras pasar), 409 `host_principal` (solo tras pasar: el nombre anterior pasaría a ser el principal del servicio), 409 `migration_services_pending` (el servicio se está desplegando), 409 `domain_in_use` (el nombre lo usa otro proyecto), 403 `account_suspended` (solo tras pasar: la cuenta está suspendida y el despliegue fallaría con la redirección ya quitada), 404 `not_found` (el nombre no está en el cambio o el servicio no existe). Con el cerrojo del proyecto. Audita `domain_migration_host_mode`. 20/min |
| POST | `/:mid/services/:sid/retry` | → 202 (servicio con el despliegue fallido; con la imagen en marcha si el fallido la reutilizaba; también en un cambio cancelado si no hay otro abierto) |
| POST | `/:mid/mailboxes/:mbid/login-update` | → 200 («Actualizar ahora» y «Actualizar y desplegar»; con aplicaciones del proyecto —credenciales `skyway:*` o usos sin gestionar del buzón, también en variables compartidas—, también sus variables y un despliegue con la imagen en marcha, con un reintento automático si falla y la alerta `mail_login_deploy_failed` si vuelve a fallar). 409 `migration_shared_mail` como la baja |
| GET | `/:mid/zonefile` | `text/plain`: fichero de zona de Mailway del dominio nuevo (nivel `recomendados`: incluye el TXT de propiedad) más los registros A de la web, comentados; si el dominio nuevo recibe en otro proveedor, su MX también va comentado; solo la web, solo los A |

---

## 8. Configuración por entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` | `4000` | puerto de la UI/API (un valor no numérico cae a 4000) |
| `HOST` | `0.0.0.0` | interfaz de escucha |
| `DATA_DIR` | `./data` | SQLite, builds y backups |
| `WEB_DIST` | `web/dist` | web compilada a servir |
| `JWT_SECRET` | generado | secreto de firma de sesiones (si no, se genera y persiste) |
| `BUILD_CONCURRENCY` | núcleos − 1, en [2, 4] | builds simultáneos |
| `TRUST_PROXY` | privadas/loopback | confianza en `X-Forwarded-*` (`true`/`false`/número/CIDRs) |
| `CSRF_ORIGIN_CHECK` | `true` | guarda CSRF de las peticiones mutantes con cookie (`Sec-Fetch-Site`/`Origin` frente al host); `false` la desactiva si un proxy raro estorba |
| `DOCKER_SOCK` | socket estándar | ruta alternativa al socket de Docker |
| `LOG_LEVEL` | `info` | nivel de log de Fastify |
| `SKYWAY_DOMAIN` | — | dominio del panel, **un solo nombre** (docker-compose lo pone tal cual en la regla `Host()` del panel: una lista con comas no coincidiría nunca y Skyway lo avisa al arrancar). Ningún servicio puede asignárselo y el puente de Traefik de Mailway nunca acepta una ruta para él; es también el dominio de las URL de webhook que se dan a GitHub |
| `SKYWAY_DOMAIN_EXTRA` | — | nombres adicionales del panel, separados por comas (p. ej. el anterior mientras se cambia de dominio). Mismas reservas que `SKYWAY_DOMAIN`; sus routers (HTTP con redirección y HTTPS con certificado propio, hacia `skyway@docker`) los publica Skyway en el proveedor dinámico que Traefik ya lee (`/api/traefik/mailway`) |
| `SKYWAY_TRAEFIK_CONTAINER` | `skyway-traefik` | contenedor de Traefik del que se lee el correo de Let's Encrypt (`tls.ts`) |

Ajustes en la UI (tabla `settings`, solo admin): `rootDomain`, `letsencryptEmail`,
`serverIp`, `githubToken`, umbrales de alerta y canales (Discord/Telegram/webhook)
y `keepImages` (versiones por servicio cuya imagen se conserva, 1–50; por
defecto 5). `letsencryptEmail` solo activa las etiquetas HTTPS: los certificados
los pide Traefik con `LETSENCRYPT_EMAIL` del `.env` (docker-compose ya no pone un
correo de `example.com` por defecto). Skyway lee el correo real de Traefik
(`docker inspect`, `tls.ts`) y, si es de un dominio que Let's Encrypt rechaza
(`example.com`, `.test`, `.local`…), no pone el router HTTPS ni la redirección
(los dominios siguen por HTTP), `GET /domains/config` devuelve
`tlsBlocked: true` y el informe de seguridad añade el hallazgo `tls-blocked`.
Vacío no bloquea: Traefik registra la cuenta sin contacto, que Let's Encrypt
acepta, y Ajustes solo lo informa. `GET /settings` devuelve
`traefikAcme: {status, email}` en todos los casos. Si no se puede leer, se
confía en el ajuste.
Ajustes → Cloudflare guarda `cloudflare.token` (secreto, nunca se devuelve),
`cloudflare.zones` y `cloudflare.lastError` con su propio botón (§7.13).
La GitHub App guarda ahí sus credenciales (`githubAppId`, `githubAppSlug`,
`githubAppName`, `githubAppPrivateKey`, `githubAppClientId`,
`githubAppClientSecret`, `githubAppWebhookSecret`, `githubAppHtmlUrl`); las crea y
las borra el propio flujo de la App, no se editan a mano.
Opcional: `autoDeployPollSeconds` afina el intervalo del sondeo de auto-deploy
(por defecto 60 s, mínimo 15).

---

## 9. Comandos

```bash
npm install
npm run dev          # server :4000 (tsx watch) + web :5173 (vite, proxy /api)
npm run build        # compila web y server
npm start            # sirve todo en :4000 (producción)
npm run typecheck    # server + web (incluye server/test)
npm run lint         # reglas de hooks de React en la web
npm test             # vitest: server/test (base SQLite temporal, sin Docker) y web/test

# Prueba real con Docker de «una sola copia», la parada limpia, la identidad por copia y
# los restos de intercambios (no la ejecuta la CI; necesita Docker y busybox:stable en local):
node scripts/prueba-real-bots.mjs                                   # todo (unos 8 min)
SECCIONES=despliegue,web node scripts/prueba-real-bots.mjs           # solo algunas secciones
SKYWAY_DIR=/ruta/a/otra/copia MODO=actual node scripts/prueba-real-bots.mjs   # versión anterior: mide el solape

# Restablecer contraseña desde el servidor (último recurso):
docker exec -it skyway node server/dist/tools/reset-password.js <email> [nueva]
npm run reset-password -w server -- <email> [nueva]

# Token de API de corta duración (stdout: {"id":"tok_…","token":"sky_…"}) y su revocación:
docker exec skyway node server/dist/tools/token.js crear --nombre "Instalador" --caduca-min 60 [--email admin@…]
docker exec skyway node server/dist/tools/token.js revocar --id tok_…

# Conectar Mailway como Ajustes → Correo (Mailway); el token mwt_ SOLO por la entrada estándar
# (stdout: {"ok":true,"version":"…","brandName":"…"}):
printf '%s' "$TOKEN_MWT" | docker exec -i skyway node server/dist/tools/mailway.js \
  conectar --servicio panel --proyecto mailway --url https://mail-panel.tudominio.com

# Token de Cloudflare del administrador como Ajustes → Cloudflare; SOLO por la entrada estándar
# (stdout: {"ok":true,"zones":N}; un token en los argumentos se rechaza sin leer nada):
printf '%s' "$CF_TOKEN" | docker exec -i skyway node server/dist/tools/cloudflare.js conectar

# Aviso por los canales de Ajustes → Alertas, como «Enviar notificación de prueba»; el texto
# va como argumento (stdout: {"ok":true,"channels":["discord"],"failures":[]}; sin canales, código 0):
docker exec skyway node server/dist/tools/aviso.js --nivel error --titulo "Actualización automática" --mensaje "…"

# Actualizar Skyway (en el servidor; detalle en §9.1):
skyway update                    # con vuelta atrás automática si algo falla
sudo skyway auto-update on --sistema

# Restaurar la BD del panel desde un snapshot (proceso manual a propósito):
docker compose stop skyway
docker run --rm -v skyway_skyway-data:/data alpine \
  sh -c 'cp /data/backups/skyway/<snapshot>.db /data/skyway.db'
docker compose start skyway
```

**Herramientas de terminal.** Viven en `server/src/tools/` y se compilan con el
resto a `server/dist/tools/`; en la imagen, el directorio de trabajo es `/app`
y el contenedor se llama `skyway`. No tienen endpoint HTTP a propósito: quien
puede ejecutarlas ya administra la máquina. Abren la misma base de datos que el
panel en marcha (SQLite en WAL) y terminan con código 0 si todo ha ido bien o
con código 1 y el motivo en stderr; el resultado, cuando lo hay, es una sola
línea JSON en stdout. Las opciones son `--clave valor`; un argumento suelto, una
opción desconocida o repetida es un error.

- `token.js crear --nombre <texto> --caduca-min <N> [--email <admin>]`: token
  de API igual que los de Mi perfil → Tokens de API (`apitokens.ts`), para el
  primer administrador o el indicado (tiene que ser administrador), con
  caducidad obligatoria de 1 minuto a 3650 días. Audita `token_created` con el
  actor `sistema` y el correo del dueño, nunca el valor.
  `token.js revocar --id <tok_…>` lo borra y audita `token_deleted`; si ya no
  existe, también termina con código 0 (`{"ok":true,"revoked":false}`).
- `mailway.js conectar --servicio <id|slug> [--proyecto <id|slug>] [--url <URL>]`:
  lee el token de gestión `mwt_…` de la **entrada estándar** (un argumento
  quedaría en el historial y en `ps`: cualquier argumento con `mwt_` o la opción
  `--token` se rechaza antes de leer nada, y desde un terminal no se espera).
  Sin `--proyecto`, el slug del servicio tiene que ser único en todo Skyway.
  Prueba la conexión con esos valores (`probarConexionMailway`, lo mismo que
  «Probar conexión») y, solo si responde, los guarda con `guardarConfigMailway`
  (lo mismo que «Guardar» en Ajustes → Correo (Mailway): misma validación,
  incluido el 400 si la URL pública la sirve otro servicio, y misma auditoría
  `mailway_config_updated`, con el actor `sistema`). Sin `--url` conserva la URL
  guardada. Los avisos de la prueba (por ejemplo, un token que no es de
  administrador) van a stderr con el prefijo `Aviso:` y no impiden guardar. El
  panel en marcha es otro proceso: lee la configuración de la base en cada
  petición y vuelve a pedir el token de Traefik en la siguiente lectura del
  puente; lo que tuviera en caché de la instancia anterior caduca en 5 minutos.
- `aviso.js --nivel <info|error> --mensaje <texto> [--titulo <texto>]`: envía
  el texto por los canales de alertas configurados (Discord, Telegram,
  webhook) con `dispatchToChannelsDetailed`, lo mismo que «Enviar notificación
  de prueba»; `error` sale como alerta crítica y, sin `--titulo`, el título es
  «Aviso del servidor». No crea alertas en el panel ni audita. El resultado
  nombra los canales y, si alguno falla, el estado HTTP o el código de red
  (nunca la URL ni el token de Telegram), con código 1. Sin ningún canal
  configurado no envía nada, lo indica en stderr y termina con código 0.
  Mensaje de hasta 1500 caracteres y título de hasta 100; los caracteres de
  control (salvo el salto de línea y el tabulador) se cambian por espacios. La
  usa `skyway update --auto` (§9.1), que le pasa el texto como argumento de
  `docker exec`, sin un shell de por medio.

`token.js` y `mailway.js` las usa el instalador de Mailway (modo junto a
Skyway) para emparejar los paneles sin pasos manuales: crea un token de Skyway
de 60 minutos si no se le ha dado uno, despliega el panel de Mailway, conecta
con el token de gestión que le devuelve Mailway y revoca el token de Skyway al
terminar.

Despliegue con Docker: ver el `README.md` y el `docker-compose.yml` (incluye
Traefik y publica la UI solo en `127.0.0.1:4000`).

### 9.1 Actualizar Skyway y actualizaciones automáticas

`scripts/skyway` (enlazado como `/usr/local/bin/skyway`, ver
[CONTROL-REMOTO.md](CONTROL-REMOTO.md)) actualiza el propio Skyway en el
servidor, sin API ni token:

```bash
skyway update                     # pregunta antes; -y no pregunta; --forzar reconstruye aunque no haya nada nuevo
skyway update --auto              # sin preguntas y con aviso por los canales de alertas (lo usa el temporizador)
sudo skyway auto-update on [--hora HH:MM] [--sistema]   # cada día a las 04:30 o a la hora indicada
sudo skyway auto-update status    # si está activa, próxima ejecución, último resultado y registro
sudo skyway auto-update off [--sistema]
```

**Qué hace `skyway update`.** Se ejecuta desde una copia temporal del script,
para que actualizar el código no lo reescriba a mitad de ejecución.

1. Consulta la rama remota que sigue la copia del servidor (normalmente
   `origin/main`). Sin nada nuevo termina con código 0 sin reconstruir ni
   reiniciar nada: la ejecución nocturna no reinicia el panel ni Traefik cada
   día.
2. Anota el estado de partida: el commit actual, si el panel responde en
   `http://localhost:4000/api/health` (o `SKYWAY_HEALTH_URL`), si el contenedor
   `skyway-traefik` está en marcha y, si el `.env` del repositorio tiene un
   `SKYWAY_DOMAIN` público (no `*.localhost`), si el panel responde por HTTPS a
   través de Traefik con un certificado válido
   (`curl --resolve <dominio>:443:127.0.0.1`).
3. Avanza el código solo en limpio (`git merge --ff-only`): con commits locales,
   o con cambios sin confirmar en ficheros que la actualización modifica, no
   aplica nada (código 1).
4. Construye la imagen nueva con el panel aún en marcha (`docker compose
   build`): si falla, el panel no se ha tocado y se vuelve al commit anterior.
   Antes de recrear el contenedor mira si hay despliegues en cola o en marcha
   (leyendo la base del panel desde el propio contenedor, en solo lectura): si
   los hay, los enumera y espera a que terminen (con `-y` o `--auto`, sin
   preguntar; como mucho 30 minutos). Un despliegue cortado por el reinicio se
   reintenta una vez al arrancar, con su alerta. A mano, quien actualiza puede
   no esperar y no reiniciar: el código vuelve a la versión que corre y termina
   con código 1 sin cambiar nada. Después recrea los contenedores (`docker
   compose up -d --build`, que ya no compila nada).
5. Durante unos 3 minutos comprueba que el panel responde con la versión del
   `package.json` y que lo que funcionaba antes sigue funcionando: Traefik en
   marcha sin reiniciarse (la misma hora de inicio en dos comprobaciones
   seguidas) y el panel por HTTPS. Lo que ya fallaba antes de actualizar (un
   certificado todavía sin emitir, un Traefik retirado en favor de un proxy
   propio) no se exige.
6. Si la compilación o una comprobación falla, vuelve automáticamente al
   commit anterior con `git reset --keep` (deshace solo lo que trajo la
   actualización y conserva los cambios locales de otros ficheros, por ejemplo
   un `docker-compose.yml` retocado), lo reconstruye (la imagen base y la caché
   de compilación de la versión anterior siguen en Docker) y lo comprueba
   igual.
7. Si todo ha ido bien, avisa si la imagen se quedó sin Nixpacks (se descarga
   al construir y, si falla, la imagen se construye igual: los repositorios sin
   Dockerfile dejarían de compilar) con la orden para reconstruirla sin caché y,
   solo a mano, ofrece borrar las imágenes sin etiqueta que deja cada
   actualización (`docker image prune -f`).

Nunca toca volúmenes ni datos, y nunca restaura nada por su cuenta. Las
migraciones de la base de datos del panel solo añaden tablas y columnas, así que
la versión anterior funciona con una base ya migrada; si alguna vez hiciera
falta volver atrás también los datos, la copia diaria del panel (hacia las
04:00, en Ajustes → Copias de seguridad del panel) se restaura a mano con el
procedimiento de §9.

Códigos de salida: **0**, actualizado y comprobado, o nada que actualizar;
**1**, no se ha actualizado y el servidor sigue con la versión que tenía (ha
fallado y se ha vuelto atrás, o no se podía aplicar sin riesgo); **2**, ha
fallado y la vuelta atrás también: hay que revisar el servidor
(`docker compose logs skyway`).

Una sola actualización a la vez (cerrojo `flock` en `.git/skyway-update.lock`).
Dos marcadores en `.git/`: `skyway-update-en-curso`, si una ejecución se cortó a
medias o su vuelta atrás falló (la siguiente reconstruye y comprueba aunque no
haya nada nuevo, y vuelve, si hace falta, a la versión que funcionaba antes), y
`skyway-update-fallida`, el commit que falló y se deshizo: `--auto` no lo
reintenta hasta que haya otro commit nuevo; `skyway update` a mano sí.

**Modo `--auto`.** Es el del temporizador: no pregunta y solo actualiza desde un
estado sano. Si antes de empezar el panel no responde o Traefik está detenido,
no aplica nada ni arranca nada (alguien puede haberlo detenido a propósito, por
ejemplo para restaurar la base de datos) y termina con código 1; si lo detuvo
una actualización cortada, sí sigue. Avisa por los canales de Ajustes → Alertas
con `aviso.js` (sin canales, no envía nada): un aviso breve de información al
actualizar («Skyway se ha actualizado a la versión X (commit abc1234).») y uno
de error, con el motivo, cuando no se aplica, cuando se vuelve atrás y cuando la
vuelta atrás falla. Sin nada nuevo no avisa, y un fallo al avisar nunca cambia
el resultado.

**Temporizador.** `auto-update on` (con sudo) escribe
`/etc/systemd/system/skyway-auto-update.service` (`Type=oneshot`, como root,
`skyway update --auto` con la ruta real del script, tope de 1 hora) y
`skyway-auto-update.timer` (`OnCalendar=*-*-* 04:30:00` o la hora de `--hora`,
en la hora local del servidor,
`RandomizedDelaySec=10min`, `Persistent=true`: si el servidor estaba apagado,
se ejecuta al encenderlo), y lo activa (`systemctl daemon-reload` y `enable
--now`). Antes comprueba que git puede leer el repositorio como root y que la
copia sigue una rama remota. Repetirlo con otra `--hora` cambia la hora. `status`
muestra si está activo, la próxima ejecución, el resultado de la última (desde
el último arranque) y las 30 últimas líneas del registro; el historial
completo está en `journalctl -u skyway-auto-update`. `off` detiene el
temporizador (una actualización en marcha termina) y borra las unidades.

**Parches del sistema (`--sistema`, Debian y Ubuntu).** Instala
`unattended-upgrades` si falta y escribe
`/etc/apt/apt.conf.d/52skyway-actualizaciones`: vacía las listas de orígenes de
`50unattended-upgrades` (`#clear`) y deja solo los archivos de seguridad de
Debian y Ubuntu (también los de Ubuntu Pro/ESM, si están activos), y reinicia a
las 05:30 solo cuando un parche lo exige (núcleo, libc): una hora después de
la actualización de Skyway (04:30, más el margen aleatorio y la compilación),
así que un reinicio nunca corta una actualización ni su vuelta atrás. Con otra
`--hora`, el reinicio también va una hora después, y cambiar la hora sin
repetir `--sistema` lo mueve igualmente.
Crea `20auto-upgrades` (listas y parches cada día) solo si no existe. Ni las
versiones nuevas de la distribución ni los repositorios de terceros (Docker
incluido) se actualizan solos. `off --sistema` retira el fichero de Skyway (y
`20auto-upgrades`, si lo creó Skyway); `unattended-upgrades` queda instalado con
la configuración de la distribución. En otros sistemas, `--sistema` se rechaza
sin instalar nada.

**Qué llega al servidor.** Lo que esté en la rama principal, que el servidor
sigue: también lo que fusiona una persona, con las mismas comprobaciones y la
misma vuelta atrás. Dependabot (`.github/dependabot.yml`) abre cada semana, por
ecosistema, un PR con los parches (`x.y.Z`) agrupados (`parches-npm`,
`parches-imagenes` del `Dockerfile`, `parches-compose` de `docker-compose.yml`,
`parches-acciones`) y, con las alertas de seguridad de npm, otro con las
correcciones que son parche (`seguridad-npm`). Cada ecosistema tiene su día
(de lunes a jueves, a las 04:00, hora de Madrid), para que no haya dos PR de
parches abiertos a la vez. Las versiones menores y mayores llegan en PR sueltos
que revisa una persona; un salto mayor de las imágenes (Node 24, Traefik 4) ni
siquiera se propone. Las imágenes llevan versión exacta
(`node:22.23.3-alpine` en las tres etapas del `Dockerfile`, `traefik:v3.7.14`
en `docker-compose.yml`): una etiqueta flotante nunca se renovaría, porque
`docker compose up` solo descarga las imágenes que faltan, y si lo hiciera
sería sin pasar por la CI.

**Fusión automática (`.github/workflows/parches-automaticos.yml`).** Al terminar
la CI de un PR (`workflow_run`) cuya rama empieza por `dependabot/`, el flujo,
solo con `gh` y sin descargar ni ejecutar el código del PR, busca el único PR
abierto desde esa rama en el propio repositorio y exige: que su autor sea
Dependabot (`app/dependabot`), que vaya contra la rama principal y que su
último commit sea el que probó la CI; que el título sea de un grupo
`parches-…` o `seguridad-…` y que no modifique `.github/workflows` (GitHub no
deja que el token de un flujo lo haga, así que los parches de las acciones de
la CI, que no llegan al servidor, los fusiona una persona); que todas las
comprobaciones de ese commit hayan terminado bien (`success`, `skipped` o
`neutral`); y que la rama incluya todo lo que hay en la principal
(`behind_by` = 0), para que lo fusionado sea exactamente lo probado.
Entonces lo fusiona con un commit de fusión
(`gh pr merge --merge --delete-branch --match-head-commit <sha>`). Si algo no
se cumple, termina sin error y deja el motivo en su registro. Las ejecuciones
esperan en fila (`concurrency` con `queue: max`), una fusión cada vez y sin que
GitHub descarte ninguna cuando la CI de varios PR termina a la vez. Si la rama
principal avanza antes de la fusión, el PR se queda sin fusionar: Dependabot lo
pone al día solo si hay conflictos, así que sin ellos hay que comentar
`@dependabot rebase` en el PR, y al terminar su CI el flujo lo vuelve a evaluar.
La fusión la hace el token del propio flujo, que no vuelve a lanzar la CI en la
rama principal: no hace falta, porque el árbol fusionado es el que probó la CI
del PR. En GitHub hay que activar las alertas y las actualizaciones de seguridad
de Dependabot (Settings → Code security), y la protección de la rama principal,
si la hay, no debe exigir revisiones: con ellas, la fusión falla y el PR espera
a una persona.
