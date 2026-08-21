import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { lineSplitter } from '../util';

export type LogFn = (line: string) => void;

let nixpacksCache: boolean | null = null;

export async function nixpacksAvailable(): Promise<boolean> {
  if (nixpacksCache !== null) return nixpacksCache;
  nixpacksCache = await new Promise<boolean>((resolve) => {
    const p = spawn('nixpacks', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return nixpacksCache;
}

let buildxCache: boolean | null = null;

/**
 * El CLI de Docker moderno construye con BuildKit, que exige el plugin buildx;
 * sin él, `docker build` falla en seco. Si falta (imagen de Skyway antigua),
 * se degrada al builder clásico en vez de dejar el despliegue inservible.
 */
export async function buildxAvailable(): Promise<boolean> {
  if (buildxCache !== null) return buildxCache;
  buildxCache = await new Promise<boolean>((resolve) => {
    const p = spawn('docker', ['buildx', 'version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return buildxCache;
}

export function spawnLogged(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; mask?: string[]; onSpawn?: (p: ReturnType<typeof spawn>) => void },
  log: LogFn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const masked = (line: string) => {
      let out = line;
      for (const secret of opts.mask || []) {
        if (secret) out = out.split(secret).join('*****');
      }
      log(out);
    };
    const p = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opts.onSpawn?.(p);
    const feedOut = lineSplitter(masked);
    const feedErr = lineSplitter(masked);
    p.stdout.on('data', feedOut);
    p.stderr.on('data', feedErr);
    p.on('error', (err) => reject(new Error(`No se pudo ejecutar ${cmd}: ${err.message}`)));
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} terminó con código ${code}`));
    });
  });
}

export interface CloneResult {
  commitSha: string | null;
  commitMsg: string | null;
}

/** Normaliza URLs de repo: admite "owner/repo" como atajo de GitHub. */
export function normalizeRepoUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return `https://github.com/${trimmed}`;
  return trimmed;
}

function withToken(url: string, token: string | null): { url: string; mask: string[] } {
  if (!token) return { url, mask: [] };
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && !u.username) {
      u.username = 'x-access-token';
      u.password = token;
      return { url: u.toString(), mask: [token, u.toString()] };
    }
  } catch {
    /* URL no estándar (ssh, etc.) */
  }
  return { url, mask: [token] };
}

/**
 * SHA del commit en la cabeza de una rama remota, sin clonar (`git ls-remote`).
 * Reutiliza la misma autenticación que el clon, así que sirve para repos
 * privados con el token del conector. Devuelve null si falla o no existe la rama.
 */
export async function remoteHeadSha(
  repoUrl: string,
  branch: string,
  token: string | null,
  timeoutMs = 20_000,
): Promise<string | null> {
  const { url } = withToken(normalizeRepoUrl(repoUrl), token);
  return new Promise((resolve) => {
    const p = spawn('git', ['ls-remote', '--heads', url, branch], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* ya terminó */ }
      resolve(null);
    }, timeoutMs);
    p.stdout.on('data', (d) => (buf += d.toString()));
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      // Líneas: "<sha>\trefs/heads/<branch>".
      const want = `refs/heads/${branch}`;
      const lines = buf.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const [sha, ref] = line.split(/\s+/);
        if (ref === want && sha) return resolve(sha); // coincidencia exacta
      }
      // Una sola rama devuelta: sin ambigüedad, se usa.
      if (lines.length === 1) return resolve(lines[0].split(/\s+/)[0] || null);
      resolve(null);
    });
  });
}

export async function cloneRepo(
  opts: { repoUrl: string; branch: string; token: string | null; dest: string; onSpawn?: (p: any) => void },
  log: LogFn,
): Promise<CloneResult> {
  const normalized = normalizeRepoUrl(opts.repoUrl);
  const { url, mask } = withToken(normalized, opts.token);
  fs.rmSync(opts.dest, { recursive: true, force: true });
  fs.mkdirSync(opts.dest, { recursive: true });
  log(`Clonando ${normalized} (rama ${opts.branch})...`);
  await spawnLogged(
    'git',
    [
      '-c', 'protocol.version=2',
      '-c', 'advice.detachedHead=false',
      'clone',
      '--depth', '1',
      '--branch', opts.branch,
      '--single-branch',
      // Un repo con años de tags trae miles de objetos que la compilación no
      // mira: no pedirlos recorta el clon sin cambiar el contenido construido.
      '--no-tags',
      url,
      opts.dest,
    ],
    { env: { GIT_TERMINAL_PROMPT: '0' }, mask, onSpawn: opts.onSpawn },
    log,
  );
  const info = await new Promise<CloneResult>((resolve) => {
    const p = spawn('git', ['-C', opts.dest, 'log', '-1', '--format=%H%n%s'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d.toString()));
    p.on('error', () => resolve({ commitSha: null, commitMsg: null }));
    p.on('exit', () => {
      const [sha, ...msg] = buf.trim().split('\n');
      resolve({ commitSha: sha || null, commitMsg: msg.join('\n') || null });
    });
  });
  if (info.commitSha) log(`Commit ${info.commitSha.slice(0, 7)}: ${info.commitMsg || ''}`);
  return info;
}

export interface BuildOpts {
  repoDir: string;
  rootDir?: string;
  dockerfilePath?: string;
  imageTag: string;
  buildArgs?: Record<string, string>;
  /** Imagen anterior de la que reaprovechar capas (BuildKit `--cache-from`). */
  cacheFrom?: string | null;
  /**
   * Constructor forzado por la config-as-code de Railway: NIXPACKS o RAILPACK
   * ignoran un Dockerfile presente; DOCKERFILE exige que exista. Sin valor, se
   * usa el Dockerfile si está y Nixpacks si no.
   */
  builder?: string | null;
  /** Variables para Nixpacks (NIXPACKS_BUILD_CMD y compañía). */
  nixpacksEnv?: Record<string, string>;
  onSpawn?: (p: any) => void;
}

/** ¿Existe la imagen en el daemon local? (para no pasar un --cache-from muerto). */
function localImageExists(tag: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['image', 'inspect', tag], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

/** Construye la imagen: Dockerfile si existe; si no, Nixpacks (como Railway). */
export async function buildImage(opts: BuildOpts, log: LogFn): Promise<void> {
  const context = path.resolve(opts.repoDir, opts.rootDir || '.');
  if (!context.startsWith(path.resolve(opts.repoDir))) {
    throw new Error('rootDir fuera del repositorio');
  }
  if (!fs.existsSync(context)) {
    throw new Error(`El directorio raíz "${opts.rootDir}" no existe en el repositorio`);
  }

  const dockerfile = path.join(context, opts.dockerfilePath || 'Dockerfile');
  const argFlags: string[] = [];
  for (const [k, v] of Object.entries(opts.buildArgs || {})) {
    argFlags.push('--build-arg', `${k}=${v}`);
  }

  // El constructor declarado en railway.json/toml manda, como en Railway: un
  // repo con Dockerfile pero `builder: NIXPACKS` se construye con Nixpacks.
  const forced = (opts.builder || '').toUpperCase();
  const forceNixpacks = forced === 'NIXPACKS' || forced === 'RAILPACK';
  if (forced === 'DOCKERFILE' && !fs.existsSync(dockerfile)) {
    throw new Error(
      `La configuración del repositorio pide construir con Dockerfile, pero no hay ninguno en ${path.relative(opts.repoDir, dockerfile)}.`,
    );
  }
  if (forceNixpacks && fs.existsSync(dockerfile)) {
    log(
      `⚠ El repositorio tiene Dockerfile, pero su configuración pide el constructor ${forced}: se ignora el Dockerfile ` +
        `y se construye con Nixpacks. El comando de arranque será el que infiera Nixpacks, NO el CMD del Dockerfile. ` +
        `Para usar el Dockerfile, pon "builder": "DOCKERFILE" en railway.json.`,
    );
  }

  if (fs.existsSync(dockerfile) && !forceNixpacks) {
    log(`Construyendo con Dockerfile (${path.relative(opts.repoDir, dockerfile)})...`);
    const buildkit = await buildxAvailable();
    if (!buildkit) {
      log('⚠ docker buildx no está disponible: se usa el builder clásico. Reconstruye la imagen de Skyway para builds con BuildKit.');
    }
    // La imagen anterior lleva incrustados los metadatos de caché
    // (BUILDKIT_INLINE_CACHE) y sirve de origen de capas para esta: las etapas
    // que no han cambiado —instalar dependencias, sobre todo— se saltan aunque
    // el daemon haya purgado su caché de build entre despliegues.
    const cacheFlags: string[] = [];
    if (buildkit) {
      cacheFlags.push('--build-arg', 'BUILDKIT_INLINE_CACHE=1');
      if (opts.cacheFrom && opts.cacheFrom !== opts.imageTag && (await localImageExists(opts.cacheFrom))) {
        cacheFlags.push('--cache-from', opts.cacheFrom);
      }
    }
    await spawnLogged(
      'docker',
      ['build', '-t', opts.imageTag, '-f', dockerfile, ...cacheFlags, ...argFlags, context],
      { env: { DOCKER_BUILDKIT: buildkit ? '1' : '0' }, onSpawn: opts.onSpawn },
      log,
    );
    return;
  }

  if (await nixpacksAvailable()) {
    log(forceNixpacks ? 'Construyendo con Nixpacks...' : 'No hay Dockerfile; construyendo con Nixpacks...');
    const envFlags: string[] = [];
    // Las NIXPACKS_* van después de los build-args para que ganen: son la
    // traducción del buildCommand de Railway y deben mandar sobre un homónimo
    // que el usuario tuviera puesto como argumento de compilación.
    for (const [k, v] of Object.entries({ ...opts.buildArgs, ...opts.nixpacksEnv })) {
      envFlags.push('--env', `${k}=${v}`);
    }
    await spawnLogged('nixpacks', ['build', context, '--name', opts.imageTag, ...envFlags], { onSpawn: opts.onSpawn }, log);
    return;
  }

  throw new Error(
    'No se encontró Dockerfile y Nixpacks no está instalado. Añade un Dockerfile al repositorio o instala nixpacks en el servidor (https://nixpacks.com).',
  );
}
