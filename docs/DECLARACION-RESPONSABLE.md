# Declaración responsable del sistema informático de facturación

> Art. 13 del Reglamento aprobado por el Real Decreto 1007/2023 y art. 15 de la
> Orden HAC/1177/2024. La suscribe el **productor** del sistema (quien lo
> desarrolla) y tiene que estar **disponible de manera legible e individualizada
> dentro del propio sistema**, accesible de forma rápida, fácil e intuitiva, para
> cada versión (art. 15.3). Skyway la enseña rellena en **Contabilidad →
> VERI*FACTU → Declaración responsable** (`GET /api/verifactu`, campo
> `declaracion`), con los datos de la instalación. El texto se genera en
> `server/src/verifactu/declaracion.ts`.

## Quién la suscribe

- Si quien instala Skyway lo usa para facturar sus propios servicios y es quien lo
  mantiene, el productor es el propio emisor: es lo que Skyway toma por defecto.
- Si el productor es otra persona o empresa, sus datos se rellenan en
  Contabilidad → VERI*FACTU → «Productor del sistema» (razón social, NIF y
  dirección postal de contacto).
- Lugar y fecha de suscripción también se rellenan allí. El lugar lleva al menos la
  localidad y el país, en ese orden («Madrid, España»), y la fecha, día, mes y año
  (art. 15.1.l).
- Skyway no inventa ningún dato del productor: lo que falta aparece como
  «(pendiente)» y el panel avisa hasta que esté completa.
- Hay que entregarla también al comercializador y al cliente, en papel o en un
  formato electrónico de uso extendido y gratuito (art. 15.3): basta con
  imprimirla o guardarla en PDF desde el panel.

## Contenido (art. 15.1 de la Orden, en este orden)

Empieza con el título **«DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE
FACTURACIÓN»** y cada dato va precedido del texto que lo describe:

| Letra | Rótulo | Valor en Skyway |
|---|---|---|
| a) | Nombre del sistema informático | Skyway |
| b) | Código identificador del sistema informático | `SK` |
| c) | Identificador completo de la versión del sistema informático | la de la instalación (`config.version`, p. ej. 0.40.0) |
| d) | Componentes, hardware y software, y descripción de lo que hace y de sus principales funcionalidades | Software: aplicación de servidor en Node.js y TypeScript, con SQLite y panel web, instalada en un servidor del usuario (sin hardware). Cuentas, planes, suscripciones y consumo, y su facturación: series por ejercicio; facturas completas, simplificadas y rectificativas; IVA e IRPF; PDF con el QR tributario; registros de alta y anulación encadenados con huella SHA-256; remisión a la AEAT por el servicio web de VERI*FACTU con certificado; cola con control de flujo y reintentos; subsanación; registro de eventos |
| e) | ¿Solo puede funcionar como «VERI*FACTU»? | Sí: remite todos los registros a la AEAT y no permite la modalidad «NO VERI*FACTU» |
| f) | ¿Permite varios obligados tributarios? | No: cada instalación factura para un único obligado tributario |
| g) | Tipos de firma (si no se usa como «VERI*FACTU») | No aplica |
| h) | Nombre y apellidos o razón social del productor | el configurado, o el emisor |
| i) | NIF español del productor | el configurado, o el del emisor |
| j) | Dirección postal completa de contacto del productor | la configurada, o la del emisor |
| k) | Declaración de cumplimiento | texto de abajo |
| l) | Fecha y lugar de suscripción | los configurados |

Texto de la letra k):

> [Productor] hace constar que el sistema informático Skyway, en la versión X.Y.Z,
> cumple con lo dispuesto en el artículo 29.2.j) de la Ley 58/2003, de 17 de
> diciembre, General Tributaria, en el Reglamento que establece los requisitos que
> deben adoptar los sistemas y programas informáticos o electrónicos que soporten
> los procesos de facturación de empresarios y profesionales, y la estandarización
> de formatos de los registros de facturación, aprobado por el Real Decreto
> 1007/2023, de 5 de diciembre, en la Orden HAC/1177/2024, de 17 de octubre, y en
> la sede electrónica de la Agencia Estatal de Administración Tributaria para todo
> aquello que complete las especificaciones de dicha orden.

El art. 15.2 recomienda añadir, como anexo, otras formas de contacto, direcciones
web del productor y una explicación de cómo cumple el sistema las
especificaciones: para lo último sirve [VERIFACTU.md](VERIFACTU.md).

## Al publicar una versión nueva

1. Revisar que los apartados siguen siendo ciertos (sobre todo d y e).
2. Actualizar la fecha de suscripción en el panel: la declaración es por versión.

## Fuente

Orden HAC/1177/2024, art. 15: https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138
