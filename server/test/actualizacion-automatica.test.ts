/**
 * `skyway update` y `skyway auto-update` (`scripts/skyway`): lo que hace que
 * la actualización automática no rompa nada. Se ejecuta el script real con
 * bash en una carpeta temporal: un repositorio «origen» donde se publican
 * versiones, y la copia del «servidor» que el script actualiza, con git de
 * verdad. docker, curl, systemctl, journalctl, id, apt-get y dpkg-query son
 * dobles al principio del PATH que anotan sus argumentos y responden lo que
 * pide cada prueba (variables FALSO_*). Sin red, sin Docker y sin tocar el
 * sistema: las rutas de systemd y apt apuntan a la carpeta temporal.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/skyway');

/**
 * Dobles de las órdenes del sistema. Son líneas en comillas simples para que
 * `${…}` y `$…` lleguen tal cual a bash.
 */
const DOBLES: Record<string, string[]> = {
  // compose up «despliega» la versión del package.json del directorio actual
  // (el repositorio), salvo el número de «up» que diga FALSO_UP_FALLA; compose
  // build falla con FALSO_BUILD_FALLA. `exec -i skyway node -` (despliegues en
  // curso) responde una línea mientras queden consultas en FALSO_DESPLIEGUES, y
  // `exec skyway nixpacks` falla con FALSO_SIN_NIXPACKS.
  docker: [
    'e="$FALSO_DIR"',
    'printf \'docker %s\\n\' "$*" >> "$e/llamadas"',
    'ups=$(cat "$e/ups" 2>/dev/null || echo 0)',
    'case "$1 ${2:-}" in',
    '  "compose version") echo "Docker Compose version v2.29.7"; exit 0;;',
    '  "compose build") if [ -n "${FALSO_BUILD_FALLA:-}" ]; then echo "fallo simulado del build" >&2; exit 1; fi; exit 0;;',
    '  "compose up")',
    '    ups=$((ups + 1)); echo "$ups" > "$e/ups"',
    '    for n in ${FALSO_UP_FALLA:-}; do',
    '      if [ "$n" = "$ups" ]; then echo "fallo simulado de la compilación" >&2; exit 1; fi',
    '    done',
    '    sed -n \'s/.*"version": *"\\([^"]*\\)".*/\\1/p\' package.json | head -n 1 > "$e/desplegada"',
    '    exit 0;;',
    'esac',
    'case "$1" in',
    '  inspect)',
    '    case "${FALSO_TRAEFIK:-en_marcha}" in',
    '      ausente) echo "Error: No such object: skyway-traefik" >&2; exit 1;;',
    '      parado) echo "false false 2026-10-09T02:00:00Z";;',
    '      inestable)',
    // Tras el primer «up», cada consulta ve otra hora de inicio: se reinicia sin parar.
    '        if [ "$ups" = 1 ]; then',
    '          c=$(( $(cat "$e/inspecciones" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$e/inspecciones"',
    '          echo "true false arranque-$ups-$c"',
    '        else echo "true false arranque-$ups"; fi;;',
    '      siempre_inestable)',
    '        c=$(( $(cat "$e/inspecciones" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$e/inspecciones"',
    '        echo "true false arranque-$ups-$c";;',
    '      *) echo "true false arranque-$ups";;',
    '    esac',
    '    exit 0;;',
    '  exec)',
    '    if [ "${2:-}" = "-i" ]; then',
    '      cat > /dev/null',
    '      n=$(cat "$e/despliegues" 2>/dev/null || echo "${FALSO_DESPLIEGUES:-0}")',
    '      if [ "$n" -gt 0 ]; then echo "web (building)"; echo $((n - 1)) > "$e/despliegues"; else echo 0 > "$e/despliegues"; fi',
    '      exit 0',
    '    fi',
    '    if [ "${3:-}" = "nixpacks" ]; then',
    '      if [ -n "${FALSO_SIN_NIXPACKS:-}" ]; then exit 127; fi',
    '      echo "nixpacks 1.39.0"; exit 0',
    '    fi',
    '    nivel=""; mensaje=""',
    '    while [ $# -gt 0 ]; do',
    '      case "$1" in --nivel) nivel="$2"; shift;; --mensaje) mensaje="$2"; shift;; esac',
    '      shift',
    '    done',
    '    printf \'%s\\t%s\\n\' "$nivel" "$mensaje" >> "$e/avisos"',
    '    echo \'{"ok":true,"channels":["discord"],"failures":[]}\'',
    '    exit 0;;',
    'esac',
    'exit 0',
  ],
  // /api/health responde con la versión desplegada, salvo si está en
  // FALSO_ROTA; por HTTPS (--resolve), además según FALSO_TLS y FALSO_TLS_ROTA.
  curl: [
    'e="$FALSO_DIR"',
    'printf \'curl %s\\n\' "$*" >> "$e/llamadas"',
    'desplegada=$(cat "$e/desplegada" 2>/dev/null)',
    'for v in ${FALSO_ROTA:-}; do',
    '  if [ "$v" = "$desplegada" ]; then exit 7; fi',
    'done',
    'case " $* " in',
    '  *" --resolve "*)',
    '    if [ "${FALSO_TLS:-ok}" = falla ]; then exit 60; fi',
    '    for v in ${FALSO_TLS_ROTA:-}; do',
    '      if [ "$v" = "$desplegada" ]; then exit 60; fi',
    '    done;;',
    'esac',
    'case "${@: -1}" in',
    '  */api/health) printf \'{"ok":true,"version":"%s"}\' "$desplegada";;',
    '  *) exit 22;;',
    'esac',
  ],
  systemctl: [
    'printf \'systemctl %s\\n\' "$*" >> "$FALSO_DIR/llamadas"',
    'case "$*" in',
    '  "is-enabled "*) echo enabled;;',
    '  *NextElapseUSecRealtime*) echo "Sat 2026-10-10 04:36:12 CEST";;',
    '  *ExecMainExitTimestamp*) echo "${FALSO_FIN-Fri 2026-10-09 04:33:40 CEST}";;',
    '  *ExecMainStatus*) echo "${FALSO_CODIGO:-0}";;',
    'esac',
    'exit 0',
  ],
  journalctl: [
    'printf \'journalctl %s\\n\' "$*" >> "$FALSO_DIR/llamadas"',
    'echo "oct 09 04:33:40 servidor bash[123]: Skyway ya está al día."',
  ],
  // Solo `id -u`: la comprobación de root del script.
  id: ['echo "${FALSO_UID:-0}"'],
  'apt-get': [
    'printf \'apt-get %s\\n\' "$*" >> "$FALSO_DIR/llamadas"',
    'if [ "$1" = install ]; then touch "$FALSO_DIR/uu-instalado"; fi',
  ],
  'dpkg-query': [
    'if [ -f "$FALSO_DIR/uu-instalado" ]; then printf "install ok installed"; exit 0; fi',
    'echo "dpkg-query: no packages found matching unattended-upgrades" >&2; exit 1',
  ],
};

let raiz: string;
let dev: string; // donde se publican las versiones nuevas
let servidor: string; // la copia que actualiza el script
let estado: string; // lo que anotan los dobles
let temporal: string; // TMPDIR: la copia del script que se re-ejecuta
let systemdDir: string;
let aptDir: string;

function entornoGit(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: raiz,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Pruebas',
    GIT_AUTHOR_EMAIL: 'pruebas@example.com',
    GIT_COMMITTER_NAME: 'Pruebas',
    GIT_COMMITTER_EMAIL: 'pruebas@example.com',
  };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: entornoGit(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const paquete = (version: string) => `{\n  "name": "skyway",\n  "version": "${version}",\n  "private": true\n}\n`;

/** Publica una versión nueva en el origen y devuelve su commit. */
function publicar(version: string): string {
  fs.writeFileSync(path.join(dev, 'package.json'), paquete(version));
  git(dev, 'commit', '-qam', `Versión ${version}`);
  git(dev, 'push', '-q', 'origin', 'main');
  return git(dev, 'rev-parse', 'HEAD');
}

/** Ejecuta el script del servidor como lo haría el operador o el temporizador. */
function skyway(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(servidor, 'scripts/skyway'), ...args], {
    env: {
      PATH: `${path.join(raiz, 'bin')}:${process.env.PATH}`,
      HOME: raiz,
      TMPDIR: temporal,
      NO_COLOR: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      FALSO_DIR: estado,
      SKYWAY_UPDATE_INTENTOS: '3',
      SKYWAY_UPDATE_PAUSA: '0',
      SKYWAY_SYSTEMD_DIR: systemdDir,
      SKYWAY_APT_CONF_DIR: aptDir,
      SKYWAY_OS_RELEASE: path.join(raiz, 'os-release'),
      ...extra,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, salida: `${r.stdout}${r.stderr}` };
}

const leer = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const llamadas = () => leer(path.join(estado, 'llamadas')).split('\n').filter(Boolean);
const ups = () => llamadas().filter((l) => l === 'docker compose up -d --build').length;
const desplegada = () => leer(path.join(estado, 'desplegada')).trim();
const cabeza = () => git(servidor, 'rev-parse', 'HEAD');
const avisos = () =>
  leer(path.join(estado, 'avisos'))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [nivel, mensaje] = l.split('\t');
      return { nivel, mensaje };
    });
const marcador = (nombre: string) => path.join(servidor, '.git', nombre);

beforeEach(() => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-actualizacion-'));
  dev = path.join(raiz, 'dev');
  servidor = path.join(raiz, 'servidor');
  estado = path.join(raiz, 'estado');
  temporal = path.join(raiz, 'tmp');
  systemdDir = path.join(raiz, 'systemd');
  aptDir = path.join(raiz, 'apt.conf.d');
  for (const d of [dev, estado, temporal, path.join(raiz, 'bin'), path.join(dev, 'scripts')]) fs.mkdirSync(d, { recursive: true });

  for (const [nombre, lineas] of Object.entries(DOBLES)) {
    fs.writeFileSync(path.join(raiz, 'bin', nombre), ['#!/usr/bin/env bash', ...lineas, ''].join('\n'), { mode: 0o755 });
  }

  // El repositorio con lo que el script necesita: package.json, docker-compose.yml y el propio script.
  fs.writeFileSync(path.join(dev, 'package.json'), paquete('0.1.0'));
  fs.writeFileSync(path.join(dev, 'docker-compose.yml'), 'services: {}\n');
  fs.copyFileSync(SCRIPT, path.join(dev, 'scripts/skyway'));
  fs.chmodSync(path.join(dev, 'scripts/skyway'), 0o755);
  git(dev, 'init', '-q', '-b', 'main');
  git(dev, 'add', '.');
  git(dev, 'commit', '-qm', 'Versión 0.1.0');
  git(raiz, 'clone', '-q', '--bare', dev, path.join(raiz, 'origen.git'));
  git(dev, 'remote', 'add', 'origin', path.join(raiz, 'origen.git'));
  git(dev, 'fetch', '-q', 'origin');
  git(dev, 'branch', '-q', '-u', 'origin/main');
  git(raiz, 'clone', '-q', path.join(raiz, 'origen.git'), servidor);

  // En marcha está la 0.1.0.
  fs.writeFileSync(path.join(estado, 'desplegada'), '0.1.0\n');
});

afterEach(() => {
  fs.rmSync(raiz, { recursive: true, force: true });
});

describe('skyway update --auto', () => {
  it('sin nada nuevo no reconstruye, no reinicia ni avisa', () => {
    const r = skyway(['update', '--auto']);
    expect(r.code, r.salida).toBe(0);
    expect(r.salida).toMatch(/ya está al día/);
    expect(ups()).toBe(0);
    // Ni siquiera comprueba nada: no hay nada que tocar.
    expect(llamadas().filter((l) => l.startsWith('docker inspect') || l.startsWith('curl'))).toEqual([]);
    expect(avisos()).toEqual([]);
  });

  it('con una versión nueva actualiza, comprueba y avisa; la noche siguiente no hace nada', () => {
    const nuevo = publicar('0.2.0');
    let r = skyway(['update', '--auto']);
    expect(r.code, r.salida).toBe(0);
    expect(cabeza()).toBe(nuevo);
    expect(ups()).toBe(1);
    expect(desplegada()).toBe('0.2.0');
    // Panel por localhost y Traefik estable (sin dominio en el .env, sin HTTPS).
    expect(llamadas()).toContain('curl -fsS --max-time 4 http://localhost:4000/api/health');
    expect(llamadas()).toContain('docker inspect -f {{.State.Running}} {{.State.Restarting}} {{.State.StartedAt}} skyway-traefik');
    expect(llamadas().some((l) => l.includes('--resolve'))).toBe(false);
    expect(avisos()).toEqual([{ nivel: 'info', mensaje: `Skyway se ha actualizado a la versión 0.2.0 (commit ${nuevo.slice(0, 7)}).` }]);
    // La copia temporal del script ya no está, ni los marcadores.
    expect(fs.readdirSync(temporal)).toEqual([]);
    expect(fs.existsSync(marcador('skyway-update-en-curso'))).toBe(false);

    r = skyway(['update', '--auto']);
    expect(r.code, r.salida).toBe(0);
    expect(ups()).toBe(1);
    expect(avisos()).toHaveLength(1);
  });

  it('si la versión nueva no responde, vuelve a la anterior (código 1) y no la reintenta cada noche', () => {
    const antes = cabeza();
    const nuevo = publicar('0.2.0');
    let r = skyway(['update', '--auto'], { FALSO_ROTA: '0.2.0' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/La actualización ha fallado: el panel no responde en http:\/\/localhost:4000\/api\/health/);
    expect(r.salida).toMatch(/migraciones de la base de datos del panel solo añaden/);
    // Código anterior y reconstruido: dos «up», el de la versión nueva y el de la vuelta atrás.
    expect(cabeza()).toBe(antes);
    expect(git(servidor, 'status', '--porcelain')).toBe('');
    expect(ups()).toBe(2);
    expect(desplegada()).toBe('0.1.0');
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0].nivel).toBe('error');
    expect(avisos()[0].mensaje).toContain(`a ${nuevo.slice(0, 7)} ha fallado`);
    expect(avisos()[0].mensaje).toContain(`se ha vuelto a la versión anterior (${antes.slice(0, 7)}), que funciona`);

    // La noche siguiente, la misma versión: ni reinicios ni otro aviso.
    r = skyway(['update', '--auto'], { FALSO_ROTA: '0.2.0' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/no se reintenta automáticamente/);
    expect(ups()).toBe(2);
    expect(avisos()).toHaveLength(1);

    // Con una corrección publicada, sí se aplica.
    const arreglo = publicar('0.2.1');
    r = skyway(['update', '--auto'], { FALSO_ROTA: '0.2.0' });
    expect(r.code, r.salida).toBe(0);
    expect(cabeza()).toBe(arreglo);
    expect(desplegada()).toBe('0.2.1');
    expect(fs.existsSync(marcador('skyway-update-fallida'))).toBe(false);
  });

  it('si la compilación falla, vuelve atrás sin esperar a las comprobaciones', () => {
    const antes = cabeza();
    publicar('0.2.0');
    const r = skyway(['update', '--auto'], { FALSO_UP_FALLA: '1' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/la reconstrucción de la imagen o el arranque de los contenedores ha fallado/);
    expect(cabeza()).toBe(antes);
    expect(ups()).toBe(2);
    expect(desplegada()).toBe('0.1.0');
    expect(avisos()[0].nivel).toBe('error');
  });

  it('construye la imagen con el panel en marcha y espera a los despliegues en curso antes de recrearlo', () => {
    const nuevo = publicar('0.2.0');
    const r = skyway(['update', '--auto'], { FALSO_DESPLIEGUES: '2', SKYWAY_UPDATE_PAUSA_DESPLIEGUES: '0' });
    expect(r.code, r.salida).toBe(0);
    expect(cabeza()).toBe(nuevo);
    expect(desplegada()).toBe('0.2.0');
    expect(r.salida).toMatch(/Hay despliegues en curso; reiniciar el panel ahora los interrumpiría/);
    expect(r.salida).toMatch(/web \(building\)/);
    expect(r.salida).toMatch(/No quedan despliegues en curso/);
    // El orden: build, consultas hasta que no queda ninguno, y después «up».
    const orden = llamadas().filter((l) => l.startsWith('docker compose build') || l.startsWith('docker exec -i') || l === 'docker compose up -d --build');
    expect(orden).toEqual([
      'docker compose build',
      'docker exec -i skyway node -',
      'docker exec -i skyway node -',
      'docker exec -i skyway node -',
      'docker compose up -d --build',
    ]);
    // El aviso de siempre, sin líneas de más por las consultas al contenedor.
    expect(avisos()).toEqual([{ nivel: 'info', mensaje: `Skyway se ha actualizado a la versión 0.2.0 (commit ${nuevo.slice(0, 7)}).` }]);
  });

  it('si el build falla, el panel no se toca y se vuelve a la versión anterior', () => {
    const antes = cabeza();
    publicar('0.2.0');
    const r = skyway(['update', '--auto'], { FALSO_BUILD_FALLA: '1' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/La actualización ha fallado: la reconstrucción de la imagen ha fallado/);
    expect(cabeza()).toBe(antes);
    // Ni consulta de despliegues ni «up» de la versión nueva: solo el de la vuelta atrás.
    expect(llamadas().filter((l) => l.startsWith('docker exec -i'))).toEqual([]);
    expect(ups()).toBe(1);
    expect(desplegada()).toBe('0.1.0');
  });

  it('sin Nixpacks en la imagen nueva lo avisa, pero la actualización es correcta', () => {
    publicar('0.2.0');
    const r = skyway(['update', '--auto'], { FALSO_SIN_NIXPACKS: '1' });
    expect(r.code, r.salida).toBe(0);
    expect(r.salida).toMatch(/Nixpacks no está instalado en la imagen/);
    expect(desplegada()).toBe('0.2.0');
    // La limpieza de imágenes sin etiqueta solo se ofrece a mano.
    expect(llamadas().some((l) => l.startsWith('docker images'))).toBe(false);
  });

  it('si la vuelta atrás también falla: código 2, aviso, y la siguiente ejecución lo retoma', () => {
    const antes = cabeza();
    const nuevo = publicar('0.2.0');
    let r = skyway(['update', '--auto'], { FALSO_ROTA: '0.2.0', FALSO_UP_FALLA: '2' });
    expect(r.code, r.salida).toBe(2);
    expect(r.salida).toMatch(/La vuelta a la versión anterior también ha fallado: la reconstrucción de la versión anterior ha fallado/);
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0].nivel).toBe('error');
    expect(avisos()[0].mensaje).toContain('Es necesario revisar el servidor');
    expect(cabeza()).toBe(antes);
    // El marcador se queda: lo que hay en marcha no se da por bueno.
    expect(leer(marcador('skyway-update-en-curso')).trim()).toBe(antes);

    // La noche siguiente lo intenta otra vez aunque esa versión ya fallara; ahora la vuelta atrás funciona.
    r = skyway(['update', '--auto'], { FALSO_ROTA: '0.2.0' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/La actualización anterior no terminó/);
    expect(ups()).toBe(4);
    expect(cabeza()).toBe(antes);
    expect(desplegada()).toBe('0.1.0');
    expect(fs.existsSync(marcador('skyway-update-en-curso'))).toBe(false);
    expect(leer(marcador('skyway-update-fallida')).trim()).toBe(nuevo);
  });

  it('una actualización cortada a medias se retoma aunque el código ya esté al día', () => {
    const antes = cabeza();
    publicar('0.2.0');
    // El código avanzó, pero la reconstrucción no llegó a terminar.
    git(servidor, 'pull', '-q', '--ff-only');
    fs.writeFileSync(marcador('skyway-update-en-curso'), `${antes}\n`);
    const r = skyway(['update', '--auto']);
    expect(r.code, r.salida).toBe(0);
    expect(ups()).toBe(1);
    expect(desplegada()).toBe('0.2.0');
    expect(fs.existsSync(marcador('skyway-update-en-curso'))).toBe(false);
  });

  it('Traefik que se reinicia sin parar tras actualizar deshace la actualización', () => {
    const antes = cabeza();
    publicar('0.2.0');
    const r = skyway(['update', '--auto'], { FALSO_TRAEFIK: 'inestable' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/Traefik \(contenedor «skyway-traefik»\) se reinicia una y otra vez/);
    expect(cabeza()).toBe(antes);
  });

  it('el panel por HTTPS se exige después si funcionaba antes', () => {
    // El dominio se lee del .env sin ejecutarlo: comillas, mayúsculas y comentario.
    fs.writeFileSync(path.join(servidor, '.env'), 'LETSENCRYPT_EMAIL=ops@example.com\nSKYWAY_DOMAIN="Panel.Example.com" # el panel\n');
    const antes = cabeza();
    publicar('0.2.0');
    const r = skyway(['update', '--auto'], { FALSO_TLS_ROTA: '0.2.0' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/el panel no responde por HTTPS en https:\/\/panel\.example\.com con un certificado válido/);
    expect(llamadas()).toContain('curl -fsS --max-time 8 --resolve panel.example.com:443:127.0.0.1 https://panel.example.com/api/health');
    expect(cabeza()).toBe(antes);
  });

  it('lo que ya fallaba antes de actualizar (certificado, Traefik retirado) no deshace la actualización', () => {
    fs.writeFileSync(path.join(servidor, '.env'), 'SKYWAY_DOMAIN=panel.example.com\n');
    const nuevo = publicar('0.2.0');
    const r = skyway(['update', '--auto'], { FALSO_TLS: 'falla', FALSO_TRAEFIK: 'ausente' });
    expect(r.code, r.salida).toBe(0);
    expect(r.salida).toMatch(/no se exigirá después de actualizar/);
    expect(cabeza()).toBe(nuevo);
    expect(ups()).toBe(1);
  });

  it('un dominio *.localhost (el del .env.example) no se comprueba por HTTPS', () => {
    fs.writeFileSync(path.join(servidor, '.env'), 'SKYWAY_DOMAIN=skyway.localhost\n');
    publicar('0.2.0');
    const r = skyway(['update', '--auto']);
    expect(r.code, r.salida).toBe(0);
    expect(llamadas().some((l) => l.includes('--resolve'))).toBe(false);
  });

  it('no actualiza ni arranca nada si el panel ya no respondía o Traefik estaba detenido', () => {
    const antes = cabeza();
    publicar('0.2.0');
    let r = skyway(['update', '--auto'], { FALSO_ROTA: '0.1.0' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/El panel no respondía antes de actualizar/);
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0].mensaje).toMatch(/^No se ha aplicado la actualización automática de Skyway\. El panel no respondía/);

    r = skyway(['update', '--auto'], { FALSO_TRAEFIK: 'parado' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/Traefik \(contenedor «skyway-traefik»\) no estaba en marcha/);

    // Un Traefik que ya se reiniciaba sin parar tampoco: no se le achaca a la actualización.
    r = skyway(['update', '--auto'], { FALSO_TRAEFIK: 'siempre_inestable' });
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/no está en marcha o se reinicia una y otra vez/);

    expect(ups()).toBe(0);
    expect(cabeza()).toBe(antes);
  });

  it('respeta los cambios locales: no avanza sobre los que chocan y conserva los demás al volver atrás', () => {
    const antes = cabeza();
    publicar('0.2.0');
    // Un cambio en un fichero que la actualización también modifica: git no avanza y no se toca nada.
    fs.writeFileSync(path.join(servidor, 'package.json'), paquete('0.1.0-local'));
    let r = skyway(['update', '--auto']);
    expect(r.code, r.salida).toBe(1);
    expect(r.salida).toMatch(/git no ha podido avanzar en limpio/);
    expect(ups()).toBe(0);
    expect(cabeza()).toBe(antes);
    expect(leer(path.join(servidor, 'package.json'))).toBe(paquete('0.1.0-local'));
    git(servidor, 'checkout', '-q', '--', 'package.json');

    // Un cambio en otro fichero sobrevive a la actualización y a la vuelta atrás.
    fs.writeFileSync(path.join(servidor, 'docker-compose.yml'), 'services: {} # retocado en el servidor\n');
    r = skyway(['update', '--auto'], { FALSO_ROTA: '0.2.0' });
    expect(r.code, r.salida).toBe(1);
    expect(cabeza()).toBe(antes);
    expect(leer(path.join(servidor, 'docker-compose.yml'))).toBe('services: {} # retocado en el servidor\n');
  });

  it('a mano: --forzar reconstruye aunque no haya nada nuevo, y sin --auto no se envían avisos', () => {
    const r = skyway(['update', '-y', '--forzar']);
    expect(r.code, r.salida).toBe(0);
    expect(ups()).toBe(1);
    expect(avisos()).toEqual([]);
  });
});

describe('skyway auto-update', () => {
  const unidad = (ext: string) => path.join(systemdDir, `skyway-auto-update.${ext}`);

  it('on instala el servicio y el temporizador; status los describe; off los retira', () => {
    let r = skyway(['auto-update', 'on', '--hora', '05:15']);
    expect(r.code, r.salida).toBe(0);
    const servicio = leer(unidad('service'));
    expect(servicio).toContain('Type=oneshot');
    expect(servicio).toContain(`ExecStart=/bin/bash "${fs.realpathSync(path.join(servidor, 'scripts/skyway'))}" update --auto`);
    const temporizador = leer(unidad('timer'));
    expect(temporizador).toContain('OnCalendar=*-*-* 05:15:00');
    expect(temporizador).toContain('RandomizedDelaySec=10min');
    expect(temporizador).toContain('Persistent=true');
    expect(temporizador).toContain('WantedBy=timers.target');
    expect(llamadas()).toEqual(['systemctl daemon-reload', 'systemctl enable --now skyway-auto-update.timer']);
    // Sin --sistema, apt no se toca.
    expect(fs.existsSync(aptDir)).toBe(false);
    expect(llamadas().some((l) => l.startsWith('apt-get'))).toBe(false);

    r = skyway(['auto-update', 'status']);
    expect(r.code, r.salida).toBe(0);
    expect(r.salida).toContain('Actualización automática: activada, cada día a las 05:15');
    expect(r.salida).toContain('Próxima ejecución: Sat 2026-10-10 04:36:12 CEST.');
    expect(r.salida).toContain('Última ejecución: Fri 2026-10-09 04:33:40 CEST · correcta');
    expect(r.salida).toContain('Parches de seguridad del sistema: no los gestiona Skyway');
    expect(llamadas()).toContain('journalctl -u skyway-auto-update -n 30 --no-pager');

    r = skyway(['auto-update', 'status'], { FALSO_CODIGO: '2' });
    expect(r.salida).toContain('ha fallado y la vuelta atrás también: es necesario revisar el servidor (código 2)');

    r = skyway(['auto-update', 'off']);
    expect(r.code, r.salida).toBe(0);
    expect(fs.existsSync(unidad('service'))).toBe(false);
    expect(fs.existsSync(unidad('timer'))).toBe(false);
    expect(llamadas()).toContain('systemctl disable --now skyway-auto-update.timer');
    expect(llamadas().filter((l) => l === 'systemctl daemon-reload')).toHaveLength(2);

    r = skyway(['auto-update', 'status']);
    expect(r.salida).toContain('Actualización automática: desactivada');
  });

  it('a las 04:30 por defecto; una hora mal escrita no instala nada', () => {
    let r = skyway(['auto-update', 'on', '--hora', '25:00']);
    expect(r.code).toBe(1);
    expect(r.salida).toMatch(/formato HH:MM/);
    expect(fs.existsSync(unidad('timer'))).toBe(false);
    expect(llamadas()).toEqual([]);

    r = skyway(['auto-update', 'on']);
    expect(r.code, r.salida).toBe(0);
    expect(leer(unidad('timer'))).toContain('OnCalendar=*-*-* 04:30:00');
  });

  it('sin root pide sudo y no toca nada', () => {
    for (const accion of ['on', 'off', 'status']) {
      const r = skyway(['auto-update', accion], { FALSO_UID: '1000' });
      expect(r.code, accion).toBe(1);
      expect(r.salida, accion).toContain(`sudo skyway auto-update ${accion}`);
    }
    expect(fs.existsSync(systemdDir)).toBe(false);
    expect(llamadas()).toEqual([]);
  });

  it('--sistema en Ubuntu: unattended-upgrades solo con parches de seguridad; off --sistema lo retira', () => {
    fs.writeFileSync(path.join(raiz, 'os-release'), 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n');
    let r = skyway(['auto-update', 'on', '--sistema']);
    expect(r.code, r.salida).toBe(0);
    expect(llamadas()).toEqual([
      'systemctl daemon-reload',
      'systemctl enable --now skyway-auto-update.timer',
      'apt-get update -qq',
      'apt-get install -y -qq unattended-upgrades',
    ]);
    const conf = leer(path.join(aptDir, '52skyway-actualizaciones'));
    expect(conf).toContain('#clear Unattended-Upgrade::Allowed-Origins;');
    expect(conf).toContain('#clear Unattended-Upgrade::Origins-Pattern;');
    expect(conf).toContain('"origin=Ubuntu,archive=${distro_codename}-security";');
    expect(conf).toContain('"origin=Debian,codename=${distro_codename}-security,label=Debian-Security";');
    expect(conf).not.toMatch(/-updates|-backports|-proposed/);
    expect(conf).toContain('Unattended-Upgrade::Automatic-Reboot "true";');
    expect(conf).toContain('Unattended-Upgrade::Automatic-Reboot-Time "05:30";');
    expect(leer(path.join(aptDir, '20auto-upgrades'))).toMatch(
      /APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";/,
    );

    // Ya instalado: no se vuelve a instalar.
    fs.writeFileSync(path.join(estado, 'llamadas'), '');
    r = skyway(['auto-update', 'on', '--sistema']);
    expect(r.code, r.salida).toBe(0);
    expect(llamadas().some((l) => l.startsWith('apt-get'))).toBe(false);

    r = skyway(['auto-update', 'status']);
    expect(r.salida).toContain('Parches de seguridad del sistema: activados (unattended-upgrades; reinicio a las 05:30');

    // El reinicio va siempre una hora después de la actualización, también al
    // cambiar la hora sin repetir --sistema: nunca puede cortarla.
    r = skyway(['auto-update', 'on', '--hora', '23:30']);
    expect(r.code, r.salida).toBe(0);
    expect(leer(path.join(aptDir, '52skyway-actualizaciones'))).toContain('Unattended-Upgrade::Automatic-Reboot-Time "00:30";');
    expect(skyway(['auto-update', 'status']).salida).toContain('reinicio a las 00:30');

    r = skyway(['auto-update', 'off', '--sistema']);
    expect(r.code, r.salida).toBe(0);
    expect(fs.existsSync(path.join(aptDir, '52skyway-actualizaciones'))).toBe(false);
    // El 20auto-upgrades lo había creado Skyway: también se retira.
    expect(fs.existsSync(path.join(aptDir, '20auto-upgrades'))).toBe(false);
  });

  it('--sistema no sobrescribe ni retira un 20auto-upgrades que ya existía', () => {
    fs.writeFileSync(path.join(raiz, 'os-release'), 'ID=debian\n');
    fs.mkdirSync(aptDir);
    const propio = 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n';
    fs.writeFileSync(path.join(aptDir, '20auto-upgrades'), propio);
    expect(skyway(['auto-update', 'on', '--sistema']).code).toBe(0);
    expect(leer(path.join(aptDir, '20auto-upgrades'))).toBe(propio);
    // El de Skyway se lee después y manda.
    expect(leer(path.join(aptDir, '52skyway-actualizaciones'))).toContain('APT::Periodic::Unattended-Upgrade "1";');
    expect(skyway(['auto-update', 'off', '--sistema']).code).toBe(0);
    expect(leer(path.join(aptDir, '20auto-upgrades'))).toBe(propio);
  });

  it('--sistema fuera de Debian y Ubuntu se rechaza antes de instalar nada', () => {
    fs.writeFileSync(path.join(raiz, 'os-release'), 'NAME="Fedora Linux"\nID=fedora\n');
    const r = skyway(['auto-update', 'on', '--sistema']);
    expect(r.code).toBe(1);
    expect(r.salida).toMatch(/solo está disponible en Debian y Ubuntu/);
    expect(fs.existsSync(unidad('timer'))).toBe(false);
    expect(llamadas()).toEqual([]);
  });
});
