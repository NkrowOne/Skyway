# VERI*FACTU en Skyway

> Diseño e implementación de la modalidad **VERI*FACTU** del Reglamento de los
> sistemas informáticos de facturación (Real Decreto 1007/2023, modificado por el
> RD 254/2025 y el RDL 15/2025) y de la Orden HAC/1177/2024, con las
> especificaciones técnicas de la AEAT. Fuentes al final. Las rutas de la API
> están en [FUNCIONALIDAD.md §7.2.4](FUNCIONALIDAD.md); la declaración
> responsable, en [DECLARACION-RESPONSABLE.md](DECLARACION-RESPONSABLE.md).

## 1. Qué hace y qué no

- **Hace**: con el modo «VERI*FACTU» activo, cada factura que se emite genera un
  **registro de facturación de alta** y cada factura anulada un **registro de
  anulación**. Los registros se encadenan con una **huella SHA-256**, se guardan
  inmutables en `invoice_ledger` y se **remiten a la AEAT** al momento por su
  servicio web, con el certificado electrónico del emisor. La factura en PDF lleva
  el **QR tributario** y la leyenda «VERI*FACTU».
- **No hace**: la modalidad «NO VERI*FACTU» (registros firmados con XAdES,
  registro de eventos obligatorio y remisión solo a requerimiento). Skyway funciona
  **solo** como VERI*FACTU (`TipoUsoPosibleSoloVerifactu = S`). Tampoco atiende
  requerimientos de la AEAT (servicio `RemisionRequerimiento`), ni la consulta de
  registros (`ConsultaFactuSistemaFacturacion`), ni comunica la renuncia a la
  modalidad (`FechaFinVeriFactu`, §12).
- **Modo desactivado**: sin registros, como antes. Solo vale hasta que el emisor
  esté obligado (§2), y no se puede volver a él una vez hay registros del entorno
  de producción (§3).

## 2. Plazos

Plazos vigentes a 9-11-2026 (RDL 15/2025):

| Quién | Desde |
|---|---|
| Contribuyentes del Impuesto sobre Sociedades | **1-1-2027** |
| Resto de obligados (autónomos incluidos) | **1-7-2027** |

Hacienda anunció el 5-10-2026 un aplazamiento a octubre de 2028, pero **no está
publicado en el BOE**: hasta que lo esté, mandan las fechas de arriba. No están
obligados quienes llevan los libros por el SII.

## 3. Cómo se activa (operación)

1. **Contabilidad → Datos de la empresa emisora**: razón social y NIF español
   válido (Skyway comprueba el dígito de control).
2. **Contabilidad → VERI*FACTU**:
   1. Cargar el **certificado electrónico** (.pfx o .p12) y su contraseña:
      de persona física, de representante de la entidad o de sello. Su titular
      tiene que ser el emisor, o un apoderado o colaborador social suyo (si no,
      la AEAT rechaza el envío con 4112).
   2. **Probar conexión**: comprueba el TLS con el certificado contra la AEAT sin
      enviar ningún registro (con un certificado de sello, contra su punto de
      acceso, §9).
   3. Completar los datos del **productor** y la **declaración responsable**. La
      razón social y el NIF del productor van juntos: uno sin el otro no se guarda
      (400). Con los dos vacíos, el productor es el propio emisor. La regla solo se
      comprueba cuando se cambia alguno de los dos: unos datos guardados a medias
      no impiden activar ni cambiar de entorno, y mientras tanto el productor es
      el emisor.
   4. Activar **VERI*FACTU** en el entorno de **pruebas**. Emitir alguna factura
      y comprobar que los registros salen «Correctos».
   5. Antes del plazo, pasar a **producción**. En cuanto existe un registro del
      entorno de producción, VERI*FACTU no se puede desactivar (tampoco desde los
      datos de la empresa) ni volver a pruebas (409): la modalidad se mantiene al
      menos hasta el final del año natural, y dejarla exige comunicar la renuncia
      a la AEAT en los envíos de ese año (art. 17 de la Orden), cosa que Skyway no
      hace (§12). Volver a pruebas también es salir: las facturas dejarían de
      llegar a la AEAT con efectos fiscales.
3. El reloj del servidor tiene que estar en hora (NTP): la Orden admite un minuto
   de error como máximo y Skyway no genera un registro (409 al emitir o anular) si
   el último de la cadena tiene una hora de generación más de un minuto posterior
   a la actual (§6).
4. **Instalaciones anteriores a esta función**: el selector «Modo Verifactu» de
   los datos de la empresa ya guardaba `sifMode = 'verifactu'`, sin activar nada.
   Al arrancar, una migración única (`migrations:verifactu_modo_v1`) lo pasa a
   `desactivado` si no se ha generado ningún registro ni anotado una activación,
   para que nadie quede en VERI*FACTU sin haberlo activado (la activación
   comprueba el NIF y anota el evento). En una instalación nueva solo deja la
   marca.

## 4. El registro de alta

Se genera al **emitir** (borrador → emitida o pagada), dentro de la misma
transacción de SQLite que asigna el número de la serie (`performEmission` →
`registrarAlta`): el número, el registro y su puesto en la cadena se confirman
juntos o no se confirma nada. Solo en la primera emisión: pasar de emitida a
pagada no genera otro. Si un dato haría que la AEAT rechazara el registro (ver
«Comprobaciones antes de emitir»), la emisión entera se deshace con un mensaje
(409) y el número no se gasta. El cobro por el webhook de Stripe no se bloquea
nunca por esto: genera el registro igual y, si la AEAT lo rechaza, se ve y se
subsana.

**Fecha de expedición.** Al emitir se congela `issued_date` (`aaaa-mm-dd`) en hora
peninsular (`Europe/Madrid`): de madrugada la fecha UTC sería la del día anterior
y, en Nochevieja, la del año anterior. De ella salen el año de la serie, la
`FechaExpedicionFactura` del registro (y del QR), la fecha que imprime el PDF y la
del CSV de Contabilidad. El vencimiento del PDF es esa fecha más los días del plazo,
contados en el calendario (con el instante en UTC, una factura de madrugada vencería
un día antes). Las facturas emitidas antes de existir la columna siguen con la que
siempre han impreso, la UTC de `issued_at`.

Campos (en el orden de `RegistroFacturacionAltaType`) y de dónde salen:

| Campo | Valor en Skyway |
|---|---|
| `IDVersion` | `1.0` |
| `IDFactura/IDEmisorFactura` | NIF del emisor congelado al emitir (`issuer_snapshot`), en mayúsculas, sin espacios ni prefijo ES |
| `IDFactura/NumSerieFactura` | número de la factura (`FRA-2026-0001`). Hasta 60 caracteres ASCII imprimibles, sin `" ' < > =` (si no, no se emite) |
| `IDFactura/FechaExpedicionFactura` | fecha de expedición (`issued_date`) en `dd-mm-aaaa`: la misma que imprime el PDF |
| `NombreRazonEmisor` | razón social congelada |
| `Subsanacion`, `RechazoPrevio` | solo en las subsanaciones (§9) |
| `TipoFactura` | `F1` completa; `F2` simplificada; rectificativa: `R5` si rectifica una simplificada, si no la causa elegida (`R1` por defecto; `R2`, `R3`, `R4`) |
| `TipoRectificativa` | `I` (por diferencias): la rectificativa de Skyway revierte la original y añade lo correcto, así que su importe es la diferencia |
| `FacturasRectificadas` | NIF del emisor (tiene que ser válido), número y fecha de expedición de la factura rectificada |
| `FechaOperacion` | la fecha de operación (una fecha sin hora) si existe y es otro día. Posterior a la de expedición: no se emite (la AEAT lo rechaza, 1146) |
| `DescripcionOperacion` | los conceptos de las líneas (hasta 500 caracteres); en una rectificativa, «Rectificación de la factura … : motivo» |
| `FacturaSinIdentifDestinatarioArt61d` | `S` en una `F2` de más de 3.000 €: sin ella la AEAT la rechaza (1150) |
| `Macrodato` | `S` si el importe total llega a 100 millones de euros |
| `Destinatarios` | no en `F2`/`R5` (1190); ver «El destinatario» |
| `Desglose/DetalleDesglose` | uno por régimen y tipo (máx. 12), ver la tabla del desglose |
| `CuotaTotal` | suma de cuotas repercutidas (y de recargo) |
| `ImporteTotal` | **base + cuotas**, sin restar la retención de IRPF: la AEAT lo comprueba así (1210, 2005), aunque el total a pagar de la factura sí la resta |
| `Encadenamiento` | `PrimerRegistro=S` o `RegistroAnterior` (§6) |
| `SistemaInformatico` | productor (el configurado, con razón social y NIF juntos, o el emisor), `Skyway`, `SK`, versión de Skyway, número de instalación, `S`/`N`/`N` |
| `FechaHoraHusoGenRegistro` | momento de generación en hora peninsular con su desfase: `2026-11-09T10:15:00+01:00` |
| `TipoHuella`, `Huella` | `01` (SHA-256) y la huella (§5) |

**El destinatario.** El país del cliente se normaliza con la lista de códigos que
admite la AEAT (`CountryType2` de `SuministroInformacion.xsd`, en `paises.ts`):
«UK» se lee como `GB` y «EL» como `GR`.

| Cliente | Identificación en el registro |
|---|---|
| Español | `NIF`, válido y distinto del emisor (si no, no se emite) |
| De otro Estado de la UE, con un identificador que tiene la estructura del NIF-IVA de su país (validaciones de la AEAT, nota 1) | `IDOtro` con `IDType 02` y el NIF-IVA con el prefijo del país («EL» en Grecia), sin `CodigoPais`: con 02 no es obligatorio, y en Grecia no coincidiría con «EL» (1122) |
| De otro Estado de la UE sin esa estructura, o de fuera de la UE | `IDOtro` con `CodigoPais` e `IDType 04` (documento de su país de residencia) |
| Subsanación de un 2001 (NIF no censado) con NIF de persona física | `IDOtro` con `CodigoPais ES` e `IDType 07` (no censado, §9) |

Desglose según el régimen de IVA de la factura (`vat_regime`):

| Régimen en Skyway | `ClaveRegimen` | Calificación / exención | Tipo y cuota |
|---|---|---|---|
| General, cualquier tipo (también el 0 %) | `01` | `S1` | tipo y cuota (al 0 %, cuota 0) |
| Recargo de equivalencia con recargo calculado | `18` | `S1` | tipo, cuota, tipo y cuota de recargo |
| Recargo sin recargo calculado (hoy Skyway no lo calcula) | `01` | `S1` | tipo y cuota |
| Exportación (art. 21) | `02` | `E2` | — |
| Entrega intracomunitaria (art. 25) | `01` | `E5` (exige cliente de otro país de la UE) | — |
| Otras exenciones | `01` | `E6` | — |
| Inversión del sujeto pasivo, cliente español | `01` | `S2` | tipo 0 y cuota 0 (1198) |
| Inversión del sujeto pasivo, cliente extranjero | `01` | `N2` (no sujeto por reglas de localización) | — |
| No sujeto, cliente español / extranjero | `01` | `N1` / `N2` | — |
| Factura sin desglose | `01` | `S1` | tipo 0, base y cuota 0 |

Un IVA al 0 % del régimen general va como `S1` al 0 % (validaciones de la AEAT,
15.1): es un tipo más del impuesto, no un importe no sujeto. Los suplidos no
entran en el registro (FAQ de desarrolladores, n.º 21), así que una línea al 0 %
no se declara como `N1`.

Los textos libres se limpian de los caracteres que la AEAT rechaza (1287):
`'` → `’`, `"` → `”`, y `<`, `>`, `=` → espacio.

**Comprobaciones antes de emitir.** Algunas se hacen siempre, porque sin ellas no
hay registro posible: el número de la factura, el NIF y la razón social del
emisor, el nombre del cliente y la identificación del cliente extranjero en una
factura completa, y el máximo de 12 combinaciones en el desglose. En la emisión
deliberada (el panel, la API y la emisión automática del ciclo) se comprueba
además, dentro de la transacción, lo que la AEAT rechazaría; el cobro por webhook
y la subsanación no hacen estas otras comprobaciones:

- **Moneda**: solo euros (art. 12.1 del RD 1619/2012). Skyway no convierte otras
  monedas.
- **Fecha de operación**: no puede ser posterior a la de expedición.
- **Tipo de IVA** (régimen general y recargo de equivalencia), según la fecha de la
  operación, o la de expedición si no hay otra (validaciones, 15.1): 0, 4, 10 y
  21 %; 5 % solo entre el 1-7-2022 y el 30-9-2024; 2 % y 7,5 % solo en el cuarto
  trimestre de 2024.
- **País del cliente** (facturas completas): tiene que estar en la lista de la
  AEAT; uno que no está dejaría el XML fuera de esquema, y la AEAT rechazaría el
  envío entero.
- **Cliente español**: NIF válido y distinto del emisor.
- **NIF-IVA**: no se emite si el régimen lo exige —entrega intracomunitaria
  exenta, o inversión del sujeto pasivo o no sujeción con cliente extranjero— y el
  identificador del cliente de la UE no tiene la estructura de los de su país. La
  entrega intracomunitaria exenta con un cliente español tampoco se emite.
- **Rectificativas**: el NIF del emisor de la factura rectificada tiene que ser
  válido; una `R3` (créditos incobrables) solo admite clientes con NIF español, y
  una `R2` (concurso), con NIF español o NIF-IVA (1191, 1192).

## 5. La huella

Documento de la AEAT «Detalle de las especificaciones técnicas para generación de
la huella o hash de los registros de facturación» (v0.1.2). Se concatenan como
`nombre=valor` unidos por `&`, en este orden, los valores tal como van en el XML
pero sin espacios al principio ni al final (un campo vacío se escribe `nombre=`),
y se calcula el SHA-256 del texto en UTF-8, en hexadecimal y mayúsculas.

- Alta: `IDEmisorFactura`, `NumSerieFactura`, `FechaExpedicionFactura`,
  `TipoFactura`, `CuotaTotal`, `ImporteTotal`, `Huella` (la del registro anterior;
  vacía en el primero) y `FechaHoraHusoGenRegistro`.
- Anulación: `IDEmisorFacturaAnulada`, `NumSerieFacturaAnulada`,
  `FechaExpedicionFacturaAnulada`, `Huella` y `FechaHoraHusoGenRegistro`.

Ejemplo oficial (primer registro):

```
IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00
→ 3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60
```

Los tres ejemplos del documento (alta, alta encadenada y anulación) son pruebas en
`server/test/verifactu-huella.test.ts` y dan exactamente las huellas publicadas.
Skyway escribe siempre los importes con dos decimales (`12.30`) y el mismo texto
en el XML y en la huella. La AEAT recalcula la huella al recibir el registro; si no
coincide, lo acepta con el error 2000 y hay que subsanarlo.

## 6. La cadena

- **Una cadena por obligado y sistema** (art. 7.c de la Orden): en Skyway, por NIF
  del emisor **y entorno**. Los registros del entorno de pruebas no tienen efectos
  fiscales; la cadena de producción empieza con `PrimerRegistro=S` aunque antes se
  haya probado.
- Altas, anulaciones y subsanaciones van en la misma cadena, en orden de
  generación, sin importar la serie ni el año.
- `seq` es único por (emisor, entorno) y la generación va dentro de la transacción
  de la factura: better-sqlite3 serializa las transacciones, así que dos emisiones
  no pueden encadenarse al mismo registro. Los registros se listan por orden de
  inserción, que es el de la cadena: la hora de generación puede retroceder hasta
  un minuto si el reloj del servidor da un paso atrás.
- **Antes de encadenar** (art. 7.i de la Orden, con las aclaraciones de la FAQ de
  desarrolladores, 15.1 a 15.3) se comprueba el último registro de la cadena:
  - que su huella, recalculada con sus propios datos, coincide con la guardada;
  - que solo el primero de la cadena (`seq` 1) va marcado con `PrimerRegistro=S`;
  - que su `RegistroAnterior` apunta al registro anterior por `seq` (NIF, número,
    fecha y huella) y que ese registro existe;
  - que sus datos guardados (`registro_json`) se pueden leer. Si no, esa es la
    anomalía: no hay huella que recalcular ni enlace que mirar.

  Una anomalía **no detiene la facturación** («la facturación por este motivo
  NUNCA debe interrumpirse», FAQ 15.2): se anota el evento `anomalia_cadena`, se
  abre una alerta crítica `verifactu_cadena` (una por registro afectado) y el
  registro nuevo se encadena con el último, como siempre. Como los registros no se
  pueden modificar desde Skyway, una anomalía apunta a un cambio hecho
  directamente en la base de datos o a una copia restaurada.
- Lo único que bloquea es el **reloj** (FAQ 15.3): si el último registro tiene una
  hora de generación más de un minuto posterior a la del servidor, no se emite ni
  se anula nada (409) hasta corregir el reloj.
- **Inmutable**: disparadores de SQLite impiden borrar registros y cambiar
  cualquier columna que no sea de la remisión (estado, CSV, intentos, incidencia,
  error).
- Un registro rechazado por la AEAT sigue siendo un eslabón: el siguiente se
  encadena con él (la AEAT no comprueba la continuidad con lo que tiene).

## 7. El registro de anulación

Se genera al anular (emitida → anulada) una factura, dentro de la misma
transacción. Sigue las «operativas de anulación admisibles» de las validaciones
de la AEAT (§6.2):

| Caso | `SinRegistroPrevio` | `RechazoPrevio` |
|---|---|---|
| La AEAT tiene el alta (anulación normal) | — | — |
| Repite una anulación rechazada | — | `S` |
| La AEAT no tiene el alta: todas rechazadas, o factura emitida antes de activar VERI*FACTU | `S` | — |
| Las dos cosas | `S` | `S` |

- Con registro de alta, va en la cadena y el entorno de ese alta, con la fecha que
  se escribió en él, **aunque el modo esté ya desactivado**: la AEAT tiene el alta
  y tiene que saber que se anuló.
- Sin registro de alta (factura de antes de activar), solo con el modo activo, en
  el entorno actual y con la fecha de expedición de la factura (§4). Es opcional
  para la AEAT: si los datos de esa factura antigua no valen para un registro (un
  NIF no válido), no se genera nada en vez de bloquear la anulación.
- Si el reloj del servidor va más de un minuto por detrás del último registro, no
  se anula nada (409). Una anomalía en la cadena no lo impide (§6).

## 8. El QR tributario

Art. 20 y 21 de la Orden y especificación del QR de la AEAT:

- URL del servicio de cotejo con cuatro parámetros codificados en UTF-8:
  `nif`, `numserie`, `fecha` (`dd-mm-aaaa`, la de expedición del registro) e
  `importe` (el `ImporteTotal` del registro, con punto decimal):
  - Producción: `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=…&numserie=…&fecha=…&importe=…`
  - Pruebas: `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?…`
- QR según ISO/IEC 18004, nivel de corrección **M**, de **35 mm** (entre 30 y
  40 mm), con una zona de silencio de **6 mm**: la AEAT pide al menos 2 mm y
  recomienda 6, y la norma, 4 módulos; se toma el mayor de 6 mm y 4 módulos.
  Generador propio sin dependencias (`server/src/verifactu/qr.ts`), comprobado
  contra una implementación de referencia y un lector.
- Al principio de la factura: «QR tributario:» encima, el QR y la leyenda
  «VERI*FACTU» debajo, centradas sobre el QR y en negrita de **14 pt**: la
  especificación pide un cuerpo igual o superior al de los datos de la factura, y
  14 pt es el de la razón social del emisor, el dato más grande (el TOTAL va a 12;
  el título del documento no es un dato). En pruebas, además, «Registro remitido
  al entorno de pruebas de la AEAT».
- La URL se guarda en el registro (`qr_url`); el PDF usa la del último alta.

## 9. La remisión

- **Servicio**: SOAP 1.1, operación `RegFactuSistemaFacturacion` con
  `soapAction=""` (`SistemaFacturacion.wsdl`, `SuministroLR.xsd` +
  `SuministroInformacion.xsd`; respuesta en `RespuestaSuministro.xsd`):
  - Producción: `https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`
  - Pruebas: `https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`
  - Con certificado de **sello**, el punto de acceso de sello del WSDL:
    `https://www10.agenciatributaria.gob.es/…` y `https://prewww10.aeat.es/…`.
    Skyway lo reconoce por el asunto del certificado («SELLO») y lo usa para
    remitir y para «Probar conexión»; `GET /api/verifactu` enseña el punto de
    acceso en uso (`servicio`).
- **Autenticación**: TLS con el certificado de cliente (Node `https` con `pfx`).
  En VERI*FACTU los registros no se firman.
- **Una cola por cadena**: cada cadena (NIF del emisor y entorno) es una cola
  independiente, con su propia espera de la AEAT, sus reintentos y su contador de
  fallos (`estadocola.ts`): una cadena que falla (un NIF que la AEAT rechaza, el
  entorno de pruebas caído) no frena a las demás. El bucle mira cada 10 s (y un
  segundo después de generar un registro) y envía un lote de la primera cadena que
  puede enviar, empezando por la del registro pendiente más antiguo. El estado se
  guarda en el ajuste `verifactuRemision`, con un resumen para el panel (por
  entorno, la espera más larga de sus cadenas; y el mayor número de fallos
  seguidos de todas), y sobrevive a un reinicio.
- **Lotes**: hasta 1000 registros de la cadena con la misma marca de incidencia
  (un lote nunca mezcla registros con y sin ella), en el orden de la cadena y con
  un solo registro por factura (el alta y la anulación de una misma factura nunca
  van juntas). Cabecera con `ObligadoEmision`; con
  `RemisionVoluntaria/Incidencia=S` si los registros del lote constan con
  incidencia.
- **Control de flujo**: tras cada respuesta, la cadena espera `TiempoEsperaEnvio`
  (60 s si no viene) antes del siguiente envío, salvo que ya tenga un lote completo
  de 1000 registros (art. 16 de la Orden). La cadena guarda la última espera que
  indicó la AEAT y la aplica también tras un SOAP Fault y tras un envío que salió y
  no tuvo respuesta: la AEAT pudo contarlos como envíos.
- **Respuestas**:
  - `EstadoRegistro = Correcto` → `correcto` con el CSV del envío.
  - `AceptadoConErrores` → `aceptado_con_errores`, con código y descripción: la
    AEAT lo tiene, pero hay que subsanarlo. Alerta por factura.
  - `Incorrecto` → `incorrecto`: la AEAT no lo tiene. Alerta crítica por factura.
  - Cuando la AEAT acepta un registro de una factura (la subsanación, la anulación
    repetida), las alertas de los registros anteriores de esa factura quedan
    resueltas.
  - `Incorrecto` con 3000 (duplicado) y `RegistroDuplicado`: si un envío anterior
    del registro acabó sin saber si la AEAT lo guardó (la petición salió y se cortó
    la conexión o se perdió la respuesta, llegó una respuesta HTTP que no era del
    servicio, o la respuesta no traía su línea; columna `envio_incierto`), es el
    propio registro y manda el estado que ya tenía la
    AEAT (`Correcta` o `Anulada` → `correcto`; `AceptadaConErrores` →
    `aceptado_con_errores`). Si no hubo ningún envío incierto (el primer envío, o
    tras un SOAP Fault, en el que la AEAT no guarda nada), quiere decir que la AEAT
    ya tiene otra factura con ese número y fecha (de otro sistema, o un número
    reutilizado): el registro queda `incorrecto`, con su alerta.
  - SOAP Fault (envío entero rechazado, códigos 4xxx) → los registros siguen en
    cola y se reintenta, salvo que el rechazo lo cause un registro (punto
    siguiente).
- **Rechazo del envío entero por un registro**: con los códigos 4102, 4103, 4106,
  4119, 4136, 4137 y 4138 (XML fuera de esquema, fecha mal formada, caracteres que
  no son UTF-8…), reintentar el mismo lote fallaría siempre. Si el lote tenía
  varios registros, pasan a constar con incidencia y la cadena sigue con lotes de
  la mitad del que falló: el que pasa queda remitido y el que falla se vuelve a
  partir, hasta que el rechazo lo provoca un solo registro. Ese queda
  `incorrecto`, con su alerta (para subsanarlo o rectificar la factura), y lo que
  quedaba del lote rechazado se prueba de una vez. Con 1000 registros, el culpable
  aparece en unos 20 envíos, no en 1000. No suma un fallo a la cadena ni abre una
  espera de reintento.
- **Registro ilegible**: si los datos guardados de un registro en cola no se pueden
  leer (solo pasa si se ha tocado la base de datos a mano), no se podrá remitir
  nunca: queda `incorrecto`, con el evento `anomalia_cadena` y su alerta, y la cola
  sigue con los demás. «Subsanar» genera uno nuevo desde la factura.
- **Reintentos** (art. 16.4 de la Orden: «al menos una vez cada hora»): sin
  conexión, con error HTTP o con otro Fault, la cadena espera 1, 2, 5, 15, 30 y
  60 minutos según los fallos seguidos; una hora si el rechazo es de configuración
  (certificado o NIF: 4104, 4107, 4108, 4109, 4112, 4115, 4116, 4123, 4141). El
  contador de fallos de la cadena vuelve a cero en cuanto la AEAT contesta (también
  con el rechazo del registro culpable). «Enviar ahora» se salta la espera tras un
  fallo, pero nunca la que pide la AEAT. Cargar un certificado quita las esperas
  tras un fallo de todas las cadenas (no la de la AEAT): lo que esperaba hasta una
  hora por un rechazo de configuración puede salir ya.
- **Registros con incidencia** (art. 16.4): un registro nace con `incidencia=1` si
  al generarlo no hay certificado o su cadena está en medio de un corte (con fallos
  seguidos o esperando un reintento). Los que ya esperan en cola pasan a constar
  con incidencia cuando falta el certificado (los de todas las cadenas) o falla el
  envío de su cadena (los de esa cadena).
- **Aviso de incidencia** (art. 16.4): va ligado a los registros con incidencia en
  cola. Se abre al marcarlos (un fallo de su cadena, la falta de certificado o un
  envío rechazado entero por un registro, mientras se busca al culpable): una
  alerta crítica dice cuántos faltan por remitir, y Contabilidad → VERI*FACTU lo
  enseña con el número vivo. Se cierra cuando ya no queda en cola ningún registro
  con incidencia, no con el primer envío que llega.
- **Subsanación** (validaciones de la AEAT, anexo 6.1): «Subsanar» genera un alta
  nueva, al final de la cadena, con `Subsanacion=S` y:
  - `RechazoPrevio=X` si la AEAT no tiene ningún alta de la factura (todas
    rechazadas);
  - `RechazoPrevio=S` si tiene un alta y se rechazó su subsanación;
  - sin `RechazoPrevio` si el alta se aceptó con errores.

  Los datos son los de la factura emitida, que no cambian: si el error está en
  ellos (un NIF mal escrito), la corrección es una rectificativa. Si el error era
  un 2001 (NIF del cliente que no está en el censo) y el NIF es de persona física
  (DNI, NIE o los K, L y M), el cliente se declara como no censado: `IDOtro` con
  `CodigoPais ES` e `IDType 07` (validaciones de la AEAT, 4.3.1), porque repetir
  el mismo NIF reproduciría el error.

## 10. Certificado

Se sube como PKCS#12 (.pfx/.p12) con su contraseña. Cargarlo o retirarlo exige
sesión de navegador de un administrador, como el resto de credenciales
persistentes: con un token de API se puede ver su estado y probar la conexión,
pero no cambiarlo (403). Skyway lo abre con OpenSSL
(Node), comprueba que no ha caducado y lee sus datos públicos (titular, NIF de la
entidad o de la persona, emisor, validez, huella SHA-256). Se guarda en `settings`
como las claves de Stripe y **nunca sale por la API ni por los registros**. Es el
secreto más delicado del panel: permite actuar ante la AEAT en nombre de su
titular, y las copias de `skyway.db` lo contienen. Conviene un certificado de
representante o de sello antes que el personal del administrador. Un PKCS#12
exportado con cifrado antiguo (RC2) no abre con OpenSSL 3: hay que exportarlo de
nuevo con AES o TripleDES.

## 11. Registro de eventos

`invoice_events_log`, encadenado por huella como los registros: activación y
desactivación, cambio de entorno o de productor, certificado cargado o retirado,
envíos correctos, con errores, rechazados o fallidos (con el entorno y el NIF de la
cadena), subsanaciones y anomalías de la cadena (§6). En VERI*FACTU no es
obligatorio; sirve para reconstruir qué pasó y cuándo. Inmutable.

## 12. Limitaciones conocidas

- Solo un obligado tributario por instalación (`TipoUsoPosibleMultiOT = N`).
- Solo euros: Skyway no convierte otras monedas, y una factura en otra moneda no se
  emite con VERI*FACTU activo (§4).
- El recargo de equivalencia no se calcula (pendiente de la facturación, no de
  VERI*FACTU); cuando se calcule, el desglose ya lo recoge con la clave 18.
- Las facturas emitidas antes de existir `issued_date` conservan la fecha que
  imprimieron, la UTC de `issued_at`: si se emitieron entre las 00:00 y la 01:00
  (02:00 en verano) hora peninsular, es la del día anterior.
- **Sin renuncia** (`FechaFinVeriFactu`, art. 17 de la Orden): es una decisión.
  Skyway no comunica la renuncia a la AEAT, así que, en cuanto hay registros de
  producción, VERI*FACTU no se puede desactivar ni volver a pruebas (§3). Tampoco
  hay en Skyway otra modalidad a la que pasar.
- Mientras se busca el registro que hace rechazar un envío entero, la cadena envía
  lotes cada vez más pequeños con la espera de la AEAT entre envío y envío (60 s
  si no indica otra): con 1000 registros, unos 20 minutos.

## 13. Pruebas

- `server/test/verifactu-huella.test.ts`: ejemplos oficiales de la huella y formatos.
- `server/test/verifactu-qr.test.ts`: QR (versión, patrones, formato, vectores).
- `server/test/verifactu.test.ts`: activación (con el productor, razón social y
  NIF juntos, y la declaración responsable en texto), alta, encadenamiento,
  anulación (también de una factura anterior a la activación), cliente de la UE,
  rectificativa, bloqueo sin gastar número, PDF, inmutabilidad, validaciones antes
  de emitir (país, NIF-IVA, tipo de IVA según la fecha, 0 % como `S1`, euros, `R2`
  y `R3`), certificado, remisión contra una AEAT simulada (lotes, espera, cortes
  con aviso de incidencia, Fault y «Enviar ahora», aislamiento del registro que
  hace rechazar el envío partiendo el lote, duplicados tras un envío incierto,
  tras un Fault y en el primer envío, rechazo y subsanación, 2001 con `IDType 07`,
  una cola por cadena), certificado solo con sesión de navegador, TLS con
  certificado de cliente, regla de producción (art. 17), punto de acceso de sello
  y comprobaciones del art. 7.i (el reloj bloquea; una anomalía, también un
  registro ilegible, se anota y la facturación sigue). Ninguna prueba llama a la AEAT: lo que solo se puede
  comprobar contra ella está pendiente
  ([AUDITORIA-FACTURACION.md](AUDITORIA-FACTURACION.md), «Sigue pendiente»).
- Los envíos que generan las pruebas validan contra los XSD oficiales:
  `VERIFACTU_VOLCADO=/carpeta npx vitest run test/verifactu.test.ts` los guarda, y
  se validan con `xmllint --schema SuministroLR.xsd` (o lxml).

## Fuentes (consultadas el 9-11-2026)

- Real Decreto 1007/2023 (texto consolidado): https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840
- Orden HAC/1177/2024: https://www.boe.es/buscar/doc.php?id=BOE-A-2024-22138
- AEAT, Sistemas informáticos de facturación y VERI*FACTU: https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu.html
- Especificación de la huella (v0.1.2): https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_especificaciones_huella_hash_registros.pdf
- Validaciones y errores (v1.2.2): https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Validaciones_Errores_Veri-Factu.pdf
- Descripción de los servicios web (v1.0.3): https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf
- Aclaraciones a dudas de los desarrolladores (v1.3): https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf
- Ejemplos de declaraciones responsables de sistemas informáticos de facturación (V0.5.1): los rótulos de la declaración responsable ([DECLARACION-RESPONSABLE.md](DECLARACION-RESPONSABLE.md))
- Esquemas: https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd y `SuministroInformacion.xsd`, `RespuestaSuministro.xsd`, `SistemaFacturacion.wsdl`, `errores.properties` en la misma carpeta
