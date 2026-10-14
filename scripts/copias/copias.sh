#!/usr/bin/env bash
#
# copias — copias externas de todo el servidor (Skyway, sus proyectos y webs, y
# Mailway) en un almacenamiento S3 (Backblaze B2 u otro compatible), cifradas con
# restic. Se usa como «skyway copias <orden>» (scripts/skyway lo delega aquí).
#
#   sudo skyway copias                      Menú
#   sudo skyway copias configurar           Destino S3 y contraseña; comprueba el bucket e inicia el repositorio
#   sudo skyway copias activar [--hora HH:MM]   Copia diaria (systemd) y peticiones del panel
#   sudo skyway copias desactivar | estado
#   sudo skyway copias copia [--alcance todo|skyway|correo|proyecto:<id>] [--motivo M] [--simular]
#   sudo skyway copias lista [--json] | ver <ejecución>
#   sudo skyway copias restaurar todo|skyway|correo|proyecto <x>|servicio <x>|volumen <x>
#                                [--ejecucion ID | --fecha AAAA-MM-DD] [--volcados] [-y]
#   sudo skyway copias extraer <carpeta> [--ejecucion ID] [--elemento <ruta>]
#   sudo skyway copias kit [todo|skyway|correo|proyecto <x>] [--ejecucion ID | --fecha AAAA-MM-DD]
#   sudo skyway copias comprobar [--a-fondo] | mantenimiento
#   sudo skyway copias datos-recuperacion | recuperar-bucket --desde <fecha>
#
# Por qué así:
# - Solo depende de Docker, bash, jq, git y curl en el servidor: funciona
#   aunque el panel de Skyway o el de Mailway no arranquen. restic y la CLI de
#   AWS corren en contenedores con versión exacta.
# - Cada elemento (un volumen, el volcado de una base, la imagen de una web, la
#   configuración, el código) es una instantánea de restic con su ruta y sus
#   etiquetas: se restaura todo o solo una parte, de cualquier fecha. El
#   manifiesto de cada ejecución (lo último que se sube) guarda las versiones y
#   qué instantánea es cada cosa.
# - La copia de un volumen es en dos pasadas: una en caliente y otra con sus
#   contenedores en pausa (o parados, el motor de correo) que solo lee lo que
#   ha cambiado. El resultado es el de un corte de luz en ese instante, del que
#   cualquier base de datos sabe recuperarse, con unos segundos de pausa.
# - Lo que no tiene regla (un volumen nuevo que nadie ha declarado) se copia
#   igualmente y se avisa: nada se queda fuera por olvido.
#
# Ficheros: /etc/skyway-copias (configuración y secretos, solo root) y
# /var/lib/skyway-copias (estado y temporales). El estado que ve el panel se
# escribe en <datos de Skyway>/copias (docs/COPIAS.md).
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
DIR_COPIAS="$(cd "$(dirname "$SELF")" && pwd)"

# Formato de los manifiestos y de los ficheros que lee el panel. Un cambio
# incompatible lo sube; quien restaura usa el copias.sh que viaja en la propia
# copia, así que una copia antigua siempre se lee con su propio código.
FORMATO=1

IMAGEN_RESTIC="${COPIAS_IMAGEN_RESTIC:-restic/restic:0.19.1}"
VERSION_RESTIC="${IMAGEN_RESTIC##*:}"
IMAGEN_AWS="${COPIAS_IMAGEN_AWS:-amazon/aws-cli:2.37.4}"
IMAGEN_AUX="${COPIAS_IMAGEN_AUX:-alpine:3.22.2}"
# Las variables COPIAS_* de rutas existen para las pruebas; en un servidor no se definen.
CONFIG_DIR="${COPIAS_CONFIG_DIR:-/etc/skyway-copias}"
ESTADO_DIR="${COPIAS_ESTADO_DIR:-/var/lib/skyway-copias}"
SYSTEMD_DIR="${COPIAS_SYSTEMD_DIR:-/etc/systemd/system}"
VOLUMEN_CACHE="${COPIAS_VOLUMEN_CACHE:-skyway-copias-cache}"
URL_PANEL="${COPIAS_URL_PANEL:-http://127.0.0.1:4000}"
URL_B2="${COPIAS_URL_B2:-https://api.backblazeb2.com}"
# Todas las instantáneas llevan este «host»: así, tras restaurar en otra
# máquina, las copias siguientes continúan las mismas series (y la
# deduplicación) en lugar de empezar de cero.
HOST_RESTIC="skyway"
UNIDAD="skyway-copias"
UNIDAD_PETICIONES="skyway-copias-peticiones"

# ---------- presentación ----------
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_ACC=$'\033[38;5;99m'; C_OK=$'\033[38;5;42m'; C_WARN=$'\033[38;5;214m'; C_ERR=$'\033[38;5;203m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_ACC=''; C_OK=''; C_WARN=''; C_ERR=''
fi
info() { printf '%s\n' "${C_DIM}$*${C_RESET}" >&2; }
ok()   { printf '%s\n' "${C_OK}✓ $*${C_RESET}" >&2; }
warn() { printf '%s\n' "${C_WARN}! $*${C_RESET}" >&2; }
fallo() { printf '%s\n' "${C_ERR}✗ $*${C_RESET}" >&2; }
ULTIMO_ERROR=''
die()  { ULTIMO_ERROR="$*"; fallo "$*"; exit 1; }
titulo() { printf '\n%s\n' "${C_BOLD}$*${C_RESET}" >&2; }
ASUMIR_SI=0
AUTO=0

confirmar() {
  [[ "$ASUMIR_SI" == 1 ]] && return 0
  local r
  printf '%s %s[s/N]%s ' "$1" "$C_DIM" "$C_RESET" >&2
  read -r r < /dev/tty || return 1
  [[ "$r" =~ ^[sSyY]$ ]]
}

# Pregunta con valor por defecto; la respuesta va a stdout.
preguntar() {
  local texto="$1" defecto="${2:-}" r
  if [[ -n "$defecto" ]]; then
    printf '%s %s[%s]%s: ' "$texto" "$C_DIM" "$defecto" "$C_RESET" >&2
  else
    printf '%s: ' "$texto" >&2
  fi
  read -r r < /dev/tty || die "Cancelado."
  printf '%s' "${r:-$defecto}"
}

preguntar_secreto() {
  local r
  printf '%s: ' "$1" >&2
  read -rs r < /dev/tty || die "Cancelado."
  printf '\n' >&2
  printf '%s' "$r"
}

# Menú numerado: $1 = líneas (una opción por línea, «valor<TAB>texto»), $2 =
# título. Imprime el valor elegido.
elegir() {
  local opciones="$1" titulo_menu="$2" i=1 linea sel
  local -a valores=()
  printf '%s\n' "${C_BOLD}$titulo_menu${C_RESET}" >&2
  while IFS= read -r linea; do
    [[ -n "$linea" ]] || continue
    valores+=("${linea%%$'\t'*}")
    printf '  %s%2d%s  %s\n' "$C_ACC" "$i" "$C_RESET" "${linea#*$'\t'}" >&2
    i=$((i + 1))
  done <<< "$opciones"
  (( ${#valores[@]} > 0 )) || die "No hay nada que elegir."
  printf '  %s›%s ' "$C_ACC" "$C_RESET" >&2
  read -r sel < /dev/tty || die "Cancelado."
  [[ "$sel" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#valores[@]} )) || die "Selección no válida."
  printf '%s' "${valores[sel-1]}"
}

ahora_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# 1234567 → «1,2 MB»: lo que lee una persona en el terminal y en los avisos.
bytes_legibles() {
  awk -v b="${1:-0}" 'BEGIN {
    split("B KB MB GB TB", u, " "); i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    s = (i == 1) ? sprintf("%d %s", b, u[i]) : sprintf("%.1f %s", b, u[i])
    gsub(/\./, ",", s); print s }'
}

duracion_legible() {
  local s="${1:-0}"
  if (( s < 60 )); then printf '%d s' "$s"
  elif (( s < 3600 )); then printf '%d min %d s' $((s / 60)) $((s % 60))
  else printf '%d h %d min' $((s / 3600)) $((s % 3600 / 60)); fi
}

need() { command -v "$1" >/dev/null 2>&1 || die "Falta «$1» en el servidor. Instálalo (p. ej. «apt install $1») y vuelve a intentarlo."; }

exigir_root() {
  [[ "$(id -u)" == 0 ]] || die "Las copias necesitan permisos de administrador del sistema: ejecútalo con sudo («sudo skyway copias …»)."
}

docker_disponible() {
  docker info >/dev/null 2>&1 || die "Docker no responde en este servidor. Arráncalo («systemctl start docker») y vuelve a intentarlo."
}

pkg_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1; }

# a.b.c > x.y.z (versiones semánticas sin sufijos). 0 si $1 es posterior a $2.
version_posterior() {
  [[ -n "$1" && -n "$2" && "$1" != "$2" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" == "$1" ]]
}

# ---------- configuración ----------
#
# config: una clave por línea (CLAVE=valor), sin comillas ni ejecución: se
# lee con un analizador estricto, nunca con «source», porque los valores
# vienen de quien configura y pueden llevar «$» o comillas.
# s3.env: credenciales del S3 en formato --env-file de Docker.
# contrasena: la de restic, en una línea. Los tres, 600 y de root.

CFG_S3_ENDPOINT=''; CFG_S3_REGION=''; CFG_S3_BUCKET=''; CFG_S3_PREFIJO=''; CFG_S3_ESTILO='auto'; CFG_S3_PROVEEDOR=''
CFG_RETENCION_DIARIAS=7; CFG_RETENCION_SEMANALES=4; CFG_RETENCION_MENSUALES=6
CFG_HORA='03:30'; CFG_AVISO_URL=''; CFG_IMAGENES='si'; CFG_EXCLUIR=''
CFG_SKYWAY_DIR=''; CFG_MAILWAY_DIR='auto'; CFG_PAUSA_MAXIMA=900

CLAVES_CONFIG=(S3_ENDPOINT S3_REGION S3_BUCKET S3_PREFIJO S3_ESTILO S3_PROVEEDOR RETENCION_DIARIAS RETENCION_SEMANALES RETENCION_MENSUALES HORA AVISO_URL IMAGENES EXCLUIR SKYWAY_DIR MAILWAY_DIR PAUSA_MAXIMA)

leer_config() {
  local f="$CONFIG_DIR/config" linea clave valor k
  [[ -f "$f" ]] || return 1
  while IFS= read -r linea || [[ -n "$linea" ]]; do
    [[ "$linea" =~ ^[[:space:]]*(#|$) ]] && continue
    clave="${linea%%=*}"; valor="${linea#*=}"
    for k in "${CLAVES_CONFIG[@]}"; do
      if [[ "$clave" == "$k" ]]; then printf -v "CFG_$k" '%s' "$valor"; fi
    done
  done < "$f"
  return 0
}

configuradas() {
  [[ -f "$CONFIG_DIR/config" && -f "$CONFIG_DIR/s3.env" && -s "$CONFIG_DIR/contrasena" ]]
}

# Escribe un fichero de una vez (temporal y renombrado), con los permisos dados.
escribir_atomico() {
  local destino="$1" modo="${2:-600}" tmp
  tmp="$(mktemp "$destino.XXXXXX")" || die "No se ha podido escribir $destino."
  if ! { cat > "$tmp" && chmod "$modo" "$tmp" && mv -f "$tmp" "$destino"; }; then
    rm -f "$tmp"
    die "No se ha podido escribir $destino."
  fi
}

escribir_config() {
  mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
  local k v
  {
    printf '# Copias externas de Skyway (docs/COPIAS.md). Lo escribe «skyway copias configurar».\n'
    printf '# Una clave por línea, sin comillas. Las credenciales van en s3.env y la contraseña en contrasena.\n'
    for k in "${CLAVES_CONFIG[@]}"; do
      v="CFG_$k"
      printf '%s=%s\n' "$k" "${!v}"
    done
  } | escribir_atomico "$CONFIG_DIR/config" 600
}

validar_config() {
  [[ "$CFG_S3_ENDPOINT" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "El endpoint del S3 no es válido (p. ej. https://s3.eu-central-003.backblazeb2.com)."
  [[ "$CFG_S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "El nombre del bucket no es válido (minúsculas, números, puntos y guiones; de 3 a 63 caracteres)."
  [[ "$CFG_S3_PREFIJO" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && "$CFG_S3_PREFIJO" != *..* ]] || die "La carpeta dentro del bucket no es válida (letras, números, «.», «_», «-» y «/»)."
  [[ "$CFG_S3_REGION" =~ ^[a-z0-9-]{1,40}$ ]] || die "La región del S3 no es válida (p. ej. eu-west-1)."
  [[ "$CFG_S3_ESTILO" =~ ^(auto|path|dns)$ ]] || die "S3_ESTILO debe ser auto, path o dns."
  [[ -z "$CFG_S3_PROVEEDOR" || "$CFG_S3_PROVEEDOR" =~ ^(backblaze|otro)$ ]] || die "S3_PROVEEDOR debe ser backblaze, otro o estar vacío."
  [[ "$CFG_HORA" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "La hora debe tener el formato HH:MM."
  local n
  for n in "$CFG_RETENCION_DIARIAS" "$CFG_RETENCION_SEMANALES" "$CFG_RETENCION_MENSUALES" "$CFG_PAUSA_MAXIMA"; do
    [[ "$n" =~ ^[0-9]{1,5}$ ]] || die "Los valores de retención y PAUSA_MAXIMA deben ser números enteros."
  done
  (( CFG_RETENCION_DIARIAS >= 1 )) || die "RETENCION_DIARIAS debe ser al menos 1."
  [[ -z "$CFG_AVISO_URL" || "$CFG_AVISO_URL" =~ ^https://[^[:space:]]+$ ]] || die "AVISO_URL debe empezar por https://."
}

REPO_RESTIC=''
REPO_LOCAL=''
OPCIONES_S3=()

# Descarga una imagen solo si falta, con reintentos: Docker Hub limita las
# descargas (responde 429 un rato) y eso no debe tumbar una copia ni, sobre
# todo, una restauración en un servidor nuevo.
asegurar_imagen() {
  local imagen="$1" espera
  docker image inspect "$imagen" >/dev/null 2>&1 && return 0
  info "Descargando $imagen…"
  for espera in 0 15 45 90; do
    sleep "$espera"
    docker pull -q "$imagen" >/dev/null 2>&1 && return 0
  done
  die "No se ha podido descargar la imagen $imagen (¿hay red hacia Docker Hub?)."
}

cargar_config() {
  if [[ -n "$REPO_LOCAL" ]]; then
    # Restauración desde un kit: el repositorio es una carpeta y solo hace
    # falta la contraseña. La configuración, si existe, aporta lo demás.
    leer_config || true
    [[ -s "$CONFIG_DIR/contrasena" ]] || die "Falta la contraseña de las copias en $CONFIG_DIR/contrasena."
    asegurar_imagen "$IMAGEN_RESTIC"
    return 0
  fi
  configuradas || die "Las copias externas no están configuradas en este servidor. Ejecuta «sudo skyway copias configurar»."
  leer_config
  validar_config
  REPO_RESTIC="s3:${CFG_S3_ENDPOINT}/${CFG_S3_BUCKET}/${CFG_S3_PREFIJO}"
  OPCIONES_S3=(-o "s3.region=$CFG_S3_REGION" -o "s3.bucket-lookup=$CFG_S3_ESTILO")
  asegurar_imagen "$IMAGEN_RESTIC"
}

# Variables de proxy del entorno, si las hay (servidores que solo salen por un
# proxy): restic y la CLI de AWS las respetan.
entorno_proxy() {
  local v
  for v in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do
    if [[ -n "${!v:-}" ]]; then printf -- '-e\n%s\n' "$v"; fi
  done
}

# restic en su contenedor. Uso: restic_ [opciones de docker run] -- [argumentos de restic]
restic_() {
  local -a dopts=() proxy=() entrada=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do dopts+=("$1"); shift; done
  [[ "${1:-}" == "--" ]] && shift
  mapfile -t proxy < <(entorno_proxy)
  # La entrada estándar solo se conecta cuando restic la lee (copias desde
  # una tubería). Si no, un «docker run -i» dentro de un bucle «while read» se
  # quedaría con las líneas que aún no ha leído el bucle.
  local a
  for a in "$@"; do [[ "$a" == --stdin ]] && entrada=(-i); done
  local -a origen_repo=()
  if [[ -n "$REPO_LOCAL" ]]; then
    origen_repo=(-v "$REPO_LOCAL:/repositorio" -e RESTIC_REPOSITORY=/repositorio)
  else
    origen_repo=(--env-file "$CONFIG_DIR/s3.env" -e "RESTIC_REPOSITORY=$REPO_RESTIC")
  fi
  docker run --rm ${entrada[@]+"${entrada[@]}"} --network host \
    "${origen_repo[@]}" \
    -e RESTIC_PASSWORD_FILE=/run/skyway-copias/contrasena \
    -e RESTIC_CACHE_DIR=/cache \
    -e "RESTIC_HOST=$HOST_RESTIC" \
    ${proxy[@]+"${proxy[@]}"} \
    -v "$CONFIG_DIR/contrasena:/run/skyway-copias/contrasena:ro" \
    -v "$VOLUMEN_CACHE:/cache" \
    ${dopts[@]+"${dopts[@]}"} \
    "$IMAGEN_RESTIC" ${OPCIONES_S3[@]+"${OPCIONES_S3[@]}"} "$@"
}

# restic insiste durante muchos minutos si el S3 no responde: bien para un
# corte de un momento a las tres de la mañana, mal para quien espera delante
# del terminal. Antes de empezar, una consulta rápida dice si se llega (con
# cualquier respuesta HTTP, aunque sea un 403: lo que importa es la red).
s3_responde() {
  [[ -n "$REPO_LOCAL" ]] && return 0
  local codigo
  codigo="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' "$CFG_S3_ENDPOINT" 2>/dev/null || true)"
  [[ "$codigo" =~ ^[1-5][0-9][0-9]$ ]]
}

# exigir_conexion [intentos]: la copia programada lo reintenta unos minutos.
exigir_conexion() {
  local intentos="${1:-1}" i
  for ((i = 1; i <= intentos; i++)); do
    s3_responde && return 0
    if (( i < intentos )); then sleep "${COPIAS_PAUSA_CONEXION:-60}"; fi
  done
  die "No se puede conectar con $CFG_S3_ENDPOINT. Comprueba la red del servidor y el endpoint en $CONFIG_DIR/config."
}

# CLI de AWS contra el S3 configurado (operaciones del bucket que restic no hace).
aws_() {
  local -a proxy=()
  mapfile -t proxy < <(entorno_proxy)
  docker run --rm --network host \
    --env-file "${AWS_ENV_FILE:-$CONFIG_DIR/s3.env}" \
    -e "AWS_DEFAULT_REGION=$CFG_S3_REGION" \
    ${proxy[@]+"${proxy[@]}"} \
    "$IMAGEN_AWS" --endpoint-url "$CFG_S3_ENDPOINT" "$@"
}

# Una clave recién creada puede tardar en valer en el API S3 (Backblaze avisa
# de que algunos cambios de claves tardan unos minutos): se espera hasta dos.
esperar_clave_s3() {
  local i
  for i in $(seq 1 24); do
    aws_ s3api head-bucket --bucket "$CFG_S3_BUCKET" >/dev/null 2>&1 && return 0
    if (( i == 1 )); then info "Esperando a que la clave nueva funcione en el S3…"; fi
    if (( i < 24 )); then sleep 5; fi
  done
  warn "La clave nueva aún no funciona en el S3; se sigue igualmente."
  return 0
}

# ---------- Backblaze B2 (API nativo) ----------
#
# El API S3 de Backblaze no crea claves ni reglas de ciclo de vida, y las
# claves que se crean en su web pueden llevar «bypassGovernance»: quien entrara
# en el servidor podría borrar las copias bloqueadas. Con la clave maestra de la
# cuenta (se pide, se usa y no se guarda), el API nativo prepara el bucket y
# crea para el servidor una clave limitada a él y sin ese permiso.

# Lo que necesita restic: leer, escribir y retirar (en Backblaze, ocultar).
# Además, ver el bloqueo y alargar la retención de un fichero, por si el
# proveedor lo pide al subir (acortarla exige bypassGovernance). Nada de
# claves ni de buckets.
CAPACIDADES_B2_SERVIDOR=(listBuckets listAllBucketNames readBuckets listFiles readFiles writeFiles deleteFiles readBucketRetentions readFileRetentions writeFileRetentions)
# recuperar-bucket: además, saltarse el bloqueo en modo governance.
CAPACIDADES_B2_RECUPERAR=("${CAPACIDADES_B2_SERVIDOR[@]}" bypassGovernance)

B2_TOKEN=''; B2_API=''; B2_CUENTA=''; B2_S3=''; B2_BUCKET_ID=''; B2_CICLO_OK=0

es_backblaze() {
  [[ "$CFG_S3_PROVEEDOR" == backblaze || "$CFG_S3_ENDPOINT" =~ ^https://s3\.[a-z0-9-]+\.backblazeb2\.com/?$ ]]
}

# https://s3.eu-central-003.backblazeb2.com → eu-central-003 (la región es la
# segunda parte del nombre). Nada si el endpoint no es de Backblaze.
region_de_endpoint() {
  if [[ "$1" =~ ^https://s3\.([a-z0-9-]+)\.backblazeb2\.com/?$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
  return 0
}

# b2_peticion <url> <línea de configuración de curl> [cuerpo JSON]: imprime la
# respuesta o, si falla, el motivo (y sale con 1): quien llama suele estar en
# una sustitución «$(…)», de la que no vuelve ninguna variable. Las
# credenciales van en un fichero de configuración de curl, nunca en la línea
# de órdenes (las vería cualquiera con «ps»).
b2_peticion() {
  local url="$1" credencial="$2" cuerpo="${3:-}" cfg salida codigo motivo
  cfg="$(mktemp)"; chmod 600 "$cfg"
  printf '%s\n' "$credencial" > "$cfg"
  if [[ -n "$cuerpo" ]]; then
    salida="$(curl -sS -m 60 -K "$cfg" -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' "$url" <<< "$cuerpo" 2>/dev/null || true)"
  else
    salida="$(curl -sS -m 60 -K "$cfg" -w '\n%{http_code}' "$url" 2>/dev/null || true)"
  fi
  rm -f "$cfg"
  codigo="${salida##*$'\n'}"; salida="${salida%$'\n'*}"
  if [[ "$codigo" == 200 ]]; then printf '%s' "$salida"; return 0; fi
  if [[ "$codigo" == 000 || -z "$codigo" ]]; then
    motivo="sin conexión con Backblaze"
  else
    motivo="$(jq -r '.message // empty' <<< "$salida" 2>/dev/null | head -n 1 || true)"
  fi
  printf '%s' "${motivo:-HTTP $codigo}"
  return 1
}

# b2_llamar <operación> <cuerpo JSON>, con el token de b2_autorizar.
b2_llamar() {
  b2_peticion "$B2_API/b2api/v4/$1" "header = \"Authorization: $B2_TOKEN\"" "$2"
}

b2_autorizar() {
  local id="$1" clave="$2" r
  [[ "$id" =~ ^[A-Za-z0-9]+$ && "$clave" =~ ^[A-Za-z0-9+/=_-]+$ ]] \
    || die "La clave de Backblaze no tiene el formato esperado (keyID y applicationKey, sin espacios)."
  r="$(b2_peticion "$URL_B2/b2api/v4/b2_authorize_account" "user = \"$id:$clave\"")" \
    || die "Backblaze no acepta esa clave ($r). Usa la clave maestra: «Application Keys» → «Generate New Master Application Key»."
  B2_TOKEN="$(jq -r '.authorizationToken // empty' <<< "$r")"
  B2_API="$(jq -r '.apiInfo.storageApi.apiUrl // empty' <<< "$r")"
  B2_S3="$(jq -r '.apiInfo.storageApi.s3ApiUrl // empty' <<< "$r")"; B2_S3="${B2_S3%/}"
  B2_CUENTA="$(jq -r '.accountId // empty' <<< "$r")"
  [[ "$B2_TOKEN" =~ ^[A-Za-z0-9+/=_.:-]+$ && "$B2_API" =~ ^https?://[A-Za-z0-9.:-]+$ && -n "$B2_S3" && "$B2_CUENTA" =~ ^[A-Za-z0-9]+$ ]] \
    || die "Respuesta inesperada de Backblaze al autorizar la clave."
  jq -e '.apiInfo.storageApi.allowed.capabilities | index("writeKeys")' >/dev/null <<< "$r" \
    || die "Esa clave no puede crear claves: usa la clave maestra («Application Keys» → «Generate New Master Application Key»)."
}

# Identificador del bucket configurado (vacío si no existe en la cuenta).
b2_id_bucket() {
  local r
  r="$(b2_llamar b2_list_buckets "$(jq -nc --arg a "$B2_CUENTA" --arg b "$CFG_S3_BUCKET" '{accountId: $a, bucketName: $b, bucketTypes: ["all"]}')")" \
    || die "Backblaze: no se han podido consultar los buckets ($r)."
  jq -c '.buckets[0] // empty' <<< "$r"
}

# Busca el bucket (o lo crea, privado y con bloqueo de objetos) y se asegura de
# la retención por defecto y de la regla que borra lo que las copias retiran
# de la carpeta de este servidor. Sin esa regla, Backblaze lo guardaría (y lo
# cobraría) para siempre.
b2_preparar_bucket() {
  local r bucket carpeta="$CFG_S3_PREFIJO/"
  bucket="$(b2_id_bucket)"
  if [[ -z "$bucket" ]]; then
    bucket="$(b2_llamar b2_create_bucket "$(jq -nc --arg a "$B2_CUENTA" --arg b "$CFG_S3_BUCKET" --arg p "$carpeta" \
      '{accountId: $a, bucketName: $b, bucketType: "allPrivate", fileLockEnabled: true,
        lifecycleRules: [{fileNamePrefix: $p, daysFromHidingToDeleting: 31, daysFromUploadingToHiding: null}]}')")" \
      || die "Backblaze: no se ha podido crear el bucket «$CFG_S3_BUCKET» ($bucket). El nombre es único en todo Backblaze: si lo usa otra cuenta, elige otro."
    ok "Bucket «$CFG_S3_BUCKET» creado: privado y con bloqueo de objetos."
  elif [[ "$(jq -r '.bucketType' <<< "$bucket")" != allPrivate ]]; then
    warn "El bucket «$CFG_S3_BUCKET» no es privado: las copias van cifradas, pero conviene que lo sea («Bucket Settings» en la web de Backblaze)."
  fi
  B2_BUCKET_ID="$(jq -r '.bucketId // empty' <<< "$bucket")"
  [[ "$B2_BUCKET_ID" =~ ^[A-Za-z0-9]+$ ]] || die "Respuesta inesperada de Backblaze: el bucket no tiene identificador."

  if ! jq -e '.fileLockConfiguration.value.isFileLockEnabled == true' >/dev/null <<< "$bucket"; then
    if r="$(b2_llamar b2_update_bucket "$(jq -nc --arg a "$B2_CUENTA" --arg i "$B2_BUCKET_ID" '{accountId: $a, bucketId: $i, fileLockEnabled: true}')")"; then
      bucket="$r"; ok "Bloqueo de objetos activado en el bucket."
    else
      warn "No se ha podido activar el bloqueo de objetos ($r): sin él, quien entrara en el servidor podría borrar las copias."
    fi
  fi
  if jq -e '.fileLockConfiguration.value.isFileLockEnabled == true' >/dev/null <<< "$bucket"; then
    if jq -e '.fileLockConfiguration.value.defaultRetention.mode // empty' >/dev/null <<< "$bucket"; then
      ok "Bloqueo de objetos: $(jq -r '.fileLockConfiguration.value.defaultRetention | "\(.period.duration) \(if .period.unit == "years" then "años" else "días" end), modo \(.mode)"' <<< "$bucket")."
    elif r="$(b2_llamar b2_update_bucket "$(jq -nc --arg a "$B2_CUENTA" --arg i "$B2_BUCKET_ID" \
        '{accountId: $a, bucketId: $i, defaultRetention: {mode: "governance", period: {duration: 30, unit: "days"}}}')")"; then
      bucket="$r"; ok "Bloqueo de objetos: 30 días, modo governance."
    else
      warn "No se ha podido fijar la retención por defecto ($r): ponla en la web de Backblaze (bucket → «Object Lock»: governance, 30 días)."
    fi
  fi

  # Backblaze no admite dos reglas que se crucen: se respeta la que ya cubra la
  # carpeta si borra lo retirado, y si no hay ninguna se añade la de la carpeta.
  local cruzadas reglas
  # (Cada regla se ata a $r: dentro de startswith(…), «.» sería la carpeta.)
  cruzadas="$(jq -c --arg p "$carpeta" '[(.lifecycleRules // [])[] | . as $r | select(($p | startswith($r.fileNamePrefix)) or ($r.fileNamePrefix | startswith($p)))]' <<< "$bucket")"
  if jq -e --arg p "$carpeta" 'any(.[]; . as $r | ($p | startswith($r.fileNamePrefix)) and (($r.daysFromHidingToDeleting // 0) > 0))' >/dev/null <<< "$cruzadas"; then
    B2_CICLO_OK=1
    ok "Lo que las copias retiran se borra del todo a los $(jq -r --arg p "$carpeta" '[.[] | . as $r | select($p | startswith($r.fileNamePrefix)) | select(($r.daysFromHidingToDeleting // 0) > 0)][0].daysFromHidingToDeleting' <<< "$cruzadas") días (regla de Backblaze)."
  elif [[ "$(jq 'length' <<< "$cruzadas")" != 0 ]]; then
    warn "Una regla de ciclo de vida del bucket se cruza con la carpeta «$carpeta» y no borra lo retirado: revísala en la web de Backblaze («Lifecycle Settings») o lo que las copias retiran seguirá ocupando, y costando."
  else
    reglas="$(jq -c --arg p "$carpeta" '(.lifecycleRules // []) + [{fileNamePrefix: $p, daysFromHidingToDeleting: 31, daysFromUploadingToHiding: null}]' <<< "$bucket")"
    if r="$(b2_llamar b2_update_bucket "$(jq -nc --arg a "$B2_CUENTA" --arg i "$B2_BUCKET_ID" --argjson l "$reglas" '{accountId: $a, bucketId: $i, lifecycleRules: $l}')")"; then
      B2_CICLO_OK=1; ok "Lo que las copias retiran se borra del todo a los 31 días (regla de Backblaze)."
    else
      warn "No se ha podido crear la regla de ciclo de vida ($r): en la web de Backblaze, bucket → «Lifecycle Settings» → «Keep prior versions for this number of days»: 31."
    fi
  fi
}

# b2_crear_clave <nombre> <segundos de validez o vacío> <capacidades…>: una
# clave solo para el bucket de B2_BUCKET_ID. Imprime «id<TAB>clave».
b2_crear_clave() {
  local nombre="$1" duracion="$2" r ak sk; shift 2
  r="$(b2_llamar b2_create_key "$(jq -nc --arg a "$B2_CUENTA" --arg n "$nombre" --arg d "$duracion" --arg b "$B2_BUCKET_ID" \
    '{accountId: $a, keyName: $n, capabilities: $ARGS.positional, bucketIds: [$b]}
     + (if $d == "" then {} else {validDurationInSeconds: ($d | tonumber)} end)' --args "$@")")" \
    || die "Backblaze: no se ha podido crear la clave «$nombre» ($r)."
  ak="$(jq -r '.applicationKeyId // empty' <<< "$r")"; sk="$(jq -r '.applicationKey // empty' <<< "$r")"
  [[ -n "$ak" && -n "$sk" && "$ak$sk" != *[[:space:]]* ]] || die "Backblaze no ha devuelto la clave «$nombre»."
  printf '%s\t%s' "$ak" "$sk"
}

b2_borrar_clave() {
  local r
  if r="$(b2_llamar b2_delete_key "$(jq -nc --arg k "$1" '{applicationKeyId: $k}')")"; then
    ok "Clave temporal de Backblaze borrada."
  else
    warn "No se ha podido borrar la clave temporal $1 ($r): caduca sola en una hora, o bórrala en «Application Keys»."
  fi
}

# «configurar» con Backblaze: $1 = carpeta por defecto, $2 = 1 si ya estaba
# configurado con Backblaze (se reutiliza el bucket y se avisa de la clave anterior).
configurar_backblaze() {
  local prefijo_defecto="$1" era_b2="$2" id clave par ak sk anterior='' nombre bucket_defecto
  info "En la web de Backblaze: «Application Keys» → «Generate New Master Application Key». La clave maestra solo se usa ahora (prepara el bucket y crea una clave limitada para este servidor) y no se guarda aquí. Guárdala en tu gestor de contraseñas: hace falta para «recuperar-bucket»."
  id="$(preguntar 'keyID de la clave maestra')"
  clave="$(preguntar_secreto 'applicationKey de la clave maestra')"
  b2_autorizar "$id" "$clave"
  CFG_S3_ENDPOINT="$B2_S3"
  CFG_S3_REGION="$(region_de_endpoint "$CFG_S3_ENDPOINT")"
  [[ -n "$CFG_S3_REGION" ]] || CFG_S3_REGION="$(preguntar 'Región del S3' us-east-1)"
  ok "Cuenta de Backblaze: $CFG_S3_ENDPOINT"
  [[ "$CFG_S3_REGION" == eu-* ]] || warn "La cuenta de Backblaze está en $CFG_S3_REGION, fuera de la Unión Europea. La región se elige al crear la cuenta: para guardar en la UE, crea otra con «EU Central»."
  bucket_defecto="skyway-copias-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  if [[ "$era_b2" == 1 && -n "$CFG_S3_BUCKET" ]]; then bucket_defecto="$CFG_S3_BUCKET"; fi
  CFG_S3_BUCKET="$(preguntar 'Bucket (se crea si no existe; el nombre es único en todo Backblaze)' "$bucket_defecto")"
  CFG_S3_PREFIJO="$(preguntar 'Carpeta dentro del bucket (una por servidor)' "$prefijo_defecto")"
  CFG_S3_ESTILO="${CFG_S3_ESTILO:-auto}"
  validar_config
  b2_preparar_bucket
  if [[ "$era_b2" == 1 && -f "$CONFIG_DIR/s3.env" ]]; then anterior="$(sed -n 's/^AWS_ACCESS_KEY_ID=//p' "$CONFIG_DIR/s3.env")"; fi
  nombre="skyway-copias-$(hostname -s 2>/dev/null | tr -cd 'A-Za-z0-9-' | cut -c1-60 || true)"
  nombre="${nombre%-}"
  par="$(b2_crear_clave "$nombre" '' "${CAPACIDADES_B2_SERVIDOR[@]}")"
  ak="${par%%$'\t'*}"; sk="${par#*$'\t'}"
  mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
  printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$ak" "$sk" | escribir_atomico "$CONFIG_DIR/s3.env" 600
  ok "Clave «$nombre» creada solo para este bucket, sin permiso para saltarse el bloqueo."
  if [[ -n "$anterior" && "$anterior" != "$ak" ]]; then
    info "La clave anterior de este servidor ($anterior) sigue activa en Backblaze: bórrala en «Application Keys» si ya no se usa."
  fi
  esperar_clave_s3
}

# ---------- estado (para el terminal, el panel y la siguiente ejecución) ----------

mkdir_estado() {
  mkdir -p "$ESTADO_DIR/ejecuciones" "$ESTADO_DIR/trabajo" && chmod 700 "$ESTADO_DIR"
}

# Carpeta «copias» dentro del volumen de datos de Skyway (la que lee el panel),
# o nada si no se puede localizar.
DIR_PANEL=''
localizar_dir_panel() {
  [[ -n "$VOL_DATOS" ]] || return 0
  local mp
  mp="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL_DATOS" 2>/dev/null)" || return 0
  [[ -n "$mp" && -d "$mp" ]] || return 0
  DIR_PANEL="$mp/copias"
  mkdir -p "$DIR_PANEL/peticiones" "$DIR_PANEL/kits" 2>/dev/null || DIR_PANEL=''
}

reflejar_en_panel() {
  local f="$1"
  [[ -n "$DIR_PANEL" && -f "$ESTADO_DIR/$f" ]] || return 0
  cp "$ESTADO_DIR/$f" "$DIR_PANEL/.$f.tmp" 2>/dev/null && mv -f "$DIR_PANEL/.$f.tmp" "$DIR_PANEL/$f" 2>/dev/null || true
}

# estado_set '<filtro jq>' [argumentos de jq…]: aplica el filtro a estado.json.
estado_set() {
  local filtro="$1"; shift
  local f="$ESTADO_DIR/estado.json" actual
  actual="$(cat "$f" 2>/dev/null || true)"
  if ! jq -e 'type == "object"' >/dev/null 2>&1 <<< "$actual"; then actual='{}'; fi
  jq "$@" --arg ahora "$(ahora_iso)" --argjson formato "$FORMATO" \
    "($filtro) | .formato = \$formato | .actualizado = \$ahora" <<< "$actual" | escribir_atomico "$f" 600
  reflejar_en_panel estado.json
}

# Lo que el panel muestra de la configuración (sin secretos).
estado_base() {
  local proxima='' activa=false
  if [[ -f "$SYSTEMD_DIR/$UNIDAD.timer" ]]; then
    activa=true
    proxima="$(systemctl show "$UNIDAD.timer" -p NextElapseUSecRealtime --value 2>/dev/null || true)"
    if [[ -n "$proxima" ]]; then proxima="$(date -u -d "$proxima" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"; fi
  fi
  estado_set '.configuradas = true
    | .destino = {endpoint: $e, bucket: $b, prefijo: $p}
    | .programacion = {activa: $activa, hora: $hora, proxima: (if $proxima == "" then null else $proxima end)}' \
    --arg e "$CFG_S3_ENDPOINT" --arg b "$CFG_S3_BUCKET" --arg p "$CFG_S3_PREFIJO" \
    --argjson activa "$activa" --arg hora "$CFG_HORA" --arg proxima "$proxima"
}

en_curso() {
  estado_set '.enCurso = {accion: $a, inicio: $i, paso: $p, pid: ($pid | tonumber)}' \
    --arg a "$1" --arg i "$(ahora_iso)" --arg p "${2:-}" --arg pid "$$"
}

paso() {
  info "$1"
  estado_set 'if .enCurso then .enCurso.paso = $p else . end' --arg p "$1"
}

fin_en_curso() { estado_set '.enCurso = null'; }

# ---------- cerrojo y limpieza ----------

PAUSADOS=()
PARADOS=()
CONTENEDOR_PASADA=''
TRABAJO=''

reanudar_contenedores() {
  local c
  for c in ${PAUSADOS[@]+"${PAUSADOS[@]}"}; do
    docker unpause "$c" >/dev/null 2>&1 || warn "No se ha podido reanudar el contenedor $c: revísalo con «docker ps»."
  done
  PAUSADOS=()
  for c in ${PARADOS[@]+"${PARADOS[@]}"}; do
    docker start "$c" >/dev/null 2>&1 || warn "No se ha podido arrancar de nuevo el contenedor $c: revísalo con «docker ps -a»."
  done
  PARADOS=()
}

COPIA_EN_MARCHA=0
INICIO_COPIA=''
ALCANCE_COPIA=''
MOTIVO_COPIA=''

al_salir() {
  local codigo=$?
  if [[ -n "$CONTENEDOR_PASADA" ]]; then docker kill "$CONTENEDOR_PASADA" >/dev/null 2>&1 || true; fi
  # Lo primero: ningún servicio se queda en pausa ni parado por una copia
  # cortada (Ctrl-C, un fallo, systemd que la detiene).
  reanudar_contenedores
  mantenimiento_mailway off
  # Una copia que se corta a medias (el S3 no responde, falta espacio…) queda
  # como fallida en el estado y se avisa, igual que una incompleta: si no, el
  # panel seguiría mostrando la anterior como la última.
  if [[ "$COPIA_EN_MARCHA" == 1 && "$codigo" != 0 ]]; then
    COPIA_EN_MARCHA=0
    local motivo_fallo="${ULTIMO_ERROR:-la copia se ha interrumpido (código $codigo)}"
    estado_set '.ultima = {id: (if $id == "" then null else $id end), inicio: $ini, fin: $fin, resultado: "fallida", motivo: $m, alcance: $a,
        detalle: $d, avisos: [], elementos: 0, bytesNuevos: 0, duracionS: 0}' \
      --arg id "$ID_EJECUCION" --arg ini "$INICIO_COPIA" --arg fin "$(ahora_iso)" --arg m "$MOTIVO_COPIA" --arg a "$ALCANCE_COPIA" \
      --arg d "$motivo_fallo" 2>/dev/null || true
    notificar error "La copia externa${ID_EJECUCION:+ $ID_EJECUCION} no ha terminado: $motivo_fallo" || true
  fi
  if [[ -n "$TRABAJO" && -d "$TRABAJO" ]]; then rm -rf "$TRABAJO"; fi
  if [[ -f "$ESTADO_DIR/estado.json" ]] && jq -e --arg pid "$$" '.enCurso.pid == ($pid | tonumber)' "$ESTADO_DIR/estado.json" >/dev/null 2>&1; then
    fin_en_curso 2>/dev/null || true
  fi
  return "$codigo"
}
trap al_salir EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Una sola operación a la vez (la copia nocturna, una del panel, un kit, una
# restauración): dos a la vez se pisarían los contenedores en pausa.
tomar_cerrojo() {
  local esperar="${1:-no}"
  mkdir_estado
  exec 8>>"$ESTADO_DIR/cerrojo"
  if [[ "$esperar" == si ]]; then
    flock -w 21600 8 || die "Otra operación de copias lleva más de 6 horas en curso."
  elif ! flock -n 8; then
    die "Ya hay otra operación de copias en curso (puede ser la copia programada). Espera a que termine; «sudo skyway copias estado» muestra cuál."
  fi
}

nuevo_trabajo() {
  TRABAJO="$(mktemp -d "$ESTADO_DIR/trabajo/XXXXXX")"
}

# ---------- localizar Skyway y Mailway ----------

SKYWAY_DIR=''
PROYECTO_COMPOSE=''
VOL_DATOS=''
VOL_CERTS=''
IMAGEN_SKYWAY=''
SKYWAY_EN_MARCHA=0

# Nombre de proyecto que daría Compose a una carpeta: minúsculas y solo
# letras, números, «-» y «_».
nombre_compose() { basename "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-'; }

montaje_de() { docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}{{end}}{{end}}" "$1" 2>/dev/null || true; }

localizar_skyway() {
  local etiqueta_dir=''
  if docker inspect skyway >/dev/null 2>&1; then
    PROYECTO_COMPOSE="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' skyway 2>/dev/null || true)"
    etiqueta_dir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' skyway 2>/dev/null || true)"
    VOL_DATOS="$(montaje_de skyway /data)"
    IMAGEN_SKYWAY="$(docker inspect -f '{{.Config.Image}}' skyway 2>/dev/null || true)"
    [[ "$(docker inspect -f '{{.State.Running}}' skyway 2>/dev/null)" == true ]] && SKYWAY_EN_MARCHA=1
  fi
  if docker inspect skyway-traefik >/dev/null 2>&1; then
    VOL_CERTS="$(montaje_de skyway-traefik /letsencrypt)"
  fi
  SKYWAY_DIR="${CFG_SKYWAY_DIR:-}"
  if [[ -z "$SKYWAY_DIR" && -n "$etiqueta_dir" && -f "$etiqueta_dir/docker-compose.yml" ]]; then SKYWAY_DIR="$etiqueta_dir"; fi
  if [[ -z "$SKYWAY_DIR" ]]; then SKYWAY_DIR="$(cd "$DIR_COPIAS/../.." 2>/dev/null && pwd)"; fi
  if [[ -z "$PROYECTO_COMPOSE" ]]; then
    PROYECTO_COMPOSE="$(sed -n 's/^[[:space:]]*COMPOSE_PROJECT_NAME[[:space:]]*=[[:space:]]*//p' "$SKYWAY_DIR/.env" 2>/dev/null | tail -n 1 | tr -d "\"' " || true)"
    PROYECTO_COMPOSE="${PROYECTO_COMPOSE:-$(nombre_compose "$SKYWAY_DIR")}"
  fi
  if [[ -z "$VOL_DATOS" ]] && docker volume inspect "${PROYECTO_COMPOSE}_skyway-data" >/dev/null 2>&1; then VOL_DATOS="${PROYECTO_COMPOSE}_skyway-data"; fi
  if [[ -z "$VOL_CERTS" ]] && docker volume inspect "${PROYECTO_COMPOSE}_traefik-letsencrypt" >/dev/null 2>&1; then VOL_CERTS="${PROYECTO_COMPOSE}_traefik-letsencrypt"; fi
  if [[ -z "$IMAGEN_SKYWAY" ]] && docker image inspect "${PROYECTO_COMPOSE}-skyway" >/dev/null 2>&1; then IMAGEN_SKYWAY="${PROYECTO_COMPOSE}-skyway"; fi
  localizar_dir_panel
}

MAILWAY_DIR=''

localizar_mailway() {
  MAILWAY_DIR=''
  local d="${CFG_MAILWAY_DIR:-auto}"
  [[ "$d" == no ]] && return 0
  if [[ "$d" != auto && -n "$d" ]]; then
    [[ -d "$d/deploy" ]] && MAILWAY_DIR="$d"
    return 0
  fi
  local enlace
  enlace="$(readlink -f /usr/local/bin/mailway 2>/dev/null || true)"
  if [[ -n "$enlace" && -f "$enlace" ]]; then
    d="$(cd "$(dirname "$enlace")/.." 2>/dev/null && pwd)"
    [[ -d "$d/deploy" ]] && { MAILWAY_DIR="$d"; return 0; }
  fi
  d="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' mailway-mail 2>/dev/null || true)"
  if [[ -n "$d" && -d "$d" ]]; then
    d="$(cd "$d/.." 2>/dev/null && pwd)"
    [[ -d "$d/deploy" ]] && MAILWAY_DIR="$d"
  fi
  return 0
}

# Inventario de Skyway (proyectos, servicios, volúmenes, volcados): lo da el
# propio Skyway con su herramienta, que conoce su modelo de datos. Si el panel
# está parado, se lanza la misma herramienta con su imagen sobre el volumen de
# datos. stdout: el JSON; nada si no se puede.
inventario_skyway() {
  local salida=''
  if [[ "$SKYWAY_EN_MARCHA" == 1 ]]; then
    salida="$(docker exec skyway node server/dist/tools/copias.js inventario 2>/dev/null)" || salida=''
  fi
  if [[ -z "$salida" && -n "$IMAGEN_SKYWAY" && -n "$VOL_DATOS" && "$SKYWAY_EN_MARCHA" != 1 ]]; then
    salida="$(docker run --rm --network none --entrypoint node -e DATA_DIR=/data -v "$VOL_DATOS:/data" "$IMAGEN_SKYWAY" server/dist/tools/copias.js inventario 2>/dev/null)" || salida=''
  fi
  if [[ -n "$salida" ]] && jq -e '.formato == 1 and .producto == "skyway" and (.proyectos | type == "array")' >/dev/null 2>&1 <<< "$salida"; then
    printf '%s' "$salida"
  fi
}

# Sin la herramienta (Skyway roto o anterior a las copias externas), lo que se
# deduce de Docker: los contenedores de Skyway llevan su proyecto y su
# servicio en etiquetas. No hay nombres ni volcados, pero ningún volumen se
# queda sin copiar.
inventario_generico() {
  local filas
  filas="$(docker ps -a --filter label=skyway.managed=true --format '{{.Names}}' 2>/dev/null | while read -r c; do
    [[ -n "$c" ]] || continue
    docker inspect -f '{{json .}}' "$c" 2>/dev/null | jq -c '{c: (.Name | ltrimstr("/")), p: (.Config.Labels["skyway.project"] // ""), s: (.Config.Labels["skyway.service"] // ""),
      v: [.Mounts[] | select(.Type == "volume" and (.Name | test("^[0-9a-f]{64}$") | not)) | .Name]}'
  done || true)"
  jq -s --arg version "$(pkg_version "$SKYWAY_DIR/package.json")" '
    map(select(.p != "" and .s != "")) as $f
    | {formato: 1, producto: "skyway", version: $version, generico: true, ajustes: {},
       proyectos: ($f | group_by(.p) | map({id: .[0].p, nombre: .[0].p, slug: .[0].p, cliente: null,
         servicios: (group_by(.s) | map({id: .[0].s, nombre: .[0].s, slug: .[0].s, tipo: null, plantilla: null,
           versionPlantilla: null, detenido: false, contenedores: (map(.c) | unique),
           volumenes: (map(.v[]) | unique), volcado: null, despliegue: null, imagen: null}))}))}' <<< "${filas:-}"
}

inventario_mailway() {
  [[ -n "$MAILWAY_DIR" ]] || return 0
  if [[ ! -f "$MAILWAY_DIR/deploy/copias.sh" ]]; then
    warn "Mailway ($MAILWAY_DIR) no tiene deploy/copias.sh (versión anterior a las copias externas): sus volúmenes se copian como volúmenes sin regla. Actualiza Mailway con «mailway update»."
    return 0
  fi
  local salida
  salida="$(bash "$MAILWAY_DIR/deploy/copias.sh" inventario 2>/dev/null)" || salida=''
  if [[ -n "$salida" ]] && jq -e '.formato == 1 and .producto == "mailway" and (.volumenes | type == "array")' >/dev/null 2>&1 <<< "$salida"; then
    printf '%s' "$salida"
  else
    warn "No se ha podido leer el inventario de Mailway («bash $MAILWAY_DIR/deploy/copias.sh inventario»): sus volúmenes se copian como volúmenes sin regla."
  fi
}

info_git() {
  local dir="$1"
  [[ -d "$dir/.git" ]] || { printf 'null'; return 0; }
  local commit rama origen
  commit="$(git -c safe.directory="$dir" -C "$dir" rev-parse HEAD 2>/dev/null || true)"
  rama="$(git -c safe.directory="$dir" -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  origen="$(git -c safe.directory="$dir" -C "$dir" remote get-url origin 2>/dev/null || true)"
  # Una URL con credenciales (https://usuario:token@…) no se guarda tal cual.
  origen="$(printf '%s' "$origen" | sed -E 's#(https?://)[^/@]*@#\1#')"
  jq -cn --arg c "$commit" --arg r "$rama" --arg o "$origen" \
    '{commit: (if $c == "" then null else $c end), rama: (if $r == "" or $r == "HEAD" then null else $r end), origen: (if $o == "" then null else $o end)}'
}

# ---------- plan de la copia ----------
#
# El plan es una lista de elementos (JSON, uno por línea) que se ejecutan en
# orden. Sale de los inventarios y de «docker volume ls»: lo que ningún
# inventario reclama se copia como «sin regla» y se avisa.

INV_SKYWAY=''
INV_MAILWAY=''

volumenes_excluidos() {
  # La caché de restic y la de BuildKit se regeneran solas.
  printf '%s\n' "$VOLUMEN_CACHE"
  docker volume ls -q 2>/dev/null | grep -E '^buildx_buildkit_.*_state$' || true
  local v
  for v in $CFG_EXCLUIR; do printf '%s\n' "$v"; done
}

plan_copia() {
  local alcance="$1"
  local todos excluidos
  todos="$(docker volume ls -q 2>/dev/null | grep -Ev '^[0-9a-f]{64}$' || true)"
  excluidos="$(volumenes_excluidos | sort -u)"
  jq -nc \
    --arg alcance "$alcance" \
    --arg datos "$VOL_DATOS" --arg certs "$VOL_CERTS" \
    --argjson sky "${INV_SKYWAY:-null}" --argjson mw "${INV_MAILWAY:-null}" \
    --arg todos "$todos" --arg excluidos "$excluidos" \
    --arg imagenes "$CFG_IMAGENES" '
    ($todos | split("\n") | map(select(. != ""))) as $existen
    | ($excluidos | split("\n") | map(select(. != ""))) as $fuera
    | (($sky.proyectos // [])) as $proyectos
    | ($mw.panel.contenedor // "") as $panel_ctr
    | [ $proyectos[] | . as $p | .servicios[] | select((.contenedores // []) | index($panel_ctr)) | .volumenes[] ] as $vol_panel
    | ($alcance | if startswith("proyecto:") then .[9:] else null end) as $solo_proyecto
    | def incluye_sistema: ($alcance == "todo" or $alcance == "skyway");
      def incluye_correo: ($alcance == "todo" or $alcance == "correo");
      def incluye_proyecto($id): ($alcance == "todo" or $solo_proyecto == $id);
    [
      {tipo: "config"},
      {tipo: "codigo"},
      (if incluye_sistema and $datos != "" then {tipo: "volumen", nombre: $datos, origen: "sistema", rol: "datos-skyway", consistencia: "pausar",
         excluir: ["builds", "copias"]} else empty end),
      (if incluye_sistema and $certs != "" then {tipo: "volumen", nombre: $certs, origen: "sistema", rol: "certificados", consistencia: "pausar"} else empty end),
      ( $proyectos[] | . as $p | select(incluye_proyecto($p.id)) | .servicios[] | . as $s
        | ( ($s.volumenes // [])[] | . as $v | select((incluye_correo and ($vol_panel | index($v))) | not)
            | {tipo: "volumen", nombre: ., origen: "skyway", proyecto: $p.id, servicio: $s.id, consistencia: "pausar"} ),
          ( if $s.volcado then {tipo: "volcado", proyecto: $p.id, servicio: $s.id, contenedores: $s.contenedores,
              plantilla: $s.plantilla, versionPlantilla: $s.versionPlantilla, orden: $s.volcado.orden,
              restaurar: $s.volcado.restaurar, extension: $s.volcado.extension} else empty end ),
          ( if $imagenes == "si" and $s.tipo == "git" and $s.despliegue and $s.despliegue.imagen
            then {tipo: "imagen", proyecto: $p.id, servicio: $s.id, imagen: $s.despliegue.imagen, despliegue: $s.despliegue.id}
            else empty end ) ),
      ( if incluye_correo then
          ( ($vol_panel | unique)[] | {tipo: "volumen", nombre: ., origen: "mailway", rol: "panel", consistencia: "pausar"} ),
          ( ($mw.volumenes // [])[] | {tipo: "volumen", nombre: .nombre, origen: "mailway", rol: .rol, consistencia: .consistencia} )
        else empty end )
    ] as $plan
    | ($plan | map(select(.tipo == "volumen") | .nombre)) as $reclamados
    | ([ $proyectos[] | .servicios[] | .volumenes[]? ] + [ ($mw.volumenes // [])[] | .nombre ] + [ ($mw.ignorados // [])[] | .nombre ] + [$datos, $certs]) as $conocidos
    | $plan + (
        if $alcance == "todo" then
          [ $existen[] | . as $n | select((($conocidos + $fuera) | index($n)) | not)
            | {tipo: "volumen", nombre: ., origen: "sin-regla", consistencia: "pausar"} ]
        else [] end )
    # Un volumen que dos servicios comparten se copia una vez.
    | reduce .[] as $e ({vistos: [], lista: []};
        if $e.tipo == "volumen" then
          if (.vistos | index($e.nombre)) then . else .vistos += [$e.nombre] | .lista += [$e] end
        else .lista += [$e] end)
    | .lista[]
    | select(.tipo != "volumen" or (.nombre as $n | $existen | index($n)))'
}

# ---------- ejecución de cada elemento ----------

ID_EJECUCION=''
ETIQUETAS_BASE=''
OLVIDAR=()
AVISOS=()
FALLOS=0
BYTES_NUEVOS=0

registrar() { printf '%s\n' "$1" >> "$TRABAJO/elementos.jsonl"; }

# Ejecuta «restic backup … --json» y deja en RESULTADO_RESTIC la línea de
# resumen (snapshot_id, data_added…). Devuelve el código de restic. La salida
# va a un fichero y no a una variable: así la segunda pasada, que corre en
# segundo plano para poder cortarla, se lee igual.
RESULTADO_RESTIC=''
backup_json() {
  local f codigo=0
  f="$(mktemp "${TRABAJO:-$ESTADO_DIR}/restic.XXXXXX")"
  restic_ "$@" > "$f" || codigo=$?
  leer_resumen "$f" "$codigo"
}

leer_resumen() {
  local f="$1" codigo="$2"
  RESULTADO_RESTIC="$(grep -F '"message_type":"summary"' "$f" 2>/dev/null | tail -n 1 | jq -c . 2>/dev/null || true)"
  rm -f "$f"
  if [[ -z "$RESULTADO_RESTIC" && "$codigo" == 0 ]]; then codigo=1; fi
  return "$codigo"
}

campo_resultado() { jq -r ".$1 // empty" <<< "$RESULTADO_RESTIC"; }
# Igual, para números: 0 si falta.
num_resultado() { local v; v="$(campo_resultado "$1")"; printf '%s' "${v:-0}"; }

etiquetas() { printf '%s,tipo:%s' "$ETIQUETAS_BASE" "$1"; }

copiar_carpeta() {
  # copiar_carpeta <carpeta local> <ruta en la copia> <tipo>
  local local_="$1" ruta="$2" tipo="$3"
  backup_json -v "$local_:$ruta:ro" -- backup "$ruta" --json --tag "$(etiquetas "$tipo")" --host "$HOST_RESTIC"
}

elemento_config() {
  local dir="$TRABAJO/config"
  mkdir -p "$dir/skyway" "$dir/copias" "$dir/sistema"
  local f
  for f in .env docker-compose.override.yml; do
    if [[ -f "$SKYWAY_DIR/$f" ]]; then cp -p "$SKYWAY_DIR/$f" "$dir/skyway/$f"; fi
  done
  guardar_git "$SKYWAY_DIR" "$dir/skyway"
  if [[ -n "$INV_MAILWAY" ]]; then
    mkdir -p "$dir/mailway"
    local fichero
    while IFS= read -r fichero; do
      [[ -n "$fichero" && -f "$fichero" ]] || continue
      cp -p "$fichero" "$dir/mailway/$(basename "$fichero")"
    done < <(jq -r '.ficheros[]? // empty' <<< "$INV_MAILWAY")
    guardar_git "$MAILWAY_DIR" "$dir/mailway"
  fi
  cp -p "$CONFIG_DIR/config" "$dir/copias/config"
  jq -n --arg h "$(hostname 2>/dev/null || true)" --arg os "$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}")" \
    --arg kernel "$(uname -r)" --arg docker "$(docker version -f '{{.Server.Version}}' 2>/dev/null || true)" \
    --arg ips "$(hostname -I 2>/dev/null || true)" --arg fecha "$(ahora_iso)" \
    '{nombre: $h, sistema: $os, nucleo: $kernel, docker: $docker, ips: ($ips | split(" ") | map(select(. != ""))), fecha: $fecha}' \
    > "$dir/sistema/servidor.json"
  copiar_carpeta "$dir" /elementos/config config
}

guardar_git() {
  local repo="$1" dest="$2"
  [[ -d "$repo/.git" ]] || return 0
  local g=(git -c safe.directory="$repo" -C "$repo")
  {
    printf 'commit: %s\n' "$("${g[@]}" rev-parse HEAD 2>/dev/null || true)"
    printf 'rama: %s\n' "$("${g[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    printf '\n'
    "${g[@]}" status --short 2>/dev/null || true
  } > "$dest/git.txt"
  # Los retoques locales del operador (un docker-compose.yml cambiado a mano)
  # viajan como parche y se reaplican al restaurar.
  "${g[@]}" diff HEAD --binary > "$dest/cambios-locales.patch" 2>/dev/null || true
  [[ -s "$dest/cambios-locales.patch" ]] || rm -f "$dest/cambios-locales.patch"
}

elemento_codigo() {
  local dir="$TRABAJO/codigo"
  mkdir -p "$dir/copias"
  local hay=0
  if empaquetar_git "$SKYWAY_DIR" "$dir/skyway.bundle"; then hay=1; fi
  if [[ -n "$MAILWAY_DIR" ]] && empaquetar_git "$MAILWAY_DIR" "$dir/mailway.bundle"; then hay=1; fi
  # El propio código de las copias, suelto: el arranque en limpio
  # (restaurar.sh) lo usa sin tener que reconstruir el repositorio.
  cp -pR "$DIR_COPIAS/." "$dir/copias/"
  (( hay )) || AVISOS+=("No se ha podido empaquetar el código (git): se restaurará clonando de GitHub.")
  copiar_carpeta "$dir" /elementos/codigo codigo
}

empaquetar_git() {
  local repo="$1" dest="$2"
  [[ -d "$repo/.git" ]] || return 1
  local g=(git -c safe.directory="$repo" -C "$repo") rama
  rama="$("${g[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -n "$rama" && "$rama" != HEAD ]]; then
    "${g[@]}" bundle create "$dest" HEAD "$rama" >/dev/null 2>&1 || return 1
  else
    "${g[@]}" bundle create "$dest" HEAD >/dev/null 2>&1 || return 1
  fi
}

# Mientras el motor de correo está parado, el panel de Mailway en modo
# mantenimiento: su vigilante no lo toma por una caída (deploy/copias.sh de
# Mailway; si no tiene la orden, no pasa nada).
MANTENIMIENTO_MAILWAY=0
mantenimiento_mailway() {
  [[ -n "$MAILWAY_DIR" && -f "$MAILWAY_DIR/deploy/copias.sh" ]] || return 0
  if [[ "$1" == on ]]; then
    bash "$MAILWAY_DIR/deploy/copias.sh" mantenimiento on >/dev/null 2>&1 && MANTENIMIENTO_MAILWAY=1
  elif [[ "$MANTENIMIENTO_MAILWAY" == 1 ]]; then
    bash "$MAILWAY_DIR/deploy/copias.sh" mantenimiento off >/dev/null 2>&1 || true
    MANTENIMIENTO_MAILWAY=0
  fi
  return 0
}

# Contenedores en marcha que usan un volumen (id y nombre).
usuarios_volumen() { docker ps --filter "volume=$1" --format '{{.ID}} {{.Names}}' 2>/dev/null || true; }

suspender_usuarios() {
  # suspender_usuarios <volumen> <pausar|parar>
  local vol="$1" modo="$2" id nombre pausado
  while read -r id nombre; do
    [[ -n "$id" ]] || continue
    if [[ "$modo" == parar ]]; then
      info "    · Parando $nombre durante la segunda pasada…"
      # Con margen para que cierre su base limpia (el motor de correo, RocksDB).
      if docker stop -t 120 "$id" >/dev/null 2>&1; then PARADOS+=("$id"); else warn "No se ha podido parar $nombre: se copia sin pararlo."; fi
    else
      pausado="$(docker inspect -f '{{.State.Paused}}' "$id" 2>/dev/null || true)"
      # Uno que ya estaba en pausa lo dejó así alguien: no se toca.
      [[ "$pausado" == true ]] && continue
      if docker pause "$id" >/dev/null 2>&1; then PAUSADOS+=("$id"); else warn "No se ha podido pausar $nombre: se copia sin pausa."; fi
    fi
  done < <(usuarios_volumen "$vol")
}

elemento_volumen() {
  local e="$1" vol consistencia ruta
  vol="$(jq -r '.nombre' <<< "$e")"
  consistencia="$(jq -r '.consistencia // "pausar"' <<< "$e")"
  ruta="/volumenes/$vol"
  local -a excl=()
  local x
  while IFS= read -r x; do [[ -n "$x" ]] && excl+=(--exclude "$ruta/$x"); done < <(jq -r '.excluir[]? // empty' <<< "$e")
  local etiquetas_vol
  etiquetas_vol="$(docker volume inspect -f '{{json .Labels}}' "$vol" 2>/dev/null || echo null)"
  jq -e 'type == "object" or . == null' >/dev/null 2>&1 <<< "$etiquetas_vol" || etiquetas_vol=null

  local codigo=0 s1 s2='' estado=ok detalle=''
  backup_json -v "$vol:$ruta:ro" -- backup "$ruta" --json --tag "$(etiquetas volumen)" --host "$HOST_RESTIC" ${excl[@]+"${excl[@]}"} || codigo=$?
  s1="$(campo_resultado snapshot_id)"
  if [[ -z "$s1" ]]; then
    FALLOS=$((FALLOS + 1))
    registrar "$(jq -c --arg d "restic no ha podido copiar el volumen (código $codigo)" '. + {estado: "fallido", detalle: $d}' <<< "$e")"
    fallo "  No se ha podido copiar el volumen $vol."
    return 0
  fi
  [[ "$codigo" == 3 ]] && { estado=parcial; detalle="Algunos ficheros no se han podido leer."; }
  local pasadas=1 nuevos total
  nuevos="$(campo_resultado data_added)"; total="$(campo_resultado total_bytes_processed)"
  if [[ "$consistencia" != en-caliente && -n "$(usuarios_volumen "$vol")" ]]; then
    if [[ "$consistencia" == parar && "$(jq -r '.origen' <<< "$e")" == mailway ]]; then mantenimiento_mailway on; fi
    suspender_usuarios "$vol" "$( [[ "$consistencia" == parar ]] && echo parar || echo pausar )"
    if (( ${#PAUSADOS[@]} + ${#PARADOS[@]} > 0 )); then
      local inicio_pausa=$SECONDS codigo2=0 f2 pid
      CONTENEDOR_PASADA="skyway-copias-pasada-$$"
      f2="$(mktemp "$TRABAJO/pasada.XXXXXX")"
      # En segundo plano para poder cortarla: los servicios no se quedan en
      # pausa más de PAUSA_MAXIMA segundos aunque restic se atasque.
      restic_ --name "$CONTENEDOR_PASADA" -v "$vol:$ruta:ro" -- backup "$ruta" --json --tag "$(etiquetas volumen)" \
        --host "$HOST_RESTIC" --parent "$s1" ${excl[@]+"${excl[@]}"} > "$f2" &
      pid=$!
      while kill -0 "$pid" 2>/dev/null; do
        if (( SECONDS - inicio_pausa > CFG_PAUSA_MAXIMA )); then
          docker kill "$CONTENEDOR_PASADA" >/dev/null 2>&1 || true
          break
        fi
        sleep 1
      done
      wait "$pid" || codigo2=$?
      CONTENEDOR_PASADA=''
      reanudar_contenedores
      mantenimiento_mailway off
      info "    · Servicios reanudados tras $(duracion_legible $((SECONDS - inicio_pausa)))."
      if leer_resumen "$f2" "$codigo2" || [[ "$codigo2" == 3 ]]; then
        s2="$(campo_resultado snapshot_id)"
      fi
      if [[ -n "$s2" ]]; then
        OLVIDAR+=("$s1")
        s1="$s2"; pasadas=2
        nuevos=$(( ${nuevos:-0} + $(num_resultado data_added) ))
        total="$(campo_resultado total_bytes_processed)"
      else
        estado=parcial
        detalle="La segunda pasada no ha terminado a tiempo (PAUSA_MAXIMA=${CFG_PAUSA_MAXIMA}s): la copia es de la primera pasada, en caliente."
        AVISOS+=("Volumen $vol: $detalle")
      fi
    fi
  fi
  BYTES_NUEVOS=$((BYTES_NUEVOS + ${nuevos:-0}))
  registrar "$(jq -c --arg s "$s1" --arg est "$estado" --arg det "$detalle" --argjson et "$etiquetas_vol" \
    --argjson pasadas "$pasadas" --argjson b "${total:-0}" --argjson n "${nuevos:-0}" \
    '. + {ruta: ("/volumenes/" + .nombre), snapshot: $s, estado: $est, detalle: (if $det == "" then null else $det end),
          etiquetas: $et, pasadas: $pasadas, bytes: $b, bytesNuevos: $n} | del(.excluir)' <<< "$e")"
  ok "  $vol $( [[ $pasadas == 2 ]] && echo '(dos pasadas)' ) · $(bytes_legibles "${total:-0}") · $(bytes_legibles "${nuevos:-0}") nuevos"
}

# El volcado va directo de la base a restic, sin pasar por el disco: una base
# grande no necesita espacio libre del mismo tamaño en el servidor.
elemento_volcado() {
  local e="$1" svc ctr orden ext
  svc="$(jq -r '.servicio' <<< "$e")"; orden="$(jq -r '.orden' <<< "$e")"; ext="$(jq -r '.extension' <<< "$e")"
  ctr=''
  local c
  while IFS= read -r c; do
    [[ -n "$c" ]] || continue
    if [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" == true ]]; then ctr="$c"; break; fi
  done < <(jq -r '.contenedores[]? // empty' <<< "$e")
  if [[ -z "$ctr" ]]; then
    registrar "$(jq -c '. + {estado: "omitido", detalle: "La base no estaba en marcha: queda su volumen."}' <<< "$e")"
    info "  Volcado de $svc: la base no está en marcha; queda la copia de su volumen."
    return 0
  fi
  local ruta="volcados/$svc/volcado.$ext" codigos f
  f="$(mktemp "$TRABAJO/restic.XXXXXX")"
  local -a st=()
  # En el lado izquierdo de «||», un fallo de la tubería no corta el script
  # (set -e) y PIPESTATUS dice qué parte ha fallado.
  { docker exec "$ctr" sh -c "$orden" 2>"$TRABAJO/volcado.err" | gzip -c \
      | restic_ -- backup --stdin --stdin-filename "$ruta" --json --tag "$(etiquetas volcado)" --host "$HOST_RESTIC" > "$f"
    st=("${PIPESTATUS[@]}"); } || true
  codigos="${st[*]:-}"
  leer_resumen "$f" 0 || true
  local s; s="$(campo_resultado snapshot_id)"
  if [[ "$codigos" != "0 0 0" || -z "$s" ]]; then
    [[ -n "$s" ]] && OLVIDAR+=("$s")
    FALLOS=$((FALLOS + 1))
    local det; det="$(head -c 300 "$TRABAJO/volcado.err" 2>/dev/null | tr '\n' ' ' || true)"
    registrar "$(jq -c --arg d "El volcado ha fallado (${codigos:-sin código}). ${det}" '. + {estado: "fallido", detalle: $d}' <<< "$e")"
    fallo "  Volcado de $svc: ha fallado. ${det}"
    return 0
  fi
  local nuevos total
  nuevos="$(campo_resultado data_added)"; total="$(campo_resultado total_bytes_processed)"
  BYTES_NUEVOS=$((BYTES_NUEVOS + ${nuevos:-0}))
  registrar "$(jq -c --arg s "$s" --arg r "/$ruta" --argjson b "${total:-0}" --argjson n "${nuevos:-0}" \
    '. + {ruta: $r, snapshot: $s, estado: "ok", bytes: $b, bytesNuevos: $n} | del(.orden)' <<< "$e")"
  ok "  Volcado de $svc ($(jq -r '.plantilla' <<< "$e")) · $(bytes_legibles "${total:-0}")"
}

elemento_imagen() {
  local e="$1" svc img
  svc="$(jq -r '.servicio' <<< "$e")"; img="$(jq -r '.imagen' <<< "$e")"
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    registrar "$(jq -c '. + {estado: "omitido", detalle: "La imagen ya no está en el servidor."}' <<< "$e")"
    return 0
  fi
  local ruta="imagenes/$svc/imagen.tar" codigos f
  f="$(mktemp "$TRABAJO/restic.XXXXXX")"
  local -a st=()
  { docker save "$img" 2>/dev/null \
      | restic_ -- backup --stdin --stdin-filename "$ruta" --json --tag "$(etiquetas imagen)" --host "$HOST_RESTIC" > "$f"
    st=("${PIPESTATUS[@]}"); } || true
  codigos="${st[*]:-}"
  leer_resumen "$f" 0 || true
  local s; s="$(campo_resultado snapshot_id)"
  if [[ "$codigos" != "0 0" || -z "$s" ]]; then
    [[ -n "$s" ]] && OLVIDAR+=("$s")
    AVISOS+=("No se ha podido copiar la imagen $img: al restaurar, ese servicio se reconstruye desde su repositorio.")
    registrar "$(jq -c '. + {estado: "fallido", detalle: "docker save ha fallado."}' <<< "$e")"
    warn "  Imagen $img: no se ha podido copiar."
    return 0
  fi
  local nuevos total
  nuevos="$(campo_resultado data_added)"; total="$(campo_resultado total_bytes_processed)"
  BYTES_NUEVOS=$((BYTES_NUEVOS + ${nuevos:-0}))
  registrar "$(jq -c --arg s "$s" --arg r "/$ruta" --argjson b "${total:-0}" --argjson n "${nuevos:-0}" \
    '. + {ruta: $r, snapshot: $s, estado: "ok", bytes: $b, bytesNuevos: $n}' <<< "$e")"
  ok "  Imagen $img · $(bytes_legibles "${total:-0}") · $(bytes_legibles "${nuevos:-0}") nuevos"
}

# ---------- copia ----------

cmd_copia() {
  local alcance="todo" motivo="manual" simular=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --alcance) alcance="${2:-}"; shift;;
      --motivo) motivo="${2:-}"; shift;;
      --simular) simular=1;;
      *) die "Opción desconocida para «copia»: $1";;
    esac
    shift
  done
  [[ "$alcance" =~ ^(todo|skyway|correo|proyecto:prj_[a-z0-9]{1,64})$ ]] || die "Alcance no válido: «$alcance» (todo, skyway, correo o proyecto:<id>)."
  [[ "$motivo" =~ ^(programada|manual|panel|antes-de-actualizar)$ ]] || die "Motivo no válido: «$motivo»."
  exigir_root; need jq; need git; docker_disponible
  cargar_config
  tomar_cerrojo
  COPIA_EN_MARCHA=1; INICIO_COPIA="$(ahora_iso)"; ALCANCE_COPIA="$alcance"; MOTIVO_COPIA="$motivo"
  localizar_skyway
  localizar_mailway
  estado_base
  exigir_conexion "$( [[ "$AUTO" == 1 ]] && echo 5 || echo 1 )"

  INV_SKYWAY="$(inventario_skyway)"
  if [[ -z "$INV_SKYWAY" ]]; then
    warn "No se ha podido leer el inventario de Skyway con su herramienta (¿panel parado o versión anterior?): se copian sus volúmenes deducidos de Docker, sin volcados."
    INV_SKYWAY="$(inventario_generico)"
  fi
  if [[ "$alcance" == todo || "$alcance" == correo ]]; then INV_MAILWAY="$(inventario_mailway)"; fi
  if [[ "$alcance" == correo && -z "$INV_MAILWAY" ]]; then die "No se encuentra Mailway en este servidor: no hay correo que copiar."; fi
  if [[ "$alcance" == proyecto:* ]] && ! jq -e --arg id "${alcance#proyecto:}" '.proyectos | any(.id == $id)' >/dev/null <<< "$INV_SKYWAY"; then
    die "No existe el proyecto ${alcance#proyecto:} en Skyway."
  fi

  local plan
  plan="$(plan_copia "$alcance")"
  if [[ "$simular" == 1 ]]; then
    COPIA_EN_MARCHA=0
    printf '%s\n' "$plan"
    return 0
  fi

  ID_EJECUCION="$(date -u +%Y%m%d-%H%M%S)"
  ETIQUETAS_BASE="skyway-copias,ejecucion:$ID_EJECUCION"
  local inicio inicio_s=$SECONDS
  inicio="$(ahora_iso)"
  nuevo_trabajo
  : > "$TRABAJO/elementos.jsonl"
  en_curso copia "Preparando la copia"
  titulo "Copia $ID_EJECUCION ($alcance) → $CFG_S3_BUCKET/$CFG_S3_PREFIJO"

  asegurar_repositorio

  local e tipo n=0 total
  total="$(printf '%s\n' "$plan" | grep -c '^{' || true)"
  while IFS= read -r e; do
    [[ -n "$e" ]] || continue
    n=$((n + 1))
    tipo="$(jq -r '.tipo' <<< "$e")"
    case "$tipo" in
      config) paso "[$n/$total] Configuración"; elemento_config_registrado "$e";;
      codigo) paso "[$n/$total] Código"; elemento_codigo_registrado "$e";;
      volumen)
        paso "[$n/$total] Volumen $(jq -r '.nombre' <<< "$e")"
        [[ "$(jq -r '.origen' <<< "$e")" == sin-regla ]] && AVISOS+=("Volumen sin regla copiado: $(jq -r '.nombre' <<< "$e") (no lo declara Skyway ni Mailway).")
        elemento_volumen "$e";;
      volcado) paso "[$n/$total] Volcado de $(jq -r '.servicio' <<< "$e")"; elemento_volcado "$e";;
      imagen) paso "[$n/$total] Imagen $(jq -r '.imagen' <<< "$e")"; elemento_imagen "$e";;
    esac
  done <<< "$plan"

  paso "Manifiesto"
  local resultado=correcta
  (( ${#AVISOS[@]} > 0 )) && resultado=con-avisos
  (( FALLOS > 0 )) && resultado=incompleta
  escribir_manifiesto "$alcance" "$motivo" "$inicio" "$resultado"

  if (( ${#OLVIDAR[@]} > 0 )); then
    restic_ -- forget ${OLVIDAR[@]+"${OLVIDAR[@]}"} >/dev/null 2>&1 || warn "No se han podido retirar las instantáneas intermedias: se retirarán en el próximo mantenimiento."
  fi

  local dur=$((SECONDS - inicio_s))
  local res_estado=correcta
  [[ "$resultado" == con-avisos ]] && res_estado=con-avisos
  [[ "$resultado" == incompleta ]] && res_estado=fallida
  local elementos; elementos="$(grep -c '^{' "$TRABAJO/elementos.jsonl" || true)"
  local avisos_json; avisos_json="$(printf '%s\n' ${AVISOS[@]+"${AVISOS[@]}"} | jq -R . | jq -sc 'map(select(. != ""))')"
  estado_set '.ultima = {id: $id, inicio: $ini, fin: $fin, resultado: $r, motivo: $m, alcance: $a, detalle: $d, avisos: $av,
      elementos: ($el | tonumber), bytesNuevos: ($bn | tonumber), duracionS: ($dur | tonumber)}
    | if $r != "fallida" then .ultimaCorrecta = {id: $id, fin: $fin} else . end' \
    --arg id "$ID_EJECUCION" --arg ini "$inicio" --arg fin "$(ahora_iso)" --arg r "$res_estado" --arg m "$motivo" --arg a "$alcance" \
    --arg d "$elementos elementos, $(bytes_legibles "$BYTES_NUEVOS") nuevos, en $(duracion_legible "$dur")" \
    --argjson av "$avisos_json" --arg el "$elementos" --arg bn "$BYTES_NUEVOS" --arg dur "$dur"
  # La copia ya está hecha y anotada: lo que falle a partir de aquí
  # (mantenimiento, lista) no la convierte en fallida.
  COPIA_EN_MARCHA=0

  ( actualizar_lista ) || warn "No se ha podido actualizar la lista de copias."
  if [[ "$motivo" == programada ]]; then
    # En un subshell: un «die» dentro no corta la copia ya terminada.
    ( mantenimiento_programado ) || warn "El mantenimiento del repositorio ha fallado; se reintentará en la próxima copia."
  fi
  limpiar_kits_caducados

  local a
  for a in ${AVISOS[@]+"${AVISOS[@]}"}; do warn "$a"; done
  if [[ "$res_estado" == fallida ]]; then
    fallo "Copia $ID_EJECUCION incompleta: $FALLOS elementos no se han podido copiar. Revisa los mensajes de arriba."
    notificar error "La copia externa $ID_EJECUCION ha quedado incompleta: $FALLOS elementos no se han podido copiar. Detalle: journalctl -u $UNIDAD."
    return 1
  fi
  ok "Copia $ID_EJECUCION terminada: $elementos elementos, $(bytes_legibles "$BYTES_NUEVOS") nuevos, en $(duracion_legible "$dur")."
  notificar ok ""
  return 0
}

# config y código no fallan la copia entera: se registran con su resultado.
elemento_config_registrado() {
  local e="$1"
  if elemento_config; then
    registrar "$(jq -c --arg s "$(campo_resultado snapshot_id)" '. + {ruta: "/elementos/config", snapshot: $s, estado: "ok"}' <<< "$e")"
    ok "  Configuración (.env de Skyway y Mailway, estado de git)"
  else
    FALLOS=$((FALLOS + 1)); registrar "$(jq -c '. + {estado: "fallido"}' <<< "$e")"; fallo "  No se ha podido copiar la configuración."
  fi
}

elemento_codigo_registrado() {
  local e="$1"
  if elemento_codigo; then
    registrar "$(jq -c --arg s "$(campo_resultado snapshot_id)" '. + {ruta: "/elementos/codigo", snapshot: $s, estado: "ok"}' <<< "$e")"
    ok "  Código (Skyway$( [[ -n "$MAILWAY_DIR" ]] && echo ' y Mailway') y herramientas de copias)"
  else
    FALLOS=$((FALLOS + 1)); registrar "$(jq -c '. + {estado: "fallido"}' <<< "$e")"; fallo "  No se ha podido copiar el código."
  fi
}

escribir_manifiesto() {
  local alcance="$1" motivo="$2" inicio="$3" resultado="$4"
  local dir="$TRABAJO/manifiesto"
  mkdir -p "$dir"
  local ipv4
  ipv4="$(jq -r '.ajustes.serverIp // empty' <<< "$INV_SKYWAY" 2>/dev/null || true)"
  local avisos_json; avisos_json="$(printf '%s\n' ${AVISOS[@]+"${AVISOS[@]}"} | jq -R . | jq -sc 'map(select(. != ""))')"
  jq -s \
    --argjson formato "$FORMATO" --arg id "$ID_EJECUCION" --arg ini "$inicio" --arg fin "$(ahora_iso)" \
    --arg motivo "$motivo" --arg alcance "$alcance" --arg resultado "$resultado" \
    --arg host "$(hostname 2>/dev/null || true)" --arg ipv4 "$ipv4" \
    --arg vsky "$(pkg_version "$SKYWAY_DIR/package.json")" --argjson gsky "$(info_git "$SKYWAY_DIR")" \
    --arg dsky "$SKYWAY_DIR" --arg pcompose "$PROYECTO_COMPOSE" --arg vdatos "$VOL_DATOS" --arg vcerts "$VOL_CERTS" \
    --argjson invsky "${INV_SKYWAY:-null}" --argjson invmw "${INV_MAILWAY:-null}" \
    --argjson gmw "$( [[ -n "$MAILWAY_DIR" ]] && info_git "$MAILWAY_DIR" || echo null)" --arg dmw "$MAILWAY_DIR" \
    --arg restic "$VERSION_RESTIC" --argjson avisos "$avisos_json" '
    {
      formato: $formato,
      herramienta: {version: $vsky, restic: $restic},
      ejecucion: $id, inicio: $ini, fin: $fin, motivo: $motivo, alcance: $alcance, resultado: $resultado,
      servidor: {nombre: $host, ipv4: (if $ipv4 == "" then null else $ipv4 end)},
      skyway: {version: $vsky, git: $gsky, ruta: $dsky, proyectoCompose: $pcompose,
               volumenes: {datos: (if $vdatos == "" then null else $vdatos end), certificados: (if $vcerts == "" then null else $vcerts end)},
               inventario: $invsky},
      mailway: (if $invmw == null then null else ($invmw + {git: ($gmw // $invmw.git), ruta: $dmw}) end),
      elementos: .,
      avisos: $avisos
    }' "$TRABAJO/elementos.jsonl" > "$dir/manifiesto.json"
  cp "$dir/manifiesto.json" "$ESTADO_DIR/ejecuciones/$ID_EJECUCION.json"
  local vmw=''
  [[ -n "$INV_MAILWAY" ]] && vmw="$(jq -r '.version // empty' <<< "$INV_MAILWAY")"
  local tags
  tags="$(etiquetas manifiesto),motivo:$motivo,alcance:$alcance,resultado:$resultado,version-skyway:$(pkg_version "$SKYWAY_DIR/package.json")"
  [[ -n "$vmw" ]] && tags+=",version-mailway:$vmw"
  if ! backup_json -v "$dir:/elementos/manifiesto:ro" -- backup /elementos/manifiesto --json --tag "$tags" --host "$HOST_RESTIC"; then
    FALLOS=$((FALLOS + 1))
    fallo "No se ha podido subir el manifiesto: esta copia no aparecerá en la lista."
  fi
}

# Inicia el repositorio si aún no existe (la primera copia tras configurar).
asegurar_repositorio() {
  local salida codigo=0
  salida="$(restic_ -- cat config 2>&1 >/dev/null)" || codigo=$?
  case "$codigo" in
    0) return 0;;
    10) info "Iniciando el repositorio de copias en el bucket…"
        restic_ -- init >/dev/null || die "No se ha podido iniciar el repositorio de copias."
        return 0;;
    12) die "La contraseña de las copias no abre el repositorio del bucket. ¿Se cambió $CONFIG_DIR/contrasena?";;
    *) die "No se puede acceder al repositorio de copias (código $codigo): ${salida%%$'\n'*}";;
  esac
}

notificar() {
  # notificar ok|error <mensaje>: ping al vigilante externo (AVISO_URL) y, en
  # un fallo de una copia programada, aviso por los canales del panel.
  local tipo="$1" mensaje="${2:-}"
  if [[ -n "$CFG_AVISO_URL" ]] && command -v curl >/dev/null 2>&1; then
    local url="$CFG_AVISO_URL"
    [[ "$tipo" == error ]] && url="${CFG_AVISO_URL%/}/fail"
    curl -fsS -m 10 --retry 2 -o /dev/null "$url" 2>/dev/null || warn "No se ha podido avisar al vigilante externo (AVISO_URL)."
  fi
  if [[ "$tipo" == error && "$AUTO" == 1 && "$SKYWAY_EN_MARCHA" == 1 ]]; then
    docker exec skyway node server/dist/tools/aviso.js --nivel error --titulo 'Copias externas' --mensaje "$mensaje" >/dev/null 2>&1 \
      || warn "No se ha podido enviar el aviso por los canales del panel."
  fi
  return 0
}

# ---------- lista de ejecuciones ----------

# Todas las instantáneas de las copias (una sola consulta al bucket).
INSTANTANEAS=''
leer_instantaneas() {
  INSTANTANEAS="$(restic_ -- snapshots --json --tag skyway-copias 2>/dev/null)" || die "No se ha podido leer la lista de copias del bucket."
  jq -e 'type == "array"' >/dev/null 2>&1 <<< "$INSTANTANEAS" || INSTANTANEAS='[]'
}

# Ejecuciones con manifiesto, de la más reciente a la más antigua.
JQ_EJECUCIONES='
  def tag($p): (.tags // []) | map(select(startswith($p))) | first | if . then .[($p | length):] else null end;
  (map(select(tag("ejecucion:") != null)) | group_by(tag("ejecucion:"))) as $grupos
  | [ $grupos[] | (map(select((.tags // []) | index("tipo:manifiesto"))) | sort_by(.time) | last) as $m
      | select($m != null)
      | { id: ($m | tag("ejecucion:")), fecha: $m.time, motivo: ($m | tag("motivo:")), alcance: ($m | tag("alcance:")),
          resultado: ($m | tag("resultado:")), manifiesto: $m.id,
          elementos: ((map(select((.tags // []) | index("tipo:manifiesto") | not)) | length)),
          tamano: (map(.summary.total_bytes_processed // 0) | add),
          versiones: {skyway: ($m | tag("version-skyway:")), mailway: ($m | tag("version-mailway:"))} } ]
  | sort_by(.id) | reverse'

actualizar_lista() {
  leer_instantaneas
  local ejecuciones
  ejecuciones="$(jq -c "$JQ_EJECUCIONES" <<< "$INSTANTANEAS")"
  # Proyectos y correo salen de los manifiestos guardados en local (los de
  # las copias hechas desde este servidor); los que falten se dejan vacíos.
  local cache='{}' f id
  for f in "$ESTADO_DIR"/ejecuciones/*.json; do
    [[ -f "$f" ]] || continue
    id="$(basename "$f" .json)"
    if jq -e --arg id "$id" 'any(.[]; .id == $id)' >/dev/null 2>&1 <<< "$ejecuciones"; then
      cache="$(jq -c --arg id "$id" --slurpfile m "$f" '. + {($id): {proyectos: [($m[0].skyway.inventario.proyectos // [])[] | {id, nombre, slug}], correo: ($m[0].mailway != null)}}' <<< "$cache")"
    else
      rm -f "$f"
    fi
  done
  jq -n --argjson f "$FORMATO" --arg ahora "$(ahora_iso)" --argjson e "$ejecuciones" --argjson c "$cache" \
    '{formato: $f, actualizado: $ahora, ejecuciones: [ $e[] | . + {proyectos: ($c[.id].proyectos // []), correo: ($c[.id].correo // null)} | del(.manifiesto) ]}' \
    | escribir_atomico "$ESTADO_DIR/ejecuciones.json" 600
  reflejar_en_panel ejecuciones.json
}

cmd_lista() {
  local json=0
  [[ "${1:-}" == --json ]] && json=1
  exigir_root; need jq; docker_disponible
  cargar_config
  exigir_conexion
  leer_instantaneas
  local ej
  ej="$(jq -c "$JQ_EJECUCIONES" <<< "$INSTANTANEAS")"
  if [[ "$json" == 1 ]]; then printf '%s\n' "$ej"; return 0; fi
  if [[ "$(jq 'length' <<< "$ej")" == 0 ]]; then info "Todavía no hay ninguna copia en $CFG_S3_BUCKET/$CFG_S3_PREFIJO."; return 0; fi
  printf '%s\n' "${C_BOLD}Copias en $CFG_S3_BUCKET/$CFG_S3_PREFIJO${C_RESET} ${C_DIM}(horas en UTC)${C_RESET}"
  jq -r '.[] | "\(.id)\t\(.fecha[0:16] | sub("T"; " "))\t\(.alcance)\t\(.motivo)\t\(.resultado)\t\(.tamano)\t\(.versiones.skyway // "?")\t\(.versiones.mailway // "—")"' <<< "$ej" \
    | while IFS=$'\t' read -r id fecha alcance motivo resultado tam vs vm; do
        printf '  %s  %s  %-22s %-20s %-11s %10s  skyway %s · mailway %s\n' "$id" "$fecha" "$alcance" "$motivo" "$resultado" "$(bytes_legibles "$tam")" "$vs" "$vm"
      done
}

# ---------- elegir una ejecución y leer su manifiesto ----------

MANIFIESTO=''
EJECUCION=''

# elegir_ejecucion <requisito> <id o vacío> <fecha o vacía> [interactivo]
# requisito: todo | skyway | correo | proyecto:<id> | cualquiera
elegir_ejecucion() {
  local req="$1" id="${2:-}" fecha="${3:-}" interactivo="${4:-no}"
  [[ -n "$INSTANTANEAS" ]] || leer_instantaneas
  local ej candidatas
  ej="$(jq -c "$JQ_EJECUCIONES" <<< "$INSTANTANEAS")"
  candidatas="$(jq -c --arg req "$req" '[ .[] | select(.resultado != "incompleta" or ($req == "cualquiera"))
      | select($req == "cualquiera" or .alcance == "todo" or .alcance == $req
               or ($req | startswith("proyecto:")) and .alcance == $req) ]' <<< "$ej")"
  if [[ -n "$id" ]]; then
    [[ "$id" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die "Identificador de copia no válido: «$id» (formato AAAAMMDD-HHMMSS)."
    EJECUCION="$(jq -r --arg id "$id" '.[] | select(.id == $id) | .id' <<< "$ej")"
    [[ -n "$EJECUCION" ]] || die "No existe la copia $id. Consulta las disponibles con «sudo skyway copias lista»."
  elif [[ -n "$fecha" ]]; then
    [[ "$fecha" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "La fecha debe tener el formato AAAA-MM-DD."
    EJECUCION="$(jq -r --arg d "${fecha//-/}" '[ .[] | select(.id | startswith($d)) ] | first | .id // empty' <<< "$candidatas")"
    [[ -n "$EJECUCION" ]] || die "No hay ninguna copia válida del $fecha (UTC) para esto. Consulta las disponibles con «sudo skyway copias lista»."
  elif [[ "$interactivo" == si ]]; then
    local opciones
    opciones="$(jq -r '.[:30][] | "\(.id)\t\(.fecha[0:16] | sub("T"; " ")) UTC · \(.alcance) · \(.motivo) · \(.resultado)"' <<< "$candidatas")"
    [[ -n "$opciones" ]] || die "No hay ninguna copia válida para esto."
    EJECUCION="$(elegir "$opciones" "¿De qué copia?")"
  else
    EJECUCION="$(jq -r 'first | .id // empty' <<< "$candidatas")"
    [[ -n "$EJECUCION" ]] || die "No hay ninguna copia válida para esto todavía."
  fi
  cargar_manifiesto "$EJECUCION"
}

cargar_manifiesto() {
  local id="$1" snap
  MANIFIESTO="$ESTADO_DIR/ejecuciones/$id.json"
  if [[ -f "$MANIFIESTO" ]] && jq -e --arg id "$id" '.ejecucion == $id' "$MANIFIESTO" >/dev/null 2>&1; then return 0; fi
  snap="$(jq -r --arg id "$id" '[ .[] | select((.tags // []) | (index("tipo:manifiesto") and index("ejecucion:" + $id))) ] | sort_by(.time) | last | .id // empty' <<< "$INSTANTANEAS")"
  [[ -n "$snap" ]] || die "No se encuentra el manifiesto de la copia $id."
  mkdir_estado
  restic_ -- dump "$snap" /elementos/manifiesto/manifiesto.json > "$MANIFIESTO.tmp" 2>/dev/null \
    && jq -e '.formato' "$MANIFIESTO.tmp" >/dev/null 2>&1 && mv -f "$MANIFIESTO.tmp" "$MANIFIESTO" \
    || { rm -f "$MANIFIESTO.tmp"; die "No se ha podido leer el manifiesto de la copia $id."; }
  local f; f="$(jq -r '.formato' "$MANIFIESTO")"
  if (( f > FORMATO )); then
    die "La copia $id es de una versión más nueva de las herramientas de copias (formato $f; esta entiende hasta el $FORMATO). Restaura con el restaurar.sh de esa copia o actualiza Skyway."
  fi
}

cmd_ver() {
  local id="${1:-}"
  exigir_root; need jq; docker_disponible
  cargar_config
  exigir_conexion
  if [[ -z "$id" ]]; then elegir_ejecucion cualquiera '' '' si; else elegir_ejecucion cualquiera "$id" ''; fi
  jq -r '
    def tam: if . >= 1073741824 then "\((. / 107374182.4 | floor) / 10) GB" elif . >= 1048576 then "\((. / 104857.6 | floor) / 10) MB" else "\(. / 1024 | floor) KB" end;
    "Copia \(.ejecucion) · \(.alcance) · \(.motivo) · \(.resultado)",
    "  Inicio: \(.inicio)   Fin: \(.fin)",
    "  Servidor: \(.servidor.nombre // "?")\(if .servidor.ipv4 then " (" + .servidor.ipv4 + ")" else "" end)",
    "  Skyway \(.skyway.version // "?") (commit \((.skyway.git.commit // "?")[0:7]))\(if .mailway then " · Mailway \(.mailway.version // "?") (motor \(.mailway.motor.serie // "?"))" else "" end)",
    "",
    "  Proyectos:",
    ((.skyway.inventario.proyectos // [])[] | "    · \(.nombre) (\(.slug)): \([.servicios[] | .slug] | join(", "))"),
    "",
    "  Elementos:",
    (.elementos[] | "    \(if .estado == "ok" then "✓" elif .estado == "omitido" then "·" else "!" end) \(.tipo) \(.nombre // .servicio // .imagen // "")\(if .bytes then " · " + (.bytes | tam) else "" end)\(if .detalle then " — " + .detalle else "" end)"),
    (if (.avisos | length) > 0 then "", "  Avisos:", (.avisos[] | "    ! " + .) else empty end)' "$MANIFIESTO"
}

# ---------- restaurar ----------

instantanea_de() {
  # instantanea_de <filtro jq sobre los elementos> → id de la instantánea
  jq -r "[.elementos[] | select(.snapshot != null and (.estado == \"ok\" or .estado == \"parcial\")) | select($1)] | first | .snapshot // empty" "$MANIFIESTO"
}

# Contenedores (en marcha o no) que montan un volumen.
contenedores_de_volumen() { docker ps -a --filter "volume=$1" --format '{{.ID}}' 2>/dev/null || true; }

PARADOS_RESTAURACION=()

parar_para_restaurar() {
  local id
  for id in "$@"; do
    [[ -n "$id" ]] || continue
    if [[ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" == true ]]; then
      docker stop -t 60 "$id" >/dev/null 2>&1 || die "No se ha podido parar el contenedor $id."
      PARADOS_RESTAURACION+=("$id")
    fi
  done
}

arrancar_parados() {
  local id
  for id in ${PARADOS_RESTAURACION[@]+"${PARADOS_RESTAURACION[@]}"}; do
    docker start "$id" >/dev/null 2>&1 || warn "No se ha podido arrancar de nuevo el contenedor $id: revísalo con «docker ps -a»."
  done
  PARADOS_RESTAURACION=()
}

# restaurar_volumen <nombre> <instantánea> [etiquetas JSON]: deja el volumen
# exactamente como estaba en la copia (lo que sobra se borra). Quien llama ya
# ha parado los contenedores que lo usan.
restaurar_volumen() {
  local vol="$1" snap="$2" etiquetas_json="${3:-null}"
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    local -a labels=()
    local k v
    while IFS=$'\t' read -r k v; do
      [[ -n "$k" ]] && labels+=(--label "$k=$v")
    done < <(jq -r 'to_entries[]? | "\(.key)\t\(.value)"' <<< "$etiquetas_json" 2>/dev/null || true)
    docker volume create ${labels[@]+"${labels[@]}"} "$vol" >/dev/null || die "No se ha podido crear el volumen $vol."
  fi
  restic_ -v "$vol:/destino" -- restore "$snap:/volumenes/$vol" --target /destino --delete >/dev/null \
    || die "No se ha podido restaurar el volumen $vol."
  ok "  Volumen $vol restaurado."
}

restaurar_volumen_de_manifiesto() {
  local vol="$1" fila snap et
  fila="$(jq -c --arg v "$vol" '[.elementos[] | select(.tipo == "volumen" and .nombre == $v and .snapshot != null)] | first // empty' "$MANIFIESTO")"
  [[ -n "$fila" ]] || die "La copia $EJECUCION no tiene el volumen $vol."
  snap="$(jq -r '.snapshot' <<< "$fila")"; et="$(jq -c '.etiquetas // null' <<< "$fila")"
  restaurar_volumen "$vol" "$snap" "$et"
}

# Carga un volcado en su base: vacía el volumen, deja que la imagen inicie
# una base nueva con las credenciales de su entorno y vuelca encima. Así no
# se mezcla con lo que hubiera y vale para una versión más nueva del motor.
# Quien llama ya ha parado la base y las aplicaciones que la usan.
restaurar_volcado() {
  local fila="$1" vol="$2" svc ctr snap ruta orden plantilla
  svc="$(jq -r '.servicio' <<< "$fila")"; snap="$(jq -r '.snapshot' <<< "$fila")"
  ruta="$(jq -r '.ruta' <<< "$fila")"; orden="$(jq -r '.restaurar' <<< "$fila")"; plantilla="$(jq -r '.plantilla' <<< "$fila")"
  ctr="$(jq -r '.contenedores[0] // empty' <<< "$fila")"
  docker inspect "$ctr" >/dev/null 2>&1 || die "No existe el contenedor $ctr de la base: despliégala antes desde Skyway."
  info "  Base $svc ($plantilla): se vacía y se carga el volcado de la copia…"
  docker stop -t 60 "$ctr" >/dev/null 2>&1 || true
  if [[ -n "$vol" ]] && docker volume inspect "$vol" >/dev/null 2>&1; then
    docker run --rm -v "$vol:/v" "$IMAGEN_AUX" sh -c 'find /v -mindepth 1 -maxdepth 1 -exec rm -rf {} +' \
      || die "No se ha podido vaciar el volumen $vol."
  fi
  docker start "$ctr" >/dev/null || die "No se ha podido arrancar la base $ctr."
  esperar_base "$ctr" "$plantilla" || die "La base $ctr no responde tras 3 minutos."
  local -a st=()
  { restic_ -- dump "$snap" "$ruta" | gunzip -c | docker exec -i "$ctr" sh -c "$orden" >/dev/null; st=("${PIPESTATUS[@]}"); } || true
  [[ "${st[*]:-}" == "0 0 0" ]] || die "La carga del volcado en $ctr ha fallado (códigos ${st[*]:-?})."
  ok "  Volcado cargado en $ctr."
}

esperar_base() {
  local ctr="$1" plantilla="$2" sonda i
  case "$plantilla" in
    postgres) sonda='pg_isready -U skyway -d skyway -q';;
    mysql) sonda='mysqladmin ping -u skyway -p"$MYSQL_PASSWORD" --silent';;
    mongo) sonda='mongosh --quiet --username skyway --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.runCommand({ping:1})" || mongo --quiet --eval "db.runCommand({ping:1})"';;
    *) sonda='true';;
  esac
  for ((i = 0; i < 90; i++)); do
    # Postgres responde un momento durante su inicio y se reinicia: se pide
    # que responda dos veces seguidas.
    if docker exec "$ctr" sh -c "$sonda" >/dev/null 2>&1 && sleep 2 && docker exec "$ctr" sh -c "$sonda" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# Busca un proyecto de la copia por id, slug o nombre. stdout: su JSON.
buscar_proyecto() {
  local q="$1" coincidencias n
  coincidencias="$(jq -c --arg q "$q" '[(.skyway.inventario.proyectos // [])[]
      | select(.id == $q or (.slug | ascii_downcase) == ($q | ascii_downcase) or ((.nombre | ascii_downcase) | contains($q | ascii_downcase)))]' "$MANIFIESTO")"
  n="$(jq 'length' <<< "$coincidencias")"
  if [[ "$n" == 0 ]]; then die "Ningún proyecto de la copia $EJECUCION coincide con «$q»."; fi
  if [[ "$n" == 1 ]]; then jq -c '.[0]' <<< "$coincidencias"; return 0; fi
  local id
  id="$(elegir "$(jq -r '.[] | "\(.id)\t\(.nombre) (\(.slug))"' <<< "$coincidencias")" "Varios proyectos coinciden con «$q»:")"
  jq -c --arg id "$id" '.[] | select(.id == $id)' <<< "$coincidencias"
}

# Busca un servicio: «proyecto/servicio», id o parte del nombre. stdout: {p, s}.
buscar_servicio() {
  local q="$1" coincidencias n
  coincidencias="$(jq -c --arg q "$q" '[(.skyway.inventario.proyectos // [])[] as $p | $p.servicios[]
      | select(.id == $q or (($p.slug + "/" + .slug) == ($q | ascii_downcase))
               or ((.nombre | ascii_downcase) | contains($q | ascii_downcase)) or (.slug == ($q | ascii_downcase)))
      | {p: ($p | del(.servicios)), s: .}]' "$MANIFIESTO")"
  n="$(jq 'length' <<< "$coincidencias")"
  if [[ "$n" == 0 ]]; then die "Ningún servicio de la copia $EJECUCION coincide con «$q» (prueba «proyecto/servicio»)."; fi
  if [[ "$n" == 1 ]]; then jq -c '.[0]' <<< "$coincidencias"; return 0; fi
  local id
  id="$(elegir "$(jq -r '.[] | "\(.s.id)\t\(.s.nombre)   \(.p.nombre)"' <<< "$coincidencias")" "Varios servicios coinciden con «$q»:")"
  jq -c --arg id "$id" '.[] | select(.s.id == $id)' <<< "$coincidencias"
}

resumen_copia() {
  jq -r '"Copia \(.ejecucion) (\(.inicio[0:16] | sub("T"; " ")) UTC) · Skyway \(.skyway.version // "?")\(if .mailway then " · Mailway \(.mailway.version // "?")" else "" end)"' "$MANIFIESTO"
}

restaurar_servicios() {
  # restaurar_servicios <JSON con una lista de servicios> <volcados: 0|1>
  local servicios="$1" volcados="$2"
  local -a vols=() ctrs=()
  local v c
  while IFS= read -r v; do [[ -n "$v" ]] && vols+=("$v"); done < <(jq -r '.[] | .volumenes[]?' <<< "$servicios" | sort -u)
  for v in ${vols[@]+"${vols[@]}"}; do
    while IFS= read -r c; do [[ -n "$c" ]] && ctrs+=("$c"); done < <(contenedores_de_volumen "$v")
  done
  # También los contenedores del servicio sin volumen (réplicas, apps sin
  # disco): así ninguno escribe mientras se restaura.
  while IFS= read -r c; do
    [[ -n "$c" ]] && docker inspect "$c" >/dev/null 2>&1 && ctrs+=("$c")
  done < <(jq -r '.[] | .contenedores[]?' <<< "$servicios")
  parar_para_restaurar ${ctrs[@]+"${ctrs[@]}"}
  # Con --volcados, las bases con volcado se cargan desde él; el resto de
  # volúmenes, como siempre. Las aplicaciones siguen paradas hasta el final:
  # una que arrancara antes podría crear sus tablas vacías en la base nueva.
  local -a vols_bd=()
  local s fila vol_bd
  if [[ "$volcados" == 1 ]]; then
    while IFS= read -r s; do
      [[ -n "$s" ]] || continue
      fila="$(jq -c --arg s "$s" '[.elementos[] | select(.tipo == "volcado" and .servicio == $s and .estado == "ok")] | first // empty' "$MANIFIESTO")"
      if [[ -n "$fila" ]]; then
        vol_bd="$(jq -r --arg s "$s" '.[] | select(.id == $s) | .volumenes[0] // empty' <<< "$servicios")"
        [[ -n "$vol_bd" ]] && vols_bd+=("$vol_bd")
      else
        warn "  La copia no tiene volcado de $s: se restaura su volumen."
      fi
    done < <(jq -r '.[] | select(.volcado) | .id' <<< "$servicios")
  fi
  local omitir x
  for v in ${vols[@]+"${vols[@]}"}; do
    omitir=0
    for x in ${vols_bd[@]+"${vols_bd[@]}"}; do [[ "$x" == "$v" ]] && omitir=1; done
    (( omitir )) && continue
    restaurar_volumen_de_manifiesto "$v"
  done
  if (( ${#vols_bd[@]} > 0 )); then
    while IFS= read -r s; do
      [[ -n "$s" ]] || continue
      fila="$(jq -c --arg s "$s" '[.elementos[] | select(.tipo == "volcado" and .servicio == $s and .estado == "ok")] | first // empty' "$MANIFIESTO")"
      [[ -n "$fila" ]] || continue
      restaurar_volcado "$fila" "$(jq -r --arg s "$s" '.[] | select(.id == $s) | .volumenes[0] // empty' <<< "$servicios")"
    done < <(jq -r '.[] | select(.volcado) | .id' <<< "$servicios")
  fi
  arrancar_parados
}

# Comprueba que el proyecto (y el servicio) siguen existiendo en el Skyway de
# ahora: sin ellos, devolver sus volúmenes no recrea sus contenedores.
exigir_proyecto_actual() {
  local id="$1" nombre="$2" svc="${3:-}" inv
  inv="$(inventario_skyway)"
  [[ -n "$inv" ]] || return 0
  jq -e --arg id "$id" '.proyectos | any(.id == $id)' >/dev/null <<< "$inv" \
    || die "El proyecto «$nombre» ya no existe en Skyway. Para recuperarlo entero hay que restaurar el panel de esa fecha («sudo skyway copias restaurar skyway --ejecucion $EJECUCION»), que también devuelve el resto del panel a ese día, y después este proyecto."
  if [[ -n "$svc" ]]; then
    jq -e --arg id "$id" --arg s "$svc" '.proyectos[] | select(.id == $id) | .servicios | any(.id == $s)' >/dev/null <<< "$inv" \
      || die "Ese servicio ya no existe en el proyecto «$nombre». Para recuperarlo hay que restaurar antes el panel de esa fecha («sudo skyway copias restaurar skyway --ejecucion $EJECUCION»)."
  fi
}

# Para restaurar una parte hay que saber de qué proyecto se habla antes de
# elegir la copia: se busca en la copia indicada o, si no se indica, en la
# última completa (la que tiene todos los nombres).
copia_para_buscar() {
  local id="$1"
  leer_instantaneas
  if [[ -n "$id" ]]; then elegir_ejecucion cualquiera "$id" ''; else elegir_ejecucion todo '' '' no; fi
}

cmd_restaurar() {
  local modo="${1:-}"; shift || true
  local objetivo='' id='' fecha='' volcados=0 sin_dns=0 sin_redesplegar=0 ip='' con_config=0 forzar=0
  if [[ "$modo" =~ ^(proyecto|servicio|volumen)$ && $# -gt 0 && "${1:0:1}" != - ]]; then objetivo="$1"; shift; fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ejecucion) id="${2:-}"; shift;;
      --fecha) fecha="${2:-}"; shift;;
      --volcados) volcados=1;;
      --sin-dns) sin_dns=1;;
      --sin-redesplegar) sin_redesplegar=1;;
      --ip) ip="${2:-}"; shift;;
      --con-config) con_config=1;;
      --forzar) forzar=1;;
      -y|--yes) ASUMIR_SI=1;;
      *) die "Opción desconocida para «restaurar»: $1";;
    esac
    shift
  done
  exigir_root; need jq; docker_disponible
  cargar_config
  exigir_conexion
  tomar_cerrojo
  localizar_skyway
  localizar_mailway
  local interactivo=no
  [[ -t 0 && -z "$id" && -z "$fecha" && "$ASUMIR_SI" != 1 ]] && interactivo=si
  case "$modo" in
    todo) elegir_ejecucion todo "$id" "$fecha" "$interactivo"; restaurar_todo "$sin_dns" "$sin_redesplegar" "$ip";;
    skyway) elegir_ejecucion skyway "$id" "$fecha" "$interactivo"; restaurar_panel_skyway "$con_config" "$forzar";;
    correo) elegir_ejecucion correo "$id" "$fecha" "$interactivo"; restaurar_correo "$forzar";;
    proyecto)
      [[ -n "$objetivo" ]] || objetivo="$(preguntar 'Proyecto (nombre o slug)')"
      copia_para_buscar "$id"
      local p pid nombre
      p="$(buscar_proyecto "$objetivo")"
      pid="$(jq -r '.id' <<< "$p")"; nombre="$(jq -r '.nombre' <<< "$p")"
      elegir_ejecucion "proyecto:$pid" "$id" "$fecha" "$interactivo"
      p="$(jq -c --arg id "$pid" '(.skyway.inventario.proyectos // [])[] | select(.id == $id)' "$MANIFIESTO")"
      [[ -n "$p" ]] || die "La copia $EJECUCION no incluye el proyecto «$nombre»."
      jq -e --arg a "proyecto:$pid" '.alcance == "todo" or .alcance == $a' "$MANIFIESTO" >/dev/null \
        || die "La copia $EJECUCION no incluye el proyecto «$nombre»."
      exigir_proyecto_actual "$pid" "$nombre"
      titulo "Restaurar el proyecto «$nombre»"
      info "$(resumen_copia)"
      info "Servicios: $(jq -r '[.servicios[].nombre] | join(", ")' <<< "$p")"
      [[ "$volcados" == 1 ]] && info "Las bases se cargan desde sus volcados SQL (vaciándolas antes)."
      confirmar "Sus datos actuales se sustituyen por los de la copia y sus servicios se reinician. ¿Continuar?" || { info "Cancelado."; return 0; }
      en_curso restauracion "Proyecto $nombre"
      restaurar_servicios "$(jq -c '.servicios' <<< "$p")" "$volcados"
      ok "Proyecto «$nombre» restaurado a la copia $EJECUCION."
      ;;
    servicio)
      [[ -n "$objetivo" ]] || objetivo="$(preguntar 'Servicio (proyecto/servicio, nombre o id)')"
      copia_para_buscar "$id"
      local ps sid pid2 s
      ps="$(buscar_servicio "$objetivo")"
      sid="$(jq -r '.s.id' <<< "$ps")"; pid2="$(jq -r '.p.id' <<< "$ps")"
      elegir_ejecucion "proyecto:$pid2" "$id" "$fecha" "$interactivo"
      s="$(jq -c --arg s "$sid" '[(.skyway.inventario.proyectos // [])[] | .servicios[] | select(.id == $s)] | first // empty' "$MANIFIESTO")"
      [[ -n "$s" ]] || die "La copia $EJECUCION no incluye ese servicio."
      exigir_proyecto_actual "$pid2" "$(jq -r '.p.nombre' <<< "$ps")" "$sid"
      titulo "Restaurar el servicio «$(jq -r '.nombre' <<< "$s")» ($(jq -r '.p.nombre' <<< "$ps"))"
      info "$(resumen_copia)"
      confirmar "Sus datos actuales se sustituyen por los de la copia y se reinicia. ¿Continuar?" || { info "Cancelado."; return 0; }
      en_curso restauracion "Servicio $(jq -r '.nombre' <<< "$s")"
      restaurar_servicios "[$s]" "$volcados"
      ok "Servicio restaurado a la copia $EJECUCION."
      ;;
    volumen)
      [[ -n "$objetivo" ]] || objetivo="$(preguntar 'Nombre del volumen')"
      leer_instantaneas
      if [[ -n "$id" ]]; then elegir_ejecucion cualquiera "$id" ''; else elegir_ejecucion todo '' "$fecha" "$interactivo"; fi
      jq -e --arg v "$objetivo" 'any(.elementos[]; .tipo == "volumen" and .nombre == $v and .snapshot != null)' "$MANIFIESTO" >/dev/null \
        || die "La copia $EJECUCION no tiene el volumen «$objetivo»."
      titulo "Restaurar el volumen $objetivo"
      info "$(resumen_copia)"
      confirmar "Su contenido actual se sustituye por el de la copia y los contenedores que lo usan se reinician. ¿Continuar?" || { info "Cancelado."; return 0; }
      en_curso restauracion "Volumen $objetivo"
      local -a cs=()
      local c
      while IFS= read -r c; do [[ -n "$c" ]] && cs+=("$c"); done < <(contenedores_de_volumen "$objetivo")
      parar_para_restaurar ${cs[@]+"${cs[@]}"}
      restaurar_volumen_de_manifiesto "$objetivo"
      arrancar_parados
      ok "Volumen $objetivo restaurado a la copia $EJECUCION."
      ;;
    *) die "Indica qué restaurar: todo, skyway, correo, proyecto <nombre>, servicio <nombre> o volumen <nombre>.";;
  esac
  fin_en_curso
}

restaurar_panel_skyway() {
  local con_config="$1" forzar="$2"
  local vbackup vactual
  vbackup="$(jq -r '.skyway.version // empty' "$MANIFIESTO")"
  vactual="$(pkg_version "$SKYWAY_DIR/package.json")"
  if [[ "$forzar" != 1 ]] && version_posterior "$vbackup" "$vactual"; then
    die "La copia es de Skyway $vbackup y aquí está instalado el $vactual: la base de datos de una versión más nueva no funciona con un código anterior. Actualiza antes Skyway («sudo skyway update») o restaura todo («sudo skyway copias restaurar todo»)."
  fi
  local vol
  vol="$(jq -r '.skyway.volumenes.datos // empty' "$MANIFIESTO")"
  [[ -n "$vol" ]] || die "La copia $EJECUCION no tiene los datos del panel de Skyway."
  titulo "Restaurar el panel de Skyway"
  info "$(resumen_copia)"
  info "Vuelven a esa fecha los proyectos, servicios, variables, usuarios y ajustes del panel. Los datos de las webs y bases no cambian."
  confirmar "¿Continuar? El panel se detiene unos segundos." || { info "Cancelado."; return 0; }
  en_curso restauracion "Panel de Skyway"
  docker stop -t 30 skyway >/dev/null 2>&1 || true
  [[ "$vol" == "$VOL_DATOS" || -z "$VOL_DATOS" ]] || warn "El volumen de datos de la copia ($vol) no es el que usa ahora el panel ($VOL_DATOS): se restaura el de la copia."
  restaurar_volumen_de_manifiesto "$vol"
  if [[ "$con_config" == 1 ]]; then restaurar_config_skyway; fi
  docker start skyway >/dev/null 2>&1 || warn "No se ha podido arrancar el panel: «cd $SKYWAY_DIR && docker compose up -d»."
  esperar_panel 120 && ok "Panel de Skyway restaurado a la copia $EJECUCION y en marcha." || warn "El panel aún no responde en $URL_PANEL/api/health; revisa «docker logs skyway»."
}

esperar_panel() {
  local max="${1:-300}" i
  for ((i = 0; i < max; i += 5)); do
    if curl -fsS -m 4 "$URL_PANEL/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

# Saca la configuración de la copia a una carpeta temporal y deja su ruta en CONFIG_RESTAURADA.
CONFIG_RESTAURADA=''
extraer_config() {
  [[ -n "$CONFIG_RESTAURADA" ]] && return 0
  local snap
  snap="$(instantanea_de '.tipo == "config"')"
  [[ -n "$snap" ]] || die "La copia $EJECUCION no tiene la configuración."
  [[ -n "$TRABAJO" ]] || nuevo_trabajo
  mkdir -p "$TRABAJO/config-restaurada"
  restic_ -v "$TRABAJO/config-restaurada:/salida" -- restore "$snap:/elementos/config" --target /salida >/dev/null \
    || die "No se ha podido leer la configuración de la copia."
  CONFIG_RESTAURADA="$TRABAJO/config-restaurada"
}

# Pone un fichero de la copia en su sitio, guardando el que hubiera.
reponer_fichero() {
  local origen="$1" destino="$2" sello
  [[ -f "$origen" ]] || return 0
  if [[ -f "$destino" ]] && cmp -s "$origen" "$destino"; then return 0; fi
  sello="$(date -u +%Y%m%d-%H%M%S)"
  if [[ -f "$destino" ]]; then cp -p "$destino" "$destino.antes-de-restaurar-$sello"; fi
  mkdir -p "$(dirname "$destino")"
  cp -p "$origen" "$destino"
  info "  $destino repuesto desde la copia${C_DIM}$( [[ -f "$destino.antes-de-restaurar-$sello" ]] && echo " (el anterior queda en $destino.antes-de-restaurar-$sello)")${C_RESET}"
}

restaurar_config_skyway() {
  extraer_config
  local f
  for f in .env docker-compose.override.yml; do reponer_fichero "$CONFIG_RESTAURADA/skyway/$f" "$SKYWAY_DIR/$f"; done
}

restaurar_correo() {
  local forzar="$1"
  jq -e '.mailway != null' "$MANIFIESTO" >/dev/null || die "La copia $EJECUCION no incluye Mailway."
  [[ -n "$MAILWAY_DIR" ]] || MAILWAY_DIR="$(jq -r '.mailway.ruta // empty' "$MANIFIESTO")"
  [[ -n "$MAILWAY_DIR" && -f "$MAILWAY_DIR/deploy/copias.sh" ]] || die "No se encuentra Mailway en este servidor (ni en ${MAILWAY_DIR:-su ruta de la copia}). Para un servidor nuevo, usa «restaurar todo»."
  local vbackup vactual
  vbackup="$(jq -r '.mailway.version // empty' "$MANIFIESTO")"
  vactual="$(pkg_version "$MAILWAY_DIR/package.json")"
  if [[ "$forzar" != 1 ]] && version_posterior "$vbackup" "$vactual"; then
    die "La copia es de Mailway $vbackup y aquí está instalado el $vactual: actualiza antes Mailway («mailway update») y vuelve a intentarlo."
  fi
  titulo "Restaurar el correo (Mailway)"
  info "$(resumen_copia)"
  info "Vuelven a esa fecha los buzones y su correo, los alias, los dominios con sus claves DKIM, el webmail y el panel de Mailway. El correo recibido después de la copia se pierde."
  confirmar "El correo se detiene unos minutos. ¿Continuar?" || { info "Cancelado."; return 0; }
  en_curso restauracion "Correo"
  bash "$MAILWAY_DIR/deploy/copias.sh" parar || die "No se ha podido detener la pila de correo."
  local -a vols=() panel=()
  local v c
  while IFS= read -r v; do [[ -n "$v" ]] && vols+=("$v"); done < <(jq -r '.elementos[] | select(.tipo == "volumen" and .origen == "mailway" and .snapshot != null) | .nombre' "$MANIFIESTO")
  for v in ${vols[@]+"${vols[@]}"}; do
    while IFS= read -r c; do [[ -n "$c" ]] && panel+=("$c"); done < <(contenedores_de_volumen "$v")
  done
  parar_para_restaurar ${panel[@]+"${panel[@]}"}
  extraer_config
  local env_mw
  env_mw="$(jq -r '.mailway.env // empty' "$MANIFIESTO")"
  if [[ -n "$env_mw" ]]; then reponer_fichero "$CONFIG_RESTAURADA/mailway/$(basename "$env_mw")" "$MAILWAY_DIR/deploy/$(basename "$env_mw")"; fi
  for v in ${vols[@]+"${vols[@]}"}; do restaurar_volumen_de_manifiesto "$v"; done
  arrancar_parados
  local codigo_arranque=0
  bash "$MAILWAY_DIR/deploy/copias.sh" arrancar || codigo_arranque=$?
  if [[ "$codigo_arranque" == 3 ]]; then
    # La copia es de otra configuración del motor (p. ej. de antes de migrar
    # a la 0.16): hay que aplicar su deploy/.env, que ya está repuesto.
    info "La pila de correo de la copia no coincide con la de ahora: se aplica su configuración…"
    bash "$MAILWAY_DIR/deploy/copias.sh" reaplicar || warn "No se ha podido aplicar la configuración del correo: «mailway update --reaplicar» lo reintenta."
  elif [[ "$codigo_arranque" != 0 ]]; then
    warn "La pila de correo no ha arrancado sola: «mailway update --reaplicar» la vuelve a levantar."
  fi
  ok "Correo restaurado a la copia $EJECUCION."
}

# ---------- restaurar todo (también en un servidor nuevo) ----------

TOKEN_ID=''
TOKEN=''

api_() {
  local metodo="$1" ruta="$2" cuerpo="${3:-}"
  local -a datos=()
  # Fastify rechaza un POST con JSON y cuerpo vacío: se manda {} como el panel.
  if [[ "$metodo" != GET ]]; then datos=(--data "${cuerpo:-"{}"}"); fi
  curl -fsS -m 30 -X "$metodo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    ${datos[@]+"${datos[@]}"} "$URL_PANEL/api$ruta"
}

crear_token() {
  local salida
  salida="$(docker exec skyway node server/dist/tools/token.js crear --nombre 'Restauración de copias externas' --caduca-min 180 2>/dev/null)" || return 1
  TOKEN_ID="$(jq -r '.id // empty' <<< "$salida")"; TOKEN="$(jq -r '.token // empty' <<< "$salida")"
  [[ -n "$TOKEN" ]]
}

revocar_token() {
  [[ -n "$TOKEN_ID" ]] || return 0
  docker exec skyway node server/dist/tools/token.js revocar --id "$TOKEN_ID" >/dev/null 2>&1 || true
  TOKEN=''; TOKEN_ID=''
}

esperar_despliegues() {
  # esperar_despliegues <límite en s> <id de despliegue>…: imprime los fallidos.
  local limite="$1"; shift
  local -a pendientes=("$@")
  local inicio=$SECONDS d estado
  while (( ${#pendientes[@]} > 0 )); do
    local -a siguen=()
    for d in "${pendientes[@]}"; do
      estado="$(api_ GET "/deployments/$d" 2>/dev/null | jq -r '.deployment.status // empty' 2>/dev/null || true)"
      case "$estado" in
        success) ;;
        failed|canceled) printf '%s\n' "$d";;
        *) siguen+=("$d");;
      esac
    done
    pendientes=(${siguen[@]+"${siguen[@]}"})
    (( ${#pendientes[@]} == 0 )) && break
    if (( SECONDS - inicio > limite )); then printf '%s\n' "${pendientes[@]}"; break; fi
    sleep 5
  done
}

# Vuelve a crear los contenedores de todos los servicios. Los de repositorio
# vuelven a su despliegue de la copia con la imagen restaurada (sin GitHub);
# si la imagen no está, se despliegan con normalidad.
redesplegar_skyway() {
  crear_token || { warn "No se ha podido crear un token temporal en Skyway: despliega los proyectos desde el panel."; return 1; }
  local servicios
  servicios="$(jq -c '[.skyway.inventario.proyectos[]? | .nombre as $pn | .servicios[] | . + {proyectoNombre: $pn}]' "$MANIFIESTO")"
  local -a deps=() fallidos=()
  local s id tipo dep r
  info "  Bases de datos…"
  while IFS= read -r s; do
    [[ -n "$s" ]] || continue
    id="$(jq -r '.id' <<< "$s")"
    r="$(api_ POST "/services/$id/deploy" 2>/dev/null | jq -r '.deployment.id // empty' 2>/dev/null || true)"
    if [[ -n "$r" ]]; then deps+=("$r"); else fallidos+=("$(jq -r '"\(.nombre) (\(.proyectoNombre))"' <<< "$s")"); fi
  done < <(jq -c '.[] | select(.tipo == "database" and (.detenido | not))' <<< "$servicios")
  local mal
  mal="$(esperar_despliegues 900 ${deps[@]+"${deps[@]}"})"
  deps=()
  info "  Aplicaciones y webs…"
  while IFS= read -r s; do
    [[ -n "$s" ]] || continue
    id="$(jq -r '.id' <<< "$s")"; tipo="$(jq -r '.tipo' <<< "$s")"
    dep="$(jq -r '.despliegue.id // empty' <<< "$s")"
    r=''
    if [[ "$tipo" == git && -n "$dep" ]] && docker image inspect "$(jq -r '.despliegue.imagen' <<< "$s")" >/dev/null 2>&1; then
      r="$(api_ POST "/deployments/$dep/rollback" 2>/dev/null | jq -r '.deployment.id // empty' 2>/dev/null || true)"
    fi
    if [[ -z "$r" ]]; then r="$(api_ POST "/services/$id/deploy" 2>/dev/null | jq -r '.deployment.id // empty' 2>/dev/null || true)"; fi
    if [[ -n "$r" ]]; then deps+=("$r"); else fallidos+=("$(jq -r '"\(.nombre) (\(.proyectoNombre))"' <<< "$s")"); fi
  done < <(jq -c '.[] | select(.tipo != "database" and (.detenido | not))' <<< "$servicios")
  mal+="$(esperar_despliegues 2700 ${deps[@]+"${deps[@]}"})"
  revocar_token
  local n_mal
  n_mal="$(printf '%s' "$mal" | grep -c . || true)"
  if (( n_mal > 0 || ${#fallidos[@]} > 0 )); then
    warn "Algunos servicios no se han desplegado ($((n_mal + ${#fallidos[@]}))): revísalos en el panel. ${fallidos[*]:-}"
    return 1
  fi
  ok "  Servicios desplegados."
}

ip_publica() {
  local u ip
  for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS -m 8 "$u" 2>/dev/null | tr -d '[:space:]')" || continue
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

# Repone el código de un repositorio en el commit de la copia: en un servidor
# nuevo lo clona del paquete de git de la copia; en el mismo, vuelve atrás
# con «git reset --keep» (que no pisa cambios locales) si hace falta.
reponer_repo() {
  local nombre="$1" destino="$2" commit="$3" rama="$4" origen="$5" bundle="$6"
  local g=(git -c safe.directory="$destino" -C "$destino")
  if [[ -d "$destino/.git" ]]; then
    local actual; actual="$("${g[@]}" rev-parse HEAD 2>/dev/null || true)"
    if [[ -n "$commit" && "$actual" != "$commit" ]]; then
      if ! "${g[@]}" cat-file -e "$commit^{commit}" 2>/dev/null && [[ -f "$bundle" ]]; then
        "${g[@]}" fetch -q "$bundle" "+refs/heads/*:refs/remotes/copia/*" 2>/dev/null || true
      fi
      if confirmar "$nombre está en el commit ${actual:0:7} y la copia es del ${commit:0:7}. ¿Volver el código a la versión de la copia?"; then
        "${g[@]}" reset -q --keep "$commit" || die "git no ha podido volver $destino al commit ${commit:0:7} (¿cambios locales?)."
        ok "  $nombre: código en el commit ${commit:0:7} de la copia."
      fi
    fi
    return 0
  fi
  [[ -f "$bundle" ]] || die "No existe $destino y la copia no tiene el código de $nombre."
  mkdir -p "$(dirname "$destino")"
  git clone -q "$bundle" "$destino" || die "No se ha podido recuperar el código de $nombre."
  if [[ -n "$rama" ]]; then git -C "$destino" checkout -q -B "$rama" "${commit:-HEAD}" 2>/dev/null || true; fi
  if [[ -n "$origen" ]]; then
    git -C "$destino" remote set-url origin "$origen"
    # La rama vuelve a seguir a la de GitHub: «skyway update» y «mailway
    # update» funcionan como antes. La referencia origin/<rama> ya viene del
    # paquete de la copia, así que no hace falta red para fijarla.
    if [[ -n "$rama" ]]; then git -C "$destino" branch -q --set-upstream-to="origin/$rama" "$rama" 2>/dev/null || true; fi
    git -C "$destino" fetch -q origin 2>/dev/null || warn "  No se ha podido consultar $origen: «git -C $destino fetch» cuando haya red."
  fi
  ok "  $nombre: código recuperado en $destino (commit ${commit:0:7})."
}

aplicar_parche_local() {
  local patch="$1" repo="$2"
  [[ -s "$patch" ]] || return 0
  if git -C "$repo" apply --check "$patch" 2>/dev/null && git -C "$repo" apply "$patch" 2>/dev/null; then
    info "  Cambios locales de $repo reaplicados desde la copia."
  else
    warn "  Los cambios locales de $repo en la copia no se aplican limpiamente: quedan en $repo/cambios-locales-de-la-copia.patch para revisarlos."
    cp "$patch" "$repo/cambios-locales-de-la-copia.patch" 2>/dev/null || true
  fi
}

restaurar_todo() {
  local sin_dns="$1" sin_redesplegar="$2" ip_nueva="$3"
  need git; need curl
  local nuevo=1
  docker inspect skyway >/dev/null 2>&1 && nuevo=0
  titulo "Restaurar TODO"
  info "$(resumen_copia)"
  jq -r '"Proyectos: \([(.skyway.inventario.proyectos // [])[] | .nombre] | join(", "))", "Correo: \(if .mailway then "sí" else "no" end)"' "$MANIFIESTO" >&2
  if [[ "$nuevo" == 0 ]]; then
    warn "Este servidor ya tiene Skyway en marcha: TODO (panel, webs, bases y correo) vuelve a la fecha de la copia y lo posterior se pierde."
  fi
  local espacio necesario
  necesario="$(jq '[.elementos[] | .bytes // 0] | add // 0' "$MANIFIESTO")"
  espacio="$(df -PB1 "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
  if [[ -n "$espacio" ]] && (( espacio < necesario )); then
    die "No hay espacio suficiente: la copia ocupa $(bytes_legibles "$necesario") y hay $(bytes_legibles "$espacio") libres."
  fi
  if [[ "$ASUMIR_SI" != 1 ]]; then
    local r
    r="$(preguntar 'Escribe RESTAURAR para continuar')"
    [[ "$r" == RESTAURAR ]] || { info "Cancelado."; return 0; }
  fi
  en_curso restauracion "Restaurar todo"
  nuevo_trabajo

  paso "1/7 Código y configuración"
  local snap_codigo
  snap_codigo="$(instantanea_de '.tipo == "codigo"')"
  mkdir -p "$TRABAJO/codigo"
  if [[ -n "$snap_codigo" ]]; then
    restic_ -v "$TRABAJO/codigo:/salida" -- restore "$snap_codigo:/elementos/codigo" --target /salida >/dev/null || warn "No se ha podido leer el código de la copia."
  fi
  local dsky
  dsky="${COPIAS_DIR_SKYWAY:-$(jq -r '.skyway.ruta // empty' "$MANIFIESTO")}"
  [[ -n "$dsky" ]] || dsky=/root/Skyway
  reponer_repo Skyway "$dsky" "$(jq -r '.skyway.git.commit // empty' "$MANIFIESTO")" "$(jq -r '.skyway.git.rama // empty' "$MANIFIESTO")" \
    "$(jq -r '.skyway.git.origen // empty' "$MANIFIESTO")" "$TRABAJO/codigo/skyway.bundle"
  SKYWAY_DIR="$dsky"
  extraer_config
  restaurar_config_skyway
  [[ "$nuevo" == 1 ]] && aplicar_parche_local "$CONFIG_RESTAURADA/skyway/cambios-locales.patch" "$SKYWAY_DIR"
  local pc
  pc="$(jq -r '.skyway.proyectoCompose // empty' "$MANIFIESTO")"
  if [[ -n "$pc" && "$(nombre_compose "$SKYWAY_DIR")" != "$pc" ]] && ! grep -qs '^COMPOSE_PROJECT_NAME=' "$SKYWAY_DIR/.env"; then
    # Los volúmenes de Compose llevan el nombre del proyecto: con otra
    # carpeta, Compose crearía unos vacíos en lugar de usar los restaurados.
    printf '\nCOMPOSE_PROJECT_NAME=%s\n' "$pc" >> "$SKYWAY_DIR/.env"
  fi
  local dmw=''
  if jq -e '.mailway != null' "$MANIFIESTO" >/dev/null; then
    dmw="${COPIAS_DIR_MAILWAY:-$(jq -r '.mailway.ruta // empty' "$MANIFIESTO")}"
    [[ -n "$dmw" ]] || dmw=/root/Mailway
    reponer_repo Mailway "$dmw" "$(jq -r '.mailway.git.commit // empty' "$MANIFIESTO")" "$(jq -r '.mailway.git.rama // empty' "$MANIFIESTO")" \
      "$(jq -r '.mailway.git.origen // empty' "$MANIFIESTO")" "$TRABAJO/codigo/mailway.bundle"
    MAILWAY_DIR="$dmw"
    local env_mw; env_mw="$(jq -r '.mailway.env // empty' "$MANIFIESTO")"
    [[ -n "$env_mw" ]] && reponer_fichero "$CONFIG_RESTAURADA/mailway/$(basename "$env_mw")" "$MAILWAY_DIR/deploy/$(basename "$env_mw")"
    [[ "$nuevo" == 1 ]] && aplicar_parche_local "$CONFIG_RESTAURADA/mailway/cambios-locales.patch" "$MAILWAY_DIR"
  fi
  # Las copias siguen configuradas igual en el servidor restaurado (hora,
  # retención, vigilante…); el destino y las claves son los que se acaban de usar.
  [[ -z "$REPO_LOCAL" ]] && fusionar_config_copias

  paso "2/7 Parando lo que haya en marcha"
  if [[ "$nuevo" == 0 ]]; then
    local c
    while IFS= read -r c; do [[ -n "$c" ]] && docker stop -t 60 "$c" >/dev/null 2>&1; done < <(docker ps -q --filter label=skyway.managed=true)
    if [[ -n "$MAILWAY_DIR" && -f "$MAILWAY_DIR/deploy/copias.sh" ]]; then bash "$MAILWAY_DIR/deploy/copias.sh" parar >/dev/null 2>&1 || true; fi
    docker stop -t 30 skyway skyway-traefik >/dev/null 2>&1 || true
  fi

  paso "3/7 Volúmenes"
  local v snap et c2
  while IFS=$'\t' read -r v snap et; do
    [[ -n "$v" ]] || continue
    local -a usan=()
    while IFS= read -r c2; do [[ -n "$c2" ]] && usan+=("$c2"); done < <(contenedores_de_volumen "$v")
    if (( ${#usan[@]} > 0 )); then docker stop -t 60 "${usan[@]}" >/dev/null 2>&1 || true; fi
    restaurar_volumen "$v" "$snap" "$et"
  done < <(jq -r '.elementos[] | select(.tipo == "volumen" and .snapshot != null) | "\(.nombre)\t\(.snapshot)\t\(.etiquetas // null | tojson)"' "$MANIFIESTO")

  paso "4/7 Imágenes de las webs"
  local svc img
  while IFS=$'\t' read -r svc snap img; do
    [[ -n "$svc" ]] || continue
    if docker image inspect "$img" >/dev/null 2>&1; then continue; fi
    if restic_ -- dump "$snap" "/imagenes/$svc/imagen.tar" | docker load >/dev/null 2>&1; then
      ok "  Imagen $img cargada."
    else
      warn "  No se ha podido cargar la imagen $img: el servicio se reconstruirá desde su repositorio."
    fi
  done < <(jq -r '.elementos[] | select(.tipo == "imagen" and .estado == "ok") | "\(.servicio)\t\(.snapshot)\t\(.imagen)"' "$MANIFIESTO")

  paso "5/7 Arrancando Skyway"
  local dc='docker compose'
  ( cd "$SKYWAY_DIR" && $dc up -d --build ) || die "No se ha podido arrancar Skyway («cd $SKYWAY_DIR && docker compose up -d --build»)."
  esperar_panel 900 || die "Skyway no responde en $URL_PANEL/api/health tras 15 minutos: revisa «docker logs skyway»."
  ok "  Skyway en marcha."
  localizar_skyway

  paso "6/7 IP del servidor y DNS"
  local ip_ant
  ip_ant="$(jq -r '.skyway.inventario.ajustes.serverIp // .servidor.ipv4 // empty' "$MANIFIESTO")"
  if [[ -z "$ip_nueva" ]]; then ip_nueva="$(ip_publica || true)"; fi
  if [[ -t 0 && "$ASUMIR_SI" != 1 ]]; then ip_nueva="$(preguntar 'IP pública de este servidor' "$ip_nueva")"; fi
  if [[ -n "$ip_ant" && -n "$ip_nueva" && "$ip_ant" != "$ip_nueva" && "$sin_dns" != 1 ]]; then
    cambiar_ip "$ip_ant" "$ip_nueva"
  elif [[ -n "$ip_ant" && "$ip_ant" == "$ip_nueva" ]]; then
    info "  La IP es la misma que la de la copia ($ip_nueva): el DNS no cambia."
  fi

  paso "7/7 Servicios y correo"
  if [[ "$sin_redesplegar" != 1 ]]; then redesplegar_skyway || true; fi
  if [[ -n "$MAILWAY_DIR" && -f "$MAILWAY_DIR/deploy/copias.sh" ]]; then
    local -a ipopt=()
    [[ -n "$ip_nueva" && "$ip_nueva" != "$ip_ant" ]] && ipopt=(--ip "$ip_nueva")
    bash "$MAILWAY_DIR/deploy/copias.sh" reaplicar ${ipopt[@]+"${ipopt[@]}"} || warn "Mailway no ha terminado de aplicarse: «mailway update --reaplicar» lo reintenta."
  fi
  fin_en_curso
  ok "Restauración de la copia $EJECUCION terminada."
  if [[ -z "$REPO_LOCAL" ]]; then
    # Solo con systemd como sistema de arranque (no dentro de un contenedor).
    if [[ -d /run/systemd/system ]] && confirmar "¿Activar la copia diaria en este servidor (a las $CFG_HORA)?"; then
      cmd_activar
    else
      info "Para seguir haciendo copias desde aquí: «sudo skyway copias activar»."
    fi
  else
    info "Restaurado desde un kit: configura las copias de este servidor con «sudo skyway copias configurar»."
  fi
  pasos_manuales "$ip_ant" "$ip_nueva"
}

fusionar_config_copias() {
  local f="$CONFIG_RESTAURADA/copias/config" linea clave valor
  [[ -f "$f" ]] || return 0
  while IFS= read -r linea || [[ -n "$linea" ]]; do
    clave="${linea%%=*}"; valor="${linea#*=}"
    case "$clave" in
      RETENCION_DIARIAS|RETENCION_SEMANALES|RETENCION_MENSUALES|HORA|AVISO_URL|IMAGENES|EXCLUIR|PAUSA_MAXIMA|SKYWAY_DIR|MAILWAY_DIR)
        printf -v "CFG_$clave" '%s' "$valor";;
    esac
  done < "$f"
  escribir_config
}

cambiar_ip() {
  local ant="$1" nueva="$2" sim
  info "  La copia es de la IP $ant y este servidor tiene la $nueva."
  sim="$(docker exec skyway node server/dist/tools/copias.js repuntar --ip-anterior "$ant" --ip-nueva "$nueva" 2>/dev/null)" || sim=''
  if [[ -z "$sim" ]]; then
    warn "  No se ha podido consultar el DNS desde Skyway: cambia la IP en Ajustes y en tu proveedor de DNS."
    return 0
  fi
  jq -r '"  · IP del servidor en Ajustes: \(.serverIp.antes // "—") → \(.serverIp.despues // "—")",
         (if .cloudflare.configurado then (.cloudflare.registros[] | "  · Cloudflare: \(.nombre) → '"$nueva"'\(if .proxied then " (con proxy)" else "" end)") else "  · Cloudflare no está conectado en Skyway: cambia el DNS a mano." end)' <<< "$sim" >&2
  if confirmar "¿Aplicar estos cambios de IP y DNS?"; then
    docker exec skyway node server/dist/tools/copias.js repuntar --ip-anterior "$ant" --ip-nueva "$nueva" --aplicar si >/dev/null \
      && ok "  IP y DNS actualizados." || warn "  Algún cambio de DNS ha fallado: revísalo en Ajustes → Cloudflare."
  fi
}

pasos_manuales() {
  local ant="$1" nueva="$2"
  [[ -n "$nueva" && "$ant" != "$nueva" ]] || return 0
  titulo "Pendiente a mano"
  info "  · DNS inverso (PTR) de $nueva con el nombre del servidor de correo, en el panel de tu proveedor del servidor."
  info "  · Los dominios cuyo DNS no esté en la cuenta de Cloudflare conectada: registro A → $nueva."
  info "  · Comprueba el puerto 25 de salida en el proveedor nuevo («mailway comprobar»)."
}

# ---------- extraer (a una carpeta, sin tocar nada en marcha) ----------

cmd_extraer() {
  local destino="${1:-}"; shift || true
  local id='' fecha='' elemento=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ejecucion) id="${2:-}"; shift;;
      --fecha) fecha="${2:-}"; shift;;
      --elemento) elemento="${2:-}"; shift;;
      *) die "Opción desconocida para «extraer»: $1";;
    esac
    shift
  done
  [[ -n "$destino" ]] || die "Indica la carpeta donde dejar los ficheros: «skyway copias extraer /root/recuperado»."
  exigir_root; need jq; docker_disponible
  cargar_config
  exigir_conexion
  local interactivo=no; [[ -t 0 && -z "$id" && -z "$fecha" ]] && interactivo=si
  elegir_ejecucion cualquiera "$id" "$fecha" "$interactivo"
  mkdir -p "$destino"; destino="$(cd "$destino" && pwd)"
  local filtro='.snapshot != null'
  [[ -n "$elemento" ]] && filtro=".snapshot != null and ((.ruta // \"\") | startswith(\"$elemento\") or (.nombre // \"\") == \"$elemento\")"
  local n=0 ruta snap
  while IFS=$'\t' read -r ruta snap; do
    [[ -n "$snap" ]] || continue
    restic_ -v "$destino:/salida" -- restore "$snap" --target /salida >/dev/null && { n=$((n + 1)); info "  $ruta"; } || warn "No se ha podido extraer $ruta."
  done < <(jq -r --arg e "$elemento" '.elementos[] | select(.snapshot != null) | select($e == "" or ((.ruta // "") | startswith($e)) or (.nombre // "") == $e) | "\(.ruta)\t\(.snapshot)"' "$MANIFIESTO")
  (( n > 0 )) || die "Nada que extraer con ese filtro."
  ok "$n elementos de la copia $EJECUCION extraídos en $destino (nada de lo que está en marcha se ha tocado)."
}

# ---------- kit ----------

DIR_KITS=''

carpeta_kits() {
  if [[ -n "$DIR_PANEL" ]]; then DIR_KITS="$DIR_PANEL/kits"; else DIR_KITS="$ESTADO_DIR/kits"; fi
  mkdir -p "$DIR_KITS"
}

limpiar_kits_caducados() {
  [[ -n "$DIR_KITS" ]] || carpeta_kits
  local f
  # Un kit lleva datos de todo el servidor (cifrados): no se deja más de un día.
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    rm -f "$f"
    if [[ -n "$DIR_PANEL" && -f "$DIR_PANEL/kit.json" ]] && jq -e --arg n "$(basename "$f")" '.fichero == $n' "$DIR_PANEL/kit.json" >/dev/null 2>&1; then rm -f "$DIR_PANEL/kit.json"; fi
  done < <(find "$DIR_KITS" -maxdepth 1 -name 'kit-*.zip' -mmin +1440 2>/dev/null)
}

kit_estado() {
  # kit_estado <estado> <fichero> <tamaño> <alcance> [detalle]
  [[ -n "$DIR_PANEL" ]] || return 0
  jq -n --argjson f "$FORMATO" --arg e "$1" --arg fic "$2" --arg t "${3:-0}" --arg ej "$EJECUCION" --arg a "$4" \
    --arg c "$(ahora_iso)" --arg cad "$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" --arg d "${5:-}" \
    '{formato: $f, estado: $e, fichero: (if $fic == "" then null else $fic end), tamano: ($t | tonumber), ejecucion: $ej, alcance: $a,
      creado: $c, caduca: (if $e == "listo" then $cad else null end), detalle: (if $d == "" then null else $d end)}' \
    | escribir_atomico "$DIR_PANEL/kit.json" 644
}

# Binarios de restic para descodificar el kit en Windows, macOS y Linux.
binarios_restic() {
  local bin="$1" cache="$ESTADO_DIR/bin/$VERSION_RESTIC"
  mkdir -p "$bin" "$cache"
  # El de Linux de esta arquitectura sale de la propia imagen: siempre está.
  local arq
  case "$(uname -m)" in x86_64|amd64) arq=amd64;; aarch64|arm64) arq=arm64;; *) arq='';; esac
  if [[ -n "$arq" && ! -f "$cache/restic-linux-$arq" ]]; then
    local cid
    cid="$(docker create "$IMAGEN_RESTIC" 2>/dev/null)" && docker cp "$cid:/usr/bin/restic" "$cache/restic-linux-$arq" >/dev/null 2>&1
    [[ -n "${cid:-}" ]] && docker rm "$cid" >/dev/null 2>&1
  fi
  # Los demás, de las versiones publicadas de restic, comprobando su SHA-256.
  local base="${COPIAS_URL_RESTIC:-https://github.com/restic/restic/releases/download/v$VERSION_RESTIC}"
  if [[ ! -f "$cache/SHA256SUMS" ]]; then curl -fsSL -m 60 -o "$cache/SHA256SUMS" "$base/SHA256SUMS" 2>/dev/null || rm -f "$cache/SHA256SUMS"; fi
  local par so a fichero destino
  for par in linux:amd64 linux:arm64 darwin:amd64 darwin:arm64 windows:amd64; do
    so="${par%%:*}"; a="${par##*:}"
    case "$so" in
      darwin) destino="restic-macos-$a"; fichero="restic_${VERSION_RESTIC}_darwin_$a.bz2";;
      windows) destino="restic-windows-$a.exe"; fichero="restic_${VERSION_RESTIC}_windows_$a.zip";;
      *) destino="restic-linux-$a"; fichero="restic_${VERSION_RESTIC}_linux_$a.bz2";;
    esac
    if [[ ! -f "$cache/$destino" && -f "$cache/SHA256SUMS" ]]; then
      if curl -fsSL -m 120 -o "$cache/$fichero" "$base/$fichero" 2>/dev/null \
        && ( cd "$cache" && grep " $fichero\$" SHA256SUMS | sha256sum -c --quiet - >/dev/null 2>&1 ); then
        case "$fichero" in
          *.bz2) docker run --rm -v "$cache:/w" "$IMAGEN_AUX" sh -c "bunzip2 -c /w/$fichero > /w/$destino" >/dev/null 2>&1 || rm -f "$cache/$destino";;
          *.zip) docker run --rm -v "$cache:/w" "$IMAGEN_AUX" sh -c "unzip -p /w/$fichero '*.exe' > /w/$destino" >/dev/null 2>&1 || rm -f "$cache/$destino";;
        esac
      fi
      rm -f "$cache/$fichero"
      [[ -s "$cache/$destino" ]] || rm -f "$cache/$destino"
    fi
  done
  local f
  for f in "$cache"/restic-*; do [[ -f "$f" ]] && cp -p "$f" "$bin/" && chmod 755 "$bin/$(basename "$f")"; done
  ls "$bin" 2>/dev/null | tr '\n' ' '
}

comprimir_zip() {
  local carpeta="$1" zip="$2" padre nombre
  padre="$(dirname "$carpeta")"; nombre="$(basename "$carpeta")"
  rm -f "$zip"
  if command -v zip >/dev/null 2>&1; then
    # Sin comprimir (-0): los datos ya van cifrados y comprimidos por restic.
    ( cd "$padre" && zip -0 -r -q -y "$zip" "$nombre" )
  elif command -v python3 >/dev/null 2>&1; then
    ( cd "$padre" && python3 - "$zip" "$nombre" <<'PY'
import os, sys, zipfile
destino, carpeta = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(destino, 'w', zipfile.ZIP_STORED, allowZip64=True) as z:
    for raiz, _, ficheros in os.walk(carpeta):
        for f in ficheros:
            z.write(os.path.join(raiz, f))
PY
    )
  else
    die "Para preparar el kit hace falta «zip» o «python3» en el servidor («apt install zip»)."
  fi
}

cmd_kit() {
  local alcance='' objetivo='' id='' fecha='' para_panel=0 destino=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      todo|skyway|correo) alcance="$1";;
      proyecto) alcance=proyecto; objetivo="${2:-}"; shift;;
      --ejecucion) id="${2:-}"; shift;;
      --fecha) fecha="${2:-}"; shift;;
      --destino) destino="${2:-}"; shift;;
      --para-panel) para_panel=1;;
      *) die "Opción desconocida para «kit»: $1";;
    esac
    shift
  done
  alcance="${alcance:-todo}"
  exigir_root; need jq; docker_disponible
  cargar_config
  exigir_conexion
  tomar_cerrojo
  localizar_skyway
  carpeta_kits
  limpiar_kits_caducados
  [[ -n "$destino" ]] && { mkdir -p "$destino"; DIR_KITS="$(cd "$destino" && pwd)"; }
  local req="$alcance" pid=''
  local interactivo=no; [[ -t 0 && -z "$id" && -z "$fecha" && "$para_panel" != 1 ]] && interactivo=si
  if [[ "$alcance" == proyecto ]]; then
    leer_instantaneas
    elegir_ejecucion cualquiera "$id" "$fecha" "$interactivo"
    [[ -n "$objetivo" ]] || die "Indica el proyecto: «skyway copias kit proyecto <nombre>»."
    local p; p="$(buscar_proyecto "$objetivo")"
    pid="$(jq -r '.id' <<< "$p")"
    jq -e --arg a "proyecto:$pid" '.alcance == "todo" or .alcance == $a' "$MANIFIESTO" >/dev/null || die "La copia $EJECUCION no incluye ese proyecto."
    req="proyecto:$pid"
  else
    elegir_ejecucion "$req" "$id" "$fecha" "$interactivo"
  fi
  local nombre_alcance="${alcance}${pid:+-$(jq -r --arg id "$pid" '.skyway.inventario.proyectos[] | select(.id == $id) | .slug' "$MANIFIESTO")}"
  local nombre="kit-$EJECUCION-$nombre_alcance"
  en_curso kit "Preparando $nombre"
  kit_estado preparando "" 0 "$nombre_alcance"

  # Qué instantáneas van en el kit.
  local filtro
  case "$alcance" in
    todo) filtro='true';;
    skyway) filtro='.tipo == "config" or .tipo == "codigo" or .origen == "sistema"';;
    correo) filtro='.tipo == "config" or .tipo == "codigo" or .origen == "mailway"';;
    proyecto) filtro=".proyecto == \"$pid\"";;
  esac
  local -a ids=()
  local s
  while IFS= read -r s; do [[ -n "$s" ]] && ids+=("$s"); done < <(jq -r ".elementos[] | select(.snapshot != null) | select($filtro) | .snapshot" "$MANIFIESTO")
  local man
  man="$(jq -r --arg id "$EJECUCION" '[.[] | select((.tags // []) | (index("tipo:manifiesto") and index("ejecucion:" + $id)))] | sort_by(.time) | last | .id // empty' <<< "$INSTANTANEAS")"
  [[ -n "$man" ]] && ids+=("$man")
  (( ${#ids[@]} > 0 )) || die "No hay nada que meter en el kit."

  local necesario libre
  necesario="$(jq "[.elementos[] | select(.snapshot != null) | select($filtro) | .bytes // 0] | add // 0" "$MANIFIESTO")"
  libre="$(df -PB1 "$DIR_KITS" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
  if [[ -n "$libre" ]] && (( libre < necesario * 2 + 104857600 )); then
    kit_estado fallido "" 0 "$nombre_alcance" "No hay espacio suficiente en el servidor para prepararlo."
    die "No hay espacio para el kit: necesita unos $(bytes_legibles $((necesario * 2))) libres en $DIR_KITS y hay $(bytes_legibles "$libre")."
  fi
  nuevo_trabajo
  local k="$TRABAJO/$nombre"
  mkdir -p "$k/repositorio"
  paso "Copiando ${#ids[@]} instantáneas al kit"
  restic_ -v "$k/repositorio:/kit" -e RESTIC_FROM_PASSWORD_FILE=/run/skyway-copias/contrasena -e "RESTIC_FROM_REPOSITORY=${REPO_LOCAL:+/repositorio}${REPO_LOCAL:-$REPO_RESTIC}" \
    -- -r /kit init --from-repo "${REPO_LOCAL:+/repositorio}${REPO_LOCAL:-$REPO_RESTIC}" --copy-chunker-params >/dev/null \
    || { kit_estado fallido "" 0 "$nombre_alcance" "No se ha podido crear el repositorio del kit."; die "No se ha podido crear el repositorio del kit."; }
  restic_ -v "$k/repositorio:/kit" -e RESTIC_FROM_PASSWORD_FILE=/run/skyway-copias/contrasena \
    -- -r /kit copy --from-repo "${REPO_LOCAL:+/repositorio}${REPO_LOCAL:-$REPO_RESTIC}" "${ids[@]}" >/dev/null \
    || { kit_estado fallido "" 0 "$nombre_alcance" "No se han podido copiar los datos al kit."; die "No se han podido copiar los datos al kit."; }

  paso "Herramientas para descodificar"
  local binarios
  binarios="$(binarios_restic "$k/bin")"
  cp -p "$DIR_COPIAS/kit/descodificar.sh" "$DIR_COPIAS/kit/descodificar.ps1" "$DIR_COPIAS/kit/descodificar.bat" "$k/" 2>/dev/null || warn "Faltan las plantillas del kit en $DIR_COPIAS/kit."
  cp -p "$DIR_COPIAS/restaurar.sh" "$k/restaurar.sh"
  chmod 755 "$k/descodificar.sh" "$k/restaurar.sh" 2>/dev/null || true
  local contenido
  contenido="$(jq -r --arg a "$nombre_alcance" --arg bins "$binarios" '
    "Copia: \(.ejecucion) (\(.inicio[0:16] | sub("T"; " ")) UTC)",
    "Alcance del kit: \($a)",
    "Servidor: \(.servidor.nombre // "?")",
    "Skyway \(.skyway.version // "?")\(if .mailway then " · Mailway \(.mailway.version // "?") (motor \(.mailway.motor.serie // "?"))" else "" end)",
    "",
    "Proyectos y servicios:",
    ((.skyway.inventario.proyectos // [])[] | "  · \(.nombre): \([.servicios[].nombre] | join(", "))"),
    "",
    "Restic incluido para: \(if $bins == "" then "ninguno (descárgalo de https://github.com/restic/restic/releases)" else $bins end)"' "$MANIFIESTO")"
  printf '%s\n' "$contenido" > "$k/contenido.txt"
  if [[ -f "$DIR_COPIAS/kit/LEEME.txt" ]]; then
    local leeme
    leeme="$(cat "$DIR_COPIAS/kit/LEEME.txt")"
    # Reemplazos entre comillas: desde bash 5.2, un «&» sin comillas en el
    # texto nuevo (un proyecto «Acme & Co») se cambiaría por el marcador.
    local fecha_copia servidor_copia
    fecha_copia="$(jq -r '.inicio[0:16] | sub("T"; " ")' "$MANIFIESTO") UTC"
    servidor_copia="$(jq -r '.servidor.nombre // "?"' "$MANIFIESTO")"
    leeme="${leeme//\{\{FECHA\}\}/"$fecha_copia"}"
    leeme="${leeme//\{\{EJECUCION\}\}/"$EJECUCION"}"
    leeme="${leeme//\{\{ALCANCE\}\}/"$nombre_alcance"}"
    leeme="${leeme//\{\{SERVIDOR\}\}/"$servidor_copia"}"
    leeme="${leeme//\{\{VERSION_RESTIC\}\}/"$VERSION_RESTIC"}"
    leeme="${leeme//\{\{CONTENIDO\}\}/"$contenido"}"
    printf '%s\n' "$leeme" > "$k/LEEME.txt"
  fi
  paso "Comprimiendo el kit"
  local zip="$DIR_KITS/$nombre.zip"
  find "$DIR_KITS" -maxdepth 1 -name 'kit-*.zip' -delete 2>/dev/null || true
  comprimir_zip "$k" "$zip.parcial" || { kit_estado fallido "" 0 "$nombre_alcance" "No se ha podido comprimir el kit."; die "No se ha podido comprimir el kit."; }
  mv -f "$zip.parcial" "$zip"
  chmod 600 "$zip"
  local tam; tam="$(stat -c %s "$zip")"
  kit_estado listo "$nombre.zip" "$tam" "$nombre_alcance"
  ok "Kit listo: $zip ($(bytes_legibles "$tam"))."
  info "Descárgalo desde el panel (Ajustes → Copias externas) o con: scp root@$(hostname -f 2>/dev/null || hostname):$zip ."
  info "Se borra del servidor dentro de 24 horas. Para abrirlo: descomprímelo y ejecuta «descodificar» (pide la contraseña de las copias)."
}

# ---------- mantenimiento: retención, limpieza y comprobación ----------

# Qué ejecuciones se conservan. Se cuenta por ejecuciones y no por
# instantáneas sueltas: así una copia antigua siempre está entera (todos sus
# elementos) o no está.
JQ_RETENCION='
  def tag($p): (.tags // []) | map(select(startswith($p))) | first | if . then .[($p | length):] else null end;
  def epoca: strptime("%Y%m%d-%H%M%S") | mktime;
  (map(select(tag("ejecucion:") != null)) | group_by(tag("ejecucion:"))
    | map({id: (.[0] | tag("ejecucion:")),
           m: (map(select((.tags // []) | index("tipo:manifiesto"))) | last),
           ids: map(.id)})) as $ej
  | ($ej | map(select(.m != null and (.m | tag("alcance:")) == "todo" and (.m | tag("resultado:")) != "incompleta")) | sort_by(.id) | reverse) as $completas
  | ([$completas[0].id // empty]
     + ([$completas[] | {id, k: .id[0:8]}] | reduce .[] as $x ({v: [], ids: []}; if (.v | index($x.k)) or (.v | length) >= $d then . else .v += [$x.k] | .ids += [$x.id] end) | .ids)
     + ([$completas[] | {id, k: (.id | epoca | strftime("%G-%V"))}] | reduce .[] as $x ({v: [], ids: []}; if (.v | index($x.k)) or (.v | length) >= $w then . else .v += [$x.k] | .ids += [$x.id] end) | .ids)
     + ([$completas[] | {id, k: .id[0:6]}] | reduce .[] as $x ({v: [], ids: []}; if (.v | index($x.k)) or (.v | length) >= $mo then . else .v += [$x.k] | .ids += [$x.id] end) | .ids)
     + ([$ej[] | select(.m != null and (((.m | tag("alcance:")) != "todo") or ((.m | tag("resultado:")) == "incompleta")))
         | select(($ahora - (.id | epoca)) < 14 * 86400)] | sort_by(.id) | reverse | .[:20] | map(.id))
     + ([$ej[] | select(.m == null and ($ahora - (.id | epoca)) < 2 * 86400)] | map(.id))
    ) as $conservar
  | [ $ej[] | select(.id as $i | $conservar | index($i) | not) | .ids[] ]'

cmd_mantenimiento() {
  exigir_root; need jq; docker_disponible
  cargar_config
  exigir_conexion
  tomar_cerrojo
  localizar_skyway
  mantenimiento_retencion
  mantenimiento_limpieza forzar
}

mantenimiento_retencion() {
  leer_instantaneas
  local olvidar n
  olvidar="$(jq -r --argjson d "$CFG_RETENCION_DIARIAS" --argjson w "$CFG_RETENCION_SEMANALES" --argjson mo "$CFG_RETENCION_MENSUALES" \
    --argjson ahora "$(date -u +%s)" "$JQ_RETENCION | .[]" <<< "$INSTANTANEAS")"
  n="$(printf '%s' "$olvidar" | grep -c . || true)"
  if (( n > 0 )); then
    info "Retirando $n instantáneas de copias que ya no se conservan…"
    local -a lote=()
    local s
    while IFS= read -r s; do
      [[ -n "$s" ]] || continue
      lote+=("$s")
      if (( ${#lote[@]} >= 200 )); then restic_ -- forget "${lote[@]}" >/dev/null || return 1; lote=(); fi
    done <<< "$olvidar"
    if (( ${#lote[@]} > 0 )); then restic_ -- forget "${lote[@]}" >/dev/null || return 1; fi
  fi
  actualizar_lista
}

# Limpiar (prune) y comprobar el repositorio cuesta: una vez por semana, y la
# lectura de una parte de los datos, una vez al mes.
mantenimiento_limpieza() {
  local forzar="${1:-}" ahora marca
  ahora="$(date -u +%s)"
  marca="$(cat "$ESTADO_DIR/ultima-limpieza" 2>/dev/null || echo 0)"
  if [[ "$forzar" == forzar ]] || (( ahora - marca > 6 * 86400 )); then
    info "Limpiando el repositorio (datos que ya no usa ninguna copia)…"
    restic_ -- prune --max-unused 10% >/dev/null || return 1
    printf '%s\n' "$ahora" > "$ESTADO_DIR/ultima-limpieza"
    comprobar_repositorio "$( (( ahora - $(cat "$ESTADO_DIR/ultima-lectura" 2>/dev/null || echo 0) > 27 * 86400 )) && echo a-fondo )" || return 1
  fi
}

mantenimiento_programado() {
  mantenimiento_retencion && mantenimiento_limpieza || return 1
  local ultima
  ultima="$(cat "$ESTADO_DIR/ultima-prueba-restauracion" 2>/dev/null || echo 0)"
  if (( $(date -u +%s) - ultima > 27 * 86400 )); then
    info "Restauración de prueba mensual…"
    # En un subshell: un fallo al leer la copia no convierte en fallida la
    # copia que acaba de terminar bien (ya avisa la propia prueba).
    ( prueba_restauracion ) || warn "La restauración de prueba ha fallado: revisa «sudo skyway copias comprobar»."
  fi
}

comprobar_repositorio() {
  local fondo="${1:-}" salida codigo=0 detalle
  local -a extra=()
  [[ "$fondo" == a-fondo ]] && extra=(--read-data-subset=5%)
  salida="$(restic_ -- check ${extra[@]+"${extra[@]}"} 2>&1)" || codigo=$?
  if [[ "$codigo" == 0 ]]; then
    detalle="Repositorio sin errores$( [[ "$fondo" == a-fondo ]] && echo ', con lectura del 5 % de los datos')."
    [[ "$fondo" == a-fondo ]] && date -u +%s > "$ESTADO_DIR/ultima-lectura"
    estado_set '.ultimaComprobacion = {fecha: $f, resultado: "correcta", detalle: $d}' --arg f "$(ahora_iso)" --arg d "$detalle"
    ok "$detalle"
    return 0
  fi
  detalle="$(printf '%s' "$salida" | grep -iE 'error|fail' | head -n 3 | tr '\n' ' ' || true)"
  estado_set '.ultimaComprobacion = {fecha: $f, resultado: "fallida", detalle: $d}' --arg f "$(ahora_iso)" --arg d "${detalle:-restic check ha fallado}"
  fallo "La comprobación del repositorio ha encontrado errores: ${detalle:-revisa «restic check»}."
  notificar error "La comprobación de las copias externas ha encontrado errores: ${detalle:-restic check ha fallado}."
  return 1
}

# Restauración de prueba de la última copia completa: la base del panel se
# restaura en una carpeta temporal y se abre (comprobación de integridad de
# SQLite con la propia imagen de Skyway). Una copia que nunca se ha probado a
# restaurar no da ninguna garantía: la copia programada lo hace una vez al mes.
prueba_restauracion() {
  [[ -n "$INSTANTANEAS" ]] || leer_instantaneas
  local id
  id="$(jq -r "$JQ_EJECUCIONES | [.[] | select(.alcance == \"todo\" and .resultado != \"incompleta\")] | first | .id // empty" <<< "$INSTANTANEAS")"
  if [[ -z "$id" ]]; then
    info "Todavía no hay ninguna copia completa para la restauración de prueba."
    return 0
  fi
  cargar_manifiesto "$id"
  EJECUCION="$id"
  [[ -n "$TRABAJO" && -d "$TRABAJO" ]] || nuevo_trabajo
  local vol snap resultado=fallida detalle integridad='sin comprobar'
  vol="$(jq -r '.skyway.volumenes.datos // empty' "$MANIFIESTO")"
  snap="$(instantanea_de ".tipo == \"volumen\" and .nombre == \"$vol\"")"
  rm -rf "$TRABAJO/prueba" && mkdir -p "$TRABAJO/prueba"
  if [[ -z "$snap" ]]; then
    detalle="La copia $id no tiene la base del panel."
  elif ! restic_ -v "$TRABAJO/prueba:/salida" -- restore "$snap:/volumenes/$vol" --target /salida --include /skyway.db >/dev/null 2>&1 \
      || [[ ! -s "$TRABAJO/prueba/skyway.db" ]] || ! head -c 16 "$TRABAJO/prueba/skyway.db" | grep -q 'SQLite format 3'; then
    detalle="No se ha podido restaurar la base del panel de la copia $id."
  else
    if [[ -n "$IMAGEN_SKYWAY" ]]; then
      integridad="$(docker run --rm --network none --entrypoint node -v "$TRABAJO/prueba:/p" "$IMAGEN_SKYWAY" \
        -e "const D=require('better-sqlite3');const db=new D('/p/skyway.db',{readonly:true});console.log(db.pragma('integrity_check',{simple:true}))" 2>/dev/null || echo 'sin comprobar')"
    fi
    if [[ "$integridad" == ok || "$integridad" == 'sin comprobar' ]]; then
      resultado=correcta
      detalle="La base del panel de la copia $id se restaura y se abre bien (integridad: $integridad)."
    else
      detalle="La base del panel de la copia $id no pasa la comprobación de integridad: $integridad"
    fi
  fi
  rm -rf "$TRABAJO/prueba"
  estado_set '.ultimaPruebaRestauracion = {fecha: $f, ejecucion: $id, resultado: $r, detalle: $d}' \
    --arg f "$(ahora_iso)" --arg id "$id" --arg r "$resultado" --arg d "$detalle"
  date -u +%s > "$ESTADO_DIR/ultima-prueba-restauracion"
  if [[ "$resultado" == correcta ]]; then ok "$detalle"; return 0; fi
  fallo "$detalle"
  notificar error "Restauración de prueba de las copias externas: $detalle"
  return 1
}

# comprobar: el repositorio y, además, una restauración de prueba de la base
# del panel de la última copia (que se abre y pasa su comprobación de integridad).
cmd_comprobar() {
  local fondo=''
  [[ "${1:-}" == --a-fondo ]] && fondo='a-fondo'
  exigir_root; need jq; docker_disponible
  cargar_config
  exigir_conexion
  tomar_cerrojo
  localizar_skyway
  en_curso comprobacion "Comprobando el repositorio"
  local bien=1
  comprobar_repositorio "$fondo" || bien=0
  paso "Restauración de prueba"
  prueba_restauracion || bien=0
  fin_en_curso
  (( bien )) || return 1
}

# ---------- configurar ----------

cmd_configurar() {
  exigir_root; need jq; need curl; docker_disponible
  [[ -t 0 ]] || die "«configurar» es interactivo: ejecútalo en una terminal."
  leer_config || true
  local era_b2=0 prefijo region_defecto
  if configuradas && es_backblaze; then era_b2=1; fi
  prefijo="${CFG_S3_PREFIJO:-$(hostname -s 2>/dev/null | tr -cd 'A-Za-z0-9._-' || echo servidor)}"
  titulo "Copias externas: destino S3"
  CFG_S3_PROVEEDOR="$(elegir "$(printf 'backblaze\tBackblaze B2 (recomendado): lo prepara todo con la clave maestra de tu cuenta\notro\tOtro S3 compatible (Cubbit, Amazon S3…)')" 'Dónde se guardan las copias')"
  if [[ "$CFG_S3_PROVEEDOR" == backblaze ]]; then
    configurar_backblaze "$prefijo" "$era_b2"
  else
    info "Ejemplos: Cubbit, https://s3.cubbit.eu (región eu-west-1); Amazon S3 en España, https://s3.eu-south-2.amazonaws.com (región eu-south-2). Crea antes en su consola una clave para este servidor, limitada al bucket y sin permiso para saltarse el bloqueo."
    CFG_S3_ENDPOINT="$(preguntar 'Endpoint del S3' "$CFG_S3_ENDPOINT")"
    region_defecto="$(region_de_endpoint "$CFG_S3_ENDPOINT")"
    CFG_S3_REGION="$(preguntar 'Región' "${region_defecto:-$CFG_S3_REGION}")"
    CFG_S3_BUCKET="$(preguntar 'Bucket' "$CFG_S3_BUCKET")"
    CFG_S3_PREFIJO="$(preguntar 'Carpeta dentro del bucket (una por servidor)' "$prefijo")"
    CFG_S3_ESTILO="${CFG_S3_ESTILO:-auto}"
    validar_config
    local ak sk
    ak="$(preguntar 'Access key')"
    sk="$(preguntar_secreto 'Secret key')"
    [[ -n "$ak" && -n "$sk" && "$ak$sk" != *$'\n'* ]] || die "Faltan las credenciales."
    mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
    printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$ak" "$sk" | escribir_atomico "$CONFIG_DIR/s3.env" 600
  fi
  escribir_config

  titulo "Bucket"
  s3_responde || die "No se puede conectar con $CFG_S3_ENDPOINT: revisa el endpoint y la red del servidor."
  comprobar_bucket

  titulo "Contraseña de las copias"
  if [[ -s "$CONFIG_DIR/contrasena" ]]; then
    info "Ya hay una contraseña guardada en $CONFIG_DIR/contrasena: se mantiene."
  else
    local c
    if confirmar "¿Generar una contraseña segura? (si no, la escribes tú)"; then
      # 30 bytes al azar en hexadecimal (60 caracteres), sin tuberías que se corten.
      c="$(od -An -N30 -tx1 /dev/urandom | tr -d ' \n')"
    else
      c="$(preguntar_secreto 'Contraseña (mínimo 16 caracteres)')"
      [[ ${#c} -ge 16 ]] || die "La contraseña debe tener al menos 16 caracteres."
      [[ "$c" == "$(preguntar_secreto 'Repítela')" ]] || die "Las contraseñas no coinciden."
    fi
    printf '%s\n' "$c" | escribir_atomico "$CONFIG_DIR/contrasena" 600
  fi
  cargar_config
  titulo "Repositorio"
  asegurar_repositorio
  # Prueba real de escritura y borrado: con el bloqueo de objetos, algunos S3
  # exigen cabeceras que no todos los clientes envían. Mejor saberlo ahora
  # que a las tres de la mañana.
  local prueba
  prueba="$(printf 'prueba de escritura %s\n' "$(ahora_iso)" | restic_ -- backup --stdin --stdin-filename prueba/escritura.txt --json --tag skyway-copias-prueba --host "$HOST_RESTIC" 2>&1 | jq -r 'select(.message_type == "summary") | .snapshot_id' 2>/dev/null || true)"
  [[ -n "$prueba" ]] || die "No se ha podido escribir en el repositorio. Revisa los permisos de la clave en el bucket."
  restic_ -- forget "$prueba" >/dev/null 2>&1 || warn "La clave puede escribir pero no retirar instantáneas: la limpieza de copias antiguas fallará. Dale permiso de borrado (los datos siguen protegidos por el bloqueo)."
  ok "El repositorio funciona: escritura y retirada comprobadas."
  mkdir_estado
  localizar_skyway
  estado_base
  imprimir_datos_recuperacion
  info "Siguiente paso: «sudo skyway copias activar» (copia diaria) y «sudo skyway copias copia» para la primera."
}

# Bloqueo de objetos y ciclo de vida. Si la clave no puede consultarlo
# (las claves restringidas no suelen poder), se explica qué revisar en la consola.
comprobar_bucket() {
  local lock salida
  if ! salida="$(aws_ s3api head-bucket --bucket "$CFG_S3_BUCKET" 2>&1)"; then
    if [[ "$salida" == *404* || "$salida" == *NotFound* || "$salida" == *NoSuchBucket* ]]; then
      if confirmar "El bucket «$CFG_S3_BUCKET» no existe. ¿Crearlo con bloqueo de objetos (30 días) y limpieza de versiones antiguas?"; then
        aws_ s3api create-bucket --bucket "$CFG_S3_BUCKET" --object-lock-enabled-for-bucket >/dev/null \
          || die "No se ha podido crear el bucket: créalo en la consola del proveedor con «Object Lock» activado."
        ok "Bucket creado con bloqueo de objetos."
      else
        die "Crea el bucket en la consola del proveedor (con «Object Lock») y vuelve a ejecutar «configurar»."
      fi
    else
      warn "No se ha podido consultar el bucket (${salida%%$'\n'*}). Se sigue: la prueba de escritura dirá si la clave funciona."
      return 0
    fi
  fi
  # Backblaze preparado por «configurar»: el bloqueo y el ciclo de vida ya se
  # han comprobado (y dicho) con su API nativo.
  [[ -z "$B2_BUCKET_ID" ]] || return 0
  # Una clave restringida (la recomendada para el servidor) no suele poder
  # leer la configuración del bucket: eso no es «sin bloqueo», es «no se sabe».
  local err codigo=0
  err="$(mktemp)"
  lock="$(aws_ s3api get-object-lock-configuration --bucket "$CFG_S3_BUCKET" 2>"$err")" || codigo=$?
  if [[ "$codigo" != 0 ]] && ! grep -q 'ObjectLockConfigurationNotFound' "$err"; then
    rm -f "$err"
    info "La clave no puede consultar el bloqueo de objetos del bucket (lo normal en una clave restringida). Comprueba en la consola del proveedor: «Object Lock» activado, retención por defecto de 30 días y una regla que borre las versiones antiguas a los 31 días."
    return 0
  fi
  rm -f "$err"
  if jq -e '.ObjectLockConfiguration.ObjectLockEnabled == "Enabled"' >/dev/null 2>&1 <<< "$lock"; then
    if jq -e '.ObjectLockConfiguration.Rule.DefaultRetention' >/dev/null 2>&1 <<< "$lock"; then
      ok "Bloqueo de objetos activo: $(jq -r '.ObjectLockConfiguration.Rule.DefaultRetention | "\(.Days // .Years) \(if .Days then "días" else "años" end), modo \(.Mode)"' <<< "$lock")."
    elif confirmar "El bucket tiene el bloqueo activado pero sin retención por defecto. ¿Fijar 30 días en modo GOVERNANCE?"; then
      aws_ s3api put-object-lock-configuration --bucket "$CFG_S3_BUCKET" \
        --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":30}}}' >/dev/null \
        && ok "Retención por defecto: 30 días." || warn "No se ha podido fijar la retención: hazlo en la consola (Object Lock → retención por defecto)."
    fi
    local ciclo codigo_ciclo=0
    if es_backblaze; then
      # Su API S3 no tiene ciclo de vida: la regla la pone «configurar» con el
      # API nativo (y ya lo ha dicho) o se pone a mano en su web.
      [[ "$B2_CICLO_OK" == 1 ]] || info "En Backblaze, la regla que borra lo que las copias retiran está en su web: bucket → «Lifecycle Settings» → «Keep prior versions for this number of days»: 31."
      return 0
    fi
    err="$(mktemp)"
    ciclo="$(aws_ s3api get-bucket-lifecycle-configuration --bucket "$CFG_S3_BUCKET" 2>"$err")" || codigo_ciclo=$?
    if [[ "$codigo_ciclo" != 0 ]] && ! grep -q 'NoSuchLifecycleConfiguration' "$err"; then
      info "No se puede consultar la regla de ciclo de vida: comprueba en la consola que las versiones antiguas se borran a los 31 días."
    elif ! jq -e '.Rules[]? | select(.NoncurrentVersionExpiration)' >/dev/null 2>&1 <<< "$ciclo"; then
      if confirmar "¿Borrar solas las versiones antiguas de los objetos 31 días después (para no llenar el espacio)?"; then
        aws_ s3api put-bucket-lifecycle-configuration --bucket "$CFG_S3_BUCKET" \
          --lifecycle-configuration '{"Rules":[{"ID":"skyway-copias-versiones","Status":"Enabled","Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":31}}]}' >/dev/null \
          && ok "Versiones antiguas: se borran a los 31 días." || warn "No se ha podido crear la regla: créala en la consola (Lifecycle → NoncurrentVersionExpiration, 31 días)."
      fi
    else
      ok "Las versiones antiguas se borran solas (regla de ciclo de vida)."
    fi
    rm -f "$err"
  else
    warn "El bucket no tiene bloqueo de objetos (Object Lock): alguien con acceso al servidor podría borrar las copias. Solo se activa al crear el bucket: crea uno nuevo con «Object Lock» si quieres esa protección."
  fi
}

imprimir_datos_recuperacion() {
  leer_config
  local ak sk
  ak="$(sed -n 's/^AWS_ACCESS_KEY_ID=//p' "$CONFIG_DIR/s3.env")"; sk="$(sed -n 's/^AWS_SECRET_ACCESS_KEY=//p' "$CONFIG_DIR/s3.env")"
  titulo "DATOS DE RECUPERACIÓN — guárdalos FUERA de este servidor (gestor de contraseñas)"
  cat >&2 <<EOF
Sin estos datos las copias no se pueden leer. Con ellos, en un servidor nuevo:
  sudo bash restaurar.sh      (de github.com/NkrowOne/Skyway, scripts/copias/restaurar.sh, o del kit)

S3_ENDPOINT=$CFG_S3_ENDPOINT
S3_REGION=$CFG_S3_REGION
S3_BUCKET=$CFG_S3_BUCKET
S3_PREFIJO=$CFG_S3_PREFIJO
S3_ACCESS_KEY=$ak
S3_SECRET_KEY=$sk
CONTRASENA=$(cat "$CONFIG_DIR/contrasena")
EOF
  if es_backblaze; then
    info "Guarda también la clave maestra de Backblaze (no está en este servidor ni en estos datos): hace falta para «recuperar-bucket»."
  fi
}

cmd_datos_recuperacion() {
  exigir_root
  configuradas || die "Las copias no están configuradas."
  confirmar "Se mostrarán en pantalla las claves y la contraseña de las copias. ¿Continuar?" || return 0
  imprimir_datos_recuperacion
}

# ---------- programación (systemd) y peticiones del panel ----------

systemd_ruta() {
  [[ "$1" != *$'\n'* ]] || die "La ruta $1 contiene un salto de línea."
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')"
}

cmd_activar() {
  local hora=''
  while [[ $# -gt 0 ]]; do
    case "$1" in --hora) hora="${2:-}"; shift;; *) die "Opción desconocida para «activar»: $1";; esac
    shift
  done
  exigir_root; docker_disponible
  cargar_config
  command -v systemctl >/dev/null 2>&1 || die "Este servidor no usa systemd: programa «$SELF copia --motivo programada --auto» con cron."
  [[ -z "$hora" ]] || CFG_HORA="$hora"
  validar_config
  escribir_config
  localizar_skyway
  local exec; exec="/bin/bash $(systemd_ruta "$SELF")"
  mkdir -p "$SYSTEMD_DIR"
  escribir_atomico "$SYSTEMD_DIR/$UNIDAD.service" 644 <<EOF
# Generado por «skyway copias activar»: no lo edites a mano.
[Unit]
Description=Copias externas de Skyway y Mailway
Documentation=https://github.com/NkrowOne/Skyway/blob/main/docs/COPIAS.md
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=root
ExecStart=$exec copia --motivo programada --auto
# La primera copia sube todo y puede tardar horas; las siguientes, minutos.
TimeoutStartSec=12h
# Que la copia no le quite CPU ni disco a las webs.
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF
  escribir_atomico "$SYSTEMD_DIR/$UNIDAD.timer" 644 <<EOF
# Generado por «skyway copias activar»: no lo edites a mano.
[Unit]
Description=Copias externas de Skyway y Mailway (cada día a las $CFG_HORA)

[Timer]
OnCalendar=*-*-* $CFG_HORA:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  escribir_atomico "$SYSTEMD_DIR/$UNIDAD_PETICIONES.service" 644 <<EOF
# Generado por «skyway copias activar»: atiende lo que se pide desde el panel.
[Unit]
Description=Peticiones del panel para las copias externas
After=docker.service

[Service]
Type=oneshot
User=root
ExecStart=$exec atender
TimeoutStartSec=12h
Nice=10
EOF
  if [[ -n "$DIR_PANEL" ]]; then
    escribir_atomico "$SYSTEMD_DIR/$UNIDAD_PETICIONES.path" 644 <<EOF
# Generado por «skyway copias activar». La carpeta es la de los datos del
# panel: si el volumen de datos de Skyway cambia, vuelve a ejecutar «activar».
[Unit]
Description=Peticiones del panel para las copias externas

[Path]
DirectoryNotEmpty=$DIR_PANEL/peticiones
MakeDirectory=yes

[Install]
WantedBy=paths.target
EOF
  fi
  systemctl daemon-reload || die "No se ha podido recargar systemd."
  systemctl enable --now "$UNIDAD.timer" >/dev/null || die "No se ha podido activar $UNIDAD.timer."
  if [[ -n "$DIR_PANEL" ]]; then systemctl enable --now "$UNIDAD_PETICIONES.path" >/dev/null || warn "No se ha podido activar la recepción de peticiones del panel."; fi
  mkdir_estado
  estado_base
  ok "Copia diaria activada a las $CFG_HORA (con hasta 10 minutos de margen)."
  [[ -n "$DIR_PANEL" ]] && info "El panel ya puede pedir copias y kits (Ajustes → Copias externas)." || warn "No se ha encontrado el volumen de datos de Skyway: el panel no podrá pedir copias ni kits."
}

cmd_desactivar() {
  exigir_root
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$UNIDAD.timer" "$UNIDAD_PETICIONES.path" >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_DIR/$UNIDAD.timer" "$SYSTEMD_DIR/$UNIDAD.service" "$SYSTEMD_DIR/$UNIDAD_PETICIONES.path" "$SYSTEMD_DIR/$UNIDAD_PETICIONES.service"
  command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload >/dev/null 2>&1 || true
  if configuradas; then cargar_config; localizar_skyway; mkdir_estado; estado_base; fi
  ok "Copia diaria desactivada. Las copias que ya hay en el bucket se conservan."
}

cmd_estado() {
  exigir_root
  if ! configuradas; then
    printf '%s\n' "Copias externas: sin configurar. Empieza con «sudo skyway copias configurar»."
    return 0
  fi
  leer_config
  printf '%s\n' "Destino: $CFG_S3_ENDPOINT · bucket $CFG_S3_BUCKET · carpeta $CFG_S3_PREFIJO"
  printf '%s\n' "Retención: $CFG_RETENCION_DIARIAS diarias, $CFG_RETENCION_SEMANALES semanales, $CFG_RETENCION_MENSUALES mensuales"
  if [[ -f "$SYSTEMD_DIR/$UNIDAD.timer" ]]; then
    printf '%s\n' "Copia diaria: activada a las $CFG_HORA. Próxima: $(systemctl show "$UNIDAD.timer" -p NextElapseUSecRealtime --value 2>/dev/null || echo '?')."
  else
    printf '%s\n' "Copia diaria: desactivada («sudo skyway copias activar»)."
  fi
  if [[ -f "$ESTADO_DIR/estado.json" ]]; then
    jq -r '
      (if .ultima then "Última copia: \(.ultima.id) · \(.ultima.resultado) · \(.ultima.detalle // "")" else "Última copia: ninguna todavía." end),
      (if .ultimaCorrecta then "Última correcta: \(.ultimaCorrecta.id)" else empty end),
      (if .ultimaComprobacion then "Última comprobación: \(.ultimaComprobacion.fecha) · \(.ultimaComprobacion.resultado)" else empty end),
      (if .enCurso then "En curso: \(.enCurso.accion) desde \(.enCurso.inicio) — \(.enCurso.paso // "")" else empty end),
      ((.ultima.avisos // [])[] | "  ! " + .)' "$ESTADO_DIR/estado.json"
  fi
  [[ -n "$CFG_AVISO_URL" ]] && printf '%s\n' "Vigilante externo: configurado (AVISO_URL)." || printf '%s\n' "Vigilante externo: sin configurar (AVISO_URL en $CONFIG_DIR/config, p. ej. healthchecks.io)."
}

# Atiende las peticiones del panel (las lanza la unidad .path de systemd).
cmd_atender() {
  exigir_root; need jq; docker_disponible
  cargar_config
  tomar_cerrojo si
  localizar_skyway
  [[ -n "$DIR_PANEL" ]] || return 0
  local f nombre peticion accion alcance proyecto ejecucion resultado detalle
  for f in "$DIR_PANEL"/peticiones/*; do
    [[ -e "$f" ]] || continue
    nombre="$(basename "$f")"
    peticion=''
    if [[ "$nombre" =~ ^[0-9]{13}-[0-9a-f]{4}\.json$ && -f "$f" && ! -L "$f" && $(stat -c %s "$f") -lt 4096 ]]; then peticion="$(cat "$f")"; fi
    rm -f "$f"
    jq -e '.formato == 1 and (.accion | IN("copia", "comprobar", "kit"))' >/dev/null 2>&1 <<< "$peticion" || {
      [[ -n "$peticion" ]] && estado_set '.ultimaPeticion = {id: $id, accion: null, resultado: "fallida", detalle: "Petición no válida.", fecha: $f}' --arg id "${nombre%.json}" --arg f "$(ahora_iso)"
      continue
    }
    accion="$(jq -r '.accion' <<< "$peticion")"
    alcance="$(jq -r '.alcance // "todo"' <<< "$peticion")"
    proyecto="$(jq -r '.proyecto // empty' <<< "$peticion")"
    ejecucion="$(jq -r '.ejecucion // empty' <<< "$peticion")"
    local -a args=()
    case "$accion" in
      copia) args=(copia --motivo panel);;
      comprobar) args=(comprobar);;
      kit)
        [[ "$alcance" =~ ^(todo|skyway|correo|proyecto)$ ]] || continue
        args=(kit "$alcance")
        if [[ "$alcance" == proyecto ]]; then
          [[ "$proyecto" =~ ^prj_[a-z0-9]{1,64}$ ]] || continue
          args+=("$proyecto")
        fi
        if [[ -n "$ejecucion" ]]; then [[ "$ejecucion" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue; args+=(--ejecucion "$ejecucion"); fi
        args+=(--para-panel);;
    esac
    # Cada petición en su propio proceso: un fallo (die) de una no corta las
    # demás, y el cerrojo lo hereda el hijo.
    if detalle="$(COPIAS_CERROJO_HEREDADO=1 bash "$SELF" "${args[@]}" 2>&1)"; then resultado=correcta; else resultado=fallida; fi
    estado_set '.ultimaPeticion = {id: $id, accion: $a, resultado: $r, detalle: $d, fecha: $f}' \
      --arg id "${nombre%.json}" --arg a "$accion" --arg r "$resultado" --arg d "$(printf '%s' "$detalle" | sed 's/\x1b\[[0-9;]*m//g' | tail -n 3 | tr '\n' ' ' | head -c 400)" --arg f "$(ahora_iso)"
  done
}

# ---------- recuperar el bucket tras un borrado ----------
#
# Con el bloqueo de objetos, borrar (o sobrescribir) solo añade marcas y
# versiones nuevas: lo anterior sigue ahí. Esto devuelve la carpeta de las
# copias a como estaba en una fecha. Hace falta una clave de ADMINISTRACIÓN
# del bucket (la del servidor no puede saltarse el bloqueo), que se pide y no
# se guarda. Con Backblaze se pide la clave maestra y, con ella, se crea una
# clave temporal (una hora, solo para el bucket) que sí puede, y se borra al
# terminar: su API S3 no acepta la clave maestra.
cmd_recuperar_bucket() {
  local desde=''
  [[ "${1:-}" == --desde ]] && desde="${2:-}"
  [[ "$desde" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z?)?$ ]] || die "Uso: skyway copias recuperar-bucket --desde AAAA-MM-DD[THH:MM:SSZ] (lo hecho en el bucket desde ese momento se deshace)."
  [[ "$desde" == *T* ]] || desde="${desde}T00:00:00Z"
  [[ "$desde" == *Z ]] || desde="${desde}Z"
  exigir_root; need jq; docker_disponible
  cargar_config
  [[ -t 0 ]] || die "Es interactivo: ejecútalo en una terminal."
  local ak sk tmp temporal=''
  if es_backblaze; then
    info "Backblaze: con la clave maestra se crea una clave temporal (una hora, solo para este bucket) que puede saltarse el bloqueo. Se borra al terminar."
    local id clave par bucket
    id="$(preguntar 'keyID de la clave maestra')"
    clave="$(preguntar_secreto 'applicationKey de la clave maestra')"
    b2_autorizar "$id" "$clave"
    bucket="$(b2_id_bucket)"
    [[ -n "$bucket" ]] || die "El bucket «$CFG_S3_BUCKET» no está en esa cuenta de Backblaze."
    B2_BUCKET_ID="$(jq -r '.bucketId // empty' <<< "$bucket")"
    par="$(b2_crear_clave skyway-copias-recuperar 3600 "${CAPACIDADES_B2_RECUPERAR[@]}")"
    ak="${par%%$'\t'*}"; sk="${par#*$'\t'}"; temporal="$ak"
  else
    ak="$(preguntar 'Access key de ADMINISTRACIÓN del bucket')"
    sk="$(preguntar_secreto 'Secret key de administración')"
  fi
  tmp="$(mktemp)"; chmod 600 "$tmp"
  printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$ak" "$sk" > "$tmp"
  # Lo que se deja al salir por cualquier camino: el fichero con la clave y,
  # con Backblaze, la clave temporal.
  fin_recuperar() { rm -f "$tmp"; [[ -z "$temporal" ]] || b2_borrar_clave "$temporal"; temporal=''; }
  [[ -z "$temporal" ]] || AWS_ENV_FILE="$tmp" esperar_clave_s3
  local versiones
  versiones="$(AWS_ENV_FILE="$tmp" aws_ s3api list-object-versions --bucket "$CFG_S3_BUCKET" --prefix "$CFG_S3_PREFIJO/" --output json)" \
    || { fin_recuperar; die "No se han podido listar las versiones del bucket con esa clave."; }
  local plan
  plan="$(jq -c --arg d "$desde" '[ (.Versions // [])[] | select(.LastModified >= $d) | {Key, VersionId, tipo: "version"} ]
      + [ (.DeleteMarkers // [])[] | select(.LastModified >= $d) | {Key, VersionId, tipo: "marca"} ]' <<< "$versiones")"
  local n_v n_m
  n_v="$(jq '[.[] | select(.tipo == "version")] | length' <<< "$plan")"; n_m="$(jq '[.[] | select(.tipo == "marca")] | length' <<< "$plan")"
  if [[ "$n_v" == 0 && "$n_m" == 0 ]]; then fin_recuperar; ok "No hay cambios en el bucket desde $desde."; return 0; fi
  warn "Desde $desde hay $n_m borrados y $n_v objetos nuevos o sobrescritos en $CFG_S3_BUCKET/$CFG_S3_PREFIJO. Se deshacen todos: las copias hechas después de esa fecha también desaparecen."
  confirmar "¿Devolver la carpeta de copias a como estaba el $desde?" || { fin_recuperar; info "Cancelado."; return 0; }
  local k v t err=0
  while IFS=$'\t' read -r k v t; do
    [[ -n "$k" ]] || continue
    if [[ "$t" == version ]]; then
      AWS_ENV_FILE="$tmp" aws_ s3api delete-object --bucket "$CFG_S3_BUCKET" --key "$k" --version-id "$v" --bypass-governance-retention >/dev/null 2>&1 || err=$((err + 1))
    else
      AWS_ENV_FILE="$tmp" aws_ s3api delete-object --bucket "$CFG_S3_BUCKET" --key "$k" --version-id "$v" >/dev/null 2>&1 || err=$((err + 1))
    fi
  done < <(jq -r '.[] | "\(.Key)\t\(.VersionId)\t\(.tipo)"' <<< "$plan")
  fin_recuperar
  (( err == 0 )) || warn "$err cambios no se han podido deshacer (con el modo COMPLIANCE nadie puede, hasta que caduque el bloqueo)."
  info "Comprobando el repositorio…"
  restic_ -- check >/dev/null 2>&1 && ok "Repositorio recuperado y sin errores." || warn "El repositorio aún tiene errores: «sudo skyway copias comprobar»."
}

# ---------- menú ----------

cmd_menu() {
  [[ -t 0 ]] || { ayuda; exit 1; }
  local op
  op="$(elegir "$(printf '%s\n' \
    $'lista\tVer las copias' \
    $'copia\tHacer una copia ahora' \
    $'r-todo\tRestaurar todo (también en un servidor nuevo)' \
    $'r-proyecto\tRestaurar un proyecto' \
    $'r-servicio\tRestaurar un servicio' \
    $'r-correo\tRestaurar solo el correo (Mailway)' \
    $'r-skyway\tRestaurar solo el panel de Skyway' \
    $'extraer\tSacar ficheros de una copia a una carpeta (sin tocar nada)' \
    $'kit\tPreparar un kit para descargar' \
    $'comprobar\tComprobar las copias' \
    $'estado\tEstado y programación' \
    $'configurar\tConfigurar el destino S3')" "Copias externas de Skyway")"
  case "$op" in
    lista) cmd_lista;;
    copia) cmd_copia;;
    r-todo) cmd_restaurar todo;;
    r-proyecto) cmd_restaurar proyecto;;
    r-servicio) cmd_restaurar servicio;;
    r-correo) cmd_restaurar correo;;
    r-skyway) cmd_restaurar skyway;;
    extraer) cmd_extraer "$(preguntar 'Carpeta de destino' /root/recuperado)";;
    kit)
      local a; a="$(elegir $'todo\tTodo\nskyway\tSolo el panel de Skyway\ncorreo\tSolo el correo\nproyecto\tUn proyecto' '¿Qué incluye el kit?')"
      if [[ "$a" == proyecto ]]; then cmd_kit proyecto "$(preguntar 'Proyecto (nombre o slug)')"; else cmd_kit "$a"; fi;;
    comprobar) cmd_comprobar;;
    estado) cmd_estado;;
    configurar) cmd_configurar;;
  esac
}

ayuda() {
  cat >&2 <<EOF
${C_BOLD}skyway copias${C_RESET} — copias externas cifradas (S3) de Skyway, sus proyectos y Mailway

  ${C_ACC}configurar${C_RESET}                    Destino S3 (Backblaze B2…), contraseña y prueba del bucket
  ${C_ACC}activar${C_RESET} [--hora HH:MM]        Copia diaria (por defecto 03:30) y peticiones del panel
  ${C_ACC}desactivar${C_RESET} | ${C_ACC}estado${C_RESET}
  ${C_ACC}copia${C_RESET} [--alcance A]           Copia ahora (todo, skyway, correo o proyecto:<id>)
  ${C_ACC}lista${C_RESET} | ${C_ACC}ver${C_RESET} <copia>            Copias disponibles y su contenido
  ${C_ACC}restaurar${C_RESET} <qué> [opciones]   todo | skyway | correo | proyecto <x> | servicio <x> | volumen <x>
      --ejecucion ID | --fecha AAAA-MM-DD   de qué copia (por defecto, la última válida)
      --volcados                            bases desde su volcado SQL (versiones nuevas del motor)
      -y                                    sin preguntas
  ${C_ACC}extraer${C_RESET} <carpeta>             Saca ficheros de una copia sin tocar nada en marcha
  ${C_ACC}kit${C_RESET} [todo|skyway|correo|proyecto <x>]   ZIP para guardar en local (se descodifica con la contraseña)
  ${C_ACC}comprobar${C_RESET} [--a-fondo]         Revisa el repositorio y prueba a restaurar la base del panel
  ${C_ACC}mantenimiento${C_RESET}                 Retención y limpieza ahora (lo hace sola la copia diaria)
  ${C_ACC}datos-recuperacion${C_RESET}            Lo que hay que guardar fuera para restaurar en otro servidor
  ${C_ACC}recuperar-bucket${C_RESET} --desde F    Deshace borrados del bucket (con la clave de administración)

En un servidor nuevo: sudo bash restaurar.sh   (scripts/copias/restaurar.sh o el del kit)
Guía completa: docs/COPIAS.md
EOF
}

main() {
  local cmd="${1:-}"
  [[ $# -gt 0 ]] && shift
  # Opciones globales en cualquier posición.
  local -a resto=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes) ASUMIR_SI=1; resto+=("$1");;
      --auto) AUTO=1; ASUMIR_SI=1;;
      # Un repositorio en una carpeta (el de un kit) en lugar del S3.
      --repositorio-local)
        [[ -d "${2:-}" ]] || die "--repositorio-local necesita la carpeta «repositorio» de un kit."
        REPO_LOCAL="$(cd "$2" && pwd)"; shift;;
      *) resto+=("$1");;
    esac
    shift
  done
  set -- ${resto[@]+"${resto[@]}"}
  # Una petición del panel ya tiene el cerrojo (lo tomó «atender»).
  if [[ -n "${COPIAS_CERROJO_HEREDADO:-}" ]]; then tomar_cerrojo() { mkdir_estado; }; fi
  case "$cmd" in
    '') if [[ -t 0 ]]; then exigir_root; cmd_menu; else ayuda; exit 1; fi;;
    configurar) cmd_configurar "$@";;
    configuradas) configuradas;;
    activar) cmd_activar "$@";;
    desactivar) cmd_desactivar;;
    estado) cmd_estado;;
    copia) cmd_copia "$@";;
    lista) cmd_lista "$@";;
    ver) cmd_ver "$@";;
    restaurar) cmd_restaurar "$@";;
    extraer) cmd_extraer "$@";;
    kit) cmd_kit "$@";;
    comprobar) cmd_comprobar "$@";;
    mantenimiento) cmd_mantenimiento;;
    datos-recuperacion) cmd_datos_recuperacion;;
    recuperar-bucket) cmd_recuperar_bucket "$@";;
    atender) cmd_atender;;
    -h|--help|help|ayuda) ayuda;;
    *) die "Orden desconocida: «$cmd» (prueba «skyway copias ayuda»).";;
  esac
}

main "$@"
