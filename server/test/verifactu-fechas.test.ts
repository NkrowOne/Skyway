/**
 * Fechas de VERI*FACTU: la fecha de expedición se congela al emitir en hora
 * peninsular y de ella salen la serie, el registro, el QR, el PDF (también el
 * vencimiento) y el CSV; las leyendas del QR van a 14 pt, no menos que ningún
 * dato de la factura, y el modo «verifactu» que las versiones hasta la
 * 0.40 guardaban sin activar nada pasa a desactivado al actualizar.
 */
import { inflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { getBillingProfile } from '../src/company';
import {
  closeDb,
  createUser,
  getSetting,
  initDb,
  insertApiToken,
  listarRegistrosFacturacion,
  listInvoiceSeries,
  registrosDeFactura,
  setSetting,
} from '../src/db';
import { anotarEvento } from '../src/verifactu/eventos';
import type { RegistroAeat } from '../src/verifactu/tipos';
import { hashPassword, randomToken } from '../src/util';

// El proceso en UTC, como el servidor en su contenedor. En hora peninsular, el
// año del reloj del proceso y el de la fecha de expedición coincidirían, y la
// prueba de la serie no distinguiría el cálculo correcto del anterior. Cada
// fichero de pruebas corre en su propio proceso (vitest.config.ts): no afecta a
// los demás.
process.env.TZ = 'UTC';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

let app: FastifyInstance;
let headers: Record<string, string>;
/** Factura emitida con VERI*FACTU en la prueba de la fecha; la de las leyendas del QR usa su PDF. */
let facturaVerifactu = '';

/** NIF de los ejemplos de la AEAT (válido). El del cliente, otro NIF válido. */
const NIF_EMISOR = '89890001K';
const NIF_CLIENTE = 'B12345674';
const PERFIL = { companyName: 'Emisor Pruebas SL', taxId: NIF_EMISOR, invoicePrefix: 'FV' };
const MARCA_MIGRACION = 'migrations:verifactu_modo_v1';

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Json = null;
  try {
    json = r.json();
  } catch {
    /* sin cuerpo JSON */
  }
  return { status: r.statusCode, json };
}

/** Borrador de factura en una cuenta, con periodo propio para no tocar el ancla del ciclo. */
async function borrador(workspaceId: string): Promise<string> {
  const ahora = Date.now();
  const r = await call('POST', `/api/workspaces/${workspaceId}/invoices`, {
    lines: [{ label: 'Alojamiento', unitCents: 10000, taxRate: 21 }],
    periodStart: ahora - 86_400_000,
    periodEnd: ahora,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.invoice.id;
}

function registros(invoiceId: string): RegistroAeat[] {
  return registrosDeFactura(invoiceId).map((r) => JSON.parse(r.registro_json) as RegistroAeat);
}

/** Contenido de las páginas del PDF de una factura: cada página va en un stream comprimido con zlib. */
async function contenidoPdf(invoiceId: string): Promise<string> {
  const r = await app.inject({ method: 'GET', url: `/api/invoices/${invoiceId}/pdf`, headers });
  expect(r.statusCode).toBe(200);
  return [...r.rawPayload.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)]
    .map((m) => inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'))
    .join('\n');
}

/**
 * Línea de texto tal como la escribe `dibujaTexto` en invoicepdf.ts, una por
 * línea del contenido: `BT /F2 12 Tf 0 g 48 700 Td (texto) Tj ET`, con el
 * cuerpo de letra en el operador `Tf` justo antes de posicionar y pintar el
 * texto (F1 es Helvetica, F2 Helvetica-Bold).
 */
const LINEA_TEXTO = /^BT \/F([12]) (-?[\d.]+) Tf -?[\d.]+ g -?[\d.]+ -?[\d.]+ Td \(((?:[^\\()]|\\.)*)\) Tj ET$/gm;

/**
 * Textos de las páginas con su cuerpo de letra. Se deshacen los escapes de
 * `cadena()`: paréntesis, barra invertida y octales. Los octales son bytes de
 * WinAnsi, que coinciden con Latin-1 salvo en 0x80-0x9F (no aparecen en los
 * textos que se comprueban aquí).
 */
function textosPdf(contenido: string): { texto: string; cuerpo: number; negrita: boolean }[] {
  return [...contenido.matchAll(LINEA_TEXTO)].map((m) => ({
    negrita: m[1] === '2',
    cuerpo: Number(m[2]),
    texto: m[3].replace(/\\([0-7]{3}|[()\\])/g, (_, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e)),
  }));
}

beforeAll(async () => {
  initDb();
  const admin = createUser('admin@test.local', hashPassword('secreto123'), 'admin');
  const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  insertApiToken({ user_id: admin.id, name: 'pruebas', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
  headers = { authorization: `Bearer ${secret}` };
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

/**
 * Va antes que las pruebas de la fecha: el caso que pasa a desactivado exige
 * una base sin registros de facturación ni activaciones anotadas, y la emisión
 * con VERI*FACTU deja las dos cosas. No hay forma de quitarlas después: los
 * disparadores de la base impiden borrar los registros y los eventos.
 */
describe('migración del modo «verifactu» guardado sin activar (hasta la 0.40)', () => {
  const PERFIL_ANTIGUO = JSON.stringify({ ...PERFIL, sifMode: 'verifactu' });

  /** Como al actualizar: el perfil tal como lo guardaba la versión anterior y la migración en el arranque siguiente. */
  function arrancarCon(marca: string): void {
    setSetting('billingProfile', PERFIL_ANTIGUO);
    // `setSetting` con '' borra la clave: es la base de antes de la migración.
    setSetting(MARCA_MIGRACION, marca);
    closeDb();
    initDb();
  }

  afterAll(() => {
    // La prueba de la fecha prepara el perfil por la API, como en una instalación nueva.
    setSetting('billingProfile', null);
  });

  it('con la marca ya puesta no cambia nada, aunque se cumplan las condiciones', () => {
    // En una instalación nueva, la migración solo deja la marca.
    expect(getSetting(MARCA_MIGRACION)).toBe('done');
    expect(getSetting('billingProfile')).toBeNull();
    arrancarCon('done');
    expect(getSetting('billingProfile')).toBe(PERFIL_ANTIGUO);
    expect(getBillingProfile().sifMode).toBe('verifactu');
  });

  it('sin registros ni activación anotada, pasa a desactivado y conserva el resto del perfil', () => {
    arrancarCon('');
    expect(getBillingProfile()).toMatchObject({ ...PERFIL, sifMode: 'desactivado' });
    expect(getSetting(MARCA_MIGRACION)).toBe('done');
  });

  it('con una activación anotada en el registro de eventos, sigue en «verifactu»', () => {
    // Sin ningún registro de facturación: lo que lo mantiene es la activación.
    expect(listarRegistrosFacturacion(1)).toHaveLength(0);
    anotarEvento('activacion', 'Entorno: pruebas');
    arrancarCon('');
    expect(getBillingProfile().sifMode).toBe('verifactu');
    expect(getSetting(MARCA_MIGRACION)).toBe('done');
  });
});

/**
 * Las 23:30 UTC del 31 de diciembre de 2026 son ya las 00:30 del 1 de enero de
 * 2027 en la Península. La fecha de expedición es la peninsular, y con ella el
 * año de la serie, el registro, el QR, el PDF y el CSV.
 *
 * Una sola emisión: el registro no se genera si el último de la cadena va más de
 * un minuto por delante del reloj, así que cualquier emisión posterior de este
 * fichero tendría que ir a una hora simulada posterior a esta.
 */
describe('fecha de expedición en hora peninsular', () => {
  const INSTANTE = Date.parse('2026-12-31T23:30:00Z');
  let emitida: Json;

  beforeAll(() => {
    // Solo se simula el reloj: los temporizadores siguen siendo los reales.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INSTANTE);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('emitir a las 23:30 UTC del 31 de diciembre, las 00:30 del 1 de enero en la Península, fija la fecha de expedición en el 1 de enero de 2027', async () => {
    let r = await call('PUT', '/api/billing/profile', PERFIL);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // En producción: en pruebas, el PDF no lleva el QR ni las leyendas.
    r = await call('PUT', '/api/verifactu', { modo: 'verifactu', entorno: 'produccion' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.modo).toBe('verifactu');
    r = await call('POST', '/api/workspaces', { name: 'Cliente Nochevieja SL' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const ws: string = r.json.workspace.id;
    r = await call('PATCH', `/api/workspaces/${ws}`, { billingTaxId: NIF_CLIENTE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    facturaVerifactu = await borrador(ws);
    r = await call('PATCH', `/api/invoices/${facturaVerifactu}`, { status: 'issued' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    emitida = r.json.invoice;
    expect(emitida.verifactu).toMatchObject({ tipo: 'alta', entorno: 'produccion' });
    // El instante sigue siendo el del 31 de diciembre en UTC; la fecha, la peninsular.
    expect(emitida.issued_at).toBe(INSTANTE);
    expect(emitida.issued_date).toBe('2027-01-01');
  });

  it('el número sale de la serie de 2027', () => {
    expect(emitida.number).toBe('FV-2027-0001');
    // Ninguna serie FV de 2026: el año del reloj del proceso (UTC) no interviene.
    const series = listInvoiceSeries().filter((s) => s.code === 'FV');
    expect(series.map((s) => ({ year: s.year, next_seq: s.next_seq }))).toEqual([{ year: 2027, next_seq: 2 }]);
  });

  it('el registro de alta y el QR llevan la fecha de expedición 01-01-2027', () => {
    const [reg] = registros(facturaVerifactu);
    if (reg?.tipo !== 'alta') throw new Error('se esperaba un registro de alta');
    expect(reg.alta.IDFactura).toEqual({ IDEmisorFactura: NIF_EMISOR, NumSerieFactura: 'FV-2027-0001', FechaExpedicionFactura: '01-01-2027' });
    // La hora de generación también va en hora peninsular, con el desfase de invierno.
    expect(reg.alta.FechaHoraHusoGenRegistro).toBe('2027-01-01T00:30:00+01:00');
    const qr = new URL(emitida.verifactu.qrUrl);
    expect(qr.searchParams.get('numserie')).toBe('FV-2027-0001');
    expect(qr.searchParams.get('fecha')).toBe('01-01-2027');
    // El PDF pinta el QR del registro guardado: tiene que ser el mismo.
    expect(registrosDeFactura(facturaVerifactu)[0].qr_url).toBe(emitida.verifactu.qrUrl);
  });

  it('el PDF imprime la fecha de expedición 01/01/2027 y el vencimiento a los 30 días de esa fecha', async () => {
    const textos = textosPdf(await contenidoPdf(facturaVerifactu)).map((t) => t.texto);
    expect(textos).toContain('Fecha de expedición: 01/01/2027');
    // Con el instante de vencimiento en UTC saldría el 30 de enero: 29 días.
    expect(textos).toContain('Vencimiento: 31/01/2027');
  });

  it('la exportación contable lleva la misma fecha de expedición', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/accounting/export.csv', headers });
    expect(r.statusCode).toBe(200);
    const [cabecera, ...filas] = r.body.split('\n').map((l) => l.split(','));
    const fila = filas.find((f) => f[0] === 'FV-2027-0001');
    expect(fila?.[cabecera.indexOf('fecha_expedicion')]).toBe('2027-01-01');
  });

  it('cobrada en el mismo instante, la exportación no la da por cobrada antes de expedirse', async () => {
    const p = await call('PATCH', `/api/invoices/${facturaVerifactu}`, { status: 'paid', paymentMethod: 'cash' });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/api/accounting/export.csv', headers });
    const [cabecera, ...filas] = r.body.split('\n').map((l) => l.split(','));
    const fila = filas.find((f) => f[0] === 'FV-2027-0001');
    // Con la fecha de cobro en UTC saldría el 31-12-2026, antes de la de expedición.
    expect(fila?.[cabecera.indexOf('pagada')]).toBe('2027-01-01');
  });
});

describe('leyendas del QR tributario', () => {
  it('«QR tributario:» y «VERI*FACTU» se escriben a 14 pt, no menos que ningún dato de la factura', async () => {
    expect(facturaVerifactu, 'la factura sale de la prueba de la fecha de expedición').not.toBe('');
    const textos = textosPdf(await contenidoPdf(facturaVerifactu));
    const cuerpos = (texto: string): number[] => textos.filter((t) => t.texto === texto).map((t) => t.cuerpo);
    // Cada leyenda una sola vez y con el cuerpo de 14 pt.
    expect(cuerpos('QR tributario:')).toEqual([14]);
    expect(cuerpos('VERI*FACTU')).toEqual([14]);
    // La especificación del QR de la AEAT pide un cuerpo igual o superior al
    // del resto de datos: ninguno va más grande, salvo el título del documento.
    const titulo = /^FACTURA( SIMPLIFICADA| RECTIFICATIVA)?( ANULADA)?$/;
    const mayorDato = Math.max(...textos.filter((t) => !titulo.test(t.texto) && t.texto !== 'QR tributario:' && t.texto !== 'VERI*FACTU').map((t) => t.cuerpo));
    expect(mayorDato).toBeLessThanOrEqual(14);
  });
});
