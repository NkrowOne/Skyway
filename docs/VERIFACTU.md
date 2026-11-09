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
  requerimientos de la AEAT (servicio `RemisionRequerimiento`) ni la consulta de
  registros (`ConsultaFactuSistemaFacturacion`).
- **Modo desactivado**: sin registros, como antes. Solo vale hasta que el emisor
  esté obligado (§2).

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
      enviar ningún registro.
   3. Completar los datos del **productor** y la **declaración responsable**
      (si se dejan vacíos, el productor es el propio emisor).
   4. Activar **VERI*FACTU** en el entorno de **pruebas**. Emitir alguna factura
      y comprobar que los registros salen «Correctos».
   5. Antes del plazo, pasar a **producción**. Desde el primer registro remitido a
      producción, VERI*FACTU no se puede desactivar hasta final de ese año natural.
3. El reloj del servidor tiene que estar en hora (NTP): la Orden admite un minuto
   de error como máximo y Skyway no genera un registro si el anterior tiene una hora
   más de un minuto posterior a la actual.

## 4. El registro de alta

Se genera al **emitir** (borrador → emitida o pagada), dentro de la misma
transacción de SQLite que asigna el número de la serie (`performEmission` →
`registrarAlta`): el número, el registro y su puesto en la cadena se confirman
juntos o no se confirma nada. Solo en la primera emisión: pasar de emitida a
pagada no genera otro. Si un dato haría que la AEAT rechazara el registro, la
emisión entera se deshace con un mensaje (el número no se gasta). El cobro por
el webhook de Stripe no se bloquea nunca por esto: genera el registro igual y,
si la AEAT lo rechaza, se ve y se subsana.

Campos (en el orden de `RegistroFacturacionAltaType`) y de dónde salen:

| Campo | Valor en Skyway |
|---|---|
| `IDVersion` | `1.0` |
| `IDFactura/IDEmisorFactura` | NIF del emisor congelado al emitir (`issuer_snapshot`), en mayúsculas, sin espacios ni prefijo ES |
| `IDFactura/NumSerieFactura` | número de la factura (`FRA-2026-0001`). Hasta 60 caracteres ASCII imprimibles, sin `" ' < > =` (si no, no se emite) |
| `IDFactura/FechaExpedicionFactura` | fecha de expedición en `dd-mm-aaaa`, **en UTC**: es la misma que imprime el PDF |
| `NombreRazonEmisor` | razón social congelada |
| `Subsanacion`, `RechazoPrevio` | solo en las subsanaciones (§9) |
| `TipoFactura` | `F1` completa; `F2` simplificada; rectificativa: `R5` si rectifica una simplificada, si no la causa elegida (`R1` por defecto; `R2`, `R3`, `R4`) |
| `TipoRectificativa` | `I` (por diferencias): la rectificativa de Skyway revierte la original y añade lo correcto, así que su importe es la diferencia |
| `FacturasRectificadas` | NIF, número y fecha de la factura rectificada |
| `FechaOperacion` | la fecha de operación si existe y es otro día. Posterior a la de expedición: no se emite (la AEAT lo rechaza, 1146) |
| `DescripcionOperacion` | los conceptos de las líneas (hasta 500 caracteres); en una rectificativa, «Rectificación de la factura … : motivo» |
| `FacturaSinIdentifDestinatarioArt61d` | `S` en una `F2` de más de 3.000 €: sin ella la AEAT la rechaza (1150) |
| `Macrodato` | `S` si el importe total llega a 100 millones de euros |
| `Destinatarios` | no en `F2`/`R5` (1190). Cliente español: `NIF` (válido y distinto del emisor, si no, no se emite). Cliente de la UE: `IDOtro` con `IDType 02` (NIF-IVA, con el prefijo del país; sin `CodigoPais`, que con 02 no es obligatorio y en Grecia no coincidiría con «EL»). Resto: `IDOtro` con `CodigoPais` e `IDType 04` |
| `Desglose/DetalleDesglose` | uno por régimen y tipo (máx. 12), ver la tabla siguiente |
| `CuotaTotal` | suma de cuotas repercutidas (y de recargo) |
| `ImporteTotal` | **base + cuotas**, sin restar la retención de IRPF: la AEAT lo comprueba así (1210, 2005), aunque el total a pagar de la factura sí la resta |
| `Encadenamiento` | `PrimerRegistro=S` o `RegistroAnterior` (§6) |
| `SistemaInformatico` | productor (configurable; por defecto el emisor), `Skyway`, `SK`, versión de Skyway, número de instalación, `S`/`N`/`N` |
| `FechaHoraHusoGenRegistro` | momento de generación en hora peninsular con su desfase: `2026-11-09T10:15:00+01:00` |
| `TipoHuella`, `Huella` | `01` (SHA-256) y la huella (§5) |

Desglose según el régimen de IVA de la factura (`vat_regime`):

| Régimen en Skyway | `ClaveRegimen` | Calificación / exención | Tipo y cuota |
|---|---|---|---|
| General, tipo > 0 | `01` | `S1` | tipo y cuota |
| General, 0 % | `01` | `N1` (no sujeto: un suplido) | — |
| Recargo de equivalencia con recargo calculado | `18` | `S1` | tipo, cuota, tipo y cuota de recargo |
| Recargo sin recargo calculado (hoy Skyway no lo calcula) | `01` | `S1` | tipo y cuota |
| Exportación (art. 21) | `02` | `E2` | — |
| Entrega intracomunitaria (art. 25) | `01` | `E5` (exige cliente de otro país de la UE) | — |
| Otras exenciones | `01` | `E6` | — |
| Inversión del sujeto pasivo, cliente español | `01` | `S2` | tipo 0 y cuota 0 (1198) |
| Inversión del sujeto pasivo, cliente extranjero | `01` | `N2` (no sujeto por reglas de localización) | — |
| No sujeto, cliente español / extranjero | `01` | `N1` / `N2` | — |

Los textos libres se limpian de los caracteres que la AEAT rechaza (1287):
`'` → `’`, `"` → `”`, y `<`, `>`, `=` → espacio.

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
  no pueden encadenarse al mismo registro.
- Antes de encadenar (art. 7.i de la Orden) se recalcula la huella del último
  registro y se comprueba que su hora no va más de un minuto por delante del reloj.
  Si falla, no se emite ni se anula nada.
- **Inmutable**: disparadores de SQLite impiden borrar registros y cambiar
  cualquier columna que no sea de la remisión (estado, CSV, intentos, error).
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

- Con registro de alta, va en la cadena y el entorno de ese alta **aunque el modo
  esté ya desactivado**: la AEAT tiene el alta y tiene que saber que se anuló.
- Sin registro de alta (factura de antes de activar), solo con el modo activo y en
  el entorno actual. Es opcional para la AEAT: si los datos de esa factura antigua
  no valen para un registro (un NIF no válido), no se genera nada en vez de
  bloquear la anulación.
- Si la cadena está dañada o el reloj va por detrás, no se anula nada (409).

## 8. El QR tributario

Art. 20 y 21 de la Orden y especificación del QR de la AEAT:

- URL del servicio de cotejo con cuatro parámetros codificados en UTF-8:
  `nif`, `numserie`, `fecha` (`dd-mm-aaaa`) e `importe` (el `ImporteTotal` del
  registro, con punto decimal):
  - Producción: `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=…&numserie=…&fecha=…&importe=…`
  - Pruebas: `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?…`
- QR según ISO/IEC 18004, nivel de corrección **M**, de **35 mm** (entre 30 y
  40 mm), con su zona de silencio de 4 módulos. Generador propio sin dependencias
  (`server/src/verifactu/qr.ts`), comprobado contra una implementación de
  referencia y un lector.
- Al principio de la factura: «QR tributario:» encima, el QR y la leyenda
  «VERI*FACTU» debajo. En pruebas, además, «Registro remitido al entorno de
  pruebas de la AEAT».
- La URL se guarda en el registro (`qr_url`); el PDF usa la del último alta.

## 9. La remisión

- **Servicio**: SOAP 1.1, operación `RegFactuSistemaFacturacion` con
  `soapAction=""` (`SistemaFacturacion.wsdl`, `SuministroLR.xsd` +
  `SuministroInformacion.xsd`; respuesta en `RespuestaSuministro.xsd`):
  - Producción: `https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`
  - Pruebas: `https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`
  - Con certificado de **sello**, el punto de acceso de sello del WSDL:
    `https://www10.agenciatributaria.gob.es/…` y `https://prewww10.aeat.es/…`.
    Skyway lo reconoce por el asunto del certificado («SELLO»).
- **Autenticación**: TLS con el certificado de cliente (Node `https` con `pfx`).
  En VERI*FACTU los registros no se firman.
- **Lotes**: hasta 1000 registros del mismo emisor, entorno e incidencia, en orden
  de la cadena y con un solo registro por factura (el alta y la anulación de una
  misma factura nunca van juntas). Cabecera con `ObligadoEmision`; con
  `RemisionVoluntaria/Incidencia=S` si los registros no se pudieron remitir a su
  hora (sin certificado al generarlos o tras un fallo de conexión).
- **Control de flujo**: tras cada respuesta se espera `TiempoEsperaEnvio` (60 s si
  no viene) antes del siguiente envío, salvo que haya 1000 registros en cola.
- **Respuestas**:
  - `EstadoRegistro = Correcto` → `correcto` con el CSV del envío.
  - `AceptadoConErrores` → `aceptado_con_errores`, con código y descripción: la
    AEAT lo tiene, pero hay que subsanarlo. Alerta por factura.
  - `Incorrecto` → `incorrecto`: la AEAT no lo tiene. Alerta crítica por factura.
  - `Incorrecto` con 3000 (duplicado) y `RegistroDuplicado` → el estado que ya tenía
    la AEAT (un reenvío tras perder la respuesta es seguro).
  - SOAP Fault (envío entero rechazado, códigos 4xxx) → los registros siguen en cola.
- **Reintentos** (art. 16.4 de la Orden: «al menos una vez cada hora»): sin
  conexión, con error HTTP o con Fault, esperas de 1, 2, 5, 15, 30 y 60 minutos;
  una hora si el rechazo es de configuración (certificado o NIF: 4104, 4107, 4108,
  4109, 4112, 4115, 4116, 4123, 4141). «Enviar ahora» se salta la espera tras un
  fallo, pero no la que pide la AEAT. El estado de la cola persiste en `settings`
  (`verifactuRemision`) y sobrevive a un reinicio.
- **Aviso de incidencia** (art. 16.4): desde el primer fallo, o en cuanto hay
  registros en cola sin certificado, una alerta crítica dice cuántos registros
  faltan por remitir, y Contabilidad → VERI*FACTU lo enseña con el número vivo
  mientras quede alguno. La alerta se resuelve con el primer envío que llega.
- **Subsanación** (validaciones de la AEAT, anexo 6.1): «Subsanar» genera un alta
  nueva, al final de la cadena, con `Subsanacion=S` y:
  - `RechazoPrevio=X` si la AEAT no tiene ningún alta de la factura (todas
    rechazadas);
  - `RechazoPrevio=S` si tiene un alta y se rechazó su subsanación;
  - sin `RechazoPrevio` si el alta se aceptó con errores.
  Los datos son los de la factura emitida, que no cambian: si el error está en
  ellos (un NIF mal escrito), la corrección es una rectificativa.

## 10. Certificado

Se sube como PKCS#12 (.pfx/.p12) con su contraseña. Skyway lo abre con OpenSSL
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
envíos correctos, con errores, rechazados o fallidos, y subsanaciones. En
VERI*FACTU no es obligatorio; sirve para reconstruir qué pasó y cuándo. Inmutable.

## 12. Limitaciones conocidas

- Solo un obligado tributario por instalación (`TipoUsoPosibleMultiOT = N`).
- El recargo de equivalencia no se calcula (pendiente de la facturación, no de
  VERI*FACTU); cuando se calcule, el desglose ya lo recoge con la clave 18.
- La fecha de expedición es la UTC que imprime el PDF: entre las 00:00 y la 01:00
  (02:00 en verano) hora peninsular difiere del día de generación del registro.
  La AEAT admite esa falta de coincidencia puntual.
- Sin renuncia a VERI*FACTU por la cabecera (`FechaFinVeriFactu`): hoy no hay otra
  modalidad a la que pasar.

## 13. Pruebas

- `server/test/verifactu-huella.test.ts`: ejemplos oficiales de la huella y formatos.
- `server/test/verifactu-qr.test.ts`: QR (versión, patrones, formato, vectores).
- `server/test/verifactu.test.ts`: activación, alta, encadenamiento, anulación
  (también de una factura anterior a la activación), cliente de la UE,
  rectificativa, bloqueo sin gastar número, PDF, inmutabilidad, certificado,
  remisión contra una AEAT simulada (lotes, espera, cortes con aviso de
  incidencia, Fault, duplicados, rechazo y subsanación), TLS con certificado de
  cliente, punto de acceso de sello, regla de desactivación y las comprobaciones
  del art. 7.i (reloj y huella del último registro). Ninguna prueba llama a la
  AEAT.
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
- Esquemas: https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd y `SuministroInformacion.xsd`, `RespuestaSuministro.xsd`, `SistemaFacturacion.wsdl`, `errores.properties` en la misma carpeta
