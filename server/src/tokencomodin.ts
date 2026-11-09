/**
 * Token de Cloudflare del certificado comodín, guardado desde el panel
 * (Ajustes → Dominios y TLS): así se configura sin entrar en el servidor a
 * editar el `.env`.
 *
 * Solo se escribe. Va al volumen `traefik-secrets`, que Traefik lee con
 * `CF_DNS_API_TOKEN_FILE` (ver comodin.ts), y nunca se devuelve, se registra ni
 * se audita: fuera de aquí solo sale su pista (los últimos 4 caracteres). No
 * pasa por `settings`, así que tampoco viaja en las copias de la base del
 * panel, que se pueden descargar. Si el `.env` del servidor también trae uno,
 * manda el del `.env` (lego lo mira antes que el fichero).
 *
 * Antes de guardarlo se prueba en Cloudflare: que es un token activo, no la
 * clave global, y que ve la zona del dominio raíz. Que pueda editar su DNS no
 * se puede saber sin escribir en ella; si no puede, Ajustes lo ve después,
 * porque Traefik no llega a servir el comodín (`certificado: 'invalido'`).
 *
 * lego lee el token al crear su cliente y lo conserva hasta que Traefik se
 * reinicia. Por eso, si Traefik ya usaba el del panel, sustituirlo o borrarlo
 * reinicia Traefik; también guardarlo con el comodín ya activado (pudo
 * intentarlo sin token, y no lo repite hasta que cambie su configuración). El
 * reinicio va después de responder: la propia petición pasa por Traefik, y
 * reiniciarlo antes la cortaría.
 */
import { CloudflareClient, CloudflareError } from './cloudflare';
import { validarFormatoToken } from './cloudflareconfig';
import {
  AJUSTE_COMODIN,
  borrarTokenPanel,
  dominioRaiz,
  escribirTokenPanel,
  refreshTraefikComodin,
  secretosDisponibles,
  tokenPanel,
} from './comodin';
import { getSetting } from './db';
import { httpError } from './mailconnect';
import { reiniciarTraefik } from './tls';

/** Cómo deja rastro quien guarda (`audit(req, …)` en la ruta). Nunca con el token. */
export type AuditarTokenComodin = (action: string, target: { type: string; id: string; detail: string }) => void;
type Logger = { warn: (obj: object, msg: string) => void };

/** Margen para que la respuesta salga antes de que Traefik se pare. */
let retrasoReinicioMs = 1500;

const SIN_VOLUMEN =
  'Falta el volumen que Skyway comparte con Traefik. Actualiza Skyway con skyway update para guardar el token desde aquí, o define CF_DNS_API_TOKEN en el .env del servidor.';

/** Prueba el token en Cloudflare y devuelve la zona del dominio raíz que ve. */
async function verificar(token: string, raiz: string): Promise<string> {
  const cliente = new CloudflareClient(token);
  await cliente.verifyToken();
  const zona = await cliente.findZoneFor(raiz);
  if (!zona) {
    throw new CloudflareError(
      400,
      `El token no da acceso a la zona de ${raiz}. Inclúyela en «Zone Resources», con los permisos «Zone · DNS · Edit» y «Zone · Zone · Read».`,
      'wildcard_token_no_zone',
    );
  }
  return zona.name;
}

function programarReinicio(log: Logger): void {
  const temporizador = setTimeout(() => {
    reiniciarTraefik().catch((err: unknown) =>
      log.warn(
        { err },
        'No se ha podido reiniciar Traefik tras cambiar el token del certificado comodín. Reinícialo con docker compose restart traefik.',
      ),
    );
  }, retrasoReinicioMs);
  temporizador.unref?.();
}

/**
 * Verifica el token y, solo si Cloudflare lo acepta, lo guarda para Traefik.
 * Guardar el mismo otra vez no cambia nada ni reinicia Traefik.
 */
export async function guardarTokenComodin(
  tokenCrudo: string,
  auditar: AuditarTokenComodin,
  log: Logger,
): Promise<{ zona: string; cambiado: boolean; reinicio: boolean }> {
  const token = validarFormatoToken(tokenCrudo);
  const raiz = dominioRaiz();
  if (!raiz) throw httpError(400, 'Guarda primero el dominio raíz: el token se comprueba con su zona.');
  if (!secretosDisponibles()) throw httpError(409, SIN_VOLUMEN);
  const zona = await verificar(token, raiz);
  const anterior = tokenPanel();
  if (anterior === token) return { zona, cambiado: false, reinicio: false };
  const antes = await refreshTraefikComodin({ force: true });
  escribirTokenPanel(token);
  auditar(anterior ? 'wildcard_token_replaced' : 'wildcard_token_saved', { type: 'system', id: 'traefik', detail: `zona ${zona}` });
  // Con el token del .env u otro fichero, el del panel no le llega a lego.
  const reinicio =
    antes.token === 'panel' || (antes.token === null && antes.resolutor !== 'sin_resolutor' && getSetting(AJUSTE_COMODIN) === '1');
  if (reinicio) programarReinicio(log);
  await refreshTraefikComodin({ force: true });
  return { zona, cambiado: true, reinicio };
}

/** Borra el token del panel. Si Traefik lo usaba, se reinicia para que lo deje. */
export async function borrarTokenComodin(auditar: AuditarTokenComodin, log: Logger): Promise<{ habia: boolean; reinicio: boolean }> {
  const antes = await refreshTraefikComodin({ force: true });
  const habia = borrarTokenPanel();
  if (!habia) return { habia, reinicio: false };
  auditar('wildcard_token_removed', { type: 'system', id: 'traefik', detail: 'token eliminado' });
  const reinicio = antes.token === 'panel';
  if (reinicio) programarReinicio(log);
  await refreshTraefikComodin({ force: true });
  return { habia, reinicio };
}

/** Solo para las pruebas: sin esperar al margen del reinicio. */
export function setRetrasoReinicioForTests(ms: number): void {
  retrasoReinicioMs = ms;
}
