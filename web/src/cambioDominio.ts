/**
 * Tipos y llamadas del asistente «Cambiar de dominio» de un proyecto
 * (`server/src/domainmigration.ts` y `routes/domainmigrations.ts`). Las formas
 * son las que devuelve el servidor; el estado del correo es el de Mailway
 * (`CambioDominioVista`), que Skyway enseña tal cual.
 */
import { api } from './api';

export type ModoHost = 'redirigir' | 'servir' | 'no_cambiar';
export type AmbitoVariable = 'service' | 'project' | 'build';

export interface HostPlan {
  serviceId: string;
  from: string;
  to: string;
  modo: ModoHost;
}

export interface Clave {
  ambito: AmbitoVariable;
  serviceId: string | null;
  key: string;
}

export type CorreoDisponible = 'si' | 'no_vinculado' | 'sin_dominio' | 'mailway_antiguo';

export interface CambioVariable {
  ambito: AmbitoVariable;
  serviceId: string | null;
  serviceName: string | null;
  key: string;
  ocurrencias: number;
  /** null en los argumentos de compilación: su valor no sale del servidor. */
  antes: string | null;
  despues: string | null;
  gestionada: string | null;
  excluida: boolean;
}

export interface NotaVariable {
  ambito: AmbitoVariable;
  serviceId: string | null;
  key: string;
  texto: string;
}

export interface PlanVariables {
  cambios: CambioVariable[];
  notas: NotaVariable[];
  wordpress: { serviceId: string; serviceName: string; url: string }[];
  huella: string;
}

/** Plan del correo en Mailway (vista previa, sin efectos). */
export interface PlanCorreo {
  desde: { domainId: string; domain: string };
  hacia: { domain: string; existe: boolean; domainId: string | null };
  /** `appsManuales`: contraseñas de aplicación creadas a mano (un Mailway anterior no lo manda). */
  buzones: { id: string; de: string; a: string; usadoPorApps: string[]; appsManuales?: string[] }[];
  alias: { id: string; de: string; a: string }[];
  formularios: { id: string; name: string; origenesNuevos: string[] }[];
  webmail: { viejo: string | null; nuevo: string | null };
  avisos: { code: string; mensaje: string }[];
  bloqueos: { code: string; mensaje: string }[];
}

/** Proveedor de webhooks del aviso; `webhook` cuando el nombre de la variable no dice cuál. */
export type ProveedorAviso = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'twilio' | 'stripe' | 'webhook';

/** Por qué se vuelve a desplegar un servicio al pasar (`referencias`: usa la dirección de otro que cambia de nombre). */
export type MotivoDespliegue = 'dominios' | 'variables' | 'compartidas' | 'remitente' | 'referencias';

/** Servicio que se volverá a desplegar al pasar. `reinicio`: se despliega con una sola copia. */
export interface ServicioAlPasar {
  serviceId: string;
  nombre: string;
  reinicio: boolean;
  motivos: MotivoDespliegue[];
}

/** Servicio que recibe webhooks en nombres que redirigen (o redirigirán) al pasar. */
export interface WebhookEnRiesgo {
  serviceId: string;
  serviceName: string;
  proveedores: ProveedorAviso[];
  evidencias: string[];
  hosts: { serviceId: string; from: string; to: string }[];
}

/** Buzón con el que entran variables que Skyway no gestiona (un `TG_SMTP_LOGIN`, un `SMTP_USER` puesto a mano…). */
export interface UsuarioSinGestionar {
  mailboxId: string;
  email: string;
  login: string;
  pendiente: boolean;
  usos: {
    ambito: 'service' | 'project';
    serviceId: string | null;
    serviceName: string | null;
    key: string;
    usuario: string;
    /** `cambiara`: entra hoy y dejará de entrar al actualizar el buzón o en la baja; `no_entra`: ya no entra. */
    estado: 'cambiara' | 'no_entra';
  }[];
}

export interface PlanSkyway {
  fromDomain: string;
  toDomain: string;
  soloWeb: boolean;
  hosts: (HostPlan & { serviceName: string; error: string | null })[];
  dnsWeb: { host: string; ip: string | null; automatico: boolean }[];
  correoDisponible: CorreoDisponible;
  correo: PlanCorreo | null;
  variables: PlanVariables;
  servicios: ServicioAlPasar[];
  webhooks: WebhookEnRiesgo[];
  avisos: string[];
  bloqueos: string[];
  expect: string;
}

export type EstadoCambioCorreo =
  | 'preparando'
  | 'listo'
  | 'pasando'
  | 'pasado'
  | 'volviendo'
  | 'dando_de_baja'
  | 'dado_de_baja'
  | 'cancelada';

/** Estado del cambio del correo en Mailway. */
export interface CambioCorreo {
  id: string;
  estado: EstadoCambioCorreo;
  paso: string;
  error: string | null;
  desde: { domainId: string | null; domain: string };
  hacia: { domainId: string | null; domain: string; cloudflare: boolean; recibeEnOtroProveedor: boolean };
  recepcionPreparada: boolean;
  compuertas: { id: string; ok: boolean; bloquea: boolean; titulo: string; detalle: string }[];
  puedeDarDeBaja: boolean;
  bloqueosBaja: { code: string; mensaje: string }[];
  buzones: {
    total: number;
    pendientes: number;
    lista: { id: string; email: string; login: string; pendiente: boolean; usadoPorApps: string[]; appsManuales?: string[] }[];
  };
  alias: { total: number };
  webmail: {
    viejo: { id: string; hostname: string; status: string; principal: boolean } | null;
    nuevo: { id: string; hostname: string; status: string; principal: boolean } | null;
  };
  avisos: { code: string; mensaje: string }[];
}

export type EstadoMigracion = 'preparando' | 'lista' | 'pasando' | 'pasada' | 'volviendo' | 'dando_de_baja' | 'terminada' | 'cancelada';

export interface Compuerta {
  id: 'dns_web' | 'certificados' | 'correo';
  ok: boolean;
  bloquea: boolean;
  titulo: string;
  detalle: string;
}

export interface MigracionSkyway {
  id: string;
  projectId: string;
  fromDomain: string;
  toDomain: string;
  soloWeb: boolean;
  estado: EstadoMigracion;
  paso: string;
  error: string | null;
  hosts: (HostPlan & {
    serviceName: string;
    dns: 'ok' | 'pendiente' | 'desconocido';
    certificado: 'ok' | 'pendiente' | 'desconocido' | 'sin_tls';
    detalle: string;
  })[];
  compuertas: Compuerta[];
  servicios: { serviceId: string; nombre: string; despliegue: { id: string; estado: string } | null; estado: string; error: string | null }[];
  redirecciones: { host: string; toHost: string; permanenteDesde: number }[];
  correo: CambioCorreo | null;
  variables: PlanVariables | null;
  /** Servicios que se volverán a desplegar al pasar (solo antes de pasar). */
  alPasar: ServicioAlPasar[] | null;
  /** Servicios con webhooks en nombres que redirigen (antes de pasar y, después, mientras sigan redirigiendo). */
  webhooks: WebhookEnRiesgo[];
  /** Buzones con los que entran variables que Skyway no gestiona (en transición). */
  usuariosSinGestionar: UsuarioSinGestionar[];
  /** Buzones pendientes con contraseñas creadas a mano que ningún servicio del proyecto usa. */
  appsManuales: { mailboxId: string; email: string; apps: string[] }[];
  /** IP a la que tienen que apuntar los registros A de los nombres nuevos. */
  ipServidor: string | null;
  avisos: string[];
  puedePasar: boolean;
  puedeVolver: boolean;
  puedeCancelar: boolean;
  puedeDarDeBaja: boolean;
  puedeTerminar: boolean;
  fechas: { creada: number; pasada: number | null; terminada: number | null };
}

export interface ListaCambios {
  abierta: MigracionSkyway | null;
  anteriores: MigracionSkyway[];
  /** Dominios de los servicios del proyecto, para proponer el actual. */
  dominios: string[];
}

export interface PeticionPlan {
  fromDomain: string;
  toDomain: string;
  soloWeb: boolean;
  hosts?: HostPlan[];
  excluidas?: Clave[];
}

const base = (projectId: string) => `/projects/${projectId}/domain-migrations`;

export const cambioDominioApi = {
  listar: (projectId: string, opts: { ligera?: boolean } = {}) =>
    api.get<ListaCambios>(`${base(projectId)}${opts.ligera ? '?ligera=1' : ''}`),
  plan: (projectId: string, body: PeticionPlan) => api.post<PlanSkyway>(`${base(projectId)}/plan`, body),
  preparar: (projectId: string, body: PeticionPlan & { hosts: HostPlan[]; excluidas: Clave[]; expect: string }) =>
    api.post<MigracionSkyway>(base(projectId), body),
  comprobar: (projectId: string, mid: string) => api.post<MigracionSkyway>(`${base(projectId)}/${mid}/check`),
  /** Cambia el MX del dominio nuevo a este servidor en su zona de Cloudflare (recibía en otro proveedor). */
  cambiarMx: (projectId: string, mid: string) => api.post<MigracionSkyway>(`${base(projectId)}/${mid}/mx`),
  pasar: (projectId: string, mid: string, expect: string) => api.post<MigracionSkyway>(`${base(projectId)}/${mid}/switch`, { expect }),
  /** «Servir también» un nombre que redirige (o volver a redirigirlo antes de pasar). Tras pasar, vuelve a desplegar el servicio. */
  modoHost: (projectId: string, mid: string, body: { serviceId: string; from: string; modo: 'servir' | 'redirigir' }) =>
    api.post<MigracionSkyway>(`${base(projectId)}/${mid}/hosts/mode`, body),
  volver: (projectId: string, mid: string) => api.post<MigracionSkyway>(`${base(projectId)}/${mid}/rollback`),
  cancelar: (projectId: string, mid: string) => api.post<MigracionSkyway>(`${base(projectId)}/${mid}/cancel`),
  darDeBaja: (projectId: string, mid: string, confirm: string) =>
    api.post<MigracionSkyway>(`${base(projectId)}/${mid}/retire`, { confirm }),
  terminar: (projectId: string, mid: string, confirm: string) =>
    api.post<MigracionSkyway>(`${base(projectId)}/${mid}/finish`, { confirm }),
  quitarRedirecciones: (projectId: string, mid: string, confirm: string) =>
    api.post<MigracionSkyway>(`${base(projectId)}/${mid}/redirects/remove`, { confirm }),
  reintentarServicio: (projectId: string, mid: string, serviceId: string) =>
    api.post<MigracionSkyway>(`${base(projectId)}/${mid}/services/${serviceId}/retry`),
  actualizarPersona: (projectId: string, mid: string, mailboxId: string) =>
    api.post<MigracionSkyway>(`${base(projectId)}/${mid}/mailboxes/${mailboxId}/login-update`),
  /** URL del fichero de zona (se descarga con la cookie de la sesión). */
  ficheroDeZonaUrl: (projectId: string, mid: string) => `/api${base(projectId)}/${mid}/zonefile`,
  async ficheroDeZona(projectId: string, mid: string): Promise<string> {
    const res = await fetch(`/api${base(projectId)}/${mid}/zonefile`, { credentials: 'same-origin' });
    const text = await res.text();
    if (!res.ok) {
      let msg = `Error ${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? msg;
      } catch {
        /* sin JSON */
      }
      throw new Error(msg);
    }
    return text;
  },
};

/** Cómo se llama cada estado en la interfaz (aviso del proyecto y cabecera del asistente). */
export const ESTADO_CAMBIO_LABEL: Record<EstadoMigracion, string> = {
  preparando: 'Preparando',
  lista: 'Listo para pasar',
  pasando: 'Pasando',
  pasada: 'En transición',
  volviendo: 'Volviendo',
  dando_de_baja: 'Dando de baja',
  terminada: 'Terminado',
  cancelada: 'Cancelado',
};

/** Estados en los que el asistente espera a que termine una acción. */
export const ESTADOS_EN_CURSO: readonly EstadoMigracion[] = ['pasando', 'volviendo', 'dando_de_baja'];

/** «11 de octubre», como lo dice la interfaz. */
export function fechaLarga(ts: number): string {
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
}

/** «1 servicio», «2 servicios». */
export function contar(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Huella de una variable para las exclusiones. */
export function claveDe(c: Clave): string {
  return `${c.ambito}\u0000${c.serviceId ?? ''}\u0000${c.key}`;
}

const NOMBRE_PROVEEDOR: Record<ProveedorAviso, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  twilio: 'Twilio',
  stripe: 'Stripe',
  webhook: 'webhooks',
};

/** «a», «a y b», «a, b y c». */
export function enumerar(lista: readonly string[]): string {
  if (lista.length <= 1) return lista[0] ?? '';
  return `${lista.slice(0, -1).join(', ')} y ${lista[lista.length - 1]}`;
}

/**
 * Aviso de un servicio con webhooks en nombres que redirigen. Telegram y
 * Stripe documentan que una redirección es un fallo; del resto no consta, así
 * que se dice con prudencia. `pasada`: el cambio ya ha pasado y el nombre
 * anterior sigue redirigiendo.
 */
export function textoWebhook(w: WebhookEnRiesgo, pasada = false): string {
  const concretos = w.proveedores.filter((p) => p !== 'webhook').map((p) => NOMBRE_PROVEEDOR[p]);
  const hosts = enumerar(w.hosts.map((h) => h.from));
  const uso = concretos.length > 0 ? `«${w.serviceName}» usa ${enumerar(concretos)} y recibe sus webhooks en ${hosts}.` : `«${w.serviceName}» recibe webhooks en ${hosts}.`;
  const estrictos = w.proveedores.filter((p) => p === 'telegram' || p === 'stripe').map((p) => NOMBRE_PROVEEDOR[p]);
  const efecto = pasada ? 'ya no le llega' : 'dejará de recibir al pasar';
  const riesgo =
    estrictos.length > 0
      ? `${enumerar(estrictos)} no ${estrictos.length === 1 ? 'sigue' : 'siguen'} redirecciones: si el webhook se registró con la URL anterior, ${efecto}.`
      : `Si el webhook se registró con la URL anterior, ${pasada ? 'puede que ya no le llegue' : 'puede dejar de recibir al pasar'}.`;
  const salida = pasada
    ? 'Vuelve a registrarlo con la URL nueva, o sirve también el nombre anterior.'
    : 'Vuelve a registrarlo con la URL nueva después de pasar, o sirve también el nombre anterior.';
  return `${uso} ${riesgo} ${salida}`;
}
