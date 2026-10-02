# Manifiesto `skyway.json`

Una web puede declarar en su repositorio qué necesita para funcionar en Skyway
—base de datos, correo, secretos, su propia URL— y con qué nombres de variable
lo espera. Con eso, al crear el servicio desde el repositorio, Skyway enseña un
**plan** y lo aplica con un solo botón, sin copiar variables a mano.

El manifiesto es **opcional**. Sin él, Skyway hace lo mismo con lo que detecta
en el repositorio (`needs.ts`): las librerías de base de datos y de correo, el
`schema.prisma` y los nombres del `.env.example`. El manifiesto solo sirve para
decirlo de forma explícita y con los nombres exactos.

## Dónde va

En la raíz del repositorio, con el nombre `skyway.json`. En un monorepo, el del
directorio raíz del servicio (`rootDir`) manda sobre el de la raíz del
repositorio, igual que el `.env.example`.

## Formato (versión 1)

```json
{
  "version": 1,
  "integrations": {
    "mail": { "mode": "smtp", "mailbox": "no-reply" },
    "postgres": {},
    "redis": {}
  },
  "env": {
    "DATABASE_URL": { "from": "postgres.url" },
    "CACHE_URL": { "from": "redis.url" },
    "SMTP_SERVER": { "from": "mail.host" },
    "SMTP_PASSWORD": { "from": "mail.password" },
    "MAIL_FROM_ADDRESS": { "from": "mail.from" },
    "SESSION_SECRET": { "generate": { "bytes": 32 } },
    "APP_URL": { "from": "self.public_url" },
    "APP_NAME": { "value": "Mi tienda" }
  }
}
```

| Campo | Qué es |
| --- | --- |
| `version` | Obligatorio. Siempre `1`. |
| `integrations.postgres`, `integrations.redis` | La web necesita esa base de datos. Sin variables que la nombren, se escribe la de siempre (`DATABASE_URL`, `REDIS_URL`). |
| `integrations.mail.mode` | `smtp` (por defecto) o `api` (la API de envío de Mailway). Si se omite y alguna variable pide `mail.api_*`, se usa la API. |
| `integrations.mail.mailbox` | Buzón remitente, solo la parte anterior a la arroba (`no-reply` por defecto). Mismas reglas que Mailway: minúsculas, números, puntos, guiones y guiones bajos, sin `+`. |
| `env.<NOMBRE>` | Una variable del servicio, con exactamente uno de estos tres campos: `from`, `generate` o `value`. |

### Orígenes de `from`

| Origen | Valor |
| --- | --- |
| `postgres.url`, `redis.url` | Referencia a la base del proyecto: `${{PostgreSQL.DATABASE_URL}}`. Si el proyecto no la tiene, se crea. |
| `self.public_url` | Referencia a la URL pública del propio servicio (`${{<servicio>.PUBLIC_URL}}`). Hasta que el servicio tenga dominio, queda pendiente. |
| `mail.host`, `mail.port` | Servidor de envío autenticado de Mailway y su puerto (587, STARTTLS). |
| `mail.secure`, `mail.starttls`, `mail.encryption` | El cifrado con la convención de cada librería: `false` (nodemailer), `true` (Django) o `tls` (Laravel). |
| `mail.user`, `mail.from` | Dirección del buzón remitente. |
| `mail.password` | Contraseña de aplicación propia del servicio (la del buzón no cambia). |
| `mail.url` | URL SMTP completa con credenciales (`smtp://usuario:contraseña@servidor:587`), para `EMAIL_SERVER` de NextAuth o `MAILER_DSN` de Symfony. |
| `mail.api_url`, `mail.api_key` | URL pública de Mailway y una clave de la API de envío con el buzón como remitente (modo `api`). |

`generate` crea un secreto aleatorio de `bytes` bytes (16 a 64, 32 por
defecto) en hexadecimal. `value` es un texto literal **no secreto** (como mucho
1000 caracteres), sin referencias `${{…}}` ni caracteres de control.

### Lo que no admite

- Comandos, rutas, imágenes ni nada que se ejecute: el esquema es estricto y
  cualquier campo desconocido invalida el manifiesto.
- `PORT` y las variables `SKYWAY_*`: las gestiona Skyway.
- Referencias `${{Servicio.VAR}}` en `value`: servirían para leer las
  variables de otro servicio del proyecto sin aprobación. Para eso está `from`.
- Más de 64 KB o más de 100 variables.

Un manifiesto no válido **no aplica nada** (tampoco la detección): el plan
enseña el motivo («skyway.json no es válido: env.PORT: PORT y las variables
SKYWAY_* las gestiona Skyway») y el despliegue lo repite en su registro.

## El plan

Al elegir el repositorio en «Nuevo servicio → Repositorio de GitHub», Skyway lee
el manifiesto por la API de GitHub (con la credencial que va a clonar) y
construye el plan **sin efectos**:

- **Bases de datos**: la del proyecto con ese motor, si la hay, o una nueva.
  Solo se buscan entre los servicios del **mismo proyecto**.
- **Correo**: el buzón remitente en el dominio del cliente de correo del
  proyecto (el que casa con el dominio del servicio o, si no, el primero) y su
  credencial. Solo si el módulo «Correo» está activo, el correo está activado
  en el proyecto y la **propiedad del dominio está comprobada**; si no, el plan
  lo explica y lo deja pendiente.
- **Secretos generados, la URL propia y los valores literales**.
- Los **nombres de variable** de cada cosa y su estado: *Se aplicará*,
  *Aplicada*, *Puesta a mano* (no se toca) o *Pendiente* (con el motivo).

«Crear, aplicar el plan y desplegar» crea el servicio, vuelve a leer el
manifiesto, aplica el plan y lanza el primer despliegue con todo puesto. Cada
recurso se puede desmarcar antes. La aprobación vale para el plan que se ha
enseñado (ver *La aprobación va ligada a lo revisado*): si al crear el servicio
el repositorio pide otra cosa, lo inofensivo se aplica, lo que requiere
aprobación queda pendiente y se avisa.

### Quién aprueba qué

| Qué | Quién lo aplica |
| --- | --- |
| Secretos generados, URL propia, valores literales, variables vacías | Cualquiera con acceso al proyecto, sin preguntar: no dan acceso a nada nuevo. |
| Crear o conectar una base de datos | Cualquiera con acceso al proyecto, con la misma regla que crearla a mano en «Nuevo servicio» o escribir su referencia en Variables: módulo «Bases de datos» y cuota de servicios. |
| Crear un buzón o una credencial de correo | Quien **gestiona el proyecto** (administrador o propietario de la cuenta), como «Conectar a un servicio». Si lo aplica un miembro, queda como *Cambios pendientes de aprobar*. |

Lo que requiere aprobación nunca se aplica solo en un despliegue (lo dispara
un push, no una persona): queda pendiente hasta que alguien con permiso lo
apruebe. Además se respetan los módulos de la cuenta («Bases de datos»,
«Correo»), la cuota de servicios y la suspensión de la cuenta.

### La aprobación va ligada a lo revisado

El plan lleva una **huella** (`fingerprint`) de lo que requiere aprobación: qué
recursos (crear o reutilizar, cuál, en qué modo) y qué variables con qué
origen. Aprobar envía la huella del plan que se ha visto (`expect`):

- Sin huella, lo que requiere aprobación queda pendiente; lo inofensivo se
  aplica.
- Si el plan ha cambiado desde que se vio (un push con otro manifiesto entre
  verlo y pulsar el botón), «Aprobar y aplicar» responde **409** con el plan
  nuevo y no aplica nada; el panel lo vuelve a enseñar antes de ofrecer el
  botón otra vez. En el alta, el servicio se crea igual, lo inofensivo se
  aplica y lo demás queda pendiente.
- **Reutilizar en SMTP un buzón que ya existe** pide además una confirmación
  expresa (`confirmMailboxAccess`): su contraseña de aplicación da acceso IMAP
  y SMTP a todo el correo del buzón, y la puede leer cualquiera que vea las
  variables del servicio. El plan lo explica en `confirmation`; sin
  confirmarlo, el correo queda pendiente. No hace falta si el servicio ya
  tiene su credencial de Skyway en ese mismo buzón, ni para un buzón que el
  plan crea, ni en modo API (la clave solo envía).

### Reglas que no cambian

- **Nunca se sobrescribe una variable puesta a mano.** Skyway recuerda el hash
  de lo que escribió (`service_managed_env`); si alguien cambia el valor, la
  variable pasa a ser suya y el plan la marca como *Puesta a mano*. Lo que el
  despliegue importó del `.env.example` y nadie ha tocado **no** cuenta como
  puesto a mano (origen `import`): es el valor de ejemplo del repositorio
  (`MAIL_HOST=mailpit` en Laravel), y el plan o el correo lo sustituyen.
- **Un secreto generado no se regenera nunca**: rotarlo cerraría sesiones o
  dejaría ilegibles los datos cifrados con él. El valor de ejemplo importado
  del repositorio no es un secreto generado: `generate` lo sustituye.
- Si la credencial de correo no cabe en ninguna variable libre (todas puestas a
  mano), no se crea.
- Si cabe, pero el servidor, el puerto, el usuario o la URL de la API están
  puestos a mano con otro valor, tampoco: la web quedaría conectada a medias,
  con la credencial de Mailway y el servidor de otro proveedor (que la
  recibiría). El plan deja el correo bloqueado con el nombre de esas variables.

## En cada despliegue

El despliegue vuelve a leer el manifiesto del commit que despliega, también
cuando reutiliza la imagen de ese mismo commit sin clonar (entonces aplica el
que guardó al clonarlo). Si eso define una variable que entra en la
compilación (`NEXT_PUBLIC_*`, `VITE_*`…), no reutiliza la imagen y compila:

- Lo **inofensivo nuevo** (un secreto, un valor literal, la URL propia cuando ya
  hay dominio) se aplica sin preguntar y entra ya en ese despliegue. El
  registro dice qué variables se han definido, nunca sus valores.
- Lo **privilegiado nuevo** (otra base, el correo) no se aplica: el servicio
  muestra «Cambios pendientes de aprobar» (en su tarjeta y en Variables →
  Integraciones), el registro lo avisa y el despliegue continúa con lo ya
  aprobado. Se aprueba con «Aprobar y aplicar» (las bases, cualquiera con
  acceso al proyecto; el correo, quien lo gestiona).

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/projects/:id/github/needs` | Además de la detección, `plan`: el plan sin efectos para el repositorio (`repo`, `branch`, `rootDir?`, `source?`, `name?`). |
| POST | `/api/projects/:projectId/services` | Con `type: 'git'` y `plan: { skip?: [...], expect?, confirmMailboxAccess? }`, aplica el plan antes del primer despliegue. `skip` omite recursos: `postgres`, `redis`, `mysql`, `mongo`, `minio`, `mail` o `empty`. `expect` es la huella del plan de `github/needs`; sin ella, o si no coincide, lo que requiere aprobación queda pendiente (con un aviso en `errors` si no coincide). La respuesta añade `plan: { result, plan, error }`. |
| GET | `/api/services/:id/integrations` | `{ plan, pending }` del servicio contra su estado actual. `plan.fingerprint` es la huella; cada recurso trae `canApprove` (si quien consulta puede aprobarlo) y `confirmation` (lo que hay que confirmar, o null). |
| POST | `/api/services/:id/integrations/apply` | `{ skip?, expect?, confirmMailboxAccess?, redeploy? }` → `{ result, plan, needsRedeploy, deploymentId }`. `result` = `{ applied, pending, kept, blocked, created, errors }`, solo nombres. Sin `expect`, lo que requiere aprobación queda pendiente; si `expect` no es la huella actual, **409** `{ error, plan }` sin aplicar nada. Auditado como `service_integrations_applied`. |

Detalle de la detección, de los nombres por alias y de la conexión con el
correo en [FUNCIONALIDAD.md](FUNCIONALIDAD.md) §5.5 y §5.7.
