# Auditoría de seguridad y backend — Skyway

Revisión completa del backend (autenticación, cifrado, base de datos, superficie
de ataque externa) y del flujo de despliegue, con las correcciones aplicadas y
las recomendaciones pendientes. Alcance: todo `server/src/`, el `Dockerfile` y el
`docker-compose.yml`.

**Veredicto general**: base sólida. El hashing de contraseñas, la gestión de
sesiones, el aislamiento por proyecto y el diseño de la consola/exec (sin
inyección de shell) están bien resueltos. Esta auditoría **corrigió** la falta de
cabeceras de seguridad, un vector de evasión del límite de fuerza bruta y dos
puntos de endurecimiento; el resto son riesgos aceptados por diseño o
recomendaciones a futuro.

---

## 1. Correcciones aplicadas

| # | Severidad | Área | Hallazgo | Corrección |
| --- | --- | --- | --- | --- |
| 1 | Media | Cabeceras HTTP | No se enviaba ninguna cabecera de seguridad: sin protección de *clickjacking*, sniffing ni CSP. El panel controla el Docker del host, así que enmarcarlo es peligroso. | `app.ts` añade `Content-Security-Policy` (mismo origen), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` restrictiva y `Strict-Transport-Security` sobre HTTPS. Verificado que no rompe la SPA (assets del mismo origen). |
| 2 | Media | Anti fuerza bruta | `trustProxy: true` confiaba en `X-Forwarded-For` de cualquier origen: un atacante podía rotar la IP aparente para evadir el límite de login (8/15 min) y envenenar la auditoría. | `config.trustProxy` confía por defecto **solo** en proxies de rango privado/loopback (Traefik, túnel SSH). Ajustable con `TRUST_PROXY`. Ahora un cliente en internet no puede falsear su IP. |
| 3 | Baja | Sesiones JWT | `jwt.verify` no fijaba el algoritmo (riesgo teórico de confusión de algoritmo). | Fijado `HS256` en firma (`signToken`) y verificación (`verifySession`). |
| 4 | Baja | Anti fuerza bruta / DoS | Al superar 5000 IPs/retos, `attempts.clear()` y `authChallenges.clear()` borraban de golpe **todos** los contadores: un atacante inundando desde muchas IPs reseteaba el bloqueo de las víctimas. | Expulsión de las entradas **más antiguas** en vez de `clear()` global (`auth.ts`, `routes/passkeys.ts`). |
| 5 | Media | Resiliencia de datos | Skyway hacía backups de las BBDD de los proyectos pero **no de su propia `skyway.db`** (usuarios, proyectos, variables, dominios, auditoría): una avería del disco perdía el panel entero. Tampoco se detectaba corrupción. | **Snapshot diario** del panel (~04:00, `VACUUM INTO`, consistente en caliente, retención 7, independiente de Docker) + creación manual, descarga y borrado desde Ajustes (solo admin, auditado); **`PRAGMA integrity_check` al arrancar** con alerta crítica y aviso de restauración si falla (`sysbackup.ts`, `scheduler.ts`, `index.ts`). |

Todas verificadas: `npm run typecheck` y `npm run build` en verde, y *smoke test*
del servidor confirmando las cabeceras y que las rutas nuevas exigen sesión.

---

## 2. Verificaciones (correcto — no requiere cambios)

- **Contraseñas cifradas**: `scrypt` (N=16384) con salt de 16 B, 64 B de salida y
  comparación en tiempo constante (`timingSafeEqual`). Formato `s2:salt:hash`.
  Nunca se guardan ni registran en claro. (`util.ts`)
- **Credenciales de BBDD**: generadas con `crypto.randomBytes` por servicio, viven
  en su volumen; se referencian con `${{Servicio.VAR}}`. (`templates.ts`)
- **Tokens de API**: se guardan **hasheados** (sha256); el valor claro solo se
  muestra al crearlos. Revocables, caducables y auditados. Crear tokens/passkeys
  exige sesión de navegador, no un token.
- **Inyección SQL**: todo el acceso a SQLite usa sentencias parametrizadas
  (`better-sqlite3`). No hay concatenación de entrada de usuario. (`db.ts`)
- **Inyección de shell**: la consola de BBDD, el `exec` y el explorador de
  archivos pasan la entrada como **variable de entorno del exec**, nunca
  interpolada en `sh -c`. La consola aplica solo-lectura también en el motor
  (statement_timeout, transacción de solo lectura). (`dbconsole.ts`, `files.ts`)
- **Path traversal**: descargas de backups y rutas de archivos se validan (regex
  `SAFE_FILE` / `normalizePath` que colapsa `..`). (`backups.ts`, `files.ts`)
- **Webhooks**: firma **HMAC-SHA256** verificada en tiempo constante sobre el
  cuerpo crudo; sin firma válida, 401. (`routes/webhooks.ts`)
- **Aislamiento multi-empresa**: `assertProjectAccess` es consistente en las rutas
  de proyecto/servicio; alertas, monitor y búsqueda de logs se filtran por los
  workspaces del usuario. (`auth.ts` y rutas)
- **Enmascarado de secretos**: el token de GitHub se enmascara en los logs de
  build; los ajustes con secretos (GitHub/Telegram) se exponen como booleanos.
- **Superficie de red**: el `docker-compose` publica la UI solo en
  `127.0.0.1:4000`; el acceso público va por dominio+TLS a través de Traefik.

---

## 3. Riesgos aceptados por diseño

Estos no son defectos, sino consecuencias del propósito de la herramienta
(paridad con Railway). Se documentan para que sean decisiones conscientes.

- **Control del Docker del host**: montar `/var/run/docker.sock` implica que quien
  entra en Skyway controla todos los contenedores del servidor. Mitigado por bind
  local + TLS/VPN, contraseña fuerte y auditoría. Es el modelo esperado de un PaaS
  auto-alojado.
- **`exec` y consola de BBDD**: permiten ejecutar comandos y SQL arbitrarios en los
  contenedores del workspace del usuario. Es una función deliberada (migraciones,
  diagnóstico); autenticada, con acceso al workspace y auditada.
- **Secretos visibles para miembros**: un miembro con acceso a un workspace ve el
  `env` resuelto (con contraseñas) de sus servicios, igual que en Railway.

---

## 4. Recomendaciones (endurecimiento futuro, sin urgencia)

- **Informe de importación de Railway**: guarda en `settings` los comandos de copia
  de datos con contraseñas locales/origen embebidas, accesibles a los miembros del
  proyecto. Recomendación: **borrar el informe tras usarlo** (ya existe
  `DELETE /api/projects/:id/import-report`) o cifrar/omitir las contraseñas en el
  comando mostrado.
- **Parámetros de scrypt**: N=16384 es correcto pero por debajo del mínimo que
  recomienda OWASP hoy (2¹⁷). No se sube ahora porque el formato `s2:` no versiona
  N y rompería los hashes existentes. Recomendación: introducir un prefijo `s3:`
  con N mayor, verificando ambos y re-hasheando al iniciar sesión.
- **CSRF**: mitigado por `SameSite=Lax` y la ausencia de mutaciones por GET. Como
  defensa en profundidad podría añadirse una comprobación de `Origin` en las rutas
  mutantes con cookie.
- **SSRF de administrador**: las URLs de webhook/Discord y la verificación DNS/IP
  las controla un admin o un usuario autenticado; el riesgo es bajo. Si se quiere,
  restringir los destinos a rangos públicos.
- **Enumeración de usuarios por *timing***: el login hace scrypt solo si el usuario
  existe, lo que deja una diferencia de tiempo medible. Menor; podría igualarse
  con un hash señuelo.

---

## 5. Flujo de backend y paridad con Railway

Revisado y **correcto**. Notas de la verificación:

- **Pipeline de despliegue** (`deploy/`): cola **serializada por servicio** +
  semáforo global de builds; build con Dockerfile o Nixpacks (como Railway); swap
  **sin corte** con validación (healthcheck HTTP 2xx o periodo de gracia) y
  **restauración automática** de la versión anterior si la nueva falla; réplicas
  con actualización rodante; recuperación de swaps interrumpidos por caída del
  servidor; purga conservando las 5 últimas imágenes para rollback. Robusto.
- **Métricas** (SSE, `routes/streams.ts`): CPU/RAM/red por servicio agregando
  réplicas (la suma de límites de RAM evita porcentajes >100 %) y carga del host.
  Correcto.
- **Consola de consultas** (`dbconsole.ts`): psql/mysql/mongosh/redis-cli dentro
  del contenedor, con timeouts y solo-lectura reforzados en el propio motor, y
  parsers CSV/TSV/EJSON. Correcto.
- **Opciones de servicio (worker/módulo/db)**: puerto interno opcional (un `image`
  con `port: null` o un `git` sin HTTP funciona como **worker** en segundo plano,
  como en Railway), recursos CPU/RAM **en caliente**, réplicas con balanceo,
  volúmenes persistentes, healthcheck, cuota de disco orientativa y backups
  programados. Paridad confirmada.
- **Consola con gestor de archivos (tipo FTP)**: **añadido** en esta iteración —
  pestaña *Archivos* por servicio para navegar, descargar, subir, crear carpeta y
  borrar dentro de cada contenedor/módulo, **sin abrir FTP ni gestionar
  credenciales** (va por el socket de Docker con la sesión del panel). Ver
  `docs/FUNCIONALIDAD.md` §7.7.

---

## 6. Cómo reproducir las verificaciones

```bash
npm install
npm run typecheck     # server + web en verde
npm run build         # build de producción en verde

# Smoke test de cabeceras y auth:
DATA_DIR=/tmp/skyway PORT=4999 node server/dist/index.js &
curl -sD - http://127.0.0.1:4999/api/health -o /dev/null   # muestra CSP, X-Frame-Options…
curl -s  http://127.0.0.1:4999/api/auth/me                 # {"needsSetup":true,...}
curl -so /dev/null -w '%{http_code}\n' \
     http://127.0.0.1:4999/api/services/x/files            # 401 (exige sesión)
```
