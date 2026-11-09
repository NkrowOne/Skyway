import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken } from '../src/auth';
import { config } from '../src/config';
import { closeDb, createUser, initDb, insertApiToken, listInvoiceSeries, registrosDeFactura } from '../src/db';
import { huellaAlta, huellaAnulacion } from '../src/verifactu/huella';
import { peticionHttps, remisionTick, type Transporte } from '../src/verifactu/remision';
import type { RegistroAeat } from '../src/verifactu/tipos';
import { hashPassword, randomToken } from '../src/util';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

let app: FastifyInstance;
let headers: Record<string, string>;
let wsId = '';
let wsExtranjero = '';
/** Factura emitida antes de activar VERI*FACTU: no tiene registro de alta. */
let antigua = '';

/** NIF de los ejemplos de la AEAT (válido). El del cliente, otro NIF válido. */
const NIF_EMISOR = '89890001K';
const NIF_CLIENTE = 'B12345674';

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
async function borrador(workspaceId: string, lines: unknown[] = [{ label: 'Alojamiento', unitCents: 10000, taxRate: 21 }]): Promise<string> {
  const ahora = Date.now();
  const r = await call('POST', `/api/workspaces/${workspaceId}/invoices`, { lines, periodStart: ahora - 86_400_000, periodEnd: ahora });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.invoice.id;
}

async function emitir(id: string): Promise<{ status: number; json: Json }> {
  return call('PATCH', `/api/invoices/${id}`, { status: 'issued' });
}

function registros(invoiceId: string): RegistroAeat[] {
  return registrosDeFactura(invoiceId).map((r) => JSON.parse(r.registro_json) as RegistroAeat);
}

// ---------------------------------------------------------------------------
// Certificados de prueba: se generan al vuelo con OpenSSL (nada de claves en el
// repositorio). Sin OpenSSL, se saltan las pruebas que los necesitan.
// ---------------------------------------------------------------------------
const dirCert = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-cert-'));
let hayOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hayOpenssl = false;
}
function openssl(args: string[]): void {
  execFileSync('openssl', args, { cwd: dirCert, stdio: 'ignore' });
}
if (hayOpenssl) {
  // Cliente: como un certificado de persona física de la FNMT (NIF en serialNumber).
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'cliente.key', '-out', 'cliente.pem', '-days', '7300', '-subj', `/C=ES/serialNumber=IDCES-${NIF_EMISOR}/CN=PRUEBAS SKYWAY - ${NIF_EMISOR}`]);
  openssl(['pkcs12', '-export', '-inkey', 'cliente.key', '-in', 'cliente.pem', '-out', 'cliente.p12', '-passout', 'pass:clave de pruebas']);
  // Servidor local que hace de AEAT, para el TLS con certificado de cliente.
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'servidor.key', '-out', 'servidor.pem', '-days', '7300', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
}
const leer = (f: string): Buffer => fs.readFileSync(path.join(dirCert, f));

// ---------------------------------------------------------------------------
// AEAT simulada: lee el XML recibido y contesta registro a registro.
// ---------------------------------------------------------------------------
interface Recibido {
  xml: string;
  /** Número, fecha y operación de cada registro, en orden. */
  registros: { num: string; fecha: string; op: 'Alta' | 'Anulacion' }[];
}
const recibidos: Recibido[] = [];

function leerEnvio(xml: string): Recibido {
  const regs: Recibido['registros'] = [];
  for (const m of xml.matchAll(/<sum1:(RegistroAlta|RegistroAnulacion)>(.*?)<\/sum1:\1>/g)) {
    const alta = m[1] === 'RegistroAlta';
    const num = new RegExp(`<sum1:${alta ? 'NumSerieFactura' : 'NumSerieFacturaAnulada'}>([^<]*)<`).exec(m[2])![1];
    const fecha = new RegExp(`<sum1:${alta ? 'FechaExpedicionFactura' : 'FechaExpedicionFacturaAnulada'}>([^<]*)<`).exec(m[2])![1];
    regs.push({ num, fecha, op: alta ? 'Alta' : 'Anulacion' });
  }
  return { xml, registros: regs };
}

type Veredicto = { estado: 'Correcto' } | { estado: 'AceptadoConErrores' | 'Incorrecto'; codigo: string; descripcion: string } | { estado: 'Duplicado'; previo: string };

function respuestaAeat(r: Recibido, veredicto: (num: string, op: string) => Veredicto, espera = 60): string {
  const lineas = r.registros
    .map((x) => {
      const v = veredicto(x.num, x.op);
      const id = `<tikR:IDFactura><sf:IDEmisorFactura>${NIF_EMISOR}</sf:IDEmisorFactura><sf:NumSerieFactura>${x.num}</sf:NumSerieFactura><sf:FechaExpedicionFactura>${x.fecha}</sf:FechaExpedicionFactura></tikR:IDFactura>`;
      const op = `<tikR:Operacion><sf:TipoOperacion>${x.op}</sf:TipoOperacion></tikR:Operacion>`;
      if (v.estado === 'Correcto') return `<tikR:RespuestaLinea>${id}${op}<tikR:EstadoRegistro>Correcto</tikR:EstadoRegistro></tikR:RespuestaLinea>`;
      if (v.estado === 'Duplicado') {
        return `<tikR:RespuestaLinea>${id}${op}<tikR:EstadoRegistro>Incorrecto</tikR:EstadoRegistro><tikR:CodigoErrorRegistro>3000</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Registro de facturación duplicado.</tikR:DescripcionErrorRegistro><tikR:RegistroDuplicado><sf:IdPeticionRegistroDuplicado>2025PET0001</sf:IdPeticionRegistroDuplicado><sf:EstadoRegistroDuplicado>${v.previo}</sf:EstadoRegistroDuplicado></tikR:RegistroDuplicado></tikR:RespuestaLinea>`;
      }
      return `<tikR:RespuestaLinea>${id}${op}<tikR:EstadoRegistro>${v.estado}</tikR:EstadoRegistro><tikR:CodigoErrorRegistro>${v.codigo}</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>${v.descripcion}</tikR:DescripcionErrorRegistro></tikR:RespuestaLinea>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Header/><env:Body>' +
    '<tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd" xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd">' +
    `<tikR:CSV>A-PRUEBA${recibidos.length}</tikR:CSV><tikR:TiempoEsperaEnvio>${espera}</tikR:TiempoEsperaEnvio><tikR:EstadoEnvio>Correcto</tikR:EstadoEnvio>${lineas}` +
    '</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>'
  );
}

/** Transporte simulado: anota lo enviado y contesta con `responder`. */
function transporte(responder: (r: Recibido) => string | Error): Transporte {
  return async (_url, xml) => {
    const r = leerEnvio(xml);
    recibidos.push(r);
    // Para validar a mano los envíos contra los XSD de la AEAT (xmllint):
    // VERIFACTU_VOLCADO=/carpeta npx vitest run test/verifactu.test.ts
    if (process.env.VERIFACTU_VOLCADO) fs.writeFileSync(path.join(process.env.VERIFACTU_VOLCADO, `envio-${recibidos.length}.xml`), xml);
    const resp = responder(r);
    if (resp instanceof Error) throw resp;
    return { status: 200, cuerpo: resp };
  };
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
  fs.rmSync(dirCert, { recursive: true, force: true });
});

describe('activación de VERI*FACTU', () => {
  it('no se activa con un NIF del emisor que no es válido', async () => {
    let r = await call('PUT', '/api/billing/profile', { companyName: 'Emisor Pruebas SL', taxId: 'B12345678', invoicePrefix: 'FV' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call('PUT', '/api/verifactu', { modo: 'verifactu' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/NIF del emisor/);
    // Tampoco por el perfil de facturación.
    r = await call('PUT', '/api/billing/profile', { sifMode: 'verifactu' });
    expect(r.status).toBe(409);
  });

  it('desactivado, emitir no genera ningún registro', async () => {
    let r = await call('PUT', '/api/billing/profile', { taxId: NIF_EMISOR });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call('POST', '/api/workspaces', { name: 'Cliente antiguo' });
    const ws = r.json.workspace.id;
    await call('PATCH', `/api/workspaces/${ws}`, { billingTaxId: NIF_CLIENTE });
    antigua = await borrador(ws);
    r = await emitir(antigua);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.verifactu).toBeNull();
    expect(registrosDeFactura(antigua)).toHaveLength(0);
  });

  it('el valor antiguo «no_verifactu» se lee como desactivado', async () => {
    const r = await call('PUT', '/api/billing/profile', { sifMode: 'no_verifactu' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.profile.sifMode).toBe('desactivado');
  });

  it('se activa con NIF válido, en el entorno de pruebas por defecto, y lo anota en el registro de eventos', async () => {
    let r = await call('PUT', '/api/billing/profile', { taxId: NIF_EMISOR });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call('PUT', '/api/verifactu', { modo: 'verifactu' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.modo).toBe('verifactu');
    expect(r.json.ajustes.entorno).toBe('pruebas');
    expect(r.json.sistema).toMatchObject({ nombre: 'Skyway', id: 'SK', version: config.version });
    expect(r.json.eventos[0].tipo_evento).toBe('activacion');
    expect(r.json.eventosIntegros).toBe(true);
    expect(r.json.avisos.map((a: { tipo: string }) => a.tipo)).toEqual(expect.arrayContaining(['sin_certificado', 'entorno_pruebas', 'declaracion_incompleta']));
  });

  it('prepara las cuentas de cliente', async () => {
    let r = await call('POST', '/api/workspaces', { name: 'Cliente "Comillas" <SL>' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    wsId = r.json.workspace.id;
    r = await call('PATCH', `/api/workspaces/${wsId}`, { billingTaxId: NIF_CLIENTE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call('POST', '/api/workspaces', { name: 'Kunde GmbH' });
    wsExtranjero = r.json.workspace.id;
    r = await call('PATCH', `/api/workspaces/${wsExtranjero}`, { billingTaxId: '123456789', billingCountry: 'DE' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });
});

describe('registros de alta y anulación encadenados', () => {
  let primera = '';
  let segunda = '';

  it('emitir genera el registro de alta, primero de la cadena, con su huella y su QR', async () => {
    primera = await borrador(wsId);
    const r = await emitir(primera);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.verifactu).toMatchObject({ estado: 'pendiente', tipo: 'alta', entorno: 'pruebas' });
    const [reg] = registros(primera);
    expect(reg.tipo).toBe('alta');
    if (reg.tipo !== 'alta') return;
    const a = reg.alta;
    expect(a.IDFactura.IDEmisorFactura).toBe(NIF_EMISOR);
    expect(a.IDFactura.NumSerieFactura).toBe(r.json.invoice.number);
    expect(a.TipoFactura).toBe('F1');
    expect(a.Encadenamiento).toEqual({ PrimerRegistro: 'S' });
    expect(a.Destinatarios).toEqual([{ NombreRazon: 'Cliente ”Comillas” SL', NIF: NIF_CLIENTE }]);
    expect(a.Desglose).toEqual([{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '21.00', BaseImponibleOimporteNoSujeto: '100.00', CuotaRepercutida: '21.00' }]);
    expect(a.CuotaTotal).toBe('21.00');
    expect(a.ImporteTotal).toBe('121.00');
    expect(a.SistemaInformatico).toMatchObject({ NombreRazon: 'Emisor Pruebas SL', NIF: NIF_EMISOR, IdSistemaInformatico: 'SK', TipoUsoPosibleSoloVerifactu: 'S' });
    expect(a.FechaHoraHusoGenRegistro).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(a.Huella).toBe(
      huellaAlta({
        idEmisorFactura: NIF_EMISOR,
        numSerieFactura: a.IDFactura.NumSerieFactura,
        fechaExpedicionFactura: a.IDFactura.FechaExpedicionFactura,
        tipoFactura: 'F1',
        cuotaTotal: '21.00',
        importeTotal: '121.00',
        huellaAnterior: '',
        fechaHoraHusoGenRegistro: a.FechaHoraHusoGenRegistro,
      }),
    );
    expect(r.json.invoice.verifactu.qrUrl).toBe(
      `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=${NIF_EMISOR}&numserie=${a.IDFactura.NumSerieFactura}&fecha=${a.IDFactura.FechaExpedicionFactura}&importe=121.00`,
    );
  });

  it('el propietario de la cuenta ve el estado y el QR, pero no el CSV, la huella ni las rutas de VERI*FACTU', async () => {
    const secret = `${API_TOKEN_PREFIX}${randomToken(24)}`;
    const owner = createUser('propietario@test.local', hashPassword('secreto123'), 'owner', wsId);
    insertApiToken({ user_id: owner.id, name: 'propietario', token_hash: hashApiToken(secret), prefix: secret.slice(0, 12), expires_at: null });
    const h = { authorization: `Bearer ${secret}` };
    let r = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}/invoices`, headers: h });
    expect(r.statusCode).toBe(200);
    const inv = r.json().invoices.find((i: Json) => i.id === primera);
    expect(Object.keys(inv.verifactu).sort()).toEqual(['entorno', 'estado', 'qrUrl', 'tipo']);
    for (const url of ['/api/verifactu', `/api/invoices/${primera}/verifactu`]) {
      r = await app.inject({ method: 'GET', url, headers: h });
      expect(r.statusCode, url).toBe(403);
    }
    r = await app.inject({ method: 'POST', url: '/api/verifactu/enviar', headers: h });
    expect(r.statusCode).toBe(403);
  });

  it('pasar a pagada no genera otro registro', async () => {
    const r = await call('PATCH', `/api/invoices/${primera}`, { status: 'paid' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(registrosDeFactura(primera)).toHaveLength(1);
  });

  it('la siguiente factura se encadena a la anterior, y la retención de IRPF no resta del importe del registro', async () => {
    segunda = await borrador(wsId, [{ label: 'Consultoría', unitCents: 20000, taxRate: 21, irpfRate: 15 }]);
    const r = await emitir(segunda);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.total_cents).toBe(20000 + 4200 - 3000);
    const anterior = registrosDeFactura(primera)[0];
    const [reg] = registros(segunda);
    if (reg.tipo !== 'alta') throw new Error('se esperaba un alta');
    expect(reg.alta.ImporteTotal).toBe('242.00');
    expect(reg.alta.Encadenamiento.RegistroAnterior).toEqual({
      IDEmisorFactura: NIF_EMISOR,
      NumSerieFactura: anterior.num_serie_factura,
      FechaExpedicionFactura: (JSON.parse(anterior.registro_json) as Extract<RegistroAeat, { tipo: 'alta' }>).alta.IDFactura.FechaExpedicionFactura,
      Huella: anterior.huella,
    });
    expect(registrosDeFactura(segunda)[0].seq).toBe(2);
  });

  it('anular una factura emitida genera su registro de anulación encadenado', async () => {
    const r = await call('PATCH', `/api/invoices/${segunda}`, { status: 'void' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.verifactu).toMatchObject({ tipo: 'anulacion', estado: 'pendiente' });
    const filas = registrosDeFactura(segunda);
    expect(filas.map((f) => f.record_type)).toEqual(['alta', 'anulacion']);
    const reg = JSON.parse(filas[1].registro_json) as RegistroAeat;
    if (reg.tipo !== 'anulacion') throw new Error('se esperaba una anulación');
    const a = reg.anulacion;
    expect(a.Encadenamiento.RegistroAnterior?.Huella).toBe(filas[0].huella);
    expect(a.Huella).toBe(
      huellaAnulacion({
        idEmisorFacturaAnulada: NIF_EMISOR,
        numSerieFacturaAnulada: filas[0].num_serie_factura,
        fechaExpedicionFacturaAnulada: a.IDFactura.FechaExpedicionFacturaAnulada,
        huellaAnterior: filas[0].huella,
        fechaHoraHusoGenRegistro: a.FechaHoraHusoGenRegistro,
      }),
    );
  });

  it('anular una factura emitida antes de activar VERI*FACTU genera una anulación «sin registro previo»', async () => {
    const r = await call('PATCH', `/api/invoices/${antigua}`, { status: 'void' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const filas = registrosDeFactura(antigua);
    expect(filas.map((f) => f.record_type)).toEqual(['anulacion']);
    const reg = JSON.parse(filas[0].registro_json) as RegistroAeat;
    if (reg.tipo !== 'anulacion') throw new Error('se esperaba una anulación');
    expect(reg.anulacion.SinRegistroPrevio).toBe('S');
    expect(reg.anulacion.IDFactura.NumSerieFacturaAnulada).toBe(r.json.invoice.number);
  });

  it('un cliente de la UE va con su NIF-IVA y sin IVA español por localización', async () => {
    const id = await borrador(wsExtranjero, [{ label: 'Alojamiento', unitCents: 5000 }]);
    let r = await call('PATCH', `/api/invoices/${id}`, { vatRegime: 'inversion_sujeto_pasivo' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const [reg] = registros(id);
    if (reg.tipo !== 'alta') throw new Error('se esperaba un alta');
    expect(reg.alta.Destinatarios).toEqual([{ NombreRazon: 'Kunde GmbH', IDOtro: { IDType: '02', ID: 'DE123456789' } }]);
    expect(reg.alta.Desglose).toEqual([{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'N2', BaseImponibleOimporteNoSujeto: '50.00' }]);
    expect(reg.alta.CuotaTotal).toBe('0.00');
    expect(reg.alta.ImporteTotal).toBe('50.00');
  });

  it('la rectificativa es R1 por defecto, por diferencias y con la factura rectificada', async () => {
    let r = await call('POST', `/api/invoices/${primera}/rectify`, { reason: 'Descuento acordado' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.invoice.id;
    r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const [reg] = registros(id);
    if (reg.tipo !== 'alta') throw new Error('se esperaba un alta');
    const original = registrosDeFactura(primera)[0];
    expect(reg.alta.TipoFactura).toBe('R1');
    expect(reg.alta.TipoRectificativa).toBe('I');
    expect(reg.alta.FacturasRectificadas).toEqual([{ IDEmisorFactura: NIF_EMISOR, NumSerieFactura: original.num_serie_factura, FechaExpedicionFactura: expect.stringMatching(/^\d{2}-\d{2}-\d{4}$/) }]);
    expect(reg.alta.ImporteTotal).toBe('-121.00');
  });

  it('un NIF de cliente no válido bloquea la emisión sin gastar número', async () => {
    const r1 = await call('POST', '/api/workspaces', { name: 'Cliente mal' });
    const malo = r1.json.workspace.id;
    await call('PATCH', `/api/workspaces/${malo}`, { billingTaxId: '12345678A' });
    const id = await borrador(malo);
    const serieAntes = listInvoiceSeries().find((s) => s.code === 'FV')!.next_seq;
    const r = await emitir(id);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/NIF del cliente/);
    expect(listInvoiceSeries().find((s) => s.code === 'FV')!.next_seq).toBe(serieAntes);
    const inv = (await call('GET', `/api/workspaces/${malo}/invoices`)).json.invoices[0];
    expect(inv.status).toBe('draft');
    expect(inv.number).toBeNull();
    expect(registrosDeFactura(id)).toHaveLength(0);
  });

  it('el PDF lleva el QR tributario y la leyenda VERI*FACTU al principio', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/invoices/${primera}/pdf`, headers });
    expect(r.statusCode).toBe(200);
    const pdf = r.rawPayload;
    const contenido = [...pdf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)]
      .map((m) => inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'))
      .join('\n');
    expect(contenido).toContain('(QR tributario:) Tj');
    expect(contenido).toContain('(VERI*FACTU) Tj');
    expect(contenido).toContain('(Registro remitido al entorno de pruebas de la AEAT) Tj');
    // Los módulos del QR: un único trazado relleno con muchos rectángulos.
    expect((contenido.match(/ re/g) ?? []).length).toBeGreaterThan(100);
  });

  it('los registros no se pueden modificar ni borrar en la base de datos', () => {
    const db = new Database(path.join(config.dataDir, 'skyway.db'));
    try {
      expect(() => db.prepare("UPDATE invoice_ledger SET huella = 'X'").run()).toThrow(/no se pueden modificar/);
      expect(() => db.prepare('DELETE FROM invoice_ledger').run()).toThrow(/no se pueden borrar/);
      expect(() => db.prepare("UPDATE invoice_events_log SET detalle = 'X'").run()).toThrow(/no se puede modificar/);
      // Lo que cambia con la remisión sí se puede actualizar.
      expect(() => db.prepare('UPDATE invoice_ledger SET intentos = intentos').run()).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!hayOpenssl)('certificado y remisión a una AEAT simulada', () => {
  it('rechaza un certificado con la contraseña equivocada y acepta el bueno sin devolverlo', async () => {
    let r = await call('POST', '/api/verifactu/certificado', { pfx: leer('cliente.p12').toString('base64'), password: 'mala' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('La contraseña del certificado no es correcta.');
    r = await call('POST', '/api/verifactu/certificado', { pfx: leer('cliente.p12').toString('base64'), password: 'clave de pruebas' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.certificado).toMatchObject({ nif: NIF_EMISOR });
    const vista = (await call('GET', '/api/verifactu')).json;
    const texto = JSON.stringify(vista);
    expect(texto).not.toContain('clave de pruebas');
    expect(texto).not.toContain(leer('cliente.p12').toString('base64').slice(0, 40));
    expect(vista.certificado.titular).toContain(NIF_EMISOR);
  });

  it('envía en un lote un registro por factura, en orden, y guarda lo que contesta la AEAT', async () => {
    const ahora = Date.now();
    const res = await remisionTick({ ahora, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Correcto' }))) });
    expect(res).toMatchObject({ enviado: true, resultado: 'correcto' });
    const envio = recibidos.at(-1)!;
    expect(envio.xml).toContain(`<sum:Cabecera><sum1:ObligadoEmision><sum1:NombreRazon>Emisor Pruebas SL</sum1:NombreRazon><sum1:NIF>${NIF_EMISOR}</sum1:NIF></sum1:ObligadoEmision>`);
    // La anulación de la segunda factura no va en el mismo envío que su alta.
    const nums = envio.registros.map((x) => x.num);
    expect(new Set(nums).size).toBe(nums.length);
    // Sin certificado al generarse, esos registros constan con incidencia.
    expect(envio.xml).toContain('<sum1:RemisionVoluntaria><sum1:Incidencia>S</sum1:Incidencia></sum1:RemisionVoluntaria>');
    const vista = (await call('GET', '/api/verifactu')).json;
    expect(vista.cola.ultimoResultado).toBe('correcto');
    expect(vista.cola.ultimoCsv).toMatch(/^A-PRUEBA/);
  });

  it('respeta el tiempo de espera que indica la AEAT antes del siguiente envío', async () => {
    const ahora = Date.now();
    let res = await remisionTick({ ahora: ahora + 1000, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Correcto' }))) });
    expect(res).toEqual({ enviado: false, motivo: 'esperando' });
    res = await remisionTick({ ahora: ahora + 61_000, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Correcto' }))) });
    expect(res.enviado).toBe(true);
    // Ya no queda nada en cola.
    res = await remisionTick({ ahora: ahora + 200_000, transporte: transporte(() => new Error('no debería llamarse')) });
    expect(res).toEqual({ enviado: false, motivo: 'sin_pendientes' });
  });

  it('un corte de conexión deja los registros en cola, avisa de la incidencia con los pendientes y reintenta más tarde', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 400_000;
    let res = await remisionTick({ ahora: t0, transporte: transporte(() => new Error('connect ECONNREFUSED')) });
    expect(res).toMatchObject({ enviado: true, resultado: 'fallo' });
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'pendiente', incidencia: 1, intentos: 1 });
    // Aviso desde el primer fallo, con cuántos faltan (art. 16.4 de la Orden).
    const alertas = (await call('GET', '/api/alerts')).json;
    const lista: Json[] = Array.isArray(alertas) ? alertas : alertas.alerts ?? [];
    expect(lista.some((a) => a.type === 'verifactu_remision' && /1 registro de facturación pendiente de remitir/.test(a.title) && !a.resolved_at)).toBe(true);
    const vista = (await call('GET', '/api/verifactu')).json;
    expect(vista.avisos.find((a: Json) => a.tipo === 'incidencia')?.texto).toMatch(/^Hay 1 registro de facturación pendiente de remitir/);
    res = await remisionTick({ ahora: t0 + 10_000, transporte: transporte(() => new Error('no debería llamarse')) });
    expect(res.motivo).toBe('esperando');
    // «Enviar ahora» se salta la espera tras un fallo.
    res = await remisionTick({ ahora: t0 + 20_000, forzar: true, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Correcto' }))) });
    expect(res.resultado).toBe('correcto');
    expect(registrosDeFactura(id)[0].estado_remision).toBe('correcto');
  });

  it('un rechazo del envío entero (SOAP Fault) no pierde los registros', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 900_000;
    const fault =
      '<?xml version="1.0"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><env:Fault><faultcode>env:Client</faultcode><faultstring>Codigo[4102].El XML no cumple el esquema. Falta informar campo obligatorio.</faultstring></env:Fault></env:Body></env:Envelope>';
    const res = await remisionTick({ ahora: t0, transporte: transporte(() => fault) });
    expect(res).toMatchObject({ resultado: 'rechazado' });
    expect(res.error).toContain('[4102]');
    expect(registrosDeFactura(id)[0].estado_remision).toBe('pendiente');
    const ok = await remisionTick({ ahora: t0 + 1000, forzar: true, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Correcto' }))) });
    expect(ok.resultado).toBe('correcto');
  });

  it('un duplicado (3000) toma el estado que ya tenía la AEAT', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const res = await remisionTick({ ahora: Date.now() + 2_000_000, forzar: true, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Duplicado', previo: 'Correcta' }))) });
    expect(res.enviado).toBe(true);
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'correcto', id_peticion: '2025PET0001' });
  });

  it('un registro rechazado se ve en la factura y se subsana con un registro nuevo encadenado', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 3_000_000;
    await remisionTick({
      ahora: t0,
      forzar: true,
      transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Incorrecto', codigo: '1100', descripcion: 'Valor o tipo incorrecto del campo.' }))),
    });
    let inv = (await call('GET', `/api/workspaces/${wsId}/invoices`)).json.invoices.find((i: Json) => i.id === id);
    expect(inv.verifactu).toMatchObject({ estado: 'incorrecto', codigoError: '1100', accion: 'subsanar' });
    const r = await call('POST', `/api/invoices/${id}/verifactu/subsanar`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const filas = registrosDeFactura(id);
    expect(filas).toHaveLength(2);
    const sub = JSON.parse(filas[1].registro_json) as RegistroAeat;
    if (sub.tipo !== 'alta') throw new Error('se esperaba un alta');
    expect(sub.alta.Subsanacion).toBe('S');
    // La AEAT no tiene el alta (fue rechazada): «X», no «S» (que daría 3002).
    expect(sub.alta.RechazoPrevio).toBe('X');
    expect(filas[1].seq).toBeGreaterThan(filas[0].seq);
    await remisionTick({ ahora: t0 + 61_000, transporte: transporte((x) => respuestaAeat(x, () => ({ estado: 'Correcto' }))) });
    inv = (await call('GET', `/api/workspaces/${wsId}/invoices`)).json.invoices.find((i: Json) => i.id === id);
    expect(inv.verifactu).toMatchObject({ estado: 'correcto', accion: null });
    // Nada más que subsanar.
    expect((await call('POST', `/api/invoices/${id}/verifactu/subsanar`)).status).toBe(409);
  });

  it('el TLS lleva el certificado de cliente hasta el servicio', async () => {
    let certCliente = '';
    const servidor = https.createServer({ key: leer('servidor.key'), cert: leer('servidor.pem'), ca: leer('cliente.pem'), requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
      const cn = peer.subject?.CN ?? '';
      certCliente = Array.isArray(cn) ? cn.join(',') : cn;
      let cuerpo = '';
      req.on('data', (c) => (cuerpo += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
        res.end(respuestaAeat(leerEnvio(cuerpo), () => ({ estado: 'Correcto' })));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    try {
      const { port } = servidor.address() as AddressInfo;
      const r = await peticionHttps(
        `https://localhost:${port}/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`,
        '<x/>',
        { pfx: leer('cliente.p12'), passphrase: 'clave de pruebas' },
        { timeoutMs: 5000, ca: leer('servidor.pem') },
      );
      expect(r.status).toBe(200);
      expect(certCliente).toBe(`PRUEBAS SKYWAY - ${NIF_EMISOR}`);
      // Sin certificado de cliente, el servidor corta la conexión.
      await expect(
        new Promise((ok, ko) => {
          const req = https.request({ hostname: 'localhost', port, method: 'GET', ca: leer('servidor.pem'), agent: false }, ok);
          req.on('error', ko);
          req.end();
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise((ok) => servidor.close(ok));
    }
  });

  it('no se puede desactivar el año en que ya se ha remitido a producción', async () => {
    let r = await call('PUT', '/api/verifactu', { entorno: 'produccion' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    expect(registrosDeFactura(id)[0].entorno).toBe('produccion');
    // La cadena de producción empieza de cero: es otra AEAT.
    const [reg] = registros(id);
    if (reg.tipo !== 'alta') throw new Error('se esperaba un alta');
    expect(reg.alta.Encadenamiento).toEqual({ PrimerRegistro: 'S' });
    r = await call('PUT', '/api/verifactu', { modo: 'desactivado' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/hasta el final del año natural/);
  });
});

describe.skipIf(!hayOpenssl)('punto de acceso del certificado de sello', () => {
  it('un certificado de sello se remite por el punto de acceso de sello', async () => {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'sello.key', '-out', 'sello.pem', '-days', '7300', '-subj', `/C=ES/O=EMISOR PRUEBAS SL/organizationIdentifier=VATES-${NIF_EMISOR}/CN=SELLO ELECTRONICO DE PRUEBAS`]);
    openssl(['pkcs12', '-export', '-inkey', 'sello.key', '-in', 'sello.pem', '-out', 'sello.p12', '-passout', 'pass:sello']);
    let r = await call('POST', '/api/verifactu/certificado', { pfx: leer('sello.p12').toString('base64'), password: 'sello' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.certificado).toMatchObject({ sello: true, nif: NIF_EMISOR });
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    let url = '';
    await remisionTick({
      ahora: Date.now() + 9_000_000,
      forzar: true,
      transporte: async (u, xml) => {
        url = u;
        return { status: 200, cuerpo: respuestaAeat(leerEnvio(xml), () => ({ estado: 'Correcto' })) };
      },
    });
    expect(url).toBe('https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
  });
});

/**
 * Lo último del fichero: estas pruebas dejan la cadena de producción rota a
 * propósito (los registros no se pueden borrar), y nada después la usa.
 */
describe('comprobaciones antes de encadenar (art. 7.i de la Orden HAC/1177/2024)', () => {
  it('no se genera nada si el último registro va más de un minuto por delante del reloj', async () => {
    const db = new Database(path.join(config.dataDir, 'skyway.db'));
    try {
      const ultimo = db.prepare("SELECT * FROM invoice_ledger WHERE entorno = 'produccion' ORDER BY seq DESC LIMIT 1").get() as Record<string, unknown>;
      db.prepare(
        `INSERT INTO invoice_ledger (id, seq, invoice_id, record_type, emisor_nif, num_serie_factura, fecha_expedicion, tipo_factura, cuota_total_cents, importe_total_cents, fecha_hora_gen, huella, huella_anterior, sif_mode, qr_url, estado_remision, version_sif, created_at, entorno, registro_json)
         VALUES (@id, @seq, @invoice_id, @record_type, @emisor_nif, @num_serie_factura, @fecha_expedicion, @tipo_factura, @cuota_total_cents, @importe_total_cents, @fecha_hora_gen, @huella, @huella_anterior, @sif_mode, @qr_url, 'correcto', @version_sif, @created_at, @entorno, @registro_json)`,
      ).run({ ...ultimo, id: 'vfr_futuro', seq: Number(ultimo.seq) + 1, created_at: Date.now() + 3_600_000 });
    } finally {
      db.close();
    }
    const id = await borrador(wsId);
    const r = await emitir(id);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/hora del servidor/);
    expect(registrosDeFactura(id)).toHaveLength(0);
  });

  it('no se genera nada si el último registro no cuadra con su huella', async () => {
    const db = new Database(path.join(config.dataDir, 'skyway.db'));
    try {
      const ultimo = db.prepare("SELECT * FROM invoice_ledger WHERE entorno = 'produccion' ORDER BY seq DESC LIMIT 1").get() as Record<string, unknown>;
      db.prepare(
        `INSERT INTO invoice_ledger (id, seq, invoice_id, record_type, emisor_nif, num_serie_factura, fecha_expedicion, tipo_factura, cuota_total_cents, importe_total_cents, fecha_hora_gen, huella, huella_anterior, sif_mode, qr_url, estado_remision, version_sif, created_at, entorno, registro_json)
         VALUES (@id, @seq, @invoice_id, @record_type, @emisor_nif, @num_serie_factura, @fecha_expedicion, @tipo_factura, @cuota_total_cents, @importe_total_cents, @fecha_hora_gen, @huella, @huella_anterior, @sif_mode, @qr_url, 'correcto', @version_sif, @created_at, @entorno, @registro_json)`,
      ).run({ ...ultimo, id: 'vfr_alterado', seq: Number(ultimo.seq) + 1, created_at: Date.now() - 1000, huella: 'A'.repeat(64) });
    } finally {
      db.close();
    }
    const id = await borrador(wsId);
    const r = await emitir(id);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/cadena de registros de facturación está dañada/);
  });
});
