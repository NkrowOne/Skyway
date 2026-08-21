import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config';
import {
  AlertRow,
  AlertSeverity,
  ApiTokenRow,
  AuditRow,
  DeploymentRow,
  DeploymentStatus,
  GithubConnectorRow,
  GithubInstallationRow,
  HostMetricHour,
  InvoiceRow,
  InvoiceSeriesRow,
  PendingChargeRow,
  PriceTierRow,
  ProductRow,
  SubscriptionRow,
  PasskeyRow,
  PlanPeriodRow,
  PlanRow,
  ProjectRow,
  ServiceConfig,
  ServiceMetricHour,
  ServiceMetricSample,
  ServiceRow,
  ServiceType,
  UserRole,
  UserRow,
  AiModelPriceRow,
  WorkspaceApiKeyRow,
  WorkspaceRow,
} from './types';
import { DEFAULT_COUNTRY } from './countries';
import { ALL_MODULE_KEYS } from './modules';
import { id, now, slugify } from './util';

/**
 * Cuotas y módulos amplios para las cuentas creadas al migrar el campo antiguo
 * `client`: nunca deben quedar por debajo de lo que un cliente ya tenía en
 * marcha (si no, al activar las cuotas quedarían congelados). El admin las
 * ajusta después con un plan real.
 */
const MIGRATED_WORKSPACE_INIT = {
  cpu_cores: 32,
  memory_mb: 65536,
  disk_mb: 512000,
  max_projects: 100,
  max_services: 500,
  max_members: 25,
  modules_override: JSON.stringify(ALL_MODULE_KEYS),
  notes: 'Cuenta creada al migrar el campo «cliente». Revisa su plan y su cuota.',
} as const;

let db: Database.Database;

export function initDb(): void {
  db = new Database(path.join(config.dataDir, 'skyway.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      session_epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_projects (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      rp_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, slug)
    );
    CREATE TABLE IF NOT EXISTS env_vars (
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (service_id, key)
    );
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      commit_sha TEXT,
      commit_msg TEXT,
      image_tag TEXT,
      logs TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS project_vars (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (project_id, key)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      severity TEXT NOT NULL,
      type TEXT NOT NULL,
      project_id TEXT,
      service_id TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      explanation TEXT,
      dedupe_key TEXT,
      resolved_at INTEGER,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(dedupe_key) WHERE resolved_at IS NULL;
    -- Rutas calientes sin cubrir por los índices de arriba: el monitor resuelve
    -- alertas por service_id en cada refresco y el dashboard/estado cuentan las
    -- abiertas por project_id en cada render. Sin estos índices era un full-scan
    -- de una tabla que nunca se poda.
    CREATE INDEX IF NOT EXISTS idx_alerts_service_open ON alerts(service_id) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_alerts_project ON alerts(project_id);
  `);

  // Migraciones de columnas para bases de datos ya existentes.
  ensureColumn('projects', 'client', 'TEXT');
  ensureColumn('deployments', 'diagnosis', 'TEXT');
  // Huella de las entradas de compilación (repo, rootDir, Dockerfile, buildArgs):
  // permite reutilizar la imagen de un commit ya construido solo si se
  // construiría exactamente igual.
  ensureColumn('deployments', 'build_key', 'TEXT');
  // Config-as-code de Railway leída del repo en ese commit (JSON). Al reutilizar
  // la imagen no se clona, y sin esto el servicio arrancaría sin el comando de
  // arranque, el healthcheck ni la política de reinicio que declara el repo.
  ensureColumn('deployments', 'repo_config', 'TEXT');
  // 1 = el usuario pidió reconstruir sin reutilizar imagen.
  ensureColumn('deployments', 'force_build', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'admin'"); // los usuarios previos eran el dueño
  ensureColumn('users', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'status_token', 'TEXT');
  ensureColumn('projects', 'status_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'status_notice', 'TEXT');
  // Cuentas de cliente: enlace de proyectos y usuarios a su workspace.
  ensureColumn('projects', 'workspace_id', 'TEXT');
  ensureColumn('users', 'workspace_id', 'TEXT');

  // Histórico de disponibilidad agregado por horas (para las páginas de estado):
  // una fila por servicio y hora, con muestras totales y muestras "en marcha".
  db.exec(`
    CREATE TABLE IF NOT EXISTS uptime_hourly (
      service_id TEXT NOT NULL,
      hour INTEGER NOT NULL,
      up INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (service_id, hour)
    );
  `);

  // Histórico de consumo por servicio y hora: una fila por servicio y hora con
  // sumas (para medias) y máximos (para picos) de CPU/RAM, bytes de red del
  // periodo (delta, no acumulado) y la última foto de disco de esa hora. El
  // monitor lo alimenta cada 30 s; se conservan ~90 días y se podan a diario.
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_metrics_hourly (
      service_id TEXT NOT NULL,
      hour INTEGER NOT NULL,
      samples INTEGER NOT NULL DEFAULT 0,
      cpu_sum REAL NOT NULL DEFAULT 0,
      cpu_max REAL NOT NULL DEFAULT 0,
      mem_sum REAL NOT NULL DEFAULT 0,
      mem_max REAL NOT NULL DEFAULT 0,
      mem_limit_last REAL NOT NULL DEFAULT 0,
      net_rx REAL NOT NULL DEFAULT 0,
      net_tx REAL NOT NULL DEFAULT 0,
      disk_last REAL,
      PRIMARY KEY (service_id, hour)
    );
    CREATE TABLE IF NOT EXISTS host_metrics_hourly (
      hour INTEGER PRIMARY KEY,
      samples INTEGER NOT NULL DEFAULT 0,
      load_sum REAL NOT NULL DEFAULT 0,
      load_max REAL NOT NULL DEFAULT 0,
      mem_used_sum REAL NOT NULL DEFAULT 0,
      mem_used_max REAL NOT NULL DEFAULT 0,
      mem_total_last REAL NOT NULL DEFAULT 0,
      disk_used_last REAL,
      disk_total_last REAL
    );
  `);

  // Conectores de GitHub por proyecto: tokens de los clientes para clonar sus
  // repos. Caen en cascada con el proyecto.
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_connectors (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      gh_login TEXT NOT NULL,
      token_type TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_github_connectors_project ON github_connectors(project_id);
  `);

  // Instalaciones de la GitHub App. Aquí NO vive ninguna credencial: el token
  // de clonado se emite bajo demanda contra GitHub y caduca en una hora, así
  // que lo persistente es solo el número de instalación. project_id NULL =
  // instalación global del administrador, visible desde todos los proyectos.
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_installations (
      id TEXT PRIMARY KEY,
      installation_id INTEGER NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      repo_selection TEXT NOT NULL DEFAULT 'selected',
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      suspended INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_github_installations_project ON github_installations(project_id);
    CREATE INDEX IF NOT EXISTS idx_github_installations_number ON github_installations(installation_id);
  `);

  // ---------- cuentas de cliente: planes, workspaces y facturación ----------
  // Planes (usos incluidos + precio). Un workspace hereda del plan y puede
  // sobrescribir cualquier cuota a medida. workspaces.plan_id cae a NULL si se
  // borra el plan (el workspace conserva sus overrides o los valores por defecto).
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      interval TEXT NOT NULL DEFAULT 'monthly' CHECK (interval IN ('monthly', 'yearly')),
      cpu_cores REAL NOT NULL DEFAULT 1,
      memory_mb INTEGER NOT NULL DEFAULT 1024,
      disk_mb INTEGER NOT NULL DEFAULT 10240,
      max_projects INTEGER NOT NULL DEFAULT 3,
      max_services INTEGER NOT NULL DEFAULT 10,
      max_members INTEGER NOT NULL DEFAULT 3,
      modules TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      discount_pct REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
      cpu_cores REAL,
      memory_mb INTEGER,
      disk_mb INTEGER,
      max_projects INTEGER,
      max_services INTEGER,
      max_members INTEGER,
      modules_override TEXT,
      owner_disabled_modules TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      billing_email TEXT,
      billing_day INTEGER NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 28),
      notes TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_invoices (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
      currency TEXT NOT NULL DEFAULT 'EUR',
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      lines TEXT NOT NULL DEFAULT '[]',
      plan_name TEXT,
      issued_at INTEGER,
      paid_at INTEGER,
      notes TEXT,
      created_at INTEGER NOT NULL
    );
    -- Series de numeración correlativa por ejercicio (sustituyen el contador global).
    -- Las rectificativas usan obligatoriamente una serie propia (art. 6.1.a RD 1619/2012).
    CREATE TABLE IF NOT EXISTS invoice_series (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      year INTEGER NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      padding INTEGER NOT NULL DEFAULT 4,
      next_seq INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'ordinaria' CHECK (kind IN ('ordinaria', 'rectificativa', 'simplificada')),
      created_at INTEGER NOT NULL,
      UNIQUE (code, year)
    );
    -- Catálogo multimodular: productos facturables por categoría y modelo de precio.
    CREATE TABLE IF NOT EXISTS catalog_products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'custom' CHECK (category IN ('web','ia','app','hosting','bbdd','dominio','soporte','custom')),
      billing_model TEXT NOT NULL DEFAULT 'flat_one_off' CHECK (billing_model IN ('flat_one_off','subscription','metered','tiered')),
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      interval TEXT NOT NULL DEFAULT 'one_off' CHECK (interval IN ('monthly','yearly','one_off','metered')),
      unit TEXT NOT NULL DEFAULT '',
      unit_size INTEGER NOT NULL DEFAULT 1,
      meter TEXT,
      tier_mode TEXT CHECK (tier_mode IN ('graduated','volume')),
      tax_rate REAL NOT NULL DEFAULT 21,
      irpf_rate REAL NOT NULL DEFAULT 0,
      tax_exempt INTEGER NOT NULL DEFAULT 0,
      modules TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    -- Historial de plan por tramos: qué plan tuvo la cuenta y entre qué fechas.
    -- Sin él, cambiar de plan a mitad de mes facturaba el ciclo ENTERO al plan
    -- nuevo (o al viejo), nunca cada tramo a su precio. El precio y el nombre se
    -- congelan en el tramo para que el histórico siga siendo facturable aunque el
    -- plan se borre del catálogo; mientras el plan exista manda su ficha viva, que
    -- es el comportamiento que ya tenía editar una tarifa.
    CREATE TABLE IF NOT EXISTS workspace_plan_periods (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      plan_id TEXT,
      plan_name TEXT,
      price_cents INTEGER,
      currency TEXT,
      interval TEXT,
      from_ms INTEGER NOT NULL,
      to_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wpp_ws ON workspace_plan_periods(workspace_id, from_ms);
    CREATE TABLE IF NOT EXISTS catalog_price_tiers (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
      up_to INTEGER,
      unit_cents INTEGER NOT NULL DEFAULT 0,
      flat_cents INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    -- Suscripciones/add-ons recurrentes múltiples por workspace.
    CREATE TABLE IF NOT EXISTS workspace_subscriptions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
      service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
      qty REAL NOT NULL DEFAULT 1,
      unit_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'EUR',
      interval TEXT NOT NULL DEFAULT 'monthly' CHECK (interval IN ('monthly','yearly')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
      anchor_day INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL
    );
    -- Cargos puntuales pendientes de la próxima factura del ciclo.
    CREATE TABLE IF NOT EXISTS pending_charges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES catalog_products(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('product','custom')),
      qty REAL NOT NULL DEFAULT 1,
      unit_cents INTEGER NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 21,
      irpf_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','invoiced','cancelled')),
      invoice_id TEXT,
      created_at INTEGER NOT NULL
    );
    -- Ingesta cruda de consumo (idempotente) y su agregado horario para tarifar.
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      subject_type TEXT NOT NULL DEFAULT 'workspace' CHECK (subject_type IN ('workspace','service')),
      subject_id TEXT NOT NULL,
      meter TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      product_id TEXT,
      ts INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_meter_hourly (
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      meter TEXT NOT NULL,
      hour INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (subject_id, meter, hour)
    );
    -- Libro de facturación de Verifactu (RD 1007/2023): registro inmutable
    -- encadenado por huella SHA-256. Esquema RESERVADO ("puertas abiertas"): se
    -- crea vacío para que activar Verifactu no exija reconstruir tablas pobladas.
    -- La lógica de huella/QR/remisión a la AEAT se implementa en una fase posterior
    -- (no obligatorio hasta 2027, RDL 15/2025).
    CREATE TABLE IF NOT EXISTS invoice_ledger (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      invoice_id TEXT NOT NULL REFERENCES workspace_invoices(id) ON DELETE RESTRICT,
      record_type TEXT NOT NULL CHECK (record_type IN ('alta','anulacion')),
      emisor_nif TEXT,
      num_serie_factura TEXT,
      fecha_expedicion INTEGER,
      tipo_factura TEXT,
      cuota_total_cents INTEGER,
      importe_total_cents INTEGER,
      fecha_hora_gen TEXT,
      huella TEXT NOT NULL,
      huella_anterior TEXT,
      sif_mode TEXT CHECK (sif_mode IN ('verifactu','no_verifactu')),
      firma TEXT,
      qr_url TEXT,
      estado_remision TEXT,
      csv_aeat TEXT,
      version_sif TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoice_events_log (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      tipo_evento TEXT NOT NULL,
      ts TEXT,
      detalle TEXT,
      huella_evento TEXT,
      huella_evento_anterior TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_invoice ON invoice_ledger(invoice_id, seq);
    -- Claves de API por cuenta para el proxy de IA (gateway). Hasheadas; el
    -- prefijo distingue de los tokens de panel (nunca dan acceso al panel).
    CREATE TABLE IF NOT EXISTS workspace_api_keys (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      allowed_models TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
      budget_cents_month INTEGER,
      spend_cents_cycle INTEGER NOT NULL DEFAULT 0,
      cycle_anchor INTEGER,
      rate_limit_rpm INTEGER,
      last_used_at INTEGER,
      expires_at INTEGER,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ws_api_keys_ws ON workspace_api_keys(workspace_id);
    -- Coste del operador por modelo (lo que Google nos cobra), para mostrar el
    -- margen frente al PVP del catálogo. Se guarda en micro-céntimos por millón de
    -- tokens (entero exacto para los precios de Gemini; dividir entre 1e6 = céntimos/Mtok).
    CREATE TABLE IF NOT EXISTS ai_model_prices (
      model TEXT PRIMARY KEY,
      cost_micros_in INTEGER NOT NULL DEFAULT 0,
      cost_micros_cache INTEGER NOT NULL DEFAULT 0,
      cost_micros_out INTEGER NOT NULL DEFAULT 0,
      margin_pct REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      updated_at INTEGER NOT NULL
    );
    -- Rutas calientes: proyectos por workspace (cuota y listados), usuarios por
    -- workspace (sub-usuarios) y facturas por workspace.
    CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_workspace ON workspace_invoices(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace ON workspace_subscriptions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_pending_charges_workspace ON pending_charges(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_usage_meter_lookup ON usage_meter_hourly(subject_id, meter, hour);
  `);

  // Facturación de empresa: número, impuestos, método de pago y datos de Stripe.
  ensureColumn('workspace_invoices', 'number', 'TEXT');
  ensureColumn('workspace_invoices', 'tax_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('workspace_invoices', 'tax_rate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('workspace_invoices', 'payment_method', 'TEXT');
  ensureColumn('workspace_invoices', 'stripe_session_id', 'TEXT');
  ensureColumn('workspace_invoices', 'stripe_url', 'TEXT');
  // Conformidad legal española (RD 1619/2012): serie, tipo de factura, rectificativa,
  // fecha de operación, desglose de IVA por tipo, régimen, IRPF, congelación de
  // emisor/destinatario e inmutabilidad de la emitida.
  ensureColumn('workspace_invoices', 'series_id', 'TEXT');
  ensureColumn('workspace_invoices', 'invoice_type', "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn('workspace_invoices', 'rectifies_invoice_id', 'TEXT');
  ensureColumn('workspace_invoices', 'rectify_reason', 'TEXT');
  ensureColumn('workspace_invoices', 'operation_date', 'INTEGER');
  ensureColumn('workspace_invoices', 'tax_breakdown', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('workspace_invoices', 'vat_regime', "TEXT NOT NULL DEFAULT 'general'");
  ensureColumn('workspace_invoices', 'legal_mentions', 'TEXT');
  ensureColumn('workspace_invoices', 'irpf_rate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('workspace_invoices', 'irpf_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('workspace_invoices', 'issuer_snapshot', 'TEXT');
  ensureColumn('workspace_invoices', 'client_name', 'TEXT');
  ensureColumn('workspace_invoices', 'client_tax_id', 'TEXT');
  ensureColumn('workspace_invoices', 'client_address', 'TEXT');
  // El país del destinatario se congela al emitir, como el resto de sus datos.
  ensureColumn('workspace_invoices', 'client_country', 'TEXT');
  // Origen de la factura: 'cycle' la genera el ciclo (y el tick puede sustituir su
  // borrador por el definitivo), 'manual' la escribe el operador y NADIE la toca.
  // Por defecto 'manual': lo conservador para las filas anteriores a la columna.
  ensureColumn('workspace_invoices', 'origin', "TEXT NOT NULL DEFAULT 'manual'");
  // Vencimiento resuelto AL EMITIR. Antes se derivaba del perfil vivo, así que
  // cambiar las condiciones de pago hacía que el duplicado de una factura ya
  // expedida dijese otra fecha: dos documentos distintos con el mismo número.
  // Además la morosidad usa esta misma fecha, para que lo impreso y lo que dispara
  // la suspensión no puedan divergir.
  ensureColumn('workspace_invoices', 'due_at', 'INTEGER');
  ensureColumn('workspace_invoices', 'locked', 'INTEGER NOT NULL DEFAULT 0');
  // Datos fiscales del cliente (destinatario de la factura).
  ensureColumn('workspaces', 'billing_tax_id', 'TEXT');
  ensureColumn('workspaces', 'billing_address', 'TEXT');
  // País del destinatario (ISO 3166-1 alfa-2). España por defecto: es el caso
  // normal del negocio y evita que las cuentas ya existentes queden sin país.
  ensureColumn('workspaces', 'billing_country', "TEXT NOT NULL DEFAULT 'ES'");
  // Estado de morosidad por cuenta (persistido, para que el corte por impago sea
  // idempotente y sobreviva a reinicios). ai_suspended = corte del proxy de IA.
  ensureColumn('workspaces', 'ai_suspended', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('workspaces', 'dunning_stage', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('workspaces', 'dunning_since', 'INTEGER');
  ensureColumn('workspaces', 'last_dunning_action_at', 'INTEGER');
  ensureColumn('workspaces', 'dunning_exempt', 'INTEGER NOT NULL DEFAULT 0');
  // Fecha de contratación del plan actual: ancla el aniversario de las cuotas
  // ANUALES (una cuota anual solo se factura en el ciclo que contiene su
  // aniversario, no en cada ciclo mensual). Se refresca al cambiar de plan, así
  // que un cambio de plan anual no vuelve a cobrar la anualidad del anterior.
  ensureColumn('workspaces', 'plan_since', 'INTEGER');
  // Alertas por cuenta (además de por proyecto/servicio).
  ensureColumn('alerts', 'workspace_id', 'TEXT');
  // Escala del medidor: nº de unidades del medidor por unidad de precio (p. ej.
  // 1000000 para tarifar por 1M de tokens con céntimos enteros).
  ensureColumn('catalog_products', 'unit_size', 'INTEGER NOT NULL DEFAULT 1');
  // Descuento comercial: por plan (aplica a todas sus cuentas) y override por cuenta
  // (nullable → hereda del plan). Se aplica sobre la base antes del IVA al facturar.
  ensureColumn('plans', 'discount_pct', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('workspaces', 'discount_pct', 'REAL');
  // Margen objetivo (s/ venta) por modelo de IA: guía el PVP sugerido = coste/(1−m).
  ensureColumn('ai_model_prices', 'margin_pct', 'REAL NOT NULL DEFAULT 0');
  // Procedencia del coste: 'auto' lo mantiene al día la sincronización con la
  // tarifa de Google; 'manual' lo escribió el operador y la sincronización lo
  // respeta. Las filas anteriores a la sincronización se escribieron a mano.
  ensureColumn('ai_model_prices', 'source', "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn('ai_model_prices', 'synced_at', 'INTEGER');
  // ATRIBUCIÓN MATERIALIZADA DEL CONSUMO. Antes se resolvía con un JOIN vivo
  // servicio → proyecto → workspace, así que borrar un servicio borraba su consumo
  // aún no facturado y reasignar un proyecto trasladaba todo su histórico a la
  // cuenta nueva. Se congela el titular en el momento de medir.
  ensureColumn('service_metrics_hourly', 'workspace_id', 'TEXT');
  ensureColumn('usage_meter_hourly', 'workspace_id', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_service_metrics_ws ON service_metrics_hourly(workspace_id, hour);
    CREATE INDEX IF NOT EXISTS idx_usage_meter_ws ON usage_meter_hourly(workspace_id, meter, hour);
  `);
  // Ancla de facturación: fin del último periodo facturado. Sustituye a derivar el
  // ciclo de `billing_day`, que refacturaba el tramo solapado al cambiar el día y
  // perdía el ciclo entero si el servidor estaba caído justo el día de cierre.
  ensureColumn('workspaces', 'last_billed_period_end', 'INTEGER');
  // Momento del último cambio de estado de una suscripción: sin él, prorratear una
  // baja es imposible (`setWorkspaceSubscriptionsStatus` no escribe `cancelled_at`).
  ensureColumn('workspace_subscriptions', 'status_changed_at', 'INTEGER');
  // Suspensión MANUAL del operador, distinta del corte por impago: al regularizar
  // el pago no debe revivir lo que se cortó a mano.
  ensureColumn('workspace_api_keys', 'suspended_by', 'TEXT');
  ensureColumn('workspace_subscriptions', 'paused_by', 'TEXT');

  seedDefaultPlans();
  // El orden importa: `migrateClientsToWorkspaces` es quien rellena
  // `projects.workspace_id`, y el backfill de atribución resuelve el titular del
  // consumo con un JOIN sobre esa columna. Al revés, una instalación que salte
  // desde antes de las cuentas escribiría NULL en todo el histórico y marcaría la
  // migración como hecha, perdiendo la atribución para siempre.
  migrateClientsToWorkspaces();
  backfillUsageAttribution();
  backfillDunningActor();
  // Después de la migración de clientes: los workspaces que crea también necesitan
  // su primer tramo de historial de plan.
  backfillPlanPeriods();
}

/**
 * Marca como cortadas «por morosidad» las claves y suscripciones que la versión
 * anterior suspendió sin dejar constancia de quién lo hizo. Sin esto,
 * `reviveDunningKeys` no las reconoce y una cuenta que paga queda reactivada a
 * medias: sin deuda pero con el servicio cortado. Solo toca las cuentas que están
 * efectivamente en mora, para no revivir un bloqueo manual ajeno al impago.
 */
function backfillDunningActor(): void {
  if (getSetting('migrations:dunning_actor_v1') === 'done') return;
  db.transaction(() => {
    db.exec(`
      UPDATE workspace_api_keys SET suspended_by = 'dunning'
       WHERE status = 'suspended' AND suspended_by IS NULL
         AND workspace_id IN (SELECT id FROM workspaces WHERE dunning_stage > 0 OR ai_suspended = 1);
      UPDATE workspace_subscriptions SET paused_by = 'dunning'
       WHERE status = 'paused' AND paused_by IS NULL
         AND workspace_id IN (SELECT id FROM workspaces WHERE dunning_stage > 0 OR ai_suspended = 1);
    `);
    setSetting('migrations:dunning_actor_v1', 'done');
  })();
}

/**
 * Rellena una sola vez el titular de las filas de consumo ya existentes, con el
 * JOIN que se usaba hasta ahora. Sin esto, el primer ciclo tras el despliegue
 * facturaría cero por todo el histórico anterior a la migración.
 */
function backfillUsageAttribution(): void {
  if (getSetting('migrations:usage_attribution_v1') === 'done') return;
  db.transaction(() => {
    db.exec(`
      UPDATE service_metrics_hourly SET workspace_id = (
        SELECT p.workspace_id FROM services s JOIN projects p ON p.id = s.project_id WHERE s.id = service_id
      ) WHERE workspace_id IS NULL;
      UPDATE usage_meter_hourly SET workspace_id = CASE
        WHEN subject_type = 'workspace' THEN subject_id
        ELSE (SELECT p.workspace_id FROM services s JOIN projects p ON p.id = s.project_id WHERE s.id = subject_id)
      END WHERE workspace_id IS NULL;
    `);
    // Solo se da por hecha cuando ya no queda ninguna fila sin titular resoluble:
    // así una instalación que se actualizó antes de tiempo lo reintenta al
    // arrancar, en vez de quedarse con el histórico sin atribuir para siempre.
    const pendientes = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM service_metrics_hourly m
         WHERE m.workspace_id IS NULL
           AND EXISTS (SELECT 1 FROM services s JOIN projects p ON p.id = s.project_id
                        WHERE s.id = m.service_id AND p.workspace_id IS NOT NULL)`,
      )
      .get() as { c: number }).c;
    if (pendientes === 0) setSetting('migrations:usage_attribution_v1', 'done');
  })();
}

/**
 * Siembra un catálogo de planes por defecto la primera vez (tabla vacía). Son
 * un punto de partida editable, no una imposición: el admin los ajusta o crea
 * los suyos. Idempotente: si ya hay algún plan, no toca nada.
 */
function seedDefaultPlans(): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM plans').get() as any).c as number;
  if (count > 0) return;
  const base: Omit<PlanRow, 'id' | 'created_at'>[] = [
    {
      name: 'Arranque', slug: 'arranque', price_cents: 0, currency: 'EUR', interval: 'monthly',
      cpu_cores: 1, memory_mb: 1024, disk_mb: 10240, max_projects: 2, max_services: 6, max_members: 2,
      modules: JSON.stringify(['databases', 'dbconsole', 'metrics', 'domains', 'status_page']),
      is_default: 1, archived: 0, discount_pct: 0,
    },
    {
      name: 'Pro', slug: 'pro', price_cents: 2900, currency: 'EUR', interval: 'monthly',
      cpu_cores: 4, memory_mb: 8192, disk_mb: 51200, max_projects: 10, max_services: 30, max_members: 8,
      modules: JSON.stringify(['databases', 'dbconsole', 'backups', 'files', 'exec', 'metrics', 'replicas', 'domains', 'status_page', 'github']),
      is_default: 0, archived: 0, discount_pct: 0,
    },
    {
      name: 'Escala', slug: 'escala', price_cents: 9900, currency: 'EUR', interval: 'monthly',
      cpu_cores: 16, memory_mb: 32768, disk_mb: 256000, max_projects: 50, max_services: 200, max_members: 25,
      modules: JSON.stringify(['databases', 'dbconsole', 'backups', 'files', 'exec', 'metrics', 'replicas', 'domains', 'status_page', 'github']),
      is_default: 0, archived: 0, discount_pct: 0,
    },
  ];
  const ins = db.prepare(
    `INSERT INTO plans (id, name, slug, price_cents, currency, interval, cpu_cores, memory_mb, disk_mb, max_projects, max_services, max_members, modules, is_default, archived, created_at)
     VALUES (@id, @name, @slug, @price_cents, @currency, @interval, @cpu_cores, @memory_mb, @disk_mb, @max_projects, @max_services, @max_members, @modules, @is_default, @archived, @created_at)`,
  );
  const tx = db.transaction(() => {
    for (const p of base) ins.run({ ...p, id: id('pln'), created_at: now() });
  });
  tx();
}

/**
 * Migra el antiguo campo de texto `projects.client` a workspaces reales,
 * enlazando cada proyecto con el suyo. Una sola vez (flag en settings), e
 * idempotente por si acaso: agrupa por nombre de cliente (sin distinguir
 * mayúsculas ni espacios), reutiliza el workspace si ya existe y no reasigna
 * proyectos ya enlazados. Los proyectos sin cliente quedan sin asignar.
 */
function migrateClientsToWorkspaces(): void {
  if (getSetting('migrations:workspaces_v1') === 'done') return;
  const rows = db
    .prepare("SELECT id, client FROM projects WHERE client IS NOT NULL AND TRIM(client) <> '' AND workspace_id IS NULL")
    .all() as { id: string; client: string }[];
  const tx = db.transaction(() => {
    // Índice de workspaces existentes por nombre normalizado (evita duplicados en reejecución).
    const existing = new Map<string, string>();
    for (const w of db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[]) {
      existing.set(w.name.trim().toLowerCase(), w.id);
    }
    for (const row of rows) {
      const name = row.client.trim();
      const key = name.toLowerCase();
      let wsId = existing.get(key);
      if (!wsId) {
        const ws = createWorkspaceRow(name, { ...MIGRATED_WORKSPACE_INIT });
        wsId = ws.id;
        existing.set(key, wsId);
      }
      db.prepare('UPDATE projects SET workspace_id = ? WHERE id = ?').run(wsId, row.id);
    }
    setSetting('migrations:workspaces_v1', 'done');
  });
  tx();
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Copia consistente y compactada de la base de datos del panel en `dest`
 * (VACUUM INTO): sirve como snapshot de backup incluso con la BD en uso.
 */
export function vacuumInto(dest: string): void {
  db.prepare('VACUUM INTO ?').run(dest);
}

/**
 * Comprobación de integridad de la BD del panel. Devuelve null si está sana,
 * o el detalle del problema. Se ejecuta al arrancar: detectar corrupción
 * temprano (disco, apagón…) vale más que descubrirla con un fallo raro.
 */
export function checkIntegrity(): string | null {
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    const results = rows.map((r) => r.integrity_check);
    if (results.length === 1 && results[0] === 'ok') return null;
    return results.join('; ').slice(0, 1000) || 'resultado vacío';
  } catch (err: any) {
    return `no se pudo comprobar: ${err?.message || err}`;
  }
}

/** Ejecuta varias escrituras de forma atómica (todo o nada). */
export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

function parseService(row: any): ServiceRow {
  return { ...row, config: JSON.parse(row.config) };
}

// ---------- users ----------
export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
}

export function createUser(
  email: string,
  passwordHash: string,
  role: UserRole = 'admin',
  workspaceId: string | null = null,
): UserRow {
  const row: UserRow = {
    id: id('usr'), email, password_hash: passwordHash, role, session_epoch: 0,
    created_at: now(), workspace_id: workspaceId,
  };
  db.prepare('INSERT INTO users (id, email, password_hash, role, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    row.id, row.email, row.password_hash, row.role, row.workspace_id, row.created_at,
  );
  return row;
}

/** Cambia el workspace al que pertenece un usuario (owner/member). null en admins. */
export function updateUserWorkspace(userId: string, workspaceId: string | null): void {
  db.prepare('UPDATE users SET workspace_id = ? WHERE id = ?').run(workspaceId, userId);
}

/** Sub-usuarios (owner/member) de un workspace, en orden de alta. */
export function listWorkspaceUsers(workspaceId: string): UserRow[] {
  return db
    .prepare('SELECT * FROM users WHERE workspace_id = ? ORDER BY created_at ASC')
    .all(workspaceId) as UserRow[];
}

export function countWorkspaceMembers(workspaceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users WHERE workspace_id = ?').get(workspaceId) as any).c;
}

export function listUsers(): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

export function countAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as any).c;
}

export function updateUserRole(userId: string, role: UserRole): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

export function deleteUser(userId: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// ---------- workspaces por usuario ----------
export function listUserProjectIds(userId: string): string[] {
  return (db.prepare('SELECT project_id FROM user_projects WHERE user_id = ?').all(userId) as any[])
    .map((r) => r.project_id);
}

export function setUserProjects(userId: string, projectIds: string[]): void {
  const del = db.prepare('DELETE FROM user_projects WHERE user_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) VALUES (?, ?)');
  const tx = db.transaction(() => {
    del.run(userId);
    for (const pid of projectIds) ins.run(userId, pid);
  });
  tx();
}

export function userHasProject(userId: string, projectId: string): boolean {
  return !!db.prepare('SELECT 1 FROM user_projects WHERE user_id = ? AND project_id = ?').get(userId, projectId);
}

/** Elimina todas las asignaciones de un proyecto (al reasignarlo de workspace, para no dejar accesos colgando). */
export function clearProjectMemberships(projectId: string): void {
  db.prepare('DELETE FROM user_projects WHERE project_id = ?').run(projectId);
}

// ---------- passkeys ----------
export function insertPasskey(row: Omit<PasskeyRow, 'id' | 'created_at' | 'last_used_at'>): PasskeyRow {
  const full: PasskeyRow = { ...row, id: id('pky'), created_at: now(), last_used_at: null };
  db.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, rp_id, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(full.id, full.user_id, full.credential_id, full.public_key, full.counter, full.transports, full.device_type, full.backed_up, full.rp_id, full.name, full.created_at, full.last_used_at);
  return full;
}

export function listPasskeys(userId: string): PasskeyRow[] {
  return db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC').all(userId) as PasskeyRow[];
}

export function countPasskeys(userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM passkeys WHERE user_id = ?').get(userId) as any).c;
}

export function getPasskeyByCredentialId(credentialId: string): PasskeyRow | undefined {
  return db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId) as PasskeyRow | undefined;
}

export function touchPasskey(passkeyId: string, counter: number): void {
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, now(), passkeyId);
}

export function deletePasskey(passkeyId: string, userId: string): boolean {
  return db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(passkeyId, userId).changes > 0;
}

// ---------- tokens de API ----------
export function insertApiToken(row: Omit<ApiTokenRow, 'id' | 'created_at' | 'last_used_at'>): ApiTokenRow {
  const full: ApiTokenRow = { ...row, id: id('tok'), created_at: now(), last_used_at: null };
  db.prepare(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(full.id, full.user_id, full.name, full.token_hash, full.prefix, full.created_at, full.last_used_at, full.expires_at);
  return full;
}

export function listApiTokens(userId: string): ApiTokenRow[] {
  return db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at ASC').all(userId) as ApiTokenRow[];
}

export function countApiTokens(userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?').get(userId) as any).c;
}

export function getApiTokenByHash(tokenHash: string): ApiTokenRow | undefined {
  return db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as ApiTokenRow | undefined;
}

export function touchApiToken(tokenId: string): void {
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), tokenId);
}

export function deleteApiToken(tokenId: string, userId: string): boolean {
  return db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(tokenId, userId).changes > 0;
}

export function getUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function getUser(userId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
}

/** Cambia la contraseña e invalida las sesiones y cookies previas del usuario (bump de epoch). */
export function updateUserPassword(userId: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(passwordHash, userId);
}

// ---------- settings ----------
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }
}

// ---------- projects ----------
export function createProject(
  name: string,
  slug: string,
  client: string | null = null,
  workspaceId: string | null = null,
): ProjectRow {
  const row: ProjectRow = {
    id: id('prj'), name, slug, client, workspace_id: workspaceId, created_at: now(),
    status_token: null, status_enabled: 0, status_notice: null,
  };
  db.prepare('INSERT INTO projects (id, name, slug, client, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    row.id, row.name, row.slug, row.client, row.workspace_id, row.created_at,
  );
  return row;
}

/** Proyectos de un workspace (para cuota agregada y listados del cliente). */
export function listWorkspaceProjects(workspaceId: string): ProjectRow[] {
  return db
    .prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId) as ProjectRow[];
}

export function countWorkspaceProjects(workspaceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM projects WHERE workspace_id = ?').get(workspaceId) as any).c;
}

/**
 * Asigna (o desasigna) un proyecto a un workspace y mantiene el reflejo
 * denormalizado `client` que usa la agrupación por empresa de la UI.
 */
export function setProjectWorkspace(projectId: string, workspaceId: string | null, clientName: string | null): void {
  db.transaction(() => {
    db.prepare('UPDATE projects SET workspace_id = ?, client = ? WHERE id = ?').run(workspaceId, clientName, projectId);
    if (!workspaceId) return;
    // El alta normal crea el proyecto SIN cuenta, despliega los servicios y asigna
    // el cliente días después: durante ese tiempo los cubos horarios se escriben
    // con `workspace_id` NULL y ese consumo no se facturaba nunca. Al asignar la
    // cuenta se adopta el consumo aún SIN TITULAR de sus servicios. El filtro
    // `workspace_id IS NULL` es lo que impide que una reasignación entre cuentas
    // se lleve consigo el consumo ya atribuido (y ya facturado) a la anterior.
    db.prepare(
      `UPDATE service_metrics_hourly SET workspace_id = ?
       WHERE workspace_id IS NULL AND service_id IN (SELECT id FROM services WHERE project_id = ?)`,
    ).run(workspaceId, projectId);
    db.prepare(
      `UPDATE usage_meter_hourly SET workspace_id = ?
       WHERE workspace_id IS NULL AND subject_type = 'service'
         AND subject_id IN (SELECT id FROM services WHERE project_id = ?)`,
    ).run(workspaceId, projectId);
  })();
}

export function listProjects(): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
}

export function getProject(projectId: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
}

export function projectSlugExists(slug: string): boolean {
  return !!db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug);
}

export function updateProjectMeta(projectId: string, name: string, client: string | null): void {
  db.prepare('UPDATE projects SET name = ?, client = ? WHERE id = ?').run(name, client, projectId);
}

export function deleteProject(projectId: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

// ---------- página de estado pública ----------
export function getProjectByStatusToken(token: string): ProjectRow | undefined {
  return db
    .prepare('SELECT * FROM projects WHERE status_token = ? AND status_enabled = 1')
    .get(token) as ProjectRow | undefined;
}

export function setProjectStatusPage(projectId: string, enabled: boolean, token?: string | null): void {
  if (token !== undefined) {
    db.prepare('UPDATE projects SET status_enabled = ?, status_token = ? WHERE id = ?')
      .run(enabled ? 1 : 0, token, projectId);
  } else {
    db.prepare('UPDATE projects SET status_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, projectId);
  }
}

/** Aviso de mantenimiento que se muestra como banner en la página de estado. */
export function setProjectStatusNotice(projectId: string, notice: string | null): void {
  db.prepare('UPDATE projects SET status_notice = ? WHERE id = ?').run(notice, projectId);
}

// ---------- histórico de disponibilidad ----------
/** Registra una muestra del monitor (una por servicio y tick) agregada por hora. */
export function recordUptimeSample(serviceId: string, up: boolean): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO uptime_hourly (service_id, hour, up, total) VALUES (?, ?, ?, 1)
     ON CONFLICT(service_id, hour) DO UPDATE SET up = up + excluded.up, total = total + 1`,
  ).run(serviceId, hour, up ? 1 : 0);
}

/** Disponibilidad acumulada de las últimas `hours` horas: NULL si no hay datos. */
export function uptimePercent(serviceId: string, hours: number): number | null {
  const from = Math.floor(now() / 3_600_000) - hours;
  const row = db
    .prepare('SELECT SUM(up) AS up, SUM(total) AS total FROM uptime_hourly WHERE service_id = ? AND hour > ?')
    .get(serviceId, from) as { up: number | null; total: number | null };
  if (!row.total) return null;
  return Math.round(((row.up ?? 0) / row.total) * 10000) / 100;
}

/** Disponibilidad por día (UTC) de los últimos `days` días, para las barras de la página de estado. */
export function uptimeDaily(serviceId: string, days: number): { day: number; up: number; total: number }[] {
  const fromHour = Math.floor(now() / 3_600_000) - days * 24;
  return db
    .prepare(
      `SELECT (hour / 24) AS day, SUM(up) AS up, SUM(total) AS total
       FROM uptime_hourly WHERE service_id = ? AND hour > ? GROUP BY day ORDER BY day ASC`,
    )
    .all(serviceId, fromHour) as { day: number; up: number; total: number }[];
}

/** Borra el histórico de disponibilidad viejo y el de servicios eliminados. */
export function pruneUptime(keepDays = 92): void {
  const cutoff = Math.floor(now() / 3_600_000) - keepDays * 24;
  db.prepare('DELETE FROM uptime_hourly WHERE hour < ?').run(cutoff);
  db.prepare('DELETE FROM uptime_hourly WHERE service_id NOT IN (SELECT id FROM services)').run();
}

// ---------- histórico de consumo (CPU/RAM/red/disco) ----------
/**
 * Acumula una muestra de consumo de un servicio en su cubo horario. Las sumas
 * dividen luego entre `samples` para la media; los máximos guardan el pico real
 * de la hora, que una media aplasta y es justo lo que delata un problema.
 */
export function recordServiceMetrics(serviceId: string, s: ServiceMetricSample, workspaceId: string | null = null): void {
  const hour = Math.floor(now() / 3_600_000);
  // `workspace_id` solo se fija al CREAR el cubo: el titular de una hora ya
  // empezada no cambia a media hora. Una reasignación de proyecto surte efecto
  // desde el cubo siguiente (granularidad de una hora, la del propio medidor).
  db.prepare(
    `INSERT INTO service_metrics_hourly
       (service_id, hour, workspace_id, samples, cpu_sum, cpu_max, mem_sum, mem_max, mem_limit_last, net_rx, net_tx)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(service_id, hour) DO UPDATE SET
       samples = samples + 1,
       cpu_sum = cpu_sum + excluded.cpu_sum,
       cpu_max = MAX(cpu_max, excluded.cpu_max),
       mem_sum = mem_sum + excluded.mem_sum,
       mem_max = MAX(mem_max, excluded.mem_max),
       mem_limit_last = excluded.mem_limit_last,
       net_rx = net_rx + excluded.net_rx,
       net_tx = net_tx + excluded.net_tx,
       workspace_id = COALESCE(workspace_id, excluded.workspace_id)`,
  ).run(serviceId, hour, workspaceId, s.cpuPercent, s.cpuPercent, s.memUsage, s.memUsage, s.memLimit, s.netRxDelta, s.netTxDelta);
}

/** Registra la foto de disco de un servicio en el cubo horario actual (sobrescribe). */
export function recordServiceDisk(serviceId: string, totalBytes: number, workspaceId: string | null = null): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO service_metrics_hourly (service_id, hour, workspace_id, disk_last) VALUES (?, ?, ?, ?)
     ON CONFLICT(service_id, hour) DO UPDATE SET
       disk_last = excluded.disk_last,
       workspace_id = COALESCE(workspace_id, excluded.workspace_id)`,
  ).run(serviceId, hour, workspaceId, totalBytes);
}

/** Acumula una muestra de carga y RAM del host en su cubo horario. */
export function recordHostMetrics(load: number, memUsed: number, memTotal: number): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO host_metrics_hourly
       (hour, samples, load_sum, load_max, mem_used_sum, mem_used_max, mem_total_last)
     VALUES (?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(hour) DO UPDATE SET
       samples = samples + 1,
       load_sum = load_sum + excluded.load_sum,
       load_max = MAX(load_max, excluded.load_max),
       mem_used_sum = mem_used_sum + excluded.mem_used_sum,
       mem_used_max = MAX(mem_used_max, excluded.mem_used_max),
       mem_total_last = excluded.mem_total_last`,
  ).run(hour, load, load, memUsed, memUsed, memTotal);
}

/** Registra la foto de disco del host en el cubo horario actual (sobrescribe). */
export function recordHostDisk(diskUsed: number, diskTotal: number): void {
  const hour = Math.floor(now() / 3_600_000);
  db.prepare(
    `INSERT INTO host_metrics_hourly (hour, disk_used_last, disk_total_last) VALUES (?, ?, ?)
     ON CONFLICT(hour) DO UPDATE SET disk_used_last = excluded.disk_used_last, disk_total_last = excluded.disk_total_last`,
  ).run(hour, diskUsed, diskTotal);
}

/** Filas horarias del histórico de un servicio de las últimas `hours` horas (orden ascendente). */
export function serviceMetricsRange(serviceId: string, hours: number): ServiceMetricHour[] {
  const from = Math.floor(now() / 3_600_000) - hours;
  return db
    .prepare('SELECT * FROM service_metrics_hourly WHERE service_id = ? AND hour > ? ORDER BY hour ASC')
    .all(serviceId, from) as ServiceMetricHour[];
}

/** Filas horarias del histórico del host de las últimas `hours` horas (orden ascendente). */
export function hostMetricsRange(hours: number): HostMetricHour[] {
  const from = Math.floor(now() / 3_600_000) - hours;
  return db
    .prepare('SELECT * FROM host_metrics_hourly WHERE hour > ? ORDER BY hour ASC')
    .all(from) as HostMetricHour[];
}

/**
 * Poda el histórico de consumo viejo. NO se borran las filas de servicios
 * eliminados: son consumo real que puede estar aún sin facturar, y borrarlas
 * hacía que quien borrase un servicio a fin de mes no pagara lo consumido. Caducan
 * igual por antigüedad (`keepDays`), muy por encima de cualquier ciclo.
 */
export function pruneMetrics(keepDays = 90): void {
  const cutoff = Math.floor(now() / 3_600_000) - keepDays * 24;
  db.prepare('DELETE FROM service_metrics_hourly WHERE hour < ?').run(cutoff);
  db.prepare('DELETE FROM host_metrics_hourly WHERE hour < ?').run(cutoff);
  db.prepare('DELETE FROM usage_meter_hourly WHERE hour < ?').run(cutoff);
  db.prepare('DELETE FROM usage_events WHERE ts < ?').run(cutoff * 3_600_000);
}

// ---------- services ----------
export function createService(
  projectId: string,
  name: string,
  slug: string,
  type: ServiceType,
  cfg: ServiceConfig,
): ServiceRow {
  const row = { id: id('svc'), project_id: projectId, name, slug, type, config: cfg, created_at: now() };
  db.prepare(
    'INSERT INTO services (id, project_id, name, slug, type, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.project_id, row.name, row.slug, row.type, JSON.stringify(cfg), row.created_at);
  return row as ServiceRow;
}

export function listServices(projectId: string): ServiceRow[] {
  return (db.prepare('SELECT * FROM services WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as any[])
    .map(parseService);
}

export function getService(serviceId: string): ServiceRow | undefined {
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId) as any;
  return row ? parseService(row) : undefined;
}

export function serviceSlugExists(projectId: string, slug: string): boolean {
  return !!db.prepare('SELECT 1 FROM services WHERE project_id = ? AND slug = ?').get(projectId, slug);
}

export function updateService(serviceId: string, name: string, cfg: ServiceConfig): void {
  db.prepare('UPDATE services SET name = ?, config = ? WHERE id = ?').run(name, JSON.stringify(cfg), serviceId);
}

export function deleteService(serviceId: string): void {
  db.prepare('DELETE FROM services WHERE id = ?').run(serviceId);
}

// ---------- env vars ----------
export function getEnv(serviceId: string): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM env_vars WHERE service_id = ? ORDER BY key').all(serviceId) as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setEnv(serviceId: string, vars: Record<string, string>): void {
  const del = db.prepare('DELETE FROM env_vars WHERE service_id = ?');
  const ins = db.prepare('INSERT INTO env_vars (service_id, key, value) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(serviceId);
    for (const [k, v] of Object.entries(vars)) ins.run(serviceId, k, v);
  });
  tx();
}

// ---------- deployments ----------
export function createDeployment(
  serviceId: string,
  trigger: string,
  imageTag?: string | null,
  opts: { forceBuild?: boolean } = {},
): DeploymentRow {
  const row: DeploymentRow = {
    id: id('dep'),
    service_id: serviceId,
    status: 'queued',
    trigger,
    commit_sha: null,
    commit_msg: null,
    image_tag: imageTag ?? null,
    logs: '',
    error: null,
    diagnosis: null,
    build_key: null,
    repo_config: null,
    force_build: opts.forceBuild ? 1 : 0,
    created_at: now(),
    finished_at: null,
  };
  db.prepare(
    `INSERT INTO deployments (id, service_id, status, trigger, commit_sha, commit_msg, image_tag, logs, error, force_build, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.service_id, row.status, row.trigger, row.commit_sha, row.commit_msg, row.image_tag, row.logs, row.error, row.force_build, row.created_at, row.finished_at);
  return row;
}

export function updateDeployment(
  deploymentId: string,
  fields: Partial<
    Pick<
      DeploymentRow,
      'status' | 'commit_sha' | 'commit_msg' | 'image_tag' | 'logs' | 'error' | 'finished_at' | 'build_key' | 'repo_config'
    >
  >,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE deployments SET ${sets} WHERE id = ?`).run(...keys.map((k) => (fields as any)[k]), deploymentId);
}

export function getDeployment(deploymentId: string): DeploymentRow | undefined {
  return db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as DeploymentRow | undefined;
}

/**
 * Igual que getDeployment pero sin el log (que llega a cientos de kB). Para los
 * avisos del feed, que se emiten varias veces por despliegue y no lo necesitan.
 */
export function deploymentSummary(deploymentId: string): DeploymentRow | undefined {
  const row = db
    .prepare(
      `SELECT id, service_id, status, trigger, commit_sha, commit_msg, image_tag, error, diagnosis,
              build_key, repo_config, force_build, created_at, finished_at
         FROM deployments WHERE id = ?`,
    )
    .get(deploymentId) as Omit<DeploymentRow, 'logs'> | undefined;
  return row ? { ...row, logs: '' } : undefined;
}

export function listDeployments(serviceId: string, limit = 20): DeploymentRow[] {
  return db
    .prepare(
      `SELECT id, service_id, status, trigger, commit_sha, commit_msg, image_tag, error, diagnosis,
              build_key, repo_config, force_build, created_at, finished_at
         FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(serviceId, limit)
    .map((r: any) => ({ ...r, logs: '' })) as DeploymentRow[];
}

/**
 * Despliegue anterior del que se puede reutilizar la imagen: mismo commit y
 * mismas entradas de compilación. Sin esto, redesplegar tras tocar una variable
 * volvía a clonar el repo y a compilar la imagen entera para acabar con
 * exactamente los mismos bits.
 */
export function reusableBuild(serviceId: string, commitSha: string, buildKey: string): DeploymentRow | undefined {
  return db
    .prepare(
      `SELECT id, service_id, status, trigger, commit_sha, commit_msg, image_tag, error, diagnosis,
              build_key, repo_config, force_build, created_at, finished_at
         FROM deployments
        WHERE service_id = ? AND commit_sha = ? AND build_key = ? AND status = 'success' AND image_tag IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(serviceId, commitSha, buildKey) as DeploymentRow | undefined;
}

/**
 * Despliegue que construyó una imagen. Un rollback reutiliza la imagen de otro
 * despliegue y necesita SU config-as-code: si aquel commit declaraba otro
 * comando de arranque o healthcheck, volver a esa imagen sin volver a esa
 * configuración arrancaría una mezcla de las dos versiones.
 */
export function deploymentForImage(serviceId: string, imageTag: string): DeploymentRow | undefined {
  const row = db
    .prepare(
      `SELECT id, service_id, status, trigger, commit_sha, commit_msg, image_tag, error, diagnosis,
              build_key, repo_config, force_build, created_at, finished_at
         FROM deployments
        WHERE service_id = ? AND image_tag = ? AND status = 'success'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(serviceId, imageTag) as Omit<DeploymentRow, 'logs'> | undefined;
  return row ? { ...row, logs: '' } : undefined;
}

/** Imagen del último despliegue correcto: sirve de caché de capas para el build. */
export function lastSuccessfulImage(serviceId: string): string | null {
  const row = db
    .prepare(
      `SELECT image_tag FROM deployments
        WHERE service_id = ? AND status = 'success' AND image_tag IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(serviceId) as { image_tag: string } | undefined;
  return row?.image_tag ?? null;
}

export function latestDeployment(serviceId: string): DeploymentRow | undefined {
  return db
    .prepare('SELECT * FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(serviceId) as DeploymentRow | undefined;
}

/** Estados no terminales: el despliegue sigue vivo y hay versión nueva en camino. */
export const ACTIVE_DEPLOY_STATES = ['queued', 'building', 'deploying'] as const;

/**
 * Despliegues en marcha del proyecto, indexados por servicio. La rejilla y la
 * cabecera del proyecto lo usan para anunciar la versión que está saliendo sin
 * tener que abrir el panel del servicio.
 */
export function activeDeploymentsByProject(projectId: string): Record<string, DeploymentRow> {
  const rows = db
    .prepare(
      `SELECT d.id, d.service_id, d.status, d.trigger, d.commit_sha, d.commit_msg, d.image_tag,
              d.error, d.diagnosis, d.build_key, d.repo_config, d.force_build, d.created_at, d.finished_at
         FROM deployments d JOIN services s ON s.id = d.service_id
        WHERE s.project_id = ? AND d.status IN ('queued', 'building', 'deploying')
        ORDER BY d.created_at ASC`,
    )
    .all(projectId) as DeploymentRow[];
  const out: Record<string, DeploymentRow> = {};
  // Orden ascendente y sobrescritura: si un servicio tuviera dos vivos (cola),
  // gana el más reciente, que es el que la UI debe anunciar.
  for (const row of rows) out[row.service_id] = { ...row, logs: '' };
  return out;
}

/**
 * SHA del último commit que Skyway llegó a construir para el servicio (clon
 * realizado, con éxito o no). Sirve al auto-deploy para no re-desplegar un
 * commit ya tratado —lo desplegara el webhook, un deploy manual o el propio
 * sondeo— y evitar duplicados y bucles.
 */
export function lastBuiltCommitSha(serviceId: string): string | null {
  const row = db
    .prepare('SELECT commit_sha FROM deployments WHERE service_id = ? AND commit_sha IS NOT NULL ORDER BY created_at DESC LIMIT 1')
    .get(serviceId) as { commit_sha: string } | undefined;
  return row?.commit_sha ?? null;
}

export function successfulDeploymentsBeyond(serviceId: string, keep: number): DeploymentRow[] {
  return db
    .prepare(
      `SELECT * FROM deployments WHERE service_id = ? AND status = 'success' AND image_tag IS NOT NULL
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
    )
    .all(serviceId, keep) as DeploymentRow[];
}

export function setDeploymentDiagnosis(deploymentId: string, diagnosis: object | null): void {
  db.prepare('UPDATE deployments SET diagnosis = ? WHERE id = ?').run(
    diagnosis ? JSON.stringify(diagnosis) : null,
    deploymentId,
  );
}

// ---------- variables compartidas de proyecto ----------
export function getProjectVars(projectId: string): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM project_vars WHERE project_id = ? ORDER BY key').all(projectId) as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setProjectVars(projectId: string, vars: Record<string, string>): void {
  const del = db.prepare('DELETE FROM project_vars WHERE project_id = ?');
  const ins = db.prepare('INSERT INTO project_vars (project_id, key, value) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(projectId);
    for (const [k, v] of Object.entries(vars)) ins.run(projectId, k, v);
  });
  tx();
}

// ---------- conectores de GitHub por proyecto ----------
export function insertGithubConnector(
  row: Omit<GithubConnectorRow, 'id' | 'created_at' | 'last_used_at'>,
): GithubConnectorRow {
  const full: GithubConnectorRow = { ...row, id: id('ghc'), created_at: now(), last_used_at: null };
  db.prepare(
    `INSERT INTO github_connectors (id, project_id, name, token, gh_login, token_type, created_by, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(full.id, full.project_id, full.name, full.token, full.gh_login, full.token_type, full.created_by, full.created_at, full.last_used_at);
  return full;
}

export function listGithubConnectors(projectId: string): GithubConnectorRow[] {
  return db
    .prepare('SELECT * FROM github_connectors WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as GithubConnectorRow[];
}

/** Todos los conectores con su proyecto, para el panel de control del admin. */
export function listAllGithubConnectors(): (GithubConnectorRow & { project_name: string; project_client: string | null })[] {
  return db
    .prepare(
      `SELECT c.*, p.name AS project_name, p.client AS project_client
       FROM github_connectors c JOIN projects p ON p.id = c.project_id
       ORDER BY p.name ASC, c.created_at ASC`,
    )
    .all() as (GithubConnectorRow & { project_name: string; project_client: string | null })[];
}

export function getGithubConnector(connectorId: string): GithubConnectorRow | undefined {
  return db.prepare('SELECT * FROM github_connectors WHERE id = ?').get(connectorId) as GithubConnectorRow | undefined;
}

export function countGithubConnectors(projectId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM github_connectors WHERE project_id = ?').get(projectId) as any).c;
}

export function touchGithubConnector(connectorId: string): void {
  db.prepare('UPDATE github_connectors SET last_used_at = ? WHERE id = ?').run(now(), connectorId);
}

// ---------- instalaciones de la GitHub App ----------

/**
 * Alta idempotente: reinstalar la misma cuenta sobre el mismo ámbito actualiza
 * la fila en vez de duplicarla (GitHub reutiliza el installation_id).
 */
export function upsertGithubInstallation(row: {
  installation_id: number;
  account_login: string;
  account_type: string;
  repo_selection: string;
  project_id: string | null;
  created_by: string;
  suspended?: boolean;
}): GithubInstallationRow {
  const existing = db
    .prepare(
      row.project_id === null
        ? 'SELECT * FROM github_installations WHERE installation_id = ? AND project_id IS NULL'
        : 'SELECT * FROM github_installations WHERE installation_id = ? AND project_id = ?',
    )
    .get(...(row.project_id === null ? [row.installation_id] : [row.installation_id, row.project_id])) as
    | GithubInstallationRow
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE github_installations
          SET account_login = ?, account_type = ?, repo_selection = ?, suspended = ?
        WHERE id = ?`,
    ).run(row.account_login, row.account_type, row.repo_selection, row.suspended ? 1 : 0, existing.id);
    return { ...existing, ...row, project_id: row.project_id, suspended: row.suspended ? 1 : 0 };
  }

  const full: GithubInstallationRow = {
    id: id('ghi'),
    installation_id: row.installation_id,
    account_login: row.account_login,
    account_type: row.account_type,
    repo_selection: row.repo_selection,
    project_id: row.project_id,
    created_by: row.created_by,
    created_at: now(),
    last_used_at: null,
    suspended: row.suspended ? 1 : 0,
  };
  db.prepare(
    `INSERT INTO github_installations
       (id, installation_id, account_login, account_type, repo_selection, project_id, created_by, created_at, last_used_at, suspended)
     VALUES (@id, @installation_id, @account_login, @account_type, @repo_selection, @project_id, @created_by, @created_at, @last_used_at, @suspended)`,
  ).run(full);
  return full;
}

/** Instalaciones utilizables desde un proyecto: las suyas y las globales. */
export function listGithubInstallationsForProject(projectId: string): GithubInstallationRow[] {
  return db
    .prepare(
      `SELECT * FROM github_installations
        WHERE project_id = ? OR project_id IS NULL
        ORDER BY project_id IS NULL, account_login`,
    )
    .all(projectId) as GithubInstallationRow[];
}

export function listAllGithubInstallations(): (GithubInstallationRow & { project_name: string | null })[] {
  return db
    .prepare(
      `SELECT i.*, p.name AS project_name
         FROM github_installations i LEFT JOIN projects p ON p.id = i.project_id
        ORDER BY i.created_at DESC`,
    )
    .all() as (GithubInstallationRow & { project_name: string | null })[];
}

export function getGithubInstallation(rowId: string): GithubInstallationRow | undefined {
  return db.prepare('SELECT * FROM github_installations WHERE id = ?').get(rowId) as GithubInstallationRow | undefined;
}

/** Filas (posiblemente varias, una por proyecto) de un número de instalación. */
export function listGithubInstallationsByNumber(installationId: number): GithubInstallationRow[] {
  return db
    .prepare('SELECT * FROM github_installations WHERE installation_id = ?')
    .all(installationId) as GithubInstallationRow[];
}

export function touchGithubInstallation(rowId: string): void {
  db.prepare('UPDATE github_installations SET last_used_at = ? WHERE id = ?').run(now(), rowId);
}

export function setGithubInstallationSuspended(installationId: number, suspended: boolean): void {
  db.prepare('UPDATE github_installations SET suspended = ? WHERE installation_id = ?').run(
    suspended ? 1 : 0,
    installationId,
  );
}

export function deleteGithubInstallation(rowId: string): boolean {
  return db.prepare('DELETE FROM github_installations WHERE id = ?').run(rowId).changes > 0;
}

/** Borra todas las filas de una instalación (la desinstalaron desde GitHub). */
export function deleteGithubInstallationsByNumber(installationId: number): number {
  return db.prepare('DELETE FROM github_installations WHERE installation_id = ?').run(installationId).changes;
}

export function deleteGithubConnector(connectorId: string): boolean {
  return db.prepare('DELETE FROM github_connectors WHERE id = ?').run(connectorId).changes > 0;
}

// ---------- auditoría ----------
export function insertAudit(entry: Omit<AuditRow, 'id' | 'ts'>): void {
  db.prepare(
    'INSERT INTO audit_log (id, ts, actor, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id('aud'), now(), entry.actor, entry.action, entry.target_type, entry.target_id, entry.detail, entry.ip);
}

export function listAudit(opts: { limit?: number; action?: string; projectId?: string } = {}): AuditRow[] {
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.action) {
    return db
      .prepare('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY ts DESC LIMIT ?')
      .all(`${opts.action}%`, limit) as AuditRow[];
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit) as AuditRow[];
}

export function countFailedLogins(sinceMs: number): { count: number; ips: string[] } {
  const rows = db
    .prepare("SELECT ip FROM audit_log WHERE action = 'login_failed' AND ts > ?")
    .all(now() - sinceMs) as { ip: string | null }[];
  return { count: rows.length, ips: [...new Set(rows.map((r) => r.ip || '?'))].slice(0, 10) };
}

// ---------- alertas ----------
export function insertAlert(alert: {
  severity: AlertSeverity;
  type: string;
  project_id?: string | null;
  service_id?: string | null;
  workspace_id?: string | null;
  title: string;
  message: string;
  explanation?: string | null;
  dedupe_key?: string | null;
}): AlertRow | null {
  if (alert.dedupe_key) {
    const open = db
      .prepare('SELECT id FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL')
      .get(alert.dedupe_key);
    if (open) return null;
  }
  const row: AlertRow = {
    id: id('alr'),
    ts: now(),
    severity: alert.severity,
    type: alert.type,
    project_id: alert.project_id ?? null,
    service_id: alert.service_id ?? null,
    title: alert.title,
    message: alert.message,
    explanation: alert.explanation ?? null,
    dedupe_key: alert.dedupe_key ?? null,
    resolved_at: null,
    read_at: null,
  };
  db.prepare(
    `INSERT INTO alerts (id, ts, severity, type, project_id, service_id, workspace_id, title, message, explanation, dedupe_key, resolved_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.ts, row.severity, row.type, row.project_id, row.service_id, alert.workspace_id ?? null, row.title, row.message, row.explanation, row.dedupe_key, row.resolved_at, row.read_at);
  return row;
}

/** Alertas por cuenta de cliente, para la vista del workspace. */
export function listWorkspaceAlerts(workspaceId: string, openOnly = true): AlertRow[] {
  const sql = openOnly
    ? 'SELECT * FROM alerts WHERE workspace_id = ? AND resolved_at IS NULL ORDER BY ts DESC LIMIT 50'
    : 'SELECT * FROM alerts WHERE workspace_id = ? ORDER BY ts DESC LIMIT 50';
  return db.prepare(sql).all(workspaceId) as AlertRow[];
}

export function listAlerts(opts: { limit?: number; openOnly?: boolean; projectIds?: string[] } = {}): AlertRow[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.openOnly) where.push('resolved_at IS NULL');
  if (opts.projectIds) {
    // Restricción por workspaces: las alertas de servidor (sin proyecto) quedan fuera.
    if (opts.projectIds.length === 0) return [];
    where.push(`project_id IN (${opts.projectIds.map(() => '?').join(',')})`);
    params.push(...opts.projectIds);
  }
  const sql = `SELECT * FROM alerts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit) as AlertRow[];
}

export function getAlert(alertId: string): AlertRow | undefined {
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as AlertRow | undefined;
}

export function countUnreadAlerts(projectIds?: string[]): number {
  if (projectIds) {
    if (projectIds.length === 0) return 0;
    const sql = `SELECT COUNT(*) AS c FROM alerts WHERE read_at IS NULL AND project_id IN (${projectIds.map(() => '?').join(',')})`;
    return (db.prepare(sql).get(...projectIds) as any).c;
  }
  return (db.prepare('SELECT COUNT(*) AS c FROM alerts WHERE read_at IS NULL').get() as any).c;
}

export function markAlertsRead(projectIds?: string[]): void {
  if (projectIds) {
    if (projectIds.length === 0) return;
    const sql = `UPDATE alerts SET read_at = ? WHERE read_at IS NULL AND project_id IN (${projectIds.map(() => '?').join(',')})`;
    db.prepare(sql).run(now(), ...projectIds);
    return;
  }
  db.prepare('UPDATE alerts SET read_at = ? WHERE read_at IS NULL').run(now());
}

export function resolveAlert(alertId: string): boolean {
  const res = db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now(), alertId);
  return res.changes > 0;
}

export function resolveAlertsByDedupe(dedupeKey: string): AlertRow[] {
  const open = db
    .prepare('SELECT * FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL')
    .all(dedupeKey) as AlertRow[];
  if (open.length > 0) {
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL').run(now(), dedupeKey);
  }
  return open;
}

/**
 * Resuelve las alertas abiertas de un servicio para un tipo, por (service_id, type)
 * en vez de por dedupe_key. Equivale a la clave para las alertas bien formadas
 * (su dedupe_key es `${serviceId}:${type}`) pero además limpia las heredadas sin
 * clave (p. ej. `deploy_failed` antiguas), que si no se quedarían abiertas para siempre.
 */
export function resolveOpenServiceAlerts(serviceId: string, type: string): AlertRow[] {
  const open = db
    .prepare('SELECT * FROM alerts WHERE service_id = ? AND type = ? AND resolved_at IS NULL')
    .all(serviceId, type) as AlertRow[];
  if (open.length > 0) {
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE service_id = ? AND type = ? AND resolved_at IS NULL').run(
      now(),
      serviceId,
      type,
    );
  }
  return open;
}

/**
 * Incidencias para la página de estado: alertas de los tipos dados, abiertas
 * o resueltas después de `resolvedSince`. Consulta dedicada — pasar por la
 * ventana de listAlerts podía expulsar una incidencia abierta si había >100
 * alertas más recientes de otros tipos.
 */
export function listProjectIncidents(projectId: string, types: string[], resolvedSince: number): AlertRow[] {
  if (types.length === 0) return [];
  const placeholders = types.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM alerts WHERE project_id = ? AND type IN (${placeholders})
       AND (resolved_at IS NULL OR resolved_at > ?) ORDER BY ts DESC LIMIT 20`,
    )
    .all(projectId, ...types, resolvedSince) as AlertRow[];
}

/** Metadatos de actividad por proyecto para el panel: último despliegue y alertas abiertas. */
export interface ProjectDashboardMeta {
  lastDeployAt: number | null;
  openAlerts: number;
  /** Despliegues en marcha: el panel avisa de que hay versiones saliendo. */
  activeDeploys: number;
}

export function projectDashboardMeta(): Record<string, ProjectDashboardMeta> {
  const out: Record<string, ProjectDashboardMeta> = {};
  const entry = (pid: string): ProjectDashboardMeta =>
    (out[pid] ??= { lastDeployAt: null, openAlerts: 0, activeDeploys: 0 });

  const deploys = db
    .prepare('SELECT s.project_id AS pid, MAX(d.created_at) AS m FROM deployments d JOIN services s ON s.id = d.service_id GROUP BY s.project_id')
    .all() as { pid: string; m: number }[];
  for (const r of deploys) entry(r.pid).lastDeployAt = r.m;

  const alerts = db
    .prepare('SELECT project_id AS pid, COUNT(*) AS c FROM alerts WHERE resolved_at IS NULL AND project_id IS NOT NULL GROUP BY project_id')
    .all() as { pid: string; c: number }[];
  for (const r of alerts) entry(r.pid).openAlerts = r.c;

  const running = db
    .prepare(
      `SELECT s.project_id AS pid, COUNT(*) AS c
         FROM deployments d JOIN services s ON s.id = d.service_id
        WHERE d.status IN ('queued', 'building', 'deploying')
        GROUP BY s.project_id`,
    )
    .all() as { pid: string; c: number }[];
  for (const r of running) entry(r.pid).activeDeploys = r.c;

  return out;
}

export function openAlertCountsByService(projectId: string): Record<string, number> {
  const rows = db
    .prepare('SELECT service_id, COUNT(*) AS c FROM alerts WHERE project_id = ? AND resolved_at IS NULL AND service_id IS NOT NULL GROUP BY service_id')
    .all(projectId) as { service_id: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.service_id] = r.c;
  return out;
}

export function markStaleDeploymentsFailed(): number {
  const res = db
    .prepare(
      `UPDATE deployments SET status = 'failed', error = 'Interrumpido por reinicio del servidor', finished_at = ?
       WHERE status IN ('queued', 'building', 'deploying')`,
    )
    .run(now());
  return res.changes;
}

// ---------- planes de facturación ----------
export function listPlans(includeArchived = true): PlanRow[] {
  const sql = includeArchived
    ? 'SELECT * FROM plans ORDER BY price_cents ASC, created_at ASC'
    : 'SELECT * FROM plans WHERE archived = 0 ORDER BY price_cents ASC, created_at ASC';
  return db.prepare(sql).all() as PlanRow[];
}

export function getPlan(planId: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
}

export function getDefaultPlan(): PlanRow | undefined {
  return db.prepare('SELECT * FROM plans WHERE is_default = 1 AND archived = 0 ORDER BY created_at ASC LIMIT 1').get() as
    | PlanRow
    | undefined;
}

export function planSlugExists(slug: string): boolean {
  return !!db.prepare('SELECT 1 FROM plans WHERE slug = ?').get(slug);
}

type PlanInput = Omit<PlanRow, 'id' | 'slug' | 'created_at'>;

export function createPlan(name: string, fields: Omit<PlanInput, 'name'>): PlanRow {
  let slug = slugify(name);
  let i = 2;
  while (planSlugExists(slug)) slug = `${slugify(name)}-${i++}`;
  const row: PlanRow = { ...fields, name, id: id('pln'), slug, created_at: now() };
  db.prepare(
    `INSERT INTO plans (id, name, slug, price_cents, currency, interval, cpu_cores, memory_mb, disk_mb, max_projects, max_services, max_members, modules, is_default, archived, discount_pct, created_at)
     VALUES (@id, @name, @slug, @price_cents, @currency, @interval, @cpu_cores, @memory_mb, @disk_mb, @max_projects, @max_services, @max_members, @modules, @is_default, @archived, @discount_pct, @created_at)`,
  ).run(row);
  if (row.is_default) clearOtherDefaultPlans(row.id);
  return row;
}

const PLAN_COLUMNS = new Set([
  'name', 'price_cents', 'currency', 'interval', 'cpu_cores', 'memory_mb', 'disk_mb',
  'max_projects', 'max_services', 'max_members', 'modules', 'is_default', 'archived', 'discount_pct',
]);

export function updatePlan(planId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields).filter((k) => PLAN_COLUMNS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE plans SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), planId);
  if (fields.is_default === 1) clearOtherDefaultPlans(planId);
}

function clearOtherDefaultPlans(keepId: string): void {
  db.prepare('UPDATE plans SET is_default = 0 WHERE id <> ?').run(keepId);
}

export function deletePlan(planId: string): void {
  db.prepare('DELETE FROM plans WHERE id = ?').run(planId);
}

export function countWorkspacesOnPlan(planId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM workspaces WHERE plan_id = ?').get(planId) as any).c;
}

// ---------- workspaces (cuentas de cliente) ----------
function uniqueWorkspaceSlug(name: string): string {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  while (db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(slug)) slug = `${base}-${i++}`;
  return slug;
}

export interface WorkspaceInit {
  plan_id?: string | null;
  cpu_cores?: number | null;
  memory_mb?: number | null;
  disk_mb?: number | null;
  max_projects?: number | null;
  max_services?: number | null;
  max_members?: number | null;
  modules_override?: string | null;
  billing_email?: string | null;
  billing_day?: number;
  notes?: string | null;
}

/** Crea un workspace con valores por defecto (las cuotas en null heredan del plan). */
export function createWorkspaceRow(name: string, init: WorkspaceInit = {}): WorkspaceRow {
  const row: WorkspaceRow = {
    id: id('wsp'),
    name,
    slug: uniqueWorkspaceSlug(name),
    plan_id: init.plan_id ?? null,
    cpu_cores: init.cpu_cores ?? null,
    memory_mb: init.memory_mb ?? null,
    disk_mb: init.disk_mb ?? null,
    max_projects: init.max_projects ?? null,
    max_services: init.max_services ?? null,
    max_members: init.max_members ?? null,
    modules_override: init.modules_override ?? null,
    owner_disabled_modules: '[]',
    status: 'active',
    billing_email: init.billing_email ?? null,
    billing_tax_id: null,
    billing_address: null,
    billing_country: DEFAULT_COUNTRY,
    billing_day: init.billing_day ?? 1,
    discount_pct: null, // hereda el descuento del plan mientras no se fije uno propio
    // Ancla del aniversario de las cuotas anuales: la contratación del plan.
    plan_since: init.plan_id ? now() : null,
    // La facturación arranca en el alta: el primer ciclo se prorratea desde aquí.
    last_billed_period_end: now(),
    dunning_stage: 0,
    dunning_since: null,
    last_dunning_action_at: null,
    dunning_exempt: 0,
    ai_suspended: 0,
    notes: init.notes ?? null,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, plan_id, cpu_cores, memory_mb, disk_mb, max_projects, max_services, max_members, modules_override, owner_disabled_modules, status, billing_email, billing_tax_id, billing_address, billing_country, billing_day, plan_since, last_billed_period_end, notes, created_at)
     VALUES (@id, @name, @slug, @plan_id, @cpu_cores, @memory_mb, @disk_mb, @max_projects, @max_services, @max_members, @modules_override, @owner_disabled_modules, @status, @billing_email, @billing_tax_id, @billing_address, @billing_country, @billing_day, @plan_since, @last_billed_period_end, @notes, @created_at)`,
  ).run(row);
  // Primer tramo del historial de plan: desde la contratación (o el alta si no hay plan).
  recordPlanChange(row.id, row.plan_id, row.plan_since ?? row.created_at);
  return row;
}

export function listWorkspaces(): WorkspaceRow[] {
  return db.prepare('SELECT * FROM workspaces ORDER BY name ASC').all() as WorkspaceRow[];
}

/**
 * Reutiliza el workspace cuyo nombre coincide (sin distinguir mayúsculas ni
 * espacios) o crea uno nuevo con el plan por defecto. Fuente única para asignar
 * un proyecto a un cliente por su nombre (creación e importación de Railway).
 */
export function getOrCreateWorkspaceByName(name: string): WorkspaceRow {
  const key = name.trim().toLowerCase();
  const existing = (db.prepare('SELECT * FROM workspaces').all() as WorkspaceRow[]).find(
    (w) => w.name.trim().toLowerCase() === key,
  );
  if (existing) return existing;
  return createWorkspaceRow(name.trim(), { plan_id: getDefaultPlan()?.id ?? null });
}

export function getWorkspace(workspaceId: string): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
}

const WORKSPACE_COLUMNS = new Set([
  'name', 'plan_id', 'cpu_cores', 'memory_mb', 'disk_mb', 'max_projects', 'max_services',
  'max_members', 'modules_override', 'owner_disabled_modules', 'status', 'billing_email',
  'billing_tax_id', 'billing_address', 'billing_country', 'billing_day', 'discount_pct', 'notes',
  'ai_suspended', 'dunning_stage', 'dunning_since', 'last_dunning_action_at', 'dunning_exempt',
  'plan_since', 'last_billed_period_end',
]);

export function updateWorkspace(workspaceId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields).filter((k) => WORKSPACE_COLUMNS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE workspaces SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), workspaceId);
  // Al renombrar, refresca el reflejo denormalizado en sus proyectos (agrupación de la UI).
  if (typeof fields.name === 'string') {
    db.prepare('UPDATE projects SET client = ? WHERE workspace_id = ?').run(fields.name, workspaceId);
  }
}

export function deleteWorkspace(workspaceId: string): void {
  // Los proyectos quedan sin asignar (no se borran): SET NULL manual + limpia el reflejo.
  db.prepare('UPDATE projects SET workspace_id = NULL, client = NULL WHERE workspace_id = ?').run(workspaceId);
  // Los sub-usuarios del workspace se quedan huérfanos: se borran en cascada lógica desde la ruta.
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
}

// ---------- historial de plan por tramos ----------
/**
 * Abre un tramo nuevo en el historial de plan y cierra el vigente. Idempotente
 * frente a un PATCH que no toca el plan: si el tramo abierto ya es de ese plan, no
 * parte nada (si no, editar el nombre de la cuenta trocearía el historial).
 */
export function recordPlanChange(workspaceId: string, planId: string | null, atMs = now()): void {
  const abierto = db
    .prepare('SELECT * FROM workspace_plan_periods WHERE workspace_id = ? AND to_ms IS NULL ORDER BY from_ms DESC LIMIT 1')
    .get(workspaceId) as PlanPeriodRow | undefined;
  if (abierto && abierto.plan_id === planId) return;
  const plan = planId ? getPlan(planId) : undefined;
  db.transaction(() => {
    if (abierto) {
      // Un tramo que se cerraría en su propio instante de apertura (dos cambios de
      // plan seguidos) no cubre nada y solo ensuciaría el historial: se descarta.
      if (abierto.from_ms >= atMs) db.prepare('DELETE FROM workspace_plan_periods WHERE id = ?').run(abierto.id);
      else db.prepare('UPDATE workspace_plan_periods SET to_ms = ? WHERE id = ?').run(atMs, abierto.id);
    }
    db.prepare(
      `INSERT INTO workspace_plan_periods (id, workspace_id, plan_id, plan_name, price_cents, currency, interval, from_ms, to_ms, created_at)
       VALUES (@id, @workspace_id, @plan_id, @plan_name, @price_cents, @currency, @interval, @from_ms, NULL, @created_at)`,
    ).run({
      id: id('wpp'),
      workspace_id: workspaceId,
      plan_id: planId,
      plan_name: plan?.name ?? null,
      price_cents: plan?.price_cents ?? null,
      currency: plan?.currency ?? null,
      interval: plan?.interval ?? null,
      from_ms: atMs,
      created_at: now(),
    });
  })();
}

/**
 * Tramos del historial que solapan `[from, to)`, del más antiguo al más reciente.
 * Devuelve vacío si la cuenta no tiene historial; quien factura decide entonces el
 * respaldo (el plan vigente para todo el ciclo, que es lo que se hacía antes).
 */
export function listPlanPeriodsInRange(workspaceId: string, from: number, to: number): PlanPeriodRow[] {
  return db
    .prepare(
      `SELECT * FROM workspace_plan_periods
        WHERE workspace_id = ? AND from_ms < ? AND (to_ms IS NULL OR to_ms > ?)
        ORDER BY from_ms ASC`,
    )
    .all(workspaceId, to, from) as PlanPeriodRow[];
}

/** Historial completo de una cuenta, del más reciente al más antiguo (ficha y auditoría). */
export function listPlanPeriods(workspaceId: string): PlanPeriodRow[] {
  return db
    .prepare('SELECT * FROM workspace_plan_periods WHERE workspace_id = ? ORDER BY from_ms DESC')
    .all(workspaceId) as PlanPeriodRow[];
}

/**
 * Primera vez que la cuenta contrató ese plan. Ancla el aniversario de una cuota
 * ANUAL: anclarlo en el tramo haría que irse y volver al mismo plan dentro del año
 * devengara una segunda anualidad ya cobrada.
 */
export function planContractedSince(workspaceId: string, planId: string): number | null {
  const row = db
    .prepare('SELECT MIN(from_ms) AS m FROM workspace_plan_periods WHERE workspace_id = ? AND plan_id = ?')
    .get(workspaceId, planId) as { m: number | null };
  return row.m ?? null;
}

/**
 * Abre el primer tramo de las cuentas que aún no tienen historial, en la fecha de
 * contratación del plan (o el alta). Sin esto, el primer ciclo tras el despliegue
 * caería al respaldo «plan vigente todo el ciclo» para siempre. Se reintenta
 * mientras queden cuentas sin tramo, y `createWorkspaceRow` abre el suyo, así que
 * las nuevas nunca dependen de esta migración.
 */
function backfillPlanPeriods(): void {
  if (getSetting('migrations:plan_periods_v1') === 'done') return;
  db.transaction(() => {
    const sinHistorial = db
      .prepare(
        `SELECT w.id, w.plan_id, w.plan_since, w.created_at FROM workspaces w
          WHERE NOT EXISTS (SELECT 1 FROM workspace_plan_periods p WHERE p.workspace_id = w.id)`,
      )
      .all() as { id: string; plan_id: string | null; plan_since: number | null; created_at: number }[];
    for (const w of sinHistorial) recordPlanChange(w.id, w.plan_id, w.plan_since ?? w.created_at);
    setSetting('migrations:plan_periods_v1', 'done');
  })();
}

// ---------- cuota agregada del workspace (a todos sus proyectos en total) ----------
/** Todos los servicios de todos los proyectos de un workspace (para la cuota agregada). */
export function listWorkspaceServices(workspaceId: string): ServiceRow[] {
  return (
    db
      .prepare(
        `SELECT s.* FROM services s JOIN projects p ON p.id = s.project_id WHERE p.workspace_id = ? ORDER BY s.created_at ASC`,
      )
      .all(workspaceId) as any[]
  ).map(parseService);
}

export function countWorkspaceServices(workspaceId: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM services s JOIN projects p ON p.id = s.project_id WHERE p.workspace_id = ?')
      .get(workspaceId) as any
  ).c;
}

/** Suma del histórico de consumo del workspace en un rango horario, para facturación/uso. */
export function workspaceUsageRange(
  workspaceId: string,
  fromHour: number,
  toHour: number,
): { buckets: number; cpuCorePctHours: number; memByteHours: number; cpuMax: number; memMax: number; diskMax: number } {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS buckets,
         COALESCE(SUM(CASE WHEN m.samples > 0 THEN m.cpu_sum * 1.0 / m.samples ELSE 0 END), 0) AS cpuCorePctHours,
         COALESCE(SUM(CASE WHEN m.samples > 0 THEN m.mem_sum * 1.0 / m.samples ELSE 0 END), 0) AS memByteHours,
         COALESCE(MAX(m.cpu_max), 0) AS cpuMax,
         COALESCE(MAX(m.mem_max), 0) AS memMax,
         COALESCE(MAX(m.disk_last), 0) AS diskMax
       FROM service_metrics_hourly m
       WHERE m.workspace_id = ? AND m.hour >= ? AND m.hour < ?`,
    )
    .get(workspaceId, fromHour, toHour) as any;
  return {
    buckets: row.buckets,
    cpuCorePctHours: row.cpuCorePctHours,
    memByteHours: row.memByteHours,
    cpuMax: row.cpuMax,
    memMax: row.memMax,
    diskMax: row.diskMax,
  };
}

// ---------- facturas ----------
export function listInvoices(workspaceId: string): InvoiceRow[] {
  return db
    .prepare('SELECT * FROM workspace_invoices WHERE workspace_id = ? ORDER BY period_start DESC, created_at DESC')
    .all(workspaceId) as InvoiceRow[];
}

export function getInvoice(invoiceId: string): InvoiceRow | undefined {
  return db.prepare('SELECT * FROM workspace_invoices WHERE id = ?').get(invoiceId) as InvoiceRow | undefined;
}

/** Valores por defecto de las columnas fiscales/opcionales de una factura nueva. */
const INVOICE_DEFAULTS = {
  series_id: null, number: null, invoice_type: 'normal', rectifies_invoice_id: null, rectify_reason: null,
  operation_date: null, tax_breakdown: '[]', vat_regime: 'general', legal_mentions: null,
  irpf_rate: 0, irpf_cents: 0, issuer_snapshot: null, client_name: null, client_tax_id: null,
  client_address: null, client_country: null, origin: 'manual', plan_name: null, payment_method: null, stripe_session_id: null,
  stripe_url: null, issued_at: null, due_at: null, paid_at: null, locked: 0, notes: null,
} as const;

type InvoiceCore = Pick<
  InvoiceRow,
  'workspace_id' | 'period_start' | 'period_end' | 'status' | 'currency' | 'subtotal_cents' | 'tax_cents' | 'tax_rate' | 'total_cents' | 'lines'
>;

export function createInvoice(row: InvoiceCore & Partial<InvoiceRow>): InvoiceRow {
  const full: InvoiceRow = { ...INVOICE_DEFAULTS, ...row, id: id('inv'), created_at: now() };
  db.prepare(
    `INSERT INTO workspace_invoices (
       id, workspace_id, series_id, number, invoice_type, rectifies_invoice_id, rectify_reason,
       period_start, period_end, operation_date, status, currency, subtotal_cents, tax_cents, tax_rate,
       tax_breakdown, vat_regime, legal_mentions, irpf_rate, irpf_cents, total_cents, lines, plan_name,
       issuer_snapshot, client_name, client_tax_id, client_address, client_country, origin, payment_method, stripe_session_id,
       stripe_url, issued_at, due_at, paid_at, locked, notes, created_at)
     VALUES (
       @id, @workspace_id, @series_id, @number, @invoice_type, @rectifies_invoice_id, @rectify_reason,
       @period_start, @period_end, @operation_date, @status, @currency, @subtotal_cents, @tax_cents, @tax_rate,
       @tax_breakdown, @vat_regime, @legal_mentions, @irpf_rate, @irpf_cents, @total_cents, @lines, @plan_name,
       @issuer_snapshot, @client_name, @client_tax_id, @client_address, @client_country, @origin, @payment_method, @stripe_session_id,
       @stripe_url, @issued_at, @due_at, @paid_at, @locked, @notes, @created_at)`,
  ).run(full);
  return full;
}

const INVOICE_COLUMNS = new Set([
  'series_id', 'number', 'invoice_type', 'rectifies_invoice_id', 'rectify_reason', 'period_start',
  'period_end', 'operation_date', 'status', 'currency', 'subtotal_cents', 'tax_cents', 'tax_rate',
  'tax_breakdown', 'vat_regime', 'legal_mentions', 'irpf_rate', 'irpf_cents', 'total_cents', 'lines',
  'plan_name', 'issuer_snapshot', 'client_name', 'client_tax_id', 'client_address', 'client_country', 'payment_method',
  'stripe_session_id', 'stripe_url', 'issued_at', 'due_at', 'paid_at', 'locked', 'notes',
]);

export function updateInvoice(invoiceId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields).filter((k) => INVOICE_COLUMNS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE workspace_invoices SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), invoiceId);
}

/**
 * Devuelve a «pendiente» los cargos puntuales que estaban enlazados a una factura
 * (al borrarla o anularla), para que no se pierdan y vuelvan a la próxima factura.
 */
export function reopenChargesForInvoice(invoiceId: string): void {
  db.prepare("UPDATE pending_charges SET status = 'pending', invoice_id = NULL WHERE invoice_id = ? AND status = 'invoiced'").run(invoiceId);
}

/**
 * Devuelve a «pendiente» los cargos enlazados a una factura que ya NO figuran
 * entre sus líneas (el operador los quitó al editar el borrador), para que entren
 * en el ciclo siguiente. Los que siguen presentes no se tocan.
 */
export function reopenChargesNotIn(invoiceId: string, keepIds: string[]): void {
  const marcadores = keepIds.map(() => '?').join(',');
  const sql = keepIds.length
    ? `UPDATE pending_charges SET status = 'pending', invoice_id = NULL WHERE invoice_id = ? AND status = 'invoiced' AND id NOT IN (${marcadores})`
    : "UPDATE pending_charges SET status = 'pending', invoice_id = NULL WHERE invoice_id = ? AND status = 'invoiced'";
  db.prepare(sql).run(invoiceId, ...keepIds);
}

export function deleteInvoice(invoiceId: string): void {
  db.transaction(() => {
    reopenChargesForInvoice(invoiceId); // no perder los cargos enlazados
    db.prepare('DELETE FROM workspace_invoices WHERE id = ?').run(invoiceId);
  })();
}

export function getInvoiceByStripeSession(sessionId: string): InvoiceRow | undefined {
  return db.prepare('SELECT * FROM workspace_invoices WHERE stripe_session_id = ?').get(sessionId) as InvoiceRow | undefined;
}

/** ¿Tiene el workspace facturas (opcionalmente solo las que ya no son borrador)? */
export function workspaceHasInvoices(workspaceId: string, nonDraftOnly = false): boolean {
  const sql = nonDraftOnly
    ? "SELECT 1 FROM workspace_invoices WHERE workspace_id = ? AND status <> 'draft' LIMIT 1"
    : 'SELECT 1 FROM workspace_invoices WHERE workspace_id = ? LIMIT 1';
  return !!db.prepare(sql).get(workspaceId);
}

/**
 * Asigna atómicamente el siguiente número de una serie por ejercicio (crea la
 * serie si no existe). El número incluye el año para reiniciar la numeración
 * cada ejercicio (p. ej. «FRA-2026-0001»). Sustituye al antiguo contador global.
 */
export function assignSeriesNumber(opts: {
  code: string;
  year: number;
  prefix: string;
  kind: InvoiceSeriesRow['kind'];
  padding?: number;
}): { seriesId: string; number: string; seq: number } {
  return db.transaction(() => {
    let s = db.prepare('SELECT * FROM invoice_series WHERE code = ? AND year = ?').get(opts.code, opts.year) as
      | InvoiceSeriesRow
      | undefined;
    if (!s) {
      s = {
        id: id('ser'), code: opts.code, year: opts.year, prefix: opts.prefix,
        padding: opts.padding ?? 4, next_seq: 1, kind: opts.kind, created_at: now(),
      };
      db.prepare(
        'INSERT INTO invoice_series (id, code, year, prefix, padding, next_seq, kind, created_at) VALUES (@id, @code, @year, @prefix, @padding, @next_seq, @kind, @created_at)',
      ).run(s);
    } else if (s.kind !== opts.kind) {
      // Las rectificativas exigen serie propia (art. 6.1.a RD 1619/2012). Si el
      // código pedido ya existe con otra naturaleza, numerar aquí mezclaría ambas
      // en la misma serie correlativa: se corta antes de asignar número.
      throw new Error(
        `La serie «${opts.code}» del ejercicio ${opts.year} ya está en uso para facturas de tipo «${s.kind}» y no puede compartirse con «${opts.kind}». Cambia el prefijo de factura en Contabilidad.`,
      );
    }
    const seq = s.next_seq;
    db.prepare('UPDATE invoice_series SET next_seq = ? WHERE id = ?').run(seq + 1, s.id);
    const p = (s.prefix || '').trim();
    const number = `${p}${p ? '-' : ''}${opts.year}-${String(seq).padStart(s.padding, '0')}`;
    return { seriesId: s.id, number, seq };
  })();
}

export function listInvoiceSeries(): InvoiceSeriesRow[] {
  return db.prepare('SELECT * FROM invoice_series ORDER BY year DESC, code ASC').all() as InvoiceSeriesRow[];
}

/** Todas las facturas de todos los workspaces, con el nombre del cliente, para la contabilidad. */
export function listAllInvoices(filter: { status?: string; fromMs?: number; toMs?: number } = {}): (InvoiceRow & { workspace_name: string | null })[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('i.status = ?');
    params.push(filter.status);
  }
  if (filter.fromMs !== undefined) {
    where.push('i.period_start >= ?');
    params.push(filter.fromMs);
  }
  if (filter.toMs !== undefined) {
    where.push('i.period_start < ?');
    params.push(filter.toMs);
  }
  const sql = `SELECT i.*, w.name AS workspace_name FROM workspace_invoices i
     LEFT JOIN workspaces w ON w.id = i.workspace_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY i.created_at DESC`;
  return db.prepare(sql).all(...params) as (InvoiceRow & { workspace_name: string | null })[];
}

/**
 * Serie de uso agregado del workspace por cubos (para las gráficas): núcleo·h y
 * GB·h de RAM por cubo, foto de disco y tráfico de red. Rellena la rejilla con
 * ceros en los cubos sin datos para que el eje temporal sea continuo.
 */
export function workspaceUsageSeries(
  workspaceId: string,
  fromHour: number,
  toHour: number,
  bucketHours: number,
): { t: number; cpuCoreHours: number; ramGbHours: number; diskGb: number; netBytes: number }[] {
  const rows = db
    .prepare(
      // CAST a INTEGER: la división debe ser entera (cubo por día/hora); si no, la
      // clave sale fraccionaria y no casa con la rejilla entera del bucle de abajo.
      `SELECT CAST(m.hour / ? AS INTEGER) AS bucket,
         COALESCE(SUM(CASE WHEN m.samples > 0 THEN m.cpu_sum * 1.0 / m.samples ELSE 0 END), 0) AS cpuPctHours,
         COALESCE(SUM(CASE WHEN m.samples > 0 THEN m.mem_sum * 1.0 / m.samples ELSE 0 END), 0) AS memByteHours,
         COALESCE(MAX(m.disk_last), 0) AS diskLast,
         COALESCE(SUM(m.net_rx + m.net_tx), 0) AS netBytes
       FROM service_metrics_hourly m
       WHERE m.workspace_id = ? AND m.hour >= ? AND m.hour < ?
       GROUP BY bucket`,
    )
    .all(bucketHours, workspaceId, fromHour, toHour) as {
    bucket: number;
    cpuPctHours: number;
    memByteHours: number;
    diskLast: number;
    netBytes: number;
  }[];
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const out: { t: number; cpuCoreHours: number; ramGbHours: number; diskGb: number; netBytes: number }[] = [];
  for (let b = Math.floor(fromHour / bucketHours); b < Math.ceil(toHour / bucketHours); b++) {
    const r = byBucket.get(b);
    out.push({
      t: b * bucketHours * 3_600_000,
      cpuCoreHours: r ? Math.round((r.cpuPctHours / 100) * 100) / 100 : 0,
      ramGbHours: r ? Math.round((r.memByteHours / 1e9) * 100) / 100 : 0,
      diskGb: r ? Math.round((r.diskLast / 1e9) * 100) / 100 : 0,
      netBytes: r ? r.netBytes : 0,
    });
  }
  return out;
}

/**
 * Consumo por proyecto del workspace en un rango (top de consumidores / insights).
 * Se filtra por el titular CONGELADO, igual que la facturación, para que el
 * desglose cuadre con el total y con la factura. El JOIN se conserva solo para
 * poner el nombre del proyecto: el consumo de un servicio ya borrado sigue
 * contando en el total pero no aparece aquí (no hay proyecto que nombrar).
 */
export function workspaceUsageByProject(
  workspaceId: string,
  fromHour: number,
  toHour: number,
): { projectId: string; name: string; cpuCoreHours: number; ramGbHours: number }[] {
  return db
    .prepare(
      `SELECT p.id AS projectId, p.name AS name,
         COALESCE(SUM(CASE WHEN m.samples > 0 THEN m.cpu_sum * 1.0 / m.samples ELSE 0 END), 0) / 100.0 AS cpuCoreHours,
         COALESCE(SUM(CASE WHEN m.samples > 0 THEN m.mem_sum * 1.0 / m.samples ELSE 0 END), 0) / 1e9 AS ramGbHours
       FROM service_metrics_hourly m
       JOIN services s ON s.id = m.service_id
       JOIN projects p ON p.id = s.project_id
       WHERE m.workspace_id = ? AND m.hour >= ? AND m.hour < ?
       GROUP BY p.id
       ORDER BY cpuCoreHours DESC`,
    )
    .all(workspaceId, fromHour, toHour) as { projectId: string; name: string; cpuCoreHours: number; ramGbHours: number }[];
}

// ---------- catálogo multimodular ----------
function uniqueProductSlug(name: string): string {
  const base = slugify(name) || 'producto';
  let candidate = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM catalog_products WHERE slug = ?').get(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

export function listProducts(includeArchived = false): ProductRow[] {
  const sql = includeArchived
    ? 'SELECT * FROM catalog_products ORDER BY archived ASC, category ASC, name ASC'
    : 'SELECT * FROM catalog_products WHERE archived = 0 ORDER BY category ASC, name ASC';
  return db.prepare(sql).all() as ProductRow[];
}

export function getProduct(productId: string): ProductRow | undefined {
  return db.prepare('SELECT * FROM catalog_products WHERE id = ?').get(productId) as ProductRow | undefined;
}

const PRODUCT_DEFAULTS = {
  category: 'custom', billing_model: 'flat_one_off', price_cents: 0, currency: 'EUR', interval: 'one_off',
  unit: '', unit_size: 1, meter: null, tier_mode: null, tax_rate: 21, irpf_rate: 0, tax_exempt: 0, modules: '[]',
  description: null, active: 1, archived: 0,
} as const;

export function createProduct(row: Pick<ProductRow, 'name'> & Partial<ProductRow>): ProductRow {
  const full: ProductRow = { ...PRODUCT_DEFAULTS, ...row, id: id('prd'), slug: uniqueProductSlug(row.name), created_at: now() };
  db.prepare(
    `INSERT INTO catalog_products (id, name, slug, category, billing_model, price_cents, currency, interval, unit, unit_size, meter, tier_mode, tax_rate, irpf_rate, tax_exempt, modules, description, active, archived, created_at)
     VALUES (@id, @name, @slug, @category, @billing_model, @price_cents, @currency, @interval, @unit, @unit_size, @meter, @tier_mode, @tax_rate, @irpf_rate, @tax_exempt, @modules, @description, @active, @archived, @created_at)`,
  ).run(full);
  return full;
}

const PRODUCT_COLUMNS = new Set([
  'name', 'category', 'billing_model', 'price_cents', 'currency', 'interval', 'unit', 'unit_size', 'meter', 'tier_mode',
  'tax_rate', 'irpf_rate', 'tax_exempt', 'modules', 'description', 'active', 'archived',
]);

export function updateProduct(productId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields).filter((k) => PRODUCT_COLUMNS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE catalog_products SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), productId);
}

export function deleteProduct(productId: string): void {
  db.prepare('DELETE FROM catalog_products WHERE id = ?').run(productId);
}

/** ¿Hay alguna suscripción (activa o pausada) que use este producto? */
/**
 * ¿Hay alguna suscripción que referencie el producto? Cuenta TAMBIÉN las
 * canceladas: la clave foránea es `ON DELETE RESTRICT`, así que una suscripción
 * cancelada impide igualmente borrar el producto. Filtrar por estado hacía que la
 * UI ofreciera un borrado que la BD rechazaba con un 500 opaco.
 */
export function productInUse(productId: string): boolean {
  return !!db.prepare('SELECT 1 FROM workspace_subscriptions WHERE product_id = ? LIMIT 1').get(productId);
}

export function listTiers(productId: string): PriceTierRow[] {
  return db.prepare('SELECT * FROM catalog_price_tiers WHERE product_id = ? ORDER BY sort ASC').all(productId) as PriceTierRow[];
}

/** Reemplaza el conjunto de tramos de un producto (todo o nada). */
export function replaceTiers(productId: string, tiers: { upTo: number | null; unitCents: number; flatCents: number }[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM catalog_price_tiers WHERE product_id = ?').run(productId);
    const ins = db.prepare(
      'INSERT INTO catalog_price_tiers (id, product_id, up_to, unit_cents, flat_cents, sort, created_at) VALUES (@id, @product_id, @up_to, @unit_cents, @flat_cents, @sort, @created_at)',
    );
    tiers.forEach((t, i) =>
      ins.run({ id: id('tir'), product_id: productId, up_to: t.upTo, unit_cents: t.unitCents, flat_cents: t.flatCents, sort: i, created_at: now() }),
    );
  })();
}

// ---------- suscripciones ----------
export function listSubscriptions(workspaceId: string): SubscriptionRow[] {
  return db
    .prepare("SELECT * FROM workspace_subscriptions WHERE workspace_id = ? ORDER BY status ASC, created_at DESC")
    .all(workspaceId) as SubscriptionRow[];
}

export function listActiveSubscriptions(workspaceId: string): SubscriptionRow[] {
  return db
    .prepare("SELECT * FROM workspace_subscriptions WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC")
    .all(workspaceId) as SubscriptionRow[];
}

/**
 * Suscripciones que hay que FACTURAR en un ciclo: las activas y, además, las que
 * se cancelaron o pausaron DENTRO del ciclo, porque el servicio se prestó hasta
 * ese momento y se cobra prorrateado. Filtrar solo por `status='active'` regalaba
 * el periodo servido de toda baja a mitad de mes.
 */
export function listBillableSubscriptions(workspaceId: string, cycleStart: number): SubscriptionRow[] {
  return db
    .prepare(
      `SELECT * FROM workspace_subscriptions
       WHERE workspace_id = ?
         AND (status = 'active' OR (status IN ('cancelled','paused') AND COALESCE(status_changed_at, cancelled_at) >= ?))
       ORDER BY created_at ASC`,
    )
    .all(workspaceId, cycleStart) as SubscriptionRow[];
}

export function getSubscription(subId: string): SubscriptionRow | undefined {
  return db.prepare('SELECT * FROM workspace_subscriptions WHERE id = ?').get(subId) as SubscriptionRow | undefined;
}

export function createSubscription(row: Omit<SubscriptionRow, 'id' | 'created_at' | 'status_changed_at' | 'paused_by'>): SubscriptionRow {
  const full: SubscriptionRow = { ...row, id: id('sub'), status_changed_at: row.started_at, paused_by: null, created_at: now() };
  db.prepare(
    `INSERT INTO workspace_subscriptions (id, workspace_id, product_id, service_id, qty, unit_cents, currency, interval, status, anchor_day, started_at, cancelled_at, status_changed_at, paused_by, created_at)
     VALUES (@id, @workspace_id, @product_id, @service_id, @qty, @unit_cents, @currency, @interval, @status, @anchor_day, @started_at, @cancelled_at, @status_changed_at, @paused_by, @created_at)`,
  ).run(full);
  return full;
}

const SUBSCRIPTION_COLUMNS = new Set(['service_id', 'qty', 'unit_cents', 'currency', 'interval', 'status', 'anchor_day', 'cancelled_at', 'status_changed_at', 'paused_by']);

export function updateSubscription(subId: string, fields: Record<string, unknown>): void {
  // Todo cambio de estado deja fecha: el prorrateo de la baja depende de saberla.
  if (fields.status !== undefined && fields.status_changed_at === undefined) fields = { ...fields, status_changed_at: now() };
  const keys = Object.keys(fields).filter((k) => SUBSCRIPTION_COLUMNS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE workspace_subscriptions SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), subId);
}

export function deleteSubscription(subId: string): void {
  db.prepare('DELETE FROM workspace_subscriptions WHERE id = ?').run(subId);
}

/** Cambia el estado de todas las suscripciones de un workspace (corte/reactivación). */
/**
 * Cambio de estado masivo de las suscripciones de una cuenta. `actor` distingue el
 * corte automático por impago ('dunning') de la pausa MANUAL del operador: al
 * regularizar el pago solo revive lo que cortó la morosidad.
 */
export function setWorkspaceSubscriptionsStatus(workspaceId: string, from: string, to: string, actor: 'dunning' | 'manual' = 'dunning'): number {
  return db
    .prepare('UPDATE workspace_subscriptions SET status = ?, status_changed_at = ?, paused_by = ? WHERE workspace_id = ? AND status = ?')
    .run(to, now(), to === 'active' ? null : actor, workspaceId, from).changes;
}

/** Reactiva solo las suscripciones que cortó la morosidad, no las pausadas a mano. */
export function reviveDunningSubscriptions(workspaceId: string, from: string): number {
  return db
    .prepare("UPDATE workspace_subscriptions SET status = 'active', status_changed_at = ?, paused_by = NULL WHERE workspace_id = ? AND status = ? AND paused_by = 'dunning'")
    .run(now(), workspaceId, from).changes;
}

/** Facturas emitidas y aún no cobradas (candidatas a morosidad). */
export function listUnpaidIssuedInvoices(): InvoiceRow[] {
  return db.prepare("SELECT * FROM workspace_invoices WHERE status = 'issued' AND paid_at IS NULL ORDER BY issued_at ASC").all() as InvoiceRow[];
}

/**
 * ¿Ya existe la factura DEFINITIVA de ese ciclo? (idempotencia de la facturación
 * automática y de la generación manual).
 *
 * Solo cuenta la factura que cubre el ciclo YA CERRADO: la emitida/cobrada, o el
 * borrador creado después de `periodEnd`. Un borrador creado a mitad de ciclo —el
 * que produce «Generar ciclo» cuando el operador quiere una previsión— NO bloquea:
 * si lo hiciera, el consumo desde esa previsión hasta el cierre no se facturaría
 * nunca. Las anuladas tampoco cuentan: el periodo vuelve a estar pendiente.
 */
export function invoiceExistsForCycle(workspaceId: string, periodStart: number, periodEnd?: number): boolean {
  if (periodEnd === undefined) {
    return !!db.prepare("SELECT 1 FROM workspace_invoices WHERE workspace_id = ? AND period_start = ? AND status <> 'void' LIMIT 1").get(workspaceId, periodStart);
  }
  return !!db
    .prepare(
      `SELECT 1 FROM workspace_invoices
       WHERE workspace_id = ? AND period_start = ? AND status <> 'void'
         AND (status <> 'draft' OR created_at >= ?)
       LIMIT 1`,
    )
    .get(workspaceId, periodStart, periodEnd);
}

/**
 * ¿El periodo tiene ya una factura EXPEDIDA viva (emitida, cobrada o vencida)?
 * Un borrador no cuenta: mientras no se emita, el periodo sigue sin facturar y el
 * ancla no debe darlo por cerrado (`performEmission` la avanza al expedir).
 */
export function issuedInvoiceExistsForCycle(workspaceId: string, periodStart: number): boolean {
  return !!db
    .prepare("SELECT 1 FROM workspace_invoices WHERE workspace_id = ? AND period_start = ? AND status NOT IN ('void','draft') LIMIT 1")
    .get(workspaceId, periodStart);
}

/**
 * Borrador GENERADO POR EL CICLO para un periodo, que el tick puede sustituir por
 * la factura definitiva al vencer. Se exige `origin = 'cycle'` e `invoice_type`
 * ordinaria: una factura a medida o una rectificativa en borrador pueden compartir
 * `period_start` y borrarlas se llevaría por delante el trabajo del operador.
 */
export function openDraftForCycle(workspaceId: string, periodStart: number): InvoiceRow | undefined {
  return db
    .prepare(
      `SELECT * FROM workspace_invoices
       WHERE workspace_id = ? AND period_start = ? AND status = 'draft'
         AND origin = 'cycle' AND invoice_type = 'normal'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspaceId, periodStart) as InvoiceRow | undefined;
}

/** Rectificativas vivas (no anuladas) que corrigen una factura dada. */
export function listRectificationsOf(invoiceId: string): InvoiceRow[] {
  return db
    .prepare("SELECT * FROM workspace_invoices WHERE rectifies_invoice_id = ? AND status <> 'void' ORDER BY created_at ASC")
    .all(invoiceId) as InvoiceRow[];
}

// ---------- cargos puntuales pendientes ----------
export function listPendingCharges(workspaceId: string, status?: PendingChargeRow['status']): PendingChargeRow[] {
  if (status) {
    return db
      .prepare('SELECT * FROM pending_charges WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC')
      .all(workspaceId, status) as PendingChargeRow[];
  }
  return db.prepare('SELECT * FROM pending_charges WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as PendingChargeRow[];
}

export function getPendingCharge(chargeId: string): PendingChargeRow | undefined {
  return db.prepare('SELECT * FROM pending_charges WHERE id = ?').get(chargeId) as PendingChargeRow | undefined;
}

export function createPendingCharge(row: Omit<PendingChargeRow, 'id' | 'created_at' | 'status' | 'invoice_id'>): PendingChargeRow {
  const full: PendingChargeRow = { ...row, id: id('chg'), status: 'pending', invoice_id: null, created_at: now() };
  db.prepare(
    `INSERT INTO pending_charges (id, workspace_id, product_id, label, kind, qty, unit_cents, tax_rate, irpf_rate, status, invoice_id, created_at)
     VALUES (@id, @workspace_id, @product_id, @label, @kind, @qty, @unit_cents, @tax_rate, @irpf_rate, @status, @invoice_id, @created_at)`,
  ).run(full);
  return full;
}

export function cancelPendingCharge(chargeId: string): void {
  db.prepare("UPDATE pending_charges SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(chargeId);
}

/** Marca varios cargos como facturados, enlazándolos a la factura. */
export function markChargesInvoiced(chargeIds: string[], invoiceId: string): void {
  if (chargeIds.length === 0) return;
  const stmt = db.prepare("UPDATE pending_charges SET status = 'invoiced', invoice_id = ? WHERE id = ? AND status = 'pending'");
  db.transaction(() => {
    for (const cid of chargeIds) stmt.run(invoiceId, cid);
  })();
}

// ---------- ingesta y agregación de uso (IA y contadores lógicos) ----------
/** Ingesta idempotente de un evento de consumo. Devuelve false si es duplicado. */
export function ingestUsageEvent(evt: {
  idempotencyKey: string;
  subjectType: 'workspace' | 'service';
  subjectId: string;
  meter: string;
  quantity: number;
  productId?: string | null;
  ts: number;
  metadata?: string | null;
}): boolean {
  // Titular resuelto AHORA y congelado en el cubo horario: la factura no puede
  // depender de a qué cuenta pertenezca el servicio dentro de tres meses.
  const workspaceId =
    evt.subjectType === 'workspace'
      ? evt.subjectId
      : ((db
          .prepare('SELECT p.workspace_id AS ws FROM services s JOIN projects p ON p.id = s.project_id WHERE s.id = ?')
          .get(evt.subjectId) as { ws: string | null } | undefined)?.ws ?? null);
  return db.transaction(() => {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO usage_events (id, idempotency_key, subject_type, subject_id, meter, quantity, product_id, ts, metadata)
         VALUES (@id, @idempotency_key, @subject_type, @subject_id, @meter, @quantity, @product_id, @ts, @metadata)`,
      )
      .run({
        id: id('use'), idempotency_key: evt.idempotencyKey, subject_type: evt.subjectType, subject_id: evt.subjectId,
        meter: evt.meter, quantity: evt.quantity, product_id: evt.productId ?? null, ts: evt.ts, metadata: evt.metadata ?? null,
      });
    if (res.changes === 0) return false; // idempotency_key ya visto
    const hour = Math.floor(evt.ts / 3_600_000);
    db.prepare(
      `INSERT INTO usage_meter_hourly (subject_type, subject_id, meter, hour, quantity, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_id, meter, hour) DO UPDATE SET
         quantity = quantity + excluded.quantity,
         workspace_id = COALESCE(workspace_id, excluded.workspace_id)`,
    ).run(evt.subjectType, evt.subjectId, evt.meter, hour, evt.quantity, workspaceId);
    return true;
  })();
}

/**
 * Consumo agregado de un medidor lógico/IA para un workspace en un rango horario.
 * Se filtra por el titular CONGELADO en el momento de medir (`workspace_id`), no
 * por la pertenencia actual del servicio: si no, borrar el servicio o mover el
 * proyecto de cuenta cambiaría retroactivamente lo ya consumido.
 */
export function workspaceMeterUsage(workspaceId: string, meter: string, fromHour: number, toHour: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(u.quantity), 0) AS total
       FROM usage_meter_hourly u
       WHERE u.meter = ? AND u.hour >= ? AND u.hour < ? AND u.workspace_id = ?`,
    )
    .get(meter, fromHour, toHour, workspaceId) as { total: number };
  return row.total;
}

// ---------- claves de API por cuenta (proxy de IA) ----------
export function createWorkspaceApiKey(
  row: Pick<WorkspaceApiKeyRow, 'workspace_id' | 'name' | 'key_hash' | 'prefix'> & Partial<WorkspaceApiKeyRow>,
): WorkspaceApiKeyRow {
  const full: WorkspaceApiKeyRow = {
    provider: 'gemini', allowed_models: '[]', status: 'active', budget_cents_month: null, spend_cents_cycle: 0,
    cycle_anchor: null, rate_limit_rpm: null, last_used_at: null, expires_at: null, created_by: null, revoked_at: null,
    ...row, id: id('wak'), created_at: now(),
  };
  db.prepare(
    `INSERT INTO workspace_api_keys (id, workspace_id, name, key_hash, prefix, provider, allowed_models, status, budget_cents_month, spend_cents_cycle, cycle_anchor, rate_limit_rpm, last_used_at, expires_at, created_by, created_at, revoked_at)
     VALUES (@id, @workspace_id, @name, @key_hash, @prefix, @provider, @allowed_models, @status, @budget_cents_month, @spend_cents_cycle, @cycle_anchor, @rate_limit_rpm, @last_used_at, @expires_at, @created_by, @created_at, @revoked_at)`,
  ).run(full);
  return full;
}

export function listWorkspaceApiKeys(workspaceId: string): WorkspaceApiKeyRow[] {
  return db
    .prepare("SELECT * FROM workspace_api_keys WHERE workspace_id = ? AND status <> 'revoked' ORDER BY created_at DESC")
    .all(workspaceId) as WorkspaceApiKeyRow[];
}

export function getWorkspaceApiKey(keyId: string): WorkspaceApiKeyRow | undefined {
  return db.prepare('SELECT * FROM workspace_api_keys WHERE id = ?').get(keyId) as WorkspaceApiKeyRow | undefined;
}

/** Busca una clave por su hash. Se consulta en CADA petición del proxy (sin caché), para que suspender/revocar surta efecto al instante. */
export function getWorkspaceApiKeyByHash(hash: string): WorkspaceApiKeyRow | undefined {
  return db.prepare('SELECT * FROM workspace_api_keys WHERE key_hash = ?').get(hash) as WorkspaceApiKeyRow | undefined;
}

// `suspended_by` entra en la lista blanca: sin él, desbloquear una clave a mano
// dejaba la marca 'dunning' pegada, y al pagar una factura la clave revivía sola
// deshaciendo la decisión del operador.
const WS_API_KEY_COLUMNS = new Set(['name', 'allowed_models', 'status', 'suspended_by', 'budget_cents_month', 'spend_cents_cycle', 'cycle_anchor', 'rate_limit_rpm', 'expires_at', 'revoked_at']);

export function updateWorkspaceApiKey(keyId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields).filter((k) => WS_API_KEY_COLUMNS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE workspace_api_keys SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), keyId);
}

/** Cambia el estado de TODAS las claves de un workspace (corte/reactivación por impago). */
export function setWorkspaceKeysStatus(workspaceId: string, from: string, to: string, actor: 'dunning' | 'manual' = 'dunning'): number {
  return db
    .prepare('UPDATE workspace_api_keys SET status = ?, suspended_by = ? WHERE workspace_id = ? AND status = ?')
    .run(to, to === 'active' ? null : actor, workspaceId, from).changes;
}

/** Reactiva solo las claves que suspendió la morosidad, no las cortadas a mano. */
export function reviveDunningKeys(workspaceId: string, from: string): number {
  return db
    .prepare("UPDATE workspace_api_keys SET status = 'active', suspended_by = NULL WHERE workspace_id = ? AND status = ? AND suspended_by = 'dunning'")
    .run(workspaceId, from).changes;
}

/** Actualiza `last_used_at` de forma diferida (como los tokens de panel): solo si pasó >60 s. */
export function touchWorkspaceApiKey(keyId: string, lastUsed: number | null): void {
  const t = now();
  if (lastUsed && t - lastUsed < 60_000) return;
  db.prepare('UPDATE workspace_api_keys SET last_used_at = ? WHERE id = ?').run(t, keyId);
}

/** Acumula gasto del ciclo en la clave (para el tope de presupuesto). */
export function incrementWorkspaceApiKeySpend(keyId: string, cents: number): void {
  if (cents <= 0) return;
  db.prepare('UPDATE workspace_api_keys SET spend_cents_cycle = spend_cents_cycle + ? WHERE id = ?').run(Math.round(cents), keyId);
}

/** Reancla el contador de gasto de la clave al inicio del ciclo actual (reset mensual). */
export function resetWorkspaceApiKeyCycle(keyId: string, cycleStart: number): void {
  db.prepare('UPDATE workspace_api_keys SET spend_cents_cycle = 0, cycle_anchor = ? WHERE id = ?').run(cycleStart, keyId);
}

// ---------- coste del operador por modelo (margen; Fase 2) ----------

/** Coste registrado del operador por modelo (micro-céntimos por millón de tokens). */
export function listModelPrices(): AiModelPriceRow[] {
  return db.prepare('SELECT * FROM ai_model_prices ORDER BY model ASC').all() as AiModelPriceRow[];
}
export function getModelPrice(model: string): AiModelPriceRow | undefined {
  return db.prepare('SELECT * FROM ai_model_prices WHERE model = ?').get(model) as AiModelPriceRow | undefined;
}
/** Alta o actualización (upsert) del coste de un modelo. Valores en micro-céntimos por Mtok. */
export function setModelPrice(p: {
  model: string;
  cost_micros_in: number;
  cost_micros_cache: number;
  cost_micros_out: number;
  margin_pct?: number;
  currency?: string;
  source?: 'auto' | 'manual';
  synced_at?: number | null;
}): AiModelPriceRow {
  db.prepare(
    `INSERT INTO ai_model_prices (model, cost_micros_in, cost_micros_cache, cost_micros_out, margin_pct, currency, source, synced_at, updated_at)
     VALUES (@model, @cost_micros_in, @cost_micros_cache, @cost_micros_out, @margin_pct, @currency, @source, @synced_at, @updated_at)
     ON CONFLICT(model) DO UPDATE SET
       cost_micros_in = excluded.cost_micros_in,
       cost_micros_cache = excluded.cost_micros_cache,
       cost_micros_out = excluded.cost_micros_out,
       margin_pct = excluded.margin_pct,
       currency = excluded.currency,
       source = excluded.source,
       synced_at = excluded.synced_at,
       updated_at = excluded.updated_at`,
  ).run({
    model: p.model,
    cost_micros_in: Math.max(0, Math.round(p.cost_micros_in)),
    cost_micros_cache: Math.max(0, Math.round(p.cost_micros_cache)),
    cost_micros_out: Math.max(0, Math.round(p.cost_micros_out)),
    // Margen s/ venta en [0,95): PVP = coste/(1−m/100); tope <100 evita división por 0.
    margin_pct: Math.max(0, Math.min(95, p.margin_pct ?? 0)),
    currency: p.currency ?? 'EUR',
    source: p.source === 'auto' ? 'auto' : 'manual',
    synced_at: p.synced_at ?? null,
    updated_at: now(),
  });
  return getModelPrice(p.model)!;
}
export function deleteModelPrice(model: string): number {
  return db.prepare('DELETE FROM ai_model_prices WHERE model = ?').run(model).changes;
}
