# Declaración responsable del sistema informático de facturación

> Art. 13 del Reglamento aprobado por el Real Decreto 1007/2023 y art. 15 de la
> Orden HAC/1177/2024. La suscribe el **productor** del sistema (quien lo
> desarrolla) y tiene que estar **disponible de manera legible e individualizada
> dentro del propio sistema**, accesible de forma rápida, fácil e intuitiva, para
> cada versión (art. 15.3). Skyway la enseña rellena en **Contabilidad →
> VERI*FACTU → «Productor y declaración responsable»** («Ver o descargar la
> declaración responsable»; en la API, `GET /api/verifactu`, campo
> `declaracion`), con los datos de la instalación, y la ofrece también en texto
> plano para tenerla fuera del sistema (ver «Fuera del sistema»). El texto se
> genera en `server/src/verifactu/declaracion.ts`.

## Quién la suscribe

- Si quien instala Skyway lo usa para facturar sus propios servicios y es quien lo
  mantiene, el productor es el propio emisor: es lo que Skyway toma cuando no hay
  otro productor configurado, con la razón social y el NIF del emisor y su
  dirección, si no se indica otra.
- Si el productor es otra persona o empresa, sus datos se rellenan en
  Contabilidad → VERI*FACTU → «Productor y declaración responsable»: la razón
  social y el NIF **juntos** (uno sin el otro no se guarda: 400) y la dirección
  postal de contacto. Así nunca se mezcla el nombre de uno con el NIF del otro.
  Con un productor configurado, la dirección es la suya y, si falta, queda
  pendiente: la del emisor solo se usa cuando el productor es el propio emisor.
- Lugar y fecha de suscripción también se rellenan allí. El lugar lleva al menos la
  localidad y el país, en ese orden («Madrid, España»), y la fecha se escribe
  completa, con el mes en letra, como en el modelo de la AEAT («17 de mayo de
  2025»).
- Skyway no inventa ningún dato del productor: lo que falta aparece como
  «(pendiente)» y el panel avisa hasta que esté completa.
- Hay que entregarla también al comercializador y al cliente, en papel o en un
  formato electrónico de uso extendido y gratuito (art. 15.3): sirve el fichero de
  texto de abajo.

## Fuera del sistema

La AEAT pide que la declaración pueda consultarse también de forma independiente
del sistema, en un formato de uso extendido y gratuito.
`GET /api/verifactu/declaracion.txt` (solo administradores) la devuelve en texto
plano UTF-8 (`text/plain`), como adjunto `declaracion-responsable-skyway-<versión>.txt`
(la declaración es de una versión concreta, y el nombre la lleva); en
el panel, con el botón «Descargar en texto» de «Ver o descargar la declaración
responsable», que descarga los datos guardados. Lleva el título y cada dato tras
su rótulo (`1.a) Rótulo:` y el valor en la línea siguiente). Si faltan datos,
termina con «Datos pendientes: …».

## Contenido (art. 15.1 de la Orden, en este orden, y anexo)

Empieza con el título **«DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE
FACTURACIÓN»** y cada dato va precedido del texto que lo describe. Los rótulos son
los del modelo de la AEAT («Ejemplos de declaraciones responsables de sistemas
informáticos de facturación», V0.5.1, ejemplo 1: producto solo VERI*FACTU de una
empresa con NIF español), numerados de 1.a a 1.l, más el anexo 2.c:

| Apartado | Rótulo | Valor en Skyway |
|---|---|---|
| 1.a) | Nombre del sistema informático a que se refiere esta declaración responsable | Skyway |
| 1.b) | Código identificador del sistema informático a que se refiere el apartado a) de esta declaración responsable | `SK` |
| 1.c) | Identificador completo de la versión concreta del sistema informático a que se refiere esta declaración responsable | la de la instalación (`config.version`, p. ej. 0.41.0) |
| 1.d) | Componentes, hardware y software, de que consta el sistema informático a que se refiere esta declaración responsable, junto con una breve descripción de lo que hace dicho sistema informático y de sus principales funcionalidades | Se trata únicamente de un software (no incluye hardware): aplicación de servidor en Node.js y TypeScript, con SQLite y panel web, instalada en un servidor del usuario. Cuentas, planes, suscripciones y consumo, y su facturación: series por ejercicio; facturas completas, simplificadas y rectificativas; IVA e IRPF; PDF con el QR tributario; registros de alta y anulación encadenados con huella SHA-256; remisión a la AEAT por el servicio web de VERI*FACTU con certificado; cola con control de flujo y reintentos; subsanación; registro de eventos. Cada instalación factura para un único obligado tributario |
| 1.e) | Indicación de si el sistema informático a que se refiere esta declaración responsable se ha producido de tal manera que, a los efectos de cumplir con el Reglamento, solo pueda funcionar exclusivamente como «VERI*FACTU» | `S - Sí` |
| 1.f) | Indicación de si el sistema informático a que se refiere la declaración responsable permite ser usado por varios obligados tributarios o por un mismo usuario para dar soporte a la facturación de varios obligados tributarios | `N - No` |
| 1.g) | Tipos de firma utilizados para firmar los registros de facturación y de evento en el caso de que el sistema informático a que se refiere esta declaración responsable no sea utilizado como «VERI*FACTU» | el texto del modelo (abajo) |
| 1.h) | Nombre y apellidos o razón social de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable | la del productor configurado, o la del emisor |
| 1.i) | Número de identificación fiscal (NIF) español de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable | el del productor configurado, o el del emisor |
| 1.j) | Dirección postal completa de contacto de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable | la configurada; si no hay y el productor es el emisor, la del emisor |
| 1.k) | Declaración de cumplimiento | texto de abajo |
| 1.l) | Fecha y lugar en que la persona o entidad productora de este sistema informático suscribe esta declaración responsable del mismo | los configurados, con la fecha en letra: «17 de mayo de 2025. Madrid, España.» |
| 2.c) | Anexo. Cómo cumple el sistema informático las especificaciones técnicas y funcionales de la Orden HAC/1177/2024 y de la sede electrónica de la Agencia Estatal de Administración Tributaria | texto de abajo |

Texto del apartado 1.g), el del modelo de la AEAT para un producto que solo
funciona como «VERI*FACTU»:

> Dado que se trata de un producto de facturación que solo puede ser utilizado
> exclusivamente en la modalidad de «VERI*FACTU», no se realiza una firma
> electrónica expresa de los registros de facturación generados, ya que la
> normativa considera que quedan firmados al ser remitidos correctamente a los
> servicios electrónicos de la Agencia Tributaria con la debida autenticación
> mediante el adecuado certificado electrónico cualificado.

Texto del apartado 1.k):

> La persona o entidad productora del sistema informático a que se refiere esta
> declaración responsable hace constar que dicho sistema informático, en la
> versión indicada en ella, cumple con lo dispuesto en el artículo 29.2.j) de la
> Ley 58/2003, de 17 de diciembre, General Tributaria, en el Reglamento que
> establece los requisitos que deben adoptar los sistemas y programas informáticos
> o electrónicos que soporten los procesos de facturación de empresarios y
> profesionales, y la estandarización de formatos de los registros de facturación,
> aprobado por el Real Decreto 1007/2023, de 5 de diciembre, en la Orden
> HAC/1177/2024, de 17 de octubre, y en la sede electrónica de la Agencia Estatal
> de Administración Tributaria para todo aquello que complete las especificaciones
> de dicha orden.

Texto del anexo 2.c):

> La expedición de la factura y la generación de su registro de facturación se
> consolidan en una sola transacción de la base de datos. Los registros y el
> registro de eventos no se pueden modificar ni borrar (lo impiden disparadores de
> la base de datos). Antes de encadenar cada registro se comprueba el
> encadenamiento del anterior y la fecha y hora de generación. La remisión respeta
> el control de flujo de la Agencia Tributaria y reintenta los envíos pendientes al
> menos una vez por hora, con aviso de incidencia mientras quede alguno por
> remitir. El diseño completo está en la documentación del sistema
> (docs/VERIFACTU.md).

El art. 15.2 recomienda añadir, como anexo, otras formas de contacto, direcciones
web del productor y una explicación de cómo cumple el sistema las
especificaciones. Skyway incluye la explicación (anexo 2.c, que remite a
[VERIFACTU.md](VERIFACTU.md)); las otras formas de contacto y las direcciones web
no se añaden.

## Al publicar una versión nueva

1. Revisar que los apartados siguen siendo ciertos (sobre todo 1.d, 1.e y el
   anexo 2.c).
2. Actualizar la fecha de suscripción en el panel: la declaración es por versión.

## Fuentes

- Orden HAC/1177/2024, art. 15: https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138
- AEAT, «Ejemplos de declaraciones responsables de sistemas informáticos de
  facturación» (V0.5.1), ejemplo 1: rótulos y textos de los apartados 1.e, 1.f
  y 1.g.
