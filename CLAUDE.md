# CLAUDE.md — guía del repositorio para agentes/LLM

Punto de entrada para navegar Skyway. Para el detalle completo (modelo de datos,
modelo de seguridad y **toda la API REST**), consulta
**[docs/FUNCIONALIDAD.md](docs/FUNCIONALIDAD.md)**. Para el estado de seguridad,
**[docs/AUDITORIA.md](docs/AUDITORIA.md)**. Para control remoto por API/agentes,
**[docs/CONTROL-REMOTO.md](docs/CONTROL-REMOTO.md)**.

## Qué es

Plataforma de despliegue auto-alojada estilo Railway: despliega repos de GitHub
y bases de datos (Postgres/Redis/MySQL/Mongo/MinIO) sobre Docker en un único
servidor, con panel web, métricas en vivo, dominios con TLS (Traefik + Let's
Encrypt), backups, alertas, multi-empresa y roles. Un binario Node + SQLite.

## Estructura

- `server/` — Node 20+/TypeScript/Fastify. Estado en SQLite. Orquesta Docker con
  `dockerode` + CLI. Una ruta por área en `server/src/routes/`. Ver el mapa de
  módulos en `docs/FUNCIONALIDAD.md` §1.
- `web/` — React + Vite + Tailwind. El servidor sirve `web/dist` en producción.
- `docs/` — documentación consultable.
- `Dockerfile`, `docker-compose.yml` — imagen y despliegue (incluye Traefik).

## Comandos

```bash
npm install
npm run dev         # server :4000 + web :5173 (proxy /api)
npm run build       # compila web y server
npm run typecheck   # SIEMPRE antes de dar por terminado un cambio
npm start           # producción, todo en :4000
```

No hay suite de tests automatizada; **`npm run typecheck` es la verificación
mínima obligatoria** tras tocar código, y `npm run build` para validar la web.

## Convenciones

- **Idioma**: código, comentarios, mensajes de UI y de error en **español**.
  Mantén ese registro. Los comentarios explican el *porqué*, no el *qué*.
- **Estilo**: sigue el patrón del fichero que tocas (nombres, formato, altura de
  abstracción). TypeScript estricto; sin `any` salvo fronteras con Docker/HTTP.
- **Rutas**: usa `requireAuth`/`requireSession`/`requireAdmin` + `assertProjectAccess`
  según el recurso. Valida el cuerpo con **zod**. Audita las acciones sensibles
  con `audit(req, 'accion', {...})`.
- **Docker/BBDD/archivos**: nunca interpoles entrada del usuario en un shell;
  pásala como variable de entorno del `exec` (patrón en `dbconsole.ts` y
  `files.ts`).
- **Secretos**: nunca los registres ni los devuelvas en claro (los tokens se
  guardan hasheados; el token de GitHub se enmascara en los logs de build).
- **Versión**: `config.version`, `package.json` (raíz/server/web) y el
  encabezado de `docs/FUNCIONALIDAD.md` van sincronizados.

## Seguridad (imprescindible)

Skyway monta `/var/run/docker.sock`: **quien accede controla el Docker del host**.
Antes de exponer una ruta nueva, piensa en el nivel de acceso. Cabeceras de
seguridad, hashing scrypt, sesiones JWT HS256 con `session_epoch`, tokens
hasheados, rate-limit de login y webhooks HMAC ya están implementados
(`server/src/app.ts`, `auth.ts`, `util.ts`). Detalle y hallazgos en
`docs/AUDITORIA.md`.

## Git

Desarrolla en la rama indicada por la tarea; **no** hagas push a otra rama sin
permiso explícito. No crees PRs salvo que se pida. No incluyas identificadores
internos de modelo en commits ni artefactos.
