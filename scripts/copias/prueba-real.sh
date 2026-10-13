#!/usr/bin/env bash
#
# Prueba real de las copias externas (scripts/copias): Docker de verdad,
# restic de verdad y un S3 local con bloqueo de objetos (versitygw). Simula un
# servidor con Skyway (un panel falso que responde a lo que usan las copias),
# un proyecto con una base PostgreSQL y una web con su volumen, Mailway y un
# volumen suelto. Hace copias, estropea datos y restaura por partes, prepara un
# kit y lo descodifica, atiende una petición del panel, aplica la retención y,
# al final, lo borra TODO (contenedores, volúmenes, imágenes, código y
# configuración) y lo vuelve a montar con restaurar.sh, como en un servidor nuevo.
#
#   bash scripts/copias/prueba-real.sh        (necesita Docker y unos minutos)
#
# Usa los nombres que fijan Skyway y Mailway (skyway, skyway-traefik,
# mailway-mail…): no se ejecuta si ya existen contenedores con esos nombres que
# no sean de una prueba anterior.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
IMG_ALPINE="${COPIAS_IMAGEN_AUX:-alpine:3.22.2}"
IMG_PG='postgres:16.10-alpine3.22'
IMG_S3='versity/versitygw:v1.8.0'
IMG_AWS="${COPIAS_IMAGEN_AWS:-amazon/aws-cli:2.37.4}"
PUERTO_S3=7071
PUERTO_API=7072
ETIQUETA='copias-prueba-real=1'

TMP="$(mktemp -d "${TMPDIR:-/tmp}/copias-prueba.XXXXXX")"
SRV="$TMP/srv"
export COPIAS_CONFIG_DIR="$TMP/etc"
export COPIAS_ESTADO_DIR="$TMP/var"
export COPIAS_SYSTEMD_DIR="$TMP/systemd"
export COPIAS_VOLUMEN_CACHE=copias-prueba-cache
export COPIAS_URL_PANEL="http://127.0.0.1:$PUERTO_API"
# Sin red hacia GitHub en la prueba: los binarios de otros sistemas fallan
# rápido y el kit lleva solo el de Linux, que sale de la imagen.
export COPIAS_URL_RESTIC="http://127.0.0.1:9/no-existe"
export NO_COLOR=1

FALLOS=0
PASOS=0
bien() { PASOS=$((PASOS + 1)); printf '  ✓ %s\n' "$*"; }
mal() { FALLOS=$((FALLOS + 1)); printf '  ✗ %s\n' "$*" >&2; }
comprobar() { local d="$1"; shift; if "$@"; then bien "$d"; else mal "$d"; fi; }
seccion() { printf '\n== %s ==\n' "$*"; }

CONTENEDORES=(skyway skyway-traefik skyway-demo-db skyway-demo-web skyway-mailway-panel mailway-mail copias-prueba-s3)
VOLUMENES=(skyway_skyway-data skyway_traefik-letsencrypt skyway-demo-db-data skyway-demo-web-data skyway-mailway-panel-data mailway-stalwart-data mailway-mail-certs copias-prueba-suelto copias-prueba-cache)

limpiar() {
  local c v
  for c in "${CONTENEDORES[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker ps -aq --filter "label=$ETIQUETA" | xargs -r docker rm -f >/dev/null 2>&1 || true
  for v in "${VOLUMENES[@]}"; do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
  docker image rm -f skyway/demo-web:prueba01 >/dev/null 2>&1 || true
  docker network rm skyway-edge >/dev/null 2>&1 || true
}

al_salir() {
  local codigo=$?
  [[ -n "${PID_API:-}" ]] && kill "$PID_API" 2>/dev/null || true
  if [[ -z "${COPIAS_PRUEBA_CONSERVAR:-}" ]]; then limpiar; rm -rf "$TMP"; else printf 'Conservado en %s\n' "$TMP"; fi
  return "$codigo"
}

for c in skyway skyway-traefik mailway-mail; do
  if docker inspect "$c" >/dev/null 2>&1 && [[ "$(docker inspect -f '{{index .Config.Labels "copias-prueba-real"}}' "$c")" != 1 ]]; then
    printf 'Ya hay un contenedor «%s» que no es de esta prueba: no se ejecuta aquí.\n' "$c" >&2
    exit 2
  fi
done
limpiar
trap al_salir EXIT

seccion "Preparación"
for i in "$IMG_ALPINE" "$IMG_PG" "$IMG_S3" "$IMG_AWS" restic/restic:0.19.1; do
  docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null
done

# S3 local con versiones y bloqueo de objetos.
mkdir -p "$TMP/s3/datos" "$TMP/s3/versiones"
docker run -d --name copias-prueba-s3 --label "$ETIQUETA" --network host -v "$TMP/s3:/s3" \
  -e ROOT_ACCESS_KEY=clave-prueba -e ROOT_SECRET_KEY=secreto-prueba-123 \
  "$IMG_S3" --port ":$PUERTO_S3" posix --versioning-dir /s3/versiones /s3/datos >/dev/null
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PUERTO_S3" && break; sleep 1; done
docker run --rm --network host -e AWS_ACCESS_KEY_ID=clave-prueba -e AWS_SECRET_ACCESS_KEY=secreto-prueba-123 -e AWS_DEFAULT_REGION=us-east-1 \
  "$IMG_AWS" --endpoint-url "http://127.0.0.1:$PUERTO_S3" s3api create-bucket --bucket copias --object-lock-enabled-for-bucket >/dev/null
bien "S3 local con bloqueo de objetos"

# Configuración de las copias (la que dejaría «configurar»).
mkdir -p "$COPIAS_CONFIG_DIR"
cat > "$COPIAS_CONFIG_DIR/config" <<EOF
S3_ENDPOINT=http://127.0.0.1:$PUERTO_S3
S3_REGION=us-east-1
S3_BUCKET=copias
S3_PREFIJO=servidor-prueba
S3_ESTILO=path
RETENCION_DIARIAS=1
RETENCION_SEMANALES=1
RETENCION_MENSUALES=1
HORA=03:30
MAILWAY_DIR=$SRV/Mailway
PAUSA_MAXIMA=120
EOF
printf 'AWS_ACCESS_KEY_ID=clave-prueba\nAWS_SECRET_ACCESS_KEY=secreto-prueba-123\n' > "$COPIAS_CONFIG_DIR/s3.env"
printf 'contrasena-de-prueba-larga-123\n' > "$COPIAS_CONFIG_DIR/contrasena"
chmod 600 "$COPIAS_CONFIG_DIR"/*
cat > "$TMP/datos.txt" <<EOF
S3_ENDPOINT=http://127.0.0.1:$PUERTO_S3
S3_REGION=us-east-1
S3_BUCKET=copias
S3_PREFIJO=servidor-prueba
S3_ACCESS_KEY=clave-prueba
S3_SECRET_KEY=secreto-prueba-123
CONTRASENA=contrasena-de-prueba-larga-123
EOF

# «Skyway»: un repositorio con su compose y un panel falso que responde como
# el de verdad a las herramientas que usan las copias.
mkdir -p "$SRV/Skyway/falso" "$SRV/Skyway/scripts"
cp -R "$DIR" "$SRV/Skyway/scripts/copias"
printf '{\n  "name": "skyway",\n  "version": "9.9.9"\n}\n' > "$SRV/Skyway/package.json"
printf 'SKYWAY_DOMAIN=panel.prueba.test\nLETSENCRYPT_EMAIL=\n' > "$SRV/Skyway/.env"
cat > "$SRV/Skyway/docker-compose.yml" <<EOF
services:
  skyway:
    image: $IMG_ALPINE
    container_name: skyway
    command: ["sleep", "infinity"]
    labels: ["$ETIQUETA"]
    networks: [skyway-edge]
    volumes:
      - skyway-data:/data
      - ./falso/node:/usr/local/bin/node:ro
  traefik:
    image: $IMG_ALPINE
    container_name: skyway-traefik
    command: ["sleep", "infinity"]
    labels: ["$ETIQUETA"]
    volumes:
      - traefik-letsencrypt:/letsencrypt
networks:
  skyway-edge:
    name: skyway-edge
volumes:
  skyway-data:
  traefik-letsencrypt:
EOF
printf '.env\n' > "$SRV/Skyway/.gitignore"
cat > "$SRV/Skyway/falso/node" <<'EOF'
#!/bin/sh
case "$1" in
  server/dist/tools/copias.js)
    case "$2" in
      inventario) cat /data/inventario.json;;
      repuntar)
        echo "$*" >> /data/repuntar.log
        aplicado=false; case "$*" in *"--aplicar si"*) aplicado=true;; esac
        printf '{"ok":true,"aplicado":%s,"serverIp":{"antes":"%s","despues":"%s","cambia":true},"cloudflare":{"configurado":false,"error":null,"registros":[]}}\n' "$aplicado" "$4" "$6";;
      *) exit 1;;
    esac;;
  server/dist/tools/token.js)
    case "$2" in
      crear) echo '{"id":"tok_prueba","token":"sky_prueba"}';;
      revocar) echo '{"ok":true,"revoked":true}';;
    esac;;
  server/dist/tools/aviso.js) echo "$*" >> /data/avisos.log; echo '{"ok":true,"channels":[],"failures":[]}';;
  *) exit 1;;
esac
EOF
chmod 755 "$SRV/Skyway/falso/node"
( cd "$SRV/Skyway" && git init -q -b main && git add -A && git -c user.email=p@p -c user.name=p commit -qm "Skyway de prueba" \
  && git remote add origin https://origen.invalid/Skyway.git && git update-ref refs/remotes/origin/main HEAD && git branch -q --set-upstream-to=origin/main main )
COMMIT_SKYWAY="$(git -C "$SRV/Skyway" rev-parse HEAD)"

# «Mailway»: su deploy/copias.sh responde con el formato del de verdad.
mkdir -p "$SRV/Mailway/deploy"
printf '{\n  "name": "mailway",\n  "version": "8.8.8"\n}\n' > "$SRV/Mailway/package.json"
printf 'MAIL_HOSTNAME=mail.prueba.test\nMAILWAY_SECRET=secreto-de-mailway-que-no-debe-salir\n' > "$SRV/Mailway/deploy/.env"
cat > "$SRV/Mailway/deploy/copias.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  inventario)
    printf '{"formato":1,"producto":"mailway","version":"8.8.8","raiz":"%s","git":{"commit":null,"rama":null,"origen":null},"instalacion":"skyway","env":"%s/deploy/.env","ficheros":["%s/deploy/.env"],"motor":{"serie":"0.16","imagen":"alpine","contenedor":"mailway-mail"},"panel":{"contenedor":"skyway-mailway-panel","volumen":null},"contenedores":["mailway-mail"],"volumenes":[{"nombre":"mailway-stalwart-data","rol":"motor-datos","descripcion":"Correo","consistencia":"parar","contenedores":["mailway-mail"]}],"ignorados":[{"nombre":"mailway-mail-certs","motivo":"Se regenera."}]}\n' "$RAIZ" "$RAIZ" "$RAIZ";;
  parar) docker stop mailway-mail >/dev/null; echo parar >> /tmp/copias-prueba-mailway.log;;
  arrancar) docker start mailway-mail >/dev/null; echo arrancar >> /tmp/copias-prueba-mailway.log;;
  reaplicar)
    shift
    docker start mailway-mail >/dev/null 2>&1 || docker run -d --name mailway-mail --label copias-prueba-real=1 -v mailway-stalwart-data:/datos -v mailway-mail-certs:/certs alpine:3.22.2 sleep infinity >/dev/null
    echo "reaplicar $*" >> /tmp/copias-prueba-mailway.log;;
esac
EOF
chmod 755 "$SRV/Mailway/deploy/copias.sh"
printf 'deploy/.env\n' > "$SRV/Mailway/.gitignore"
( cd "$SRV/Mailway" && git init -q -b main && git add -A && git -c user.email=p@p -c user.name=p commit -qm "Mailway de prueba" \
  && git remote add origin https://origen.invalid/Mailway.git && git update-ref refs/remotes/origin/main HEAD && git branch -q --set-upstream-to=origin/main main )
rm -f /tmp/copias-prueba-mailway.log

( cd "$SRV/Skyway" && docker compose up -d >/dev/null 2>&1 )
DATOS="$(docker volume inspect -f '{{.Mountpoint}}' skyway_skyway-data)"
python3 - "$DATOS/skyway.db" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1]); db.execute("create table proyectos (id text, nombre text)")
db.execute("insert into proyectos values ('prj_0000000000000001', 'Demo')"); db.commit(); db.close()
PY
mkdir -p "$DATOS/builds/dep_temporal" "$DATOS/backups"
echo "clon temporal" > "$DATOS/builds/dep_temporal/fichero"
cat > "$DATOS/inventario.json" <<'EOF'
{"formato":1,"producto":"skyway","version":"9.9.9","ajustes":{"serverIp":"203.0.113.10","serverIpv6":null,"rootDomain":"prueba.test","cloudflare":false},
 "proyectos":[{"id":"prj_0000000000000001","nombre":"Demo","slug":"demo","cliente":null,"servicios":[
  {"id":"svc_00000000000000db","nombre":"Base de datos","slug":"db","tipo":"database","plantilla":"postgres","versionPlantilla":"16","detenido":false,
   "contenedores":["skyway-demo-db"],"volumenes":["skyway-demo-db-data"],
   "volcado":{"orden":"pg_dump -U skyway -d skyway --no-owner --no-acl","restaurar":"psql -U skyway -d skyway -q -v ON_ERROR_STOP=0","extension":"sql.gz"},
   "despliegue":null,"imagen":null},
  {"id":"svc_00000000000000eb","nombre":"Web","slug":"web","tipo":"git","plantilla":null,"versionPlantilla":null,"detenido":false,
   "contenedores":["skyway-demo-web"],"volumenes":["skyway-demo-web-data"],"volcado":null,
   "despliegue":{"id":"dep_00000000000000eb","imagen":"skyway/demo-web:prueba01","commit":"0000000000000000000000000000000000000000"},"imagen":null}]},
  {"id":"prj_0000000000000002","nombre":"Mailway","slug":"mailway","cliente":null,"servicios":[
  {"id":"svc_0000000000000a11","nombre":"Panel","slug":"panel","tipo":"git","plantilla":null,"versionPlantilla":null,"detenido":false,
   "contenedores":["skyway-mailway-panel"],"volumenes":["skyway-mailway-panel-data"],"volcado":null,"despliegue":null,"imagen":null}]}]}
EOF
docker run --rm -v skyway_traefik-letsencrypt:/l "$IMG_ALPINE" sh -c 'echo "{\"le\":\"certificados\"}" > /l/acme.json; chmod 600 /l/acme.json'

# Proyecto «Demo»: la base y la web, como las crearía Skyway.
crear_bd() {
  docker run -d --name skyway-demo-db --label "$ETIQUETA" --label skyway.managed=true --label skyway.project=prj_0000000000000001 \
    --label skyway.service=svc_00000000000000db --network skyway-edge \
    -e POSTGRES_USER=skyway -e POSTGRES_PASSWORD=clave-bd -e POSTGRES_DB=skyway \
    -v skyway-demo-db-data:/var/lib/postgresql/data "$IMG_PG" >/dev/null
}
crear_web() {
  docker run -d --name skyway-demo-web --label "$ETIQUETA" --label skyway.managed=true --label skyway.project=prj_0000000000000001 \
    --label skyway.service=svc_00000000000000eb -v skyway-demo-web-data:/datos skyway/demo-web:prueba01 sleep infinity >/dev/null
}
sql() { docker exec skyway-demo-db psql -U skyway -d skyway -tAq -c "$1"; }
esperar_pg() {
  local i
  for i in $(seq 1 60); do
    if docker exec skyway-demo-db pg_isready -U skyway -d skyway -q 2>/dev/null && sleep 1 && docker exec skyway-demo-db pg_isready -U skyway -d skyway -q 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
docker tag "$IMG_ALPINE" skyway/demo-web:prueba01
crear_bd; crear_web
esperar_pg
sql "create table clientes (id serial primary key, nombre text); insert into clientes (nombre) select 'cliente ' || g from generate_series(1, 250) g;"
docker exec skyway-demo-web sh -c 'mkdir -p /datos/subidas && echo "factura original" > /datos/subidas/factura.pdf && echo "logo" > /datos/logo.png'
docker run -d --name mailway-mail --label "$ETIQUETA" -v mailway-stalwart-data:/datos -v mailway-mail-certs:/certs "$IMG_ALPINE" sleep infinity >/dev/null
docker run -d --name skyway-mailway-panel --label "$ETIQUETA" --label skyway.managed=true --label skyway.project=prj_0000000000000002 \
  --label skyway.service=svc_0000000000000a11 -v skyway-mailway-panel-data:/data "$IMG_ALPINE" sleep infinity >/dev/null
docker exec skyway-mailway-panel sh -c 'echo "base del panel de mailway" > /data/mailway.db; echo clave > /data/.secret'
docker exec mailway-mail sh -c 'mkdir -p /datos/buzones && echo "correo de ana" > /datos/buzones/ana.eml; echo cert > /certs/mail.pem'
docker volume create copias-prueba-suelto >/dev/null
docker run --rm -v copias-prueba-suelto:/v "$IMG_ALPINE" sh -c 'echo "dato suelto" > /v/importante.txt'

# API falsa del panel: salud, despliegues (crea los contenedores como Skyway) y rollback.
cat > "$TMP/api.py" <<'PY'
import http.server, json, subprocess, sys
LOG = sys.argv[2]
SERVICIOS = {
  'svc_00000000000000db': ['docker', 'run', '-d', '--name', 'skyway-demo-db', '--label', 'copias-prueba-real=1', '--label', 'skyway.managed=true',
    '--label', 'skyway.project=prj_0000000000000001', '--label', 'skyway.service=svc_00000000000000db', '--network', 'skyway-edge',
    '-e', 'POSTGRES_USER=skyway', '-e', 'POSTGRES_PASSWORD=clave-bd', '-e', 'POSTGRES_DB=skyway',
    '-v', 'skyway-demo-db-data:/var/lib/postgresql/data', 'postgres:16.10-alpine3.22'],
  'svc_0000000000000a11': ['docker', 'run', '-d', '--name', 'skyway-mailway-panel', '--label', 'copias-prueba-real=1', '--label', 'skyway.managed=true',
    '--label', 'skyway.project=prj_0000000000000002', '--label', 'skyway.service=svc_0000000000000a11',
    '-v', 'skyway-mailway-panel-data:/data', 'alpine:3.22.2', 'sleep', 'infinity'],
}
WEB = ['docker', 'run', '-d', '--name', 'skyway-demo-web', '--label', 'copias-prueba-real=1', '--label', 'skyway.managed=true',
  '--label', 'skyway.project=prj_0000000000000001', '--label', 'skyway.service=svc_00000000000000eb',
  '-v', 'skyway-demo-web-data:/datos', 'skyway/demo-web:prueba01', 'sleep', 'infinity']
ESTADOS = {}
class H(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def responder(self, codigo, cuerpo):
    datos = json.dumps(cuerpo).encode()
    self.send_response(codigo); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(datos)
  def do_GET(self):
    if self.path == '/api/health': return self.responder(200, {'ok': True, 'version': '9.9.9'})
    if self.path.startswith('/api/deployments/'):
      return self.responder(200, {'deployment': {'status': ESTADOS.get(self.path.split('/')[3], 'failed')}})
    self.responder(404, {'error': 'no'})
  def do_POST(self):
    n = int(self.headers.get('Content-Length') or 0); self.rfile.read(n)
    with open(LOG, 'a') as f: f.write(self.path + ' ' + (self.headers.get('Authorization') or '') + '\n')
    partes = self.path.split('/')
    def lanzar(orden, dep):
      subprocess.run(['docker', 'rm', '-f', orden[4]], capture_output=True)
      r = subprocess.run(orden, capture_output=True)
      ESTADOS[dep] = 'success' if r.returncode == 0 else 'failed'
      return self.responder(202, {'deployment': {'id': dep}})
    if len(partes) == 5 and partes[2] == 'services' and partes[4] == 'deploy' and partes[3] in SERVICIOS:
      return lanzar(SERVICIOS[partes[3]], 'dep_' + partes[3][-6:])
    if len(partes) == 5 and partes[2] == 'deployments' and partes[4] == 'rollback' and partes[3] == 'dep_00000000000000eb':
      if subprocess.run(['docker', 'image', 'inspect', 'skyway/demo-web:prueba01'], capture_output=True).returncode != 0:
        return self.responder(409, {'error': 'image_purged'})
      return lanzar(WEB, 'dep_rollback_web')
    self.responder(404, {'error': 'no'})
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
python3 "$TMP/api.py" "$PUERTO_API" "$TMP/api.log" &
PID_API=$!
bien "Servidor de prueba preparado (Skyway, proyecto Demo con PostgreSQL y web, Mailway, volumen suelto)"

COPIAS="$SRV/Skyway/scripts/copias/copias.sh"
cuenta_clientes() { sql 'select count(*) from clientes' 2>/dev/null || echo error; }
leer_vol() { docker run --rm -v "$1:/v:ro" "$IMG_ALPINE" cat "/v/$2" 2>/dev/null || echo '(no existe)'; }
todos_en_marcha() {
  local c
  for c in skyway skyway-traefik skyway-demo-db skyway-demo-web skyway-mailway-panel mailway-mail; do
    [[ "$(docker inspect -f '{{.State.Running}} {{.State.Paused}}' "$c" 2>/dev/null)" == "true false" ]] || return 1
  done
}

seccion "Copia completa"
inicio_mail="$(docker inspect -f '{{.State.StartedAt}}' mailway-mail)"
bash "$COPIAS" copia --motivo manual > "$TMP/copia1.log" 2>&1 || { cat "$TMP/copia1.log"; mal "La copia ha fallado"; }
LISTA="$(bash "$COPIAS" lista --json 2>/dev/null)"
comprobar "Una copia en la lista" test "$(jq 'length' <<< "$LISTA")" = 1
ID1="$(jq -r '.[0].id' <<< "$LISTA")"
MAN="$COPIAS_ESTADO_DIR/ejecuciones/$ID1.json"
comprobar "El manifiesto tiene configuración, código, volúmenes, volcado e imagen" \
  jq -e '[.elementos[] | select(.estado == "ok") | .tipo] | (index("config") and index("codigo") and index("volumen") and index("volcado") and index("imagen"))' "$MAN"
for v in skyway_skyway-data skyway_traefik-letsencrypt skyway-demo-db-data skyway-demo-web-data mailway-stalwart-data copias-prueba-suelto; do
  comprobar "Volumen $v copiado" jq -e --arg v "$v" 'any(.elementos[]; .tipo == "volumen" and .nombre == $v and .estado == "ok")' "$MAN"
done
comprobar "El volumen del panel de Mailway va con el correo" jq -e 'any(.elementos[]; .tipo == "volumen" and .nombre == "skyway-mailway-panel-data" and .origen == "mailway")' "$MAN"
comprobar "El volumen ignorado por Mailway no se copia" jq -e 'all(.elementos[]; .nombre != "mailway-mail-certs")' "$MAN"
comprobar "La caché de restic no se copia" jq -e 'all(.elementos[]; .nombre != "copias-prueba-cache")' "$MAN"
comprobar "El volumen suelto se avisa como sin regla" jq -e 'any(.avisos[]; contains("copias-prueba-suelto"))' "$MAN"
comprobar "Los volúmenes con servicios en marcha van en dos pasadas" jq -e '[.elementos[] | select(.tipo == "volumen" and .nombre == "skyway-demo-db-data") | .pasadas] == [2]' "$MAN"
comprobar "Ningún contenedor se queda en pausa ni parado" todos_en_marcha
comprobar "El motor de correo se ha parado y vuelto a arrancar" test "$(docker inspect -f '{{.State.StartedAt}}' mailway-mail)" != "$inicio_mail"
comprobar "El panel ve el estado de la copia" jq -e --arg id "$ID1" '.ultima.id == $id and .ultima.resultado == "con-avisos"' "$DATOS/copias/estado.json"
comprobar "El panel ve la lista de copias" jq -e --arg id "$ID1" '.ejecuciones[0].id == $id and (.ejecuciones[0].proyectos[0].slug == "demo")' "$DATOS/copias/ejecuciones.json"
comprobar "Ningún secreto en el manifiesto" bash -c "! grep -q 'secreto-de-mailway-que-no-debe-salir' '$MAN'"
bash "$COPIAS" extraer "$TMP/extraido" --ejecucion "$ID1" --elemento /volumenes/skyway_skyway-data > "$TMP/extraer1.log" 2>&1 || { cat "$TMP/extraer1.log"; mal "extraer ha fallado"; }
comprobar "Las carpetas temporales del panel (builds) no se copian" test ! -e "$TMP/extraido/volumenes/skyway_skyway-data/builds"
comprobar "La base del panel sí" test -s "$TMP/extraido/volumenes/skyway_skyway-data/skyway.db"
bash "$COPIAS" extraer "$TMP/extraido" --ejecucion "$ID1" --elemento /elementos/config > "$TMP/extraer2.log" 2>&1 || { cat "$TMP/extraer2.log"; mal "extraer ha fallado"; }
comprobar "La configuración lleva el .env de Mailway" grep -q 'MAILWAY_SECRET=secreto-de-mailway' "$TMP/extraido/elementos/config/mailway/.env"

seccion "Datos estropeados y restauración de un proyecto"
sql "delete from clientes where id > 10; insert into clientes (nombre) values ('basura');" || mal "No se ha podido estropear la base"
docker exec skyway-demo-web sh -c 'rm /datos/subidas/factura.pdf; echo "virus" > /datos/malo.php'
bash "$COPIAS" restaurar proyecto demo --ejecucion "$ID1" -y > "$TMP/r1.log" 2>&1 || { cat "$TMP/r1.log"; mal "restaurar proyecto ha fallado"; }
esperar_pg || true
comprobar "La base vuelve a tener 250 clientes" test "$(cuenta_clientes)" = 250
comprobar "La factura borrada vuelve" test "$(leer_vol skyway-demo-web-data subidas/factura.pdf)" = "factura original"
comprobar "Lo que no estaba en la copia desaparece" test "$(leer_vol skyway-demo-web-data malo.php)" = '(no existe)'
comprobar "Los servicios del proyecto vuelven a estar en marcha" todos_en_marcha

seccion "Restaurar una base desde su volcado SQL"
sql "drop table clientes;" || mal "No se ha podido borrar la tabla"
bash "$COPIAS" restaurar servicio demo/db --ejecucion "$ID1" --volcados -y > "$TMP/r2.log" 2>&1 || { cat "$TMP/r2.log"; mal "restaurar servicio --volcados ha fallado"; }
esperar_pg || true
comprobar "La base vuelve desde el volcado con 250 clientes" test "$(cuenta_clientes)" = 250
comprobar "Todo sigue en marcha" todos_en_marcha

seccion "Restaurar solo el correo y un volumen suelto"
bash "$COPIAS" copia --alcance correo --simular > "$TMP/plan-correo.json" 2>/dev/null || mal "copia --simular ha fallado"
comprobar "Una copia solo del correo lleva el motor y el panel de Mailway, y nada de la web" \
  jq -se '(map(.nombre) | index("mailway-stalwart-data") and index("skyway-mailway-panel-data")) and (map(.nombre) | index("skyway-demo-web-data") | not)' "$TMP/plan-correo.json" >/dev/null
docker exec mailway-mail sh -c 'echo "borrado" > /datos/buzones/ana.eml'
docker run --rm -v copias-prueba-suelto:/v "$IMG_ALPINE" sh -c 'rm /v/importante.txt'
docker exec skyway-mailway-panel sh -c 'echo "estropeado" > /data/mailway.db'
bash "$COPIAS" restaurar correo --ejecucion "$ID1" -y > "$TMP/r3.log" 2>&1 || { cat "$TMP/r3.log"; mal "restaurar correo ha fallado"; }
comprobar "El correo de Ana vuelve" test "$(leer_vol mailway-stalwart-data buzones/ana.eml)" = "correo de ana"
comprobar "El panel de Mailway vuelve" test "$(leer_vol skyway-mailway-panel-data mailway.db)" = "base del panel de mailway"
comprobar "Mailway se ha parado y arrancado con su copias.sh" grep -q '^arrancar' /tmp/copias-prueba-mailway.log
bash "$COPIAS" restaurar volumen copias-prueba-suelto --ejecucion "$ID1" -y > "$TMP/r4.log" 2>&1 || { cat "$TMP/r4.log"; mal "restaurar volumen ha fallado"; }
comprobar "El volumen suelto vuelve" test "$(leer_vol copias-prueba-suelto importante.txt)" = "dato suelto"

seccion "Kit para guardar en local"
bash "$COPIAS" kit todo --ejecucion "$ID1" > "$TMP/kit.log" 2>&1 || { cat "$TMP/kit.log"; mal "El kit ha fallado"; }
ZIP="$(ls "$DATOS"/copias/kits/kit-*.zip 2>/dev/null | head -n 1)"
comprobar "El kit está donde lo descarga el panel" test -s "$ZIP"
comprobar "kit.json dice que está listo" jq -e '.estado == "listo" and (.fichero | startswith("kit-"))' "$DATOS/copias/kit.json"
mkdir -p "$TMP/local" && { [[ -n "$ZIP" ]] && unzip -q "$ZIP" -d "$TMP/local" || true; }
KITDIR="$(find "$TMP/local" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
KITDIR="${KITDIR:-$TMP/local/sin-kit}"
comprobar "El kit trae LEEME, descodificadores, restaurar.sh y restic" \
  test -f "$KITDIR/LEEME.txt" -a -f "$KITDIR/descodificar.sh" -a -f "$KITDIR/descodificar.bat" -a -f "$KITDIR/restaurar.sh" -a -x "$KITDIR/bin/restic-linux-amd64"
comprobar "El LEEME lleva la fecha de la copia" grep -q "$ID1" "$KITDIR/LEEME.txt"
( cd "$KITDIR" && printf 'contrasena-de-prueba-larga-123\n' | bash descodificar.sh -y > "$TMP/descodificar.log" 2>&1 ) || { cat "$TMP/descodificar.log"; mal "descodificar.sh ha fallado"; }
comprobar "Descodificado: la factura de la web" grep -q 'factura original' "$KITDIR/descodificado/volumenes/skyway-demo-web-data/subidas/factura.pdf"
comprobar "Descodificado: el volcado SQL de la base" bash -c "gunzip -c '$KITDIR/descodificado/volcados/svc_00000000000000db/volcado.sql.gz' | grep -q 'cliente 250'"
comprobar "Descodificado: el correo" grep -q 'correo de ana' "$KITDIR/descodificado/volumenes/mailway-stalwart-data/buzones/ana.eml"
( cd "$KITDIR" && printf 'contrasena-mala\n' | bash descodificar.sh -y > "$TMP/descodificar-mal.log" 2>&1 ) && mal "Con una contraseña mala, descodificar.sh no falla" || bien "Con una contraseña mala, descodificar.sh falla"

seccion "Petición del panel, panel parado y retención"
docker stop skyway >/dev/null || true
bash "$COPIAS" copia > "$TMP/copia-sin-panel.log" 2>&1 || { cat "$TMP/copia-sin-panel.log"; mal "La copia con el panel parado ha fallado"; }
docker start skyway >/dev/null || true
comprobar "Con el panel parado, la copia usa lo que ve en Docker y avisa" grep -q 'deducidos de Docker' "$TMP/copia-sin-panel.log"
printf '{"formato":1,"accion":"copia","solicitadoPor":"admin@prueba.test","fecha":"2026-10-13T10:00:00Z"}\n' > "$DATOS/copias/peticiones/1760349600000-ab12.json"
bash "$COPIAS" atender > "$TMP/atender.log" 2>&1 || { cat "$TMP/atender.log"; mal "atender ha fallado"; }
comprobar "La petición del panel se atiende y se borra" jq -e '.ultimaPeticion.resultado == "correcta" and .ultimaPeticion.accion == "copia"' "$DATOS/copias/estado.json"
comprobar "No quedan peticiones" test -z "$(ls -A "$DATOS/copias/peticiones")"
docker stop copias-prueba-s3 >/dev/null
inicio_s=$SECONDS
COPIAS_PAUSA_CONEXION=1 bash "$COPIAS" copia --auto > "$TMP/copia-sin-s3.log" 2>&1 && mal "Con el S3 caído, la copia no falla" || bien "Con el S3 caído, la copia falla"
comprobar "y falla enseguida, sin esperar a los reintentos de restic" test $((SECONDS - inicio_s)) -lt 120
comprobar "con un motivo claro" grep -q 'No se puede conectar con' "$TMP/copia-sin-s3.log"
comprobar "y queda como fallida en lo que ve el panel" jq -e '.ultima.resultado == "fallida" and (.ultima.detalle | contains("No se puede conectar"))' "$DATOS/copias/estado.json"
comprobar "y avisa por los canales del panel" grep -q 'Copias externas' "$DATOS/avisos.log"
docker start copias-prueba-s3 >/dev/null
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PUERTO_S3" && break; sleep 1; done
comprobar "Hay 3 copias antes de la retención" test "$(bash "$COPIAS" lista --json | jq 'length')" = 3
bash "$COPIAS" mantenimiento > "$TMP/mant.log" 2>&1 || { cat "$TMP/mant.log"; mal "El mantenimiento ha fallado"; }
comprobar "La retención (1 diaria) deja solo la última copia completa del día" test "$(bash "$COPIAS" lista --json | jq 'length')" = 1
bash "$COPIAS" comprobar > "$TMP/comprobar.log" 2>&1 && bien "El repositorio pasa la comprobación" || { cat "$TMP/comprobar.log"; mal "comprobar ha fallado"; }
rm -f "$COPIAS_ESTADO_DIR/ultima-prueba-restauracion"
bash "$COPIAS" copia --motivo programada --auto > "$TMP/programada.log" 2>&1 || { cat "$TMP/programada.log"; mal "La copia programada ha fallado"; }
comprobar "La copia programada hace la restauración de prueba mensual" test -s "$COPIAS_ESTADO_DIR/ultima-prueba-restauracion"
comprobar "y el panel la ve, correcta" jq -e '.ultimaPruebaRestauracion.resultado == "correcta"' "$DATOS/copias/estado.json"
comprobar "y aplica la retención: queda solo la última" test "$(bash "$COPIAS" lista --json | jq 'length')" = 1
ID_ULTIMA="$(bash "$COPIAS" lista --json | jq -r '.[0].id')"

seccion "Servidor nuevo: se borra TODO y se restaura con restaurar.sh"
CLIENTES_ANTES="$(cuenta_clientes)"
limpiar_servidor() {
  local c v
  for c in skyway skyway-traefik skyway-demo-db skyway-demo-web skyway-mailway-panel mailway-mail; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for v in skyway_skyway-data skyway_traefik-letsencrypt skyway-demo-db-data skyway-demo-web-data skyway-mailway-panel-data mailway-stalwart-data mailway-mail-certs copias-prueba-suelto copias-prueba-cache; do
    docker volume rm -f "$v" >/dev/null 2>&1 || true
  done
  docker image rm -f skyway/demo-web:prueba01 >/dev/null 2>&1 || true
  docker network rm skyway-edge >/dev/null 2>&1 || true
  rm -rf "$SRV" "$COPIAS_CONFIG_DIR" "$COPIAS_ESTADO_DIR"
}
cp "$SRV/Skyway/scripts/copias/restaurar.sh" "$TMP/restaurar.sh"
limpiar_servidor
rm -f /tmp/copias-prueba-mailway.log
bash "$TMP/restaurar.sh" --datos "$TMP/datos.txt" --ip 198.51.100.7 -y > "$TMP/nuevo.log" 2>&1 || { cat "$TMP/nuevo.log"; mal "restaurar.sh ha fallado"; }
comprobar "El código de Skyway vuelve en su commit" test "$(git -C "$SRV/Skyway" rev-parse HEAD 2>/dev/null)" = "$COMMIT_SKYWAY"
comprobar "La rama de Skyway vuelve a seguir a GitHub" test "$(git -C "$SRV/Skyway" rev-parse --abbrev-ref '@{u}' 2>/dev/null)" = origin/main
comprobar "El .env de Skyway vuelve" grep -q 'SKYWAY_DOMAIN=panel.prueba.test' "$SRV/Skyway/.env"
comprobar "El .env de Mailway vuelve" grep -q 'MAILWAY_SECRET=secreto-de-mailway' "$SRV/Mailway/deploy/.env"
comprobar "La imagen de la web se carga desde la copia" docker image inspect skyway/demo-web:prueba01
comprobar "La web vuelve con su rollback (sin GitHub)" grep -q '/api/deployments/dep_00000000000000eb/rollback Bearer sky_prueba' "$TMP/api.log"
comprobar "La base se vuelve a desplegar" grep -q '/api/services/svc_00000000000000db/deploy' "$TMP/api.log"
esperar_pg || true
comprobar "La base vuelve con sus clientes ($CLIENTES_ANTES)" test "$(cuenta_clientes)" = "$CLIENTES_ANTES"
comprobar "La factura vuelve" test "$(leer_vol skyway-demo-web-data subidas/factura.pdf)" = "factura original"
comprobar "El correo vuelve" test "$(leer_vol mailway-stalwart-data buzones/ana.eml)" = "correo de ana"
comprobar "El panel de Mailway vuelve (y se vuelve a desplegar)" test "$(leer_vol skyway-mailway-panel-data mailway.db)" = "base del panel de mailway"
comprobar "Los certificados de Traefik vuelven" bash -c "docker run --rm -v skyway_traefik-letsencrypt:/l:ro $IMG_ALPINE cat /l/acme.json | grep -q certificados"
comprobar "El volumen suelto vuelve" test "$(leer_vol copias-prueba-suelto importante.txt)" = "dato suelto"
DATOS="$(docker volume inspect -f '{{.Mountpoint}}' skyway_skyway-data 2>/dev/null || true)"
comprobar "La IP nueva se aplica en Skyway (y en su DNS)" grep -q -- '--ip-anterior 203.0.113.10 --ip-nueva 198.51.100.7 --aplicar si' "$DATOS/repuntar.log"
comprobar "Mailway se reaplica con la IP nueva" grep -q 'reaplicar --ip 198.51.100.7' /tmp/copias-prueba-mailway.log
comprobar "Todo en marcha en el servidor nuevo" todos_en_marcha
comprobar "Las copias siguen configuradas en el servidor nuevo" test -s "$COPIAS_CONFIG_DIR/config" -a -s "$COPIAS_CONFIG_DIR/contrasena"
grep -q "$ID_ULTIMA" "$TMP/nuevo.log" && bien "Restaurada la última copia ($ID_ULTIMA)" || mal "No se ha restaurado la última copia"
rm -f /tmp/copias-prueba-mailway.log

printf '\n%d comprobaciones correctas, %d fallos.\n' "$PASOS" "$FALLOS"
(( FALLOS == 0 ))
