/**
 * Generador de códigos QR según ISO/IEC 18004, sin dependencias, para el QR de
 * la factura VERI*FACTU. Devuelve la matriz de módulos y `invoicepdf.ts` la
 * dibuja como rectángulos: el PDF sigue escrito a mano, sin librerías ni
 * imágenes incrustadas.
 *
 * Solo implementa el modo byte con el texto en UTF-8 y sin cabecera ECI. Las URL
 * de cotejo de la AEAT llevan minúsculas, que el modo alfanumérico no admite,
 * así que los demás modos (numérico, alfanumérico, kanji) y la segmentación
 * mixta no ahorrarían lo bastante para justificar su código; y los lectores ya
 * interpretan UTF-8 sin ECI.
 *
 * La matriz no incluye la zona de silencio (cuatro módulos claros por lado, que
 * la norma exige): la añade quien la pinta, que es quien conoce la escala y el
 * fondo.
 *
 * `generarQr` es pura y determinista, sin E/S ni estado entre llamadas: la misma
 * entrada da siempre la misma matriz. `server/test/verifactu-qr.test.ts` fija
 * vectores sacados de la implementación de referencia `qrcode` (npm), con la que
 * coincide módulo a módulo, máscara elegida incluida.
 *
 * Los apartados, tablas y anexos citados son los de ISO/IEC 18004:2015.
 */

export type NivelCorreccion = 'L' | 'M' | 'Q' | 'H';

export interface CodigoQr {
  version: number;          // 1..40
  tamano: number;           // módulos por lado = 17 + 4 * version
  nivel: NivelCorreccion;
  mascara: number;          // 0..7
  /** Fila a fila: true = módulo oscuro. Sin zona de silencio (la pone quien lo pinta). */
  modulos: boolean[][];
}

const NIVELES: readonly string[] = ['L', 'M', 'Q', 'H'];

// ---------------------------------------------------------------------------
// Tablas de la norma
// ---------------------------------------------------------------------------

/** Bits del nivel en la información de formato (tabla 12): no siguen el orden de los niveles. */
const BITS_NIVEL: Readonly<Record<NivelCorreccion, number>> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/*
 * Tabla 9 reducida a los dos datos que no se pueden deducir, indexados por
 * versión (la posición 0 no se usa): palabras de corrección por bloque y número
 * de bloques. Cuántos bloques llevan una palabra de datos más y cuántas lleva
 * cada uno sale de las palabras totales de la versión (ver `intercalar`).
 */
const CORRECCION_POR_BLOQUE: Readonly<Record<NivelCorreccion, readonly number[]>> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
    28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
    30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const BLOQUES: Readonly<Record<NivelCorreccion, readonly number[]>> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
    23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
    25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/**
 * Centros de los patrones de alineamiento por versión (tabla E.1; la posición 0
 * no se usa), en líneas agrupadas por cuántos lleva cada fila. Se copian tal
 * cual porque no salen de una regla sencilla: la versión 32 rompe el paso
 * uniforme que siguen las demás.
 */
const ALINEAMIENTO: readonly (readonly number[])[] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

// ---------------------------------------------------------------------------
// Capacidad
// ---------------------------------------------------------------------------

/**
 * Módulos que quedan para datos y corrección: el área del símbolo menos los
 * patrones de función. Los alineamientos centrados en la fila o la columna 6
 * comparten cinco módulos con la temporización, que ya están descontados.
 */
function modulosLibres(version: number): number {
  const tamano = 17 + 4 * version;
  // Localizadores con su separador (8 × 8), dos copias del formato y el módulo
  // oscuro, y la temporización que queda entre los localizadores.
  let libres = tamano * tamano - 3 * 64 - (2 * 15 + 1) - 2 * (tamano - 16);
  const n = ALINEAMIENTO[version].length;
  if (n > 0) libres -= 25 * (n * n - 3) - 2 * 5 * (n - 2);
  if (version >= 7) libres -= 2 * 18;
  return libres;
}

/** Palabras de código de datos: las totales menos las de corrección de todos los bloques. */
function palabrasDatos(version: number, nivel: NivelCorreccion): number {
  return Math.floor(modulosLibres(version) / 8) - BLOQUES[nivel][version] * CORRECCION_POR_BLOQUE[nivel][version];
}

/** Bits del indicador de recuento en modo byte (tabla 3): 8 hasta la versión 9 y 16 desde la 10. */
function bitsRecuento(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Bytes de texto que caben después del indicador de modo y del de recuento. */
function capacidadBytes(version: number, nivel: NivelCorreccion): number {
  return Math.floor((palabrasDatos(version, nivel) * 8 - 4 - bitsRecuento(version)) / 8);
}

// ---------------------------------------------------------------------------
// Datos y corrección de errores
// ---------------------------------------------------------------------------

/**
 * Flujo de datos (apartado 7.4): indicador de modo byte (0100), recuento, los
 * bytes, terminador de hasta cuatro ceros, ceros hasta completar el byte y las
 * palabras de relleno 11101100 y 00010001 alternas hasta llenar la capacidad.
 */
function codificarDatos(bytes: Uint8Array, version: number, nivel: NivelCorreccion): Uint8Array {
  const capacidad = palabrasDatos(version, nivel);
  const salida = new Uint8Array(capacidad);
  let bit = 0;
  const escribir = (valor: number, longitud: number): void => {
    for (let i = longitud - 1; i >= 0; i--, bit++) {
      if ((valor >>> i) & 1) salida[bit >>> 3] |= 0x80 >>> (bit & 7);
    }
  };
  escribir(0b0100, 4);
  escribir(bytes.length, bitsRecuento(version));
  for (const byte of bytes) escribir(byte, 8);
  // El terminador y el ajuste al byte son ceros, que la salida ya tiene: basta
  // con avanzar el cursor sin pasar de la capacidad.
  bit = Math.min(bit + 4, capacidad * 8);
  for (let i = Math.ceil(bit / 8), par = true; i < capacidad; i++, par = !par) salida[i] = par ? 0xec : 0x11;
  return salida;
}

// GF(256) con el polinomio primitivo x⁸ + x⁴ + x³ + x² + 1 (0x11D) y α = 2. Con
// las tablas de exponentes y logaritmos cada producto es una suma de
// logaritmos; EXP va duplicada para no reducir módulo 255 en cada producto.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}

function multiplicar(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** Polinomio generador ∏ (x − αⁱ) para i = 0 … grado − 1, del coeficiente de mayor grado al de menor. */
function generadorRs(grado: number): Uint8Array {
  let g = Uint8Array.of(1);
  for (let i = 0; i < grado; i++) {
    // En GF(2⁸) restar es sumar (XOR): (x − αⁱ) = (x + αⁱ).
    const siguiente = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      siguiente[j] ^= g[j];
      siguiente[j + 1] ^= multiplicar(g[j], EXP[i]);
    }
    g = siguiente;
  }
  return g;
}

/** Palabras de corrección: el resto de dividir datos(x) · x^grado entre el generador. */
function restoRs(datos: Uint8Array, generador: Uint8Array): Uint8Array {
  const grado = generador.length - 1;
  const resto = new Uint8Array(grado);
  for (const byte of datos) {
    const factor = byte ^ resto[0];
    resto.copyWithin(0, 1);
    resto[grado - 1] = 0;
    for (let i = 0; i < grado; i++) resto[i] ^= multiplicar(generador[i + 1], factor);
  }
  return resto;
}

/**
 * Reparte los datos en bloques, calcula la corrección de cada uno e intercala
 * el resultado (apartado 7.6): la palabra i de datos de cada bloque, y después
 * la palabra i de corrección de cada bloque. Así un daño localizado en el
 * símbolo se reparte entre varios bloques en vez de agotar la corrección de uno.
 */
function intercalar(datos: Uint8Array, version: number, nivel: NivelCorreccion): Uint8Array {
  const bloques = BLOQUES[nivel][version];
  const porBloque = CORRECCION_POR_BLOQUE[nivel][version];
  const total = Math.floor(modulosLibres(version) / 8);
  // Si el total no se divide entre los bloques, los últimos (los largos) llevan
  // una palabra de datos más que los primeros.
  const cortos = bloques - (total % bloques);
  const datosCorto = Math.floor(total / bloques) - porBloque;
  const generador = generadorRs(porBloque);
  const trozos: Uint8Array[] = [];
  const correcciones: Uint8Array[] = [];
  for (let b = 0, inicio = 0; b < bloques; b++) {
    const fin = inicio + datosCorto + (b < cortos ? 0 : 1);
    const trozo = datos.subarray(inicio, fin);
    trozos.push(trozo);
    correcciones.push(restoRs(trozo, generador));
    inicio = fin;
  }
  const salida = new Uint8Array(total);
  let k = 0;
  for (let i = 0; i <= datosCorto; i++) {
    for (const trozo of trozos) if (i < trozo.length) salida[k++] = trozo[i];
  }
  for (let i = 0; i < porBloque; i++) {
    for (const correccion of correcciones) salida[k++] = correccion[i];
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Matriz
// ---------------------------------------------------------------------------

/** Matriz en construcción, plana por filas; `funcion` marca los módulos que no llevan datos. */
interface Matriz {
  tamano: number;
  oscuro: Uint8Array;
  funcion: Uint8Array;
}

function fijar(m: Matriz, fila: number, columna: number, oscuro: boolean): void {
  const i = fila * m.tamano + columna;
  m.oscuro[i] = oscuro ? 1 : 0;
  m.funcion[i] = 1;
}

/** BCH(15,5) del nivel y la máscara (anexo C), enmascarado con 0x5412 para que nunca salga todo a cero. */
function bitsFormato(nivel: NivelCorreccion, mascara: number): number {
  const datos = (BITS_NIVEL[nivel] << 3) | mascara;
  let resto = datos;
  // Generador x¹⁰ + x⁸ + x⁵ + x⁴ + x² + x + 1.
  for (let i = 0; i < 10; i++) resto = (resto << 1) ^ ((resto >>> 9) * 0x537);
  return ((datos << 10) | resto) ^ 0x5412;
}

/** Las dos copias de la información de formato (figura 25); el bit 0 es el menos significativo de `bits`. */
function escribirFormato(m: Matriz, bits: number): void {
  const n = m.tamano;
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  // Primera copia, en ángulo junto al localizador superior izquierdo, saltando
  // la fila y la columna de temporización.
  for (let i = 0; i <= 5; i++) fijar(m, i, 8, bit(i));
  fijar(m, 7, 8, bit(6));
  fijar(m, 8, 8, bit(7));
  fijar(m, 8, 7, bit(8));
  for (let i = 9; i < 15; i++) fijar(m, 8, 14 - i, bit(i));
  // Segunda copia repartida entre los otros dos localizadores: si una esquina
  // está dañada, la otra copia sigue legible.
  for (let i = 0; i < 8; i++) fijar(m, 8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) fijar(m, n - 15 + i, 8, bit(i));
}

/** BCH(18,6) de la versión (anexo D), en dos bloques de 6 × 3 junto a los localizadores superior derecho e inferior izquierdo. */
function escribirVersion(m: Matriz, version: number): void {
  let resto = version;
  // Generador x¹² + x¹¹ + x¹⁰ + x⁹ + x⁸ + x⁵ + x² + 1.
  for (let i = 0; i < 12; i++) resto = (resto << 1) ^ ((resto >>> 11) * 0x1f25);
  const bits = (version << 12) | resto;
  const n = m.tamano;
  for (let i = 0; i < 18; i++) {
    const oscuro = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = n - 11 + (i % 3);
    fijar(m, a, b, oscuro);
    fijar(m, b, a, oscuro);
  }
}

function dibujarPatronesFuncion(m: Matriz, version: number): void {
  const n = m.tamano;
  // La temporización se traza de borde a borde y los localizadores sobrescriben
  // después los extremos que les corresponden.
  for (let i = 0; i < n; i++) {
    fijar(m, 6, i, i % 2 === 0);
    fijar(m, i, 6, i % 2 === 0);
  }
  // Localizador: anillo oscuro de 7 × 7, anillo claro y centro oscuro de 3 × 3.
  // El separador es el anillo claro siguiente (distancia 4 al centro), recortado
  // por el borde del símbolo.
  for (const [cf, cc] of [[3, 3], [3, n - 4], [n - 4, 3]]) {
    for (let df = -4; df <= 4; df++) {
      for (let dc = -4; dc <= 4; dc++) {
        const fila = cf + df;
        const columna = cc + dc;
        if (fila < 0 || fila >= n || columna < 0 || columna >= n) continue;
        const d = Math.max(Math.abs(df), Math.abs(dc));
        fijar(m, fila, columna, d !== 2 && d !== 4);
      }
    }
  }
  // Un alineamiento (5 × 5 con centro oscuro) en cada cruce de la tabla, salvo
  // en los tres que caerían encima de un localizador.
  const pos = ALINEAMIENTO[version];
  const ultimo = pos.length - 1;
  for (let i = 0; i <= ultimo; i++) {
    for (let j = 0; j <= ultimo; j++) {
      if ((i === 0 && (j === 0 || j === ultimo)) || (i === ultimo && j === 0)) continue;
      for (let df = -2; df <= 2; df++) {
        for (let dc = -2; dc <= 2; dc++) {
          fijar(m, pos[i] + df, pos[j] + dc, Math.max(Math.abs(df), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  // El formato depende de la máscara: aquí solo se reserva su sitio para que la
  // colocación de datos y la máscara lo salten.
  escribirFormato(m, 0);
  fijar(m, n - 8, 8, true); // módulo oscuro
  if (version >= 7) escribirVersion(m, version);
}

/**
 * Coloca las palabras en zigzag (apartado 7.7.3): columnas de dos módulos desde
 * la esquina inferior derecha, subiendo y bajando alternativamente, saltando la
 * columna 6 de temporización y los módulos de función.
 */
function colocarDatos(m: Matriz, palabras: Uint8Array): void {
  const n = m.tamano;
  const totalBits = palabras.length * 8;
  let i = 0;
  for (let derecha = n - 1; derecha >= 1; derecha -= 2) {
    if (derecha === 6) derecha = 5;
    // `n` es impar, así que este criterio da subida en la primera pareja de
    // columnas y alterna en cada una de las siguientes.
    const subiendo = ((derecha + 1) & 2) === 0;
    for (let v = 0; v < n; v++) {
      const fila = subiendo ? n - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const k = fila * n + derecha - j;
        if (m.funcion[k]) continue;
        // Los bits de resto (de 0 a 7 según la versión) se quedan claros.
        if (i < totalBits) m.oscuro[k] = (palabras[i >>> 3] >>> (7 - (i & 7))) & 1;
        i++;
      }
    }
  }
}

/** Matriz sin máscara: patrones de función, formato reservado y palabras ya colocadas. */
function construirBase(bytes: Uint8Array, version: number, nivel: NivelCorreccion): Matriz {
  const tamano = 17 + 4 * version;
  const m: Matriz = { tamano, oscuro: new Uint8Array(tamano * tamano), funcion: new Uint8Array(tamano * tamano) };
  dibujarPatronesFuncion(m, version);
  colocarDatos(m, intercalar(codificarDatos(bytes, version, nivel), version, nivel));
  return m;
}

// ---------------------------------------------------------------------------
// Máscara
// ---------------------------------------------------------------------------

/** Condición de cada máscara (tabla 10), con i la fila y j la columna: true invierte el módulo. */
function invierte(mascara: number, i: number, j: number): boolean {
  switch (mascara) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
  }
}

/** Copia de la base con la máscara aplicada a los módulos de datos y el formato que la declara. */
function enmascarar(base: Matriz, nivel: NivelCorreccion, mascara: number): Matriz {
  const n = base.tamano;
  // `funcion` se comparte: escribir el formato solo vuelve a marcar módulos que
  // ya estaban marcados.
  const m: Matriz = { tamano: n, oscuro: base.oscuro.slice(), funcion: base.funcion };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      if (!m.funcion[k] && invierte(mascara, i, j)) m.oscuro[k] ^= 1;
    }
  }
  escribirFormato(m, bitsFormato(nivel, mascara));
  return m;
}

/** N1 y N3 de una fila o columna, recorrida desde `inicio` de `paso` en `paso`. */
function penalizarLinea(oscuro: Uint8Array, inicio: number, paso: number, n: number): number {
  let puntos = 0;
  let color = -1;
  let racha = 0;
  let ventana = 0; // los últimos 11 módulos, el más reciente en el bit menos significativo
  for (let k = 0; k < n; k++) {
    const v = oscuro[inicio + k * paso];
    if (v === color) {
      racha++;
    } else {
      if (racha >= 5) puntos += 3 + (racha - 5);
      color = v;
      racha = 1;
    }
    ventana = ((ventana << 1) & 0x7ff) | v;
    if (k >= 10 && (ventana === 0b10111010000 || ventana === 0b00001011101)) puntos += 40;
  }
  if (racha >= 5) puntos += 3 + (racha - 5);
  return puntos;
}

/**
 * Penalización del símbolo ya enmascarado, con el formato y la versión incluidos
 * (apartado 7.8.3, tabla 11): N1, rachas de cinco o más módulos iguales en una
 * fila o columna; N2, bloques de 2 × 2 de un mismo color; N3, el patrón
 * 1:1:3:1:1 con cuatro módulos claros a un lado, que imita a un localizador; y
 * N4, la desviación del 50 % de módulos oscuros.
 *
 * La norma deja margen de interpretación y cada implementación elige. Aquí se
 * calcula igual que la implementación de referencia `qrcode`, para que la
 * máscara elegida coincida con la suya y se pueda comprobar contra ella: N3 solo
 * cuenta ventanas de 11 módulos enteras dentro del símbolo (sin contar la zona
 * de silencio), y N4 vale 10 × |⌈% de oscuros / 5⌉ − 10|, que por encima del 50 %
 * suma un escalón más que la tabla. No afecta a la lectura: el lector toma la
 * máscara de la información de formato, y elegirla solo sirve para evitar
 * patrones que dificultan la detección.
 */
function penalizacion(oscuro: Uint8Array, n: number): number {
  let puntos = 0;
  for (let a = 0; a < n; a++) puntos += penalizarLinea(oscuro, a * n, 1, n) + penalizarLinea(oscuro, a, n, n);
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const k = i * n + j;
      const suma = oscuro[k] + oscuro[k + 1] + oscuro[k + n] + oscuro[k + n + 1];
      if (suma === 0 || suma === 4) puntos += 3;
    }
  }
  let oscuros = 0;
  for (const v of oscuro) oscuros += v;
  // ⌈% / 5⌉ con el porcentaje como fracción exacta (20 · oscuros / total).
  puntos += 10 * Math.abs(Math.ceil((oscuros * 20) / (n * n)) - 10);
  return puntos;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Codifica el texto (UTF-8, modo byte) en la versión más pequeña que quepa con ese nivel. Lanza Error en español si no cabe en la versión 40. */
export function generarQr(texto: string, nivel: NivelCorreccion = 'M'): CodigoQr {
  if (!NIVELES.includes(nivel)) {
    throw new Error(`Nivel de corrección no válido: «${String(nivel)}». Los valores admitidos son L, M, Q y H.`);
  }
  const bytes = Buffer.from(texto, 'utf8');
  let version = 1;
  while (capacidadBytes(version, nivel) < bytes.length) {
    if (version === 40) {
      throw new Error(
        `No es posible generar el código QR: el texto ocupa ${bytes.length} bytes y el máximo con el nivel de corrección ${nivel} es de ${capacidadBytes(40, nivel)} bytes.`,
      );
    }
    version++;
  }

  const base = construirBase(bytes, version, nivel);
  // La de menor penalización; con empate, la de número más bajo (como la referencia).
  let mascara = 0;
  let elegida = enmascarar(base, nivel, 0);
  let menor = penalizacion(elegida.oscuro, base.tamano);
  for (let candidata = 1; candidata < 8; candidata++) {
    const m = enmascarar(base, nivel, candidata);
    const p = penalizacion(m.oscuro, base.tamano);
    if (p < menor) {
      mascara = candidata;
      elegida = m;
      menor = p;
    }
  }

  const tamano = base.tamano;
  const modulos = Array.from({ length: tamano }, (_, fila) =>
    Array.from({ length: tamano }, (_, columna) => elegida.oscuro[fila * tamano + columna] === 1),
  );
  return { version, tamano, nivel, mascara, modulos };
}
