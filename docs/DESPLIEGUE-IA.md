# Desplegar en Skyway: guía para agentes de IA

> Cómo configurar y desplegar bots, aplicaciones y webs en Skyway, escrito para un agente de IA que
> prepara un repositorio o maneja la API. Comprobado contra el código (`server/src/`); si
> discrepan, gana el código. Referencia completa:
> [FUNCIONALIDAD.md](FUNCIONALIDAD.md).

## 1. Para qué sirve y cómo usarla

- **Preparar un repositorio**: §2, tipo en §3, plantilla de §10 y lista de §11.
- **Desplegar por API**: secuencia de §9. Requiere un token `sky_…`.
- **Arreglar un despliegue fallido**: busca el texto del registro en §12.
- Los nombres de ficheros, claves, variables y rutas son exactos. Lo que Skyway no hace está marcado
  como **no está soportado** o **no se aplica**.

## 2. Resumen

1. Un servicio de repositorio se construye con el `Dockerfile` si existe; si no, con Nixpacks. Para
   resultados reproducibles, incluye un `Dockerfile`.
2. La aplicación escucha en `0.0.0.0` y en el puerto de la variable `PORT`. Skyway fija `PORT` al
   puerto interno del servicio (3000 por defecto).
3. El proceso principal permanece en ejecución. Un proceso que termina, aunque sea con código 0, es
   un despliegue fallido. Skyway lo ejecuta bajo un init que le entrega `SIGTERM`: sin manejador,
   termina al momento; con uno, el manejador tiene que cerrar y salir.
4. Una web o API pública declara una ruta de healthcheck que responde 2xx sin autenticación:
   `deploy.healthcheckPath` en `railway.json`.
5. Un bot de polling o un worker va sin dominio, sin healthcheck y con 1 réplica. Skyway lo
   despliega con «una sola copia».
6. Las migraciones van en `deploy.preDeployCommand` de `railway.json`. Si fallan, la versión en
   marcha no se toca.
7. Las conexiones a bases de datos son referencias: `DATABASE_URL=${{postgres.DATABASE_URL}}`, nunca
   la contraseña literal.
8. Ningún secreto en el repositorio, en un `ARG` del Dockerfile ni en `buildArgs`: van en las
   variables del servicio.
9. Los datos persistentes van en un volumen. El resto del sistema de ficheros del contenedor se
   pierde en cada despliegue.
10. Cambiar variables o ajustes no reinicia nada: hay que volver a desplegar (`needsRedeploy: true`,
    `pendingChanges: true`).
11. Las tareas programadas (cron) **no están soportadas**.

## 3. Árbol de decisión por tipo de proyecto

```
¿Qué se despliega?
├─ Proceso HTTP con dirección pública ..................... A. Web o API pública
├─ Proceso HTTP que solo llaman otros servicios ............ B. API interna
├─ Proceso sin HTTP (bot de polling, consumidor de cola) ... C. Bot o worker
├─ HTML, CSS y JS ya compilados ............................ D. Sitio estático
├─ PostgreSQL, Redis, MySQL, MongoDB o MinIO ............... E. Base de datos
├─ Tarea periódica ......................................... F. Tareas programadas
├─ Imagen ya publicada en un registro ...................... G. Servicio de imagen
└─ docker-compose con varios contenedores .................. H. Varios servicios
```

| Tipo | `type` | Puerto interno | Dominio | Healthcheck | Réplicas | Estrategia automática |
| --- | --- | --- | --- | --- | --- | --- |
| A. Web o API pública | `git` | el que escucha (def. 3000) | sí | recomendado | 1–10 | sin corte |
| B. API interna | `git` | el que escucha | no | recomendado | 1–10 | sin corte si tiene healthcheck o la referencian |
| C. Bot o worker | `git` | irrelevante | no | no | **1** | una sola copia |
| D. Sitio estático | `git` + Dockerfile | el del servidor HTTP | sí | opcional | 1–10 | sin corte |
| E. Base de datos | `database` | fijo por plantilla | no | — | 1 | una sola copia |
| G. Imagen | `image` | `port`, o ninguno (worker) | solo con puerto | opcional | 1–10 | mismas reglas (§4.5) |

- **B**: los demás servicios la llaman con `${{api.INTERNAL_URL}}` (`http://<slug>:<puerto>`), y
  Skyway lo detecta. Una llamada escrita en el código no se detecta: fija
  `"deployStrategy":"overlap"`.
- **C**: los bots de Telegram y Discord se reconocen por su biblioteca (telegraf, grammy,
  node-telegram-bot-api, discord.js, python-telegram-bot, aiogram, discord.py, py-cord, nextcord…)
  y, sin dominio, van siempre con una sola copia. Cada réplica es una copia permanente: un bot de
  polling solo admite 1. Un bot en modo webhook necesita dominio y puerto; si un bot con dominio
  hace polling, fija `"deployStrategy":"recreate"`.
- **D**: **no hay un tipo de servicio estático**. Se despliega un Dockerfile con un servidor HTTP
  (nginx, Caddy o Node) que sirve los ficheros.
- **F**: **no está soportado**. `deploy.cronSchedule` solo se anota en el registro. Alternativa: un
  worker (C) con un planificador interno y 1 réplica.
- **G**: `{"type":"image","name":"worker","image":"nombre:tag","port":8080}`. Un dominio exige
  puerto (400 si falta).
- **H**: un `docker-compose.yml` **no se despliega** como un servicio. Crea un servicio por
  componente o usa una pila (`GET /api/stacks`: Supabase, WordPress, Ghost, n8n, Metabase).

## 4. Cómo construye y arranca Skyway

### 4.1 Orden de un despliegue de repositorio

1. **Reutilización**: si la cabeza de la rama ya se construyó con éxito con la misma huella (repo,
   `rootDir`, Dockerfile, `buildCmd`, `builder`, `startCmd`, `buildArgs`, variables de compilación),
   se reutiliza la imagen. `POST /api/services/:id/deploy {"force":true}` compila de nuevo.
2. **Clonado**: `git clone --depth 1 --branch <rama> --single-branch --no-tags`, hasta 5 min. Los
   submódulos de git no se clonan.
3. **Lectura del repositorio**: importación del `.env` (§5.4), `railway.json` o `railway.toml`
   (primero en `rootDir`, después en la raíz; §4.3), dependencias y `skyway.json` (§6, §7).
4. **Construcción** (§4.2), hasta 45 min. Contexto: `rootDir` (o la raíz).
5. **Comando previo** (`deploy.preDeployCommand`), hasta 30 min.
6. **Arranque y validación** según la estrategia (§4.5).
7. Se conservan las imágenes de las 5 últimas versiones correctas para
   `POST /api/deployments/:id/rollback`.

### 4.2 Constructor y comando de arranque

| Prioridad | Constructor según |
| --- | --- |
| 1 | `config.builder` del servicio: `dockerfile` o `nixpacks` (`auto` = sin elección) |
| 2 | `build.builder` del repo: `DOCKERFILE` (exige Dockerfile), `NIXPACKS`, `RAILPACK` (se construye con Nixpacks; `railpack.json` no se lee). Si el último despliegue correcto usó el Dockerfile y el fichero pide Nixpacks, se mantiene el Dockerfile |
| 3 | Dockerfile si existe; si no, Nixpacks |

- Ruta del Dockerfile: variable `RAILWAY_DOCKERFILE_PATH` > `build.dockerfilePath` >
  `config.dockerfilePath` > `Dockerfile`. Relativa a `rootDir`; no puede salir del repositorio.
- Comando de compilación (solo Nixpacks): `build.buildCommand` > `config.buildCmd`, entregado como
  `NIXPACKS_BUILD_CMD`.
- Comando de arranque: `deploy.startCommand` > `config.startCmd` > `CMD` o `ENTRYPOINT` de la imagen
  (o el que infiere Nixpacks).
- Un comando de arranque explícito se ejecuta con `sh -c` (la imagen necesita `sh`); un `ENTRYPOINT`
  que no es un shell se sustituye. Si es una sola orden, empiézala con `exec`. Sin comando
  explícito, usa la forma exec del Dockerfile: `CMD ["node", "server.js"]`.

### 4.3 Claves de `railway.json` / `railway.toml`

JSON o un subconjunto de TOML (tablas `[build]` y `[deploy]`). Mandan sobre los ajustes del panel.

| Clave | Efecto |
| --- | --- |
| `build.builder`, `build.dockerfilePath`, `build.buildCommand` | ver §4.2 |
| `deploy.startCommand` | comando de arranque |
| `deploy.preDeployCommand` | texto o lista (se une con espacios). Corre con la imagen nueva y sus variables, en la red del proyecto, antes de tocar la versión en marcha; si falla o pasa de 30 min, se aborta. No existe como ajuste del panel |
| `deploy.healthcheckPath` | ruta de validación; manda sobre `config.healthcheckPath` |
| `deploy.healthcheckTimeout` | segundos, 5–900 (def. 300). También la variable `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` |
| `deploy.restartPolicyType` | `NEVER`→`no`, `ON_FAILURE`→`on-failure`, `ALWAYS`→`unless-stopped`. Sin clave: `unless-stopped` |
| `deploy.restartPolicyMaxRetries` | reintentos de `on-failure` (máx. 100) |
| `deploy.numReplicas` | **no se aplica**: se usa `config.replicas` |
| `deploy.cronSchedule` | **no se aplica** |
| `deploy.drainingSeconds`, `deploy.overlapSeconds` | **no se aplican** (solo se anotan) |
| `build.watchPatterns` | **no se aplica**: cualquier push a la rama despliega |
| `environments.*` | **no se aplica**: solo se lee el nivel raíz |

### 4.4 Puerto

- Puerto interno: `config.port` (3000 por defecto en un servicio de repositorio). Traefik enruta el
  dominio a ese puerto.
- Skyway pone `PORT=<puerto interno>` salvo que definas `PORT`. No la definas: cambia el puerto
  interno.
- Escucha en `0.0.0.0`: la sonda y Traefik llegan por la red de Docker.
- Sin `port` en el alta, el primer despliegue adopta el `EXPOSE` de la imagen si expone uno solo.
  Después no cambia solo: un desajuste solo da un aviso.

### 4.5 Validación, estrategia y parada

| Situación | Comprobación de la versión nueva | Plazo |
| --- | --- | --- |
| Con ruta de healthcheck | `GET http://<slug>:<puerto><ruta>` desde la red del proyecto; 2xx | 300 s (5–900) |
| Sin ruta, con dominio o `hostPort` | el puerto interno acepta TCP y el proceso sigue vivo 5 s | 300 s |
| Sin ruta y sin tráfico | el proceso sigue vivo 5 s | 5 s (90 s si `restartPolicyType` reintenta) |

La ruta de healthcheck solo se consulta al desplegar. Si la imagen declara `HEALTHCHECK`, Traefik no
envía tráfico a la copia hasta que está `healthy`.

Estrategia (`config.deployStrategy`: `auto`, `overlap`, `recreate`), por orden: 1) base de datos →
una sola copia; 2) volúmenes o `hostPort` → una sola copia (fijo); 3) la elegida; 4) bot de Telegram
o Discord sin dominio → una sola copia; 5) sin dominio, sin healthcheck y sin referencias de otros
servicios → una sola copia; en otro caso, sin corte. `GET /api/services/:id` → `deploy` da la
efectiva y su motivo.

- **Sin corte** (`overlap`): la copia `<servicio>--next` arranca con `SKYWAY_VALIDATION=1` mientras
  la anterior atiende. Úsala para no registrar webhooks ni consumir trabajos durante la validación.
- **Una sola copia** (`recreate`): se detiene la anterior y arranca la nueva; si la nueva falla, se
  restaura la anterior.
- **Parada**: `config.stopCommand` (opcional) → `SIGTERM` → gracia → `SIGKILL`. Gracia:
  `config.stopGraceSeconds` (0–600) o `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`; por defecto, 30 s. Las
  aplicaciones se ejecutan con el init de Docker como PID 1, que entrega `SIGTERM` a la aplicación:
  sin manejador, termina al momento; con manejador (`process.on('SIGTERM', …)` en Node;
  `signal.signal(...)` o `loop.add_signal_handler(...)` en Python), tiene que cerrar y salir. Una
  imagen con su propio proceso de inicio (s6-overlay, systemd, tini, dumb-init) se ejecuta sin el de
  Docker.

### 4.6 Volúmenes, réplicas y recursos

- Volumen: `PATCH /api/services/:id {"config":{"volumes":[{"containerPath":"/data"}]}}` (ruta
  absoluta). El primero se publica en `RAILWAY_VOLUME_MOUNT_PATH`. Con volúmenes: una sola copia y 1
  réplica (400 si no).
- Las rutas `VOLUME` de la imagen sin volumen se vacían en cada despliegue.
- `config.replicas`: 1–10, sin volúmenes ni `hostPort`. Cada copia recibe `SKYWAY_REPLICA` (1…N) y
  `SKYWAY_REPLICAS`.
- `config.cpus` y `config.memoryMb` se aplican en caliente.

## 5. Variables

### 5.1 Variables que pone Skyway

| Variable | Valor | Cuándo |
| --- | --- | --- |
| `PORT` | puerto interno | si no la defines |
| `INTERNAL_HOST` | slug del servicio (nombre DNS en la red del proyecto) | siempre |
| `INTERNAL_PORT`, `INTERNAL_URL` | puerto interno; `http://<slug>:<puerto>` | con puerto (sin `INTERNAL_URL` en bases) |
| `PUBLIC_DOMAIN`, `PUBLIC_URL` | dominio principal (§8); `https://<dominio>` (`http://` sin Let's Encrypt) | con dominio |
| `SKYWAY_PROJECT`, `SKYWAY_SERVICE`, `SKYWAY_DEPLOYMENT` | slugs e id del despliegue | siempre |
| `SKYWAY_INSTANCE_ID`, `SKYWAY_REPLICA`, `SKYWAY_REPLICAS` | UUID por contenedor; índice y total de réplicas | siempre |
| `SKYWAY_VALIDATION` | `1` | solo en la copia `--next` |
| `RAILWAY_*` | equivalentes de Railway (`RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_PRIVATE_DOMAIN`, `RAILWAY_GIT_COMMIT_SHA`…) | si no las defines |

Una variable guardada con el mismo nombre gana a `PORT`, `INTERNAL_*`, `PUBLIC_*` y `RAILWAY_*`;
las `SKYWAY_*` de esta tabla las pone Skyway siempre y no se pueden sustituir. Skyway **no** fija
`NODE_ENV`, `HOST` ni `TZ`: defínelas si la aplicación las necesita.

### 5.2 Referencias y variables compartidas

- `${{<servicio>.VAR}}`: nombre del servicio (sin distinguir mayúsculas) o slug. Vale para variables
  guardadas y de sistema (`${{web.PUBLIC_URL}}`).
- `${{shared.VAR}}` (alias `project`, `proyecto`): variable compartida.
- Las compartidas (`PATCH /api/projects/:id/vars {"set":{…},"unset":[…]}`) llegan a **todos** los
  servicios, bases de datos incluidas. La del servicio gana a la compartida.
- Se resuelven al desplegar, hasta 5 niveles. Una referencia que no resuelve queda como texto
  literal y el registro lo avisa: crea antes el servicio.

### 5.3 Nombres, valores y secretos

- Nombre válido: `^[A-Za-z_][A-Za-z0-9_]*$` (400 `invalid_key` si no). El panel escribe en
  mayúsculas los nombres **nuevos** y respeta los existentes; la API guarda el nombre tal cual. Usa
  mayúsculas.
- Los valores llegan al contenedor por la API de Docker, sin shell: un `$` se escribe tal cual.
- `PATCH /api/services/:id/env {"set":{…},"unset":[…]}` aplica solo cambios; `PUT` reemplaza la
  lista entera.
- Variables de compilación. Con Dockerfile: las del servicio declaradas con `ARG` y
  `config.buildArgs` (quedan en `docker history`: nunca un secreto). Con Nixpacks: las de prefijo
  `NIXPACKS_`, `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`, `GATSBY_`, `EXPO_PUBLIC_`,
  `ASTRO_PUBLIC_`, `VUE_APP_`, `PUBLIC_`, más `NODE_ENV`, `BUN_ENV` y `config.buildArgs`. Cambiar
  una de ellas obliga a compilar de nuevo.

### 5.4 Importación del `.env` del repositorio

En cada despliegue (salvo `config.autoImportEnv: false`) se leen `.env.example`, `.env.sample`,
`.env.template`, `.env.dist`, `.env.defaults`, `example.env` y `.env` (el último manda), en la raíz
y en `rootDir`.

| Caso | Resultado |
| --- | --- |
| Clave ya definida (servicio o compartida) | se respeta; nunca se sobrescribe |
| `PORT` o `RAILWAY_*` | se ignora (reservada) |
| Valor vacío o de ejemplo (`changeme`, `<…>`, `your-…`, `tu-…`/`tu_…`, `xxx`, `TODO`, contiene `example`, `replace`, `insert`, `aquí`/`…_aqui`, `pon_…`, `rellenar`, `cambiame`…) | queda **pendiente**, con aviso en el panel |
| Valor con `localhost`, `127.0.0.1` o `0.0.0.0` | se ignora |
| Valor útil | se importa |

Un `.env` confirmado en git publica sus valores en el panel: no lo confirmes. `HOST=0.0.0.0` del
`.env.example` no se importa: fija la dirección de escucha en el código o con `ENV` en el
Dockerfile.

## 6. Bases de datos

`POST /api/projects/:id/services {"type":"database","template":"<plantilla>","name":"<nombre>"}`.
Usuario, contraseña y variables se generan solos; el volumen es persistente. El slug sale del
nombre: `"name":"postgres"` → host `postgres`.

| Plantilla | Imagen (versión def.) | Puerto | Variable para conectar | Otras variables |
| --- | --- | --- | --- | --- |
| `postgres` | `postgres` (`16-alpine`) | 5432 | `DATABASE_URL` | `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| `postgres` + `"extensions":["vector"]` | `pgvector/pgvector` (`pg16-trixie`, Debian) | 5432 | `DATABASE_URL` | Las mismas. `version` es la mayor (`"16"`, 13–18) |
| `redis` | `redis` (`7-alpine`) | 6379 | `REDIS_URL` | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` |
| `mysql` | `mysql` (`8`) | 3306 | `MYSQL_URL` | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_ROOT_PASSWORD` |
| `mongo` | `mongo` (`7`) | 27017 | `MONGO_URL` (sin nombre de base) | `MONGO_HOST`, `MONGO_PORT`, `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD` |
| `minio` | `minio/minio` (`latest`) | 9000 | `MINIO_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | `MINIO_CONSOLE` (9001). Los buckets los crea la aplicación |

En la aplicación, referencia con el nombre que espera el código:
`DATABASE_URL=${{postgres.DATABASE_URL}}`, `REDIS_URL=${{redis.REDIS_URL}}`,
`DB_HOST=${{postgres.PGHOST}}`, `S3_ACCESS_KEY=${{minio.MINIO_ROOT_USER}}`.

**Detección.** Al clonar se leen `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`,
`Gemfile`, `composer.json`, `prisma/schema.prisma`, `docker-compose.yml` y `.env.example` (en
`rootDir` y en la raíz). `GET /api/services/:id/env` devuelve `suggestions` (referencia propuesta, o
`value: null` si la base no existe), `missing` (esperadas sin propuesta) y `repoPending` (pendientes
del `.env`). Nada se escribe solo. `DATABASE_URL` sin otra pista se asume PostgreSQL.

**pgvector.** Para `CREATE EXTENSION vector` y columnas `vector(N)`, crea la base con
`{"type":"database","template":"postgres","extensions":["vector"]}` (opcional `"version":"17"`). La
extensión la crea la aplicación con su `CREATE EXTENSION`. Se elige al crear o en Ajustes, pero
**solo sin datos**: activarla o quitarla cambia de alpine (musl) a Debian (glibc), que ordenan el texto
de otra forma, y con un despliegue correcto previo el PATCH responde 409 (el despliegue también lo
comprueba con el volumen). Con datos: crea una base nueva con pgvector y copia los datos con «Copiar
datos» (§5.6 de FUNCIONALIDAD.md). La detección propone pgvector si el repositorio usa `pgvector`
(npm, PyPI, gem, Composer), `pgvector-go` o la imagen `pgvector/pgvector` en el compose.

Cambiar la versión mayor de PostgreSQL con datos no funciona: usa copia de seguridad y restauración.
Volver a desplegar una base la detiene unos segundos.

## 7. Manifiesto `skyway.json`

Opcional. Declara las bases, el correo y las variables de una web con sus nombres exactos. Formato
completo: [MANIFIESTO.md](MANIFIESTO.md).

```json
{
  "version": 1,
  "integrations": { "postgres": {} },
  "env": {
    "DATABASE_URL": { "from": "postgres.url" },
    "SESSION_SECRET": { "generate": { "bytes": 32 } },
    "APP_URL": { "from": "self.public_url" },
    "APP_NAME": { "value": "Mi tienda" }
  }
}
```

- En la raíz del repositorio o de `rootDir` (este manda). Máximo 64 KB y 100 variables.
- Esquema estricto: una clave desconocida (por ejemplo `$schema`) invalida el manifiesto entero, y
  uno no válido no aplica nada.
- `integrations`: solo `postgres`, `redis` y `mail`. `postgres.extensions`: `["vector"]` (pgvector),
  único valor admitido; el plan crea la base con pgvector y no conecta en silencio una del proyecto
  que no lo tenga (queda `blocked` con el motivo).
- `from`: `postgres.url`, `redis.url`, `self.public_url` o `mail.<papel>` (papeles en
  MANIFIESTO.md). `generate.bytes`: 16–64 (def. 32), hexadecimal, nunca se regenera. `value`: texto
  no secreto, hasta 1000 caracteres, sin `${{…}}`.
- Prohibidas: `PORT` y cualquier `SKYWAY_*`.
- Lo inofensivo (secretos generados, URL propia, literales) se aplica solo. Lo privilegiado (crear o
  conectar una base, el correo) exige aprobación con la huella del plan: `expect` =
  `plan.fingerprint` (§9).

## 8. Dominios y TLS

- Alta con `domains`, o
  `PATCH /api/services/:id {"config":{"domains":[…]},"domainsBase":[<dominios actuales>]}`.
- DNS: registro `A` hacia la IP de `GET /api/domains/server-ip`. Comprobación:
  `POST /api/domains/check {"domain":"…"}` → `status` (`ok`, `wrong_ip`, `no_record`, `caa`,
  `cloudflare_proxy`, `cloudflare_flexible`, `unknown`).
- TLS: Let's Encrypt vía Traefik si el administrador lo ha configurado (`GET /api/domains/config` →
  `tls`). Con TLS, HTTP redirige a HTTPS.
- `ejemplo.com` se guarda con `www.ejemplo.com` y al revés; para evitarlo, `dominiosSinPareja`.
- Dominio principal (`PUBLIC_URL`): primero un dominio propio con `www.`; después los propios en
  orden; el subdominio generado (`<slug>.<dominio raíz>`) al final. El subdominio generado no se
  añade solo.
- Un dominio solo puede estar en un servicio del servidor (409 si no).
- En el código, usa `PUBLIC_URL` o `${{<servicio>.PUBLIC_URL}}`, nunca el dominio escrito a mano.
  Cambiar dominios exige volver a desplegar.
- Con el proxy de Cloudflare, modo SSL/TLS «Completo (estricto)»: «Flexible» produce un bucle de
  redirecciones.

## 9. Desplegar por API

Token: «Mi perfil → Tokens de API» (`sky_…`, se muestra una vez). Hereda los permisos de su usuario
y no puede crear otros tokens. Más ejemplos en [CONTROL-REMOTO.md](CONTROL-REMOTO.md).

```bash
BASE="https://panel.example.com"; TOKEN="sky_..."
AUTH=(-H "Authorization: Bearer $TOKEN"); JSON=(-H "Content-Type: application/json")

# 1. Acceso y proyecto (crear: administrador o propietario; un miembro recibe 403)
curl -s "$BASE/api/health"
curl -s "${AUTH[@]}" "$BASE/api/projects" | jq '.projects[] | {id, name, services}'
PROJ=$(curl -s "${AUTH[@]}" "${JSON[@]}" -d '{"name":"tienda"}' "$BASE/api/projects" | jq -r .project.id)

# 2. Repos privados: id de fila de la instalación de la GitHub App
curl -s "${AUTH[@]}" "$BASE/api/projects/$PROJ/github/installations"
curl -s "${AUTH[@]}" "$BASE/api/github/installations/GHI_ID/repos/lookup?repo=owner/repo&projectId=$PROJ"

# 3. Opcional: dependencias y plan del skyway.json, sin efectos
FP=$(curl -s "${AUTH[@]}" \
  "$BASE/api/projects/$PROJ/github/needs?repo=owner/repo&branch=main&source=app:GHI_ID" | jq -r .plan.fingerprint)

# 4. Base de datos (antes que la aplicación que la referencia).
#    Con pgvector: añade "extensions":["vector"] (§6)
curl -s "${AUTH[@]}" "${JSON[@]}" -d '{"type":"database","template":"postgres","name":"postgres"}' \
  "$BASE/api/projects/$PROJ/services" | jq -r .service.id

# 5. Servicio de repositorio: nace con variables y lanza el primer despliegue (201).
#    Con skyway.json, añade "plan": {"expect": "<FP>"}.
RESP=$(curl -s "${AUTH[@]}" "${JSON[@]}" -d '{
  "type": "git", "name": "api", "repoUrl": "owner/repo", "branch": "main",
  "githubInstallationId": "GHI_ID", "port": 3000, "domains": ["api.example.com"],
  "env": { "DATABASE_URL": "${{postgres.DATABASE_URL}}", "NODE_ENV": "production" }
}' "$BASE/api/projects/$PROJ/services")
SVC=$(jq -r .service.id <<<"$RESP"); DEP=$(jq -r .deployment.id <<<"$RESP")

# 6. Seguir el despliegue: SSE (eventos snapshot, log, status, done) o sondeo.
#    status: queued | building | deploying | success | failed | canceled
#    diagnosis: texto JSON con id, title, cause y fix (§12)
curl -sN "${AUTH[@]}" "$BASE/api/deployments/$DEP/logs/stream"
curl -s "${AUTH[@]}" "$BASE/api/deployments/$DEP" | jq '.deployment | {status, error, diagnosis}'

# 7. Ajustes que el alta no admite (healthcheck, volúmenes, réplicas, estrategia, recursos)
curl -s -X PATCH "${AUTH[@]}" "${JSON[@]}" -d '{"config":{"healthcheckPath":"/health","memoryMb":512}}' \
  "$BASE/api/services/$SVC" | jq .needsRedeploy

# 8. Variables (solo cambios) y nuevo despliegue (202)
curl -s -X PATCH "${AUTH[@]}" "${JSON[@]}" -d '{"set":{"LOG_LEVEL":"info"},"unset":["DEBUG"]}' \
  "$BASE/api/services/$SVC/env"
DEP=$(curl -s -X POST "${AUTH[@]}" "$BASE/api/services/$SVC/deploy" | jq -r .deployment.id)

# 9. Estado y diagnóstico
curl -s "${AUTH[@]}" "$BASE/api/services/$SVC" | jq '{runtime, pendingChanges, deploy, last: .latestDeployment.status}'
curl -s "${AUTH[@]}" "$BASE/api/services/$SVC/env" | jq '{missing, suggestions, repoPending}'
curl -s "${AUTH[@]}" "$BASE/api/services/$SVC/logs/tail?limit=200"
curl -s "${AUTH[@]}" "$BASE/api/help/issues?serviceId=$SVC" | jq .issues
```

- `PATCH /api/services/:id` y las variables **no despliegan**: devuelven `needsRedeploy`; después,
  `POST …/deploy`.
- Volver atrás: `POST /api/deployments/:id/rollback`. Si responde 409 `image_purged`:
  `POST /api/services/:id/deploy {"commit":"<SHA de 40>"}`.
- Borrar exige `?confirm=<nombre o slug>` y borra los datos: pide antes confirmación a una persona.
- CLI equivalente (`scripts/skyway`): `skyway deploy api -f`, `skyway status api`.

Despliegue automático por push, activo por defecto (`config.autoDeploy: false` lo desactiva):
webhook de la GitHub App (sin configuración); webhook por servicio
`POST /api/webhooks/github/:serviceId` (evento `push`, cuerpo JSON, HMAC con
`service.config.webhookSecret`; URL en `GET /api/services/:id` → `webhook.url`); y sondeo de la rama
cada ~1 min.

## 10. Plantillas listas para copiar

### 10.1 Web Next.js (salida standalone)

`next.config.mjs`: `export default { output: "standalone" };`

`app/api/health/route.ts`:
`export const dynamic = "force-dynamic"; export const GET = () => Response.json({ ok: true });`

`Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Skyway solo pasa al build las variables declaradas con ARG. Solo valores públicos.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine
WORKDIR /app
# HOSTNAME=0.0.0.0: el servidor standalone escucha en todas las interfaces.
# PORT no: la pone Skyway con el puerto interno del servicio (§4.4).
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

`railway.json`: `{"build":{"builder":"DOCKERFILE"},"deploy":{"healthcheckPath":"/api/health"}}`

Servicio: `type: git`, `port: 3000`, `domains: ["www.example.com"]`. Variable:
`NEXT_PUBLIC_SITE_URL=${{web.PUBLIC_URL}}` (`web` = nombre del servicio). Sin carpeta `public`,
quita esa línea `COPY`.

### 10.2 Bot de Discord en Python

`requirements.txt`: `discord.py>=2.3`

`bot.py`:
```python
import asyncio
import os
import signal

import discord

client = discord.Client(intents=discord.Intents.default())

@client.event
async def on_ready() -> None:
    print(f"Conectado como {client.user}", flush=True)

async def main() -> None:
    loop = asyncio.get_running_loop()
    # Cierre ordenado al recibir SIGTERM (Detener, Reiniciar, despliegues): sin él, termina de golpe.
    loop.add_signal_handler(signal.SIGTERM, lambda: asyncio.ensure_future(client.close()))
    async with client:
        await client.start(os.environ["DISCORD_TOKEN"])

asyncio.run(main())
```

`Dockerfile`:
```dockerfile
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["python", "bot.py"]
```

`railway.json` (reintentos si el arranque falla de forma transitoria):
`{"build":{"builder":"DOCKERFILE"},"deploy":{"restartPolicyType":"ON_FAILURE","restartPolicyMaxRetries":10}}`

Servicio: `type: git`, sin `domains`, sin healthcheck, `replicas: 1`. Variable: `DISCORD_TOKEN`.
Estrategia esperada en `GET /api/services/:id` → `deploy`: `recreate`, motivo `bot`.

### 10.3 API Node con PostgreSQL

`package.json` (extracto): `"type": "module"`, scripts `"start": "node server.js"` y
`"migrate": "node-pg-migrate up"`, dependencias `pg` y `node-pg-migrate`. La herramienta de
migraciones va en `dependencies`: la imagen se instala sin las de desarrollo. Sustitúyela por la del
proyecto si usa otra.

`server.js`:
```js
import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const server = http.createServer(async (req, res) => {
  if (req.url !== "/health") return res.writeHead(404).end();
  // Comprueba también DATABASE_URL: sin base, la validación del despliegue falla.
  const ok = await pool.query("select 1").then(() => true, () => false);
  res.writeHead(ok ? 200 : 503).end(ok ? "ok" : "sin base de datos");
});

// 0.0.0.0: la sonda y Traefik llegan por la red de Docker, no por localhost.
server.listen(Number(process.env.PORT) || 3000, "0.0.0.0");

process.on("SIGTERM", () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
});
```

`Dockerfile`:
```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

`railway.json`:
`{"build":{"builder":"DOCKERFILE"},"deploy":{"preDeployCommand":"npm run migrate","healthcheckPath":"/health"}}`

Variables: crea antes la base `postgres` y define `DATABASE_URL=${{postgres.DATABASE_URL}}`, o
declara `"DATABASE_URL": {"from": "postgres.url"}` en `skyway.json` (§7).

## 11. Lista de comprobación antes de desplegar

- [ ] Hay `Dockerfile` (o se ha comprobado que Nixpacks construye el proyecto) y `railway.json` con
      `"builder"` explícito.
- [ ] `npm ci` (o equivalente) funciona con el lockfile confirmado.
- [ ] Si atiende HTTP, escucha en `0.0.0.0:$PORT`.
- [ ] El proceso no termina solo y, si atiende `SIGTERM`, el manejador cierra y sale.
- [ ] Web o API pública: `deploy.healthcheckPath` responde 2xx sin autenticación.
- [ ] Bot o worker: sin dominio, sin healthcheck, `replicas` = 1.
- [ ] Migraciones idempotentes en `deploy.preDeployCommand`.
- [ ] Ningún secreto en git, en `ARG` ni en `buildArgs`; ningún `.env` confirmado.
- [ ] El `.env.example` lista todas las variables, con valor vacío o de ejemplo.
- [ ] Conexiones como referencias `${{<servicio>.VAR}}`; la base existe antes que la aplicación.
- [ ] URLs propias con `PUBLIC_URL` o `${{<servicio>.PUBLIC_URL}}`.
- [ ] Variables públicas de compilación (`NEXT_PUBLIC_*`, `VITE_*`) declaradas con `ARG` si se
      construye con Dockerfile.
- [ ] Datos persistentes en un volumen (`config.volumes`).
- [ ] `skyway.json`, si existe, sin claves extra, sin `PORT` ni `SKYWAY_*`.
- [ ] Tras desplegar: `status` = `success`, `pendingChanges` = `false`, y `missing` y `repoPending`
      vacíos.

## 12. Errores frecuentes

Texto del registro de despliegue (o de la aplicación), causa y solución. El diagnóstico automático
(`deploy/diagnose.ts`) llega en `deployment.diagnosis`.

| Síntoma en el registro | Causa | Solución |
| --- | --- | --- |
| `invalid username or token`, `authentication failed`, `bad credentials` | credencial de GitHub caducada o revocada | reconectar la GitHub App o renovar el token del conector |
| `could not read username`, `terminal prompts disabled` | repositorio privado sin credencial | conectar la GitHub App (`githubInstallationId`) |
| `repository not found` | URL incorrecta o la credencial no ve el repo | revisar `repoUrl`; añadir el repo a la instalación |
| `remote branch … not found`, `couldn't find remote ref` | la rama no existe | corregir `config.branch` (`main` frente a `master`) |
| `El directorio raíz "…" no existe en el repositorio` | `rootDir` incorrecto | corregir `config.rootDir` |
| `No existe el Dockerfile indicado`, `Se solicita construir con Dockerfile (…), pero no existe ninguno` | ruta mal escrita (relativa a `rootDir`) o `DOCKERFILE` sin Dockerfile | corregir `dockerfilePath`, `build.dockerfilePath` o `RAILWAY_DOCKERFILE_PATH` |
| `No se encontró Dockerfile y Nixpacks no está instalado` | no hay constructor | añadir un Dockerfile |
| `dockerfile parse error`, `COPY failed`, `file not found in build context` | rutas de `COPY` fuera del contexto | las rutas son relativas a `rootDir` |
| `error TS…` | errores de tipos; a menudo una dependencia no declarada | `npm ci && npm run build` en limpio; declarar la dependencia |
| `npm ERR!`, `yarn error`, `pnpm ERR` | falla la instalación o el script de build | leer las últimas líneas; reproducir en local |
| `EBADENGINE`, `Unsupported engine` | versión de Node insuficiente | `engines.node` en `package.json` o `NIXPACKS_NODE_VERSION` |
| `no start command could be found`, `No lockfile found` | Nixpacks no detecta la aplicación | fijar `rootDir` o añadir un Dockerfile |
| `exit code 137`, `oom-kill`, `out of memory` | memoria agotada | subir `config.memoryMb` o reducir el consumo |
| `exec format error` | imagen de otra arquitectura | imagen base multiarquitectura |
| `exit code 127`, `executable file not found` | el comando de arranque no existe (o falta `sh`) | revisar `startCommand`/`startCmd`; vacío usa el `CMD` |
| `el proceso terminó enseguida (… código 0)` | el comando termina o deja la app en segundo plano | proceso en primer plano: `exec …` |
| `el proceso finalizó durante el arranque (código N)` | error al arrancar (variable ausente, conexión) | leer las líneas del contenedor fallido; `GET …/env` → `missing` |
| `el healthcheck /… no respondió 2xx en Ns` | ruta inexistente o con autenticación, puerto o dirección de escucha | ruta pública 2xx; `0.0.0.0:$PORT` |
| `el puerto interno N no aceptó conexiones en Ns`; dominio con 502 y despliegue correcto | la app escucha en otro puerto o en `localhost` | usar `PORT` y `0.0.0.0`, o corregir `config.port` |
| `⚠ La imagen declara EXPOSE X y el puerto interno del servicio es Y` | desajuste de puerto | corregir `config.port` |
| `La versión nueva no pasó la validación (…)` | alguno de los casos anteriores | la versión anterior sigue en servicio; corregir y volver a desplegar |
| `El comando previo al despliegue falló (…)` | la migración falló | revisar el comando y `DATABASE_URL`; la versión en marcha no cambió |
| `⚠ Referencias sin resolver en …` | servicio o variable referenciada inexistente | crear el servicio o corregir el nombre en `${{…}}` |
| `⚠ … no terminó con SIGTERM en N s y se detuvo con SIGKILL` | el manejador de `SIGTERM` no sale; o la copia se creó sin init | que el manejador cierre y llame a `exit`; volver a desplegar una vez |
| `409 Conflict: terminated by other getUpdates request` (aplicación) | dos copias del bot | `replicas: 1` y `deployStrategy: recreate` |
| `port is already allocated`, `address already in use` | `hostPort` ocupado | otro `hostPort` o usar un dominio |
| `pull access denied`, `manifest unknown`, `toomanyrequests` | imagen o tag inexistente; límite de Docker Hub | corregir la imagen o `version`; esperar |
| `database files are incompatible with server` | versión mayor de Postgres distinta de la del volumen | volver a la versión anterior o migrar con copia de seguridad |
| HTTP 403 `El módulo «…» no está activo` | módulo desactivado en el workspace | pedirlo al administrador |
| HTTP 409 al guardar dominios | el dominio ya está en otro servicio | usar otro dominio o liberarlo |

## 13. Opcional: integración con Skyway webtools

> **Opcional.** El código está en el repositorio **privado** `NkrowOne/skyway-tools` («Skyway
> webtools»): sin acceso de lectura no se puede integrar. Su documentación manda sobre este resumen:
> `README.md`, `docs/nueva-web.md`, `docs/acceso-maestro.md`, `docs/calendario.md`,
> `connect/README.md` y `kit/README.md`.

Dos piezas: **Skyway Connect** (`connect/`), servicio central en `conectar.skyway.es` con las
aplicaciones OAuth de Google y Microsoft y las cuentas maestras (las webs nunca ven sus secretos;
`GET /health` → `{"ok":true,"providers":{…},"master":true}`), y **el kit** (`kit/`), TypeScript sin
dependencias (Node 22, `node:crypto`) que se **copia** en cada web en `src/vendor/skyway-kit/`, con
un fichero `VERSION` (commit de origen).

| Módulo del kit | Para qué | Dónde (servidor = Node, nunca Edge) |
| --- | --- | --- |
| `broker` | firmar enlaces y peticiones a Connect, «Conectar con Google / Microsoft», caché de permisos | servidor |
| `master` | acceso maestro por Connect y acceso de emergencia (contraseña cifrada + TOTP); sesión `platform` de 8 h | servidor |
| `calendar` | Google Calendar y Microsoft Graph: eventos, ocupado, cambios, avisos, salas de Meet y Teams | servidor (`calendar/types`, también navegador) |
| `holidays` | festivos nacionales y autonómicos de España (BOE), con fuentes de reserva | servidor y navegador |
| `video` | una sala nueva por cita, nunca un enlace compartido | servidor y navegador |
| `secret-box` | cifrado de los permisos de calendario (AES-256-GCM, clave de `SESSION_SECRET`) | servidor |

**Cuándo añadirlo.** Webs con citas que se escriben en Google Calendar u Outlook (con Meet o Teams y
festivos), o webs con panel de administración en las que el soporte de Skyway debe poder entrar
(acceso maestro). No aplica a bots, workers ni APIs sin panel. La guía de integración es para
Next.js (App Router) con Prisma y PostgreSQL.

**Pasos.**

1. `siteId`: 3–64 caracteres, minúsculas, números y guiones. No se cambia después: cambiarlo cambia
   el secreto.
2. En el servidor de Connect: `docker exec skyway-connect node cli.js site-secret <siteId> --env` →
   `SKYWAY_CONNECT_URL`, `SKYWAY_SITE_ID` y `SKYWAY_SITE_SECRET`. El secreto se deriva de la clave
   maestra y del `siteId`: repetir la orden da el mismo.
3. Desde `skyway-tools`: `node scripts/sync-kit.mjs <ruta-de-la-web>`. Crea `src/vendor/skyway-kit/`
   y `VERSION`; se confirma en la web tal cual.
4. En la web: un fichero con `import "server-only"` que crea los clientes (`src/lib/skyway.ts`, con
   `brokerConfigFromEnv` y `breakGlassConfigFromEnv`); modelos de Prisma (papel `PLATFORM`,
   `Session.masterVia`, `AuditLog`, `SiteSetting`); rutas `GET /api/skyway/master`,
   `GET /api/skyway/master/callback` y `POST /api/skyway/master/emergency`; con citas, los campos y
   rutas del calendario (`docs/nueva-web.md`).
5. Variables en Skyway (tabla siguiente).
6. Comprobar: `node scripts/sync-kit.mjs <web> --check` dice que está al día; `VERSION` no es `dev`;
   el registro de la web no tiene líneas `[skyway] … desactivado`; `/health` de Connect da
   `"master": true`.

| Variable | Para qué | Obligatoria |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | dirección pública real, en https (vueltas de Connect) | sí |
| `SESSION_SECRET` | sesiones y `secret-box`; si cambia, hay que volver a conectar el calendario. Se puede generar con `skyway.json` (`generate`) | sí |
| `SKYWAY_CONNECT_URL`, `SKYWAY_SITE_ID`, `SKYWAY_SITE_SECRET` | Skyway Connect (paso 2) | para calendario y acceso maestro |
| `SKYWAY_MASTER_EMAIL`, `SKYWAY_MASTER_PASSWORD`, `SKYWAY_MASTER_TOTP` | acceso de emergencia: las tres o ninguna, propias de cada web (`node cli.js master-breakglass <siteId>` en `connect/`) | no (recomendado) |
| `CRON_SECRET` | tarea programada `POST /api/cron/run`, cada 15 min | con calendario |

**Notas propias de Skyway** (comprobadas en su código):

- Las `SKYWAY_*` no caben en `skyway.json` (el manifiesto las rechaza): se definen en Variables o
  con `PATCH /api/services/:id/env`.
- Si el `.env.example` de la web las nombra, la pestaña Variables las propone sin valor hasta que
  se definen (`repoPending`). Además, el kit avisa al arrancar: `Skyway Connect desactivado: …` o
  `Acceso de emergencia de Skyway desactivado: …`.
- No reutilices los nombres `SKYWAY_*` que pone Skyway (§5.1).
- El `$` de `SKYWAY_MASTER_PASSWORD` se escribe tal cual en Skyway (§5.3); solo se escapa en
  `docker-compose.yml` (`$$`) o en un `.env` de Next.js (`\$`).
- `NEXT_PUBLIC_SITE_URL` es de compilación: con Dockerfile, declárala con `ARG` (§10.1). Valor
  recomendado: `${{<servicio>.PUBLIC_URL}}`. Las URL de vuelta deben ser públicas y en https: el
  servicio necesita dominio con TLS.
- Skyway no ejecuta tareas programadas: un worker de larga duración o un planificador externo tiene
  que llamar a `POST /api/cron/run`. La documentación de `skyway-tools` no indica quién lo hace.

**Reglas.**

- Nunca se edita `src/vendor/skyway-kit/` en una web. Los cambios van en `kit/src/` de
  `skyway-tools` (`cd kit && npm test && npm run typecheck`), se confirman allí y se vuelven a
  copiar en cada web.
- `VERSION` = `dev` (copia sin commit o con cambios sin guardar): no se publica.
- Ningún secreto en los repositorios (ni en la web ni en `skyway-tools`): claves, contraseñas
  cifradas, secretos TOTP ni `.env`.
- El protocolo con Connect (firmas, rutas, acceso maestro v1) es uno solo: no se cambia en un lado
  sin cambiarlo a la vez en el otro (`connect/README.md` §9).
- Desplegar Skyway Connect en Skyway: `rootDir` = `connect`, puerto `8080`, una sola réplica (los
  vales viven en memoria).
