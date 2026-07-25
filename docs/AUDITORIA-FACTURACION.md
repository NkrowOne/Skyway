# Auditoría de los sistemas críticos de clientes y facturación — Skyway

Revisión completa del dominio que cobra a los clientes: cuentas (*workspaces*),
planes, catálogo, suscripciones, consumo medido, facturas, IVA/IRPF, series de
numeración, rectificativas, morosidad (*dunning*), cobro por Stripe y el panel
que lo maneja. Complementa a [AUDITORIA.md](AUDITORIA.md), que cubre
autenticación, cifrado y superficie de ataque.

**Alcance**: `server/src/routes/{billing,accounting,subscriptions,products,plans,usage,workspaces,webhooks,aigateway}.ts`,
`server/src/{billingauto,billingsettings,company,pricing,quota,stripe,aigateway,db,types}.ts`,
`server/src/scheduler.ts` y `web/src/pages/{Accounting,Workspace,Workspaces,Plans,Catalog}.tsx`.

**Método**: nueve revisiones independientes y simultáneas (corrección fiscal,
aritmética monetaria, integridad transaccional, control de acceso, ciclo de
facturación, medición de consumo, pagos, esquema de datos y panel web), cada
hallazgo sometido después a una verificación adversarial que intentaba refutarlo
leyendo el código. De 89 hallazgos brutos, **18 se descartaron** por no
sostenerse y 71 se confirmaron; consolidados y deduplicados quedan en **44
defectos reales corregidos** (34 en la auditoría, 10 en la segunda tanda, 14 en
la verificación adversarial y 7 en la cuarta) y **4 carencias pendientes**.

**Veredicto general**: el diseño fiscal es serio —numeración por serie y
ejercicio, congelación del emisor y del destinatario al emitir, inmutabilidad de
la factura emitida, desglose de IVA por tipo redondeado una sola vez por base,
rectificativas en serie propia— y el aislamiento entre clientes es correcto: el
administrador es un rol **global de plataforma** y las rutas de cuenta pasan por
`assertWorkspaceAccess`, así que no se encontró ninguna vía por la que un cliente
viera datos de otro. Los problemas serios no estaban en el control de acceso sino
en el **motor de devengo**: qué se cobra, cuántas veces y a quién.

Dos de ellos eran críticos: las cuotas **anuales** se cobraban íntegras los doce
meses, y un cliente podía **anular la medición de su propio consumo de IA**. Los
dos están corregidos.

---

## 1. Correcciones aplicadas

### 1.1 Críticas

| # | Área | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 1 | Devengo | **Las cuotas ANUALES se facturaban enteras en cada ciclo mensual (×12).** El ciclo siempre es mensual (`previousCycle` avanza un mes), pero `generateCycleDraft` empujaba `plan.price_cents` y el precio de la suscripción íntegros en todos ellos; `interval` solo elegía la etiqueta «anual»/«mensual» y no tenía ningún otro uso en el servidor. Un plan de 1.200 €/año facturaba 14.400 €/año, y con la auto-emisión activada quedaban doce facturas numeradas y bloqueadas que solo se deshacen con rectificativas. | Una cuota anual se devenga **una sola vez, en el ciclo que contiene su aniversario** (`annualDueInCycle`, `routes/billing.ts`). El ancla del plan es la columna nueva `workspaces.plan_since`, que se fija al contratar y **se reancla al cambiar de plan** (`routes/workspaces.ts`) para que migrar entre planes anuales no cobre dos anualidades en el mismo año; la de cada suscripción es su `started_at`. Verificado: 12 ciclos consecutivos de un plan anual producen **1** cobro. |
| 2 | Consumo | **El cliente podía anular la medición de su propio consumo de IA.** `usage_events.idempotency_key` es única **global** y `POST /api/usage` aceptaba una clave elegida por el cliente. El medidor interno del gateway derivaba la suya de forma determinista (`gemini:${requestId}:${meter}`) a partir del `responseId` que el propio cliente **recibe en el flujo SSE**: bastaba con enviar esa misma clave con `quantity: 0` antes de que cerrara el flujo para que el consumo real se descartara como duplicado y no se facturase. | Espacios de nombres separados e inalcanzables entre sí: la ingesta por API se prefija `api:<tipo>:<sujeto>:` (`routes/usage.ts`) y la medición interna del gateway `gw:` (`aigateway.ts`). La clave del cliente queda además acotada a su propio sujeto. |

### 1.2 Altas

| # | Área | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 3 | Pagos | **Una factura ANULADA resucitaba como PAGADA.** `markInvoicePaidByStripeSession` no miraba el estado: si el cliente pagaba con un enlace antiguo de una factura ya anulada (cuyos cargos habían vuelto a pendientes y se habían refacturado), la anulada pasaba a `paid` saltándose `ALLOWED_TRANSITIONS`, con el mismo concepto cobrado dos veces. | `void` es terminal y no admite pago. El webhook **audita el incidente y dispara una alerta crítica** en vez de tragárselo: el dinero está en Stripe y hay que devolverlo a mano. |
| 4 | Pagos | **Cada clic en «Cobrar» creaba una sesión de Stripe nueva y machacaba `stripe_session_id`.** Si el cliente pagaba con el enlace anterior, `getInvoiceByStripeSession` no encontraba nada, la factura seguía `issued` y el *dunning* acababa cortándole el servicio a un cliente que ya había pagado. | El endpoint **reutiliza el enlace vigente** en vez de crear otro, y el webhook concilia **primero por el identificador propio** (`metadata.invoiceId` / `client_reference_id`, que Skyway ya ponía en la sesión) y solo después por la sesión, de modo que un enlace antiguo también casa. Además se comprueba que **el importe y la moneda cobrados coinciden** con lo facturado y, si un cobro no se puede imputar a ninguna factura, se audita y se alerta en lugar de responder `{received:true}` en silencio. |
| 5 | Consumo | **El mismo consumo se facturaba una vez por cada suscripción que compartiera medidor.** Dos productos sobre `ai_tokens_out` (o dos suscripciones al mismo producto) generaban dos líneas por el mismo consumo. | Cada medidor se tarifa **una sola vez por ciclo**, con la suscripción más antigua —la misma que ya elige el guardarraíl de presupuesto del gateway (`meterUnitPrice`), así factura y presupuesto quedan alineados. |
| 6 | Aritmética | **Una factura podía sumar importes de monedas distintas.** El plan en EUR y un producto del catálogo en USD se sumaban céntimo a céntimo sin conversión ni aviso. | Moneda única por factura: se rechaza contratar (suscripción o cargo) un producto en otra divisa, se impide cambiar la moneda de un producto ya contratado, y `generateCycleDraft` **aborta con un error accionable** si detecta divisas mezcladas. |
| 7 | Fiscal | **El IRPF configurado en productos y cargos se ignoraba.** `catalog_products.irpf_rate` y `pending_charges.irpf_rate` existían y se guardaban, pero la factura aplicaba siempre el tipo global del perfil a **toda** la base: un cargo de servicios profesionales al 15 % salía sin retención, y con un tipo global distinto de cero se retenía sobre conceptos no sujetos. | Retención **por línea**, agrupada por tipo y redondeada una vez por base, igual que el IVA (`computeTotals`). El descuento comercial agrupa ahora por el par (IVA, IRPF) para no descolocar las bases. La cabecera guarda el tipo único, o el efectivo si la factura mezcla varios. |
| 8 | Fiscal | **Editar el borrador de una rectificativa borraba la referencia a la factura corregida.** El `PATCH` recomputaba `legal_mentions` con `legalMention(regime)`, que devuelve `null` en régimen general: la rectificativa se emitía sin la mención obligatoria (art. 15.2 RD 1619/2012) ni el motivo. | La mención se **reconstruye** conservando la referencia y el motivo (`invoiceMentions` / `rectifyNote`, compartidas con la ruta de rectificación). |
| 9 | Fiscal | **Se podía rectificar la misma factura tantas veces como se quisiera.** Cada rectificativa revierte la original **íntegra**, así que dos seguidas abonaban dos veces la misma operación; nada en la lista indicaba que ya estuviera rectificada. | Se rechaza con 409 una segunda rectificativa viva sobre la misma factura, indicando cuál la rectifica ya. Anulando esa se puede volver a corregir, así que ningún error queda sin salida. |
| 10 | Panel | **Editar las líneas de un borrador colapsaba todos los tipos de IVA al de la factura.** El editor no enviaba el `taxRate` de cada línea, así que abrirlo para corregir una errata y guardar convertía al 21 % una línea exenta o al 10 %. La factura, una vez emitida, ya solo se corrige con una rectificativa. | El editor conserva el tipo y la naturaleza de cada línea, y **expone una columna «IVA %»** editable. La suma del pie deja de rotularse «Total» —era la base imponible— y se aclara que el total lo calcula el servidor. |
| 11 | Morosidad | **Un abono cortaba el servicio a un cliente al corriente.** `listUnpaidIssuedInvoices` devuelve toda factura emitida sin cobrar, incluidas las rectificativas de importe **negativo**: al vencer entraban en mora, avisaban por «−121,00 EUR» y acababan suspendiendo y revocando las claves de IA. | La morosidad se evalúa sobre el **saldo vencido neto**: los abonos compensan la deuda y una factura de importe ≤ 0 nunca abre mora por sí sola. Si el saldo queda saldado, el corte se levanta solo. |
| 12 | Morosidad | **El corte por impago se eludía creando una clave de IA nueva.** La suspensión marcaba `ai_suspended` y pasaba las claves existentes a `suspended`, pero una clave nueva nacía `active` y el proxy solo miraba el estado de la clave. | El proxy comprueba la suspensión **por cuenta** (`resolveProxyKey`), y además no se emiten claves nuevas mientras la cuenta esté cortada. |
| 13 | Ciclo | **Un borrador generado a mitad de mes anulaba la facturación automática de ese ciclo.** `invoiceExistsForCycle` solo comparaba `period_start`, así que la previsión que el operador genera el día 20 bloqueaba para siempre la factura del día de cierre: el consumo restante no se facturaba nunca, en silencio. | La idempotencia se evalúa sobre el **ciclo cerrado**: solo cuenta la factura no-borrador o el borrador creado después de `period_end`. El tick sustituye el borrador parcial por el definitivo y `deleteInvoice` ya devolvía sus cargos a pendientes, así que no se pierde nada. Las anuladas tampoco bloquean. |
| 14 | Devengo | **Una cuenta dada de alta «sin plan» se facturaba el plan por defecto.** `workspacePlan` cae al plan por defecto como respaldo *informativo* de cuotas, y la facturación usaba esa misma función como si el plan estuviera contratado. | La facturación usa `contractedPlan`, sin respaldo: sin `plan_id` no hay línea de plan. `quota.ts` mantiene su respaldo, que ahí sí es correcto. |
| 15 | Panel | **Pulsar «Guardar» sin tocar el campo borraba el precio de IA negociado.** El campo mostraba el precio congelado, pero el guardado leía el *borrador de edición*, vacío mientras no se escribiera: se enviaba `null` y el cliente volvía al precio de catálogo. | Se guarda el valor que **muestra** el campo. |

### 1.3 Medias

| # | Área | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 16 | Ciclo | «Generar ciclo» no era idempotente: dos pulsaciones creaban dos facturas del mismo periodo, con el plan y los cargos duplicados. | La ruta comprueba el ciclo en curso y responde 409. |
| 17 | Morosidad | Anular (o rectificar) la factura vencida dejaba al cliente **cortado para siempre**: el corte solo se levantaba al *pagar*. | Anular una factura también reevalúa el saldo y levanta el corte si ya no debe nada. |
| 18 | Pagos | En monedas **sin decimales** (JPY, KRW…) se enviaba a Stripe el importe en céntimos: cobro de 100 veces la factura. | `stripeAmount` convierte a la unidad mínima real de cada divisa, y la misma función se usa al conciliar el cobro. |
| 19 | Fiscal | La rectificativa de anulación total no neteaba exactamente cero: negaba el **precio unitario** y volvía a multiplicar por la cantidad, reintroduciendo el redondeo con signo contrario. | Se niega el **importe ya calculado** de cada línea. Verificado que la reversa iguala exactamente la base original. |
| 20 | Fiscal | El libro registro exportado incluía **borradores** (sin número ni fecha de expedición) y no seguía ningún orden. | El CSV recoge solo facturas expedidas —las anuladas sí, con su número, para justificar el hueco en la serie— y va ordenado por fecha de expedición y número. |
| 21 | Fiscal | Se emitían facturas completas **sin NIF** del emisor ni del destinatario. | La emisión se bloquea con un mensaje accionable si falta la identificación fiscal del emisor o, salvo en la simplificada, la del cliente. El webhook de cobro queda **exento** a propósito: un pago ya realizado nunca debe quedarse sin registrar por un dato de configuración. |
| 22 | Contabilidad | Los totales y la gráfica sumaban facturas de divisas distintas y las etiquetaban con la moneda de la empresa. | Los totales se agrupan **por moneda**; los KPI y la serie son los de la moneda del emisor y el resto se desglosa aparte, sin sumarse. |
| 23 | Panel | Tras «Generar ciclo», la lista de cargos pendientes quedaba obsoleta y dejaba «eliminar» un cargo ya facturado con un falso mensaje de éxito. | Las mutaciones de factura refrescan también la lista de suscripciones y cargos. |
| 24 | Datos | Borrar un producto con suscripciones **canceladas** reventaba con un 500: `productInUse` las excluía, pero la clave foránea es `ON DELETE RESTRICT`. | `productInUse` cuenta cualquier suscripción que lo referencie, de modo que el producto se archiva en vez de intentar borrarse. |
| 25 | Panel | La UI ofrecía «precio propio» en productos por **tramos**, precio que el motor de facturación ignora (los tramos mandan): prometía un descuento que no se cobraba. | En productos por tramos se remite al catálogo en lugar de ofrecer un campo inoperante. |
| 26 | Panel | «Emitir» y «Marcar pagada» se ejecutaban de un solo clic siendo irreversibles: emitir numera la factura en la serie y la congela. | Ambas piden confirmación explicando la consecuencia. |

### 1.4 Bajas

| # | Área | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 27 | Fiscal | El prefijo de factura es configurable y podía fijarse en `REC`, el código reservado a la serie de rectificativas: ambas compartirían serie correlativa. | El perfil rechaza `REC` como prefijo. |
| 28 | Fiscal | `assignSeriesNumber` reutilizaba una serie existente sin comprobar su naturaleza. | Si el código ya existe con otra naturaleza, se corta **antes** de asignar número. |
| 29 | Pagos | La verificación de la firma de Stripe se quedaba con la **última** `v1` de la cabecera; durante una rotación del secreto Stripe manda varias y se rechazaban webhooks legítimos. | Se evalúan todas las firmas candidatas, sin cortocircuito temporal. |
| 30 | Aritmética | Los tramos de precio se tarifan en el orden almacenado, sin validar que los topes fueran crecientes ni que solo el último quedara abierto. | Se valida al guardar el producto. |
| 31 | Panel | En la lista de facturas, IVA e IRPF solo se mostraban si eran **positivos**: en una rectificativa son negativos y desaparecían. | Se muestran con su signo. |
| 32 | Datos | `dunning_exempt` era una columna muerta: el *dunning* la respetaba pero ninguna ruta podía escribirla. | Editable desde la cuenta y expuesta en la API. |
| 33 | Panel | El editor rotulaba «Total» a la suma de líneas, que es la base imponible. | Corregido junto al #10. |
| 34 | Datos | Se podía cambiar la moneda de un producto ya contratado, dejando suscripciones vivas con la divisa congelada distinta. | Se rechaza; hay que archivarlo y crear uno nuevo. |

---

## 2. Verificaciones (correcto — no requiere cambios)

Puntos que se auditaron a fondo y **resultaron sanos**, varios de ellos tras
descartar un hallazgo que no se sostenía:

- **Aislamiento entre clientes**: `admin` es un rol global de plataforma, no por
  cuenta, así que las rutas de factura por `:id` protegidas con `requireAdmin` no
  son un IDOR. Las rutas de cuenta (`/invoices`, `/subscriptions`, `/usage`)
  pasan por `assertWorkspaceAccess`. No se encontró ninguna vía por la que un
  cliente viera facturas, datos fiscales, precios negociados o consumo de otro.
- **Secretos**: la clave secreta de Stripe y la de firma del webhook se exponen
  como booleanos; las claves de API de cliente se guardan hasheadas y el secreto
  solo viaja al crearlas.
- **Numeración**: `assignSeriesNumber` es atómica (lectura y escritura en la
  misma transacción) y la tabla tiene `UNIQUE (code, year)`. La numeración se
  reinicia por ejercicio y las rectificativas usan serie propia.
- **Inmutabilidad**: el `PATCH` rechaza con 409 cualquier edición de contenido
  fiscal sobre una factura no-borrador, y solo se borran borradores. `locked` es
  redundante con esa comprobación, no un control que falte.
- **Día de facturación**: `billing_day` tiene `CHECK BETWEEN 1 AND 28` en el
  esquema, así que no existe el desbordamiento de fin de mes (un `billing_day`
  31 en febrero) que sí afectaría a `new Date(año, mes, día)`.
- **Conservación fiscal**: borrar una cuenta con facturas emitidas se rechaza con
  409 (la clave foránea las arrastraría en cascada); hay que suspenderla.
- **Ventanas de consumo**: los rangos horarios son semiabiertos `[from, to)` en
  ambas consultas (`workspaceUsageRange`, `workspaceMeterUsage`), así que la hora
  frontera no se cuenta dos veces ni se pierde.
- **Cargos puntuales**: `deleteInvoice` y la anulación devuelven los cargos
  enlazados a `pending`, dentro de una transacción, y `markChargesInvoiced` solo
  actúa sobre los que siguen pendientes.
- **Ingesta de consumo**: `POST /api/usage` exige acceso al workspace del sujeto,
  rechaza cantidades negativas y no admite marcas temporales futuras.
- **CSV**: la exportación neutraliza la inyección de fórmulas respetando los
  importes negativos legítimos.
- **Firma del webhook**: es la de Stripe (`t=…,v1=…` sobre el cuerpo crudo), con
  comparación en tiempo constante y tolerancia anti-*replay* de 300 s.

---

## 3. Segunda tanda: lo que exigía migrar esquema o decidir política

Resuelto después de la auditoría, con el esquema migrado y las decisiones
comerciales tomadas (prorrateo por días; solo régimen general español).

| # | Área | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 35 | Consumo | **Borrar un servicio borraba retroactivamente su consumo sin facturar**, y **reasignar un proyecto trasladaba todo su histórico** a la cuenta nueva: la atribución se resolvía con un `JOIN` vivo servicio → proyecto → workspace. | `service_metrics_hourly` y `usage_meter_hourly` congelan el titular en el momento de medir (con relleno único de las filas existentes). La poda deja de borrar las métricas de servicios eliminados —eran consumo real pendiente de cobro— y caducan por antigüedad como el resto; de paso se podan `usage_events` y `usage_meter_hourly`, que no caducaban. |
| 36 | Ciclo | **Cambiar el día de facturación refacturaba el tramo solapado o dejaba un hueco**, y si el servidor estaba caído el día de cierre **ese ciclo se perdía para siempre**. | `workspaces.last_billed_period_end` ancla el periodo: se factura de lo último facturado al último corte vencido, sin depender del día del mes. El ancla solo avanza con periodos cerrados (una previsión del periodo en curso no consume el ciclo), y borrar o anular la factura que cerraba un periodo lo devuelve. |
| 37 | Devengo | **Un alta a mitad de ciclo pagaba el mes completo** y **una baja a mitad de ciclo no pagaba nada** del periodo prestado. | Prorrateo por días de altas y bajas, escalando contra el **mes nominal** y no contra el ciclo ya recortado (escalar contra el ciclo devolvía factor 1 justo en el alta, que es el caso que se quería arreglar). Las cuotas anuales no se prorratean: se devengan enteras en su aniversario. |
| 38 | Datos | Una suscripción cancelada o pausada **no se podía prorratear**: el corte masivo por impago cambia el estado sin escribir `cancelled_at`. | `workspace_subscriptions.status_changed_at` registra cada cambio de estado, y `listBillableSubscriptions` incluye en el ciclo las bajas ocurridas dentro de él. |
| 39 | Ciclo | **Los cargos puntuales se perdían al quitar su línea del borrador**: quedaban `invoiced` en una factura que ya no los contenía. | La línea guarda el `chargeId` del que procede y viaja de vuelta con el editor; al guardar, los cargos que ya no figuran vuelven a «pendiente». |
| 40 | Morosidad | **Reactivar al pagar revivía claves y suscripciones que el operador había cortado a mano.** | `suspended_by` / `paused_by` distinguen el corte por morosidad del manual; solo revive el primero. |
| 41 | Factura | **No existía documento de factura ni forma de remitirla al cliente.** | PDF de la factura generado a mano (sin dependencias, como el cliente de Stripe del repositorio): A4, WinAnsi con acentos y €, desglose de IVA por tipo, IRPF, paginación con la cabecera repetida y los totales siempre en la última hoja. Descargable por el admin **y por la propia cuenta**. Se añade un cliente SMTP propio y el envío de la factura al emitirla (opt-in `emailOnIssue`), con prueba de conexión en Ajustes. Un fallo de correo nunca deshace la emisión: se audita y se alerta. |
| 42 | Acceso | La ingesta de consumo facturable **no dejaba traza**, y el **catálogo comercial completo** lo leía cualquier usuario autenticado, incluido un miembro de proyecto. | `POST /api/usage` se audita; el catálogo exige admin o propietario de cuenta. |
| 43 | Fiscal | El selector **«Modo Verifactu (AEAT)»** sugería una funcionalidad inexistente. | Rotulado como preparado pero no operativo, hasta implementar huella, QR y remisión. |
| 44 | Fiscal | **El país del cliente no se registraba en ninguna parte**, pese a ser lo que determina el régimen de IVA de la operación. | `workspaces.billing_country` en ISO 3166-1 alfa-2 con **España por defecto**, seleccionable en la ficha de la cuenta, congelado en la factura al emitir (`client_country`) e impreso en el PDF junto al domicilio del destinatario. |

## 3.ter Tercera tanda: verificación adversarial de la reforma

Terminada la reforma, todo el diff se sometió a una **revisión adversarial en seis
frentes** (devengo, consumo, fiscal, pagos, rutas HTTP y documento), con cada
defecto sometido después a un refutador que debía **reproducirlo ejecutando
código**. De 38 defectos en bruto, 10 se descartaron y **28 se confirmaron, todos
reproducidos**. Los 14 de más impacto están corregidos:

| # | Gravedad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 45 | **Crítica** | **Emitir la previsión del ciclo EN CURSO congelaba el ancla y la cuenta no se volvía a facturar nunca.** El ancla solo avanzaba con periodos cerrados, pero `invoiceExistsForCycle` sí daba por facturado el periodo en cuanto la factura dejaba de ser borrador: 200 ticks después, cero facturas nuevas. Regresión introducida por la propia reforma. | El ancla avanza al **emitir**, no solo al cerrar el periodo: emitir es un hecho legal y el cliente queda facturado hasta `period_end`. Solo avanza si la factura continúa la línea temporal (`period_start` = ancla), para que una factura a medida con periodo arbitrario no se salte periodos pendientes. |
| 46 | Alta | **Un hueco de varios meses se cobraba como un solo mes.** `prorationFactor` capaba el factor a 1, así que recuperar un ciclo atrasado de 3 meses facturaba una cuota y el ancla saltaba al final: los otros dos no se facturaban jamás. | El tick recorre los periodos pendientes **de uno en uno** (`pendingPeriods`), con su prorrateo y su idempotencia por periodo. La tolerancia de `prorationFactor` ya solo redondea hacia arriba lo que roza 1, sin recortar factores mayores. |
| 47 | Alta | **El tick borraba cualquier borrador con el mismo `period_start`**, incluidas las facturas escritas a mano y las rectificativas en borrador. | Columna `workspace_invoices.origin`: solo se sustituye el borrador que generó el propio ciclo (`origin='cycle'`, tipo ordinario). |
| 48 | Alta | **El editor del panel destruía la retención de IRPF por línea**: no devolvía `irpfRate`, así que el servidor aplicaba el tipo EFECTIVO de la cabecera a todas las líneas (150,00 € de retención pasaban a 75,00 €). | El editor y la rectificativa conservan el IRPF por línea y lo exponen en una columna «IRPF %». Una línea nueva nace sin retención, no con el tipo agregado. |
| 49 | Alta | **La morosidad usaba la factura vencida más antigua aunque un abono ya la hubiera saldado**: cancelaba cuentas cuya única deuda real seguía dentro del periodo de gracia. | Los abonos se imputan **FIFO** contra las vencidas más antiguas; solo entran en la etapa las que conservan deuda. |
| 50 | Media | **Cambiar el régimen de IVA a uno exento machacaba los tipos por línea de forma irreversible**: al volver a «general» la factura quedaba con base entera y 0,00 € de IVA. | El tipo real de la línea se conserva siempre; la exención se aplica solo al calcular el desglose. |
| 51 | Media | **El backfill de atribución corría ANTES de la migración de clientes→workspaces**: una instalación que saltara versiones perdía la atribución de todo su histórico, y la marcaba como hecha. | Se ejecuta después, y solo se da por hecha cuando no queda ninguna fila con titular resoluble sin resolver. |
| 52 | Media | **Las claves y suscripciones cortadas por la versión anterior nunca revivían al pagar** (`suspended_by` NULL): la cuenta quedaba reactivada a medias. | Migración `dunning_actor_v1` que las marca como cortadas por morosidad, acotada a las cuentas efectivamente en mora. |
| 53 | Media | **La contraseña SMTP acababa en claro (base64) en la auditoría y en las alertas** cuando el relé repite el comando no reconocido. | Todo texto del servidor pasa por un saneador que enmascara los bloques largos de base64 antes de salir del módulo. |
| 54 | Media | **Reanudar una suscripción pausada cobraba el mes entero** por unos días de servicio (asimétrico con la baja, que sí se prorrateaba). | Se cobra desde la reanudación (`status_changed_at`). Limitación conocida: si la pausa y la reanudación caen en el mismo ciclo, solo se cobra el tramo posterior. |
| 55 | Media | **El PDF imprimía un tipo de retención inventado** cuando la factura mezclaba conceptos con y sin IRPF (13,86 % sobre una base que no da ese importe). | Con tipos mezclados se imprime «Retención IRPF» sin porcentaje; el tipo solo se muestra cuando es uniforme. |
| 56 | Baja | `workspaceUsageByProject` se quedó sin migrar: el desglose por proyecto no cuadraba con el total ni con la factura. | Filtra por el titular congelado, como el resto. |
| 57 | Baja | La traza de `POST /api/usage` escribía una fila de auditoría **por evento**. | Una traza por (cuenta, medidor, día). |
| 58 | Baja | El CSV del libro registro colaba **borradores anulados**, sin número ni fecha pero con base e IVA. Y el cliente no podía descargar su propia factura (el botón estaba bajo `isAdmin`). | El libro exige fecha de expedición; el botón de descarga sale del bloque de admin (la ruta ya lo permitía). |

### Cuarta tanda: el resto de los defectos confirmados

Los 8 defectos menores que el §3.ter dejaba documentados, ya corregidos:

| # | Hallazgo | Corrección |
| --- | --- | --- |
| 59 | **Dos líneas de descuento con la etiqueta idéntica** e importes distintos: el desdoble lo causaba el IRPF pero la etiqueta solo nombraba el IVA. La causa de fondo era que `undefined` y el tipo por defecto formaban grupos separados. | El IRPF se normaliza al agrupar con el mismo criterio que `computeTotals`, la línea del plan declara su retención (0: una cuota de plan no está sujeta) y la etiqueta nombra solo la dimensión que de verdad varía. |
| 60 | **El envío de la factura fallaba sin dejar traza** cuando no había SMTP o la cuenta no tenía email: los dos cortes salían antes del `try` y los llamantes automáticos descartan el resultado. | Un único camino de fallo que audita y alerta también en esos dos casos. |
| 61 | **Un cobro por segunda vía pasaba en silencio**: `markInvoicePaidByStripeSession` cortaba por estado antes de mirar con qué sesión y con qué método se había cobrado. | Desenlace nuevo `cobro_duplicado` cuando la factura ya estaba saldada por otro medio o con otra sesión; el webhook lo audita y lanza alerta crítica. El reenvío del mismo evento sigue siendo idempotente y silencioso. |
| 62 | **El PDF de una factura ANULADA era idéntico al de una válida**: mismo número, misma fecha, mismo total. | El título lo rotula: «FACTURA ANULADA» / «FACTURA RECTIFICATIVA ANULADA». |
| 63 | **El duplicado de una factura emitida cambiaba solo**: el vencimiento salía del perfil vivo, así que ampliar las condiciones de pago alteraba un documento ya expedido. | Columna `due_at`, congelada al emitir. La morosidad usa **la misma** fecha, para que lo impreso y lo que dispara la suspensión no puedan divergir. |
| 64 | **Asignar la cuenta a un proyecto creado sin ella perdía el consumo acumulado** — el flujo de alta habitual: crear el proyecto, desplegar, asignar el cliente días después. | `setProjectWorkspace` adopta, en la misma transacción, el consumo **aún sin titular** de sus servicios. El filtro `workspace_id IS NULL` impide que una reasignación entre cuentas se lleve lo ya atribuido. |
| 65 | **Una clave bloqueada a mano revivía sola al pagar**: `suspended_by` no estaba en la lista blanca, así que desbloquearla dejaba pegada la marca `dunning`. | `suspended_by` es escribible y el actor se reescribe en cada cambio manual, tanto en claves como en suscripciones. |

Sobre los parches de esta tanda: se generaron en worktrees aislados, pero **dos
de los cuatro se crearon desde `main`** y por tanto ignoraban las reformas
anteriores; sus revisores detectaron que habrían revertido trabajo ya verificado.
Ninguno de los cuatro se integró: las correcciones se reescribieron sobre la base
correcta aprovechando su diseño y, sobre todo, las trampas que la revisión
destapó.

### Sigue pendiente

1. **Cambiar de plan a mitad de ciclo pierde el tramo del plan anterior**: solo se
   factura el plan actual prorrateado desde `plan_since`, así que una subida o
   bajada el día 25 deja sin cobrar los 24 días del plan saliente. Arreglarlo bien
   exige un historial de plan por tramos; el atajo (crear un cargo puntual con el
   tramo saliente al cambiar de plan) necesita recortar por el ancla y conocer el
   mes nominal del ciclo que cerrará.
2. **Cada cubo horario se factura como hora completa**, aunque el servicio solo
   haya corrido unos minutos dentro de esa hora.
2. **El recargo de equivalencia no se calcula.** El régimen es seleccionable y
   `InvoiceLine.reRate` existe, pero nadie lo rellena ni lo suma.
3. **No se puede registrar el régimen de IVA del cliente**, así que la facturación
   recurrente a un cliente intracomunitario o extranjero no sale correcta sin
   editar la factura a mano. El **país** sí se registra ya (`workspaces.billing_country`,
   ISO 3166-1 alfa-2, España por defecto): se congela al emitir y consta en la
   factura y en el PDF, de modo que cuando se implemente el régimen por país el
   dato ya estará.
4. **Verifactu**: el registro encadenado (`invoice_ledger`, `invoice_events_log`)
   está creado como reserva, sin huella, QR ni remisión a la AEAT.

Los puntos 2 y 3 se dejan conscientemente fuera: el negocio factura hoy solo en
régimen general español.

---

## 3.bis Estado original de estos puntos (para trazabilidad)

Así se documentaron al cerrar la auditoría, antes de la segunda tanda.

1. **La atribución del consumo no está materializada** (`db.ts`,
   `service_metrics_hourly`). El consumo de infraestructura se atribuye por un
   `JOIN` vivo `servicio → proyecto → workspace`, así que **borrar un servicio
   borra retroactivamente su consumo aún no facturado** (se factura 0 por lo
   consumido) y **reasignar un proyecto a otra cuenta traslada todo su histórico**,
   incluido el ya facturado. Arreglo: columnas `workspace_id`/`project_id` en las
   tablas horarias, escritas en el momento de medir (en `recordServiceMetrics` y
   `recordServiceDisk`), formando parte de la clave del *upsert*, con relleno
   único de las filas existentes antes de cambiar las consultas.
2. **No hay ancla de facturación persistente.** El ciclo se deriva de
   `billing_day`, así que **cambiar el día de facturación** refactura el tramo
   solapado o deja un hueco sin facturar, y si el servidor está caído justo el día
   de cierre **ese ciclo se pierde para siempre** (el tick solo mira el día
   exacto). Arreglo: `workspaces.last_billed_period_end`, actualizado en la misma
   transacción que crea la factura, y facturar el rango
   `[last_billed_period_end, corte)` en vez de reconstruirlo desde `billing_day`.
   Esto resuelve los dos casos de una vez.
3. **Los cargos puntuales se pierden al quitar su línea del borrador.** El cargo
   queda `invoiced` apuntando a una factura que ya no lo contiene: no vuelve a
   pendientes ni entra en ningún ciclo posterior. Arreglo: persistir el vínculo
   (`chargeId` en `InvoiceLine` y en `lineSchema`, propagado por `computeTotals` y
   por el editor del panel) y reconciliar al guardar. **No** basta con reabrir los
   cargos al editar: sin el identificador en la línea se reabrirían todos y se
   facturarían dos veces, que es peor que el defecto actual.
4. **Una suscripción cancelada o pausada a mitad de ciclo no se factura por el
   periodo ya prestado.** `listActiveSubscriptions` filtra por `status='active'`.
   El propio *dunning* abre el mismo hueco al pasarlas a `paused`. Cuidado: no se
   puede resolver mirando `cancelled_at`, porque `setWorkspaceSubscriptionsStatus`
   cambia el estado **sin** escribir fecha; hace falta persistir primero cuándo
   cambió el estado, o se pasa de una infrafacturación acotada a una
   sobrefacturación permanente.
5. **No hay prorrateo.** Un alta a mitad de ciclo paga el mes completo, incluido
   el tiempo anterior al alta. Es una decisión comercial antes que un defecto,
   pero hoy no está ni documentada en el panel.
6. **Cada cubo horario se factura como hora completa**, aunque el servicio solo
   haya corrido unos minutos dentro de esa hora.
7. **El recargo de equivalencia no se calcula.** El régimen es seleccionable y
   `InvoiceLine.reRate` existe, pero nadie lo rellena ni lo suma: una factura a un
   cliente en recargo sale sin él.
8. **No se puede registrar el régimen de IVA ni el país del cliente** en la ficha
   de la cuenta. El ciclo automático fuerza `general`, así que la facturación
   recurrente a un cliente intracomunitario o extranjero nunca sale correcta sin
   editar la factura a mano.
9. **La reactivación por pago revive claves y suscripciones que el operador había
   cortado a mano**: no se distingue una suspensión por morosidad de una manual.
10. **No existe documento de factura (PDF) ni forma de remitirla al cliente**
    desde el panel; solo la vista en pantalla.
11. **El selector «Modo Verifactu (AEAT)» no activa nada.** El esquema del
    registro encadenado (`invoice_ledger`, `invoice_events_log`) está creado a
    propósito como reserva —así activarlo no exigirá reconstruir tablas
    pobladas—, pero el selector del panel sugiere una funcionalidad que aún no
    existe. Conviene marcarlo como «preparado, no activo» hasta implementar
    huella, QR y remisión.
12. **`POST /api/usage` no deja traza de auditoría** pese a inyectar consumo
    facturable. Auditar cada evento inundaría el registro; lo razonable es un
    resumen por sujeto y ciclo, o auditar solo las ingestas anómalas.
13. **El catálogo comercial completo, con precios y tramos, lo lee cualquier
    usuario autenticado**, incluido un miembro de proyecto sin relación con la
    facturación.

---

## 4. Cómo reproducir las verificaciones

```bash
npm install
npm run typecheck     # server + web en verde
npm run build         # build de producción en verde

# Smoke de arranque y de autenticación de las rutas de facturación:
DATA_DIR=/tmp/skyway PORT=4999 node server/dist/index.js &
curl -s  --noproxy '*' http://127.0.0.1:4999/api/health                 # {"ok":true,...}
curl -so /dev/null --noproxy '*' -w '%{http_code}\n' \
     http://127.0.0.1:4999/api/accounting/summary                       # 401
curl -so /dev/null --noproxy '*' -w '%{http_code}\n' -X PATCH \
     -H 'content-type: application/json' -d '{}' \
     http://127.0.0.1:4999/api/invoices/x                               # 401
curl -s  --noproxy '*' -X POST -H 'content-type: application/json' \
     -d '{"type":"checkout.session.completed"}' \
     http://127.0.0.1:4999/api/webhooks/stripe                          # sin firma: rechazado
```

Comprobaciones de comportamiento ejecutadas contra el servidor compilado, todas
en verde:

| Comprobación | Resultado esperado |
| --- | --- |
| Plan anual a lo largo de 12 ciclos | **1** cobro, no 12 |
| Cuenta sin plan asignado | no se genera línea de plan |
| Dos suscripciones sobre el mismo medidor | **1** línea de consumo |
| Cargo al 15 % de IRPF + cargo no sujeto | retención solo sobre la base sujeta |
| Emitir sin NIF del cliente | bloqueado con mensaje accionable |
| Serie `REC` pedida como ordinaria | rechazada antes de numerar |
| Suscripción en USD en una cuenta en EUR | la factura aborta con error de moneda |
| `stripeAmount(12100, 'JPY')` | `121` (no `12100`) |
| Abono vencido como única deuda | no abre morosidad |
| Abono que salda la deuda | levanta el corte |
| Reversa de la rectificativa | netea exactamente la base original |
| Cobro con importe distinto al facturado | no marca pagada |
| Cobro con un enlace antiguo | concilia por el id de factura |
| Cobro sobre factura anulada | no resucita; se audita y alerta |
| Alta el día 16 de un mes de 31 | cuota prorrateada 16/31, no completa |
| Baja el día 16 de un mes de 31 | se cobra el periodo prestado, no cero |
| Ciclo completo | sin prorrateo |
| Cambio del día de facturación de 10 a 15 | una sola factura, 10-jul → 15-jul |
| Servidor caído el día de cierre | el ciclo se recupera en el tick siguiente |
| Consumo tras borrar el servicio | sigue atribuido al titular congelado |
| Línea de cargo eliminada del borrador | el cargo vuelve a pendiente; el resto no |
| PDF de 62 líneas con 3 tipos de IVA | 3 páginas, xref válida, TOTAL en la última |
| PDF de una rectificativa | conserva el signo negativo |
| Envío de la factura | PDF adjunto válido y descodificable en el correo |
| Inyección de un CRLF en el remitente o el destinatario | rechazada antes del sobre SMTP |
| Credenciales SMTP rechazadas | error accionable, sin filtrar la contraseña |
