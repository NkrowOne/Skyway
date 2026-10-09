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

Se crean en **Mi perfil → Tokens de API**. El token completo (`sky_…`) solo se
muestra una vez; guárdalo en un gestor de secretos. Cada token **hereda los
permisos del usuario que lo crea**:

- Token de un **admin** → control total (incluye gestión de usuarios y ajustes).
- Token de un **miembro** → solo sus workspaces asignados. Ideal para dar a un
  cliente acceso programático acotado, o para un agente con permisos limitados.

Se usan con la cabecera `Authorization: Bearer`. Con Bearer no aplica la guarda
CSRF del panel: esa solo mira las peticiones mutantes que llegan con la cookie
de sesión (un cliente con cookie y una cabecera `Origin` ajena recibe 403).

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

# Eliminar un servicio o un proyecto: borra SIEMPRE sus datos (volúmenes,
# bases de datos, copias de seguridad, imágenes) y exige confirmar con su nombre
# exacto o su slug en ?confirm= (sin él o si no coincide, 400 y nada borrado).
# La respuesta trae en "warnings" lo que no se pudo retirar. Un 409 con
# "warnings" significa que un contenedor no se pudo retirar o que un despliegue
# no terminó de cancelarse: no se ha borrado ningún dato y se puede reintentar.
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/services/SVC_ID?confirm=api"
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID?confirm=mi-proyecto"

# Salud y versión (sin auth)
curl -s "$BASE/api/health"
```

Notas:
- Los intentos y acciones quedan en el **registro de auditoría** con el formato
  `usuario · token:nombre`, así siempre se sabe qué automatización hizo qué.
- Borrar no tiene vuelta atrás: un agente debe pedir la confirmación a una
  persona antes de enviar `?confirm=`. Desde la 0.36 ya no existe `?volumes=`:
  los datos se borran siempre. La limpieza de datos sin proyecto
  (`/api/system/orphans`) no se puede hacer con un token, ni siquiera de
  administrador: solo desde el panel.
- Revocar un token (Mi perfil → papelera) corta el acceso al instante.
- Ponles caducidad si son para tareas puntuales.
- Un script que corre **en el propio servidor** (como el instalador de Mailway)
  puede crear y revocar su token sin pasar por el panel, con la herramienta de
  terminal `tools/token.js` (`docs/FUNCIONALIDAD.md` §9):

  ```bash
  TOKEN_JSON=$(docker exec skyway node server/dist/tools/token.js crear --nombre "Mi script" --caduca-min 60)
  # … usar el token de "token" con la API …
  docker exec skyway node server/dist/tools/token.js revocar --id "$(printf '%s' "$TOKEN_JSON" | jq -r .id)"
  ```

### Correo (Mailway) a través de Skyway

Si el administrador ha conectado Mailway (Ajustes → Correo), el correo de cada
proyecto se gestiona con el mismo token de Skyway: no hace falta un token de
Mailway en el script, y el token solo alcanza el cliente de correo de los
proyectos a los que da acceso (cada dominio y buzón se comprueba contra el
proyecto). Los proyectos de una cuenta comparten el cliente de correo de la
cuenta (dominios, buzones y plan): activarlo en un segundo proyecto lo vincula
a ese mismo cliente. Referencia completa en `docs/FUNCIONALIDAD.md` §7.12.

```bash
# Estado del correo del proyecto (dominios con su estado DNS, buzones, uso y, en
# suggestedDomains, los dominios de los servicios del proyecto que aún no tiene)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail"

# Activarlo (propietario o admin): crea el cliente de correo del proyecto con el
# plan predeterminado (solo un admin puede pasar "planId"). Tras desactivarlo,
# {"mode":"previous"} recupera el mismo cliente con sus dominios.
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"create"}' "$BASE/api/projects/PROJ_ID/mail/link"

# Añadir un dominio, ver sus registros DNS y verificarlo
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"domain":"tuempresa.com"}' "$BASE/api/projects/PROJ_ID/mail/domains"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/domains/DOM_ID/dns"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/domains/DOM_ID/verify"

# Fichero de zona para importarlo en Cloudflare (DNS → Registros → Importar y
# exportar). No incluye registros de la web del dominio raíz ni de www.
curl -s -H "Authorization: Bearer $TOKEN" -o zona.txt "$BASE/api/projects/PROJ_ID/mail/domains/DOM_ID/zonefile"

# Webmail con el dominio del cliente en webmail.<dominio> (propietario o admin):
# alta (la respuesta trae en webmail.instructions el registro DNS que hay que
# crear), comprobación y, si el DNS está en Cloudflare, creación del registro
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/domains/DOM_ID/webmail"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/domains/DOM_ID/webmail/verify"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/domains/DOM_ID/webmail/cloudflare"

# Webmail propio: interruptor del webmail automático del cliente (propietario o
# admin). Apagado, Mailway retira los webmail que creó solo, con su registro DNS.
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"activo":false}' "$BASE/api/projects/PROJ_ID/mail/webmail-automatico"

# Configuración inicial (propietario o admin): enlace de bienvenida para la
# persona de contacto del cliente (la URL llega UNA vez en invite.url), lista
# de enlaces, volver a ver uno pendiente y revocarlo
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"contacto@tuempresa.com","name":"Ana","ttlHours":168}' "$BASE/api/projects/PROJ_ID/mail/invites"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/invites"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/invites/INV_ID/url"
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/invites/INV_ID"

# Crear un buzón (propietario o admin; la respuesta trae la contraseña UNA sola vez)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"domainId":"DOM_ID","localPart":"info"}' "$BASE/api/projects/PROJ_ID/mail/mailboxes"

# Conectar un servicio por SMTP y volver a desplegarlo (solo devuelve los nombres
# de las variables; la credencial SMTP anterior de ese servicio se revoca). Si el
# servidor, el puerto o el usuario están puestos a mano con otro valor, 409 sin
# crear nada: la vista previa (…/mail/connect/preview) lo dice en «conflicts».
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"SVC_ID","mailboxId":"MBX_ID","mode":"smtp","redeploy":true}' \
  "$BASE/api/projects/PROJ_ID/mail/connect"

# Plan de integraciones de una web (skyway.json o detección): revisarlo y
# aprobarlo con su huella. Si el plan ha cambiado desde que se leyó, 409 con el
# plan nuevo y nada aplicado. Reutilizar en SMTP un buzón que ya existe exige
# además "confirmMailboxAccess": true (el plan lo explica en «confirmation»).
FP=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/services/SVC_ID/integrations" | jq -r .plan.fingerprint)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"expect\":\"$FP\",\"redeploy\":true}" "$BASE/api/services/SVC_ID/integrations/apply"

# Revocar una contraseña de aplicación o una clave de API del cliente
# (los ids están en summary.appPasswords / summary.apiKeys de GET .../mail)
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/app-passwords/APP_ID"
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/PROJ_ID/mail/api-keys/KEY_ID"
```

Un token de un usuario que no es admin: no elige el plan de Mailway, no crea
buzones de nombre reservado (postmaster, abuse, admin…) y, en Cloudflare, solo
usa las cuentas del propio cliente (también para el registro del webmail). El
webmail nunca se crea con un nombre que ya sirve un servicio de Skyway ni con el
del panel y, a la inversa, ningún servicio puede asignarse un nombre de marca
blanca de Mailway, tampoco mientras espera DNS (409). Los enlaces de configuración con contraseña
exigen ser propietario o admin y tienen un tope de 5 cada 10 minutos.

Configurar la conexión (`PUT /api/mailway/config`) y desconectarla
(`POST /api/mailway/disconnect`, que además retira de Traefik las rutas de
Mailway) exigen sesión de navegador de un administrador, como el resto de
credenciales persistentes; con un token de API se puede consultar
(`GET /api/mailway/config`, `GET /api/mailway/plans`) y probar
(`POST /api/mailway/test`). Quitar el token no retira las rutas publicadas.
Desde la terminal del servidor, `tools/mailway.js conectar` prueba y guarda la
conexión igual que Ajustes → Correo, con el token `mwt_…` por la entrada
estándar (nunca como argumento); es lo que usa el instalador de Mailway para
emparejar los dos paneles (`docs/FUNCIONALIDAD.md` §9).

### DNS automático en Cloudflare (administrador)

Con el token de Cloudflare del operador guardado (Ajustes → Cloudflare), las
peticiones de un **administrador** que dan de alta dominios nuevos —crear un
servicio con `domains`, añadirlos con `PATCH /api/services/:id`, una pila o una
plantilla con `domain`, y en la importación de Railway solo los que se indiquen
en `dnsDomains`— crean el registro A de cada uno en su Cloudflare sin pisar
nada, y la respuesta trae `dns` con el resultado (`created`, `kept`,
`conflict`, `skipped` o `error`, con su motivo). Vale igual con un token `sky_`
de un administrador. Con el token de un propietario o un miembro nunca se toca
Cloudflare y la respuesta no lleva `dns`; en el correo, su alta va con
`autoDns: false` y `?soloCliente=1`. El alta de correo de un administrador solo
pide `autoDns` si Mailway declara `features.cloudflareSoloCrear` (1.1 o
posterior: solo crea lo que falta); con uno anterior no se pide y
`cloudflareReason` lo explica (`docs/FUNCIONALIDAD.md` §7.13).

Un dominio que dio `error`, `conflict` o `skipped` se reintenta, ya corregida
la causa, con `POST /api/services/:id/cloudflare-dns {"domain":"…"}` (solo
administrador; solo ese dominio y solo si sigue en el servicio).

Cada dominio nuevo registrable o con www (`ejemplo.com`, `www.ejemplo.com`) se
guarda con su pareja con o sin www, también por la API, y la pareja pasa por el
mismo DNS automático. Para no añadirla, indica el dominio en
`config.dominiosSinPareja` (en el alta, `dominiosSinPareja` junto a `domains`).
Quitar el proxy de Cloudflare de un dominio (`POST
/api/services/:id/cloudflare-proxy`) exige sesión de navegador: no está
disponible con un token `sky_`.

Al editar un servicio, el registro solo se crea si la petición indica en
`domainsBase` los dominios de los que parte (los que leyó antes de editar). Así
un dominio que otra persona haya quitado entretanto no vuelve a ponerse ni se
crea su registro: si `config.domains` coincide con la base, se conservan los
dominios actuales; si no, 409. Sin `domainsBase`, el cambio se guarda pero cada
dominio nuevo vuelve en `dns` como `skipped`.

```bash
# Añadir un dominio a un servicio como administrador: la respuesta trae "dns"
ACTUALES=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$BASE/api/services/SVC_ID" | jq -c '.service.config.domains // []')
curl -s -X PATCH -H "Authorization: Bearer $TOKEN_ADMIN" -H "Content-Type: application/json" \
  -d "{\"config\":{\"domains\":$(jq -c '. + ["app.midominio.com"]' <<<"$ACTUALES")},\"domainsBase\":$ACTUALES}" \
  "$BASE/api/services/SVC_ID" | jq .dns
```

Los nombres creados quedan reservados al proyecto para el que se crearon (otro
cliente no puede asignárselos) hasta que el administrador borra su registro:
`GET /api/cloudflare/records` y `DELETE /api/cloudflare/records/:dominio`.

Guardar o borrar el token exige sesión de navegador (con un token de API solo
se consulta, `GET /api/cloudflare/config`, y se prueba,
`POST /api/cloudflare/test`). Por lo mismo, descargar una copia de `skyway.db`
(`GET /api/system/backups/:file/download`), que lleva el token en claro, exige
sesión de navegador: con un token de API se crea, se lista y se borra, pero no
se descarga. Desde la terminal del servidor, el instalador de
Mailway lo deja puesto con el token SOLO por la entrada estándar (un token en
los argumentos se rechaza sin leer nada); la salida nunca incluye el token:

```bash
printf '%s' "$CF_TOKEN" | docker exec -i skyway node server/dist/tools/cloudflare.js conectar
# → {"ok":true,"zones":3}
```

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
