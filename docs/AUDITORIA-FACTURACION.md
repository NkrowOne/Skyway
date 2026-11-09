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
sostenerse y 71 se confirmaron; consolidados y deduplicados quedan en **46
defectos reales corregidos** (34 en la auditoría, 10 en la segunda tanda, 14 en
la verificación adversarial, 7 en la cuarta y 2 en la quinta) y **5 carencias
pendientes** (ver «Sigue pendiente»).

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
| 19 | Fiscal | La rectificativa de anulación total no neteaba exactamente cero: negaba el **precio unitario** y volvía a multiplicar por la cantidad, reintroduciendo el redondeo con signo contrario. | Se niega el **importe ya calculado** de cada línea. Verificado que la reversa iguala exactamente la base original; desde la sexta tanda (nº 68) también la cuota de IVA y la de IRPF. |
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

### Quinta tanda: historial de plan por tramos y rebobinado del ancla

Los dos defectos que la cuarta tanda dejaba abiertos, ya corregidos:

| # | Hallazgo | Corrección |
| --- | --- | --- |
| 66 | **Cambiar de plan a mitad de ciclo perdía el tramo del plan anterior**: solo se facturaba el plan vigente prorrateado desde `plan_since`, así que pasar de Pro a Básico el día 25 cobraba el mes entero a 10 €/mes y regalaba 24 días de Pro (y al revés, subir de plan cobraba el mes entero al precio caro). | Tabla `workspace_plan_periods`: un tramo por cada intervalo con un plan, abierto en el alta y partido en cada cambio, dentro de la misma transacción que el `plan_id` de la cuenta. `generateCycleDraft` factura **cada tramo a su precio**, prorrateado por los días servidos contra el mes nominal: 24 días de Pro (77,42) + 7 de Básico (2,26) = **79,68 €**. |
| 67 | **El ancla no se rebobinaba si la factura anulada no era la última**: `rewindAnchorIfLast` exigía `last_billed_period_end === period_end`, así que anular la factura de mayo con junio y julio ya facturados dejaba mayo sin facturar para siempre. | Rebobina siempre que el ancla esté por delante del inicio del periodo. Los ciclos posteriores no se duplican porque el tick los salta (`invoiceExistsForCycle`) y **vuelve a empujar el ancla al pasar por ellos**; además la empuja cuando un periodo no tiene nada que facturar, que antes la dejaba clavada y hacía crecer el hueco mes a mes. |

Decisiones de diseño del historial, y las trampas que evitan:

- **La tarifa viva manda mientras el plan exista**; el tramo guarda una copia
  congelada (nombre, precio, divisa, intervalo) que solo se usa si el plan se
  borró del catálogo. Así editar un precio sigue afectando a lo no facturado y el
  histórico se puede facturar igualmente. Borrar un plan sigue bloqueado solo si
  alguna cuenta lo tiene **contratado**: figurar en un historial no lo bloquea.
- **El aniversario de una cuota anual se ancla en la primera contratación de ese
  plan**, no en el tramo. Irse y volver al mismo plan dentro del año no devenga
  una segunda anualidad; pasar de un plan anual a otro devenga solo la del nuevo.
- **Un tramo de minutos no genera línea**: se descarta si su importe redondea a
  cero (un plan gratuito sí conserva la suya, porque ahí el cero es el precio).
  Sin esto, un cambio de plan justo antes del cierre podía sumar un céntimo de más.
- **Un cambio de divisa no bloquea el ciclo**: partirlo mezclaría monedas en una
  factura, y abortar dejaría el ancla clavada y la cuenta sin facturar para
  siempre. Se factura el mes completo al plan vigente —el comportamiento
  anterior— y se levanta una alerta para que el operador rectifique.
- **El descuento comercial no se trocea por tramos**: es una condición del
  acuerdo con el cliente, no una propiedad de la tarifa, y se aplica a toda la
  factura (consumo y cargos incluidos), no solo a la cuota.
- El historial se ve en la pestaña «Facturación» de la cuenta, con el precio de
  cada tramo y hasta dónde está facturada.

### Sexta tanda: redondeo, ancla, Stripe y validaciones

Verificado con 20 000 facturas aleatorias (IVA 0–21 %, IRPF 0–19 %, cantidades
fraccionarias e importes negativos) y con la app arrancada sobre una base
temporal (`scratchpad/r2/`).

| # | Hallazgo | Corrección |
| --- | --- | --- |
| 68 | **La cuota de IVA/IRPF de la rectificativa difería 1 céntimo** de la original: `Math.round` redondea la mitad hacia +∞ (`+100,5 → 101`, `−100,5 → −100`) y `base × (tipo/100)` arrastra el error de coma flotante. | `roundCents` (mitad lejos de cero, simétrico) y `cuota = roundCents(base × tipo / 100)` en importes de línea, desglose de IVA, IRPF y descuento. Solo afecta a lo que se recalcule: las emitidas son inmutables. |
| 69 | **El rebobinado del ancla refacturaba**: retrocedía al `period_start` de cualquier factura anulada o borrada, también de una a medida cuyo periodo no coincide con un corte, y el tick volvía a cobrar plan y consumo del tramo. | No rebobina si otra factura expedida y viva solapa el periodo. |
| 70 | **Doble abono**: se podía anular una factura que ya tenía una rectificativa viva. | 409 hasta anular antes la rectificativa (simétrico a la guarda de `/rectify`). |
| 71 | **Enlace de Stripe muerto para siempre**: se reutilizaba a ciegas la sesión guardada, y Checkout caduca a las 24 h. Además un borrador con total ≤ 0 se **emitía y numeraba** antes de que Stripe rechazara el importe, y dos clics seguidos creaban dos sesiones. | Se consulta a Stripe y, si la sesión no sigue abierta, se crea otra (`invoice_stripe_link_expired`); el importe se comprueba antes de emitir (400); guarda de concurrencia (409) y recomprobación del estado tras esperar a Stripe. |
| 72 | **«Generar ciclo» con el ancla atrasada varios meses** facturaba el hueco entero como un ciclo (factor 2,9 sobre el mes nominal, consumo sumado). | Toma el primer periodo pendiente, de uno en uno, igual que el tick. |
| 73 | Validaciones que solo vivían en el panel: plan **archivado** contratable por API; **moneda** de un plan contratado editable (el ciclo abortaba por divisas mezcladas); producto `metered`/`tiered` **sin medidor** (nunca se facturaba, en silencio); periodo de factura a medida invertido; `workspaceCurrency` calculada con el plan por defecto mientras el ciclo usaba el contratado. | 400/409 en el servidor; misma regla de moneda que el ciclo. |
| 74 | `due_at` (el vencimiento congelado que imprime el PDF y usa la morosidad) no llegaba al panel. | Expuesto en las facturas de la cuenta y de contabilidad. |

Pendiente de decisión (no tocado): la factura **a medida** toma por defecto el
periodo del ciclo en curso y, al emitirse con `period_start` igual al ancla,
la empuja al fin del ciclo: el plan y el consumo de ese mes no se facturan
nunca. Arreglarlo exige decidir si `origin='manual'` cuenta como factura del
ciclo (hoy es la vía para desatascar un ciclo bloqueado) o si el panel deja de
usar el ciclo como periodo por defecto.

### Séptima tanda: vuelta del cliente tras pagar con Stripe

| # | Hallazgo | Corrección |
| --- | --- | --- |
| 75 | **Tras pagar o cancelar en Stripe, el cliente volvía al panel de administración** (`/workspaces/:id`), que le pedía iniciar sesión aunque no tuviera cuenta. Además, la URL de vuelta salía de la cabecera Host del administrador que creaba el enlace. | Ajuste `paymentReturnUrl` en el perfil de facturación: solo `https://`, sin usuario ni contraseña (`http://` o `javascript:` → 400). Con él, Stripe devuelve a esa página pública con `estado=pagado` o `estado=cancelado` y `factura=<número>`, codificado, y se conservan los parámetros que ya traiga. Vacío, se mantiene la vuelta al panel. `estado` solo informa: el cobro lo sigue confirmando el webhook. Pruebas en `server/test/billing-stripe.test.ts`. |

### Octava tanda: VERI*FACTU

| # | Hallazgo | Corrección |
| --- | --- | --- |
| 76 | **Skyway no cumplía el Reglamento de sistemas informáticos de facturación** (RD 1007/2023, Orden HAC/1177/2024), obligatorio desde el 1-1-2027 para las sociedades y el 1-7-2027 para el resto: el libro `invoice_ledger` estaba vacío, sin huella, QR ni remisión, y el selector «Modo Verifactu» no activaba nada. | Modalidad **VERI*FACTU** completa ([VERIFACTU.md](VERIFACTU.md)): registro de alta al emitir y de anulación al anular, **en la misma transacción** que la numeración y con la huella SHA-256 encadenada (los tres ejemplos oficiales de la AEAT son prueba); registros **inmutables** por disparadores de SQLite; comprobaciones del art. 7.i de la Orden antes de encadenar (nº 81); QR tributario de 35 mm con 6 mm de zona de silencio y las leyendas «QR tributario:» y «VERI*FACTU» en negrita de 14 pt (el cuerpo de la razón social del emisor, el dato más grande) en el PDF; remisión al servicio SOAP de la AEAT con certificado de cliente (por el punto de acceso de sello si el certificado lo es), **una cola por cadena** (nº 80), lotes de hasta 1000, control de flujo, reintentos, duplicados, incidencias, alertas y subsanación; certificado tratado como secreto (nunca sale por la API); registro de eventos encadenado; productor del sistema con razón social y NIF juntos (uno sin el otro → 400; sin ninguno, el emisor); declaración responsable con los rótulos del modelo de la AEAT, en el panel y en texto plano (`GET /api/verifactu/declaracion.txt`, solo administradores) ([DECLARACION-RESPONSABLE.md](DECLARACION-RESPONSABLE.md)). Los envíos generados validan contra los XSD oficiales. Pruebas en `server/test/verifactu*.test.ts`, contra una AEAT simulada. |
| 77 | Una factura con un dato que la AEAT rechaza (NIF del cliente mal escrito, NIF-IVA sin la estructura de su país, país que la AEAT no admite, moneda distinta del euro, tipo de IVA no vigente en la fecha de la operación, fecha de operación posterior a la expedición, número con caracteres no admitidos) se habría emitido con su registro rechazado; un código de país fuera de esquema, además, habría hecho rechazar el envío entero. | Con VERI*FACTU activo, la emisión deliberada lo comprueba dentro de la transacción y la deshace entera con un mensaje (409): el número no se gasta. También las restricciones de las rectificativas: NIF válido del emisor de la factura rectificada, `R3` solo con cliente con NIF español y `R2` con NIF o NIF-IVA. «UK» y «EL» se leen como `GB` y `GR`. El cobro por webhook no se bloquea nunca; si la AEAT rechaza su registro, se ve en la factura y se subsana. |
| 78 | El **importe total** que la AEAT exige en el registro es base + cuotas, pero el `total_cents` de Skyway resta la retención de IRPF: usarlo habría hecho rechazar o aceptar con errores cada factura con retención (1210, 2005). | `ImporteTotal` y el importe del QR se calculan del desglose (base + cuotas + recargo), sin la retención. |
| 79 | Con la **fecha de expedición en UTC**, una factura emitida de madrugada (de 00:00 a 01:00, o a 02:00 en verano, hora peninsular) habría llevado en el PDF, el registro y el QR la fecha del día anterior y, la madrugada del 1 de enero, un número de la serie del año anterior. | `issued_date` (`aaaa-mm-dd`) se congela al emitir en hora peninsular (`Europe/Madrid`): de ella salen el año de la serie, la `FechaExpedicionFactura` del registro, el PDF y el CSV de Contabilidad. Las facturas anteriores conservan la fecha UTC que imprimieron. |
| 80 | Con **una sola cola para todas las cadenas**, una cadena atascada (un NIF que la AEAT rechaza, el entorno de pruebas caído) habría dejado sin remitir los registros de las demás; y un envío rechazado entero por el defecto de un solo registro se habría reintentado siempre igual. | Cada cadena (NIF del emisor y entorno) tiene su espera de la AEAT, sus reintentos y su contador de fallos (`estadocola.ts`, ajuste `verifactuRemision`). Si la AEAT rechaza el envío entero con un código que causa un registro (4102, 4103, 4106, 4119, 4136, 4137, 4138), la cadena parte el lote por la mitad hasta dar con él (con 1000 registros, unos 20 envíos y no 1000): el registro que lo provoca queda `incorrecto`, con su alerta, y el resto se remite. Un registro en cola con los datos ilegibles queda `incorrecto` sin frenar a los demás. Tras cualquier SOAP Fault se esperan 60 s, porque la AEAT sí ha recibido el envío. Los registros generados durante un corte de su cadena, o sin certificado, nacen con `incidencia` y viajan con `Incidencia=S`; un lote nunca mezcla registros con y sin incidencia. |
| 81 | **Detener la facturación por una anomalía en la cadena** iría contra la AEAT, que indica que por ese motivo nunca debe interrumpirse (FAQ de desarrolladores, 15.2). | Antes de encadenar se recalcula la huella del último registro y se comprueban `PrimerRegistro` y el enlace con el anterior por `seq`; una anomalía se anota en el registro de eventos (`anomalia_cadena`), abre una alerta crítica (`verifactu_cadena`) y la facturación sigue. Solo bloquea (409) el reloj del servidor, si va más de un minuto por detrás del último registro. |
| 82 | Tomar el estado de un **duplicado (3000)** en el primer envío de un registro habría dado por aceptado un registro que la AEAT no tiene: ese 3000 quiere decir que ya tiene otra factura con ese número y fecha. | El estado que tenía la AEAT solo se toma si un envío anterior del registro acabó sin saber si la AEAT lo guardó (corte, respuesta perdida o sin su línea: `envio_incierto`). En el primer envío, o tras un SOAP Fault (la AEAT no guardó nada), queda `incorrecto`, con su alerta. |
| 83 | **Dejar VERI*FACTU con registros de producción** (desactivarlo o volver al entorno de pruebas) habría sacado las facturas de la AEAT sin comunicar la renuncia que exige el art. 17 de la Orden. Además, un `sifMode = 'verifactu'` guardado por el selector antiguo, que no activaba nada, habría dejado VERI*FACTU activo sin pasar por la activación. | En cuanto existe un registro de producción, desactivar (también desde los datos de la empresa) o volver a pruebas da 409; la renuncia no está implementada (punto 5 de «Sigue pendiente»). Una migración única (`migrations:verifactu_modo_v1`) pasa a `desactivado` el modo guardado si no hay registros ni evento de activación. |
| 84 | Un **IVA al 0 %** del régimen general se habría declarado como no sujeto (`N1`), cuando es un tipo más del impuesto (validaciones de la AEAT, 15.1). | Va como `S1` al 0 %. |
| 85 | El **certificado electrónico** de VERI*FACTU se podía cargar o retirar con un token de API: un token filtrado habría podido cambiar con qué identidad se presenta Skyway ante la AEAT o dejar de remitir. | `POST` y `DELETE /api/verifactu/certificado` exigen sesión de navegador de un administrador, como el resto de credenciales persistentes (Cloudflare, Mailway); con un token, 403. Consultar el estado, probar la conexión y enviar la cola siguen abiertos al token. |
| 86 | Unos **datos del productor guardados a medias** (el nombre sin el NIF) habrían hecho fallar con 400 cualquier cambio de modo o de entorno, con un mensaje que no tenía que ver. | La regla de la razón social y el NIF juntos solo se comprueba cuando el cuerpo trae alguno de los dos; mientras tanto, el productor efectivo es el emisor. |
| 87 | El **aviso de incidencia** del art. 16.4 iba ligado a los fallos de conexión de las cadenas: no se abría cuando un envío rechazado entero por un registro dejaba registros con incidencia en cola, y se cerraba con el primer envío correcto aunque quedaran registros con incidencia por remitir. Además, el rechazo del registro culpable tras un corte no reiniciaba el contador de fallos, y los registros siguientes nacían con una incidencia falsa. | La alerta y el aviso del panel van ligados a los registros con `incidencia` en cola: se abren al marcarlos y se cierran cuando no queda ninguno. Cualquier respuesta de la AEAT, también el rechazo del culpable, pone a cero los fallos de la cadena. |
| 88 | Un envío que no llegaba a salir (DNS, conexión rechazada, TLS) quedaba como **envío incierto**, y un duplicado posterior se daba por bueno con el estado de otra factura. Tras perder una respuesta, «Enviar ahora» reenviaba sin respetar la espera de la AEAT desde el envío anterior. | La petición se marca como enviada solo cuando ha salido entera (evento `finish`) por una sesión TLS establecida y lo que falla después no es un rechazo del TLS: una alerta por el certificado de cliente puede llegar después de escribir la petición (TLS 1.3) y el servicio no la ha visto. Entonces sí queda incierta y la cadena respeta la última espera que indicó la AEAT, como tras un SOAP Fault. |
| 89 | Cargar el certificado correcto tras un rechazo de configuración no levantaba la **espera de una hora**, y las **alertas de registros rechazados** no se cerraban nunca, ni tras aceptarse la subsanación. | Cargar un certificado quita las esperas tras un fallo de todas las cadenas (no la de la AEAT). Cuando la AEAT acepta un registro de una factura, las alertas de sus registros anteriores quedan resueltas. |
| 90 | Con la fecha de expedición en hora peninsular, el **vencimiento** del PDF seguía saliendo del instante en UTC: una factura emitida de madrugada vencía un día antes de su plazo. Y las leyendas del QR, a 12 pt, quedaban por debajo de la razón social del emisor (14 pt), que es un dato de la factura. | El vencimiento es la fecha de expedición más los días del plazo, en el calendario. Las leyendas van a 14 pt. |
| 91 | En el **CSV contable**, la fecha de cobro seguía en UTC mientras la de expedición pasaba a hora peninsular: una factura cobrada de madrugada constaba cobrada antes de expedirse. | La fecha de cobro sale en la misma zona que la de expedición (peninsular en las facturas con `issued_date`; UTC en las anteriores). |
| 92 | Tras probar VERI*FACTU sin certificado y **desactivarlo**, la alerta crítica de incidencia volvía cada 10 s por los registros de pruebas en cola, que no se pueden borrar. | Con el modo desactivado (solo posible sin registros de producción), la cola de pruebas se queda quieta y no cuenta como incidencia; al desactivar se cierra el aviso. |
| 93 | En el **entorno de pruebas**, las facturas reales salían con la frase «VERI*FACTU» y un QR al portal de pruebas de la AEAT, aunque sus registros no llegan a la AEAT con efectos fiscales: la frase solo se admite cuando el sistema remite todos los registros (art. 6.5.b del RD 1619/2012 y art. 20.1.b de la Orden). | El QR y las leyendas solo van en las facturas cuyo registro es de producción. En pruebas, el PDF lleva la nota «Registro de facturación de prueba: remitido al entorno de pruebas de la AEAT, sin efectos fiscales». |
| 94 | La **declaración responsable** tomaba la versión de Skyway en cada lectura, pero la fecha de suscripción era fija: tras actualizar, decía que se había suscrito la versión nueva en una fecha anterior a que existiera (art. 13 del RD 1007/2023: una declaración por versión). | La fecha se guarda con la versión para la que se puso (`declaracionVersion`). Con otra versión, la fecha queda pendiente y el panel avisa hasta que se ponga la nueva. |
| 95 | Se bloqueaba la factura a un cliente con **el mismo NIF que el emisor**, que la AEAT admite (autoconsumo) desde la versión 1.0.3 de sus validaciones. | Ya no se bloquea. |
| 96 | Con VERI*FACTU activo se podía **cambiar el NIF del emisor**: Skyway pasaba a gestionar dos obligados (la cadena anterior sigue para las anulaciones) declarando `IndicadorMultiplesOT = N` y, en la declaración responsable, que no admite varios. | Con registros de producción, cambiar el NIF del emisor da 409. En pruebas se puede, para corregir un NIF puesto por error. |
| 97 | Al reenviar un alta tras un envío incierto, un **duplicado con estado «Anulada»** se daba por bueno, aunque es otra factura: la anulación de una factura nunca sale antes de resolverse su alta. Y una **anulación «sin registro previo»** que sí llegó, reenviada tras perderse la respuesta, quedaba rechazada y se repetía sin fin (validaciones, anexo 6.2, ERROR 10). | Un duplicado `Anulada` solo vale para una anulación; para un alta es un rechazo. Una anulación reenviada tras un envío incierto que la AEAT rechaza con 3001 (ya dada de baja) o con 3000 sin `RegistroDuplicado` queda remitida. |

### Sigue pendiente

1. **Cada cubo horario se factura como hora completa**, aunque el servicio solo
   haya corrido unos minutos dentro de esa hora.
2. **El recargo de equivalencia no se calcula.** El régimen es seleccionable y
   `InvoiceLine.reRate` existe, pero nadie lo rellena ni lo suma.
3. **No se puede registrar el régimen de IVA del cliente**, así que la facturación
   recurrente a un cliente intracomunitario o extranjero no sale correcta sin
   editar la factura a mano. El **país** sí se registra ya (`workspaces.billing_country`,
   ISO 3166-1 alfa-2, España por defecto): se congela al emitir y consta en la
   factura y en el PDF, de modo que cuando se implemente el régimen por país el
   dato ya estará.
4. **VERI*FACTU con un certificado real contra el entorno de pruebas de la
   AEAT**: lo que solo se puede comprobar allí (que la AEAT acepte el
   certificado, también uno de sello por su punto de acceso, y sus respuestas
   reales: control de flujo, duplicados y códigos de rechazo) está preparado pero
   sin probar. En la CI no hay llamadas reales: las pruebas usan una AEAT
   simulada. El primer paso en una instalación real es «Probar conexión» y emitir
   en el entorno de pruebas ([VERIFACTU.md §3](VERIFACTU.md)).
5. **Renuncia a VERI*FACTU** (`FechaFinVeriFactu`, art. 17 de la Orden
   HAC/1177/2024): no está implementada. Con registros del entorno de producción,
   VERI*FACTU no se puede desactivar ni volver a pruebas (409), porque dejarlo
   exige comunicar la renuncia en los envíos del año y Skyway no la comunica.

Los puntos 2 y 3 se dejan conscientemente fuera: el negocio factura hoy solo en
régimen general español. Cuando se calcule el recargo de equivalencia, el
registro de VERI*FACTU ya lo recoge (clave 18). El 5 también es una decisión:
una vez en producción, Skyway se queda en producción.

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
| Cambio de Pro a Básico el día 25 de un mes de 31 | dos líneas: 24/31 de Pro + 7/31 de Básico = 79,68 € |
| Tres tramos de plan en el mismo ciclo | tres líneas; la suma nunca supera el mes del plan más caro |
| Plan anual con ida y vuelta al mismo plan en un ciclo | ninguna anualidad extra |
| Paso de un plan anual a otro | solo la anualidad del nuevo |
| Tramo de un plan ya borrado del catálogo | se factura con su tarifa congelada |
| Cambio de plan a otra divisa a mitad de ciclo | el ciclo no se bloquea; alerta al operador |
| Cambio de plan a un minuto del cierre | sin línea de 0,00 € ni céntimo de más |
| Anular la factura de mayo con junio y julio facturados | mayo se refactura una vez; junio y julio no se duplican |
| Periodo sin nada que facturar | el ancla avanza igualmente, sin factura vacía |
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
