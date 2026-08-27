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
  /**
   * Instalación de la GitHub App con la que clonar (fila de
   * `github_installations`, no el número de instalación de GitHub). Tiene
   * prioridad sobre `connectorId`. Ausente y sin conector, Skyway busca una
   * instalación que ya vea la cuenta del repo antes de caer al token global.
   */
  githubInstallationId?: string | null;
  rootDir?: string;
  dockerfilePath?: string;
  /**
   * Constructor elegido a mano para este servicio. Ausente o `'auto'` = lo
   * decide Skyway (lo que declare la config-as-code del repositorio y, si no
   * dice nada, Dockerfile si lo hay y Nixpacks si no). Elegirlo aquí manda
   * sobre el fichero del repositorio: es la forma de tener un repo que sirve
   * para las dos cosas —Docker y Railway— y decidir en Skyway con cuál va.
   */
  builder?: 'auto' | 'dockerfile' | 'nixpacks';
  startCmd?: string;
  /**
   * Comando de compilación cuando se construye con Nixpacks (sin Dockerfile).
   * Es el equivalente al «Build Command» del panel de Railway, y el importador
   * lo copia de allí. Con Dockerfile no aplica: manda el Dockerfile.
   */
  buildCmd?: string;
  port: number;
  /**
   * El puerto de arriba lo puso Skyway por defecto: nadie lo eligió. Mientras
   * siga en `true` —y solo hasta el primer despliegue correcto— el desplegador
   * puede corregirlo con el EXPOSE de la imagen. Ausente significa que lo
   * eligió una persona, o que el servicio es anterior a esto: no se toca jamás.
   */
  portAuto?: boolean;
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
  /** Pila de aplicaciones de la que salió este servicio (clave de STACKS). */
  stack?: string;
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
  /**
   * Marca con la que el panel pinta el servicio. La rellenan las pilas de
   * aplicaciones, donde adivinar por el nombre de la imagen no vale
   * (`postgrest/postgrest` no es PostgreSQL, `kong/kong` no es genérico).
   */
  icon?: string;
  /** Pila de aplicaciones de la que salió este servicio (clave de STACKS). */
  stack?: string;
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
  runtime_logs?: string | null;
  error: string | null;
  diagnosis: string | null;
  /**
   * Huella de las entradas de compilación (repo, rootDir, Dockerfile,
   * buildArgs). Un despliegue posterior del MISMO commit con la misma huella
   * puede reutilizar la imagen en vez de clonar y compilar otra vez.
   */
  build_key: string | null;
  /** Config-as-code de Railway del repo en ese commit (JSON), para no perderla al reutilizar. */
  repo_config: string | null;
  /**
   * Digest por variable de las que llegaron al build (JSON `{NOMBRE: hash}`).
   * Con Dockerfile, cuáles llegan depende de los `ARG` del repo y no se sabe sin
   * clonar; con esto se puede comprobar al reutilizar que ninguna ha cambiado.
   * Opcional: las consultas que no lo necesitan no lo seleccionan.
   */
  build_vars?: string | null;
  /** 1 = reconstruir sin reutilizar imagen, aunque el commit ya esté construido. */
  force_build: number;
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
  /** Descuento comercial (%) aplicado a las facturas de las cuentas de este plan. */
  discount_pct: number;
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
  /** País del cliente en ISO 3166-1 alfa-2. «ES» por defecto. */
  billing_country: string;
  /** Día del mes (1–28) en que renueva el ciclo de facturación. */
  billing_day: number;
  /** Descuento comercial (%) de la cuenta; null = hereda el del plan. */
  discount_pct: number | null;
  /**
   * Fecha de contratación del plan actual. Ancla el aniversario de las cuotas
   * ANUALES: una cuota anual solo se devenga en el ciclo que la contiene. Null en
   * cuentas anteriores a esta columna; entonces se usa `created_at`.
   */
  plan_since: number | null;
  /**
   * Fin del último periodo facturado: el ancla desde la que arranca el siguiente.
   * Sustituye a derivar el ciclo de `billing_day`, que refacturaba el tramo
   * solapado al cambiar el día y perdía el ciclo si el servidor estaba caído justo
   * el día de cierre. Null en cuentas anteriores a la columna.
   */
  last_billed_period_end: number | null;
  /** Etapa de morosidad alcanzada: 0 al corriente, 1 aviso, 2 suspensión, 3 cancelación. */
  dunning_stage: number;
  /** Momento en que empezó la mora actual. */
  dunning_since: number | null;
  /** Última acción de morosidad ejecutada (para trazar el avance de etapas). */
  last_dunning_action_at: number | null;
  /** Cuenta exenta del corte automático por impago (clientes de trato especial). */
  dunning_exempt: number;
  /** Servicio de IA cortado por impago. */
  ai_suspended: number;
  notes: string | null;
  created_at: number;
}

/**
 * Tramo del historial de plan de una cuenta: qué plan tuvo y entre qué fechas.
 * `to_ms` en null es el tramo VIGENTE. La tarifa se congela al abrirlo para poder
 * facturar el histórico aunque el plan desaparezca del catálogo; mientras el plan
 * exista, manda su ficha viva.
 */
export interface PlanPeriodRow {
  id: string;
  workspace_id: string;
  /** Plan del tramo. Null = la cuenta estuvo sin plan en ese intervalo. */
  plan_id: string | null;
  plan_name: string | null;
  price_cents: number | null;
  currency: string | null;
  interval: string | null;
  from_ms: number;
  to_ms: number | null;
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
  /**
   * Tipo de retención de IRPF (%) de esta línea. Permite facturas que mezclan
   * conceptos sujetos a retención (servicios profesionales) con otros que no
   * (hosting, licencias). Si falta (líneas antiguas), se usa el tipo por defecto
   * de la factura al recomputar.
   */
  irpfRate?: number;
  /** Tipo de recargo de equivalencia (%) de la línea, cuando aplica. */
  reRate?: number;
  /**
   * Cargo puntual del que nace la línea. Es el vínculo que permite devolver el
   * cargo a «pendiente» si se elimina su línea del borrador: sin él, quitar la
   * línea dejaba el cargo marcado como facturado en una factura que ya no lo
   * contiene, y no volvía a facturarse nunca.
   */
  chargeId?: string;
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
  /** País del destinatario (ISO alfa-2) congelado al emitir. */
  client_country: string | null;
  /**
   * Quién la creó: 'cycle' la generó la facturación del ciclo (su borrador es
   * sustituible por el definitivo), 'manual' la escribió el operador (intocable).
   */
  origin: 'cycle' | 'manual';
  /**
   * Vencimiento congelado al emitir (expedición + condiciones de pago de ese
   * momento). Null en facturas anteriores a la columna: entonces se recalcula con
   * el perfil vivo, como antes.
   */
  due_at: number | null;
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

// ---------- facturación multimodular: catálogo, suscripciones y uso ----------

/** Categoría de un producto/servicio facturable. */
export type ProductCategory = 'web' | 'ia' | 'app' | 'hosting' | 'bbdd' | 'dominio' | 'soporte' | 'custom';

/** Modelo de precio de un producto del catálogo. */
export type BillingModel = 'flat_one_off' | 'subscription' | 'metered' | 'tiered';

/**
 * Medidor de uso. Los de infraestructura salen de `service_metrics_hourly`
 * (ya capturado); los lógicos/IA de `usage_meter_hourly` (ingesta por API).
 */
export type UsageMeter =
  | 'cpu_core_hour'
  | 'mem_gb_hour'
  | 'ai_tokens_in'
  | 'ai_tokens_cache_in'
  | 'ai_tokens_out'
  | 'ai_requests'
  | 'ai_bytes'
  | 'unit';

/** Producto/servicio facturable del catálogo (paralelo a `plans`). */
export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  category: ProductCategory;
  billing_model: BillingModel;
  /** Precio unitario (céntimos) para flat/subscription/metered sin tramos. */
  price_cents: number;
  currency: string;
  /** Periodicidad de la suscripción (monthly/yearly), o one_off/metered. */
  interval: 'monthly' | 'yearly' | 'one_off' | 'metered';
  /** Unidad mostrada en la factura (p. ej. «mes», «1M tokens», «hora»). */
  unit: string;
  /** Nº de unidades del medidor por unidad de precio (p. ej. 1000000 → precio por 1M tokens). */
  unit_size: number;
  /** Medidor que tarifa el producto (solo billing_model='metered'/'tiered'). */
  meter: UsageMeter | null;
  /** Cómo se evalúan los tramos (billing_model='tiered'). */
  tier_mode: 'graduated' | 'volume' | null;
  tax_rate: number;
  irpf_rate: number;
  tax_exempt: number;
  /** Módulos que concede al contratarse (JSON array). */
  modules: string;
  description: string | null;
  active: number;
  archived: number;
  created_at: number;
}

/** Tramo de precio para productos con billing_model='tiered'. */
export interface PriceTierRow {
  id: string;
  product_id: string;
  /** Límite superior del tramo (unidades); null = último tramo (sin tope). */
  up_to: number | null;
  unit_cents: number;
  flat_cents: number;
  sort: number;
  created_at: number;
}

/** Suscripción/add-on recurrente de un workspace a un producto del catálogo. */
export interface SubscriptionRow {
  id: string;
  workspace_id: string;
  product_id: string;
  /** Servicio concreto al que se liga el add-on (opcional). */
  service_id: string | null;
  qty: number;
  /** Precio congelado al contratar (céntimos); null = sigue el catálogo. */
  unit_cents: number | null;
  currency: string;
  interval: 'monthly' | 'yearly';
  status: 'active' | 'paused' | 'cancelled';
  anchor_day: number;
  started_at: number;
  cancelled_at: number | null;
  /**
   * Momento del último cambio de estado. Es lo que permite prorratear una baja:
   * el corte masivo por impago cambia el estado sin escribir `cancelled_at`.
   */
  status_changed_at: number | null;
  /** Quién la pausó/canceló: 'dunning' (impago) o 'manual' (el operador). */
  paused_by: 'dunning' | 'manual' | null;
  created_at: number;
}

/** Cargo puntual pendiente de incluir en la próxima factura del ciclo. */
export interface PendingChargeRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  label: string;
  kind: 'product' | 'custom';
  qty: number;
  unit_cents: number;
  tax_rate: number;
  irpf_rate: number;
  status: 'pending' | 'invoiced' | 'cancelled';
  invoice_id: string | null;
  created_at: number;
}

/**
 * Clave de API por cuenta que abre EXCLUSIVAMENTE el proxy de IA (nunca el
 * panel). Se guarda hasheada; el secreto (`skai_…`) solo se muestra al crearla.
 * El prefijo NO empieza por `sky_` para que jamás se resuelva como token de panel.
 */
export interface WorkspaceApiKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  key_hash: string;
  prefix: string;
  provider: string;
  /** Modelos permitidos (JSON array); [] = todos los del allowlist global del operador. */
  allowed_models: string;
  status: 'active' | 'suspended' | 'revoked';
  /** Quién la suspendió: 'dunning' (impago) o 'manual' (el operador). */
  suspended_by?: 'dunning' | 'manual' | null;
  /** Presupuesto mensual (céntimos); null = sin tope. Se aplica en la fase de límites. */
  budget_cents_month: number | null;
  /** Gasto acumulado del ciclo (contador cacheado; la verdad está en usage_meter_hourly). */
  spend_cents_cycle: number;
  cycle_anchor: number | null;
  rate_limit_rpm: number | null;
  last_used_at: number | null;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  revoked_at: number | null;
}

/** Coste del operador por modelo (micro-céntimos por millón de tokens). Para el margen. */
export interface AiModelPriceRow {
  model: string;
  cost_micros_in: number;
  cost_micros_cache: number;
  cost_micros_out: number;
  /** Margen objetivo sobre venta (%); guía el PVP sugerido = coste/(1−m/100). */
  margin_pct: number;
  currency: string;
  /** `auto` = lo mantiene la sincronización con la tarifa de Google; `manual` = lo fijó el operador y no se pisa. */
  source: 'auto' | 'manual';
  /** Última vez que la sincronización escribió este coste (null si nunca). */
  synced_at: number | null;
  updated_at: number;
}

/** Evento crudo de consumo (ingesta idempotente); alimenta `usage_meter_hourly`. */
export interface UsageEventRow {
  id: string;
  idempotency_key: string;
  subject_type: 'workspace' | 'service';
  subject_id: string;
  meter: string;
  quantity: number;
  product_id: string | null;
  ts: number;
  metadata: string | null;
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

/**
 * Instalación de la GitHub App sobre una cuenta u organización. A diferencia
 * del conector con token personal, aquí NO se guarda ninguna credencial: el
 * token de clonado se emite bajo demanda y caduca en una hora, así que lo único
 * persistente es el número de instalación.
 *
 * `project_id` null = instalación global del administrador, visible desde todos
 * los proyectos. Con proyecto, solo desde ese (mismo modelo que los conectores).
 */
export interface GithubInstallationRow {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  /** 'all' o 'selected': si la App ve toda la cuenta o solo los repos elegidos. */
  repo_selection: string;
  project_id: string | null;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  /** 1 si GitHub la tiene suspendida (la App sigue instalada pero sin acceso). */
  suspended: number;
}
