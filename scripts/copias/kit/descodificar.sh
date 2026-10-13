#!/usr/bin/env bash
#
# descodificar.sh — descodifica el kit de copia de seguridad (Linux y macOS).
#
# Restaura todas las instantáneas del repositorio cifrado («repositorio/») en
# «descodificado/», junto a este script. Los ficheros quedan sin cifrar y se
# pueden abrir con cualquier programa. Los pasos para recuperar los datos en un
# servidor nuevo están en LEEME.txt.
#
# Uso:  bash descodificar.sh [-y] [--ayuda]
#
# Portabilidad: debe funcionar con el bash 3.2 que trae macOS, así que no usa
# arrays asociativos, mapfile ni conversiones de mayúsculas con ${x,,}, y
# tampoco jq ni python: los identificadores de las instantáneas se extraen del
# JSON de restic con grep.
#
# Contraseña: se pide una sola vez, sin mostrarla, y se pasa a restic por la
# variable RESTIC_PASSWORD (nunca como argumento, porque la línea de órdenes
# es visible para el resto de procesos). Para poder probar y automatizar el
# script sin terminal, también se acepta si RESTIC_PASSWORD ya está definida
# en el entorno o, cuando la entrada no es una terminal, en la primera línea de
# la entrada estándar. Las respuestas a las preguntas siguientes se leen de las
# líneas que vengan después.
#
# Códigos de salida: 0 correcto; 1 error o instantáneas con errores; 2 opción
# no reconocida; 12 contraseña incorrecta (el mismo código que usa restic);
# 130 interrumpido.

# Con «sh descodificar.sh» (en Debian y Ubuntu sh es dash) se relanza con bash
# antes de llegar a ninguna sintaxis exclusiva de bash.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

VERSION_RESTIC="0.19.1"
URL_RESTIC="https://github.com/restic/restic/releases"
REPO="repositorio"
DESTINO="descodificado"

# ---------- mensajes ----------
# Los avisos y errores van a stderr para no mezclarse con la salida de restic.
msg()   { printf '%s\n' "$*"; }
aviso() { printf 'Aviso: %s\n' "$*" >&2; }

# fallo <código> <línea>...: muestra un error (una línea por argumento) y sale.
fallo() {
  local codigo="$1" linea primera=1
  shift
  for linea in "$@"; do
    if [ "$primera" -eq 1 ]; then
      printf 'Error: %s\n' "$linea" >&2
      primera=0
    else
      printf '       %s\n' "$linea" >&2
    fi
  done
  exit "$codigo"
}

ayuda() {
  cat <<'EOF'
Descodifica el kit de copia de seguridad.

Restaura todas las instantáneas del repositorio cifrado («repositorio») en la
carpeta «descodificado», junto a este script. Los ficheros quedan sin cifrar y
se pueden abrir con cualquier programa.

Uso:
  bash descodificar.sh [opciones]

Opciones:
  -y, --yes      Continuar sin preguntar si «descodificado» ya contiene ficheros
  -h, --ayuda    Mostrar esta ayuda

La contraseña de las copias se pide una sola vez y no se muestra al escribirla.
Si la variable de entorno RESTIC_PASSWORD ya está definida, se usa sin preguntar.
Si la entrada no es una terminal, la contraseña se lee de la primera línea de la
entrada estándar.

El programa restic se toma de la carpeta «bin» (el que corresponde a este
sistema) o, si no está, del PATH.

Códigos de salida: 0 correcto; 1 error o instantáneas restauradas con errores;
2 opción no reconocida; 12 contraseña incorrecta.
EOF
}

# confirmar <pregunta>: devuelve 0 solo si la respuesta es afirmativa. Una
# respuesta vacía, o la entrada agotada, cuenta como «no».
confirmar() {
  local resp=""
  printf '%s [s/N] ' "$1" >&2
  IFS= read -r resp || true
  # Con la entrada redirigida el salto de línea no aparece en pantalla.
  if [ ! -t 0 ]; then printf '\n' >&2; fi
  resp="${resp%$'\r'}"
  # Sin patrones con corchetes: «í» ocupa dos bytes y su comportamiento
  # depende de la configuración regional del sistema.
  case "$resp" in
    s|S|si|SI|Si|sí|Sí|y|Y|yes|YES|Yes) return 0 ;;
  esac
  return 1
}

# ---------- opciones ----------
ASUMIR_SI=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASUMIR_SI=1 ;;
    -h|--ayuda|--help) ayuda; exit 0 ;;
    *) fallo 2 "Opción no reconocida: $1." "Consulta las opciones con «bash descodificar.sh --ayuda»." ;;
  esac
  shift
done

# ---------- carpeta del kit ----------
# Todo es relativo a la carpeta del script, se ejecute desde donde se ejecute.
cd -- "$(dirname -- "$0")" || fallo 1 "No se ha podido acceder a la carpeta del script."

if [ ! -d "$REPO" ]; then
  fallo 1 "No se ha encontrado la carpeta «$REPO» junto a este script." \
    "Descomprime el ZIP completo y ejecuta el script desde la carpeta descomprimida, no desde dentro del ZIP."
fi
if [ ! -f "$REPO/config" ]; then
  fallo 1 "La carpeta «$REPO» está incompleta: falta el fichero «config»." \
    "Vuelve a descomprimir el ZIP completo."
fi

# ---------- sistema y programa restic ----------
SO_UNAME="$(uname -s 2>/dev/null || echo desconocido)"
ARQ_UNAME="$(uname -m 2>/dev/null || echo desconocida)"

# SO nombra el binario del kit; SO_GH, el fichero de la página de descargas de restic.
case "$SO_UNAME" in
  Linux)  SO="linux"; SO_GH="linux" ;;
  Darwin) SO="macos"; SO_GH="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    fallo 1 "Este script es para Linux y macOS." \
      "En Windows, haz doble clic en «descodificar.bat»."
    ;;
  *)
    SO="$(printf '%s' "$SO_UNAME" | tr '[:upper:]' '[:lower:]')"
    SO_GH="$SO"
    ;;
esac
case "$ARQ_UNAME" in
  x86_64|amd64)  ARQ="amd64" ;;
  arm64|aarch64) ARQ="arm64" ;;
  *)             ARQ="$ARQ_UNAME" ;;
esac

RESTIC=""
CANDIDATO="bin/restic-$SO-$ARQ"
if [ -f "$CANDIDATO" ]; then
  # Algunos programas de descompresión no conservan el permiso de ejecución.
  chmod +x "$CANDIDATO" 2>/dev/null || true
  if [ "$SO" = "macos" ] && command -v xattr >/dev/null 2>&1; then
    # Un ZIP descargado de Internet marca sus ficheros como «en cuarentena» y
    # macOS impide ejecutar así un programa sin firmar. Si la marca no existe,
    # xattr falla y no importa.
    xattr -d com.apple.quarantine "$CANDIDATO" 2>/dev/null || true
  fi
  # Se ejecuta para comprobar que arranca: un binario de otra arquitectura,
  # bloqueado por el sistema o en un disco montado sin permiso de ejecución no sirve.
  if "$CANDIDATO" version >/dev/null 2>&1; then
    RESTIC="$PWD/$CANDIDATO"
  else
    aviso "No se ha podido ejecutar «$CANDIDATO» en este sistema."
  fi
fi
if [ -z "$RESTIC" ] && command -v restic >/dev/null 2>&1; then
  RESTIC="$(command -v restic)"
  if ! "$RESTIC" version >/dev/null 2>&1; then
    aviso "No se ha podido ejecutar el programa restic instalado en el sistema ($RESTIC)."
    RESTIC=""
  fi
fi
if [ -z "$RESTIC" ]; then
  fallo 1 "No se ha encontrado el programa restic para este sistema ($SO, $ARQ)." \
    "Este kit necesita restic $VERSION_RESTIC. Hay dos opciones:" \
    "  1. Descarga restic $VERSION_RESTIC de $URL_RESTIC" \
    "     (fichero restic_${VERSION_RESTIC}_${SO_GH}_${ARQ}.bz2), descomprímelo con «bunzip2»" \
    "     y guárdalo como $CANDIDATO dentro de esta carpeta." \
    "  2. Instala restic con el gestor de paquetes del sistema (por ejemplo," \
    "     «brew install restic» en macOS o «sudo apt install restic» en Debian y Ubuntu)." \
    "Después, vuelve a ejecutar este script. Si la carpeta está en un disco externo," \
    "cópiala antes al disco del equipo."
fi

VERSION_USADA="$("$RESTIC" version 2>/dev/null || true)"
VERSION_USADA="${VERSION_USADA%%$'\n'*}"
VERSION_USADA="${VERSION_USADA%% compiled*}"

# La configuración de restic de quien ejecuta el script (otro repositorio u
# otro origen de la contraseña) no debe interferir con la de este kit: el
# fichero o la orden de contraseña tienen prioridad sobre RESTIC_PASSWORD, y
# un fichero de repositorio choca con -r.
unset RESTIC_REPOSITORY RESTIC_REPOSITORY_FILE RESTIC_PASSWORD_FILE \
  RESTIC_PASSWORD_COMMAND RESTIC_KEY_HINT

# Opciones comunes: --no-lock evita escribir en la carpeta del kit (puede estar
# en un medio de solo lectura) y --no-cache evita dejar una caché en la carpeta
# personal, que en un repositorio local no aporta nada. La entrada va a
# /dev/null para que restic nunca consuma las respuestas del usuario.
restic_kit() {
  "$RESTIC" -r "$REPO" --no-cache --no-lock "$@" </dev/null
}

msg "Descodificación del kit de copia de seguridad"
msg "Carpeta del kit: $PWD"
msg "Programa: ${VERSION_USADA:-restic} ($RESTIC)"
msg ""

# ---------- contraseña ----------
if [ -z "${RESTIC_PASSWORD:-}" ]; then
  if [ -t 0 ]; then
    # El bash 3.2 de macOS deja el terminal sin eco si se pulsa Ctrl+C mientras
    # se escribe la contraseña; se guarda su estado y se restaura al salir.
    ESTADO_TTY="$(stty -g 2>/dev/null || true)"
    if [ -n "$ESTADO_TTY" ]; then
      trap 'stty "$ESTADO_TTY" 2>/dev/null || true' EXIT
    fi
    printf 'Introduce la contraseña de las copias (no se mostrará al escribirla): ' >&2
    IFS= read -rs RESTIC_PASSWORD || true
    printf '\n' >&2
  else
    IFS= read -r RESTIC_PASSWORD || true
    RESTIC_PASSWORD="${RESTIC_PASSWORD%$'\r'}"
  fi
fi
if [ -z "${RESTIC_PASSWORD:-}" ]; then
  fallo 1 "No se ha introducido ninguna contraseña."
fi
export RESTIC_PASSWORD

# ---------- comprobar la contraseña y obtener las instantáneas ----------
# Un solo acceso al repositorio sirve para las dos cosas: si la contraseña es
# incorrecta, restic termina con el código 12 antes de listar nada. Con --json
# los errores de restic salen en JSON por stderr; el detalle se extrae de ahí.
msg "Comprobando la contraseña…"
COD=0
SALIDA="$(restic_kit snapshots --json 2>&1)" || COD=$?
if [ "$COD" -ne 0 ]; then
  DETALLE="$(printf '%s\n' "$SALIDA" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | sed 's/\\n/ /g')"
  if [ -z "$DETALLE" ]; then DETALLE="$SALIDA"; fi
  case "$COD" in
    12)
      fallo 12 "La contraseña no es correcta." \
        "Comprueba que es la contraseña de las copias (la misma con la que se cifró este kit)," \
        "escrita exactamente igual, y vuelve a ejecutar el script."
      ;;
    10)
      fallo 1 "La carpeta «$REPO» no contiene un repositorio de copias válido." \
        "Vuelve a descomprimir el ZIP completo."
      ;;
    130)
      fallo 130 "Descodificación interrumpida."
      ;;
    *)
      fallo 1 "No se ha podido abrir el repositorio (código $COD)." "$DETALLE"
      ;;
  esac
fi
msg "Contraseña correcta."

# Los identificadores salen de los «"id": "<64 hexadecimales>"» del JSON. El
# patrón no encaja con «short_id», que lleva un guion bajo antes de «id». restic
# las lista de la más antigua a la más reciente, y se restauran en ese orden:
# si una ruta tiene varias instantáneas, prevalece el contenido de la última.
IDS="$(printf '%s\n' "$SALIDA" | grep -Eo '"id" *: *"[0-9a-f]{64}"' | grep -Eo '[0-9a-f]{64}' || true)"
TOTAL="$(printf '%s\n' "$IDS" | grep -c . || true)"
if [ "$TOTAL" -eq 0 ]; then
  fallo 1 "El repositorio no contiene ninguna instantánea."
fi
if [ "$TOTAL" -eq 1 ]; then
  msg "Se ha encontrado 1 instantánea."
else
  msg "Se han encontrado $TOTAL instantáneas."
fi

# ---------- carpeta de destino ----------
if [ -e "$DESTINO" ] && [ ! -d "$DESTINO" ]; then
  fallo 1 "Existe un fichero llamado «$DESTINO» que no es una carpeta." \
    "Cámbiale el nombre o elimínalo y vuelve a ejecutar el script."
fi
if [ -d "$DESTINO" ] && [ -n "$(ls -A "$DESTINO" 2>/dev/null)" ]; then
  if [ "$ASUMIR_SI" -eq 1 ]; then
    msg "La carpeta «$DESTINO» ya contiene ficheros: se sobrescribirán los que tengan el mismo nombre."
  else
    msg ""
    msg "La carpeta «$DESTINO» ya contiene ficheros. Si continúas, se sobrescribirán los que tengan el mismo nombre."
    if ! confirmar "¿Continuar?"; then
      msg "Operación cancelada. No se ha modificado nada."
      msg "Para empezar de cero, cambia el nombre de la carpeta «$DESTINO» o elimínala."
      msg "Con la opción -y el script continúa sin preguntar."
      exit 1
    fi
  fi
fi
if ! mkdir -p "$DESTINO" 2>/dev/null; then
  fallo 1 "No se ha podido crear la carpeta «$DESTINO» en $PWD." \
    "Copia el kit a una carpeta con permiso de escritura y vuelve a intentarlo."
fi

# ---------- restauración ----------
msg ""
msg "La restauración puede tardar varios minutos, según el tamaño del kit."
N=0
FALLOS=0
while IFS= read -r ID; do
  if [ -z "$ID" ]; then continue; fi
  N=$((N + 1))
  msg ""
  msg "[$N/$TOTAL] Restaurando la instantánea ${ID:0:8}…"
  COD=0
  restic_kit restore "$ID" --target "$DESTINO" || COD=$?
  if [ "$COD" -eq 130 ]; then
    fallo 130 "Descodificación interrumpida."
  elif [ "$COD" -ne 0 ]; then
    FALLOS=$((FALLOS + 1))
    aviso "La instantánea ${ID:0:8} no se ha restaurado por completo (código $COD)."
  fi
done <<EOF
$IDS
EOF

# ---------- resumen ----------
msg ""
if [ "$FALLOS" -gt 0 ]; then
  aviso "$FALLOS de $TOTAL instantáneas se han restaurado con errores. Revisa los mensajes anteriores."
else
  msg "Descodificación terminada."
fi
msg ""
msg "Los ficheros están en:"
msg "  $PWD/$DESTINO"
msg ""
msg "Contenido:"
if [ -d "$DESTINO/volumenes" ]; then
  printf '  %-12s %s\n' "volumenes/" "datos de los volúmenes de cada servicio"
fi
if [ -d "$DESTINO/volcados" ]; then
  printf '  %-12s %s\n' "volcados/" "volcados de las bases de datos (SQL comprimido, volcado.sql.gz)"
fi
if [ -d "$DESTINO/elementos" ]; then
  printf '  %-12s %s\n' "elementos/" "configuración (config), código (codigo) y manifiesto de la copia"
fi
if [ -d "$DESTINO/imagenes" ]; then
  printf '  %-12s %s\n' "imagenes/" "imágenes de Docker de los servicios (imagen.tar)"
fi
msg ""
msg "Los ficheros ya no están cifrados y pueden incluir contraseñas y claves (por"
msg "ejemplo, en la configuración). Guárdalos en un sitio seguro y elimina la carpeta"
msg "«$DESTINO» cuando dejes de necesitarla."
msg "Para recuperar los datos en un servidor nuevo, consulta LEEME.txt."

unset RESTIC_PASSWORD
if [ "$FALLOS" -gt 0 ]; then exit 1; fi
exit 0
