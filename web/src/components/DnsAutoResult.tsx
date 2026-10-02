import { Cloud } from 'lucide-react';
import { DnsAutoResult, MailAutoDnsResult } from '../types';
import { Tone } from '../utils';
import { Chip } from './ui';

/**
 * Resultado del DNS automático en Cloudflare (solo lo recibe un administrador
 * con el token configurado). Un mismo criterio para los avisos de servicios,
 * pilas, importaciones y correo: verde si todo quedó bien, información si hay
 * algo que revisar a mano (conflicto, sin zona) y error si falló.
 */

export const DNS_AUTO_META: Record<DnsAutoResult['action'], { label: string; tone: Tone }> = {
  created: { label: 'DNS creado en Cloudflare', tone: 'ok' },
  kept: { label: 'DNS ya configurado', tone: 'ok' },
  conflict: { label: 'Conflicto en Cloudflare', tone: 'warn' },
  skipped: { label: 'Cloudflare: omitido', tone: 'neutral' },
  error: { label: 'Cloudflare: error', tone: 'err' },
};

type Aviso = { message: string; kind: 'ok' | 'err' | 'info' };

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Un aviso (toast) con el resumen del DNS automático de varios dominios, o null si no hay nada que contar. */
export function avisoDns(results: DnsAutoResult[] | undefined): Aviso | null {
  if (!results || results.length === 0) return null;
  const n = (a: DnsAutoResult['action']) => results.filter((r) => r.action === a).length;
  const kind: Aviso['kind'] = n('error') > 0 ? 'err' : n('conflict') + n('skipped') > 0 ? 'info' : 'ok';
  if (results.length === 1) return { message: `${results[0].domain}: ${results[0].message}`, kind };
  const partes = [
    n('created') && plural(n('created'), 'registro creado', 'registros creados'),
    n('kept') && plural(n('kept'), 'ya estaba configurado', 'ya estaban configurados'),
    n('conflict') && `${plural(n('conflict'), 'conflicto', 'conflictos')} sin modificar`,
    n('skipped') && plural(n('skipped'), 'omitido', 'omitidos'),
    n('error') && plural(n('error'), 'error', 'errores'),
  ].filter(Boolean);
  return { message: `DNS en Cloudflare: ${partes.join(', ')}. El detalle se muestra en cada dominio.`, kind };
}

/** El mismo aviso para el alta de un dominio de correo, que aplica Mailway. */
export function avisoDnsCorreo(domain: string, cloudflare: MailAutoDnsResult | null | undefined, reason?: string | null): Aviso | null {
  if (cloudflare) {
    const { applied, errors, skipped } = cloudflare;
    if (errors.length > 0) return { message: `DNS de ${domain} en Cloudflare: ${errors.map((e) => e.error).join(' ')}`, kind: 'err' };
    // El alta automática solo crea (Mailway 1.1 con `soloCrear`); se cuentan
    // aparte por si alguna vez llega otra acción, sin darla por creada.
    const creados = applied.filter((a) => a.action === 'create').length;
    const otros = applied.length - creados;
    const partes = [
      creados > 0 ? plural(creados, 'registro creado', 'registros creados') : '',
      otros > 0 ? plural(otros, 'registro modificado', 'registros modificados') : '',
      applied.length === 0 ? 'no faltaba ningún registro' : '',
      skipped.length > 0 ? `${plural(skipped.length, 'conflicto', 'conflictos')} sin modificar (${skipped.map((s) => s.name).join(', ')})` : '',
    ].filter(Boolean);
    return { message: `DNS de ${domain} en Cloudflare: ${partes.join('; ')}.`, kind: skipped.length > 0 ? 'info' : 'ok' };
  }
  if (reason) return { message: `DNS de ${domain} sin configurar automáticamente: ${reason}`, kind: 'info' };
  return null;
}

/** Chip con el resultado de un dominio; el motivo completo, en el título. */
export function DnsAutoChip({ result }: { result: DnsAutoResult }) {
  const meta = DNS_AUTO_META[result.action];
  return (
    <Chip size="sm" tone={meta.tone} icon={<Cloud size={10} aria-hidden />} title={result.message}>
      {meta.label}
    </Chip>
  );
}
