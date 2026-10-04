/**
 * Cliente mínimo de la API v4 de Cloudflare, portado del de Mailway
 * (`server/src/core/cloudflare.ts`): solo lo que necesita el DNS automático
 * de los dominios de servicios (verificar el token, localizar la zona de un
 * nombre, leer sus registros y crear uno). No hay métodos para modificar
 * registros a propósito: Skyway nunca pisa un registro existente por su
 * cuenta. Solo borra, a petición del administrador, un registro que creó el
 * propio DNS automático y que nadie ha cambiado desde entonces (Ajustes →
 * Cloudflare) o, con su confirmación expresa, el A/AAAA/CNAME del hosting
 * anterior de un dominio que pasa a este servidor (`batch`, que lo sustituye
 * de una vez y sin estados intermedios).
 *
 * Los errores de Cloudflare se traducen a mensajes en español listos para la
 * interfaz, con `statusCode` para el manejador global (nunca 401: la interfaz
 * lo tomaría por una sesión caducada). El token solo viaja en la cabecera
 * Authorization: no aparece en ningún mensaje ni registro.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** Comentario con el que se marcan los registros que crea Skyway. */
export const COMENTARIO_SKYWAY = 'Skyway';

const TIMEOUT_MS = 15_000;

/* --------------------------------- Tipos ---------------------------------- */

export interface CfMensaje {
  code: number;
  message: string;
  error_chain?: CfMensaje[];
}

interface CfSobre<T> {
  success: boolean;
  errors?: CfMensaje[];
  result: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
}

export interface CfZona {
  id: string;
  name: string;
  /** initializing | pending | active | moved */
  status: string;
  accountId: string;
}

export interface CfRegistro {
  id: string;
  type: string;
  /** FQDN en minúsculas, sin punto final. */
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}

/** Cuerpo del alta de un registro. */
export interface CfRegistroNuevo {
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment: string;
}

/**
 * Lote atómico (`/dns_records/batch`): Cloudflare aplica primero los borrados
 * y después las altas, y si una operación falla no aplica ninguna. Sin
 * modificaciones (`patches`/`puts`): Skyway no las usa.
 */
export interface CfLote {
  deletes?: { id: string }[];
  posts?: (Omit<CfRegistroNuevo, 'comment'> & { comment?: string })[];
}

export interface CfInfoToken {
  id: string;
  status: string;
  /** Tokens de usuario (perfil) o de cuenta (cfat_): se verifican en rutas distintas. */
  kind: 'user' | 'account';
  accountId: string | null;
}

/* -------------------------------- Errores --------------------------------- */

/** Error de Cloudflare ya traducido; conserva los códigos originales. */
export class CloudflareError extends Error {
  /** Código HTTP con el que responde Skyway (lo lee el manejador global). */
  readonly statusCode: number;
  /** Código estable (`cloudflare_token_invalid`, `cloudflare_exists`…). */
  readonly code: string;
  readonly cfCodes: number[];
  /** Código HTTP con el que respondió Cloudflare (0 si no llegó a responder). */
  readonly httpStatus: number;

  constructor(status: number, message: string, code: string, cfCodes: number[] = [], httpStatus = 0) {
    super(message);
    this.name = 'CloudflareError';
    this.statusCode = status;
    this.code = code;
    this.cfCodes = cfCodes;
    this.httpStatus = httpStatus;
  }
}

/**
 * Errores que afectan al token o a la conexión entera: con ellos no tiene
 * sentido seguir con el siguiente dominio (fallaría igual y gastaría plazo).
 */
export const ERRORES_GLOBALES = new Set([
  'cloudflare_token_invalid',
  'cloudflare_token_malformed',
  'cloudflare_token_inactive',
  'cloudflare_token_ip_restricted',
  'cloudflare_global_key',
  'cloudflare_rate_limited',
  'cloudflare_timeout',
  'cloudflare_unreachable',
]);

function codigosDe(errores: CfMensaje[]): number[] {
  const out: number[] = [];
  const visitar = (lista: CfMensaje[] | undefined) => {
    for (const e of lista || []) {
      if (typeof e.code === 'number') out.push(e.code);
      visitar(e.error_chain);
    }
  };
  visitar(errores);
  return out;
}

/** Mensajes de todos los errores con ese código (también los de `error_chain`). */
function mensajesCon(errores: CfMensaje[], codigo: number): string[] {
  const out: string[] = [];
  const visitar = (lista: CfMensaje[] | undefined) => {
    for (const e of lista || []) {
      if (e.code === codigo && typeof e.message === 'string') out.push(e.message);
      visitar(e.error_chain);
    }
  };
  visitar(errores);
  return out;
}

function primerMensaje(errores: CfMensaje[]): string {
  const e = errores[0];
  if (!e) return '';
  const cadena = e.error_chain?.[0]?.message;
  // Una sola línea y acotada: el texto viene de fuera y acaba en la interfaz.
  return [e.message, cadena]
    .filter(Boolean)
    .join(': ')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
}

/**
 * Traduce la respuesta de error de Cloudflare. Los códigos se miran también en
 * `error_chain`, que es donde Cloudflare deja el motivo concreto (p. ej. el
 * 6111 de una clave global usada como token).
 */
export function errorDeCloudflare(httpStatus: number, errores: CfMensaje[] = []): CloudflareError {
  const codigos = codigosDe(errores);
  const tiene = (...lista: number[]) => lista.some((c) => codigos.includes(c));
  const detalle = primerMensaje(errores);
  const nuevo = (status: number, mensaje: string, code: string) => new CloudflareError(status, mensaje, code, codigos, httpStatus);

  if (httpStatus === 429 || tiene(971)) {
    return nuevo(
      429,
      'Cloudflare ha limitado temporalmente las peticiones de este token (1200 cada 5 minutos). Espera unos minutos y vuelve a intentarlo.',
      'cloudflare_rate_limited',
    );
  }
  if (tiene(81057, 81058)) {
    return nuevo(409, 'Ya existe un registro idéntico en Cloudflare.', 'cloudflare_identical');
  }
  if (tiene(81053, 81054, 81055)) {
    return nuevo(
      409,
      'Ya existe en Cloudflare otro registro con ese nombre que no puede convivir con el nuevo (un CNAME no admite otros registros con el mismo nombre).',
      'cloudflare_exists',
    );
  }
  if (tiene(6003, 6111, 6103, 9106)) {
    return nuevo(
      400,
      'Cloudflare no acepta la credencial. Utiliza un token de API (no la clave global de la API) y cópialo completo.',
      'cloudflare_token_malformed',
    );
  }
  if (tiene(1000) || httpStatus === 401) {
    return nuevo(400, 'El token de Cloudflare no es válido. Comprueba que lo has copiado completo o genera uno nuevo.', 'cloudflare_token_invalid');
  }
  if (tiene(9109)) {
    // Cloudflare usa el 9109 para tres cosas distintas, que solo distingue el
    // texto: un token que no existe o se ha revocado («Invalid access token»,
    // con HTTP 403 en /zones), uno restringido a otras direcciones IP
    // («Cannot use the access token from location: …») y la falta de permiso.
    // Las dos primeras afectan a todo lo que se haga con el token.
    const textos = mensajesCon(errores, 9109).join(' ');
    if (/invalid (access|api) token/i.test(textos)) {
      return nuevo(400, 'El token de Cloudflare no es válido. Comprueba que lo has copiado completo o genera uno nuevo.', 'cloudflare_token_invalid');
    }
    if (/location/i.test(textos)) {
      return nuevo(
        400,
        'El token de Cloudflare está restringido a otras direcciones IP y no admite peticiones desde este servidor. Añade su IP a las restricciones del token o quítalas.',
        'cloudflare_token_ip_restricted',
      );
    }
    return nuevo(
      400,
      'El token de Cloudflare no tiene permiso para esta operación. Asigna los permisos «Zone · Zone · Read» y «Zone · DNS · Edit» e incluye la zona en el token.',
      'cloudflare_forbidden',
    );
  }
  if (tiene(10000) || httpStatus === 403) {
    return nuevo(
      400,
      'El token de Cloudflare es válido, pero no tiene permiso sobre esta zona. Asigna los permisos «Zone · Zone · Read» y «Zone · DNS · Edit» e incluye la zona en el token.',
      'cloudflare_forbidden',
    );
  }
  if (tiene(7000, 7003)) {
    return nuevo(400, 'Cloudflare no reconoce el identificador de la zona.', 'cloudflare_invalid_id');
  }
  if (tiene(1004, 9101) || codigos.some((c) => c >= 9000 && c < 9200)) {
    return nuevo(400, `Cloudflare ha rechazado el registro DNS${detalle ? ` (${detalle})` : ''}.`, 'cloudflare_invalid_record');
  }
  const codigo = codigos[0];
  return nuevo(
    502,
    `Cloudflare ha respondido con un error${codigo ? ` (código ${codigo})` : ` (HTTP ${httpStatus})`}${detalle ? `: ${detalle}` : ''}.`,
    'cloudflare_error',
  );
}

/* -------------------------------- Cliente --------------------------------- */

interface ZonaCruda {
  id: string;
  name: string;
  status?: string;
  account?: { id?: string };
}

interface RegistroCrudo {
  id: string;
  type: string;
  name: string;
  content?: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
}

function aZona(z: ZonaCruda): CfZona {
  return { id: z.id, name: z.name.toLowerCase(), status: z.status || 'active', accountId: z.account?.id || '' };
}

function aRegistro(r: RegistroCrudo): CfRegistro {
  return {
    id: r.id,
    type: r.type,
    name: r.name.toLowerCase().replace(/\.$/, ''),
    content: r.content ?? '',
    proxied: Boolean(r.proxied),
    ttl: r.ttl ?? 1,
    comment: r.comment ?? null,
  };
}

/** Clave global de la API (no es un token): Cloudflare la rechaza como Bearer. */
export function esClaveGlobal(token: string): boolean {
  return token.startsWith('cfk_') || /^[0-9a-f]{37}$/i.test(token);
}

export class CloudflareClient {
  private readonly token: string;
  private readonly baseUrl: string;
  /** Señal externa (plazo total de una operación): corta también la petición en curso. */
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;

  constructor(token: string, opts: { baseUrl?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
    this.token = token.trim();
    this.baseUrl = (opts.baseUrl ?? CLOUDFLARE_API).replace(/\/+$/, '');
    this.signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  private async peticion<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<CfSobre<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [clave, valor] of Object.entries(opts.query || {})) {
      if (valor !== undefined) url.searchParams.set(clave, valor);
    }
    // Plazo por petición y, encima, el de la operación entera: lo que antes
    // venza corta la petición (y la lectura del cuerpo).
    const ctrl = new AbortController();
    const plazo = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const alCortar = () => ctrl.abort();
    if (this.signal?.aborted) ctrl.abort();
    else this.signal?.addEventListener('abort', alCortar, { once: true });
    let res: Response;
    let texto: string;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      texto = await res.text();
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw new CloudflareError(504, 'Cloudflare no ha respondido a tiempo. Vuelve a intentarlo en unos minutos.', 'cloudflare_timeout');
      }
      // El mensaje de fetch no incluye cabeceras: no hay riesgo de exponer el token.
      throw new CloudflareError(502, `No se ha podido conectar con Cloudflare (${(err as Error).message}).`, 'cloudflare_unreachable');
    } finally {
      clearTimeout(plazo);
      this.signal?.removeEventListener('abort', alCortar);
    }
    let sobre: CfSobre<T> | null = null;
    try {
      sobre = texto ? (JSON.parse(texto) as CfSobre<T>) : null;
    } catch {
      sobre = null;
    }
    if (!sobre || typeof sobre !== 'object') {
      if (!res.ok) throw errorDeCloudflare(res.status, []);
      throw new CloudflareError(502, `Cloudflare ha devuelto una respuesta no válida (HTTP ${res.status}).`, 'cloudflare_error');
    }
    if (!res.ok || sobre.success === false) throw errorDeCloudflare(res.status, sobre.errors || []);
    return sobre;
  }

  /** Recorre todas las páginas de un listado. */
  private async paginar<T>(path: string, query: Record<string, string | undefined>, porPagina: number): Promise<T[]> {
    const out: T[] = [];
    // Tope de seguridad: más de 50 páginas no es un caso de uso de este panel.
    for (let pagina = 1; pagina <= 50; pagina++) {
      const sobre = await this.peticion<T[]>('GET', path, {
        query: { ...query, page: String(pagina), per_page: String(porPagina) },
      });
      const lote = Array.isArray(sobre.result) ? sobre.result : [];
      out.push(...lote);
      const total = sobre.result_info?.total_pages;
      if (lote.length < porPagina || (typeof total === 'number' && pagina >= total)) break;
    }
    return out;
  }

  /**
   * Verifica el token. Los tokens de cuenta (cfat_) fallan en la ruta de
   * usuario con el código 1000, así que en ese caso se obtiene la cuenta a
   * partir de las zonas visibles y se verifica en la ruta de la cuenta.
   */
  async verifyToken(): Promise<CfInfoToken> {
    if (esClaveGlobal(this.token)) {
      throw new CloudflareError(
        400,
        'Has introducido la clave global de la API de Cloudflare. Por seguridad, crea un token de API con permisos limitados a las zonas y al DNS.',
        'cloudflare_global_key',
      );
    }
    let deCuenta = this.token.startsWith('cfat_');
    if (!deCuenta) {
      try {
        const sobre = await this.peticion<{ id: string; status: string }>('GET', '/user/tokens/verify');
        return this.comprobarActivo({ id: sobre.result.id, status: sobre.result.status, kind: 'user', accountId: null });
      } catch (err) {
        if (!(err instanceof CloudflareError) || !err.cfCodes.includes(1000)) throw err;
        deCuenta = true;
      }
    }
    const zonas = await this.peticion<ZonaCruda[]>('GET', '/zones', { query: { per_page: '5' } });
    const cuenta = zonas.result?.[0]?.account?.id;
    if (!cuenta) {
      throw new CloudflareError(
        400,
        'El token no da acceso a ninguna zona. Asigna el permiso «Zone · Zone · Read» e incluye las zonas de tus dominios.',
        'cloudflare_no_zones',
      );
    }
    const sobre = await this.peticion<{ id: string; status: string }>('GET', `/accounts/${encodeURIComponent(cuenta)}/tokens/verify`);
    return this.comprobarActivo({ id: sobre.result.id, status: sobre.result.status, kind: 'account', accountId: cuenta });
  }

  private comprobarActivo(info: CfInfoToken): CfInfoToken {
    if (info.status !== 'active') {
      throw new CloudflareError(400, 'El token de Cloudflare está desactivado o ha caducado. Actívalo o genera uno nuevo.', 'cloudflare_token_inactive');
    }
    return info;
  }

  /** Zonas visibles para el token (todas las páginas). */
  async listZones(): Promise<CfZona[]> {
    const crudas = await this.paginar<ZonaCruda>('/zones', {}, 50);
    return crudas.map(aZona);
  }

  /**
   * Zona que contiene un nombre: se prueba de la etiqueta más larga a la más
   * corta (a.b.ejemplo.es → b.ejemplo.es → ejemplo.es). Una zona que el token
   * no ve no es un error para Cloudflare: devuelve una lista vacía.
   */
  async findZoneFor(hostname: string): Promise<CfZona | null> {
    const etiquetas = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    for (let i = 0; i < etiquetas.length - 1; i++) {
      const candidata = etiquetas.slice(i).join('.');
      const sobre = await this.peticion<ZonaCruda[]>('GET', '/zones', { query: { name: candidata, per_page: '5' } });
      const zona = (sobre.result || []).find((z) => z.name.toLowerCase() === candidata);
      if (zona) return aZona(zona);
    }
    return null;
  }

  /** Registros de la zona, filtrados por tipo y nombre exacto (FQDN). */
  async listRecords(zoneId: string, filtro: { type?: string; name?: string } = {}): Promise<CfRegistro[]> {
    const crudos = await this.paginar<RegistroCrudo>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      { type: filtro.type, name: filtro.name },
      100,
    );
    return crudos.map(aRegistro);
  }

  async createRecord(zoneId: string, registro: CfRegistroNuevo): Promise<CfRegistro> {
    const sobre = await this.peticion<RegistroCrudo>('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, { body: registro });
    return aRegistro(sobre.result);
  }

  /** Un registro por su identificador, o null si ya no existe (Cloudflare responde 404 / 81044). */
  async getRecord(zoneId: string, recordId: string): Promise<CfRegistro | null> {
    try {
      const sobre = await this.peticion<RegistroCrudo>(
        'GET',
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      );
      return aRegistro(sobre.result);
    } catch (err) {
      if (err instanceof CloudflareError && (err.httpStatus === 404 || err.cfCodes.includes(81044))) return null;
      throw err;
    }
  }

  /**
   * Borra un registro. Solo lo usa la limpieza de Ajustes → Cloudflare, y solo
   * tras comprobar con `getRecord` que es el que creó Skyway sin cambios.
   */
  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.peticion<unknown>('DELETE', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
  }

  /**
   * Borra y crea en una sola operación atómica. Lo usa el reemplazo del
   * registro de la web (y su restauración): hecho en dos pasos, un fallo entre
   * medias dejaría el dominio sin dirección.
   */
  async batch(zoneId: string, lote: CfLote): Promise<{ deletes: CfRegistro[]; posts: CfRegistro[] }> {
    const cuerpo: CfLote = {};
    if (lote.deletes?.length) cuerpo.deletes = lote.deletes;
    if (lote.posts?.length) cuerpo.posts = lote.posts;
    const sobre = await this.peticion<{ deletes?: RegistroCrudo[]; posts?: RegistroCrudo[] }>(
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/batch`,
      { body: cuerpo },
    );
    const r = sobre.result || {};
    return { deletes: (r.deletes || []).map(aRegistro), posts: (r.posts || []).map(aRegistro) };
  }
}

/** Últimos 4 caracteres del token, para reconocerlo sin mostrarlo. */
export function pistaToken(token: string): string {
  const limpio = token.trim();
  return limpio.length > 8 ? limpio.slice(-4) : '';
}

/**
 * Enlace al asistente de tokens de Cloudflare con los dos permisos que
 * necesita Skyway ya marcados (Zone · Read y DNS · Edit).
 */
export const URL_CREAR_TOKEN =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=Skyway%20DNS';
