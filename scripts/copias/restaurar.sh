#!/usr/bin/env bash
#
# restaurar.sh — vuelve a montar TODO el servidor (Skyway, sus proyectos y
# webs, y Mailway) desde las copias externas, en un servidor nuevo donde no
# hay nada instalado. Una sola orden:
#
#   sudo bash restaurar.sh                    # pide los datos de recuperación y elige la copia
#   sudo bash restaurar.sh --datos datos.txt  # los datos de «skyway copias datos-recuperacion», en un fichero
#   sudo bash restaurar.sh --kit kit-….zip    # desde un kit descargado (o su carpeta descomprimida)
#
# Opciones: --ejecucion ID | --fecha AAAA-MM-DD (por defecto, la última copia
# completa), --ip <IPv4 de este servidor>, -y (sin preguntas).
#
# Este fichero es pequeño a propósito y no cambia de una versión a otra: solo
# prepara lo mínimo (Docker, la conexión con las copias), saca de la copia
# elegida su propio código de copias y le pasa el trabajo. Así cada copia se
# restaura con las herramientas de su versión, aunque sea antigua.
set -euo pipefail

IMAGEN_RESTIC="${COPIAS_IMAGEN_RESTIC:-restic/restic:0.19.1}"
CONFIG_DIR="${COPIAS_CONFIG_DIR:-/etc/skyway-copias}"
ESTADO_DIR="${COPIAS_ESTADO_DIR:-/var/lib/skyway-copias}"

if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OK=$'\033[38;5;42m'; C_ERR=$'\033[38;5;203m'; C_ACC=$'\033[38;5;99m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_OK=''; C_ERR=''; C_ACC=''
fi
info() { printf '%s\n' "${C_DIM}$*${C_RESET}" >&2; }
ok() { printf '%s\n' "${C_OK}✓ $*${C_RESET}" >&2; }
die() { printf '%s\n' "${C_ERR}✗ $*${C_RESET}" >&2; exit 1; }

ASUMIR_SI=0
DATOS=''
KIT=''
EJECUCION=''
FECHA=''
IP=''

ayuda() {
  sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --datos) DATOS="${2:-}"; shift;;
    --kit) KIT="${2:-}"; shift;;
    --ejecucion) EJECUCION="${2:-}"; shift;;
    --fecha) FECHA="${2:-}"; shift;;
    --ip) IP="${2:-}"; shift;;
    -y|--yes) ASUMIR_SI=1;;
    -h|--help|--ayuda) ayuda; exit 0;;
    *) die "Opción desconocida: $1 (prueba --ayuda)";;
  esac
  shift
done

[[ "$(id -u)" == 0 ]] || die "Hace falta ser administrador del sistema: «sudo bash restaurar.sh»."
[[ -z "$EJECUCION" || "$EJECUCION" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die "--ejecucion tiene el formato AAAAMMDD-HHMMSS."
[[ -z "$FECHA" || "$FECHA" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--fecha tiene el formato AAAA-MM-DD."

preguntar() {
  local texto="$1" defecto="${2:-}" r
  if [[ -n "$defecto" ]]; then printf '%s %s[%s]%s: ' "$texto" "$C_DIM" "$defecto" "$C_RESET" >&2; else printf '%s: ' "$texto" >&2; fi
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
confirmar() {
  [[ "$ASUMIR_SI" == 1 ]] && return 0
  local r
  printf '%s %s[s/N]%s ' "$1" "$C_DIM" "$C_RESET" >&2
  read -r r < /dev/tty || return 1
  [[ "$r" =~ ^[sSyY]$ ]]
}

printf '%s\n' "${C_BOLD}Restaurar el servidor desde las copias externas${C_RESET}" >&2

# ---------- programas necesarios ----------
if ! command -v docker >/dev/null 2>&1; then
  confirmar "Docker no está instalado. ¿Instalarlo ahora con el instalador oficial (get.docker.com)?" || die "Instala Docker y vuelve a ejecutar este script."
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; } || die "No se ha podido instalar curl."
  curl -fsSL https://get.docker.com | sh || die "No se ha podido instalar Docker."
fi
docker info >/dev/null 2>&1 || { systemctl start docker 2>/dev/null || true; docker info >/dev/null 2>&1; } || die "Docker no responde («systemctl start docker»)."
faltan=()
for p in jq git curl; do command -v "$p" >/dev/null 2>&1 || faltan+=("$p"); done
if [[ -n "$KIT" && -f "$KIT" ]] && ! command -v unzip >/dev/null 2>&1; then faltan+=(unzip); fi
if (( ${#faltan[@]} > 0 )); then
  command -v apt-get >/dev/null 2>&1 || die "Faltan programas: ${faltan[*]}. Instálalos y vuelve a ejecutar este script."
  confirmar "Faltan ${faltan[*]}. ¿Instalarlos con apt?" || die "Instala ${faltan[*]} y vuelve a ejecutar este script."
  DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${faltan[@]}" >/dev/null || die "No se han podido instalar ${faltan[*]}."
fi

mkdir -p "$CONFIG_DIR" "$ESTADO_DIR" && chmod 700 "$CONFIG_DIR" "$ESTADO_DIR"

# ---------- de dónde salen las copias ----------
REPO_LOCAL=''
declare -A D=()
if [[ -n "$KIT" ]]; then
  if [[ -f "$KIT" ]]; then
    destino="$ESTADO_DIR/kit"
    rm -rf "$destino" && mkdir -p "$destino"
    info "Descomprimiendo el kit…"
    unzip -q "$KIT" -d "$destino" || die "No se ha podido descomprimir $KIT."
    REPO_LOCAL="$(find "$destino" -maxdepth 3 -type d -name repositorio | head -n 1)"
  elif [[ -d "$KIT" ]]; then
    REPO_LOCAL="$(cd "$KIT" && pwd)"
    [[ -d "$REPO_LOCAL/repositorio" ]] && REPO_LOCAL="$REPO_LOCAL/repositorio"
  fi
  [[ -n "$REPO_LOCAL" && -f "$REPO_LOCAL/config" ]] || die "No se encuentra el repositorio de copias dentro de $KIT."
  if [[ ! -s "$CONFIG_DIR/contrasena" ]]; then
    c="$(preguntar_secreto 'Contraseña de las copias')"
    printf '%s\n' "$c" > "$CONFIG_DIR/contrasena"; chmod 600 "$CONFIG_DIR/contrasena"
  fi
else
  if [[ -n "$DATOS" ]]; then
    [[ -f "$DATOS" ]] || die "No existe el fichero $DATOS."
    while IFS= read -r linea || [[ -n "$linea" ]]; do
      [[ "$linea" =~ ^(S3_ENDPOINT|S3_REGION|S3_BUCKET|S3_PREFIJO|S3_ACCESS_KEY|S3_SECRET_KEY|CONTRASENA)=(.*)$ ]] || continue
      D[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
    done < "$DATOS"
  fi
  info "Datos de recuperación (los que guardaste al configurar las copias):"
  [[ -n "${D[S3_ENDPOINT]:-}" ]] || D[S3_ENDPOINT]="$(preguntar 'Endpoint del S3' https://s3.eu-central-003.backblazeb2.com)"
  # En Backblaze la región es la segunda parte del endpoint.
  if [[ -z "${D[S3_REGION]:-}" && "${D[S3_ENDPOINT]}" =~ ^https://s3\.([a-z0-9-]+)\.backblazeb2\.com/?$ ]]; then
    D[S3_REGION]="${BASH_REMATCH[1]}"
  fi
  [[ -n "${D[S3_REGION]:-}" ]] || D[S3_REGION]="$(preguntar 'Región')"
  [[ -n "${D[S3_BUCKET]:-}" ]] || D[S3_BUCKET]="$(preguntar 'Bucket')"
  [[ -n "${D[S3_PREFIJO]:-}" ]] || D[S3_PREFIJO]="$(preguntar 'Carpeta dentro del bucket')"
  [[ -n "${D[S3_ACCESS_KEY]:-}" ]] || D[S3_ACCESS_KEY]="$(preguntar 'Access key')"
  [[ -n "${D[S3_SECRET_KEY]:-}" ]] || D[S3_SECRET_KEY]="$(preguntar_secreto 'Secret key')"
  [[ -n "${D[CONTRASENA]:-}" ]] || D[CONTRASENA]="$(preguntar_secreto 'Contraseña de las copias')"
  for k in S3_ENDPOINT S3_REGION S3_BUCKET S3_PREFIJO S3_ACCESS_KEY S3_SECRET_KEY CONTRASENA; do
    [[ -n "${D[$k]}" && "${D[$k]}" != *$'\n'* ]] || die "Falta $k."
  done
  [[ "${D[S3_ENDPOINT]}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "El endpoint no es válido."
  umask 077
  printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "${D[S3_ACCESS_KEY]}" "${D[S3_SECRET_KEY]}" > "$CONFIG_DIR/s3.env"
  printf '%s\n' "${D[CONTRASENA]}" > "$CONFIG_DIR/contrasena"
  if [[ ! -f "$CONFIG_DIR/config" ]]; then
    printf 'S3_ENDPOINT=%s\nS3_REGION=%s\nS3_BUCKET=%s\nS3_PREFIJO=%s\nS3_ESTILO=auto\n' \
      "${D[S3_ENDPOINT]}" "${D[S3_REGION]}" "${D[S3_BUCKET]}" "${D[S3_PREFIJO]}" > "$CONFIG_DIR/config"
  fi
  chmod 600 "$CONFIG_DIR/s3.env" "$CONFIG_DIR/contrasena" "$CONFIG_DIR/config"
  umask 022
fi

# restic en su contenedor, contra el S3 o contra la carpeta del kit.
restic_() {
  local -a dopts=() repo=() s3=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do dopts+=("$1"); shift; done
  [[ "${1:-}" == "--" ]] && shift
  if [[ -n "$REPO_LOCAL" ]]; then
    repo=(-v "$REPO_LOCAL:/repositorio" -e RESTIC_REPOSITORY=/repositorio)
  else
    repo=(--env-file "$CONFIG_DIR/s3.env" -e "RESTIC_REPOSITORY=s3:${D[S3_ENDPOINT]}/${D[S3_BUCKET]}/${D[S3_PREFIJO]}")
    s3=(-o "s3.region=${D[S3_REGION]}")
  fi
  docker run --rm --network host "${repo[@]}" \
    -e RESTIC_PASSWORD_FILE=/run/contrasena -v "$CONFIG_DIR/contrasena:/run/contrasena:ro" \
    ${dopts[@]+"${dopts[@]}"} "$IMAGEN_RESTIC" ${s3[@]+"${s3[@]}"} "$@"
}

if [[ -z "$REPO_LOCAL" ]]; then
  # restic insiste muchos minutos si no hay respuesta: antes, una consulta rápida.
  codigo_http="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' "${D[S3_ENDPOINT]}" 2>/dev/null || true)"
  [[ "$codigo_http" =~ ^[1-5][0-9][0-9]$ ]] || die "No se puede conectar con ${D[S3_ENDPOINT]}: comprueba el endpoint y la red de este servidor."
fi

# Solo si falta, y con reintentos: Docker Hub limita las descargas (responde
# 429 un rato) y eso no debe parar una restauración.
if ! docker image inspect "$IMAGEN_RESTIC" >/dev/null 2>&1; then
  info "Descargando restic ($IMAGEN_RESTIC)…"
  descargado=0
  for espera in 0 15 45 90; do
    sleep "$espera"
    if docker pull -q "$IMAGEN_RESTIC" >/dev/null 2>&1; then descargado=1; break; fi
  done
  [[ "$descargado" == 1 ]] || die "No se ha podido descargar $IMAGEN_RESTIC (¿hay red hacia Docker Hub?)."
fi

info "Leyendo las copias…"
codigo=0
manifiestos="$(restic_ -- snapshots --json --tag tipo:manifiesto 2>/tmp/restaurar-restic.err)" || codigo=$?
case "$codigo" in
  0) ;;
  10) die "No hay copias en ese destino (¿bucket o carpeta equivocados?).";;
  12) die "La contraseña no es la de estas copias.";;
  *) die "No se puede acceder a las copias: $(head -n 3 /tmp/restaurar-restic.err | tr '\n' ' ')";;
esac
rm -f /tmp/restaurar-restic.err
ejecuciones="$(jq -c '
  def tag($p): (.tags // []) | map(select(startswith($p))) | first | if . then .[($p | length):] else null end;
  [ .[] | {id: tag("ejecucion:"), fecha: .time, alcance: tag("alcance:"), motivo: tag("motivo:"), resultado: tag("resultado:")}
    | select(.alcance == "todo") ] | sort_by(.id) | reverse' <<< "$manifiestos")"
[[ "$(jq 'length' <<< "$ejecuciones")" != 0 ]] || die "No hay ninguna copia completa en ese destino."

if [[ -n "$EJECUCION" ]]; then
  jq -e --arg id "$EJECUCION" 'any(.[]; .id == $id)' >/dev/null <<< "$ejecuciones" || die "No existe la copia completa $EJECUCION."
elif [[ -n "$FECHA" ]]; then
  EJECUCION="$(jq -r --arg d "${FECHA//-/}" '[.[] | select(.resultado != "incompleta" and (.id | startswith($d)))] | first | .id // empty' <<< "$ejecuciones")"
  [[ -n "$EJECUCION" ]] || die "No hay ninguna copia completa del $FECHA (UTC)."
elif [[ "$ASUMIR_SI" == 1 || ! -t 0 ]]; then
  EJECUCION="$(jq -r '[.[] | select(.resultado != "incompleta")] | first | .id // empty' <<< "$ejecuciones")"
else
  printf '%s\n' "${C_BOLD}Copias completas disponibles (la primera es la más reciente):${C_RESET}" >&2
  i=1
  while IFS=$'\t' read -r id fecha res; do
    printf '  %s%2d%s  %s  %s UTC  %s\n' "$C_ACC" "$i" "$C_RESET" "$id" "$fecha" "$res" >&2
    i=$((i + 1))
  done < <(jq -r '.[:20][] | "\(.id)\t\(.fecha[0:16] | sub("T"; " "))\t\(.resultado)"' <<< "$ejecuciones")
  sel="$(preguntar '¿Cuál restauro?' 1)"
  [[ "$sel" =~ ^[0-9]+$ ]] || die "Selección no válida."
  EJECUCION="$(jq -r --argjson n "$sel" '.[$n - 1].id // empty' <<< "$ejecuciones")"
  [[ -n "$EJECUCION" ]] || die "Selección no válida."
fi
ok "Copia elegida: $EJECUCION"

# El código de copias de esa copia: es el que sabe restaurarla.
todas="$(restic_ -- snapshots --json --tag "ejecucion:$EJECUCION,tipo:codigo")" || die "No se ha podido leer la copia $EJECUCION."
codigo_snap="$(jq -r 'sort_by(.time) | last | .id // empty' <<< "$todas")"
[[ -n "$codigo_snap" ]] || die "La copia $EJECUCION no tiene el código de las herramientas."
arranque="$ESTADO_DIR/arranque"
rm -rf "$arranque" && mkdir -p "$arranque"
restic_ -v "$arranque:/salida" -- restore "$codigo_snap:/elementos/codigo" --target /salida >/dev/null || die "No se ha podido leer el código de la copia."
[[ -f "$arranque/copias/copias.sh" ]] || die "La copia $EJECUCION no trae copias.sh."

opciones=(restaurar todo --ejecucion "$EJECUCION")
[[ -n "$IP" ]] && opciones+=(--ip "$IP")
[[ "$ASUMIR_SI" == 1 ]] && opciones+=(-y)
[[ -n "$REPO_LOCAL" ]] && opciones+=(--repositorio-local "$REPO_LOCAL")
info "Pasando a las herramientas de copias de esa versión…"
exec bash "$arranque/copias/copias.sh" "${opciones[@]}"
