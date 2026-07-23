export type ServiceType = 'git' | 'database' | 'image';

export interface VolumeMount {
  name: string;
  containerPath: string;
}

export interface GitConfig {
  repoUrl: string;
  branch: string;
  /** Conector de GitHub del proyecto con cuyo token se clona (null/ausente = token global). */
  connectorId?: string | null;
  rootDir?: string;
  dockerfilePath?: string;
  startCmd?: string;
  port: number;
  buildArgs?: Record<string, string>;
  domains: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  /** Cuota de disco orientativa en MB (volúmenes + capa de escritura): al superarla salta una alerta. */
  diskMb?: number | null;
  webhookSecret: string;
  volumes?: VolumeMount[];
  healthcheckPath?: string | null;
  replicas?: number;
  /**
   * Auto-desplegar al detectar un commit nuevo en la rama (sondeo periódico de
   * `git ls-remote`, sin webhook ni URL pública). `false` lo desactiva; ausente
   * = activado. La primera comprobación fija la línea base y no despliega: solo
   * disparan los commits posteriores.
   */
  autoDeploy?: boolean;
}

export interface DatabaseConfig {
  template: string;
  version: string;
  domains?: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  diskMb?: number | null;
  backupSchedule?: 'daily' | 'weekly' | null;
  backupRetention?: number;
}

export interface ImageConfig {
  image: string;
  port?: number | null;
  startCmd?: string;
  domains: string[];
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  diskMb?: number | null;
  volumes?: VolumeMount[];
  healthcheckPath?: string | null;
  replicas?: number;
}

export type ServiceConfig = GitConfig | DatabaseConfig | ImageConfig;

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  /**
   * Nombre del cliente, denormalizado desde el workspace para conservar la
   * agrupación por empresa de la UI existente. Es un reflejo de
   * `workspaces.name` (o null si el proyecto no está asignado a un workspace):
   * el origen de verdad es `workspace_id`.
   */
  client: string | null;
  /** Workspace (cuenta de cliente) al que pertenece el proyecto. null = sin asignar. */
  workspace_id: string | null;
  created_at: number;
  /** Página de estado pública: token de la URL compartible y si está activa. */
  status_token: string | null;
  status_enabled: number;
  /** Aviso de mantenimiento visible en la página de estado (null = sin aviso). */
  status_notice: string | null;
}

export interface ServiceRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  type: ServiceType;
  config: ServiceConfig;
  created_at: number;
}

export type DeploymentStatus =
  | 'queued'
  | 'building'
  | 'deploying'
  | 'success'
  | 'failed'
  | 'canceled';

export interface Diagnosis {
  id: string;
  title: string;
  cause: string;
  fix: string;
}

export interface DeploymentRow {
  id: string;
  service_id: string;
  status: DeploymentStatus;
  trigger: string;
  commit_sha: string | null;
  commit_msg: string | null;
  image_tag: string | null;
  logs: string;
  error: string | null;
  diagnosis: string | null;
  created_at: number;
  finished_at: number | null;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertRow {
  id: string;
  ts: number;
  severity: AlertSeverity;
  type: string;
  project_id: string | null;
  service_id: string | null;
  title: string;
  message: string;
  explanation: string | null;
  dedupe_key: string | null;
  resolved_at: number | null;
  read_at: number | null;
}

export interface AuditRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  ip: string | null;
}

export interface SecurityFinding {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  fix: string;
  projectId?: string;
  projectName?: string;
  serviceId?: string;
  serviceName?: string;
}

export type ContainerState =
  | 'running'
  | 'restarting'
  | 'exited'
  | 'paused'
  | 'created'
  | 'removing'
  | 'dead'
  | 'not_created'
  | 'unknown';

export interface ServiceRuntime {
  state: ContainerState;
  startedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  image: string | null;
}

export interface ServiceStats {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

/** Muestra puntual del consumo de un servicio (agregada de sus réplicas). */
export interface ServiceMetricSample {
  /** % de CPU en la convención de Docker: 100 = un núcleo completo. */
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  /** Bytes transferidos DESDE la muestra anterior (no acumulado): permite sumar por hora. */
  netRxDelta: number;
  netTxDelta: number;
}

/** Fila horaria del histórico de un servicio (sumas para medias + máximos para picos). */
export interface ServiceMetricHour {
  hour: number;
  samples: number;
  cpu_sum: number;
  cpu_max: number;
  mem_sum: number;
  mem_max: number;
  mem_limit_last: number;
  net_rx: number;
  net_tx: number;
  disk_last: number | null;
}

/** Fila horaria del histórico del host. */
export interface HostMetricHour {
  hour: number;
  samples: number;
  load_sum: number;
  load_max: number;
  mem_used_sum: number;
  mem_used_max: number;
  mem_total_last: number;
  disk_used_last: number | null;
  disk_total_last: number | null;
}

/**
 * Roles del sistema:
 * - `admin`: administrador de plataforma; controla todo el servidor y todos los
 *   workspaces. Sin workspace propio.
 * - `owner`: propietario/administrador de un workspace de cliente. Gestiona los
 *   proyectos de SU workspace, crea sub-usuarios en él, acota sus módulos y
 *   consulta su facturación. No toca ajustes del servidor ni otros workspaces.
 * - `member`: sub-usuario con acceso a proyectos concretos dentro de un workspace.
 */
export type UserRole = 'admin' | 'owner' | 'member';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  session_epoch: number;
  created_at: number;
  /** Workspace al que pertenece el usuario (owner/member). null en administradores. */
  workspace_id: string | null;
}

// ---------- cuentas de cliente: planes, workspaces y facturación ----------

export type BillingInterval = 'monthly' | 'yearly';

/**
 * Plan de facturación reutilizable: define los usos incluidos (cuotas y módulos)
 * y el precio. Un workspace hereda del plan salvo que se le fijen valores a
 * medida (override) — de ahí «usos incluidos, o totalmente personalizable».
 */
export interface PlanRow {
  id: string;
  name: string;
  slug: string;
  price_cents: number;
  currency: string;
  interval: BillingInterval;
  /** Cuotas incluidas (agregadas a TODOS los proyectos del workspace). */
  cpu_cores: number;
  memory_mb: number;
  disk_mb: number;
  max_projects: number;
  max_services: number;
  max_members: number;
  /** Claves de módulo incluidas (JSON array de ModuleKey). */
  modules: string;
  /** Plan aplicado por defecto a los workspaces nuevos (solo uno lo lleva). */
  is_default: number;
  /** Archivado: no se ofrece para nuevos workspaces pero sigue válido para los que ya lo tienen. */
  archived: number;
  created_at: number;
}

export type WorkspaceStatus = 'active' | 'suspended';

/**
 * Workspace = cuenta de un cliente. Sus proyectos comparten una cuota agregada
 * de recursos. Los campos de cuota en null heredan del plan; fijados, lo
 * sobrescriben (a medida). `modules_override` es la concesión del admin; sobre
 * ella, `owner_disabled_modules` es lo que el propietario acota para sí.
 */
export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  plan_id: string | null;
  cpu_cores: number | null;
  memory_mb: number | null;
  disk_mb: number | null;
  max_projects: number | null;
  max_services: number | null;
  max_members: number | null;
  /** Concesión de módulos del admin (JSON array). null = hereda los del plan. */
  modules_override: string | null;
  /** Módulos que el propietario ha desactivado para su workspace (JSON array). */
  owner_disabled_modules: string;
  status: WorkspaceStatus;
  billing_email: string | null;
  /** NIF/CIF del cliente (destinatario de la factura). */
  billing_tax_id: string | null;
  /** Domicilio fiscal del cliente (destinatario de la factura). */
  billing_address: string | null;
  /** Día del mes (1–28) en que renueva el ciclo de facturación. */
  billing_day: number;
  notes: string | null;
  created_at: number;
}

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';

/** Método de cobro de una factura. */
export type PaymentMethod = 'bank_transfer' | 'stripe' | 'card' | 'cash' | 'other';

/** Tipo de factura según la normativa española (RD 1619/2012). */
export type InvoiceType = 'normal' | 'simplificada' | 'rectificativa';

/**
 * Régimen de IVA de la operación. Determina si se repercute IVA o va exento/con
 * inversión del sujeto pasivo, y qué mención legal debe constar en la factura.
 */
export type VatRegime =
  | 'general'
  | 'exento_intracom_art25'
  | 'exento_export_art21'
  | 'inversion_sujeto_pasivo'
  | 'recargo_equivalencia'
  | 'exento_otros'
  | 'no_sujeto';

export interface InvoiceLine {
  label: string;
  kind: 'plan' | 'usage' | 'custom' | 'product' | 'subscription' | 'discount';
  qty: number;
  unitCents: number;
  amountCents: number;
  /**
   * Tipo de IVA (%) aplicado a esta línea. Permite facturas con varios tipos
   * (21/10/4/0). Si falta (líneas antiguas), se usa el tipo por defecto de la
   * factura al recomputar.
   */
  taxRate?: number;
  /** Tipo de recargo de equivalencia (%) de la línea, cuando aplica. */
  reRate?: number;
}

/** Desglose de bases y cuotas por tipo impositivo (obligatorio si concurren varios tipos). */
export interface TaxBreakdownEntry {
  /** Tipo de IVA (%) de este grupo. */
  rate: number;
  /** Base imponible (céntimos) sumada de las líneas de este tipo. */
  base_cents: number;
  /** Cuota de IVA (céntimos), redondeada UNA vez sobre la base del tipo. */
  quota_cents: number;
  /** Tipo de recargo de equivalencia (%) del grupo, si aplica. */
  re_rate?: number;
  /** Cuota de recargo de equivalencia (céntimos), si aplica. */
  re_cents?: number;
}

export interface InvoiceRow {
  id: string;
  workspace_id: string;
  /** Serie de numeración a la que pertenece (FK invoice_series). null en borradores. */
  series_id: string | null;
  /** Número de factura, asignado al emitir (p. ej. «FRA-0001»). null en borradores. */
  number: string | null;
  /** Tipo de factura (normal/simplificada/rectificativa). */
  invoice_type: InvoiceType;
  /** Factura original que esta rectifica (solo si invoice_type='rectificativa'). */
  rectifies_invoice_id: string | null;
  /** Motivo de la rectificación. */
  rectify_reason: string | null;
  period_start: number;
  period_end: number;
  /** Fecha de la operación si difiere de la de expedición (issued_at). */
  operation_date: number | null;
  status: InvoiceStatus;
  currency: string;
  subtotal_cents: number;
  /** Impuesto (IVA) total: suma de las cuotas del desglose. */
  tax_cents: number;
  /** Tipo de IVA por defecto de la factura (para líneas sin tipo propio). */
  tax_rate: number;
  /** Desglose de bases y cuotas por tipo (JSON TaxBreakdownEntry[]). */
  tax_breakdown: string;
  /** Régimen de IVA de la operación. */
  vat_regime: VatRegime;
  /** Menciones legales derivadas del régimen (exención, inversión del sujeto pasivo…). */
  legal_mentions: string | null;
  /** Tipo de retención de IRPF (%), 0 = sin retención. */
  irpf_rate: number;
  /** Cuota de IRPF retenida (céntimos), se resta del total. */
  irpf_cents: number;
  total_cents: number;
  /** Líneas de la factura (JSON InvoiceLine[]). */
  lines: string;
  /** Nombre del plan en el momento de emitir (histórico). */
  plan_name: string | null;
  /** Datos fiscales del emisor congelados al emitir (JSON IssuerSnapshot). */
  issuer_snapshot: string | null;
  /** Nombre del destinatario congelado al emitir. */
  client_name: string | null;
  /** NIF del destinatario congelado al emitir. */
  client_tax_id: string | null;
  /** Domicilio del destinatario congelado al emitir. */
  client_address: string | null;
  /** Método de cobro elegido/registrado. */
  payment_method: PaymentMethod | null;
  stripe_session_id: string | null;
  stripe_url: string | null;
  issued_at: number | null;
  paid_at: number | null;
  /** 1 una vez emitida: la factura es inmutable (solo se corrige con rectificativa). */
  locked: number;
  notes: string | null;
  created_at: number;
}

/**
 * Serie de numeración correlativa por ejercicio (sustituye el contador global).
 * Las rectificativas usan obligatoriamente una serie propia (kind='rectificativa').
 */
export interface InvoiceSeriesRow {
  id: string;
  /** Código corto de la serie (p. ej. «FRA», «REC»). */
  code: string;
  /** Ejercicio fiscal; la numeración reinicia por año. */
  year: number;
  prefix: string;
  padding: number;
  /** Siguiente número correlativo a asignar. */
  next_seq: number;
  kind: 'ordinaria' | 'rectificativa' | 'simplificada';
  created_at: number;
}

/** Datos fiscales del emisor congelados en la factura al emitir. */
export interface IssuerSnapshot {
  companyName: string;
  taxId: string;
  address: string;
  email: string;
  phone: string;
}

/**
 * Perfil fiscal de la empresa que emite las facturas (nosotros). Se guarda como
 * JSON en `settings`. Las claves de Stripe se almacenan aparte y enmascaradas.
 */
export interface BillingProfile {
  companyName: string;
  taxId: string;
  address: string;
  email: string;
  phone: string;
  currency: string;
  /** Tipo de IVA por defecto (%), 0 = sin impuesto. */
  vatRate: number;
  invoicePrefix: string;
  paymentTermsDays: number;
  /** Tipo de retención de IRPF (%) por defecto, 0 = no se aplica retención. */
  defaultIrpfRate: number;
  /**
   * Modo del sistema de facturación de cara a Verifactu: `verifactu` (con
   * remisión a la AEAT) o `no_verifactu` (con firma y conservación local).
   */
  sifMode: 'verifactu' | 'no_verifactu';
  /** Datos para transferencia bancaria. */
  iban: string;
  bic: string;
  bankName: string;
  /** Pie de página de la factura (condiciones, agradecimiento…). */
  footer: string;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string; // base64url
  public_key: string; // base64url
  counter: number;
  transports: string | null; // JSON array
  device_type: string | null;
  backed_up: number;
  rp_id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string; // sha256 hex del token completo
  prefix: string; // primeros caracteres, para identificarlo en la UI
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/**
 * Conector de GitHub ligado a un proyecto: un cliente conecta su propio token
 * para desplegar sus repos privados sin depender del token global del admin.
 * El token se necesita en claro para clonar; jamás se devuelve por la API.
 */
export interface GithubConnectorRow {
  id: string;
  project_id: string;
  name: string;
  token: string;
  gh_login: string;
  token_type: string;
  created_by: string; // email de quien lo conectó (auditoría y control del admin)
  created_at: number;
  last_used_at: number | null;
}
