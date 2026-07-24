# Skyway — Referencia de funcionalidad completa

> Documento de referencia único y exhaustivo, pensado para ser **consultado por
> un LLM** (o por una persona). Describe qué hace Skyway, cómo está organizado el
> código, el modelo de datos, el modelo de seguridad y **toda la API REST**.
>
> Skyway es una plataforma de despliegue auto-alojada estilo Railway: despliega
> repos de GitHub y bases de datos sobre Docker, en un único servidor, con panel
> web, métricas en vivo, dominios con TLS, backups y alertas.
>
> Versión de este documento: 0.23.0. Si el código y este documento discrepan,
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
  audit.ts              registro de auditoría (actor, acción, IP)
  modules.ts            catálogo de módulos (capacidades que un plan/workspace activa)
  quota.ts              cuota efectiva, asignación agregada de recursos y módulos por workspace
  company.ts            perfil fiscal de la empresa emisora + claves de Stripe (en settings)
  stripe.ts             cliente mínimo de Stripe (Checkout Session + verificación de firma de webhook)
  pricing.ts            cálculo de precios por tramos (graduated/volume) del catálogo
  aigateway.ts          gateway de IA: config (clave de Gemini del operador, modelos), medición de tokens,
                        streaming SSE, API compatible con OpenAI y coste/margen por modelo
  billingauto.ts        automatización: corte por impago (dunning), reactivación y factura automática del ciclo
  billingsettings.ts    ajustes de automatización (auto-generar/auto-emitir el ciclo, umbrales de morosidad)
  security.ts           escáner de seguridad (hallazgos + nota)
  variables.ts          resolución de ${{Servicio.VAR}} y ${{shared.VAR}}
  templates.ts          plantillas de BBDD (postgres/redis/mysql/mongo/minio)
  dbconsole.ts          consola de consultas (psql/mysql/mongosh/redis-cli vía exec)
  files.ts              explorador de archivos por contenedor (tar sobre socket)
  backups.ts            volcado/restauración de BBDD (dump dentro del contenedor)
  sysbackup.ts          snapshots del propio skyway.db (VACUUM INTO + retención)
  disk.ts               uso de disco por servicio y del host
  domains.ts            IP del servidor + verificación DNS de dominios
  notify.ts             envío a Discord/Telegram/webhook
  alerts.ts             creación/resolución de alertas (con dedupe) + notificación
  metrics.ts            deltas de red por réplica + agrupado del histórico de consumo
  monitor.ts            bucle 30 s: caídas, bucles de reinicio, CPU/RAM, uptime, disco, histórico
  scheduler.ts          bucle 10 min: backups programados de BBDD + snapshot diario del panel
  autodeploy.ts         bucle ~2 min: sondea la cabeza de la rama (git ls-remote) y despliega si cambió
  events.ts             bus en memoria para logs de despliegue (SSE)
  sse.ts                utilidad Server-Sent Events
  docker/
    client.ts           instancia dockerode + ping cacheado
    networks.ts         red edge (Traefik) y red privada por proyecto
    containers.ts       crear/arrancar/parar, stats, logs, exec, réplicas, labels
  deploy/
    builder.ts          clone (git) + build (Dockerfile o Nixpacks), enmascara secretos
    deployer.ts         orquestador: build → swap sin corte → validación → rollback
    queue.ts            cola serializada por servicio + semáforo de builds
    diagnose.ts         diagnóstico de fallos y explicación de códigos de salida
  github/client.ts      API de GitHub: validar tokens, listar repos y ramas (solo lectura)
  railway/client.ts     cliente GraphQL de Railway (solo en memoria)
  railway/importer.ts   análisis y ejecución de la importación desde Railway
  routes/               una ruta por área (ver §7 API)
  tools/reset-password.ts  CLI de emergencia para restablecer contraseña

web/src/
  main.tsx, App.tsx     arranque React + router
  api.ts                cliente fetch (/api, cookies same-origin) + EventSource
  types.ts              tipos del cliente (espejo de server/types)
  utils.ts              formateadores, etiquetas de estado/acción
  hooks.ts              useLocalStorage, useMediaQuery…
  pages/                Dashboard, Proyecto, Monitor, Sitios, Estado, Ajustes…
  components/           canvas de servicios, drawer con pestañas, gráficas
  components/tabs/      Despliegues, Consultas, Variables, Backups, Archivos,
                        Métricas, Logs, Ajustes del servicio
```

---

## 2. Arquitectura en ejecución

- **Servidor**: Node 20+/TypeScript/Fastify. Estado en SQLite (`/data/skyway.db`,
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
    entre sí por su *slug* (`postgres:5432`, `redis:6379`…).
- **Traefik** (en el `docker-compose`): enruta por dominio y emite TLS con
  Let's Encrypt. Se activa por *labels* que Skyway pone en cada contenedor.

### Pipeline de despliegue (deploy/deployer.ts)

1. `triggerDeploy(serviceId, trigger)` crea una fila `deployments` en estado
   `queued` y la encola. La cola (`queue.ts`) **serializa por servicio** (un
   deploy a la vez por servicio) y limita los builds globales con un semáforo
   (`BUILD_CONCURRENCY`, por defecto 2).
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
   - `git` → clone superficial (`--depth 1 --branch`) + build con **Dockerfile**
     si existe (BuildKit; si el plugin buildx faltara, se degrada al builder
     clásico con un aviso en el log), o **Nixpacks** si no. Si el repo trae
     `railway.json` con `deploy.startCommand`, ese comando **manda sobre el
     `startCmd` del servicio** (misma precedencia config-as-code que Railway;
     el importador copia el del panel y puede contradecir al del repo). El
     token para clonar se resuelve así: el
     **conector de GitHub** del servicio (`connectorId`, token del cliente) o, en
     su defecto, el token global (`settings.githubToken`); se inyecta en la URL y
     se **enmascara** en los logs. Si el conector referenciado ya no existe, se
     avisa en el log y se usa el global.
   - rollback → reutiliza una imagen ya construida (`image_tag`), si sigue viva.
3. **Despliegue del contenedor** (swap con validación):
   - **Corte cero** (servicios sin volúmenes ni puerto de host): se arranca la
     versión nueva en paralelo, se **valida** (healthcheck HTTP 2xx o periodo de
     gracia) y solo entonces se intercambia, réplica a réplica (rolling update).
   - **Con estado** (volúmenes/puerto fijo/BBDD): intercambio con **restauración
     automática** — si la versión nueva falla la validación, vuelve la anterior.
   - `recoverStaleSwap` repara restos (`--next`/`--prev`) de un swap interrumpido
     por una caída del servidor.
4. **Post**: un deploy correcto resuelve las alertas de caída del servicio y
   purga imágenes antiguas (se conservan las **5 últimas** por servicio para
   rollback). Un fallo genera una alerta con diagnóstico (`diagnose.ts`).

---

## 3. Modelo de datos (SQLite)

| Tabla | Claves / campos relevantes |
| --- | --- |
| `users` | `id`, `email` (único), `password_hash` (scrypt `s2:salt:hash`), `role` (`admin`/`owner`/`member`), `workspace_id` (owner/member), `session_epoch` |
| `user_projects` | `(user_id, project_id)` — proyectos asignados a un miembro |
| `plans` | `id`, `name`, `slug`, `price_cents`, `currency`, `interval`, cuotas incluidas (`cpu_cores`, `memory_mb`, `disk_mb`, `max_projects`, `max_services`, `max_members`), `modules` (JSON), `is_default`, `archived`, `discount_pct` (descuento comercial % de las cuentas del plan) |
| `workspaces` | `id`, `name`, `slug`, `plan_id`, overrides de cuota (mismos campos, null = hereda del plan), `modules_override` (concesión del admin), `owner_disabled_modules` (acotado del propietario), `status` (`active`/`suspended`), `billing_email`, `billing_tax_id` (NIF/CIF del cliente), `billing_address` (domicilio fiscal del cliente), `billing_day`, `discount_pct` (descuento % de la cuenta; null = hereda del plan), `notes`, y estado de morosidad (`ai_suspended`, `dunning_stage` 0→3, `dunning_since`, `last_dunning_action_at`, `dunning_exempt`) |
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
| `ai_model_prices` | coste del operador por modelo y margen objetivo: `model` (PK), `cost_micros_in`/`cost_micros_cache`/`cost_micros_out` (micro-céntimos por millón de tokens), `margin_pct` (margen objetivo s/ venta, guía el PVP sugerido), `currency`, `updated_at`. Informativo; no interviene en la factura |
| `passkeys` | credencial WebAuthn: `credential_id`, `public_key`, `counter`, `rp_id`… |
| `api_tokens` | `token_hash` (sha256 hex), `prefix`, `expires_at` — tokens `sky_…` |
| `settings` | pares clave/valor: `jwtSecret`, `githubToken`, `rootDomain`, `letsencryptEmail`, `serverIp`, canales de alerta, `importReport:<projectId>`, `billingProfile` (perfil fiscal del emisor, JSON: razón social, NIF, domicilio, IVA por defecto, `defaultIrpfRate`, `sifMode` veri/no-veri, IBAN…), claves de Stripe (`stripeSecretKey`, `stripeWebhookSecret`, `stripePublishableKey` — las secretas nunca se devuelven), gateway de IA (`ai.geminiApiKey` — clave del operador, nunca devuelta; `ai.allowedModels`, `ai.geminiBaseUrl`), dunning (`billing.dunningGraceDays` por defecto 14, `billing.dunningCancelDays` por defecto 44)… |
| `projects` | `id`, `name`, `slug` (único), `workspace_id` (cuenta de cliente), `client` (reflejo denormalizado del nombre del workspace para la UI), página de estado (`status_token`, `status_enabled`, `status_notice`) |
| `services` | `id`, `project_id`, `name`, `slug`, `type` (`git`/`database`/`image`), `config` (JSON) |
| `env_vars` | `(service_id, key)` → `value` — variables por servicio |
| `project_vars` | `(project_id, key)` → `value` — variables compartidas |
| `deployments` | `status`, `trigger`, `commit_sha/msg`, `image_tag`, `logs`, `error`, `diagnosis` |
| `audit_log` | `ts`, `actor`, `action`, `target_*`, `detail`, `ip` |
| `alerts` | `severity`, `type`, `title`, `message`, `explanation`, `dedupe_key`, `resolved_at`, `read_at` |
| `uptime_hourly` | `(service_id, hour)` → `up`, `total` — histórico de disponibilidad |
| `service_metrics_hourly` | `(service_id, hour)` → sumas y máximos de CPU/RAM, bytes de red del periodo (delta) y foto de disco — histórico de consumo (~90 d) |
| `host_metrics_hourly` | `hour` → carga, RAM y disco del host (sumas, máximos y última foto) — histórico de consumo del servidor (~90 d) |
| `github_connectors` | `id`, `project_id`, `name`, `token` (en claro: se necesita para clonar; jamás sale por la API), `gh_login`, `token_type`, `created_by`, `last_used_at` — cae en cascada con el proyecto |

`config` de servicio (ver `types.ts`): `GitConfig`, `DatabaseConfig`, `ImageConfig`
comparten `domains`, `hostPort`, `cpus`, `memoryMb`, `diskMb`, `healthcheckPath`,
`volumes`, `replicas`; git añade `repoUrl`, `connectorId`, `branch`, `rootDir`,
`dockerfilePath`, `startCmd`, `port`, `buildArgs`, `webhookSecret`, `autoDeploy`;
database añade `template`, `version`, `backupSchedule`, `backupRetention`.

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
  puede fabricarse acceso persistente.
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
- **Anti fuerza bruta**: límite por IP (8 intentos / 15 min) en login por
  contraseña y por passkey. La IP real se obtiene respetando el proxy **solo**
  de rangos privados/loopback (`config.trustProxy`), de modo que un cliente en
  internet no puede falsear `X-Forwarded-For` para evadir el límite.
- **Cabeceras de seguridad** (todas las respuestas, `app.ts`): `Content-Security-Policy`
  (mismo origen; sin scripts externos ni inline), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` restrictiva y
  `Strict-Transport-Security` sobre HTTPS.
- **Webhooks**: firma **HMAC-SHA256** verificada con comparación en tiempo
  constante sobre el cuerpo crudo. El webhook de Stripe añade tolerancia temporal
  (anti-replay) y solo actúa si Stripe confirma `payment_status == paid`; las
  claves de Stripe se guardan en `settings` y nunca se devuelven en claro.
- **Consola de BBDD y explorador de archivos**: todo corre **dentro** del
  contenedor con exec; las consultas/rutas viajan como variables de entorno del
  exec, **nunca interpoladas en el shell**. La consola tiene modo solo-lectura
  por defecto (reforzado en el propio motor).
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
| `connectorId` | ✓ | — | — | conector de GitHub del proyecto para clonar (null = token global) |
| `buildArgs` | ✓ | — | — | `--build-arg` |
| `image` | — | ✓ | — | imagen pública |
| `template`, `version` | — | — | ✓ | postgres/redis/mysql/mongo/minio |
| `port` (interno) | ✓ (def. 3000) | opcional (null = **worker**) | fijo por plantilla | Traefik enruta a este puerto |
| `domains` | ✓ | ✓ | — | Traefik + TLS |
| `hostPort` (público) | ✓ | ✓ | ✓ (⚠ expone BBDD) | salta Traefik |
| `cpus`, `memoryMb` | ✓ | ✓ | ✓ | en caliente |
| `diskMb` | ✓ | ✓ | ✓ | cuota orientativa, vigilada por el monitor |
| `healthcheckPath` | ✓ | ✓ | — | validación del deploy |
| `volumes` | ✓ | ✓ | fijo (su volumen) | conserva nombre al editar |
| `replicas` (1–10) | ✓ | ✓ | 1 | requiere sin volúmenes ni hostPort |
| `autoDeploy` | ✓ | — | — | sondeo de la rama; despliega al haber commit nuevo (opt-out) |
| `backupSchedule`, `backupRetention` | — | — | ✓ | diario/semanal ~04:00 |
| `alertsMuted` | ✓ | ✓ | ✓ | silencia alertas del servicio |

**Worker/módulo sin HTTP**: un servicio `image` con `port: null` (o un `git` cuyo
proceso no escucha) corre en segundo plano; sin puerto no se crea router de
Traefik y la validación del deploy usa el periodo de gracia en vez del healthcheck.
Esto reproduce el comportamiento de un *worker* de Railway.

---

## 6. Áreas funcionales (resumen)

- **Despliegues**: build en vivo (SSE), historial, cancelación, rollback a
  cualquiera de las 5 imágenes conservadas, diagnóstico de fallos en español.
- **Auto-deploy** (servicios git): Skyway sondea la cabeza de la rama cada ~2 min
  con `git ls-remote` (mismo acceso que el clon, sirve para repos privados y para
  servidores sin dominio) y despliega en cuanto aparece un commit nuevo. Sin tocar
  GitHub; la primera comprobación fija la línea base y solo disparan los commits
  posteriores. Se controla con `autoDeploy` (opt-out) en Ajustes del servicio.
  El **webhook** de GitHub (`/api/webhooks/github/:serviceId`, HMAC) sigue
  disponible para despliegues instantáneos: obedece la misma opción `autoDeploy` y
  no se pisa con el sondeo (un commit ya construido no se vuelve a desplegar). El
  interruptor `autoDeploy` manda sobre ambas vías a la vez.
- **Variables**: por servicio y compartidas por proyecto; referencias
  `${{Servicio.VAR}}` y `${{shared.VAR}}` resueltas al desplegar.
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
- **Dominios y TLS**: verificación DNS en vivo, subdominios con comodín, TLS
  automático con Let's Encrypt vía Traefik.
- **Página de estado pública**: dashboard compartible por token (sin login), con
  disponibilidad 90 días, incidencias y aviso de mantenimiento; token rotable.
- **Importador de Railway**: analiza un proyecto por la API oficial y recrea
  servicios, variables (con referencias), dominios y volúmenes; genera los
  comandos de copia de datos. Las variables que apuntaban a bases de datos de
  Railway también importadas se **reconectan solas** como referencias
  `${{Base.VAR}}` al servicio nuevo (por host privado/proxy público, o por
  esquema si es inequívoco); solo lo no mapeable genera aviso. El token viaja
  solo en memoria.
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
- **Passkeys (WebAuthn)** y **tokens de API** para automatización/agentes.

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
| POST | `/auth/passkeys` | session | registra una passkey |
| DELETE | `/auth/passkeys/:id` | auth | borra una passkey |
| POST | `/auth/passkey-login/options` | público (rate-limit) | opciones de login con passkey |
| POST | `/auth/passkey-login` | público (rate-limit) | login con passkey (sin email) |

### 7.2 Tokens de API y usuarios
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/tokens` | auth | lista tokens del usuario |
| POST | `/tokens` | session | crea token (`{name, expiresDays?}`) → devuelve el valor una vez |
| DELETE | `/tokens/:id` | auth | revoca un token |
| GET | `/users` | admin | lista usuarios |
| POST | `/users` | admin | crea usuario (`{email, password, role, projectIds}`) |
| PATCH | `/users/:id` | admin | cambia rol / workspaces / contraseña |
| DELETE | `/users/:id` | admin | elimina usuario (deja ≥1 admin) |

### 7.2.1 Cuentas de cliente, planes y facturación
Niveles: **manage** = admin o propietario del workspace del recurso; **admin** = solo administrador de plataforma.

| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/modules` | auth | catálogo de módulos (capacidades) para las etiquetas de la UI |
| GET | `/workspaces` | auth | admin: todas; propietario: la suya; miembro: ninguna. Incluye cuota, asignación y módulos |
| POST | `/workspaces` | admin | crea una cuenta (`{name, planId?, billingEmail?, billingDay?}`) |
| GET | `/workspaces/:id` | manage | cuenta + proyectos + sub-usuarios |
| PATCH | `/workspaces/:id` | admin | **live resize**: cuota, plan, concesión de módulos, estado (suspender), facturación |
| DELETE | `/workspaces/:id` | admin | elimina la cuenta y sus sub-usuarios; sus proyectos quedan sin asignar |
| PATCH | `/workspaces/:id/modules` | manage | el propietario **acota** (desactiva) módulos concedidos (`{disabled}`) |
| GET | `/workspaces/:id/usage?days=` | manage | uso agregado (núcleo·h, GB·h, picos) del periodo |
| GET | `/workspaces/:id/usage/series?days=` | manage | serie temporal de uso por cubos (para gráficas) + top de proyectos por consumo |
| POST | `/workspaces/:id/members` | manage (session) | crea un sub-usuario del workspace (el propietario solo crea miembros) |
| PATCH | `/workspaces/:id/members/:userId` | manage | cambia rol/proyectos/contraseña de un sub-usuario |
| DELETE | `/workspaces/:id/members/:userId` | manage | elimina un sub-usuario del workspace |
| GET | `/plans` | admin | lista de planes (con nº de cuentas que lo usan) |
| POST | `/plans` | admin | crea un plan (usos incluidos + precio + `discount_pct` opcional) |
| PATCH | `/plans/:id` | admin | edita un plan |
| DELETE | `/plans/:id` | admin | borra un plan (bloqueado si alguna cuenta lo usa) |
| GET | `/workspaces/:id/invoices` | manage | facturas de la cuenta + datos del emisor (perfil fiscal), del cliente y si Stripe está activo |
| POST | `/workspaces/:id/invoices/generate` | admin | genera la factura del ciclo (plan + uso) con el IVA del perfil |
| POST | `/workspaces/:id/invoices` | admin | crea un borrador a medida (`{lines[], taxRate?, irpfRate?, vatRegime?, operationDate?, notes?}`); cada línea admite su propio `taxRate` |
| PATCH | `/invoices/:id` | admin | edita el borrador o transiciona el estado. **El contenido fiscal solo es editable en borrador**; una factura emitida es inmutable (409). Al emitir (`issued`/`paid`) congela emisor y destinatario, asigna nº de serie del ejercicio y bloquea (`locked`). Transiciones válidas: `draft→issued→paid`, `→void`; nunca vuelve a borrador |
| DELETE | `/invoices/:id` | admin | **solo borradores**; una factura emitida se conserva (409): debe anularse o rectificarse, nunca borrarse |
| POST | `/invoices/:id/rectify` | admin | crea una **factura rectificativa** (borrador, serie REC) que corrige una emitida (`{reason, lines?, operationDate?}`); sin `lines` es anulación total, con `lines` correctas factura la diferencia; enlaza por `rectifies_invoice_id` |
| POST | `/invoices/:id/stripe-link` | admin | emite la factura (alta antes del cobro) y crea/reutiliza el enlace de pago Stripe |

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
| POST | `/products` | admin | crea un producto (`{name, category, billingModel, priceCents, meter?, tierMode?, tiers?, taxRate?, …}`) |
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
| GET | `/ai/gateway/prices` | admin | coste del operador por modelo (`ai_model_prices`), margen objetivo, **PVP sugerido** (coste/(1−margen)) y PVP de referencia del catálogo con el margen actual |
| PUT·DELETE | `/ai/gateway/prices/:model` | admin | fija/borra coste (€/M: entrada, cache, salida) y `marginPct` (margen objetivo s/ venta) de un modelo |
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

### 7.3 Proyectos, variables compartidas y conectores de GitHub
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/projects` | auth | proyectos accesibles (con meta) |
| POST | `/projects` | admin/owner | crea proyecto (`{name, client?, workspaceId?}`); el propietario en su workspace, dentro de la cuota |
| GET | `/projects/:id` | +access | proyecto + servicios con runtime |
| PATCH | `/projects/:id` | manage | renombra; el admin además reasigna de workspace |
| DELETE | `/projects/:id?volumes=true` | manage | elimina proyecto (y volúmenes opcional) |
| POST | `/projects/:id/deploy-all` | +access | despliega repos e imágenes del proyecto |
| GET | `/projects/:id/vars` | +access | variables compartidas |
| PUT | `/projects/:id/vars` | +access | reemplaza variables compartidas |
| GET | `/projects/:id/connectors` | +access | conectores del proyecto (sin tokens) + `hasGlobalToken` |
| POST | `/projects/:id/connectors` | +access | conecta un token (`{name, token}`; se verifica contra GitHub) |
| DELETE | `/connectors/:id` | +access | elimina un conector (sus servicios vuelven al token global) |
| POST | `/connectors/:id/test` | +access | revalida el token guardado contra GitHub |
| GET | `/connectors/:id/repos` | +access | repos visibles con ese token (para el selector) |
| GET | `/connectors/:id/branches?repo=owner/repo` | +access | ramas del repo (la por defecto primero) |
| GET | `/connectors` | admin | todos los conectores de todos los proyectos (control central) |

**Conectores de GitHub**: cualquier usuario con acceso al workspace (clientes
incluidos) conecta un token de su cuenta; al crear o editar un servicio `git`
elige el conector y el repo/rama de esa cuenta. El token se guarda en el servidor,
nunca se devuelve, y solo se usa para listar repos y clonar. Todo queda auditado
(`connector_created`/`connector_deleted`) y el admin lo controla desde Ajustes.

### 7.4 Servicios
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/templates` | auth | plantillas de BBDD disponibles |
| POST | `/projects/:projectId/services` | +access | crea servicio (git/database/image) |
| GET | `/services/:id` | +access | servicio + runtime + último deploy |
| PATCH | `/services/:id` | +access | edita `name`/`config` (recursos en caliente) |
| DELETE | `/services/:id?volumes=true` | +access | elimina servicio |
| POST | `/services/:id/deploy` | +access | dispara despliegue manual |
| POST | `/services/:id/{start,stop,restart}` | +access | acciones sobre el contenedor |
| GET | `/services/:id/env` | +access | variables (crudas, resueltas, referencias) |
| PUT | `/services/:id/env` | +access | reemplaza variables del servicio |

### 7.5 Despliegues (logs por SSE)
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/services/:id/deployments` | +access | historial (25) |
| GET | `/deployments/:id` | +access | detalle (incluye logs) |
| POST | `/deployments/:id/cancel` | +access | cancela uno en curso |
| POST | `/deployments/:id/rollback` | +access | redespliega una imagen anterior (solo git) |
| GET | `/deployments/:id/logs/stream` | +access | **SSE** de build/deploy |
| GET | `/services/:id/logs/stream` | +access | **SSE** de logs de ejecución |
| GET | `/projects/:id/metrics/stream` | +access | **SSE** de métricas en vivo del proyecto |
| GET | `/services/:id/metrics/history` | +access | histórico de consumo del servicio (`?hours=`): CPU/RAM (media y pico), red y disco |

### 7.6 Consola de base de datos
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/services/:id/db/overview` | +access | esquema, tamaños y snippets |
| POST | `/services/:id/db/query` | +access | ejecuta (`{query, allowWrite}`) |
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
| POST | `/services/:id/exec` | +access | ejecuta un comando (`sh -c`) en el contenedor (60 s) |
| GET | `/services/:id/backups` | +access | lista backups |
| POST | `/services/:id/backups` | +access | crea backup (dump dentro del contenedor) |
| GET | `/services/:id/backups/:file/download` | +access | descarga un backup |
| POST | `/services/:id/backups/:file/restore` | +access | restaura (`{confirm:true}`) |
| DELETE | `/services/:id/backups/:file` | +access | borra un backup |
| GET | `/health` | público | estado + versión |
| GET | `/system` | auth | versión, docker, nixpacks, host, disco |
| GET | `/system/docker-usage` | admin | uso de Docker (imágenes/volúmenes/caché) |
| POST | `/system/prune` | admin | libera imágenes colgantes y caché de build |
| GET | `/system/backups` | admin | snapshots del propio skyway.db (+ retención) |
| POST | `/system/backups` | admin | crea un snapshot ahora (VACUUM INTO) |
| GET | `/system/backups/:file/download` | admin | descarga un snapshot (.db restaurable) |
| DELETE | `/system/backups/:file` | admin | borra un snapshot |
| GET | `/settings` | admin | ajustes (secretos como booleanos) |
| PUT | `/settings` | admin | guarda ajustes (dominio, TLS, token GitHub, alertas) |
| POST | `/settings/github/test` | admin | valida el token de GitHub |
| DELETE | `/settings/github` | admin | borra el token de GitHub |
| POST | `/settings/alerts/test` | admin | envía notificación de prueba |

### 7.9 Seguridad, alertas y monitor
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/security` | admin | hallazgos, nota y logins fallidos 24 h |
| GET | `/audit` | admin | registro de auditoría (`?limit=&action=`) |
| POST | `/security/rotate-sessions` | admin | invalida todas las sesiones |
| GET | `/alerts` | auth | alertas del ámbito del usuario (`?open=&limit=`) |
| POST | `/alerts/read-all` | auth | marca todas como leídas |
| POST | `/alerts/:id/resolve` | auth | resuelve una alerta accesible |
| GET | `/monitor/overview` | auth | todos los servicios accesibles con estado/consumo |
| GET | `/monitor/logs/search` | auth | busca texto en logs (`?q=&tail=&projectId=`) |
| GET | `/monitor/disk` | auth | disco por servicio (+ host/Docker si admin) |
| GET | `/monitor/host-history` | auth | histórico de carga, RAM y disco del host (`?hours=`) |
| GET | `/websites` | auth | vista de sitios web (servicios con dominio) |

### 7.10 Dominios, estado público, importación y webhooks
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/domains/server-ip` | auth | IP del servidor (configurada o detectada) |
| POST | `/domains/check` | auth | verifica DNS de un dominio (`{domain}`) |
| GET | `/public/status/:token` | público | página de estado pública (cacheada) |
| GET | `/projects/:id/status-page` | +access | config de la página de estado |
| POST | `/projects/:id/status-page` | admin | activa/desactiva y aviso |
| POST | `/projects/:id/status-page/rotate` | admin | rota el token del enlace |
| GET | `/projects/:id/import-report` | +access | informe de importación de Railway |
| DELETE | `/projects/:id/import-report` | +access | borra el informe |
| POST | `/import/railway/projects` | admin | lista proyectos de Railway (`{token}`) |
| POST | `/import/railway/analyze` | admin | plan de importación (sin valores de variables) |
| POST | `/import/railway/run` | admin | ejecuta la importación |
| POST | `/webhooks/github/:serviceId` | público (HMAC) | auto-deploy instantáneo en push (firma verificada); respeta `autoDeploy` y deduplica contra el último commit construido; complementa al sondeo interno de `autodeploy.ts` |
| POST | `/webhooks/stripe` | público (firma Stripe) | marca la factura como pagada al confirmarse el cobro; firma `Stripe-Signature` verificada (HMAC-SHA256 con tolerancia temporal anti-replay); exige `payment_status == paid`; idempotente |

---

## 8. Configuración por entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` | `4000` | puerto de la UI/API |
| `HOST` | `0.0.0.0` | interfaz de escucha |
| `DATA_DIR` | `./data` | SQLite, builds y backups |
| `WEB_DIST` | `web/dist` | web compilada a servir |
| `JWT_SECRET` | generado | secreto de firma de sesiones (si no, se genera y persiste) |
| `BUILD_CONCURRENCY` | `2` | builds simultáneos |
| `TRUST_PROXY` | privadas/loopback | confianza en `X-Forwarded-*` (`true`/`false`/número/CIDRs) |
| `DOCKER_SOCK` | socket estándar | ruta alternativa al socket de Docker |
| `LOG_LEVEL` | `info` | nivel de log de Fastify |

Ajustes en la UI (tabla `settings`, solo admin): `rootDomain`, `letsencryptEmail`,
`serverIp`, `githubToken`, umbrales de alerta y canales (Discord/Telegram/webhook).
Opcional: `autoDeployPollSeconds` afina el intervalo del sondeo de auto-deploy
(por defecto 120 s, mínimo 30).

---

## 9. Comandos

```bash
npm install
npm run dev          # server :4000 (tsx watch) + web :5173 (vite, proxy /api)
npm run build        # compila web y server
npm start            # sirve todo en :4000 (producción)
npm run typecheck    # server + web

# Restablecer contraseña desde el servidor (último recurso):
docker compose exec skyway node dist/tools/reset-password.js <email> [nueva]
npm run reset-password -w server -- <email> [nueva]

# Restaurar la BD del panel desde un snapshot (proceso manual a propósito):
docker compose stop skyway
docker run --rm -v skyway_skyway-data:/data alpine \
  sh -c 'cp /data/backups/skyway/<snapshot>.db /data/skyway.db'
docker compose start skyway
```

Despliegue con Docker: ver el `README.md` y el `docker-compose.yml` (incluye
Traefik y publica la UI solo en `127.0.0.1:4000`).
