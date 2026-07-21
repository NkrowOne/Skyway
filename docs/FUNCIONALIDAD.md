# Skyway — Referencia de funcionalidad completa

> Documento de referencia único y exhaustivo, pensado para ser **consultado por
> un LLM** (o por una persona). Describe qué hace Skyway, cómo está organizado el
> código, el modelo de datos, el modelo de seguridad y **toda la API REST**.
>
> Skyway es una plataforma de despliegue auto-alojada estilo Railway: despliega
> repos de GitHub y bases de datos sobre Docker, en un único servidor, con panel
> web, métricas en vivo, dominios con TLS, backups y alertas.
>
> Versión de este documento: 0.12.0. Si el código y este documento discrepan,
> gana el código (`server/src/`).

---

## 1. Mapa del código

```
server/src/
  index.ts              arranque: initDb, red edge, monitor, scheduler, listen
  app.ts                ensamblado Fastify: cabeceras de seguridad, rutas, SPA
  config.ts             configuración por entorno (puertos, dirs, trustProxy)
  db.ts                 esquema y acceso SQLite (better-sqlite3, WAL)
  types.ts              tipos compartidos (filas, configs de servicio…)
  util.ts               id/token/slug, hashPassword (scrypt), hmac, safeEqual
  auth.ts               sesiones JWT (cookie httpOnly), tokens API, roles, rate-limit
  audit.ts              registro de auditoría (actor, acción, IP)
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
  monitor.ts            bucle 30 s: caídas, bucles de reinicio, CPU/RAM, uptime, disco
  scheduler.ts          bucle 10 min: backups programados de BBDD + snapshot diario del panel
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
  github/client.ts      validación del token de GitHub (GET /user)
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
   - `database` → `docker pull` de la imagen de la plantilla.
   - `image` → `docker pull` de la imagen indicada.
   - `git` → clone superficial (`--depth 1 --branch`) + build con **Dockerfile**
     si existe, o **Nixpacks** si no. El token de GitHub se inyecta en la URL y
     se **enmascara** en los logs.
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
| `users` | `id`, `email` (único), `password_hash` (scrypt `s2:salt:hash`), `role` (`admin`/`member`), `session_epoch` |
| `user_projects` | `(user_id, project_id)` — workspaces asignados a un miembro |
| `passkeys` | credencial WebAuthn: `credential_id`, `public_key`, `counter`, `rp_id`… |
| `api_tokens` | `token_hash` (sha256 hex), `prefix`, `expires_at` — tokens `sky_…` |
| `settings` | pares clave/valor: `jwtSecret`, `githubToken`, `rootDomain`, `letsencryptEmail`, `serverIp`, canales de alerta, `importReport:<projectId>`… |
| `projects` | `id`, `name`, `slug` (único), `client`, página de estado (`status_token`, `status_enabled`, `status_notice`) |
| `services` | `id`, `project_id`, `name`, `slug`, `type` (`git`/`database`/`image`), `config` (JSON) |
| `env_vars` | `(service_id, key)` → `value` — variables por servicio |
| `project_vars` | `(project_id, key)` → `value` — variables compartidas |
| `deployments` | `status`, `trigger`, `commit_sha/msg`, `image_tag`, `logs`, `error`, `diagnosis` |
| `audit_log` | `ts`, `actor`, `action`, `target_*`, `detail`, `ip` |
| `alerts` | `severity`, `type`, `title`, `message`, `explanation`, `dedupe_key`, `resolved_at`, `read_at` |
| `uptime_hourly` | `(service_id, hour)` → `up`, `total` — histórico de disponibilidad |

`config` de servicio (ver `types.ts`): `GitConfig`, `DatabaseConfig`, `ImageConfig`
comparten `domains`, `hostPort`, `cpus`, `memoryMb`, `diskMb`, `healthcheckPath`,
`volumes`, `replicas`; git añade `repoUrl`, `branch`, `rootDir`, `dockerfilePath`,
`startCmd`, `port`, `buildArgs`, `webhookSecret`; database añade `template`,
`version`, `backupSchedule`, `backupRetention`.

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
- **Roles**: `admin` (control total del servidor) y `member` (limitado a los
  workspaces asignados; sin ajustes del servidor, seguridad ni otros clientes).
  `assertProjectAccess` protege cada recurso de proyecto.
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
  constante sobre el cuerpo crudo.
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
- **Variables**: por servicio y compartidas por proyecto; referencias
  `${{Servicio.VAR}}` y `${{shared.VAR}}` resueltas al desplegar.
- **Consola de consultas** (Consultas): explorador de tablas/colecciones/claves,
  ejecución con export CSV/JSON, snippets, historial, solo-lectura por defecto.
- **Explorador de archivos** (Archivos): navegar, descargar, subir, crear
  carpeta y borrar dentro de cada contenedor, **sin FTP ni credenciales** (va por
  el socket de Docker). Ver §7.7.
- **Métricas** (SSE): CPU, memoria y red por servicio (agregando réplicas) y del
  host, cada 2,5 s.
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
  comandos de copia de datos. El token viaja solo en memoria.
- **Multi-empresa y usuarios/roles**: proyectos por cliente; admins y miembros.
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

### 7.3 Proyectos y variables compartidas
| Método | Ruta | Nivel | Descripción |
| --- | --- | --- | --- |
| GET | `/projects` | auth | proyectos accesibles (con meta) |
| POST | `/projects` | admin | crea proyecto (`{name, client?}`) |
| GET | `/projects/:id` | +access | proyecto + servicios con runtime |
| PATCH | `/projects/:id` | admin | renombra / cambia cliente |
| DELETE | `/projects/:id?volumes=true` | admin | elimina proyecto (y volúmenes opcional) |
| POST | `/projects/:id/deploy-all` | +access | despliega repos e imágenes del proyecto |
| GET | `/projects/:id/vars` | +access | variables compartidas |
| PUT | `/projects/:id/vars` | +access | reemplaza variables compartidas |

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
| GET | `/projects/:id/metrics/stream` | +access | **SSE** de métricas del proyecto |

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
| POST | `/webhooks/github/:serviceId` | público (HMAC) | auto-deploy en push (firma verificada) |

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
