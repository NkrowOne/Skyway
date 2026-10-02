/**
 * Conecta Skyway con el panel de Mailway desde el propio servidor: lo que
 * hace un administrador en Ajustes → Correo (Mailway) con «Probar conexión» y
 * «Guardar», sin navegador. Lo usa el instalador de Mailway para emparejar los
 * dos paneles al terminar; quien puede ejecutarlo ya administra la máquina.
 *
 *   printf '%s' "$TOKEN_MWT" | docker exec -i skyway node server/dist/tools/mailway.js \
 *     conectar --servicio <id|slug> [--proyecto <id|slug>] [--url <URL pública del panel>]
 *     → stdout: {"ok":true,"version":"…","brandName":"…"}
 *
 * El token de gestión (`mwt_…`) se lee SOLO de la entrada estándar: como
 * argumento quedaría en el historial del shell y en `ps` de cualquier usuario
 * de la máquina mientras corre. La prueba y el guardado son las funciones de
 * Ajustes (`mailwayconfig.ts`): misma validación (incluido que la URL pública
 * no la sirva otro servicio de Skyway, el token viajaría hasta él) y misma
 * auditoría, con el actor «sistema» y sin valores. Si la prueba falla no se
 * guarda nada. Los avisos de la prueba (token que no es de administrador…)
 * van a stderr; código 1 y el motivo en stderr si algo falla.
 */
import { z } from 'zod';
import { auditSystem } from '../audit';
import { getProject, getService, initDb, listProjects, listServices } from '../db';
import { MailwayError } from '../mailway';
import { MAILWAY_TOKEN_RE, checkService, guardarConfigMailway, parsePanelUrl, probarConexionMailway } from '../mailwayconfig';
import { ProjectRow, ServiceRow } from '../types';
import {
  ENTRADA_SALIDA_PROCESO,
  EntradaSalida,
  ErrorHerramienta,
  leerOpciones,
  mensajeDeError,
  mensajeMailway,
} from './argumentos';

const USO =
  'Uso: printf \'%s\' "$TOKEN_MWT" | mailway conectar --servicio <id|slug> [--proyecto <id|slug>] [--url <URL pública del panel>]';

const SOLO_ENTRADA =
  'El token de gestión se lee solo de la entrada estándar, nunca de los argumentos (quedaría en el historial y en «ps»). ' +
  'Ejemplo: printf \'%s\' "$TOKEN_MWT" | docker exec -i skyway node server/dist/tools/mailway.js conectar --servicio panel';

/** Tamaño máximo de la entrada: un token ocupa ~60 caracteres. */
const MAX_ENTRADA = 4096;

const referencia = (que: string, opcion: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,100}$/, `${que} (--${opcion}) debe ser un id o un slug.`);

const conectarSchema = z.object({
  servicio: z.string({ required_error: 'Indica el servicio del panel de Mailway con --servicio (id o slug).' }).pipe(referencia('El servicio', 'servicio')),
  proyecto: referencia('El proyecto', 'proyecto').optional(),
  url: z.string().trim().min(1, 'La URL del panel (--url) no puede estar vacía.').max(500).optional(),
});

export interface EntradaSalidaMailway extends EntradaSalida {
  /** Todo lo recibido por la entrada estándar. */
  leerEntrada: () => Promise<string>;
}

function resolverProyecto(ref: string): ProjectRow {
  const project = getProject(ref) ?? listProjects().find((p) => p.slug === ref);
  if (!project) throw new ErrorHerramienta(`No existe ningún proyecto con el id o el slug «${ref}».`);
  return project;
}

/** Servicio por id o slug; sin --proyecto, el slug tiene que ser único en todo Skyway. */
export function resolverServicio(ref: string, proyectoRef?: string): ServiceRow {
  if (proyectoRef) {
    const project = resolverProyecto(proyectoRef);
    const service = listServices(project.id).find((s) => s.id === ref || s.slug === ref);
    if (!service) throw new ErrorHerramienta(`El proyecto «${project.name}» no tiene ningún servicio con el id o el slug «${ref}».`);
    return service;
  }
  const byId = getService(ref);
  if (byId) return byId;
  const candidatos = listProjects().flatMap((p) => listServices(p.id).filter((s) => s.slug === ref).map((s) => ({ s, p })));
  if (candidatos.length === 0) throw new ErrorHerramienta(`No existe ningún servicio con el id o el slug «${ref}».`);
  if (candidatos.length > 1) {
    const proyectos = candidatos.map((c) => c.p.slug).sort().join(', ');
    throw new ErrorHerramienta(`Hay ${candidatos.length} servicios con el slug «${ref}» (proyectos: ${proyectos}): indica cuál con --proyecto.`);
  }
  return candidatos[0].s;
}

/** El token de la entrada estándar, sin el salto de línea final. Nunca se repite en un mensaje. */
export function tokenDeEntrada(texto: string): string {
  const token = texto.trim();
  if (!token) throw new ErrorHerramienta(`No ha llegado ningún token por la entrada estándar. ${SOLO_ENTRADA}`);
  if (!MAILWAY_TOKEN_RE.test(token)) {
    throw new ErrorHerramienta(
      'La entrada estándar no contiene un token de gestión válido: debe empezar por «mwt_» (Mailway → Conexiones → Tokens de gestión).',
    );
  }
  return token;
}

async function conectar(argv: readonly string[], io: EntradaSalidaMailway): Promise<void> {
  const opts = conectarSchema.parse(leerOpciones(argv, ['servicio', 'proyecto', 'url']));
  const service = resolverServicio(opts.servicio, opts.proyecto);
  checkService(service.id);
  // Todo lo que no depende del token se valida antes de leerlo.
  if (opts.url) parsePanelUrl(opts.url);

  const texto = await io.leerEntrada();
  if (texto.length > MAX_ENTRADA) throw new ErrorHerramienta('La entrada estándar es demasiado larga para ser un token de gestión.');
  const token = tokenDeEntrada(texto);

  const valores = { token, serviceId: service.id, ...(opts.url ? { baseUrl: opts.url } : {}) };
  // Sesión de navegador «no»: es lo más restrictivo, y el token llega siempre.
  const prueba = await probarConexionMailway(valores, { sesionNavegador: false });
  guardarConfigMailway(valores, (action, target) => auditSystem(action, target.detail, target));
  for (const aviso of prueba.warnings) io.err(`Aviso: ${aviso}`);
  io.out(JSON.stringify({ ok: true, version: prueba.info.version, brandName: prueba.info.brandName }));
}

/** Ejecuta la herramienta y devuelve el código de salida. La base de datos ya debe estar abierta. */
export async function ejecutarMailway(argv: readonly string[], io: EntradaSalidaMailway): Promise<number> {
  const [orden, ...resto] = argv;
  try {
    // Antes que nada: un token en los argumentos se rechaza sin usarlo ni repetirlo.
    if (argv.some((a) => /mwt_/i.test(a)) || argv.includes('--token')) throw new ErrorHerramienta(SOLO_ENTRADA);
    if (orden !== 'conectar') throw new ErrorHerramienta(USO);
    await conectar(resto, io);
    return 0;
  } catch (err) {
    io.err(err instanceof MailwayError ? mensajeMailway(err) : mensajeDeError(err));
    return 1;
  }
}

/** Entrada estándar del proceso. Desde un terminal no se espera: el token tiene que llegar por una tubería. */
async function leerEntradaEstandar(): Promise<string> {
  if (process.stdin.isTTY) throw new ErrorHerramienta(SOLO_ENTRADA);
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of process.stdin) {
    const buf = Buffer.isBuffer(trozo) ? trozo : Buffer.from(String(trozo));
    total += buf.length;
    if (total > MAX_ENTRADA) throw new ErrorHerramienta('La entrada estándar es demasiado larga para ser un token de gestión.');
    trozos.push(buf);
  }
  return Buffer.concat(trozos).toString('utf8');
}

if (require.main === module) {
  initDb();
  void ejecutarMailway(process.argv.slice(2), { ...ENTRADA_SALIDA_PROCESO, leerEntrada: leerEntradaEstandar }).then((code) => process.exit(code));
}
