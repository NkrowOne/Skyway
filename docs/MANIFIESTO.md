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
recurso se puede desmarcar antes.

### Quién aprueba qué

| Qué | Quién lo aplica |
| --- | --- |
| Secretos generados, URL propia, valores literales, variables vacías | Cualquiera con acceso al proyecto, sin preguntar: no dan acceso a nada nuevo. |
| Crear o conectar una base de datos, crear un buzón, crear una credencial de correo | Quien **gestiona el proyecto** (administrador o propietario de la cuenta). Si lo aplica un miembro, queda como *Cambios pendientes de aprobar*. |

Además se respetan los módulos de la cuenta («Bases de datos», «Correo»), la
cuota de servicios y la suspensión de la cuenta.

### Reglas que no cambian

- **Nunca se sobrescribe una variable puesta a mano.** Skyway recuerda el hash
  de lo que escribió (`service_managed_env`); si alguien cambia el valor, la
  variable pasa a ser suya y el plan la marca como *Puesta a mano*.
- **Un secreto generado no se regenera nunca**: rotarlo cerraría sesiones o
  dejaría ilegibles los datos cifrados con él.
- Si la credencial de correo no cabe en ninguna variable libre (todas puestas a
  mano), no se crea.

## En cada despliegue

El despliegue vuelve a leer el manifiesto del commit que despliega:

- Lo **inofensivo nuevo** (un secreto, un valor literal, la URL propia cuando ya
  hay dominio) se aplica sin preguntar y entra ya en ese despliegue. El
  registro dice qué variables se han definido, nunca sus valores.
- Lo **privilegiado nuevo** (otra base, el correo) no se aplica: el servicio
  muestra «Cambios pendientes de aprobar» (en su tarjeta y en Variables →
  Integraciones), el registro lo avisa y el despliegue continúa con lo ya
  aprobado. Quien gestiona el proyecto lo aprueba con «Aprobar y aplicar».

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/projects/:id/github/needs` | Además de la detección, `plan`: el plan sin efectos para el repositorio (`repo`, `branch`, `rootDir?`, `source?`, `name?`). |
| POST | `/api/projects/:projectId/services` | Con `type: 'git'` y `plan: { skip?: [...] }`, aplica el plan antes del primer despliegue. `skip` omite recursos: `postgres`, `redis`, `mysql`, `mongo`, `minio`, `mail` o `empty`. La respuesta añade `plan: { result, plan, error }`. |
| GET | `/api/services/:id/integrations` | `{ plan, pending }` del servicio contra su estado actual. |
| POST | `/api/services/:id/integrations/apply` | `{ skip?, redeploy? }` → `{ result, plan, needsRedeploy, deploymentId }`. `result` = `{ applied, pending, kept, blocked, created, errors }`, solo nombres. Auditado como `service_integrations_applied`. |

Detalle de la detección, de los nombres por alias y de la conexión con el
correo en [FUNCIONALIDAD.md](FUNCIONALIDAD.md) §5.5 y §5.7.
