export type UserRole = 'admin' | 'owner' | 'member';

export interface Me {
  needsSetup: boolean;
  user: {
    id: string;
    email: string;
    role: UserRole;
    workspaceId?: string | null;
    workspaceName?: string | null;
  } | null;
}

export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
  created_at: number;
  workspaceId?: string | null;
  workspaceName?: string | null;
  projectIds: string[];
  passkeys: number;
  tokens: number;
}

export interface Passkey {
  id: string;
  name: string;
  rp_id: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: number;
  last_used_at: number | null;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/** Conector de GitHub de un proyecto: el token queda en el servidor, aquí solo metadatos. */
export interface GithubConnector {
  id: string;
  project_id: string;
  name: string;
  gh_login: string;
  token_type: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  project_name?: string; // solo en la vista global del admin
  project_client?: string | null;
}

/**
 * Instalación de la GitHub App sobre una cuenta u organización. No caduca y no
 * guarda credenciales: el token de clonado lo emite Skyway al desplegar.
 * `projectId` null = conexión global del administrador.
 */
export interface GithubInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  /** 'all' (toda la cuenta) o 'selected' (solo los repos elegidos en GitHub). */
  repoSelection: string;
  projectId: string | null;
  projectName: string | null;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
  suspended: boolean;
  manageUrl: string | null;
}

export interface GithubAppStatus {
  configured: boolean;
  canConfigure: boolean;
  app: { slug: string; name: string; htmlUrl: string } | null;
  webhookUrl: string;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  description: string | null;
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

export interface Runtime {
  state: ContainerState;
  startedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  image: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  client: string | null;
  workspace_id?: string | null;
  created_at: number;
  serviceCount?: number;
  lastDeployAt?: number | null;
  openAlerts?: number;
  /** Despliegues en marcha en el proyecto: la tarjeta anuncia la versión que sale. */
  activeDeploys?: number;
}

// ---------- cuentas de cliente: workspaces, planes, facturación ----------

export type WorkspaceStatus = 'active' | 'suspended';
export type BillingInterval = 'monthly' | 'yearly';

export interface EffectiveQuota {
  cpuCores: number;
  memoryMb: number;
  diskMb: number;
  maxProjects: number;
  maxServices: number;
  maxMembers: number;
}

export interface WorkspaceAllocation {
  cpuCores: number;
  memoryMb: number;
  diskMb: number;
  projects: number;
  services: number;
  members: number;
  unlimited: { cpu: number; memory: number; disk: number };
}

export interface WorkspaceModules {
  granted: string[];
  disabled: string[];
  effective: string[];
}

export interface WorkspacePlanRef {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  interval: BillingInterval;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  plan_id: string | null;
  billing_email: string | null;
  billing_tax_id: string | null;
  billing_address: string | null;
  /** País del cliente (ISO 3166-1 alfa-2). «ES» por defecto. */
  billing_country?: string;
  billing_day: number;
  /** Descuento comercial (%) de la cuenta; null = hereda el del plan. */
  discount_pct: number | null;
  /** Contratación del plan vigente: ancla del aniversario de las cuotas anuales. */
  plan_since?: number | null;
  /** Facturado hasta aquí: desde este instante arranca el próximo ciclo. */
  last_billed_period_end?: number | null;
  notes: string | null;
  /** Corte del proxy de IA por impago (0/1). */
  ai_suspended: number;
  /** Cuenta exenta del corte automático por impago. */
  dunning_exempt?: number;
  /** Etapa de morosidad: 0 al día · 1 vencida · 2 suspendida · 3 cancelada. */
  dunning_stage: number;
  created_at: number;
  plan: WorkspacePlanRef | null;
  quota: EffectiveQuota;
  allocation: WorkspaceAllocation;
  modules: WorkspaceModules;
  over: { cpu: boolean; memory: boolean; disk: boolean; projects: boolean; services: boolean; members: boolean };
  inheriting: {
    cpuCores: boolean;
    memoryMb: boolean;
    diskMb: boolean;
    maxProjects: boolean;
    maxServices: boolean;
    maxMembers: boolean;
    modules: boolean;
  };
}

export interface WorkspaceProject {
  id: string;
  name: string;
  slug: string;
  serviceCount: number;
  created_at: number;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  role: UserRole;
  created_at: number;
  projectIds: string[];
}

export interface WorkspaceUsage {
  days: number;
  cpuCoreHours: number;
  ramGbHours: number;
  cpuMaxCores: number;
  ramMaxGb: number;
  diskMaxGb: number;
}

export interface Plan {
  id: string;
  name: string;
  slug: string;
  price_cents: number;
  currency: string;
  interval: BillingInterval;
  cpu_cores: number;
  memory_mb: number;
  disk_mb: number;
  max_projects: number;
  max_services: number;
  max_members: number;
  modules: string[];
  is_default: boolean;
  archived: boolean;
  /** Descuento comercial (%) aplicado a las facturas de las cuentas de este plan. */
  discount_pct: number;
  created_at: number;
  inUse: number;
}

export type ModuleGroup = 'Cómputo' | 'Datos' | 'Red' | 'Operación';

export interface ModuleDef {
  key: string;
  label: string;
  description: string;
  group: ModuleGroup;
}

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';
export type PaymentMethod = 'bank_transfer' | 'stripe' | 'card' | 'cash' | 'other';
export type InvoiceType = 'normal' | 'simplificada' | 'rectificativa';
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
  taxRate?: number;
  /** Tipo de retención de IRPF (%) de la línea. */
  irpfRate?: number;
  /**
   * Cargo puntual del que nace la línea. Viaja de vuelta al editar: es lo que
   * permite al servidor devolver a «pendiente» el cargo cuya línea se elimina.
   */
  chargeId?: string;
}

export interface TaxBreakdownEntry {
  rate: number;
  base_cents: number;
  quota_cents: number;
  re_rate?: number;
  re_cents?: number;
}

export interface IssuerSnapshot {
  companyName: string;
  taxId: string;
  address: string;
  email: string;
  phone: string;
}

export interface Invoice {
  id: string;
  workspace_id: string;
  series_id: string | null;
  number: string | null;
  invoice_type: InvoiceType;
  rectifies_invoice_id: string | null;
  rectify_reason: string | null;
  period_start: number;
  period_end: number;
  operation_date: number | null;
  status: InvoiceStatus;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  tax_rate: number;
  tax_breakdown: TaxBreakdownEntry[];
  vat_regime: VatRegime;
  legal_mentions: string | null;
  irpf_rate: number;
  irpf_cents: number;
  total_cents: number;
  lines: InvoiceLine[];
  plan_name: string | null;
  issuer_snapshot: IssuerSnapshot | null;
  client_name: string | null;
  client_tax_id: string | null;
  client_address: string | null;
  client_country?: string | null;
  payment_method: PaymentMethod | null;
  stripe_url: string | null;
  issued_at: number | null;
  paid_at: number | null;
  locked: number;
  notes: string | null;
  created_at: number;
}

/** Perfil fiscal de la empresa emisora (nosotros). */
export interface BillingProfile {
  companyName: string;
  taxId: string;
  address: string;
  email: string;
  phone: string;
  currency: string;
  vatRate: number;
  invoicePrefix: string;
  paymentTermsDays: number;
  defaultIrpfRate: number;
  sifMode: 'verifactu' | 'no_verifactu';
  iban: string;
  bic: string;
  bankName: string;
  footer: string;
}

export interface InvoicesResponse {
  invoices: Invoice[];
  issuer: BillingProfile;
  client: { name: string; billing_email: string | null; billing_tax_id: string | null; billing_address: string | null; billing_country?: string };
  stripeEnabled: boolean;
}

// ---------- series de uso e insights ----------

export interface UsagePoint {
  t: number;
  cpuCoreHours: number;
  ramGbHours: number;
  diskGb: number;
  netBytes: number;
}

export interface UsageByProject {
  projectId: string;
  name: string;
  cpuCoreHours: number;
  ramGbHours: number;
}

export interface UsageSeries {
  days: number;
  bucketHours: number;
  series: UsagePoint[];
  byProject: UsageByProject[];
}

// ---------- contabilidad de empresa ----------

export interface AccountingTotals {
  invoiced: number;
  paid: number;
  pending: number;
  draft: number;
  void: number;
  count: number;
}

export interface RevenuePoint {
  t: number;
  invoiced: number;
  paid: number;
}

export interface AccountingSummary {
  /** Moneda de la empresa emisora: la de `totals` y la de la serie mensual. */
  currency: string;
  totals: AccountingTotals;
  /** Totales desglosados POR MONEDA (no se suman entre sí). */
  byCurrency?: (AccountingTotals & { currency: string })[];
  series: RevenuePoint[];
  byClient: { workspaceId: string; name: string; currency: string; invoiced: number; paid: number }[];
}

export interface AccountingInvoice {
  id: string;
  number: string | null;
  invoice_type: InvoiceType;
  workspace_id: string;
  workspace_name: string | null;
  client_tax_id: string | null;
  status: InvoiceStatus;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  irpf_cents: number;
  total_cents: number;
  payment_method: PaymentMethod | null;
  period_start: number;
  period_end: number;
  issued_at: number | null;
  paid_at: number | null;
}

export interface BillingProfileResponse {
  profile: BillingProfile;
  stripe: { hasSecretKey: boolean; hasWebhookSecret: boolean; publishableKey: string };
  /** Servidor de correo saliente. La contraseña nunca viaja: solo si la hay. */
  smtp: { configured: boolean; host: string; port: number; secure: boolean; user: string; from: string; fromName: string; hasPassword: boolean };
  invoiceSeq: number;
}

export interface BillingAutomation {
  autoGenerate: boolean;
  autoIssue: boolean;
  dunningGraceDays: number;
  dunningCancelDays: number;
  /** Enviar la factura en PDF al cliente al emitirla. Requiere SMTP configurado. */
  emailOnIssue: boolean;
}

// ---------- catálogo multimodular ----------

export type ProductCategory = 'web' | 'ia' | 'app' | 'hosting' | 'bbdd' | 'dominio' | 'soporte' | 'custom';
export type BillingModel = 'flat_one_off' | 'subscription' | 'metered' | 'tiered';
export type UsageMeter = 'cpu_core_hour' | 'mem_gb_hour' | 'ai_tokens_in' | 'ai_tokens_cache_in' | 'ai_tokens_out' | 'ai_requests' | 'ai_bytes' | 'unit';

export interface PriceTier {
  up_to: number | null;
  unit_cents: number;
  flat_cents: number;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  category: ProductCategory;
  billing_model: BillingModel;
  price_cents: number;
  currency: string;
  interval: 'monthly' | 'yearly' | 'one_off' | 'metered';
  unit: string;
  unit_size: number;
  meter: UsageMeter | null;
  tier_mode: 'graduated' | 'volume' | null;
  tax_rate: number;
  irpf_rate: number;
  tax_exempt: number;
  modules: string[];
  description: string | null;
  active: number;
  archived: number;
  in_use: boolean;
  tiers: PriceTier[];
  created_at: number;
}

export interface Subscription {
  id: string;
  workspace_id: string;
  product_id: string;
  product_name: string;
  category: ProductCategory;
  billing_model: BillingModel;
  meter: UsageMeter | null;
  unit: string;
  service_id: string | null;
  qty: number;
  unit_cents: number;
  frozen: boolean;
  currency: string;
  interval: 'monthly' | 'yearly';
  status: 'active' | 'paused' | 'cancelled';
  anchor_day: number;
  started_at: number;
  cancelled_at: number | null;
}

export interface PendingCharge {
  id: string;
  label: string;
  kind: 'product' | 'custom';
  qty: number;
  unit_cents: number;
  tax_rate: number;
  irpf_rate: number;
  status: 'pending' | 'invoiced' | 'cancelled';
  created_at: number;
}

export interface SubscriptionsResponse {
  subscriptions: Subscription[];
  charges: PendingCharge[];
}

// ---------- gateway de IA ----------

export interface WorkspaceApiKey {
  id: string;
  name: string;
  prefix: string;
  provider: string;
  status: 'active' | 'suspended' | 'revoked';
  allowed_models: string[];
  budget_cents_month: number | null;
  spend_cents_cycle: number;
  rate_limit_rpm: number | null;
  last_used_at: number | null;
  expires_at: number | null;
  created_at: number;
}

export interface WorkspaceKeysResponse {
  keys: WorkspaceApiKey[];
  geminiConfigured: boolean;
}

export interface AiGatewayConfig {
  hasGeminiKey: boolean;
  baseUrl: string;
  allowedModels: string[];
}

/** Coste del operador por modelo (céntimos por millón de tokens) y PVP de referencia. */
export interface AiModelCost {
  model: string;
  currency: string;
  /** Margen objetivo sobre venta (%); guía el PVP sugerido. */
  margin_pct: number;
  cost_cents_mtok_in: number;
  cost_cents_mtok_cache: number;
  cost_cents_mtok_out: number;
  /** PVP sugerido (céntimos/Mtok) = coste/(1−margen/100); null si margen 0. */
  pvp_cents_mtok_in: number | null;
  pvp_cents_mtok_cache: number | null;
  pvp_cents_mtok_out: number | null;
  /** `auto` = lo mantiene al día la tarifa de Google; `manual` = fijado por el operador. */
  source: 'auto' | 'manual';
  synced_at: number | null;
  updated_at: number;
}

/** Resultado del último pase de autoactualización de la tarifa. */
export interface AiPriceSync {
  ok: boolean;
  at: number;
  /** De dónde salió la tarifa: fuente propia, Google o el catálogo interno. */
  source: 'propia' | 'google' | 'catálogo';
  currency: string;
  fxRate: number | null;
  added: string[];
  updated: string[];
  unchanged: string[];
  manual: string[];
  missing: string[];
  discovered: string[];
  error: string | null;
}

/** Ajustes de la autoactualización + resultado del último pase. */
export interface AiPriceSyncState {
  auto: boolean;
  url: string | null;
  currency: string;
  fxRate: number | null;
  fxAt: number | null;
  defaultMarginPct: number;
  autoAllow: boolean;
  lastAt: number | null;
  last: AiPriceSync | null;
  catalogDate: string;
}

export interface AiModelPrices {
  models: AiModelCost[];
  sell_cents_mtok: { in: number | null; cache: number | null; out: number | null };
  sync: AiPriceSyncState;
  /** Tarifa de lista de Google conocida (USD por millón de tokens). */
  list_usd: Record<string, { in: number; cache: number; out: number }>;
}

export interface WorkspaceAlert {
  id: string;
  ts: number;
  severity: 'info' | 'warning' | 'serious' | 'critical';
  type: string;
  title: string;
  message: string;
  explanation: string | null;
}

export interface GitConfig {
  repoUrl: string;
  branch: string;
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
  diskMb?: number | null;
  webhookSecret: string;
  healthcheckPath?: string | null;
  replicas?: number;
  autoDeploy?: boolean;
}

export interface DatabaseConfig {
  template: string;
  version: string;
  hostPort?: number | null;
  cpus?: number | null;
  memoryMb?: number | null;
  diskMb?: number | null;
  backupSchedule?: 'daily' | 'weekly' | null;
  backupRetention?: number;
}

export interface Service {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  type: 'git' | 'database' | 'image';
  config: GitConfig & DatabaseConfig & { image?: string; icon?: string; stack?: string };
  created_at: number;
  runtime?: Runtime;
}

export type DeploymentStatus = 'queued' | 'building' | 'deploying' | 'success' | 'failed' | 'canceled';

export interface Diagnosis {
  id: string;
  title: string;
  cause: string;
  fix: string;
}

export interface Deployment {
  id: string;
  service_id: string;
  status: DeploymentStatus;
  trigger: string;
  commit_sha: string | null;
  commit_msg: string | null;
  image_tag: string | null;
  logs?: string;
  error: string | null;
  diagnosis: string | null;
  created_at: number;
  finished_at: number | null;
}

/**
 * Despliegue vivo tal y como lo anuncia el feed del proyecto: la carga inicial
 * de /projects/:id y el stream /projects/:id/deploys/stream usan esta forma, de
 * modo que la rejilla sabe qué servicio tiene una versión nueva saliendo sin
 * abrir el panel de nadie.
 */
export interface ActiveDeploy {
  id: string;
  serviceId: string;
  projectId: string;
  status: DeploymentStatus;
  trigger: string;
  commitSha: string | null;
  commitMsg: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  ts: number;
  severity: AlertSeverity;
  type: string;
  project_id: string | null;
  service_id: string | null;
  title: string;
  message: string;
  explanation: string | null;
  resolved_at: number | null;
  read_at: number | null;
}

export interface AuditEntry {
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

export interface SecurityReport {
  score: number;
  grade: string;
  findings: SecurityFinding[];
  failedLogins24h: number;
  jwtFromEnv: boolean;
}

export interface ServiceStats {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

export interface MetricsSnapshot {
  ts: number;
  docker: boolean;
  host?: {
    cpus: number;
    load: number;
    totalMem: number;
    freeMem: number;
  };
  services: Record<
    string,
    { state: ContainerState; stats: ServiceStats | null; replicas?: { running: number; total: number } }
  >;
}

// ---------- histórico de consumo ----------

/** Un punto (cubo) del histórico de consumo de un servicio. */
export interface ServiceMetricPoint {
  t: number;
  /** Muestras que respaldan el cubo (para ponderar la media del periodo). */
  samples: number;
  /** Media de CPU en el cubo (100 = un núcleo). null si el servicio no corría. */
  cpuAvg: number | null;
  cpuMax: number | null;
  memAvg: number | null;
  memMax: number | null;
  memLimit: number | null;
  netRx: number;
  netTx: number;
  disk: number | null;
}

export interface ServiceMetricHistory {
  hours: number;
  points: ServiceMetricPoint[];
}

/** Un punto (cubo) del histórico de consumo del host. */
export interface HostMetricPoint {
  t: number;
  loadAvg: number | null;
  loadMax: number | null;
  memUsedAvg: number | null;
  memUsedMax: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
}

export interface HostMetricHistory {
  hours: number;
  points: HostMetricPoint[];
}

export interface DbTemplate {
  key: string;
  label: string;
  description: string;
  image: string;
  defaultVersion: string;
  port: number;
}

/** Servicio de una pila de aplicaciones, tal y como lo describe el catálogo. */
export interface StackServiceInfo {
  key: string;
  description: string;
  icon: string;
  image: string;
  public: boolean;
}

/** Servicio de una plantilla de Railway, ya traducido a lo que Skyway crearía. */
export interface RailwayTemplateServicePlan {
  templateName: string;
  slug: string;
  kind: 'image' | 'git';
  image: string;
  port: number | null;
  public: boolean;
  stage: number;
  varCount: number;
  volumes: string[];
  notes: string[];
}

/** Vista previa de una plantilla pública del catálogo de Railway. */
export interface RailwayTemplatePlan {
  code: string;
  name: string;
  description: string | null;
  prefix: string;
  warnings: string[];
  services: RailwayTemplateServicePlan[];
}

/** Pila de aplicaciones: plantilla que despliega varios servicios a la vez. */
export interface Stack {
  key: string;
  label: string;
  description: string;
  icon: string;
  logos: string[];
  docsUrl: string;
  memoryHintMb: number;
  notes: string[];
  defaultPrefix: string;
  services: StackServiceInfo[];
}

export interface SystemInfo {
  version: string;
  docker: boolean;
  nixpacks: boolean;
  host: {
    platform: string;
    arch: string;
    cpus: number;
    totalMem: number;
    freeMem: number;
    load: number[];
    uptime: number;
  };
  disk: { total: number; free: number } | null;
  dataDir: string;
}

export interface DockerUsage {
  images: { count: number; size: number };
  containers: { count: number; size: number };
  volumes: { count: number; size: number };
  buildCache: { size: number };
}

// ---------- monitor global ----------

export interface MonitorService {
  id: string;
  projectId: string;
  projectName: string;
  client: string | null;
  name: string;
  slug: string;
  type: 'git' | 'database' | 'image';
  template?: string;
  image?: string;
  domains: string[];
  state: ContainerState;
  startedAt: string | null;
  exitCode: number | null;
  exitExplanation: string | null;
  restartCount: number;
  replicas: { running: number; total: number };
  stats: { cpuPercent: number; memUsage: number; memLimit: number } | null;
  memoryMb: number | null;
  cpus: number | null;
  alerts: number;
  lastDeploy: { id: string; status: DeploymentStatus; created_at: number } | null;
  disk: { totalBytes: number | null; quotaMb: number | null };
  uptime24h: number | null;
}

export interface MonitorOverview {
  docker: boolean;
  host: {
    cpus: number;
    load: number;
    totalMem: number;
    freeMem: number;
    disk: { total: number; free: number } | null;
  };
  services: MonitorService[];
}

export interface LogSearchResult {
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
  replica: number | null;
  ts: number | null;
  line: string;
}

export interface DiskBreakdown {
  host: { total: number; free: number } | null;
  docker: DockerUsage | null;
  services: {
    serviceId: string;
    name: string;
    type: string;
    projectId: string;
    projectName: string;
    totalBytes: number;
    containerBytes: number;
    logBytes: number | null;
    volumes: { name: string; sizeBytes: number }[];
    quotaMb: number | null;
  }[];
}

// ---------- sitios web ----------

export interface WebsiteEntry {
  id: string;
  name: string;
  type: 'git' | 'image';
  image?: string;
  repoUrl?: string;
  projectId: string;
  projectName: string;
  client: string | null;
  domains: string[];
  hostPort: number | null;
  state: ContainerState;
  startedAt: string | null;
  replicas: { running: number; total: number };
  alerts: number;
  lastDeploy: { status: DeploymentStatus; created_at: number; finished_at: number | null } | null;
}

// ---------- consola de base de datos ----------

export interface DbObject {
  name: string;
  rows: number | null;
  sizeBytes: number | null;
}

export interface DbOverview {
  engine: 'postgres' | 'mysql' | 'mongo' | 'redis';
  version: string | null;
  sizeBytes: number | null;
  objectLabel: string;
  objects: DbObject[];
}

export interface DbSnippet {
  label: string;
  query: string;
  hint?: string;
}

export interface DbQueryResult {
  kind: 'table' | 'text';
  columns?: string[];
  rows?: string[][];
  raw?: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  notice?: string;
}

// ---------- explorador de archivos ----------

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  perms: string;
  target?: string;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

// ---------- página de estado pública ----------

export type PublicServiceState = 'operational' | 'degraded' | 'down' | 'unknown';

export interface StatusPageConfig {
  enabled: boolean;
  token: string | null;
  notice: string | null;
}

export interface PublicStatusService {
  name: string;
  type: string;
  state: PublicServiceState;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime90d: number | null;
  days: { date: number; pct: number | null }[];
}

export interface PublicStatus {
  project: { name: string; client: string | null };
  overall: PublicServiceState;
  notice: string | null;
  services: PublicStatusService[];
  incidents: {
    id: string;
    title: string;
    startedAt: number;
    resolvedAt: number | null;
    severity: AlertSeverity;
  }[];
  generatedAt: number;
}
