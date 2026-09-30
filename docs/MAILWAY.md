# Correo con dominio propio

En **Servicio → Ajustes → Dominios → Configurar correo** hay un asistente
de tres pasos: elegir el dominio raíz guardado, crear las cuentas y descargar
el archivo DNS para Cloudflare. Propone `info`, `no-reply` y `postmaster`,
permite otras direcciones y prepara `webmail.<dominio>` con HTTPS.

La web sigue usando el dominio raíz. El archivo de correo no sustituye los
registros A/CNAME de la web; configurarlos según el editor de dominios si la
web es nueva. Importar DNS tampoco borra MX/SPF anteriores: el asistente avisa
cuando encuentra destinos de correo distintos.

## Conexión inicial del administrador

Actualizar Skyway y Mailway a las versiones con esta integración. En el `.env`
del **servidor Skyway** (no en las variables de la web del cliente):

```dotenv
MAILWAY_URL=https://panel.tuproveedor.com
MAILWAY_INTEGRATION_TOKEN=<secreto de 32 o más caracteres>
MAILWAY_INSTANCE_ID=skyway-produccion
```

Generar el secreto con `openssl rand -hex 32`. Definir el mismo en
`MAILWAY_SKYWAY_TOKEN` de las variables del **panel Mailway**. Allí también
configurar `MAILWAY_SKYWAY_PLAN_ID` (por defecto `plan_basico`),
`MAILWAY_MAIL_HOSTNAME`, `MAILWAY_PUBLIC_IP` y el backend de Roundcube.
La identidad de instancia debe permanecer estable.

El `docker-compose.yml` pasa las variables al proceso Skyway y conecta el
proveedor HTTP de Traefik a `/api/mailway/traefik`. Tras actualizarlo:

```bash
docker compose up -d --build skyway traefik
```

También hay que redesplegar Mailway para aplicar sus variables. Se admite una
URL HTTP interna en `skyway-edge`; por redes públicas usar HTTPS. No introducir
el secreto en el navegador, el dominio del cliente ni la URL del proveedor HTTP.

Si Skyway se instala sin el Compose del repositorio, añadir al proxy existente:

```text
--providers.http.endpoint=http://skyway:4000/api/mailway/traefik
--providers.http.pollInterval=30s
--providers.http.pollTimeout=10s
--providers.http.headers.X-Skyway-Mailway-Token=<secreto compartido>
```

Ajustar el hostname interno `skyway` a la instalación. Sustituir cualquier
proveedor HTTP anterior; mantener el proveedor Docker y el resolutor `le`.
Traefik, Skyway y Roundcube deben poder comunicarse por su red privada.
No se requiere una API key de Cloudflare: el cliente importa el archivo DNS.

## Qué se comprueba

Solo el administrador y el propietario del workspace pueden preparar correo;
no se aceptan dominios que no estén guardados en el servicio. Un dominio ya
asignado a otro cliente en Mailway no se reasigna automáticamente.

El asistente espera la conexión autenticada del proxy antes de crear las
cuentas. Una vez importado el DNS, **Comprobar conexión** revisa DNS y HTTPS.
La emisión del certificado puede requerir esperar y comprobar de nuevo. El
inicio de sesión IMAP y el envío/recepción deben probarse con un buzón real.

Las contraseñas se eligen o generan en el navegador. Hay que guardarlas antes
del alta; no se persisten en Skyway. Un reintento conserva las cuentas ya
creadas y sus contraseñas. Los límites de plan siguen aplicándose en Mailway.

Guía completa del servidor de correo:
[integración Mailway–Skyway](https://github.com/NkrowOne/Mailway/blob/codex/skyway-mail-onboarding/docs/INTEGRACION-SKYWAY.md).
