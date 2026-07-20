# 🚀 Skyway

**Tu propia plataforma de despliegue estilo [Railway](https://railway.app), corriendo en tu servidor dedicado.**

Despliega repositorios de GitHub y bases de datos (PostgreSQL, Redis, MySQL, MongoDB, MinIO) con una interfaz visual, red privada por proyecto, variables compartidas entre servicios, métricas en vivo y dominios con TLS automático — todo auto-alojado sobre Docker.

## Características

- **Importador de Railway** — migra tus proyectos existentes en minutos: un asistente lee tu cuenta por la API oficial de Railway y recrea servicios, variables (con sus referencias), dominios propios y volúmenes, además de generar los comandos exactos para copiar los datos de cada base de datos. Ver [Migrar desde Railway](#migrar-desde-railway).
- **Despliegue desde GitHub** — pega la URL del repo (o `usuario/repo`) y Skyway clona, construye y despliega. Usa el `Dockerfile` del repo o, si no hay, [Nixpacks](https://nixpacks.com) (el mismo builder que usa Railway). Repos privados con token.
- **Imágenes Docker** — despliega cualquier imagen pública (n8n, Plausible, Uptime Kuma...) como un servicio más, con dominio, volúmenes y límites.
- **Auto-deploy con webhooks** — cada `git push` a la rama configurada redespliega automáticamente (firma HMAC verificada).
- **Bases de datos en un clic** — PostgreSQL, Redis, MySQL, MongoDB y MinIO con credenciales generadas, volumen persistente y variables de conexión listas.
- **Proyectos con red privada** — los servicios de un proyecto comparten una red Docker y se resuelven entre sí por nombre (`postgres:5432`, `redis:6379`...), sin exponer nada al exterior.
- **Variables con referencias** — conecta servicios con `${{Postgres.DATABASE_URL}}`, igual que en Railway. Se resuelven al desplegar.
- **Gestión dinámica de recursos** — límites de CPU y RAM por servicio, aplicados **en caliente** sin reiniciar el contenedor. Métricas en vivo (CPU, memoria, red) por servicio y del host.
- **Dominios y TLS sin saber de DNS** — asistente estilo Railway: subdominio generado en un clic (con un comodín configurado una sola vez), o dominio propio con la tabla exacta de registros DNS a crear (tipo, nombre y la IP de tu servidor autodetectada) y **verificación en vivo** del DNS ("correcto ✓ / esperando propagación / apunta a otra IP"). Traefik enruta y, con Let's Encrypt, el certificado se emite solo.
- **Despliegues sin corte** — la versión nueva se arranca y se **valida** (healthcheck HTTP o periodo de gracia) antes de retirar la anterior. Sin volúmenes ni puertos fijos el intercambio es de **corte cero** (ambas conviven unos segundos tras el proxy); con estado, intercambio con **restauración automática**: si la nueva falla, la anterior vuelve sola. Un deploy roto ya no puede tumbar un servicio en producción.
- **Logs en tiempo real** — logs de build y de ejecución en streaming (SSE) y descargables, historial de despliegues, **cancelación** de despliegues en curso y **rollback** a cualquier versión anterior.
- **Monitor global** — una página con **todos los servicios del servidor**: estado en vivo, CPU, RAM, disco, reinicios y alertas, con filtros, reinicio en un clic y explicación del error cuando algo está caído. Incluye un **buscador de logs entre todos los contenedores**: escribe "ECONNREFUSED" o "500" y te dice en qué servicio y cuándo, con enlace directo.
- **Consola de consultas a las bases de datos** — pestaña **Consultas** en cada PostgreSQL, MySQL, MongoDB y Redis: explorador de tablas/colecciones/claves con tamaños, consultas con resultados en tabla, snippets típicos ("tablas más grandes", "conexiones activas"...), historial y **modo solo lectura por defecto** (las escrituras requieren activarlas a propósito). Todo corre dentro del contenedor con su cliente oficial: sin exponer puertos ni credenciales.
- **Asignación de espacio en disco** — cuota orientativa por servicio (MB) vigilada por el monitor: verás el uso real (volúmenes + escritura del contenedor) en el Monitor y una **alerta al superar la cuota**. Los logs json de cada contenedor rotan solos (10 MB × 3) para que no se coman el disco.
- **Página de estado para clientes** — activa en cada proyecto un **dashboard público con enlace compartible** (sin login): estado en vivo de los servicios, disponibilidad de los últimos 90 días con barras diarias, uptime 24 h/7 d/90 d e incidencias. El enlace se puede rotar si se filtra.
- **Vista de sitios web** — todas las webs y apps desplegadas en un solo sitio: dominio clicable con candado TLS, estado, réplicas, último deploy y acciones rápidas (abrir, desplegar, reiniciar), filtrables por cliente o dominio.
- **Backups de bases de datos** — volcado comprimido de PostgreSQL/MySQL/MongoDB en un clic o **programado (diario/semanal, ~04:00) con retención automática**; descarga, restauración y borrado desde el panel, y alerta si un backup programado falla.
- **Réplicas con balanceo** — varias copias de un servicio repartiéndose el tráfico (Traefik + DNS interno) con **actualización rodante** réplica a réplica: siempre queda alguna sirviendo. Monitorización y métricas agregadas por réplica.
- **Comandos en el contenedor** — terminal de un comando (`sh -c`) para migraciones y diagnóstico, con salida capturada y registro en auditoría.
- **Volúmenes persistentes** — monta rutas de datos en servicios de repo/imagen desde la UI; los nombres de volumen se conservan al editar para no perder datos.
- **Mantenimiento del servidor** — uso de disco del host y de Docker (imágenes, volúmenes, caché) y botón de liberar espacio que nunca toca volúmenes; aviso de seguridad si el disco se agota.
- **Errores explicados** — cuando un despliegue falla, Skyway diagnostica la causa (repo privado sin token, OOM, puerto ocupado, rama inexistente, build roto...) y te dice **qué pasó y cómo arreglarlo**, en español.
- **Alertas** — un monitor vigila caídas, bucles de reinicio, CPU/RAM sostenidas y despliegues fallidos, con recuperación automática. Notificaciones por **Discord, Telegram o webhook** (n8n, Zapier...), además de la campana del panel.
- **Panel de seguridad** — puntuación y hallazgos con explicación y solución (bases de datos expuestas, servicios sin límites, dominios sin TLS, intentos de login sospechosos), registro de auditoría de toda la actividad, cambio de contraseña y cierre de sesiones remoto. Login con límite de intentos por IP.
- **Multi-empresa** — asigna cada proyecto a una empresa/cliente y el panel los agrupa y filtra. **Variables compartidas por proyecto** (SMTP, claves S3, TZ...) heredadas por todos sus servicios y referenciables con `${{shared.VAR}}`.
- **Usuarios y roles** — crea usuarios **administradores** (control total del servidor) o **miembros** limitados a los workspaces de su cliente: solo ven y operan sus proyectos, sin ajustes del servidor, seguridad ni otros clientes. Alta, baja, cambio de rol y asignación de workspaces desde el panel.
- **Passkeys (WebAuthn)** — entra con huella, cara o llave de seguridad, sin contraseña y resistente a phishing. Varias passkeys por usuario, gestionadas desde «Mi cuenta».
- **Tokens de API** — control programático total (`Authorization: Bearer sky_…`) para automatizaciones, CI/CD o agentes como **Claude**; cada token hereda los permisos de su usuario, es revocable y queda auditado. Ver [docs/CONTROL-REMOTO.md](docs/CONTROL-REMOTO.md).
- **Ligero** — un solo binario Node + SQLite. Sin Kubernetes, sin dependencias pesadas: pensado para un único servidor dedicado.

## Requisitos

- Un servidor Linux con **Docker** (y `docker compose`).
- Puertos 80/443 libres si quieres usar dominios (Traefik), y el 4000 para la UI.
- Opcional: un dominio apuntando a la IP del servidor.

## Instalación rápida (producción)

```bash
git clone https://github.com/NkrowOne/Skyway.git
cd Skyway
cp .env.example .env      # opcional: configura SKYWAY_DOMAIN y LETSENCRYPT_EMAIL
docker compose up -d --build
```

Abre `http://IP-DEL-SERVIDOR:4000` (o `http://tu-dominio`) y crea la cuenta de administrador.

> El contenedor de Skyway monta `/var/run/docker.sock` para orquestar los contenedores de tus aplicaciones directamente sobre el Docker del host. Eso implica que quien tenga acceso a Skyway controla el Docker del servidor: usa una contraseña fuerte y, a ser posible, no expongas el puerto 4000 públicamente (usa el dominio con TLS o una VPN).

## Primeros pasos

1. **Crea un proyecto** — por ejemplo `mi-saas`. Cada proyecto tiene su red privada `skyway-mi-saas`.
2. **Añade una base de datos** — "Nuevo servicio → Base de datos → PostgreSQL". Se crea con credenciales generadas y variables (`DATABASE_URL`, `PGHOST`...) listas para referenciar.
3. **Despliega tu app** — "Nuevo servicio → Repositorio de GitHub". Indica la URL, rama y puerto interno. Verás el build en directo en la pestaña **Despliegues**.
4. **Conéctalos** — en la pestaña **Variables** de tu app añade:
   ```
   DATABASE_URL=${{PostgreSQL.DATABASE_URL}}
   ```
   y redespliega. La app llega a la base de datos por la red privada del proyecto.

   Para lo común de una empresa (SMTP, claves de API, `TZ`...), usa **Variables compartidas** del proyecto: se heredan en todos sus servicios (las del servicio ganan si repiten clave) y se referencian con `${{shared.VAR}}`.
5. **Ponle dominio** — en **Ajustes** del servicio añade `app.midominio.com` (con el DNS apuntando a tu servidor). Con email de Let's Encrypt configurado, TLS automático.
6. **Auto-deploy** — copia la URL y el secreto del webhook (Ajustes del servicio) en GitHub → Settings → Webhooks. Cada push despliega.
7. **Activa las notificaciones** — en Ajustes → Alertas configura Discord, Telegram o un webhook y pulsa "Enviar notificación de prueba". Si un servicio de un cliente se cae, te llega al momento con la explicación del código de salida.
8. **Revisa el panel de seguridad** (icono del escudo) — corrige los hallazgos hasta subir la nota: límites de recursos en todos los servicios, TLS activado, sin puertos de bases de datos expuestos.
9. **Vigila y depura desde el Monitor** (icono de actividad, o `g m`) — todos los servicios con su consumo y espacio; si algo falla, busca el texto del error en los logs de todos los contenedores a la vez.
10. **Comparte el estado con tu cliente** — en el proyecto, botón **Página de estado**: actívala y pásale el enlace. Verá disponibilidad e incidencias sin entrar al panel.

## Migrar desde Railway

1. Crea un **token de cuenta** en Railway (Account Settings → Tokens). No selecciones equipo si también quieres ver tus proyectos personales.
2. En Skyway: **Dashboard → Importar de Railway**, pega el token (se usa solo en memoria durante la importación, nunca se guarda) y elige proyecto y entorno.
3. Revisa la **vista previa**: qué servicio se convierte en qué (repo → servicio git, Postgres/Redis/MySQL/Mongo/MinIO → plantilla con credenciales nuevas, otras imágenes → servicio de imagen), con avisos de todo lo que conviene revisar.
4. Importa. Las bases de datos e imágenes se despliegan solas; los repos quedan listos para pulsar **Desplegar** (configura antes el token de GitHub si son privados).
5. **Copia los datos**: el informe (accesible después desde el banner del proyecto) incluye el comando exacto `pg_dump | psql` / `mysqldump | mysql` / `mongodump | mongorestore` para cada base de datos, usando el TCP proxy público de Railway y las credenciales nuevas. Ejecútalo en el servidor.
6. Apunta el **DNS** de tus dominios a la IP del servidor cuando quieras hacer el cambio, verifica, y pausa el proyecto en Railway.

Qué se traslada: servicios con su configuración (rama, directorio raíz, comando de arranque, puerto si estaba en `PORT`), variables por servicio **con referencias `${{Servicio.VAR}}` funcionando** (misma sintaxis), variables compartidas del entorno, dominios propios y volúmenes. Qué no: los dominios `*.up.railway.app` (genera los tuyos), el build command (Skyway construye con Dockerfile/Nixpacks) y los datos (un comando por base de datos, incluido en el informe).

## Desarrollo local

```bash
npm install
npm run dev        # servidor en :4000 (tsx watch) + web en :5173 (vite)
```

La UI de desarrollo (`http://localhost:5173`) proxya `/api` al servidor. Para producción: `npm run build && npm start` (el servidor sirve la web compilada en `:4000`).

## Arquitectura

```
┌─────────────────────────────── tu servidor ───────────────────────────────┐
│                                                                           │
│  ┌───────────┐     ┌──────────────────────────────────────────────┐       │
│  │  Traefik  │────▶│  skyway-edge (red compartida)                │       │
│  │  :80/:443 │     │   └─ contenedores con dominio                │       │
│  └───────────┘     └──────────────────────────────────────────────┘       │
│        ▲                                                                  │
│        │ labels     ┌──────────────────────────────────────────────┐      │
│  ┌───────────┐      │  skyway-<proyecto> (red privada por proyecto)│      │
│  │  Skyway   │─────▶│   ├─ app        (skyway-proy-app)            │      │
│  │  UI + API │ sock │   ├─ postgres   (skyway-proy-postgres)       │      │
│  │  :4000    │      │   └─ redis      (skyway-proy-redis)          │      │
│  └───────────┘      └──────────────────────────────────────────────┘      │
│    SQLite (/data)      volúmenes: skyway-<proyecto>-<servicio>-data       │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Servidor**: Node 20+ / TypeScript / Fastify. Estado en SQLite (`/data/skyway.db`). Habla con Docker vía `dockerode` + CLI (builds).
- **Pipeline de despliegue**: clone superficial → build (Dockerfile o Nixpacks) → recrear contenedor con env resuelto, límites de recursos, red y labels de Traefik → verificación → purga de imágenes antiguas (se conservan las 5 últimas por servicio para rollback).
- **Web**: React + Vite + Tailwind. Logs y métricas por SSE.
- **Un build concurrente por servicio**, máximo 2 builds globales en paralelo (configurable con `BUILD_CONCURRENCY`).

### Estructura del código

```
server/src/
  index.ts, app.ts        arranque y ensamblado de Fastify
  db.ts                   esquema y acceso SQLite (incl. histórico de uptime)
  auth.ts                 sesiones JWT (cookie httpOnly)
  templates.ts            plantillas de bases de datos
  variables.ts            resolución de ${{Servicio.VAR}}
  dbconsole.ts            consola de consultas (psql/mysql/mongosh/redis-cli vía exec)
  disk.ts                 uso de disco por servicio (volúmenes + contenedor)
  docker/                 contenedores, redes, stats, logs
  deploy/                 builder (git+docker/nixpacks), orquestador, cola
  routes/                 API REST + SSE + webhooks (+ monitor, websites, status público)
web/src/
  pages/                  Dashboard, Proyecto, Monitor, Sitios, Estado público...
  components/             canvas de servicios, drawer con pestañas, gráficas
```

## Configuración

| Variable (servidor)   | Por defecto | Descripción                                    |
| --------------------- | ----------- | ---------------------------------------------- |
| `PORT`                | `4000`      | Puerto de la UI/API                            |
| `DATA_DIR`            | `./data`    | SQLite, builds temporales                      |
| `JWT_SECRET`          | generado    | Secreto de sesiones (persiste en la BD si no)  |
| `BUILD_CONCURRENCY`   | `2`         | Builds simultáneos                             |
| `DOCKER_SOCK`         | socket std  | Ruta alternativa al socket de Docker           |

En **Ajustes** (UI): dominio raíz para subdominios generados, email de Let's Encrypt y token de GitHub para repos privados.

## ¿Y Kubernetes?

Kubernetes es un orquestador pensado para repartir contenedores entre **flotas de servidores**: decide en qué máquina corre cada cosa, mueve cargas cuando un nodo muere y escala horizontalmente. Ese es su valor — y en un **único servidor dedicado no aporta nada de eso**, pero sí cobra su peaje: cientos de MB de RAM para su propio plano de control (RAM que dejarían de tener tus aplicaciones) y una complejidad operativa enorme (pods, ingresses, PVCs, RBAC...).

Por eso Skyway usa Docker a pelo y, en su lugar, incorpora de forma nativa lo que de Kubernetes sí tiene sentido en una máquina: **despliegues validados sin corte con marcha atrás automática y healthchecks** (ver arriba). Si algún día pasas a 2-3 servidores o más, entonces sí: la capa de orquestación de Skyway está aislada en `server/src/docker/`, y se podría añadir un driver de Kubernetes (k3s) manteniendo el mismo panel. Hasta entonces, cada MB del servidor trabaja para tus proyectos.

## Notas y límites actuales

- Los servicios **con volúmenes o puerto de host fijo** (y las bases de datos) tienen un corte breve al redesplegar: no pueden convivir dos instancias escribiendo el mismo volumen. Aun así el intercambio valida la versión nueva y restaura la anterior si falla.
- La **cuota de disco por servicio es orientativa**: Docker no corta la escritura al llegar al límite (haría falta un driver de almacenamiento con cuotas). Skyway mide el uso real, lo muestra y alerta al superarla — suficiente para detectar a tiempo una base que crece o unos uploads desbocados.
- La rotación de logs (10 MB × 3 por contenedor) se aplica a los contenedores creados a partir de v0.10: los anteriores la adoptan en su próximo redespliegue.
- Las credenciales de una base de datos se fijan al crearla (viven en su volumen); cambiar las variables después no cambia la contraseña real.
- El rollback reutiliza imágenes construidas: solo funciona hacia despliegues que sigan entre los 5 conservados.
- `docker compose` incluye Traefik; si ya tienes un proxy propio, elimina ese servicio y publica los puertos que necesites.

## Hoja de ruta

- Cron jobs y comandos one-off (`skyway run`)
- Backups de volúmenes de aplicaciones (uploads, etc.)
- Plantillas de la comunidad (one-click apps)
- Incidencias manuales y avisos de mantenimiento en la página de estado
