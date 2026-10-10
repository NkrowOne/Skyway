#!/usr/bin/env node
/**
 * Prueba real con Docker de «una sola copia», la parada limpia, la identidad
 * por copia y la limpieza de restos de intercambios.
 *
 * No la ejecuta la CI (necesita Docker y la imagen busybox:stable en local):
 * se lanza a mano en una máquina de desarrollo con Docker.
 *
 *   npm install                       # una vez, en la raíz del repositorio
 *   docker pull busybox:stable        # si no está ya (Skyway la usa para sus sondas)
 *   node scripts/prueba-real-bots.mjs
 *
 * Variables:
 *   SKYWAY_DIR    raíz del repositorio de Skyway que se prueba (por defecto, la de este script).
 *   MODO          «paquete» (por defecto) lo comprueba todo; «actual» solo mide el solape del
 *                 bot y la web sin corte, para comparar con una versión anterior al paquete.
 *   SECCIONES     lista separada por comas para ejecutar solo algunas (ver SECCIONES_TODAS).
 *   PORT_PRUEBA   puerto del Skyway de la prueba (4999).
 *
 * Arranca un Skyway propio con `npx tsx src/index.ts` (DATA_DIR temporal, solo
 * 127.0.0.1, grupo de procesos propio), crea un proyecto con un «bot»
 * (busybox:stable sin puerto ni dominio), un bot de repositorio local (para
 * volver atrás) y una web (httpd con healthcheck), y mide con `docker events`
 * cuántas copias de cada servicio hay en marcha a la vez y con qué código
 * terminan. Una sonda en la red del proyecto pide la web cada 0,1 s para ver si
 * hay corte. Al acabar (también si falla) elimina el proyecto, los contenedores,
 * imágenes y redes que haya creado y la carpeta de datos: no toca nada que no
 * lleve su etiqueta o su nombre.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKYWAY_DIR = process.env.SKYWAY_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODO = process.env.MODO === 'actual' ? 'actual' : 'paquete';
const SECCIONES_TODAS = [
  'despliegue',
  'identidad',
  'replicas',
  'parada',
  'reiniciar',
  'control',
  'restos',
  'detener',
  'reintento',
  'fallo',
  'cancelar',
  'volver',
  'sondeo',
  'web',
  'todos',
  'sinsh',
];
const SECCIONES = new Set(
  process.env.SECCIONES ? process.env.SECCIONES.split(',').map((s) => s.trim()) : MODO === 'actual' ? ['despliegue', 'web'] : SECCIONES_TODAS,
);
const PORT = Number(process.env.PORT_PRUEBA || 4999);
const BASE = `http://127.0.0.1:${PORT}`;
const IMAGEN = 'busybox:stable';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-prueba-bots-'));
const SONDA = `skyway-prueba-sonda-${process.pid}`;
/** Imagen sin `sh` (busybox sin el enlace /bin/sh): el comando al parar no puede ejecutarse. */
const IMAGEN_SIN_SH = `skyway-prueba-sinsh:${process.pid}`;

/** Un «bot de polling»: escribe su identidad al arrancar y cierra ordenadamente con SIGTERM. */
const BOT_LIMPIO =
  'echo "inicio $SKYWAY_INSTANCE_ID r=$SKYWAY_REPLICA/$SKYWAY_REPLICAS v=$SKYWAY_VALIDATION"; ' +
  'trap \'echo "parada $SKYWAY_INSTANCE_ID"; sleep 1; echo "fin $SKYWAY_INSTANCE_ID"; exit 0\' TERM; ' +
  'while :; do sleep 1; done';
/** El mismo bot, que tarda 4 s en cerrar: da tiempo a cortar Skyway durante la parada. */
const BOT_LENTO =
  'echo "inicio $SKYWAY_INSTANCE_ID"; ' +
  'trap \'echo "parada $SKYWAY_INSTANCE_ID"; sleep 4; echo "fin $SKYWAY_INSTANCE_ID"; exit 0\' TERM; ' +
  'while :; do sleep 1; done';
/** Un proceso que no atiende SIGTERM (PID 1 sin manejador): solo lo para el SIGKILL. */
const BOT_SORDO = 'while :; do sleep 1; done';
/**
 * Una web: httpd sirve el nombre del contenedor; con SIGTERM sigue sirviendo
 * 1 s (lo que haría un servidor que termina las peticiones en curso) y sale.
 */
const WEB =
  'mkdir -p /www; echo "$HOSTNAME" > /www/index.html; httpd -f -p "$PORT" -h /www & pid=$!; ' +
  'echo "inicio $HOSTNAME $SKYWAY_INSTANCE_ID"; ' +
  'trap \'echo "parada $HOSTNAME"; sleep 1; kill $pid; echo "fin $HOSTNAME"; exit 0\' TERM; ' +
  'while :; do sleep 1; done';
/** El comando al parar escribe en la salida del proceso principal: queda en `docker logs`. */
const COMANDO_AL_PARAR_LOG = 'echo "comando al parar de $SKYWAY_INSTANCE_ID" > /proc/1/fd/1';

const resultados = [];
let servidor = null;
let eventos = null;
let token = '';
let proyecto = null;
let edgeExistia = true;

function ok(nombre, cond, detalle = '') {
  resultados.push({ nombre, ok: !!cond, detalle });
  console.log(`${cond ? 'OK  ' : 'FALLO'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

function nota(texto) {
  console.log(`   ${texto}`);
}

function titulo(texto) {
  console.log(`\n== ${texto}`);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function intentar(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function puertoLibre() {
  try {
    await fetch(`${BASE}/api/health`);
    return false;
  } catch {
    return true;
  }
}

async function esperar(cond, plazoMs, paso = 500) {
  const fin = Date.now() + plazoMs;
  while (Date.now() < fin) {
    if (await cond()) return true;
    await dormir(paso);
  }
  return false;
}

async function arrancarSkyway() {
  if (!(await puertoLibre())) throw new Error(`El puerto ${PORT} ya está en uso: para el Skyway que lo ocupa (PORT_PRUEBA cambia el puerto).`);
  const log = fs.openSync(path.join(DATA_DIR, 'servidor.log'), 'a');
  servidor = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(SKYWAY_DIR, 'server'),
    env: { ...process.env, DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', log, log],
    // Grupo de procesos propio: npx y tsx lanzan hijos, y matar solo al
    // primero dejaba el servidor escuchando en el puerto.
    detached: true,
  });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* aún no escucha */
    }
    await dormir(500);
  }
  throw new Error(`Skyway no ha arrancado; mira ${DATA_DIR}/servidor.log`);
}

function matarSkyway(senal = 'SIGTERM') {
  if (!servidor) return Promise.resolve();
  const proc = servidor;
  servidor = null;
  const p = new Promise((r) => proc.once('exit', r));
  try {
    process.kill(-proc.pid, senal);
  } catch {
    proc.kill(senal);
  }
  // El grupo entero, también los nietos: se espera a que el puerto quede libre.
  return p.then(() => esperar(puertoLibre, 15_000, 200));
}

async function api(metodo, ruta, cuerpo, cabeceras = {}) {
  const r = await fetch(`${BASE}/api${ruta}`, {
    method: metodo,
    headers: {
      ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...cabeceras,
    },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    /* no es JSON */
  }
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status}: ${texto.slice(0, 300)}`);
  return { json, headers: r.headers };
}

async function sesion() {
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ email: 'prueba@bots.test', password: 'clave-de-prueba-123' }),
  });
  if (!setup.ok) throw new Error(`setup → ${setup.status}`);
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
  const t = await fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie },
    body: JSON.stringify({ name: 'prueba-bots' }),
  });
  if (!t.ok) throw new Error(`tokens → ${t.status}: ${await t.text()}`);
  token = (await t.json()).token;
}

/** `docker events` del proyecto: arranques, señales y finales por id de contenedor, con su hora y su código. */
function escucharEventos(projectId) {
  const lista = [];
  const proc = spawn('docker', ['events', '--filter', 'type=container', '--filter', `label=skyway.project=${projectId}`, '--format', '{{json .}}']);
  let resto = '';
  proc.stdout.on('data', (b) => {
    resto += b.toString();
    let i;
    while ((i = resto.indexOf('\n')) >= 0) {
      const linea = resto.slice(0, i);
      resto = resto.slice(i + 1);
      try {
        const e = JSON.parse(linea);
        const a = e.Actor?.Attributes ?? {};
        lista.push({
          t: Number(e.timeNano) / 1e6,
          accion: e.Action ?? e.status,
          id: e.Actor?.ID ?? e.id,
          nombre: a.name,
          servicio: a['skyway.service'] ?? null,
          despliegue: a['skyway.deployment'] ?? null,
          instancia: a['skyway.instance'] ?? null,
          codigo: a.exitCode !== undefined ? Number(a.exitCode) : null,
          senal: a.signal !== undefined ? Number(a.signal) : null,
        });
      } catch {
        /* línea incompleta */
      }
    }
  });
  return { lista, parar: () => proc.kill() };
}

/**
 * Copias del servicio en marcha a la vez entre `desde` y `hasta`: el máximo,
 * el mínimo (para la web: nunca cero) y los arranques y finales con su código.
 * Se recorren todos los eventos desde que se escucha, para saber qué seguía en
 * marcha al empezar la medición.
 */
function analizar(serviceId, desde, hasta = Infinity) {
  const vivos = new Set();
  let max = 0;
  let min = Infinity;
  let midiendo = false;
  const finales = [];
  const arranques = [];
  const senales = [];
  for (const e of eventos.lista.filter((x) => x.servicio === serviceId && x.t <= hasta).sort((a, b) => a.t - b.t)) {
    if (!midiendo && e.t >= desde) {
      midiendo = true;
      max = vivos.size;
      min = vivos.size;
    }
    if (e.accion === 'start') {
      vivos.add(e.id);
      if (midiendo) arranques.push(e);
    } else if (e.accion === 'die') {
      vivos.delete(e.id);
      if (midiendo) finales.push(e);
    } else if (e.accion === 'kill' && midiendo) {
      senales.push(e);
    }
    if (midiendo) {
      max = Math.max(max, vivos.size);
      min = Math.min(min, vivos.size);
    }
  }
  if (!midiendo) {
    max = vivos.size;
    min = vivos.size;
  }
  return { max, min, finales, arranques, senales, vivos: vivos.size };
}

function resumen(a) {
  return (
    `copias a la vez: máx ${a.max}, mín ${a.min}; ` +
    `arranques: ${a.arranques.map((x) => x.nombre).join(', ') || '—'}; ` +
    `finales: ${a.finales.map((f) => `${f.nombre}=${f.codigo}`).join(', ') || '—'}`
  );
}

async function esperarEvento(pred, plazoMs) {
  const fin = Date.now() + plazoMs;
  while (Date.now() < fin) {
    const e = eventos.lista.find(pred);
    if (e) return e;
    await dormir(50);
  }
  return null;
}

async function esperarDespliegue(depId, plazoMs = 240_000) {
  const fin = Date.now() + plazoMs;
  for (;;) {
    const { json } = await api('GET', `/deployments/${depId}`);
    const d = json.deployment;
    if (!['queued', 'building', 'deploying'].includes(d.status)) return d;
    if (Date.now() > fin) throw new Error(`El despliegue ${depId} no ha terminado a tiempo`);
    await dormir(500);
  }
}

async function desplegar(serviceId) {
  const { json } = await api('POST', `/services/${serviceId}/deploy`, {});
  return esperarDespliegue(json.deployment.id);
}

async function desplieguesDe(serviceId) {
  return (await api('GET', `/services/${serviceId}/deployments`)).json.deployments ?? [];
}

/** Líneas del registro de un despliegue que cuentan qué ha pasado con las copias. */
function lineasClave(logs, re = /Estrategia|Una sola copia|una sola copia|Validando|Intercambi|Recuperad|Retirad|Comando al parar|SIGKILL|restaurando|Versión nueva en marcha/) {
  return (logs ?? '')
    .split('\n')
    .filter((l) => re.test(l))
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 220));
}

function contenedoresDe(serviceId) {
  const out = docker('ps', '-a', '--filter', `label=skyway.service=${serviceId}`, '--format', '{{.Names}}|{{.State}}|{{.Label "skyway.deployment"}}');
  return out ? out.split('\n').map((l) => ({ nombre: l.split('|')[0], estado: l.split('|')[1], despliegue: l.split('|')[2] })) : [];
}

function entornoDe(nombre) {
  const env = JSON.parse(docker('inspect', '-f', '{{json .Config.Env}}', nombre));
  return Object.fromEntries(env.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
}

function registroDe(nombre) {
  return execFileSync('docker', ['logs', nombre], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------- sonda web

/** Contenedor sin etiquetas de Skyway en la red del proyecto que pide la web cada 0,1 s. */
function arrancarSonda(red, host) {
  intentar(() => docker('rm', '-f', SONDA));
  docker(
    'run', '-d', '--name', SONDA, '--network', red, IMAGEN, 'sh', '-c',
    `while :; do r=$(wget -q -T 2 -O - http://${host}/ 2>/dev/null) && echo "ok $r" || echo "FALLO"; sleep 0.1; done`,
  );
}

/** Eventos de un servicio cerca de un instante, para situar un fallo de la sonda. */
function eventosCerca(serviceId, t, margenMs = 1500) {
  return eventos.lista
    .filter((e) => e.servicio === serviceId && Math.abs(e.t - t) <= margenMs && ['start', 'kill', 'die'].includes(e.accion))
    .sort((a, b) => a.t - b.t)
    .map((e) => `${e.t - t >= 0 ? '+' : ''}${Math.round(e.t - t)} ms ${e.accion} ${e.nombre}${e.codigo !== null ? `=${e.codigo}` : ''}`)
    .join('; ');
}

/** Respuestas de la sonda entre dos instantes (ms): cuántas, cuántos fallos y qué contenedores contestaron. */
function leerSonda(desde, hasta = Date.now()) {
  const out = execFileSync('docker', ['logs', '-t', SONDA], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  let total = 0;
  let fallos = 0;
  const quien = [];
  const horasFallo = [];
  let racha = 0;
  let rachaMax = 0;
  for (const linea of out.split('\n')) {
    const m = /^(\S+)\s+(ok\s+(\S+)|FALLO)/.exec(linea);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (t < desde || t > hasta) continue;
    total += 1;
    racha = m[3] ? 0 : racha + 1;
    rachaMax = Math.max(rachaMax, racha);
    if (!m[3]) {
      fallos += 1;
      horasFallo.push(t);
    } else if (quien[quien.length - 1] !== m[3]) quien.push(m[3]);
  }
  return { total, fallos, quien, horasFallo, rachaMax };
}

// ---------------------------------------------------------------- limpieza

async function limpiar() {
  intentar(() => docker('rm', '-f', SONDA));
  try {
    if (proyecto && servidor) {
      await api('DELETE', `/projects/${proyecto.id}?confirm=${encodeURIComponent(proyecto.name)}`).catch((e) => console.log(`(limpieza) ${e.message}`));
    }
  } finally {
    eventos?.parar();
    await matarSkyway('SIGTERM');
    if (proyecto) {
      const restos = intentar(() => docker('ps', '-aq', '--filter', `label=skyway.project=${proyecto.id}`));
      if (restos) intentar(() => docker('rm', '-f', ...restos.split('\n')));
      const imagenes = intentar(() => docker('images', '-q', '--filter', `reference=skyway/${proyecto.slug}-*`));
      if (imagenes) intentar(() => docker('rmi', '-f', ...new Set(imagenes.split('\n'))));
      intentar(() => docker('network', 'rm', `skyway-${proyecto.slug}`));
    }
    intentar(() => docker('rmi', '-f', IMAGEN_SIN_SH));
    if (!edgeExistia) intentar(() => docker('network', 'rm', 'skyway-edge'));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- repositorio local (volver atrás)

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=Prueba', '-c', 'user.email=prueba@bots.test', ...args], { encoding: 'utf8' }).trim();
}

function escribirVersion(dir, version) {
  fs.writeFileSync(
    path.join(dir, 'bot.sh'),
    [
      `echo "inicio ${version} $SKYWAY_INSTANCE_ID"`,
      `trap 'echo "parada ${version}"; sleep 1; echo "fin ${version}"; exit 0' TERM`,
      'while :; do sleep 1; done',
      '',
    ].join('\n'),
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', version);
}

// ---------------------------------------------------------------- prueba

async function principal() {
  try {
    docker('image', 'inspect', IMAGEN);
  } catch {
    throw new Error(`Falta la imagen ${IMAGEN}: docker pull ${IMAGEN}`);
  }
  edgeExistia = intentar(() => docker('network', 'inspect', 'skyway-edge')) !== null;
  console.log(`Skyway: ${SKYWAY_DIR} (${intentar(() => execFileSync('git', ['-C', SKYWAY_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()) ?? '?'}), modo ${MODO}, secciones: ${[...SECCIONES].join(', ')}`);
  await arrancarSkyway();
  await sesion();
  proyecto = (await api('POST', '/projects', { name: `Bots ${Date.now() % 100000}` })).json.project;
  eventos = escucharEventos(proyecto.id);
  await dormir(500);
  const red = `skyway-${proyecto.slug}`;

  const creado = (await api('POST', `/projects/${proyecto.id}/services`, { type: 'image', name: 'bot', image: IMAGEN, startCmd: BOT_LIMPIO })).json;
  const bot = creado.service;
  const baseBot = `skyway-${proyecto.slug}-bot`;
  const inicial = await esperarDespliegue(creado.deployment.id);
  ok('primer despliegue del bot', inicial.status === 'success', inicial.error ?? '');

  let desde;
  let d;
  let a;

  // 1. Volver a desplegar: ¿cuántas copias a la vez y cómo terminan?
  if (SECCIONES.has('despliegue')) {
    titulo('1. Volver a desplegar un bot (sin puerto ni dominio)');
    desde = Date.now();
    d = await desplegar(bot.id);
    await dormir(1500);
    a = analizar(bot.id, desde);
    const next = a.finales.filter((f) => (f.nombre ?? '').endsWith('--next'));
    nota(resumen(a));
    for (const l of lineasClave(d.logs)) nota(`registro: ${l}`);
    if (MODO === 'actual') {
      ok('reproduce el solape (dos copias del bot a la vez)', a.max >= 2, `máximo ${a.max}`);
      ok('mata la copia «--next» con SIGKILL (137)', next.some((f) => f.codigo === 137), next.map((f) => f.codigo).join(','));
    } else {
      ok('redespliegue correcto', d.status === 'success', d.error ?? '');
      ok('una sola copia: nunca hay dos copias del bot a la vez', a.max === 1, `máximo ${a.max}`);
      ok('sin copia de validación «--next»', next.length === 0 && !a.arranques.some((x) => (x.nombre ?? '').endsWith('--next')));
      ok('la versión anterior termina con SIGTERM (código 0)', a.finales.length > 0 && a.finales.every((f) => f.codigo === 0), a.finales.map((f) => f.codigo).join(','));
      ok('la anterior termina antes de que arranque la nueva', a.finales.length > 0 && a.arranques.length > 0 && Math.max(...a.finales.map((f) => f.t)) <= Math.min(...a.arranques.map((x) => x.t)));
      const previo = (await desplieguesDe(bot.id)).find((x) => x.id !== d.id && x.status === 'success');
      if (previo) {
        const texto = JSON.stringify((await api('GET', `/deployments/${previo.id}/logs`)).json);
        ok('el registro archivado de la versión anterior incluye su cierre', texto.includes('parada') && texto.includes('fin '));
      }
    }
  }

  if (MODO === 'paquete' && SECCIONES.has('identidad')) {
    titulo('2. Identidad por copia');
    const env1 = entornoDe(baseBot);
    nota(`SKYWAY_INSTANCE_ID=${env1.SKYWAY_INSTANCE_ID} SKYWAY_REPLICA=${env1.SKYWAY_REPLICA} SKYWAY_REPLICAS=${env1.SKYWAY_REPLICAS} RAILWAY_REPLICA_ID=${env1.RAILWAY_REPLICA_ID}`);
    ok('SKYWAY_INSTANCE_ID presente', !!env1.SKYWAY_INSTANCE_ID);
    ok('SKYWAY_REPLICA=1 y SKYWAY_REPLICAS=1', env1.SKYWAY_REPLICA === '1' && env1.SKYWAY_REPLICAS === '1');
    ok('RAILWAY_REPLICA_ID = SKYWAY_INSTANCE_ID', env1.RAILWAY_REPLICA_ID === env1.SKYWAY_INSTANCE_ID);
    ok('sin SKYWAY_VALIDATION en la copia que sirve', env1.SKYWAY_VALIDATION === undefined);
    d = await desplegar(bot.id);
    const env2 = entornoDe(baseBot);
    nota(`tras volver a desplegar: SKYWAY_INSTANCE_ID=${env2.SKYWAY_INSTANCE_ID}`);
    ok('cada despliegue cambia SKYWAY_INSTANCE_ID', env2.SKYWAY_INSTANCE_ID && env2.SKYWAY_INSTANCE_ID !== env1.SKYWAY_INSTANCE_ID);
    ok('el registro del bot muestra su identidad', registroDe(baseBot).includes(`inicio ${env2.SKYWAY_INSTANCE_ID} r=1/1`));
    const info = (await api('GET', `/services/${bot.id}`)).json.deploy;
    nota(`GET /api/services/:id → deploy=${JSON.stringify(info)}`);
    ok('GET del servicio: estrategia «recreate» por defecto (sin tráfico)', info?.strategy === 'recreate' && info?.reason === 'sin_trafico');
    ok('GET del servicio: gracia de parada 30 s por defecto', info?.stopGraceSeconds === 30 && info?.stopGraceSource === 'defecto');
  }

  if (MODO === 'paquete' && SECCIONES.has('replicas')) {
    titulo('3. Dos réplicas');
    await api('PATCH', `/services/${bot.id}`, { config: { replicas: 2 } });
    await desplegar(bot.id);
    desde = Date.now();
    d = await desplegar(bot.id);
    await dormir(1500);
    a = analizar(bot.id, desde);
    nota(resumen(a));
    const primerArranque = Math.min(...a.arranques.map((x) => x.t));
    const ultimoFinal = Math.max(...a.finales.map((x) => x.t));
    ok('dos réplicas: máximo dos copias (las nuevas), nunca tres', a.max === 2, `máximo ${a.max}`);
    ok('dos réplicas: las anteriores terminan (código 0) antes del primer arranque', ultimoFinal <= primerArranque && a.finales.every((f) => f.codigo === 0));
    const r1 = entornoDe(baseBot);
    const r2 = entornoDe(`${baseBot}-r2`);
    nota(`r1: ${r1.SKYWAY_REPLICA}/${r1.SKYWAY_REPLICAS} ${r1.SKYWAY_INSTANCE_ID}; r2: ${r2.SKYWAY_REPLICA}/${r2.SKYWAY_REPLICAS} ${r2.SKYWAY_INSTANCE_ID}`);
    ok('réplicas con índice y SKYWAY_INSTANCE_ID distintos', r1.SKYWAY_REPLICA === '1' && r2.SKYWAY_REPLICA === '2' && r1.SKYWAY_INSTANCE_ID !== r2.SKYWAY_INSTANCE_ID && r2.SKYWAY_REPLICAS === '2');
    ok('el registro avisa de varias réplicas sin tráfico', /copias en marcha a la vez de forma permanente/.test(d.logs ?? ''));
    await api('PATCH', `/services/${bot.id}`, { config: { replicas: 1 } });
    await desplegar(bot.id);
  }

  if (MODO === 'paquete' && SECCIONES.has('parada')) {
    titulo('4. Comando al parar y parada forzada');
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: 'echo "comando al parar de $SKYWAY_INSTANCE_ID"' } });
    await desplegar(bot.id);
    d = await desplegar(bot.id);
    for (const l of lineasClave(d.logs, /comando al parar|Comando al parar|Parada:/)) nota(`registro: ${l}`);
    ok('el registro del despliegue muestra el comando al parar', (d.logs ?? '').includes('comando al parar de'));
    // Comillas, variables y un código distinto de 0: el texto llega intacto al
    // contenedor (viaja en una variable del exec) y el fallo no impide la parada.
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: `echo "comillas 'simples' y \\"dobles\\" r=$SKYWAY_REPLICA"; exit 3` } });
    await desplegar(bot.id);
    d = await desplegar(bot.id);
    for (const l of lineasClave(d.logs, /comillas|Comando al parar|comando al parar/)) nota(`registro: ${l}`);
    ok(
      'comando al parar con comillas y código 3: llega intacto y la parada sigue',
      d.status === 'success' && (d.logs ?? '').includes(`comillas 'simples' y "dobles" r=1`) && /terminó con el código 3: se continúa con SIGTERM/.test(d.logs ?? ''),
    );
    // Un comando que no termina: se corta a la gracia y la parada sigue con SIGTERM.
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: 'sleep 100', stopGraceSeconds: 2 } });
    await desplegar(bot.id);
    desde = Date.now();
    d = await desplegar(bot.id);
    a = analizar(bot.id, desde);
    const finAnterior = a.finales.find((f) => f.nombre.endsWith('--prev'));
    nota(`comando que no termina (gracia 2 s): la anterior termina a los ${finAnterior ? ((finAnterior.t - desde) / 1000).toFixed(1) : '?'} s con código ${finAnterior?.codigo}`);
    ok(
      'un comando al parar que no termina se corta a la gracia y sigue la parada con SIGTERM (código 0)',
      d.status === 'success' && /no terminó en 2 s: se continúa con SIGTERM/.test(d.logs ?? '') && finAnterior?.codigo === 0 && finAnterior.t - desde < 8000,
    );
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: null, stopGraceSeconds: null } });
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: null, stopGraceSeconds: 3, startCmd: BOT_SORDO } });
    await desplegar(bot.id);
    desde = Date.now();
    d = await desplegar(bot.id);
    a = analizar(bot.id, desde);
    const k = a.finales.find((f) => f.codigo === 137);
    const term = a.senales.find((s) => s.senal === 15);
    nota(resumen(a));
    if (k && term) nota(`SIGTERM → final 137: ${((k.t - term.t) / 1000).toFixed(1)} s`);
    ok('un proceso que no atiende SIGTERM termina con SIGKILL a los 3 s (137)', !!k && !!term && k.t - term.t >= 2800 && k.t - term.t < 6000);
    ok('el registro avisa de la parada forzada', /SIGKILL/.test(d.logs ?? ''));
    const stopTimeout = docker('inspect', '-f', '{{.Config.StopTimeout}}', baseBot);
    ok('el contenedor lleva la gracia como StopTimeout (la respeta también un docker stop ajeno)', stopTimeout === '3', `StopTimeout=${stopTimeout}`);
    await api('PATCH', `/services/${bot.id}`, { config: { stopGraceSeconds: null, startCmd: BOT_LIMPIO } });
    await api('PATCH', `/services/${bot.id}/env`, { set: { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '7' } });
    const conRailway = (await api('GET', `/services/${bot.id}`)).json.deploy;
    nota(`con RAILWAY_DEPLOYMENT_DRAINING_SECONDS=7: stopGraceSeconds=${conRailway?.stopGraceSeconds} (${conRailway?.stopGraceSource})`);
    ok('la gracia se lee de RAILWAY_DEPLOYMENT_DRAINING_SECONDS', conRailway?.stopGraceSeconds === 7 && conRailway?.stopGraceSource === 'railway');
    await api('PATCH', `/services/${bot.id}/env`, { unset: ['RAILWAY_DEPLOYMENT_DRAINING_SECONDS'] });
    await desplegar(bot.id);
  }

  if (MODO === 'paquete' && SECCIONES.has('reiniciar')) {
    titulo('5. Reiniciar');
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: COMANDO_AL_PARAR_LOG } });
    await desplegar(bot.id);
    const instancia = entornoDe(baseBot).SKYWAY_INSTANCE_ID;
    desde = Date.now();
    const r = (await api('POST', `/services/${bot.id}/restart`, {})).json;
    await dormir(1500);
    a = analizar(bot.id, desde);
    nota(resumen(a));
    const registro = registroDe(baseBot);
    const pos = (t) => registro.indexOf(t);
    nota(`registro del bot: ${registro.trim().split('\n').slice(-5).join(' | ')}`);
    ok('reiniciar: nunca dos copias a la vez', a.max === 1, `máximo ${a.max}`);
    ok('reiniciar: la copia termina con SIGTERM (código 0) y vuelve a arrancar', a.finales.length === 1 && a.finales[0].codigo === 0 && a.arranques.length === 1, `forced=${JSON.stringify(r.forced)}`);
    ok(
      'reiniciar: el comando al parar se ejecuta antes del SIGTERM',
      pos(`comando al parar de ${instancia}`) >= 0 && pos(`comando al parar de ${instancia}`) < pos(`parada ${instancia}`) && pos(`fin ${instancia}`) > pos(`parada ${instancia}`),
    );
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: null } });
    await desplegar(bot.id);
  }

  if (MODO === 'paquete' && SECCIONES.has('control')) {
    titulo('6. Control: «sin corte» elegido a mano');
    await api('PATCH', `/services/${bot.id}`, { config: { deployStrategy: 'overlap', stopCommand: 'echo "comando al parar"' } });
    await desplegar(bot.id);
    desde = Date.now();
    d = await desplegar(bot.id);
    await dormir(1500);
    a = analizar(bot.id, desde);
    nota(resumen(a));
    const n2 = a.finales.filter((f) => (f.nombre ?? '').endsWith('--next'));
    const envNext = a.arranques.find((x) => (x.nombre ?? '').endsWith('--next'));
    ok('control «sin corte»: la medición ve el solape', a.max >= 2, `máximo ${a.max}`);
    ok('control «sin corte»: nunca tres copias (la «--next» se retira antes del relevo)', a.max <= 2, `máximo ${a.max}`);
    ok('«--next» se para con SIGTERM (código 0), no con SIGKILL', n2.length > 0 && n2.every((f) => f.codigo === 0), n2.map((f) => f.codigo).join(','));
    const finNext = Math.max(...n2.map((f) => f.t));
    const arranqueNueva = a.arranques.find((x) => x.nombre === baseBot)?.t ?? 0;
    ok('«--next» termina antes de que arranque la copia nueva', n2.length > 0 && finNext <= arranqueNueva, `fin ${finNext}, arranque ${arranqueNueva}`);
    const baseNueva = a.arranques.find((x) => x.nombre === baseBot);
    nota(`instancias: «--next» ${envNext?.instancia}, nueva ${baseNueva?.instancia}`);
    ok('«--next» tiene su propia identidad, distinta de la copia que la sustituye', !!envNext?.instancia && !!baseNueva?.instancia && envNext.instancia !== baseNueva.instancia);
    ok(
      '«sin corte»: el comando al parar se ejecuta en la versión anterior y no en la «--next»',
      (d.logs ?? '').includes(`Comando al parar de ${baseBot}--prev`) && !(d.logs ?? '').includes(`Comando al parar de ${baseBot}--next`),
    );
    await api('PATCH', `/services/${bot.id}`, { config: { deployStrategy: 'auto', stopCommand: null } });
    await desplegar(bot.id);
  }

  if (MODO === 'paquete' && SECCIONES.has('restos')) {
    titulo('7. Restos de un intercambio y caída brusca de Skyway');
    const resto = () =>
      docker('run', '-d', '--name', `${baseBot}--next`, '--label', 'skyway.managed=true', '--label', `skyway.project=${proyecto.id}`, '--label', `skyway.service=${bot.id}`, IMAGEN, 'sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done');
    resto();
    desde = Date.now();
    await matarSkyway('SIGKILL');
    await arrancarSkyway();
    const limpio = await esperar(() => !contenedoresDe(bot.id).some((c) => c.nombre.endsWith('--next')), 60_000);
    a = analizar(bot.id, desde);
    nota(resumen(a));
    ok('al arrancar, Skyway retira la «--next» que dejó una caída (con SIGTERM: código 0)', limpio && a.finales.some((f) => f.nombre.endsWith('--next') && f.codigo === 0));
    docker('rename', baseBot, `${baseBot}--prev`);
    await matarSkyway('SIGKILL');
    await arrancarSkyway();
    const restaurado = await esperar(() => contenedoresDe(bot.id).some((c) => c.nombre === baseBot && c.estado === 'running'), 60_000);
    ok('al arrancar, una «--prev» sin versión nueva vuelve a su nombre y en marcha', restaurado, JSON.stringify(contenedoresDe(bot.id)));
    const log = fs.readFileSync(path.join(DATA_DIR, 'servidor.log'), 'utf8');
    for (const l of log.split('\n').filter((x) => /intercambio/i.test(x)).slice(-4)) {
      nota(`servidor: ${(intentar(() => JSON.parse(l).msg) ?? l).slice(0, 200)}`);
    }
  }

  if (MODO === 'paquete' && SECCIONES.has('detener')) {
    titulo('8. Detener, Iniciar y Reiniciar con restos de un intercambio');
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: COMANDO_AL_PARAR_LOG } });
    await desplegar(bot.id);
    const instancia = entornoDe(baseBot).SKYWAY_INSTANCE_ID;
    docker('run', '-d', '--name', `${baseBot}--next`, '--label', 'skyway.managed=true', '--label', `skyway.project=${proyecto.id}`, '--label', `skyway.service=${bot.id}`, IMAGEN, 'sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done');
    desde = Date.now();
    await api('POST', `/services/${bot.id}/stop`, {});
    const tras = contenedoresDe(bot.id);
    a = analizar(bot.id, desde);
    nota(`tras Detener: ${JSON.stringify(tras.map((c) => `${c.nombre}=${c.estado}`))}; ${resumen(a)}`);
    ok('«Detener» retira también la «--next» y para el bot', !tras.some((c) => c.nombre.endsWith('--next')) && tras.every((c) => c.estado !== 'running'));
    const reg = registroDe(baseBot);
    ok(
      '«Detener»: comando al parar, SIGTERM y cierre ordenado (código 0)',
      reg.indexOf(`comando al parar de ${instancia}`) >= 0 && reg.indexOf(`comando al parar de ${instancia}`) < reg.indexOf(`parada ${instancia}`) && a.finales.every((f) => f.codigo === 0),
      a.finales.map((f) => `${f.nombre}=${f.codigo}`).join(', '),
    );
    await api('POST', `/services/${bot.id}/start`, {});
    ok('«Iniciar» lo vuelve a arrancar', contenedoresDe(bot.id).some((c) => c.nombre === baseBot && c.estado === 'running'));
    // Una «--prev» en marcha sin su copia base (Skyway cayó justo después de apartarla).
    docker('rename', baseBot, `${baseBot}--prev`);
    desde = Date.now();
    await api('POST', `/services/${bot.id}/restart`, {});
    await dormir(1500);
    a = analizar(bot.id, desde);
    const tras2 = contenedoresDe(bot.id);
    nota(`tras Reiniciar: ${JSON.stringify(tras2.map((c) => `${c.nombre}=${c.estado}`))}; ${resumen(a)}`);
    ok('«Reiniciar» con una «--prev» suelta: vuelve a su nombre, se reinicia y nunca hay dos copias', tras2.length === 1 && tras2[0].nombre === baseBot && tras2[0].estado === 'running' && a.max <= 1);
    await api('PATCH', `/services/${bot.id}`, { config: { stopCommand: null } });
    await desplegar(bot.id);
  }

  if (MODO === 'paquete' && SECCIONES.has('reintento')) {
    titulo('9. Skyway cae a mitad de un despliegue de una sola copia y lo reintenta al arrancar');
    await api('PATCH', `/services/${bot.id}`, { config: { startCmd: BOT_LENTO } });
    await desplegar(bot.id);
    const textoMomento = {
      parada: 'caída durante la parada de la anterior',
      validacion: 'caída durante la validación de la nueva',
      apagado: 'apagado ordenado durante la parada de la anterior',
      replicas: 'dos réplicas, caída al arrancar la primera nueva',
    };
    for (const momento of ['parada', 'validacion', 'apagado', 'replicas']) {
      const copias = momento === 'replicas' ? 2 : 1;
      if (momento === 'replicas') {
        await api('PATCH', `/services/${bot.id}`, { config: { replicas: 2 } });
        await desplegar(bot.id);
      }
      const antes = new Set((await desplieguesDe(bot.id)).map((x) => x.id));
      desde = Date.now();
      const dep = (await api('POST', `/services/${bot.id}/deploy`, {})).json.deployment;
      // Durante la parada de la anterior (SIGTERM enviado, 4 s de cierre) o justo
      // al arrancar la nueva, antes de que termine su validación.
      const evento =
        momento === 'parada' || momento === 'apagado'
          ? await esperarEvento((e) => e.t >= desde && e.servicio === bot.id && e.accion === 'kill' && e.senal === 15, 60_000)
          : await esperarEvento((e) => e.t >= desde && e.servicio === bot.id && e.accion === 'start' && e.despliegue === dep.id, 60_000);
      if (!evento) throw new Error(`No se vio el momento «${momento}» del despliegue ${dep.id}`);
      if (momento === 'parada' || momento === 'apagado') await dormir(500);
      // `skyway update` y el apagado del servicio mandan SIGTERM: Skyway cancela
      // los despliegues en marcha y los reintenta al volver.
      await matarSkyway(momento === 'apagado' ? 'SIGTERM' : 'SIGKILL');
      nota(`Skyway cortado con ${momento === 'apagado' ? 'SIGTERM' : 'SIGKILL'} (${momento}); contenedores: ${JSON.stringify(contenedoresDe(bot.id).map((c) => `${c.nombre}=${c.estado}`))}`);
      await arrancarSkyway();
      let reintento = null;
      await esperar(async () => {
        reintento = (await desplieguesDe(bot.id)).find((x) => !antes.has(x.id) && x.id !== dep.id && x.trigger === 'reintento');
        return !!reintento;
      }, 60_000);
      const fin = reintento ? await esperarDespliegue(reintento.id) : null;
      await dormir(1500);
      a = analizar(bot.id, desde);
      nota(resumen(a));
      if (fin) for (const l of lineasClave(fin.logs)) nota(`registro del reintento: ${l}`);
      const finales = contenedoresDe(bot.id);
      ok(`${textoMomento[momento]}: el reintento termina bien`, fin?.status === 'success', fin?.error ?? (reintento ? '' : 'sin reintento'));
      ok(`${textoMomento[momento]}: nunca más copias a la vez que réplicas (${copias})`, a.max <= copias, `máximo ${a.max}`);
      ok(
        `${textoMomento[momento]}: quedan las copias del reintento, sin restos`,
        finales.length === copias && finales.every((c) => !/--(next|prev)$/.test(c.nombre) && c.estado === 'running' && c.despliegue === reintento?.id),
        JSON.stringify(finales),
      );
      ok(`${textoMomento[momento]}: ninguna copia termina con SIGKILL`, a.finales.every((f) => f.codigo !== 137), a.finales.map((f) => `${f.nombre}=${f.codigo}`).join(', '));
    }
    await api('PATCH', `/services/${bot.id}`, { config: { startCmd: BOT_LIMPIO, replicas: 1 } });
    await desplegar(bot.id);
  }

  if (MODO === 'paquete' && SECCIONES.has('fallo')) {
    titulo('10. La versión nueva no arranca: se restaura la anterior');
    const instancia = entornoDe(baseBot).SKYWAY_INSTANCE_ID;
    await api('PATCH', `/services/${bot.id}`, { config: { startCmd: 'echo "inicio $SKYWAY_INSTANCE_ID (rota)"; exit 1' } });
    desde = Date.now();
    d = await desplegar(bot.id);
    await dormir(1500);
    a = analizar(bot.id, desde);
    nota(resumen(a));
    for (const l of lineasClave(d.logs, /restaur|falló|Error/)) nota(`registro: ${l}`);
    const finales = contenedoresDe(bot.id);
    ok('versión rota: el despliegue falla', d.status === 'failed', d.error ?? '');
    ok('versión rota: nunca dos copias a la vez', a.max <= 1, `máximo ${a.max}`);
    ok(
      'versión rota: vuelve a estar en marcha la anterior (misma instancia) y sin restos',
      finales.length === 1 && finales[0].nombre === baseBot && finales[0].estado === 'running' && entornoDe(baseBot).SKYWAY_INSTANCE_ID === instancia,
      JSON.stringify(finales),
    );
    await api('PATCH', `/services/${bot.id}`, { config: { startCmd: BOT_LIMPIO } });
  }

  if (MODO === 'paquete' && SECCIONES.has('cancelar')) {
    titulo('11. Cancelar durante la parada de la versión anterior');
    await api('PATCH', `/services/${bot.id}`, { config: { startCmd: BOT_LENTO } });
    await desplegar(bot.id);
    const instancia = entornoDe(baseBot).SKYWAY_INSTANCE_ID;
    desde = Date.now();
    const dep = (await api('POST', `/services/${bot.id}/deploy`, {})).json.deployment;
    const ev = await esperarEvento((e) => e.t >= desde && e.servicio === bot.id && e.accion === 'kill' && e.senal === 15, 60_000);
    if (!ev) throw new Error('No se vio la parada de la versión anterior');
    await api('POST', `/deployments/${dep.id}/cancel`, {});
    d = await esperarDespliegue(dep.id);
    await dormir(1500);
    a = analizar(bot.id, desde);
    nota(resumen(a));
    for (const l of lineasClave(d.logs, /restaur|Cancel|cancel/)) nota(`registro: ${l}`);
    const finales = contenedoresDe(bot.id);
    ok('cancelar: el despliegue queda cancelado', d.status === 'canceled', d.status);
    ok('cancelar: nunca dos copias a la vez y la anterior termina con SIGTERM', a.max <= 1 && a.finales.every((f) => f.codigo === 0), `máximo ${a.max}`);
    ok(
      'cancelar: la versión anterior vuelve a estar en marcha y sin restos',
      finales.length === 1 && finales[0].nombre === baseBot && finales[0].estado === 'running' && entornoDe(baseBot).SKYWAY_INSTANCE_ID === instancia,
      JSON.stringify(finales),
    );
    await api('PATCH', `/services/${bot.id}`, { config: { startCmd: BOT_LIMPIO } });
    await desplegar(bot.id);
  }

  let botgit = null;
  if (MODO === 'paquete' && SECCIONES.has('volver')) {
    titulo('12. Volver atrás (bot de repositorio)');
    const repo = path.join(DATA_DIR, 'repo-bot');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM busybox:stable\nCOPY bot.sh /bot.sh\nCMD ["sh", "/bot.sh"]\n');
    escribirVersion(repo, 'v1');
    const c = (await api('POST', `/projects/${proyecto.id}/services`, { type: 'git', name: 'botgit', repoUrl: repo, branch: 'main', autoDeploy: false })).json;
    botgit = c.service;
    const v1 = await esperarDespliegue(c.deployment.id);
    ok('bot de repositorio: v1 construida y desplegada', v1.status === 'success', v1.error ?? '');
    escribirVersion(repo, 'v2');
    const v2 = await desplegar(botgit.id);
    const baseGit = `skyway-${proyecto.slug}-botgit`;
    ok('bot de repositorio: v2 construida y desplegada', v2.status === 'success' && registroDe(baseGit).includes('inicio v2'), v2.error ?? '');
    desde = Date.now();
    const vuelta = (await api('POST', `/deployments/${v1.id}/rollback`, {})).json.deployment;
    d = await esperarDespliegue(vuelta.id);
    await dormir(1500);
    a = analizar(botgit.id, desde);
    nota(resumen(a));
    for (const l of lineasClave(d.logs)) nota(`registro: ${l}`);
    ok('volver atrás: correcto y en marcha la v1', d.status === 'success' && registroDe(baseGit).includes('inicio v1'), d.error ?? '');
    ok('volver atrás: nunca dos copias a la vez', a.max === 1, `máximo ${a.max}`);
    ok('volver atrás: la v2 termina con SIGTERM (código 0) antes de arrancar la v1', a.finales.length === 1 && a.finales[0].codigo === 0 && a.finales[0].t <= Math.min(...a.arranques.map((x) => x.t)));
  }

  if (MODO === 'paquete' && SECCIONES.has('sondeo') && botgit) {
    titulo('12b. Despliegue automático por sondeo de la rama');
    const repo = path.join(DATA_DIR, 'repo-bot');
    const baseGit = `skyway-${proyecto.slug}-botgit`;
    await api('PATCH', `/services/${botgit.id}`, { config: { autoDeploy: true } });
    // El primer sondeo tras arrancar (a los 10 s) fija la línea base sin
    // desplegar; el siguiente, tras otro arranque, ve el commit nuevo.
    await matarSkyway('SIGTERM');
    await arrancarSkyway();
    await dormir(13_000);
    escribirVersion(repo, 'v3');
    const antes = new Set((await desplieguesDe(botgit.id)).map((x) => x.id));
    desde = Date.now();
    await matarSkyway('SIGTERM');
    await arrancarSkyway();
    let auto = null;
    await esperar(async () => {
      auto = (await desplieguesDe(botgit.id)).find((x) => !antes.has(x.id) && x.trigger === 'autodeploy');
      return !!auto;
    }, 60_000);
    const fin = auto ? await esperarDespliegue(auto.id) : null;
    await dormir(1500);
    a = analizar(botgit.id, desde);
    nota(resumen(a));
    ok('sondeo: el commit nuevo se despliega solo', fin?.status === 'success' && registroDe(baseGit).includes('inicio v3'), fin?.error ?? (auto ? '' : 'sin despliegue automático'));
    ok('sondeo: nunca dos copias a la vez y la anterior termina con SIGTERM', a.max === 1 && a.finales.every((f) => f.codigo === 0), `máximo ${a.max}`);
    await api('PATCH', `/services/${botgit.id}`, { config: { autoDeploy: false } });
  }

  let web = null;
  if (SECCIONES.has('web')) {
    titulo('13. Web con healthcheck: intercambio sin corte');
    const cw = (await api('POST', `/projects/${proyecto.id}/services`, { type: 'image', name: 'web', image: IMAGEN, port: 8080, startCmd: WEB })).json;
    web = cw.service;
    await esperarDespliegue(cw.deployment.id);
    await api('PATCH', `/services/${web.id}`, { config: { healthcheckPath: '/' } });
    if (MODO === 'paquete') {
      const info = (await api('GET', `/services/${web.id}`)).json.deploy;
      nota(`GET /api/services/:id → deploy=${JSON.stringify(info)}`);
      ok('web: estrategia «sin corte» automática (con tráfico)', info?.strategy === 'overlap' && info?.reason === 'con_trafico');
    }
    await desplegar(web.id);
    arrancarSonda(red, `${web.slug}:8080`);
    await dormir(2000);
    desde = Date.now();
    const vecesWeb = Number(process.env.DESPLIEGUES_WEB || 2);
    for (let i = 0; i < vecesWeb; i++) {
      d = await desplegar(web.id);
      ok(`web: despliegue ${i + 1} correcto`, d.status === 'success', d.error ?? '');
    }
    await dormir(2500);
    a = analizar(web.id, desde);
    const s = leerSonda(desde);
    nota(resumen(a));
    nota(`sonda: ${s.total} peticiones, ${s.fallos} fallos; contestaron, por orden: ${s.quien.join(' → ')}`);
    for (const t of s.horasFallo) nota(`fallo de la sonda a las ${new Date(t).toISOString()}: ${eventosCerca(web.id, t)}`);
    for (const l of lineasClave(d.logs)) nota(`registro: ${l}`);
    ok('web: hay solape (la nueva arranca antes de parar la anterior)', a.max >= 2, `máximo ${a.max}`);
    ok('web: nunca tres copias a la vez (la «--next» se retira antes del relevo)', a.max <= 2, `máximo ${a.max}`);
    ok('web: nunca se queda sin copias en marcha', a.min >= 1, `mínimo ${a.min}`);
    // Sin Traefik, la sonda entra por el alias de la red del proyecto, y el DNS
    // de Docker reparte entre las copias: la que acaba de arrancar figura un
    // instante antes de escuchar, y la que sale, hasta que su contenedor
    // termina (una petición a su IP en ese instante falla o agota los 2 s de
    // espera). Alguna petición suelta puede fallar justo ahí, también antes de
    // este paquete; un corte (la web sin ninguna copia) serían decenas seguidas.
    ok(
      'web: sin corte (como mucho dos peticiones fallidas por despliegue, justo al entrar o salir una copia)',
      s.total > 20 && s.fallos <= 2 * vecesWeb && s.rachaMax <= 2,
      `${s.fallos}/${s.total}, racha máxima ${s.rachaMax}`,
    );
    ok('web: contesta la versión nueva al terminar', s.quien.length >= 3);
    ok('web: las copias retiradas terminan con SIGTERM (código 0)', a.finales.length > 0 && a.finales.every((f) => f.codigo === 0), a.finales.map((f) => `${f.nombre}=${f.codigo}`).join(', '));

    const baseWeb = `skyway-${proyecto.slug}-web`;
    for (const momento of MODO === 'paquete' ? ['next', 'relevo'] : []) {
      titulo(
        momento === 'next'
          ? '14. Web: Skyway cae mientras valida la copia «--next»'
          : '14b. Web: Skyway cae con la copia nueva arrancada y la anterior aún en servicio',
      );
      const antes = new Set((await desplieguesDe(web.id)).map((x) => x.id));
      desde = Date.now();
      const dep = (await api('POST', `/services/${web.id}/deploy`, {})).json.deployment;
      const ev = await esperarEvento(
        (e) =>
          e.t >= desde &&
          e.servicio === web.id &&
          e.accion === 'start' &&
          (momento === 'next' ? (e.nombre ?? '').endsWith('--next') : e.nombre === baseWeb && e.despliegue === dep.id),
        60_000,
      );
      if (!ev) throw new Error(`No se vio el momento «${momento}» del despliegue de la web`);
      await matarSkyway('SIGKILL');
      nota(`Skyway cortado con SIGKILL; contenedores: ${JSON.stringify(contenedoresDe(web.id).map((c) => `${c.nombre}=${c.estado}`))}`);
      await arrancarSkyway();
      let reintento = null;
      await esperar(async () => {
        reintento = (await desplieguesDe(web.id)).find((x) => !antes.has(x.id) && x.id !== dep.id && x.trigger === 'reintento');
        return !!reintento;
      }, 60_000);
      const fin = reintento ? await esperarDespliegue(reintento.id) : null;
      await dormir(2500);
      a = analizar(web.id, desde);
      const s2 = leerSonda(desde);
      nota(resumen(a));
      nota(`sonda: ${s2.total} peticiones, ${s2.fallos} fallos`);
      for (const t of s2.horasFallo) nota(`fallo de la sonda a las ${new Date(t).toISOString()}: ${eventosCerca(web.id, t)}`);
      const finales = contenedoresDe(web.id);
      ok(
        momento === 'next'
          ? 'web tras la caída: la «--next» huérfana se retira con SIGTERM (código 0)'
          : 'web tras la caída: la copia nueva sin validar se retira con SIGTERM (código 0)',
        a.finales.some((f) => f.id === ev.id && f.codigo === 0),
        a.finales.map((f) => `${f.nombre}=${f.codigo}`).join(', '),
      );
      ok('web tras la caída: el reintento termina bien y no quedan restos', fin?.status === 'success' && finales.length === 1 && finales[0].estado === 'running', JSON.stringify(finales));
      ok('web tras la caída: nunca sin copias ni corte', a.min >= 1 && s2.rachaMax <= 2 && s2.fallos <= 4, `mínimo ${a.min}, fallos ${s2.fallos}/${s2.total}, racha máxima ${s2.rachaMax}`);
    }

    if (MODO === 'paquete') {
      // Antes de la parada limpia, Reiniciar iba réplica a réplica; parar todas
      // a la vez dejaba la web sin servicio durante la gracia y el arranque.
      titulo('14c. Web con dos réplicas: Reiniciar va réplica a réplica');
      await api('PATCH', `/services/${web.id}`, { config: { replicas: 2 } });
      d = await desplegar(web.id);
      ok('web: despliegue con dos réplicas correcto', d.status === 'success', d.error ?? '');
      await dormir(2000);
      desde = Date.now();
      const rr = await api('POST', `/services/${web.id}/restart`, {});
      await dormir(2500);
      a = analizar(web.id, desde);
      const s3 = leerSonda(desde);
      nota(resumen(a));
      nota(`sonda: ${s3.total} peticiones, ${s3.fallos} fallos, racha máxima ${s3.rachaMax}`);
      ok('reiniciar la web: respuesta correcta', rr.json?.ok === true, JSON.stringify(rr.json));
      ok('reiniciar la web: las dos réplicas se reinician', a.arranques.length === 2 && a.finales.length === 2, resumen(a));
      ok('reiniciar la web: nunca sin copias en marcha', a.min >= 1, `mínimo ${a.min}`);
      ok('reiniciar la web: sin corte', s3.total > 10 && s3.rachaMax <= 2, `${s3.fallos}/${s3.total}, racha máxima ${s3.rachaMax}`);
      await api('PATCH', `/services/${web.id}`, { config: { replicas: 1 } });
      await desplegar(web.id);
    }
  }

  if (MODO === 'paquete' && SECCIONES.has('todos')) {
    titulo('15. «Desplegar todos»');
    const servicios = [bot, botgit, web].filter(Boolean);
    const antes = new Map();
    for (const s of servicios) antes.set(s.id, new Set((await desplieguesDe(s.id)).map((x) => x.id)));
    desde = Date.now();
    const r = (await api('POST', `/projects/${proyecto.id}/deploy-all`, {})).json;
    nota(`deploy-all → ${JSON.stringify(r)}`);
    for (const s of servicios) {
      let nuevo = null;
      await esperar(async () => {
        nuevo = (await desplieguesDe(s.id)).find((x) => !antes.get(s.id).has(x.id));
        return !!nuevo;
      }, 30_000);
      const fin = nuevo ? await esperarDespliegue(nuevo.id) : null;
      ok(`desplegar todos: «${s.name}» correcto`, fin?.status === 'success', fin?.error ?? '');
    }
    await dormir(2500);
    for (const s of [bot, botgit].filter(Boolean)) {
      a = analizar(s.id, desde);
      nota(`${s.name}: ${resumen(a)}`);
      ok(`desplegar todos: «${s.name}» nunca tiene dos copias a la vez`, a.max === 1 && a.finales.every((f) => f.codigo === 0), `máximo ${a.max}`);
    }
    if (web) {
      a = analizar(web.id, desde);
      const s3 = leerSonda(desde);
      nota(`web: ${resumen(a)}; sonda ${s3.fallos}/${s3.total} fallos`);
      ok('desplegar todos: la web sigue sin corte', a.min >= 1 && a.max >= 2 && s3.rachaMax <= 2 && s3.fallos <= 2, `${s3.fallos}/${s3.total}`);
    }
  }
}

async function seccionSinShell() {
  titulo('16. Comando al parar en una imagen sin shell');
  execFileSync('docker', ['build', '-q', '-t', IMAGEN_SIN_SH, '-'], {
    input: 'FROM busybox:stable\nRUN rm /bin/sh\nENTRYPOINT ["/bin/sleep", "100000"]\n',
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const c = (await api('POST', `/projects/${proyecto.id}/services`, { type: 'image', name: 'sinsh', image: IMAGEN_SIN_SH })).json;
  const svc = c.service;
  await esperarDespliegue(c.deployment.id);
  await api('PATCH', `/services/${svc.id}`, { config: { stopCommand: 'echo hola', stopGraceSeconds: 2 } });
  await desplegar(svc.id);
  const desde = Date.now();
  const d = await desplegar(svc.id);
  const a = analizar(svc.id, desde);
  for (const l of lineasClave(d.logs, /comando al parar|Comando al parar|SIGKILL/)) nota(`registro: ${l}`);
  const fin = a.finales[0];
  nota(`${resumen(a)}; la anterior termina a los ${fin ? ((fin.t - desde) / 1000).toFixed(1) : '?'} s`);
  ok(
    'sin shell: el comando al parar falla sin bloquear y la parada sigue (SIGTERM y SIGKILL a la gracia)',
    d.status === 'success' && /no incluye «sh»: el comando al parar no se puede ejecutar/.test(d.logs ?? '') && fin?.codigo === 137 && fin.t - desde < 10_000,
    d.error ?? '',
  );
  ok('sin shell: nunca dos copias a la vez', a.max === 1, `máximo ${a.max}`);
}

principal()
  .then(async () => {
    if (MODO === 'paquete' && SECCIONES.has('sinsh')) await seccionSinShell();
  })
  .catch((err) => ok('la prueba ha terminado sin errores', false, err.message))
  .finally(async () => {
    await limpiar();
    const fallos = resultados.filter((r) => !r.ok);
    console.log(`\n${resultados.length - fallos.length}/${resultados.length} comprobaciones correctas (modo ${MODO}).`);
    process.exit(fallos.length ? 1 : 0);
  });
