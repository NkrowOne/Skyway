import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { API_TOKEN_PREFIX, hashApiToken, signToken } from '../src/auth';
import { config } from '../src/config';
import { closeDb, createUser, getSetting, initDb, insertApiToken, listInvoiceSeries, registrosDeFactura, setSetting } from '../src/db';
import { huellaAlta, huellaAnulacion } from '../src/verifactu/huella';
import { peticionHttps, remisionTick, type Transporte } from '../src/verifactu/remision';
import type { RegistroAeat } from '../src/verifactu/tipos';
import { hashPassword, randomToken } from '../src/util';

// El cuerpo de una respuesta HTTP es frontera: se inspecciona sin tipar.
type Json = any;

let app: FastifyInstance;
let headers: Record<string, string>;
/** Sesión de navegador del administrador: la piden las credenciales (el certificado). */
let sesion: Record<string, string>;
let wsId = '';
let wsExtranjero = '';
/** Factura emitida antes de activar VERI*FACTU: no tiene registro de alta. */
let antigua = '';

/** NIF de los ejemplos de la AEAT (válido). El del cliente, otro NIF válido. */
const NIF_EMISOR = '89890001K';
const NIF_CLIENTE = 'B12345674';

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, cabeceras: Record<string, string> = headers): Promise<{ status: number; json: Json }> {
  const r = await app.inject({
    method,
    url,
    headers: body === undefined ? cabeceras : { ...cabeceras, 'content-type': 'application/json' },
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

/** Contenido (los flujos ya descomprimidos) del PDF de una factura. */
async function contenidoPdf(invoiceId: string): Promise<string> {
  const r = await app.inject({ method: 'GET', url: `/api/invoices/${invoiceId}/pdf`, headers });
  expect(r.statusCode).toBe(200);
  return [...r.rawPayload.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)]
    .map((m) => inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'))
    .join('\n');
}

/** Alta del primer registro de una factura (falla si es una anulación). */
function alta(invoiceId: string): Extract<RegistroAeat, { tipo: 'alta' }>['alta'] {
  const [reg] = registros(invoiceId);
  if (reg?.tipo !== 'alta') throw new Error('se esperaba un registro de alta');
  return reg.alta;
}

/** Cuenta de cliente con su NIF y, si se indica, su país. */
async function cuenta(nombre: string, taxId: string, pais?: string): Promise<string> {
  const r = await call('POST', '/api/workspaces', { name: nombre });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id: string = r.json.workspace.id;
  const p = await call('PATCH', `/api/workspaces/${id}`, { billingTaxId: taxId, ...(pais ? { billingCountry: pais } : {}) });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return id;
}

/** Siguiente número de la serie FV: un rechazo antes de emitir no lo gasta. */
const siguienteNumero = (): number => listInvoiceSeries().find((s) => s.code === 'FV')!.next_seq;

/** Alertas abiertas de un tipo. */
async function alertasAbiertas(tipo: string): Promise<Json[]> {
  const a = (await call('GET', '/api/alerts')).json;
  const lista: Json[] = Array.isArray(a) ? a : a.alerts ?? [];
  return lista.filter((x) => x.type === tipo && !x.resolved_at);
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

/** Rechazo del envío entero, como lo devuelve la AEAT (SOAP Fault). */
function soapFault(codigo: string, texto: string): string {
  return `<?xml version="1.0"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><env:Fault><faultcode>env:Client</faultcode><faultstring>Codigo[${codigo}].${texto}</faultstring></env:Fault></env:Body></env:Envelope>`;
}

const todoCorrecto = (r: Recibido): string => respuestaAeat(r, () => ({ estado: 'Correcto' }));

/** Corte después de entregar la petición: la AEAT pudo guardar el lote. */
const respuestaPerdida = (): Error => Object.assign(new Error('socket hang up'), { enviado: true });

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
  sesion = { cookie: `skyway_token=${signToken(admin.id)}`, 'sec-fetch-site': 'same-origin' };
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

  it('el nombre y el NIF del productor van juntos', async () => {
    let r = await call('PUT', '/api/verifactu', { productorNombre: 'Productora de Software SL' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/razón social y el NIF del productor juntos/);
    r = await call('PUT', '/api/verifactu', { productorNombre: 'Productora de Software SL', productorNif: NIF_CLIENTE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const apartado = (letra: string): string => r.json.declaracion.apartados.find((a: Json) => a.letra === letra).texto;
    expect(apartado('1.h')).toBe('Productora de Software SL');
    expect(apartado('1.i')).toBe(NIF_CLIENTE);
    // Vaciar solo uno dejaría el nombre de un productor con el NIF de otro.
    r = await call('PUT', '/api/verifactu', { productorNif: '' });
    expect(r.status).toBe(400);
    // Los dos vacíos: el productor es la empresa emisora.
    r = await call('PUT', '/api/verifactu', { productorNombre: '', productorNif: '' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(apartado('1.h')).toBe('Emisor Pruebas SL');
    expect(apartado('1.i')).toBe(NIF_EMISOR);
  });

  it('unos datos del productor guardados a medias no impiden cambiar de modo ni de entorno', async () => {
    // Como los que pudo dejar una versión anterior: el nombre sin el NIF.
    setSetting('verifactu', JSON.stringify({ ...JSON.parse(getSetting('verifactu') ?? '{}'), productorNombre: 'Productora a medias SL', productorNif: '' }));
    let r = await call('PUT', '/api/verifactu', { entorno: 'pruebas' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Mientras, el productor efectivo es la empresa emisora.
    expect(r.json.declaracion.apartados.find((a: Json) => a.letra === '1.h').texto).toBe('Emisor Pruebas SL');
    r = await call('PUT', '/api/verifactu', { productorNombre: '', productorNif: '' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it('la declaración responsable se descarga en texto, con los rótulos del modelo de la AEAT en su orden', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/verifactu/declaracion.txt', headers });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="declaracion-responsable-skyway-${config.version}.txt"`);
    const texto = r.body;
    expect(texto.startsWith('DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN\n')).toBe(true);
    expect(texto).toContain('1.a) Nombre del sistema informático a que se refiere esta declaración responsable:\nSkyway\n');
    expect(texto).toContain(`1.c) Identificador completo de la versión concreta del sistema informático a que se refiere esta declaración responsable:\n${config.version}\n`);
    expect(texto).toMatch(/^1\.e\) [^\n]*:\nS - Sí$/m);
    expect(texto).toMatch(/^1\.f\) [^\n]*:\nN - No$/m);
    // El orden lo fija el art. 15.1 de la Orden: de la a) a la l), y el anexo.
    expect([...texto.matchAll(/^(\d\.[a-l])\) /gm)].map((m) => m[1])).toEqual(['1.a', '1.b', '1.c', '1.d', '1.e', '1.f', '1.g', '1.h', '1.i', '1.j', '1.k', '1.l', '2.c']);
    // Sin lugar ni fecha de suscripción, la descarga lo dice.
    expect(texto).toMatch(/\n\nDatos pendientes: [^\n]*Lugar de suscripción/);
  });

  it('la fecha de suscripción de la declaración vale para su versión: tras actualizar Skyway, vuelve a quedar pendiente', async () => {
    const apartado = (j: Json, letra: string): string => j.declaracion.apartados.find((a: Json) => a.letra === letra).texto;
    const fechaPendiente = (j: Json): boolean => j.declaracion.pendientes.some((p: string) => p.startsWith('Fecha de suscripción'));
    let r = await call('PUT', '/api/verifactu', { declaracionLugar: 'Madrid, España', declaracionFecha: '2026-11-09' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(fechaPendiente(r.json)).toBe(false);
    expect(apartado(r.json, '1.l')).toBe('9 de noviembre de 2026. Madrid, España.');
    // Como tras actualizar: la fecha guardada es la de otra versión.
    setSetting('verifactu', JSON.stringify({ ...JSON.parse(getSetting('verifactu') ?? '{}'), declaracionVersion: '0.40.0' }));
    r = await call('GET', '/api/verifactu');
    expect(r.json.declaracion.pendientes).toContain(`Fecha de suscripción de la versión ${config.version} (la guardada es de la versión 0.40.0)`);
    expect(apartado(r.json, '1.l')).toBe('(pendiente). Madrid, España.');
    // Guardar otros datos no la suscribe; poner la fecha, sí.
    r = await call('PUT', '/api/verifactu', { declaracionLugar: 'Madrid, España', declaracionFecha: '2026-11-09' });
    expect(fechaPendiente(r.json)).toBe(true);
    r = await call('PUT', '/api/verifactu', { declaracionFecha: '2026-11-10' });
    expect(fechaPendiente(r.json)).toBe(false);
    // Lo deja como estaba para el resto de pruebas.
    r = await call('PUT', '/api/verifactu', { declaracionLugar: '', declaracionFecha: '' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
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
    for (const url of ['/api/verifactu', '/api/verifactu/declaracion.txt', `/api/invoices/${primera}/verifactu`]) {
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

  it('en el entorno de pruebas, el PDF no lleva el QR ni la leyenda VERI*FACTU: dice que el registro es de prueba', async () => {
    // La frase «VERI*FACTU» solo se admite si los registros llegan a la AEAT con
    // efectos fiscales (art. 6.5.b del RD 1619/2012 y art. 20.1.b de la Orden).
    const contenido = await contenidoPdf(primera);
    expect(contenido).not.toContain('(QR tributario:) Tj');
    expect(contenido).not.toContain('(VERI*FACTU) Tj');
    // El PDF escribe en octal lo que no es ASCII: «ó» es \363.
    expect(contenido).toMatch(/\(Registro de facturaci\\363n de prueba: [^)]*\) Tj/);
    // Sin los módulos del QR (un trazado con más de cien rectángulos).
    expect((contenido.match(/ re/g) ?? []).length).toBeLessThan(50);
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

/**
 * Lo que la AEAT rechazaría se para antes de emitir, sin gastar número: una
 * factura emitida con su registro rechazado obliga a subsanar o rectificar.
 */
describe('validaciones antes de emitir', () => {
  let wsUk = '';

  it('el país del cliente va con el código de la AEAT (UK pasa a GB) y uno que la AEAT no admite bloquea la emisión', async () => {
    wsUk = await cuenta('UK Client Ltd', '123456789', 'UK');
    const id = await borrador(wsUk);
    let r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(alta(id).Destinatarios).toEqual([{ NombreRazon: 'UK Client Ltd', IDOtro: { CodigoPais: 'GB', IDType: '04', ID: '123456789' } }]);
    // Kosovo (XK) no está en la lista de países de la AEAT.
    const xk = await cuenta('Klient Prishtina', '810000000', 'XK');
    const otra = await borrador(xk);
    const antes = siguienteNumero();
    r = await emitir(otra);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/no es un código que admita la AEAT/);
    expect(siguienteNumero()).toBe(antes);
    expect(registrosDeFactura(otra)).toHaveLength(0);
  });

  it('un NIF-IVA con la estructura de su país va como NIF-IVA (02); sin ella, como documento del país (04), salvo que el régimen exija NIF-IVA', async () => {
    const gr = await cuenta('Pelatis AE', '123456789', 'GR');
    let id = await borrador(gr);
    let r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Grecia usa el prefijo EL, y con IDType 02 el país no va aparte.
    expect(alta(id).Destinatarios).toEqual([{ NombreRazon: 'Pelatis AE', IDOtro: { IDType: '02', ID: 'EL123456789' } }]);
    const fr = await cuenta('Client Particulier', '12345', 'FR');
    id = await borrador(fr);
    r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(alta(id).Destinatarios).toEqual([{ NombreRazon: 'Client Particulier', IDOtro: { CodigoPais: 'FR', IDType: '04', ID: '12345' } }]);
    // Un servicio no sujeto a un cliente de la UE sí exige su NIF-IVA.
    id = await borrador(fr, [{ label: 'Alojamiento', unitCents: 5000 }]);
    r = await call('PATCH', `/api/invoices/${id}`, { vatRegime: 'inversion_sujeto_pasivo' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const antes = siguienteNumero();
    r = await emitir(id);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/NIF-IVA del cliente/);
    expect(siguienteNumero()).toBe(antes);
  });

  it('el tipo de IVA tiene que ser uno de los que admite la AEAT en la fecha de la operación', async () => {
    const id = await borrador(wsId, [{ label: 'Alojamiento', unitCents: 10000, taxRate: 7 }]);
    const r = await emitir(id);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/no admite un IVA del 7,00 %/);
    expect(registrosDeFactura(id)).toHaveLength(0);
  });

  it('una línea al 0 % en régimen general va como operación sujeta al 0 % (S1)', async () => {
    const id = await borrador(wsId, [{ label: 'Formación', unitCents: 10000, taxRate: 0 }]);
    const r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const a = alta(id);
    expect(a.Desglose).toEqual([{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '0.00', BaseImponibleOimporteNoSujeto: '100.00', CuotaRepercutida: '0.00' }]);
    expect(a.CuotaTotal).toBe('0.00');
    expect(a.ImporteTotal).toBe('100.00');
  });

  it('un cliente con el mismo NIF que el emisor (autoconsumo) es válido', async () => {
    const propia = await cuenta('Emisor Pruebas SL (consumo propio)', NIF_EMISOR);
    const id = await borrador(propia);
    const r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(alta(id).Destinatarios).toEqual([{ NombreRazon: 'Emisor Pruebas SL (consumo propio)', NIF: NIF_EMISOR }]);
  });

  it('solo se registran facturas en euros', async () => {
    const ahora = Date.now();
    let r = await call('POST', `/api/workspaces/${wsId}/invoices`, {
      lines: [{ label: 'Alojamiento', unitCents: 10000, taxRate: 21 }],
      currency: 'USD',
      periodStart: ahora - 86_400_000,
      periodEnd: ahora,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.invoice.id;
    r = await emitir(id);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/exige los importes en euros/);
    expect(registrosDeFactura(id)).toHaveLength(0);
  });

  it('una rectificativa por créditos incobrables (R3) exige un cliente con NIF español; una por concurso (R2) admite además un NIF-IVA de la UE', async () => {
    /** Emite una factura de la cuenta y le prepara una rectificativa con esa causa. */
    const rectificativa = async (ws: string, causa: 'R2' | 'R3'): Promise<string> => {
      const original = await borrador(ws);
      expect((await emitir(original)).status).toBe(200);
      const r = await call('POST', `/api/invoices/${original}/rectify`, { reason: 'Impago del cliente', cause: causa });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json.invoice.id;
    };
    let r = await emitir(await rectificativa(wsUk, 'R3'));
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/\(R3\) solo admite clientes con NIF español/);
    r = await emitir(await rectificativa(wsUk, 'R2'));
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/\(R2\) solo admite clientes con NIF español o NIF-IVA/);
    let id = await rectificativa(wsExtranjero, 'R2');
    r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(alta(id)).toMatchObject({ TipoFactura: 'R2', Destinatarios: [{ IDOtro: { IDType: '02', ID: 'DE123456789' } }] });
    id = await rectificativa(wsId, 'R3');
    r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(alta(id)).toMatchObject({ TipoFactura: 'R3', Destinatarios: [{ NIF: NIF_CLIENTE }] });
  });

  it('con VERI*FACTU desactivado, los registros de pruebas que quedan en cola no son una incidencia', async () => {
    // Hay registros de pruebas en cola y no hay certificado: con el modo activo, es una incidencia.
    expect(await remisionTick({ ahora: Date.now() })).toEqual({ enviado: false, motivo: 'sin_certificado' });
    expect(await alertasAbiertas('verifactu_remision')).toHaveLength(1);
    let r = await call('PUT', '/api/verifactu', { modo: 'desactivado' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.avisos.map((a: Json) => a.tipo)).not.toContain('incidencia');
    expect(await alertasAbiertas('verifactu_remision')).toHaveLength(0);
    // La cola de pruebas se queda quieta y la alerta no vuelve a abrirse.
    expect(await remisionTick({ ahora: Date.now() })).toEqual({ enviado: false, motivo: 'sin_pendientes' });
    expect(await alertasAbiertas('verifactu_remision')).toHaveLength(0);
    r = await call('PUT', '/api/verifactu', { modo: 'verifactu' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.avisos.map((a: Json) => a.tipo)).toContain('incidencia');
  });
});

describe.skipIf(!hayOpenssl)('certificado y remisión a una AEAT simulada', () => {
  it('cargar o retirar el certificado exige sesión de navegador: con un token de API, no', async () => {
    let r = await call('POST', '/api/verifactu/certificado', { pfx: leer('cliente.p12').toString('base64'), password: 'clave de pruebas' });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/sesión de navegador/);
    r = await call('DELETE', '/api/verifactu/certificado');
    expect(r.status).toBe(403);
    expect((await call('GET', '/api/verifactu')).json.certificado).toBeNull();
  });

  it('rechaza un certificado con la contraseña equivocada y acepta el bueno sin devolverlo', async () => {
    let r = await call('POST', '/api/verifactu/certificado', { pfx: leer('cliente.p12').toString('base64'), password: 'mala' }, sesion);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('La contraseña del certificado no es correcta.');
    r = await call('POST', '/api/verifactu/certificado', { pfx: leer('cliente.p12').toString('base64'), password: 'clave de pruebas' }, sesion);
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
    // La conexión ni se abrió: la AEAT no tiene nada, el envío no queda incierto.
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'pendiente', incidencia: 1, intentos: 1, envio_incierto: 0 });
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

  it('un rechazo del envío entero (SOAP Fault) no pierde los registros, y «Enviar ahora» respeta la espera de la AEAT', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 900_000;
    let res = await remisionTick({ ahora: t0, transporte: transporte(() => soapFault('4111', 'Error técnico al crear el trámite.')) });
    expect(res).toMatchObject({ resultado: 'rechazado' });
    expect(res.error).toContain('[4111]');
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'pendiente', incidencia: 1 });
    // La AEAT sí recibió el envío: su espera entre envíos también cuenta aquí.
    res = await remisionTick({ ahora: t0 + 1000, forzar: true, transporte: transporte(() => new Error('no debería llamarse')) });
    expect(res).toEqual({ enviado: false, motivo: 'esperando' });
    res = await remisionTick({ ahora: t0 + 61_000, forzar: true, transporte: transporte(todoCorrecto) });
    expect(res.resultado).toBe('correcto');
    expect(registrosDeFactura(id)[0].estado_remision).toBe('correcto');
  });

  it('si un registro hace rechazar el envío entero, se parte el lote hasta dar con él: queda rechazado y el resto sigue', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await borrador(wsId);
      expect((await emitir(id)).status).toBe(200);
      ids.push(id);
    }
    const mala = ids[2];
    const numMala = registrosDeFactura(mala)[0].num_serie_factura;
    // La AEAT simulada rechaza entero cualquier envío que lleve el registro de `mala`.
    const aeat = transporte((r) => (r.registros.some((x) => x.num === numMala) ? soapFault('4102', 'El XML no cumple el esquema. Falta informar campo obligatorio.') : todoCorrecto(r)));
    const t0 = Date.now() + 1_200_000;
    const tamanos: number[] = [];
    let res = await remisionTick({ ahora: t0, transporte: aeat });
    expect(res).toMatchObject({ resultado: 'rechazado', registros: 4 });
    tamanos.push(res.registros!);
    // Cada envío, pasada la espera de la AEAT (60 s), con la mitad del lote que falló.
    for (let paso = 1; paso <= 4; paso++) {
      res = await remisionTick({ ahora: t0 + paso * 61_000, transporte: aeat });
      tamanos.push(res.registros!);
    }
    // 4 → [1, 2] bien, [3, 4] mal → [3] culpable → [4] bien.
    expect(tamanos).toEqual([4, 2, 2, 1, 1]);
    expect(ids.map((id) => registrosDeFactura(id)[0].estado_remision)).toEqual(['correcto', 'correcto', 'incorrecto', 'correcto']);
    expect(registrosDeFactura(mala)[0].codigo_error).toBe('4102');
    const inv = (await call('GET', `/api/workspaces/${wsId}/invoices`)).json.invoices.find((i: Json) => i.id === mala);
    expect(inv.verifactu).toMatchObject({ estado: 'incorrecto', codigoError: '4102', accion: 'subsanar' });
    expect((await alertasAbiertas('verifactu_registro')).some((a) => a.title.includes(inv.number))).toBe(true);
    // Encontrado el culpable, la cola vuelve a los lotes enteros.
    for (const otra of [await borrador(wsId), await borrador(wsId)]) expect((await emitir(otra)).status).toBe(200);
    res = await remisionTick({ ahora: t0 + 5 * 61_000, transporte: aeat });
    expect(res).toMatchObject({ resultado: 'correcto', registros: 2 });
  });

  it('tras un envío sin respuesta, un duplicado (3000) toma el estado que ya tenía la AEAT', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 2_000_000;
    // El envío llega a la AEAT, pero la respuesta se pierde por el camino.
    await remisionTick({ ahora: t0, transporte: transporte(respuestaPerdida) });
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'pendiente', intentos: 1, envio_incierto: 1 });
    // La AEAT pudo contarlo como envío: «Enviar ahora» respeta su espera.
    let res = await remisionTick({ ahora: t0 + 1000, forzar: true, transporte: transporte(() => new Error('no debería llamarse')) });
    expect(res).toEqual({ enviado: false, motivo: 'esperando' });
    res = await remisionTick({ ahora: t0 + 61_000, forzar: true, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Duplicado', previo: 'Correcta' }))) });
    expect(res.enviado).toBe(true);
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'correcto', id_peticion: '2025PET0001' });
  });

  it('en el primer envío, un duplicado (3000) es un rechazo: la AEAT ya tiene otra factura con ese número y fecha', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    await remisionTick({ ahora: Date.now() + 2_150_000, forzar: true, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Duplicado', previo: 'Correcta' }))) });
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'incorrecto', codigo_error: '3000', id_peticion: null });
  });

  it('tras un rechazo del envío entero (SOAP Fault), un duplicado (3000) también es un rechazo: la AEAT no guardó nada', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 2_300_000;
    await remisionTick({ ahora: t0, transporte: transporte(() => soapFault('4111', 'Error técnico al crear el trámite.')) });
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'pendiente', intentos: 1, envio_incierto: 0 });
    await remisionTick({ ahora: t0 + 61_000, forzar: true, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Duplicado', previo: 'Correcta' }))) });
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'incorrecto', codigo_error: '3000', id_peticion: null });
  });

  it('si tras un corte la AEAT rechaza al registro culpable, el corte ha terminado: el aviso se cierra y lo siguiente nace sin incidencia', async () => {
    const x = await borrador(wsId);
    expect((await emitir(x)).status).toBe(200);
    const t0 = Date.now() + 2_500_000;
    await remisionTick({ ahora: t0, transporte: transporte(() => new Error('connect ECONNREFUSED')) });
    expect(await alertasAbiertas('verifactu_remision')).toHaveLength(1);
    const res = await remisionTick({ ahora: t0 + 1000, forzar: true, transporte: transporte(() => soapFault('4102', 'El XML no cumple el esquema. Falta informar campo obligatorio.')) });
    expect(res).toMatchObject({ resultado: 'rechazado', registros: 1 });
    expect(registrosDeFactura(x)[0].estado_remision).toBe('incorrecto');
    // No queda ningún registro con incidencia por remitir: el aviso se cierra.
    expect(await alertasAbiertas('verifactu_remision')).toHaveLength(0);
    const y = await borrador(wsId);
    expect((await emitir(y)).status).toBe(200);
    expect(registrosDeFactura(y)[0].incidencia).toBe(0);
    expect((await remisionTick({ ahora: t0 + 62_000, transporte: transporte(todoCorrecto) })).resultado).toBe('correcto');
  });

  it('al reenviar un alta, un duplicado de una factura «Anulada» no es el alta propia: es otra factura', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 2_650_000;
    await remisionTick({ ahora: t0, transporte: transporte(respuestaPerdida) });
    expect(registrosDeFactura(id)[0].envio_incierto).toBe(1);
    // La anulación de una factura nunca sale antes de resolverse su alta.
    await remisionTick({ ahora: t0 + 61_000, transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Duplicado', previo: 'Anulada' }))) });
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'incorrecto', codigo_error: '3000' });
  });

  it('una anulación reenviada tras un envío incierto que la AEAT da por ya dada de baja (3001) queda remitida', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 2_772_000;
    expect((await remisionTick({ ahora: t0, transporte: transporte(todoCorrecto) })).resultado).toBe('correcto');
    expect((await call('PATCH', `/api/invoices/${id}`, { status: 'void' })).status).toBe(200);
    await remisionTick({ ahora: t0 + 61_000, transporte: transporte(respuestaPerdida) });
    await remisionTick({
      ahora: t0 + 122_000,
      transporte: transporte((r) => respuestaAeat(r, () => ({ estado: 'Incorrecto', codigo: '3001', descripcion: 'El registro de facturación ya ha sido dado de baja.' }))),
    });
    const [altaFila, anulacion] = registrosDeFactura(id);
    expect(altaFila.estado_remision).toBe('correcto');
    expect(anulacion).toMatchObject({ record_type: 'anulacion', estado_remision: 'correcto' });
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
    const alertaDeLaFactura = async (): Promise<boolean> => (await alertasAbiertas('verifactu_registro')).some((a) => a.title.includes(inv.number));
    expect(await alertaDeLaFactura()).toBe(true);
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
    // Aceptada la subsanación, la alerta del rechazo queda resuelta.
    expect(await alertaDeLaFactura()).toBe(false);
    // Nada más que subsanar.
    expect((await call('POST', `/api/invoices/${id}/verifactu/subsanar`)).status).toBe(409);
  });

  it('un NIF de persona física que no está en el censo (2001) se subsana declarándolo «no censado» (07)', async () => {
    const pf = await cuenta('Lucía Pérez Gómez', '00000000T');
    const id = await borrador(pf);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 3_500_000;
    await remisionTick({
      ahora: t0,
      forzar: true,
      transporte: transporte((r) =>
        respuestaAeat(r, () => ({ estado: 'AceptadoConErrores', codigo: '2001', descripcion: 'El NIF del bloque Destinatarios no está identificado en el censo de la AEAT.' })),
      ),
    });
    expect(registrosDeFactura(id)[0]).toMatchObject({ estado_remision: 'aceptado_con_errores', codigo_error: '2001' });
    const r = await call('POST', `/api/invoices/${id}/verifactu/subsanar`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const sub = JSON.parse(registrosDeFactura(id)[1].registro_json) as RegistroAeat;
    if (sub.tipo !== 'alta') throw new Error('se esperaba un alta');
    expect(sub.alta.Subsanacion).toBe('S');
    // La AEAT tiene el alta (aceptada con errores): sin «RechazoPrevio».
    expect(sub.alta.RechazoPrevio).toBeUndefined();
    expect(sub.alta.Destinatarios).toEqual([{ NombreRazon: 'Lucía Pérez Gómez', IDOtro: { CodigoPais: 'ES', IDType: '07', ID: '00000000T' } }]);
    await remisionTick({ ahora: t0 + 61_000, transporte: transporte(todoCorrecto) });
    expect(registrosDeFactura(id)[1].estado_remision).toBe('correcto');
  });

  it('cargar un certificado levanta la espera de una hora tras un rechazo de configuración, pero no la de la AEAT', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    const t0 = Date.now() + 3_700_000;
    await remisionTick({ ahora: t0, transporte: transporte(() => soapFault('4112', 'El titular del certificado debe ser Obligado Emisión, Colaborador Social, Apoderado o Sucesor.')) });
    let res = await remisionTick({ ahora: t0 + 120_000, transporte: transporte(() => new Error('no debería llamarse')) });
    expect(res).toEqual({ enviado: false, motivo: 'esperando' });
    const r = await call('POST', '/api/verifactu/certificado', { pfx: leer('cliente.p12').toString('base64'), password: 'clave de pruebas' }, sesion);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // La espera de la AEAT tras el rechazo (60 s) sigue contando…
    res = await remisionTick({ ahora: t0 + 30_000, transporte: transporte(() => new Error('no debería llamarse')) });
    expect(res).toEqual({ enviado: false, motivo: 'esperando' });
    // …pero la hora de espera por el rechazo de configuración ya no.
    res = await remisionTick({ ahora: t0 + 120_000, transporte: transporte(todoCorrecto) });
    expect(res.resultado).toBe('correcto');
    expect(registrosDeFactura(id)[0].estado_remision).toBe('correcto');
  });

  it('una petición que no llega a salir no queda como enviada; una que sale y no tiene respuesta, sí', async () => {
    const cert = { pfx: leer('cliente.p12'), passphrase: 'clave de pruebas' };
    // Puerto cerrado: la conexión ni se abre.
    const libre = net.createServer();
    await new Promise<void>((ok) => libre.listen(0, '127.0.0.1', ok));
    const puertoCerrado = (libre.address() as AddressInfo).port;
    await new Promise((ok) => libre.close(ok));
    const rechazada = await peticionHttps(`https://localhost:${puertoCerrado}/x`, '<x/>', cert, { timeoutMs: 2000, ca: leer('servidor.pem') }).catch((e: unknown) => e);
    expect(rechazada).toMatchObject({ enviado: false });
    // Un servidor que recibe la petición entera y no contesta nunca.
    const mudo = https.createServer({ key: leer('servidor.key'), cert: leer('servidor.pem') }, (req) => req.resume());
    await new Promise<void>((ok) => mudo.listen(0, '127.0.0.1', ok));
    try {
      const { port } = mudo.address() as AddressInfo;
      const sinRespuesta = await peticionHttps(`https://localhost:${port}/x`, '<x/>', cert, { timeoutMs: 500, ca: leer('servidor.pem') }).catch((e: unknown) => e);
      expect(sinRespuesta).toMatchObject({ enviado: true, message: expect.stringMatching(/no ha respondido/) });
    } finally {
      mudo.closeAllConnections();
      await new Promise((ok) => mudo.close(ok));
    }
  });

  it('cada cadena tiene su cola: un corte en una no frena a la otra, y lo generado durante el corte consta con incidencia', async () => {
    const OTRO_NIF = '12345678Z';
    const x = await borrador(wsId);
    expect((await emitir(x)).status).toBe(200);
    let r = await call('PUT', '/api/billing/profile', { taxId: OTRO_NIF });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const y = await borrador(wsId);
    expect((await emitir(y)).status).toBe(200);
    expect(registrosDeFactura(y)[0]).toMatchObject({ emisor_nif: OTRO_NIF, incidencia: 0 });
    // Otro obligado, otra cadena: empieza de cero.
    expect(alta(y).Encadenamiento).toEqual({ PrimerRegistro: 'S' });
    // La AEAT simulada no contesta a los envíos del primer NIF.
    const aeat = transporte((env) => (env.xml.includes(`<sum1:NIF>${NIF_EMISOR}</sum1:NIF></sum1:ObligadoEmision>`) ? new Error('connect ETIMEDOUT') : todoCorrecto(env)));
    const t0 = Date.now() + 4_000_000;
    let res = await remisionTick({ ahora: t0, transporte: aeat });
    expect(res).toMatchObject({ resultado: 'fallo', registros: 1 });
    expect(registrosDeFactura(x)[0]).toMatchObject({ estado_remision: 'pendiente', incidencia: 1 });
    // Lo que se genera en esa cadena mientras dura el corte nace con incidencia.
    r = await call('PUT', '/api/billing/profile', { taxId: NIF_EMISOR });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const z = await borrador(wsId);
    expect((await emitir(z)).status).toBe(200);
    expect(registrosDeFactura(z)[0].incidencia).toBe(1);
    // La otra cadena envía sin esperar a la primera.
    res = await remisionTick({ ahora: t0 + 1000, transporte: aeat });
    expect(res).toMatchObject({ resultado: 'correcto', registros: 1 });
    expect(recibidos.at(-1)!.xml).toContain(`<sum1:NIF>${OTRO_NIF}</sum1:NIF></sum1:ObligadoEmision>`);
    expect(recibidos.at(-1)!.xml).not.toContain('<sum1:Incidencia>S</sum1:Incidencia>');
    expect(registrosDeFactura(y)[0].estado_remision).toBe('correcto');
    expect(registrosDeFactura(x)[0].estado_remision).toBe('pendiente');
    // El aviso de incidencia sigue mientras la primera cadena tenga pendientes.
    expect(await alertasAbiertas('verifactu_remision')).toHaveLength(1);
    // Pasada su espera, la primera cadena envía lo suyo con la marca de incidencia.
    res = await remisionTick({ ahora: t0 + 61_000, transporte: transporte(todoCorrecto) });
    expect(res).toMatchObject({ resultado: 'correcto', registros: 2 });
    expect(recibidos.at(-1)!.xml).toContain('<sum1:Incidencia>S</sum1:Incidencia>');
    expect(registrosDeFactura(x)[0].estado_remision).toBe('correcto');
    expect(registrosDeFactura(z)[0].estado_remision).toBe('correcto');
    expect(await alertasAbiertas('verifactu_remision')).toHaveLength(0);
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

  it('con registros de producción no se puede desactivar VERI*FACTU ni volver a pruebas (art. 17 de la Orden)', async () => {
    let r = await call('PUT', '/api/verifactu', { entorno: 'produccion' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Sin ningún registro de producción todavía, volver a pruebas sí se puede.
    r = await call('PUT', '/api/verifactu', { entorno: 'pruebas' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call('PUT', '/api/verifactu', { entorno: 'produccion' });
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
    r = await call('PUT', '/api/verifactu', { entorno: 'pruebas' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/seguir activo y en producción/);
    r = await call('PUT', '/api/billing/profile', { sifMode: 'desactivado' });
    expect(r.status).toBe(409);
    expect((await call('GET', '/api/verifactu')).json).toMatchObject({ modo: 'verifactu', ajustes: { entorno: 'produccion' } });
    // Un solo obligado tributario: con registros de producción, el NIF del emisor no cambia.
    r = await call('PUT', '/api/billing/profile', { taxId: '12345678Z' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/el NIF del emisor no se puede cambiar/);
  });

  it('en producción, el PDF lleva el QR tributario y la leyenda VERI*FACTU al principio', async () => {
    const id = await borrador(wsId);
    expect((await emitir(id)).status).toBe(200);
    expect(registrosDeFactura(id)[0].entorno).toBe('produccion');
    const contenido = await contenidoPdf(id);
    expect(contenido).toContain('(QR tributario:) Tj');
    expect(contenido).toContain('(VERI*FACTU) Tj');
    expect(contenido).not.toContain('Registro de facturaci\\363n de prueba');
    // Los módulos del QR: un único trazado relleno con muchos rectángulos.
    expect((contenido.match(/ re/g) ?? []).length).toBeGreaterThan(100);
  });
});

describe.skipIf(!hayOpenssl)('punto de acceso del certificado de sello', () => {
  it('un certificado de sello se remite por el punto de acceso de sello', async () => {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'sello.key', '-out', 'sello.pem', '-days', '7300', '-subj', `/C=ES/O=EMISOR PRUEBAS SL/organizationIdentifier=VATES-${NIF_EMISOR}/CN=SELLO ELECTRONICO DE PRUEBAS`]);
    openssl(['pkcs12', '-export', '-inkey', 'sello.key', '-in', 'sello.pem', '-out', 'sello.p12', '-passout', 'pass:sello']);
    let r = await call('POST', '/api/verifactu/certificado', { pfx: leer('sello.p12').toString('base64'), password: 'sello' }, sesion);
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

  it('si el último registro no cuadra con su huella, se anota la anomalía y se avisa, pero la facturación sigue (FAQ 15.2)', async () => {
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
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // El registro nuevo se encadena con el último, como siempre.
    expect(alta(id).Encadenamiento.RegistroAnterior?.Huella).toBe('A'.repeat(64));
    const vista = (await call('GET', '/api/verifactu')).json;
    const evento = vista.eventos.find((e: Json) => e.tipo_evento === 'anomalia_cadena');
    expect(evento?.detalle).toMatch(/no cuadra con sus datos/);
    expect(evento?.detalle).toMatch(/no apunta al registro anterior/);
    expect(vista.eventosIntegros).toBe(true);
    const alertas = await alertasAbiertas('verifactu_cadena');
    expect(alertas).toHaveLength(1);
    expect(alertas[0].severity).toBe('critical');
  });

  it.skipIf(!hayOpenssl)('un registro con los datos ilegibles se anota como anomalía al encadenar y, en la cola, queda rechazado sin frenar a los demás', async () => {
    const db = new Database(path.join(config.dataDir, 'skyway.db'));
    try {
      const ultimo = db.prepare("SELECT * FROM invoice_ledger WHERE entorno = 'produccion' ORDER BY seq DESC LIMIT 1").get() as Record<string, unknown>;
      db.prepare(
        `INSERT INTO invoice_ledger (id, seq, invoice_id, record_type, emisor_nif, num_serie_factura, fecha_expedicion, tipo_factura, cuota_total_cents, importe_total_cents, fecha_hora_gen, huella, huella_anterior, sif_mode, qr_url, estado_remision, version_sif, created_at, entorno, registro_json)
         VALUES (@id, @seq, @invoice_id, @record_type, @emisor_nif, @num_serie_factura, @fecha_expedicion, @tipo_factura, @cuota_total_cents, @importe_total_cents, @fecha_hora_gen, @huella, @huella_anterior, @sif_mode, @qr_url, 'pendiente', @version_sif, @created_at, @entorno, @registro_json)`,
      ).run({ ...ultimo, id: 'vfr_ilegible', seq: Number(ultimo.seq) + 1, created_at: Date.now() - 500, registro_json: 'no es JSON' });
    } finally {
      db.close();
    }
    const id = await borrador(wsId);
    const r = await emitir(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const eventos = (await call('GET', '/api/verifactu')).json.eventos as Json[];
    expect(eventos.some((e) => e.tipo_evento === 'anomalia_cadena' && /no se pueden leer/.test(e.detalle))).toBe(true);
    // El registro ilegible es de la misma factura que el anterior (un envío no
    // lleva dos registros de una factura): la cola puede necesitar dos pasadas.
    let ahora = Date.now() + 10_000_000;
    for (let i = 0; i < 4 && registrosDeFactura(id)[0].estado_remision === 'pendiente'; i++, ahora += 61_000) {
      const res = await remisionTick({ ahora, forzar: true, transporte: transporte(todoCorrecto) });
      expect(res.resultado).toBe('correcto');
    }
    expect(registrosDeFactura(id)[0].estado_remision).toBe('correcto');
    const db2 = new Database(path.join(config.dataDir, 'skyway.db'));
    try {
      expect(db2.prepare("SELECT estado_remision FROM invoice_ledger WHERE id = 'vfr_ilegible'").get()).toEqual({ estado_remision: 'incorrecto' });
    } finally {
      db2.close();
    }
  });
});
