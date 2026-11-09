import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generarQr, type CodigoQr, type NivelCorreccion } from '../src/verifactu/qr';

/**
 * Generador del QR de la factura VERI*FACTU (`verifactu/qr.ts`). La lectura con
 * decodificadores reales (jsQR, ZXing) y la comparación módulo a módulo con la
 * implementación de referencia `qrcode` se hacen fuera del repositorio, para no
 * añadir dependencias; aquí queda su resultado como vectores fijos, más
 * comprobaciones de estructura contra las tablas de la norma, de modo que una
 * regresión se note en la CI sin decodificar nada.
 */

const URL_EJEMPLO =
  'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.4';
const ACENTOS = 'Factura nº F-2024/0001 · Importe: 1.234,56 € · Cliente: Muñoz Pérez, S.L.';
/** ASCII imprimible sin patrón corto: varios bloques de dos tamaños y recuento de 16 bits. */
const LARGO = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(33 + ((i * 37) % 94))).join('');
/** Lo máximo que admite el nivel M (versión 40). */
const MAXIMO_M = Array.from({ length: 2331 }, (_, i) => String.fromCharCode(33 + ((i * 53) % 94))).join('');
const urlCotejo = (serie: string, importe: string): string =>
  `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=${serie}&fecha=15-03-2025&importe=${importe}`;

const NIVELES: NivelCorreccion[] = ['L', 'M', 'Q', 'H'];

/** Filas como cadenas de '1' (oscuro) y '0' (claro). */
const filas = (qr: CodigoQr): string[] => qr.modulos.map((f) => f.map((m) => (m ? '1' : '0')).join(''));
const huella = (qr: CodigoQr): string => createHash('sha256').update(filas(qr).join('\n')).digest('hex');

/** Recorte de la matriz como cadenas de '1'/'0'. */
const recorte = (qr: CodigoQr, fila: number, columna: number, alto: number, ancho: number): string[] =>
  filas(qr).slice(fila, fila + alto).map((f) => f.slice(columna, columna + ancho));

/**
 * Información de formato ya enmascarada, del bit 14 al 0, por nivel y máscara
 * (tabla C.1 de la norma). Se copia de la norma en vez de calcularla para no
 * repetir aquí el BCH del generador.
 */
const FORMATO: Record<NivelCorreccion, readonly string[]> = {
  L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101',
    '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
  M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
  Q: ['011010101011111', '011000001101000', '011111100110001', '011101000000110',
    '010010010110100', '010000110000011', '010111011011010', '010101111101101'],
  H: ['001011010001001', '001001110111110', '001110011100111', '001100111010000',
    '000011101100010', '000001001010101', '000110100001100', '000100000111011'],
};

/** Las dos copias de la información de formato, con el bit i en la posición i (figura 25). */
function leerFormato(qr: CodigoQr): [number, number] {
  const n = qr.tamano;
  const primera: [number, number][] = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  const segunda: [number, number][] = [
    ...Array.from({ length: 8 }, (_, i): [number, number] => [8, n - 1 - i]),
    ...Array.from({ length: 7 }, (_, i): [number, number] => [n - 7 + i, 8]),
  ];
  const leer = (posiciones: [number, number][]): number =>
    posiciones.reduce((acc, [f, c], i) => acc | (Number(qr.modulos[f][c]) << i), 0);
  return [leer(primera), leer(segunda)];
}

/** Los dos bloques de información de versión (desde la versión 7), con el bit i en la posición i. */
function leerVersion(qr: CodigoQr): [number, number] {
  const n = qr.tamano;
  let derecha = 0;
  let izquierda = 0;
  for (let i = 0; i < 18; i++) {
    const a = Math.floor(i / 3);
    const b = n - 11 + (i % 3);
    derecha |= Number(qr.modulos[a][b]) << i;
    izquierda |= Number(qr.modulos[b][a]) << i;
  }
  return [derecha, izquierda];
}

describe('generarQr: versión y tamaño', () => {
  it('codifica la URL de cotejo de la AEAT con nivel M en la versión 8 (49 × 49 módulos)', () => {
    const qr = generarQr(URL_EJEMPLO, 'M');
    expect(qr.version).toBe(8);
    expect(qr.tamano).toBe(49);
    expect(qr.nivel).toBe('M');
    expect(qr.modulos).toHaveLength(49);
    for (const fila of qr.modulos) expect(fila).toHaveLength(49);
  });

  it('usa el nivel M por defecto', () => {
    expect(generarQr(URL_EJEMPLO)).toEqual(generarQr(URL_EJEMPLO, 'M'));
  });

  it('elige la versión más pequeña en la que cabe el texto (capacidades en modo byte de la norma)', () => {
    // Versión 9 → 10: el recuento pasa de 8 a 16 bits. Versión 40: el máximo.
    const capacidad: Record<NivelCorreccion, [number, number][]> = {
      L: [[1, 17], [9, 230], [26, 1367], [40, 2953]],
      M: [[1, 14], [9, 180], [26, 1059], [40, 2331]],
      Q: [[1, 11], [9, 130], [26, 751], [40, 1663]],
      H: [[1, 7], [9, 98], [26, 593], [40, 1273]],
    };
    for (const nivel of NIVELES) {
      for (const [version, bytes] of capacidad[nivel]) {
        const qr = generarQr('a'.repeat(bytes), nivel);
        expect([qr.version, qr.tamano]).toEqual([version, 17 + 4 * version]);
        if (version < 40) expect(generarQr('a'.repeat(bytes + 1), nivel).version).toBe(version + 1);
      }
    }
  });

  it('cuenta la longitud en bytes UTF-8, no en caracteres', () => {
    // «€» ocupa 3 bytes: 4 × 3 + 2 = 14 caben en la versión 1 con nivel M; 5 × 3 = 15, no.
    expect(generarQr('€€€€ab').version).toBe(1);
    expect(generarQr('€€€€€').version).toBe(2);
  });

  it('el texto vacío también genera un código (versión 1)', () => {
    expect(generarQr('').version).toBe(1);
  });

  it('lanza un error en español si el texto no cabe en la versión 40', () => {
    expect(() => generarQr('a'.repeat(2332), 'M')).toThrow(
      'No es posible generar el código QR: el texto ocupa 2332 bytes y el máximo con el nivel de corrección M es de 2331 bytes.',
    );
    expect(() => generarQr('€'.repeat(425), 'H')).toThrow(/ocupa 1275 bytes .* nivel de corrección H es de 1273 bytes/);
    expect(() => generarQr('a', 'X' as NivelCorreccion)).toThrow(/Nivel de corrección no válido/);
  });
});

describe('generarQr: patrones de función', () => {
  const codigos = [
    generarQr('VERI*FACTU', 'M'),
    ...NIVELES.map((nivel) => generarQr(URL_EJEMPLO, nivel)),
    generarQr(LARGO, 'M'),
    generarQr(MAXIMO_M, 'M'),
  ];

  it('los tres localizadores y sus separadores están en las esquinas', () => {
    for (const qr of codigos) {
      const n = qr.tamano;
      expect(recorte(qr, 0, 0, 8, 8)).toEqual([
        '11111110', '10000010', '10111010', '10111010', '10111010', '10000010', '11111110', '00000000',
      ]);
      expect(recorte(qr, 0, n - 8, 8, 8)).toEqual([
        '01111111', '01000001', '01011101', '01011101', '01011101', '01000001', '01111111', '00000000',
      ]);
      expect(recorte(qr, n - 8, 0, 8, 8)).toEqual([
        '00000000', '11111110', '10000010', '10111010', '10111010', '10111010', '10000010', '11111110',
      ]);
    }
  });

  it('la temporización alterna en la fila y la columna 6 entre los localizadores, y el módulo oscuro está en su sitio', () => {
    for (const qr of codigos) {
      const n = qr.tamano;
      const alterna = Array.from({ length: n - 16 }, (_, i) => (i % 2 === 0 ? '1' : '0')).join('');
      expect(recorte(qr, 6, 8, 1, n - 16)).toEqual([alterna]);
      expect(recorte(qr, 8, 6, n - 16, 1).join('')).toBe(alterna);
      expect(qr.modulos[4 * qr.version + 9][8]).toBe(true);
    }
  });

  it('los patrones de alineamiento de la versión 8 están en los cruces de 6, 24 y 42 (tabla E.1)', () => {
    const qr = generarQr(URL_EJEMPLO, 'M');
    const centros = [6, 24, 42];
    for (const f of centros) {
      for (const c of centros) {
        // Los tres cruces de las esquinas los ocupan los localizadores.
        if ((f === 6 && c === 6) || (f === 6 && c === 42) || (f === 42 && c === 6)) continue;
        expect(recorte(qr, f - 2, c - 2, 5, 5), `alineamiento en (${f}, ${c})`).toEqual([
          '11111', '10001', '10101', '10001', '11111',
        ]);
      }
    }
  });

  it('la información de formato, en sus dos copias, declara el nivel y la máscara devueltos', () => {
    const mascaras = new Set<number>();
    for (const texto of ['', 'a', '€', URL_EJEMPLO, 'áéíóúüñÁÉÍÓÚÜÑ¿¡€«»', 'Recibo 🧾 pagado ✅ 😀']) {
      for (const nivel of NIVELES) {
        const qr = generarQr(texto, nivel);
        const esperado = parseInt(FORMATO[nivel][qr.mascara], 2);
        expect(leerFormato(qr), `${JSON.stringify(texto)} con nivel ${nivel}`).toEqual([esperado, esperado]);
        mascaras.add(qr.mascara);
      }
    }
    // Estos textos llevan a las ocho máscaras: la comprobación cubre todas.
    expect([...mascaras].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('la información de versión, en sus dos bloques, declara la versión (tabla D.1)', () => {
    const casos: [CodigoQr, number][] = [
      [generarQr(URL_EJEMPLO, 'M'), 0x085bc],
      [generarQr(LARGO, 'M'), 0x1afab],
      [generarQr(MAXIMO_M, 'M'), 0x28c69],
    ];
    for (const [qr, esperado] of casos) expect(leerVersion(qr), `versión ${qr.version}`).toEqual([esperado, esperado]);
  });
});

describe('generarQr: vectores de la implementación de referencia', () => {
  it('matriz completa de «VERI*FACTU» con nivel M', () => {
    const qr = generarQr('VERI*FACTU', 'M');
    expect([qr.version, qr.mascara]).toEqual([1, 3]);
    expect(filas(qr)).toEqual([
      '111111101110101111111',
      '100000101010001000001',
      '101110100110101011101',
      '101110101100101011101',
      '101110100010001011101',
      '100000100100001000001',
      '111111101010101111111',
      '000000001110000000000',
      '101101110100001001011',
      '001110000100100101100',
      '111001111010110100011',
      '000111001110100111011',
      '110110110111010101110',
      '000000001100011001011',
      '111111101000010110100',
      '100000101111110111101',
      '101110100011011101000',
      '101110101000000010110',
      '101110101101010001100',
      '100000100001101011001',
      '111111101101110000100',
    ]);
  });

  // SHA-256 de las filas de '1'/'0' unidas con '\n', con la versión y la máscara
  // que elige la referencia.
  const vectores: { nombre: string; texto: string; nivel: NivelCorreccion; version: number; mascara: number; sha256: string }[] = [
    { nombre: 'URL de cotejo', texto: URL_EJEMPLO, nivel: 'L', version: 6, mascara: 3, sha256: '29fe139417c132f785edb7358472a1049b66aa2e7804bb389401faca44cd32fd' },
    { nombre: 'URL de cotejo', texto: URL_EJEMPLO, nivel: 'M', version: 8, mascara: 2, sha256: 'a2ed4facd12ea7d9af4e67b3495034c83280bcec1d0eb7979ef0a429b055be05' },
    { nombre: 'URL de cotejo', texto: URL_EJEMPLO, nivel: 'Q', version: 10, mascara: 2, sha256: '5995d89a2a02fc8952ea5b6efc3c99b3bb4018647719857aceb26d0e803ad5de' },
    { nombre: 'URL de cotejo', texto: URL_EJEMPLO, nivel: 'H', version: 11, mascara: 2, sha256: '68d5198c1a292de76bbed60f1551b9fad9c474497bbff4539bde6953b4fe1270' },
    { nombre: 'acentos y €', texto: ACENTOS, nivel: 'M', version: 5, mascara: 2, sha256: '47249ab380a4b973ff877d744df44f17d3df4b715683916d662f3806bde0ebd7' },
    { nombre: 'acentos y €', texto: ACENTOS, nivel: 'H', version: 8, mascara: 3, sha256: '537bbb677411af5cb44f9663f89b2a5d0aac5e39ae2041c9e6139a9914a9da0e' },
    { nombre: '1000 bytes', texto: LARGO, nivel: 'L', version: 22, mascara: 5, sha256: 'b6134be4d791b4bae8a7beedda61a365620a6a42072917dba972d3e2f7b5db97' },
    { nombre: '1000 bytes', texto: LARGO, nivel: 'M', version: 26, mascara: 4, sha256: '1b9564676da0f7aeda940d46c1d961f35fcdfc07e7c78983eb1cabe665337962' },
    { nombre: 'máximo del nivel M', texto: MAXIMO_M, nivel: 'M', version: 40, mascara: 5, sha256: 'ad9d9700e1dc13245bb8c1ffc86a42e8db1447b38df85bdfa7628a7a144e7951' },
    { nombre: 'texto vacío', texto: '', nivel: 'M', version: 1, mascara: 3, sha256: 'c30ac51df3031a0d4219aac58b58f0b82efbdb32354c067967ff9db149b16f61' },
    // Las máscaras 1 y 2 empatan con la menor penalización: gana la de número más bajo.
    { nombre: 'URL con empate de máscaras', texto: urlCotejo('F2025-0010', '73.1'), nivel: 'M', version: 8, mascara: 1, sha256: 'a4210d8d9c1b4315d9d225276a547fec547d8d2892c45d3c9c64e29716eb772e' },
    // Aquí decide el cálculo de N4 de la referencia: con la tabla literal de la norma saldría la máscara 2.
    { nombre: 'URL en la que decide N4', texto: urlCotejo('F2025-0073', '533.63'), nivel: 'M', version: 8, mascara: 7, sha256: 'bc3894c3d67bc2bc836310f463daee88af7d246ae87d8cb4769c711aebfd3929' },
  ];

  it.each(vectores)('$nombre con nivel $nivel', ({ texto, nivel, version, mascara, sha256 }) => {
    const qr = generarQr(texto, nivel);
    expect([qr.version, qr.mascara]).toEqual([version, mascara]);
    expect(huella(qr)).toBe(sha256);
  });
});
