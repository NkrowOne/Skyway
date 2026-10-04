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
  buzones: { id: string; de: string; a: string; usadoPorApps: string[] }[];
  alias: { id: string; de: string; a: string }[];
  formularios: { id: string; name: string; origenesNuevos: string[] }[];
  webmail: { viejo: string | null; nuevo: string | null };
  avisos: { code: string; mensaje: string }[];
  bloqueos: { code: string; mensaje: string }[];
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
  servicios: { serviceId: string; nombre: string; reinicio: boolean }[];
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
    lista: { id: string; email: string; login: string; pendiente: boolean; usadoPorApps: string[] }[];
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
  alPasar: { serviceId: string; nombre: string; reinicio: boolean }[] | null;
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
  pasar: (projectId: string, mid: string, expect: string) => api.post<MigracionSkyway>(`${base(projectId)}/${mid}/switch`, { expect }),
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
