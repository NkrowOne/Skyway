/**
 * Tipos del centro de ayuda: preguntas frecuentes, asistente determinista y
 * detección de problemas. La web los replica tal cual en `web/src/types.ts`,
 * así que un cambio aquí es un cambio de contrato.
 */

export type FaqCategory =
  | 'primeros-pasos'
  | 'despliegues'
  | 'variables'
  | 'dominios'
  | 'bases-de-datos'
  | 'logs-y-errores'
  | 'github'
  | 'cuenta-y-facturacion'
  | 'seguridad';

/**
 * Enlace que la web pinta como botón. `to` es una ruta interna de la SPA
 * ('/projects/ID?s=SVC&tab=variables', '/settings', '/help') o una URL https
 * externa; la web decide con qué componente lo abre según empiece por '/'.
 */
export interface HelpLink {
  label: string;
  to: string;
}

export interface FaqEntry {
  id: string;
  category: FaqCategory;
  question: string;
  answer: string;
  /** Sinónimos y errores frecuentes con los que alguien buscaría esto («502», «no arranca»…). */
  keywords: string[];
  links?: HelpLink[];
}

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface HelpIssue {
  /** p. ej. 'deploy-failed:healthcheck-failed', 'runtime:env-missing', 'env:pending', 'container:restarting'. */
  id: string;
  severity: IssueSeverity;
  serviceId: string;
  serviceName: string;
  projectId: string;
  projectName: string;
  title: string;
  cause: string;
  fix: string;
  /** Línea de log que lo delata, recortada a 200 caracteres y sin secretos. */
  evidence?: string;
  links: HelpLink[];
}

export interface AskResponse {
  /** Texto en español, párrafos separados por '\n\n'; puede llevar **negritas** y listas con '- '. */
  answer: string;
  /** Hasta 3, ordenadas por relevancia. */
  matches: FaqEntry[];
  issues: HelpIssue[];
  links: HelpLink[];
}
