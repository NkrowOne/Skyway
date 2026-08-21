# Control remoto de Skyway (API, Claude y automatizaciones)

Skyway se controla al 100% por API REST. Todo lo que hace el panel — proyectos,
servicios, despliegues, variables, backups, usuarios — existe como endpoint bajo
`/api`. Eso permite que un agente (Claude), un script o un CI/CD manejen el
servidor sin tocar el panel.

Hay **dos planos de control** complementarios:

| Plano | Qué controla | Cómo |
|---|---|---|
| **Skyway API** | Apps, despliegues, dominios, backups, usuarios | Token de API de Skyway (`sky_…`) |
| **netcup SCP API** | La máquina: reinicios, snapshots, firewall, reinstalación | OAuth del SCP de netcup |

---

## 1. Tokens de API de Skyway

Se crean en **Mi cuenta → Tokens de API**. El token completo (`sky_…`) solo se
muestra una vez; guárdalo en un gestor de secretos. Cada token **hereda los
permisos del usuario que lo crea**:

- Token de un **admin** → control total (incluye gestión de usuarios y ajustes).
- Token de un **miembro** → solo sus workspaces asignados. Ideal para dar a un
  cliente acceso programático acotado, o para un agente con permisos limitados.

Se usan con la cabecera `Authorization: Bearer`:

```bash
BASE="https://skyway.tudominio.com"   # o http://localhost:4000 por túnel SSH
TOKEN="sky_..."

# Listar proyectos
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects"

# Ver un servicio (estado del contenedor incluido)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/services/SVC_ID"

# Desplegar un servicio (añade {"force":true} para recompilar sin reutilizar imagen)
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/services/SVC_ID/deploy"

# Reiniciar / parar / arrancar
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/services/SVC_ID/restart"

# Variables de entorno de un servicio
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"vars":{"NODE_ENV":"production"}}' "$BASE/api/services/SVC_ID/env"

# Último despliegue con logs
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/deployments/DEP_ID"

# Despliegues en marcha de un proyecto, en vivo (SSE)
curl -sN -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/deploys/stream"

# Cuentas de GitHub conectadas al proyecto y sus repos
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/github/installations"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/github/installations/GHI_ID/repos"

# Copiar los datos de una base externa a una gestionada (Postgres/MySQL/Mongo)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sourceUrl":"postgresql://usuario:clave@host:5432/db"}' \
  "$BASE/api/services/SVC_ID/data-migration"

# Catálogo de pilas de aplicaciones y creación de una entera (Supabase, WordPress…)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stacks"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"stack":"supabase","domain":"supabase.midominio.com"}' \
  "$BASE/api/projects/PROJ_ID/stacks"

# Salud y versión (sin auth)
curl -s "$BASE/api/health"
```

Notas:
- Los intentos y acciones quedan en el **registro de auditoría** con el formato
  `usuario · token:nombre`, así siempre se sabe qué automatización hizo qué.
- Revocar un token (Mi cuenta → papelera) corta el acceso al instante.
- Ponles caducidad si son para tareas puntuales.

### CLI rápida: el comando `skyway`

Para el día a día hay un script en `scripts/skyway` que envuelve la API: elige el
servicio de una lista (o por nombre/slug) y actúa, sin recordar ids ni escribir
`curl`. Necesita `curl` y `jq`.

```bash
# Instalar (enlace en el PATH) y configurar una vez
sudo ln -s "$PWD/scripts/skyway" /usr/local/bin/skyway
mkdir -p ~/.config/skyway && cat > ~/.config/skyway/config <<CFG
SKYWAY_URL="https://skyway.tudominio.com"   # o http://localhost:4000 por túnel SSH
SKYWAY_TOKEN="sky_..."
CFG

skyway ls                 # lista los servicios accesibles con su estado
skyway deploy             # elige un servicio y despliega (rama configurada, p. ej. main, al último commit)
skyway deploy api -f      # despliega el servicio «api» y sigue el estado hasta terminar
skyway restart api        # reinicia
skyway stop api           # detiene (pide confirmación; -y la salta)
skyway rewind api         # rollback: muestra los despliegues correctos y vuelves al que elijas
skyway status api         # estado y último despliegue
skyway update             # actualiza el PROPIO Skyway: git pull + rebuild + reinicio (en el servidor)
```

`deploy` siempre redespliega la rama configurada del servicio (habitualmente
`main`) clonándola de nuevo, así que trae el último commit sin pasos extra. El
token define qué servicios ves y qué puedes hacer (hereda los permisos del
usuario). `skyway --help` lista todo.

`skyway update` es distinto: no usa la API ni el token, opera **en local sobre
el servidor** donde corre Skyway. Hace `git pull` del repo, reconstruye la imagen
(`docker compose up -d --build`) y comprueba el health. La base de datos vive en
el volumen `skyway-data`, así que no se toca, y las apps desplegadas siguen
corriendo (solo parpadea el panel unos segundos). Requiere `git`, `docker` y
Docker Compose en el servidor.

### Darle el control a Claude

En una sesión de Claude Code (terminal, web o app):

```bash
export SKYWAY_URL="https://skyway.tudominio.com"
export SKYWAY_TOKEN="sky_..."
```

y dile: *«Controla mi Skyway con la API en $SKYWAY_URL usando $SKYWAY_TOKEN
(Authorization: Bearer). Lista los proyectos y redespliega el servicio X.»*
Claude puede leer estados, desplegar, cambiar variables, consultar logs de
despliegue y gestionar backups con `curl` contra la API.

> Mientras no tengas dominio, la API solo es accesible desde el propio servidor
> o por túnel SSH (`ssh -p PUERTO -L 4000:127.0.0.1:4000 root@IP`). Un agente
> que corra fuera de tu red necesitará el dominio con HTTPS.

---

## 2. API del SCP de netcup (nivel máquina)

netcup expone una API REST de su Server Control Panel, con OAuth2:

- **Base:** `https://servercontrolpanel.de/scp-core/api/v1`
- **Activación y credenciales:** SCP → <https://servercontrolpanel.de/scp-ui/api/rest-settings>
- **Docs:** <https://servercontrolpanel.de/scp-ui/api/rest-docs>
- **Token OAuth:** `https://servercontrolpanel.de/realms/scp/protocol/openid-connect/token`
  (también hay *device flow* para autorizar desde otro dispositivo)

Con ella se controla lo que Skyway no ve, porque está por debajo del SO:

- `GET /servers` · `PATCH /servers/{id}` — estado, arranque/parada/reinicio
- `POST /servers/{id}/snapshots` · `.../revert` — snapshots y restauración
- `POST /servers/{id}/rescuesystem` — arrancar el sistema de rescate
- `GET /servers/{id}/metrics/cpu|disk|network` — métricas del hipervisor
- `.../interfaces/{mac}/firewall` — firewall externo de netcup
- `PUT /servers/{id}/image` — reinstalar el sistema operativo
- `GET/POST /users/{id}/ssh-keys` — claves SSH guardadas en el panel

**Extra para Claude:** el SCP publica un endpoint **MCP** (`/api/v1/openapi/mcp`),
el protocolo nativo de conectores de Claude. Añadiéndolo como conector en
claude.ai (Ajustes → Conectores → Añadir conector personalizado), Claude puede
operar el panel de netcup directamente: crear un snapshot antes de un cambio
arriesgado, reiniciar la máquina si se cuelga, etc.

---

## 3. Buenas prácticas

1. **Un token por integración** (uno para Claude, otro para CI…), nunca
   compartidos: revocar uno no rompe el resto y la auditoría distingue autores.
2. **Principio de mínimo privilegio:** si el agente solo opera un workspace,
   crea un usuario miembro asignado a ese workspace y genera el token desde él.
3. **Snapshot antes de operaciones arriesgadas** a nivel máquina (API netcup) y
   backup de bases de datos antes de migraciones (API Skyway).
4. Los tokens viajan por HTTPS (dominio + Let's Encrypt) o por túnel SSH; nunca
   por HTTP plano expuesto.
