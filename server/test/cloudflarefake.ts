/**
 * Doble en memoria de la API v4 de Cloudflare detrás de `fetch`, para las
 * pruebas del token del administrador y del DNS automático. Sigue el contrato
 * real en lo que usa Skyway: sobre `{success, errors, result, result_info}`,
 * verificación de tokens de usuario y de cuenta (`cfat_`), zonas visibles por
 * token, registros filtrados por nombre exacto y códigos de error (1000 token
 * no válido, 10000 sin permiso, 81053 CNAME que no convive, 81058 idéntico).
 *
 * Registra cada petición (método, ruta, consulta, Authorization y cuerpo) y
 * responde 405 a cualquier PUT, PATCH o DELETE: Skyway nunca debe enviarlos.
 */

export const CF_HOST = 'api.cloudflare.com';

export interface CfZonaFalsa {
  id: string;
  name: string;
  status: 'active' | 'pending';
  accountId: string;
}

export interface CfRegistroFalso {
  id: string;
  zoneId: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}

export interface CfTokenFalso {
  kind: 'user' | 'account';
  accountId: string;
  zoneIds: string[];
  status: 'active' | 'disabled';
}

export interface CfLlamada {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | null;
  body: unknown;
}

export const cf = {
  tokens: new Map<string, CfTokenFalso>(),
  zones: [] as CfZonaFalsa[],
  records: [] as CfRegistroFalso[],
  calls: [] as CfLlamada[],
  /** Si es true, no responde nunca (hasta que se corta la petición). */
  hang: false,
  seq: 0,
};

/** Estado inicial: sin tokens, zonas ni registros. */
export function reiniciarCloudflare(): void {
  cf.tokens.clear();
  cf.zones = [];
  cf.records = [];
  cf.calls = [];
  cf.hang = false;
  cf.seq = 0;
}

export function zona(name: string, opts: { accountId?: string; status?: 'active' | 'pending' } = {}): CfZonaFalsa {
  const z: CfZonaFalsa = { id: `zona_${name.replace(/\W/g, '_')}`, name, status: opts.status ?? 'active', accountId: opts.accountId ?? 'cuenta1' };
  cf.zones.push(z);
  return z;
}

export function registro(z: CfZonaFalsa, r: { type: string; name: string; content: string; proxied?: boolean; comment?: string }): CfRegistroFalso {
  const nuevo: CfRegistroFalso = {
    id: `reg_${++cf.seq}`,
    zoneId: z.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: !!r.proxied,
    ttl: 1,
    comment: r.comment ?? null,
  };
  cf.records.push(nuevo);
  return nuevo;
}

function sobre(status: number, result: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: status < 400, errors: [], messages: [], result, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fallo(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pagina<T>(lista: T[], query: Record<string, string>): Response {
  const porPagina = Number(query.per_page || 20);
  const num = Number(query.page || 1);
  const total = Math.max(1, Math.ceil(lista.length / porPagina));
  return sobre(200, lista.slice((num - 1) * porPagina, num * porPagina), {
    result_info: { page: num, per_page: porPagina, total_pages: total, total_count: lista.length },
  });
}

const aZonaApi = (z: CfZonaFalsa) => ({ id: z.id, name: z.name, status: z.status, account: { id: z.accountId, name: 'Cuenta' } });

export async function cloudflareFetch(url: URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const query = Object.fromEntries(url.searchParams.entries());
  const path = url.pathname.replace(/^\/client\/v4/, '');
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  cf.calls.push({ method, path, query, auth: headers.get('authorization'), body });

  if (cf.hang) {
    return new Promise<Response>((_resolve, reject) => {
      const cortar = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) cortar();
      else init.signal?.addEventListener('abort', cortar, { once: true });
    });
  }

  const bearer = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const token = cf.tokens.get(bearer);
  if (!token) return fallo(401, 1000, 'Invalid API Token');
  const visibles = cf.zones.filter((z) => token.zoneIds.includes(z.id));
  let m: RegExpMatchArray | null;

  if (path === '/user/tokens/verify' && method === 'GET') {
    // Los tokens de cuenta no se verifican en la ruta de usuario.
    if (token.kind === 'account') return fallo(401, 1000, 'Invalid API Token');
    return sobre(200, { id: 'tok_usuario', status: token.status });
  }
  if ((m = path.match(/^\/accounts\/([^/]+)\/tokens\/verify$/)) && method === 'GET') {
    if (token.kind !== 'account' || token.accountId !== m[1]) return fallo(401, 1000, 'Invalid API Token');
    return sobre(200, { id: 'tok_cuenta', status: token.status });
  }
  // Un token desactivado no sirve para nada más (Cloudflare responde 401/1000).
  if (token.status !== 'active') return fallo(401, 1000, 'Invalid API Token');

  if (path === '/zones' && method === 'GET') {
    const lista = query.name ? visibles.filter((z) => z.name === query.name) : visibles;
    return pagina(lista.map(aZonaApi), query);
  }
  if ((m = path.match(/^\/zones\/([^/]+)\/dns_records$/))) {
    const z = visibles.find((x) => x.id === m![1]);
    if (!z) return fallo(403, 10000, 'Authentication error');
    if (method === 'GET') {
      const lista = cf.records.filter(
        (r) => r.zoneId === z.id && (!query.name || r.name === query.name) && (!query.type || r.type === query.type),
      );
      return pagina(lista, query);
    }
    if (method === 'POST') {
      const nuevo = body as { type: string; name: string; content: string; proxied: boolean; ttl: number; comment: string };
      const mismos = cf.records.filter((r) => r.zoneId === z.id && r.name === nuevo.name);
      if (mismos.some((r) => r.type === nuevo.type && r.content === nuevo.content)) {
        return fallo(400, 81058, 'An identical record already exists.');
      }
      if (mismos.some((r) => r.type === 'CNAME') || (nuevo.type === 'CNAME' && mismos.length > 0)) {
        return fallo(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
      }
      const r = registro(z, nuevo);
      r.ttl = nuevo.ttl;
      return sobre(200, r);
    }
  }
  return fallo(405, 10405, `Método no admitido por el doble: ${method} ${path}`);
}
