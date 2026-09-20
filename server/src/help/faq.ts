import { FaqCategory, FaqEntry } from './types';

/**
 * Preguntas frecuentes del centro de ayuda. Están escritas para el CLIENTE que
 * despliega su aplicación, no para quien administra el servidor: nombran las
 * pestañas y ajustes tal y como se ven en el panel («Ajustes del servicio →
 * Puerto interno», «Variables», «Despliegues»…) y evitan las tripas de Skyway.
 *
 * Las `keywords` llevan sinónimos y los errores que la gente teclea cuando algo
 * falla («502», «no arranca», «se queda cargando»): el buscador puntúa por
 * ellas, así que son la forma de que una queja llegue a la respuesta correcta.
 */

export const FAQ_CATEGORIES: { key: FaqCategory; label: string }[] = [
  { key: 'primeros-pasos', label: 'Primeros pasos' },
  { key: 'despliegues', label: 'Despliegues' },
  { key: 'variables', label: 'Variables' },
  { key: 'dominios', label: 'Dominios y TLS' },
  { key: 'bases-de-datos', label: 'Bases de datos' },
  { key: 'logs-y-errores', label: 'Logs y errores' },
  { key: 'github', label: 'GitHub' },
  { key: 'cuenta-y-facturacion', label: 'Cuenta y facturación' },
  { key: 'seguridad', label: 'Seguridad' },
];

export const FAQ: FaqEntry[] = [
  // ---------- primeros pasos ----------
  {
    id: 'crear-servicio-github',
    category: 'primeros-pasos',
    question: '¿Cómo despliego una aplicación desde un repositorio de GitHub?',
    answer:
      'Entra en tu proyecto y pulsa **Nuevo servicio → Repositorio de GitHub**. Elige la cuenta de GitHub con la que se va a clonar, el repositorio y la rama (puedes pegar la URL o escribir `owner/repo` si no aparece en la lista).\n\n' +
      'Skyway construye la imagen con el `Dockerfile` del repo o, si no hay, detecta el lenguaje con Nixpacks y la construye sola. El primer despliegue arranca al crear el servicio y lo sigues en vivo en la pestaña **Despliegues**.\n\n' +
      'Si tu aplicación escucha en un puerto que no es el 3000, cámbialo en **Ajustes → Puerto interno** (Skyway inyecta la variable `PORT`; lo más cómodo es que tu app la lea).',
    keywords: ['nuevo servicio', 'crear', 'desplegar', 'deploy', 'repositorio', 'repo', 'github', 'empezar', 'primera vez', 'aplicacion', 'app', 'subir'],
  },
  {
    id: 'tipos-de-servicio',
    category: 'primeros-pasos',
    question: '¿Qué tipos de servicio puedo crear en un proyecto?',
    answer:
      'Cuatro, desde **Nuevo servicio**:\n\n' +
      '- **Repositorio de GitHub**: tu código, construido en cada despliegue.\n' +
      '- **Base de datos**: PostgreSQL, Redis, MySQL, MongoDB o MinIO gestionados, con copias de seguridad y consola de consultas.\n' +
      '- **Imagen Docker**: cualquier imagen pública (`nginx`, `ghcr.io/…`). Sin puerto interno funciona como *worker* en segundo plano.\n' +
      '- **Aplicación completa**: pilas listas para usar (Supabase, WordPress, Ghost, n8n, Metabase) que crean varios servicios ya cableados entre sí.\n\n' +
      'Todos los servicios de un proyecto comparten una red privada: se ven entre sí por el nombre del servicio.',
    keywords: ['tipos', 'servicio', 'imagen', 'docker', 'pila', 'stack', 'supabase', 'wordpress', 'n8n', 'ghost', 'metabase', 'worker'],
  },
  {
    id: 'importar-desde-railway',
    category: 'primeros-pasos',
    question: 'Vengo de Railway. ¿Cómo traigo mi proyecto?',
    answer:
      'En la página de proyectos, **Importar de Railway** (lo hace el administrador de la plataforma) pide un token de tu cuenta de Railway, analiza el proyecto y te enseña el plan antes de crear nada: qué servicios se recrean, qué bases de datos pasan a ser gestionadas por Skyway, qué variables se traducen y qué avisos hay. El token no se guarda.\n\n' +
      'Se conservan las variables con sus referencias `${{Servicio.VAR}}`, los dominios y los volúmenes; las variables mágicas de Railway (`RAILWAY_PRIVATE_DOMAIN`, `PORT`…) se traducen a lo que existe aquí, y el `railway.json` del repo se sigue respetando al construir.\n\n' +
      'Los datos de las bases no viajan solos: el último paso es **Copiar datos desde otra base** en cada base de datos nueva, pegando la URL pública de la de Railway. También puedes instalar cualquier **plantilla pública de Railway** dentro de un proyecto pegando su URL en Nuevo servicio.',
    keywords: ['railway', 'importar', 'migrar', 'migracion', 'plantilla', 'template', 'railway.json', 'traer proyecto', 'mover', 'heroku'],
  },
  {
    id: 'rama-y-directorio-raiz',
    category: 'primeros-pasos',
    question: 'Mi repositorio es un monorepo: ¿cómo despliego solo una carpeta?',
    answer:
      'En **Ajustes del servicio** pon el **Directorio raíz** en la carpeta de la aplicación (por ejemplo `apps/api`). El build se ejecuta desde ahí: las rutas de `COPY` del Dockerfile y la detección de Nixpacks son relativas a ese directorio.\n\n' +
      'Si esa app tiene su propio Dockerfile en otra ruta, indícalo en **Dockerfile** (también relativa al directorio raíz). Y para desplegar varias apps del mismo repo, crea un servicio por app, cada uno con su directorio raíz.\n\n' +
      'La **Rama** se cambia en el mismo sitio; ojo con `main` frente a `master`: si la rama no existe el despliegue falla con «La rama no existe».',
    keywords: ['monorepo', 'directorio raiz', 'root', 'carpeta', 'subdirectorio', 'rama', 'branch', 'main', 'master', 'workspace', 'apps'],
  },
  {
    id: 'dockerfile-vs-nixpacks',
    category: 'primeros-pasos',
    question: '¿Necesito un Dockerfile o Skyway construye mi app sola?',
    answer:
      'No hace falta. Si el repositorio tiene `Dockerfile`, se usa. Si no, **Nixpacks** detecta el lenguaje (Node, Python, Go, Ruby, PHP, Rust, Java…) por los ficheros del repo y construye la imagen con un comando de build y de arranque razonables.\n\n' +
      'Puedes forzar uno u otro en **Ajustes → Constructor** (Automático, Dockerfile o Nixpacks). Con Nixpacks también dispones de **Comando de compilación** y de la variable `NIXPACKS_NODE_VERSION` para fijar la versión de Node.\n\n' +
      'Un `Dockerfile` da control total y builds reproducibles: si Nixpacks adivina mal (monorepos con varios lenguajes, por ejemplo), es el camino seguro.',
    keywords: ['dockerfile', 'nixpacks', 'constructor', 'builder', 'build', 'construir', 'detecta', 'lenguaje', 'node', 'python', 'railpack', 'version de node'],
  },
  {
    id: 'comando-de-arranque',
    category: 'primeros-pasos',
    question: '¿Cómo cambio el comando con el que arranca mi aplicación?',
    answer:
      'En **Ajustes del servicio → Comando de arranque**. Vacío, se usa el `CMD` del Dockerfile (o el que infiere Nixpacks). Ejemplos: `npm run start`, `gunicorn app:app`, `node dist/server.js`.\n\n' +
      'El comando tiene que ser **el proceso que se queda vivo**: si lanza la app en segundo plano y termina, el contenedor se para y el despliegue se da por fallido («El proceso terminó por su cuenta, sin error»). Usa `exec` en scripts de arranque, o `wait` al final si de verdad lanzas varias cosas.\n\n' +
      'Los repos que traen `railway.json` con `deploy.startCommand` lo aplican automáticamente.',
    keywords: ['comando', 'arranque', 'start', 'startCommand', 'cmd', 'entrypoint', 'npm start', 'gunicorn', 'codigo 0', 'termina', 'se cierra', 'exit 0'],
  },
  {
    id: 'puerto-interno-y-healthcheck',
    category: 'primeros-pasos',
    question: '¿Qué son el puerto interno y la ruta de healthcheck?',
    answer:
      'El **Puerto interno** (Ajustes del servicio) es el puerto en el que escucha tu proceso **dentro** del contenedor. Traefik entrega ahí las peticiones del dominio, así que si no coincide con el real el dominio responde **502 Bad Gateway** aunque la app esté viva. Skyway pasa ese número en la variable `PORT`: lo más robusto es que tu app haga `listen(process.env.PORT)`.\n\n' +
      'Escucha en `0.0.0.0`, no en `127.0.0.1`/`localhost`: desde fuera del contenedor no se llega a localhost.\n\n' +
      'La **Ruta de healthcheck** (por ejemplo `/health`) es lo que Skyway consulta al desplegar: solo cuando responde 2xx retira la versión anterior. Sin ruta, se espera un periodo de gracia y se comprueba que el proceso siga vivo. Debe responder sin autenticación.',
    keywords: ['puerto', 'port', 'interno', 'healthcheck', 'health', 'salud', '502', 'bad gateway', 'localhost', '0.0.0.0', 'escucha', 'listen', 'no responde', 'validacion'],
  },

  // ---------- despliegues ----------
  {
    id: 'despliegue-falla-donde-mirar',
    category: 'despliegues',
    question: 'Un despliegue ha fallado. ¿Dónde miro y qué hago?',
    answer:
      'Abre el servicio y ve a **Despliegues**: el despliegue fallido lleva una tarjeta de **diagnóstico** con la causa probable y cómo arreglarla, y debajo el log completo del build. Las tres causas más habituales:\n\n' +
      '- **El build falla**: el error real está en las últimas líneas del log (un `npm ERR!`, un `error TS…`, un paquete que no instala). Reprodúcelo en local con `npm ci && npm run build`.\n' +
      '- **La app arranca y muere**: falta una variable (`DATABASE_URL`…), no conecta con la base de datos o el puerto interno no es el correcto. Mira la pestaña **Logs** (Aplicación).\n' +
      '- **No pasa la validación de salud**: la ruta de healthcheck no responde 2xx o el puerto interno está mal. La versión anterior sigue sirviendo mientras tanto.\n\n' +
      'También puedes preguntar aquí «mi despliegue falla» con el servicio seleccionado: el asistente revisa el último despliegue y los logs por ti.',
    keywords: ['despliegue', 'deploy', 'falla', 'fallo', 'fallido', 'error', 'rojo', 'build', 'no despliega', 'diagnostico', 'que hago', 'donde miro', 'log de build'],
  },
  {
    id: 'redesplegar-tras-cambios',
    category: 'despliegues',
    question: '¿Cómo vuelvo a desplegar sin hacer un commit nuevo?',
    answer:
      'En la cabecera del servicio pulsa **Desplegar**. Si el commit y la configuración de build no han cambiado, Skyway **reutiliza la imagen** y solo recrea el contenedor (tarda segundos): es lo que hace falta tras cambiar variables, puerto o comando de arranque.\n\n' +
      '**Reconstruir** fuerza un build desde cero sin reutilizar nada: úsalo si sospechas de una dependencia cacheada o si tu Dockerfile lee algo externo.\n\n' +
      'Tras guardar un ajuste que requiere recrear el contenedor, el panel te lo avisa con el botón **Desplegar ahora**.',
    keywords: ['redesplegar', 'redeploy', 'desplegar', 'reconstruir', 'rebuild', 'forzar', 'cache', 'imagen', 'volver a desplegar', 'aplicar cambios', 'desplegar ahora'],
  },
  {
    id: 'auto-deploy',
    category: 'despliegues',
    question: '¿Se despliega solo cuando hago push?',
    answer:
      'Sí, si **Auto-deploy** está activado en Ajustes del servicio (lo está por defecto). Skyway se entera de tres formas y todas respetan el mismo interruptor:\n\n' +
      '- Con la **GitHub App** conectada, el push llega al instante por webhook, sin configurar nada.\n' +
      '- Sin App, el **sondeo** comprueba la rama cada minuto y despliega si hay un commit nuevo.\n' +
      '- Además puedes crear un **webhook por servicio** en GitHub con la URL y el secreto que verás en Ajustes.\n\n' +
      'Solo dispara la rama configurada; un commit ya construido no se vuelve a desplegar, y si hay un despliegue en marcha no se encola otro encima.',
    keywords: ['auto deploy', 'autodeploy', 'automatico', 'push', 'webhook', 'commit', 'no se despliega', 'no despliega solo', 'sondeo', 'polling', 'github app'],
  },
  {
    id: 'rollback',
    category: 'despliegues',
    question: 'He desplegado algo roto. ¿Cómo vuelvo a la versión anterior?',
    answer:
      'En **Despliegues**, localiza un despliegue anterior correcto y pulsa **Volver a esta versión**. Skyway conserva las imágenes de los últimos despliegues correctos, así que no hay que reconstruir nada: se arranca esa imagen con la configuración que tenía ese commit.\n\n' +
      'Mientras tanto, si el despliegue roto no pasó la validación de salud, la versión anterior **nunca dejó de servir**: Skyway solo retira la vieja cuando la nueva responde.\n\n' +
      'Un despliegue en curso se puede **Cancelar** desde la misma lista.',
    keywords: ['rollback', 'volver', 'version anterior', 'revertir', 'deshacer', 'restaurar version', 'cancelar despliegue', 'roto'],
  },
  {
    id: 'replicas',
    category: 'despliegues',
    question: '¿Cómo ejecuto varias copias de mi servicio?',
    answer:
      'En **Ajustes → Recursos → Réplicas** (de 1 a 10). Traefik reparte el tráfico del dominio entre todas y el panel enseña cuántas están en marcha. Los despliegues sustituyen las réplicas una a una.\n\n' +
      'Requisitos: el servicio no puede tener **volúmenes** (varias copias escribiendo en el mismo disco se pisarían) ni **Puerto público** (solo una puede ocuparlo). Las réplicas consumen CPU y RAM de la cuota de tu cuenta.\n\n' +
      'En la pestaña **Logs** las líneas de las réplicas 2 en adelante llevan el prefijo `[r2]`, `[r3]`…',
    keywords: ['replicas', 'escalar', 'scale', 'copias', 'instancias', 'balanceo', 'alta disponibilidad', 'horizontal'],
  },
  {
    id: 'metricas-y-cuotas',
    category: 'despliegues',
    question: '¿Cuánta CPU y memoria consume mi servicio y cómo cambio sus límites?',
    answer:
      'La pestaña **Métricas** muestra CPU, memoria, red y disco en vivo y el histórico a 24 h / 7 d / 30 d con media y pico. En **Monitor** ves todos tus servicios a la vez.\n\n' +
      'Los límites se ajustan en **Ajustes → Recursos** (CPUs, RAM, Disco) y se aplican **en caliente**, sin redesplegar. Si un proceso supera la RAM asignada, el sistema lo mata (código de salida 137) y Skyway lo diagnostica como falta de memoria.\n\n' +
      'La suma de recursos de todos tus servicios está acotada por la **cuota de tu cuenta**; la ves en Cuentas y clientes y, si necesitas más, pide ampliarla al administrador.',
    keywords: ['metricas', 'cpu', 'memoria', 'ram', 'recursos', 'limite', 'cuota', 'consumo', '137', 'oom', 'out of memory', 'lento', 'disco'],
  },
  {
    id: 'servicio-parado',
    category: 'despliegues',
    question: '¿Cómo paro, arranco o reinicio un servicio sin redesplegar?',
    answer:
      'En la cabecera del servicio tienes **Detener**, **Iniciar** y **Reiniciar**. Detener conserva la imagen, las variables y los volúmenes: al iniciar vuelve exactamente como estaba, sin build.\n\n' +
      'Un servicio detenido a mano aparece en gris y no genera alertas de caída. Si necesitas que deje de consumir cuota, detenerlo basta; para liberarla del todo, elimínalo desde Ajustes.\n\n' +
      'Si el servicio está caído sin que nadie lo parara, mira primero **Logs**: casi siempre hay una excepción justo antes del cierre.',
    keywords: ['parar', 'detener', 'stop', 'iniciar', 'start', 'reiniciar', 'restart', 'apagar', 'encender', 'detenido', 'gris'],
  },

  // ---------- variables ----------
  {
    id: 'variables-basico',
    category: 'variables',
    question: '¿Cómo añado variables de entorno a mi servicio?',
    answer:
      'Abre el servicio → pestaña **Variables** → **Añadir variable**, escribe clave y valor y pulsa **Guardar variables**. También puedes pegar un bloque `CLAVE=valor` por línea en el modo de edición en bloque.\n\n' +
      'Las variables llegan al contenedor en el siguiente despliegue: tras guardar aparece **Desplegar ahora**. Skyway añade por su cuenta `PORT` y las `RAILWAY_*` de compatibilidad, sin pisar las tuyas.\n\n' +
      'Las que todos los servicios del proyecto deben compartir (`NODE_ENV`, una clave de API común) van en **Variables compartidas** del proyecto: cada servicio las hereda y puede sobrescribirlas.',
    keywords: ['variables', 'entorno', 'env', 'environment', 'añadir', 'secreto', 'clave', 'config', 'compartidas', 'guardar', '.env'],
  },
  {
    id: 'referencias-entre-servicios',
    category: 'variables',
    question: '¿Cómo uso la URL de mi base de datos en la aplicación sin copiarla a mano?',
    answer:
      'Con una **referencia**: en las variables del servicio escribe `${{Postgres.DATABASE_URL}}` (nombre del servicio de base de datos y variable). Al desplegar se sustituye por el valor real, y si algún día rotas la contraseña solo cambia en un sitio.\n\n' +
      'La pestaña Variables tiene un panel de **Referencias del proyecto** con todas las variables de tus servicios hermanos listas para insertar. Para las compartidas del proyecto usa `${{shared.NOMBRE}}`.\n\n' +
      'Una referencia que apunta a un servicio o variable que no existe **se queda literal** en el entorno (`${{…}}` como texto) y la app fallará al conectar: el asistente lo detecta como «referencia sin resolver».',
    keywords: ['referencia', 'referencias', '${{', 'database_url', 'conectar', 'url interna', 'hermano', 'otro servicio', 'shared', 'compartida', 'sin resolver'],
  },
  {
    id: 'importar-env-repo',
    category: 'variables',
    question: 'Mi repo tiene un .env.example. ¿Puedo importar sus variables?',
    answer:
      'Sí, de dos formas:\n\n' +
      '- **Automática**: en cada despliegue Skyway lee `.env.example`, `.env.sample`, `.env.template`… (y un `.env` si estuviera en el repo) y crea las variables con valor útil que aún no tengas. Las que vienen vacías o con un valor de ejemplo (`changeme`, `<tu-clave>`) quedan **pendientes** y el panel te avisa en la pestaña Variables para que las rellenes. Se desactiva en Ajustes («Importar las variables del .env del repositorio al desplegar»).\n' +
      '- **Manual**: en **Variables → Importar del repositorio** ves una vista previa (qué se importa, qué queda pendiente y qué se ignora y por qué) antes de aplicar.\n\n' +
      'Nunca se importan `PORT` ni las `RAILWAY_*`, ni valores que apuntan a `localhost` (dentro del contenedor no existe: usa el nombre del servicio).',
    keywords: ['importar', '.env', 'env.example', 'ejemplo', 'plantilla', 'repositorio', 'pendientes', 'importar del repositorio', 'automatico', 'faltan variables'],
  },
  {
    id: 'variables-no-aplican',
    category: 'variables',
    question: 'He cambiado una variable y la aplicación sigue igual. ¿Por qué?',
    answer:
      'Las variables se inyectan al **crear el contenedor**, así que un cambio no llega hasta el siguiente despliegue. Pulsa **Desplegar** (o **Desplegar ahora** en el aviso de la pestaña Variables). Como el código no ha cambiado, se reutiliza la imagen y tarda segundos.\n\n' +
      'Si aun así no lo ves: comprueba que guardaste (**Guardar variables**), que el nombre es exactamente el que lee tu código (mayúsculas incluidas) y que no hay una variable con el mismo nombre en el servicio pisando a la compartida del proyecto.\n\n' +
      'Las variables que se usan **durante el build** (por ejemplo `VITE_*` o `NEXT_PUBLIC_*`, que se incrustan al compilar) necesitan **Reconstruir**, no solo redesplegar.',
    keywords: ['variable', 'no aplica', 'no cambia', 'sigue igual', 'no se actualiza', 'redesplegar', 'vite', 'next_public', 'build', 'no funciona'],
  },

  // ---------- dominios ----------
  {
    id: 'anadir-dominio',
    category: 'dominios',
    question: '¿Cómo añado un dominio a mi servicio?',
    answer:
      'En **Ajustes del servicio → Dominios** escribe el nombre (`app.midominio.com`) y guarda. Skyway configura Traefik, pide el certificado TLS a Let\'s Encrypt y redirige HTTP a HTTPS: normalmente en uno o dos minutos está servido.\n\n' +
      'Antes, en tu proveedor de DNS crea un registro **A** del dominio apuntando a la **IP del servidor** (el panel la muestra junto al campo y ofrece **comprobar el DNS** al momento). Para `www` y otros subdominios puedes usar un **CNAME** al dominio principal.\n\n' +
      'El dominio necesita que el servicio tenga **Puerto interno**: un worker sin puerto no puede tener dominio.',
    keywords: ['dominio', 'domain', 'dns', 'registro a', 'cname', 'https', 'ssl', 'tls', 'certificado', 'subdominio', 'traefik', 'lets encrypt', 'apuntar', 'ip'],
  },
  {
    id: 'dominio-502',
    category: 'dominios',
    question: 'Mi dominio da 502 Bad Gateway o 404. ¿Qué pasa?',
    answer:
      '**502/504**: Traefik llega al contenedor pero nadie responde en el puerto esperado. Casi siempre es que **Puerto interno** (Ajustes) no coincide con el puerto en que escucha tu app, o que la app escucha en `localhost` en vez de `0.0.0.0`. Comprueba en **Logs** en qué puerto arranca y ajusta uno u otro; lo ideal es que la app lea la variable `PORT`.\n\n' +
      '**404 de Traefik**: el dominio no está asignado a ningún servicio en marcha. Revisa que está escrito igual en Ajustes → Dominios, que el servicio se ha desplegado después de añadirlo y que tiene puerto interno.\n\n' +
      '**503**: el servicio está detenido o reiniciándose. Mira su estado y los Logs.',
    keywords: ['502', '503', '504', 'bad gateway', 'gateway timeout', '404', 'not found', 'dominio no funciona', 'no carga', 'no responde', 'se queda cargando', 'caido', 'traefik'],
  },
  {
    id: 'certificado-tls',
    category: 'dominios',
    question: 'El navegador dice que el certificado no es válido o que la conexión no es segura',
    answer:
      'El certificado lo emite Let\'s Encrypt cuando el dominio ya resuelve a la IP del servidor. Si lo acabas de añadir, espera un par de minutos y recarga.\n\n' +
      'Si persiste: comprueba el **DNS** (el registro A tiene que apuntar a la IP del servidor y no estar detrás de un proxy como Cloudflare en modo «nube naranja» mientras se emite el certificado), que el puerto 80 llega al servidor (Let\'s Encrypt valida por HTTP) y que no has superado el límite de emisiones de Let\'s Encrypt por probar muchas veces (5 por semana y dominio).\n\n' +
      'Con Cloudflare puedes dejar el proxy activado **después** de que el certificado se haya emitido, en modo SSL «Full».',
    keywords: ['certificado', 'ssl', 'tls', 'https', 'no es segura', 'inseguro', 'invalido', 'lets encrypt', 'cloudflare', 'expirado', 'NET::ERR_CERT'],
  },
  {
    id: 'url-interna',
    category: 'dominios',
    question: '¿Cómo se conectan entre sí los servicios de un proyecto sin salir a internet?',
    answer:
      'Todos los servicios de un proyecto están en la misma red privada y se resuelven por el **nombre del servicio** (en minúsculas y con guiones, tal como aparece en Ajustes → Dirección interna). Por ejemplo, desde la app llegas a la base de datos como `postgres:5432` o a otra API como `http://api:3000`.\n\n' +
      'No hace falta dominio ni **Puerto público** para hablar entre servicios; el puerto público expone el servicio directamente en la IP del servidor saltándose Traefik y, en bases de datos, las deja abiertas a internet.\n\n' +
      'Para no escribir hosts a mano, usa referencias `${{Servicio.VARIABLE}}` en Variables.',
    keywords: ['interno', 'interna', 'red', 'privada', 'conectar servicios', 'hostname', 'host', 'puerto publico', 'exponer', 'direccion interna', 'nombre del servicio'],
  },

  // ---------- bases de datos ----------
  {
    id: 'crear-base-de-datos',
    category: 'bases-de-datos',
    question: '¿Cómo creo una base de datos y la conecto a mi aplicación?',
    answer:
      '**Nuevo servicio → Base de datos**, elige PostgreSQL, Redis, MySQL, MongoDB o MinIO y la versión. Skyway genera usuario y contraseña, crea el volumen persistente y publica variables como `DATABASE_URL`, `PGHOST`, `REDIS_URL`… en la pestaña **Variables** de la base de datos.\n\n' +
      'En tu aplicación no copies el valor: escribe `${{NombreDeLaBase.DATABASE_URL}}` en sus Variables. La URL usa el nombre interno del servicio, que solo funciona desde dentro del proyecto.\n\n' +
      'Para verla desde tu ordenador tienes la pestaña **Consultas** en el panel; abrir un **Puerto público** la expondría a internet y no es recomendable.',
    keywords: ['base de datos', 'bbdd', 'database', 'postgres', 'postgresql', 'mysql', 'redis', 'mongo', 'mongodb', 'minio', 'crear', 'conectar', 'database_url', 'credenciales', 'contraseña'],
  },
  {
    id: 'consola-de-consultas',
    category: 'bases-de-datos',
    question: '¿Puedo ver las tablas y ejecutar consultas sin instalar nada?',
    answer:
      'Sí: la pestaña **Consultas** de la base de datos tiene un explorador de tablas, colecciones o claves, un editor con snippets e historial y exportación del resultado a CSV o JSON.\n\n' +
      'Por defecto va en **solo lectura**; para ejecutar `UPDATE`, `DELETE` o `DROP` hay que activar explícitamente la escritura en esa consulta. Está disponible en las bases que crea Skyway y en los servicios de imagen que sean un PostgreSQL (como el de la pila de Supabase).\n\n' +
      'Para trabajar con ficheros dentro del contenedor (subir un volcado, bajar un fichero) usa la pestaña **Archivos**.',
    keywords: ['consultas', 'consola', 'sql', 'query', 'tablas', 'explorar', 'psql', 'cliente', 'csv', 'exportar', 'archivos', 'ficheros'],
  },
  {
    id: 'backups-y-restauracion',
    category: 'bases-de-datos',
    question: '¿Cómo hago copias de seguridad de mi base de datos y las restauro?',
    answer:
      'En la pestaña **Backups** de la base de datos (PostgreSQL, MySQL y MongoDB) pulsas **Crear copia ahora** y se genera un volcado comprimido que puedes **Descargar**, **Restaurar** o **Eliminar**.\n\n' +
      'Para automatizarlo, en **Ajustes** de la base activa la copia **diaria o semanal** y elige cuántas conservar (se hacen de madrugada). Skyway avisa con una alerta si una copia programada falla.\n\n' +
      'Restaurar **sobrescribe** los datos actuales con los de la copia: el panel pide confirmación. Si quieres cambiar de versión mayor de PostgreSQL, el camino es copia con la versión vieja → cambiar versión → restaurar.',
    keywords: ['backup', 'backups', 'copia', 'copia de seguridad', 'restaurar', 'restore', 'dump', 'volcado', 'programado', 'diario', 'semanal', 'perder datos', 'version de postgres'],
  },
  {
    id: 'migrar-datos-externos',
    category: 'bases-de-datos',
    question: 'Tengo mis datos en otra base (Railway, otro servidor). ¿Cómo los traigo?',
    answer:
      'Si eres administrador o propietario del workspace, en la base de datos de destino encontrarás **Copiar datos desde otra base**: pegas la URL de conexión de origen (`postgres://…`, `mysql://…`, `mongodb://…`), Skyway comprueba que responde y hace el volcado y la restauración por ti, con el log en vivo.\n\n' +
      'La copia **sobrescribe** el destino, así que hazla antes de apuntar tu aplicación a la base nueva. Redis y MinIO no se copian por esta vía.\n\n' +
      'Si vienes de Railway con todo el proyecto, el **importador de Railway** (en la página de proyectos) recrea servicios, variables y dominios y te deja la copia de datos como último paso.',
    keywords: ['migrar', 'migracion', 'importar datos', 'railway', 'copiar', 'otra base', 'externa', 'mover', 'traer datos', 'volcar'],
  },

  // ---------- logs y errores ----------
  {
    id: 'ver-logs',
    category: 'logs-y-errores',
    question: '¿Dónde veo los logs de mi aplicación y cómo busco en ellos?',
    answer:
      'En la pestaña **Logs** del servicio. La vista **Aplicación** sigue en vivo lo que escribe tu proceso (con todas las réplicas) y carga historial al subir; **Build** enseña el log del despliegue vigente.\n\n' +
      'Tienes **Buscar en los logs…** para filtrar, **Marcas de tiempo** para ver la hora de cada línea y **Descargar** para bajar el log completo. Si se para el contenedor, el visor lo avisa y se reengancha solo al arrancar.\n\n' +
      'Para buscar una cadena en **todos** tus servicios a la vez, usa el buscador de logs del **Monitor**.',
    keywords: ['logs', 'log', 'ver', 'consola', 'salida', 'stdout', 'buscar', 'descargar', 'seguir', 'en vivo', 'historial', 'monitor'],
  },
  {
    id: 'app-no-arranca',
    category: 'logs-y-errores',
    question: 'La aplicación se cierra nada más arrancar o se reinicia en bucle',
    answer:
      'Abre **Logs → Aplicación** y busca la última excepción antes del cierre. Lo más común, por orden:\n\n' +
      '- **Falta una variable** (`X is not defined`, `KeyError`, `Missing required env`): añádela en Variables y redespliega.\n' +
      '- **No conecta con la base de datos** (`ECONNREFUSED`, `getaddrinfo ENOTFOUND`): el host debe ser el nombre del servicio, no `localhost`; usa una referencia `${{Base.DATABASE_URL}}`.\n' +
      '- **Credenciales rechazadas** (`password authentication failed`, `Access denied`): la referencia apunta a otra variable o hay un valor copiado a mano y caducado.\n' +
      '- **Falta memoria** (código 137, `heap out of memory`): sube la RAM en Ajustes → Recursos.\n' +
      '- **Módulo no encontrado** (`Cannot find module`, `ModuleNotFoundError`): la dependencia no está en `package.json`/`requirements.txt`, o falta un paso de build.\n\n' +
      'El asistente hace esta revisión por ti: pregunta «mi servicio no arranca» con el servicio seleccionado.',
    keywords: ['no arranca', 'no funciona', 'se cierra', 'se cae', 'crash', 'reinicia', 'bucle', 'restarting', 'loop', 'caido', 'caida', 'excepcion', 'error', 'falla', 'exit', 'codigo de salida', 'econnrefused', 'not defined', 'cannot find module', 'app', 'aplicacion', 'servicio'],
  },
  {
    id: 'alertas',
    category: 'logs-y-errores',
    question: '¿Cómo me entero de que un servicio se ha caído?',
    answer:
      'Skyway vigila todos los servicios y crea una **alerta** cuando uno se cae, entra en bucle de reinicios, mantiene CPU o RAM al límite, supera su cuota de disco o falla un despliegue o una copia de seguridad. Las ves en la **campana** del panel y en la página **Alertas**, con una explicación de la causa probable.\n\n' +
      'El administrador puede conectar canales externos (Discord, Telegram o un webhook) desde Ajustes → Alertas y notificaciones. Si un servicio hace ruido a sabiendas, silencia sus alertas en Ajustes del servicio.\n\n' +
      'Para compartir el estado con tus usuarios, activa la **Página de estado** pública del proyecto: disponibilidad de 90 días e incidencias sin necesidad de login.',
    keywords: ['alertas', 'alerta', 'notificacion', 'aviso', 'discord', 'telegram', 'caida', 'monitorizar', 'uptime', 'disponibilidad', 'pagina de estado', 'status page', 'campana'],
  },
  {
    id: 'pagina-de-estado',
    category: 'logs-y-errores',
    question: '¿Puedo publicar una página de estado para mis usuarios?',
    answer:
      'Sí. En la cabecera del proyecto pulsa **Página de estado**: obtienes un enlace público (con un token en la URL, sin login) que muestra el estado de cada servicio, la disponibilidad de los últimos 90 días y las incidencias.\n\n' +
      'Puedes publicar un **aviso de mantenimiento** que aparezca arriba, y **rotar el enlace** si se ha compartido de más. Activarla y rotar el token lo hace el administrador del workspace.',
    keywords: ['pagina de estado', 'status', 'estado publico', 'enlace publico', 'mantenimiento', 'incidencias', 'compartir estado'],
  },

  // ---------- github ----------
  {
    id: 'conectar-github-app',
    category: 'github',
    question: '¿Cómo conecto mi cuenta de GitHub para desplegar repositorios privados?',
    answer:
      'La forma recomendada es la **GitHub App**: en el proyecto (o al crear el servicio) pulsa **Conectar con GitHub**, elige tu cuenta u organización y marca qué repositorios puede ver Skyway. No caduca, no guarda contraseñas ni tokens y activa el despliegue automático por webhook.\n\n' +
      'Si en tu cuenta no puedes instalar Apps, conecta un **token personal** (conector) desde el proyecto: un token clásico con permiso `repo` ve todo lo que ves tú. El token se guarda en el servidor y nunca se vuelve a mostrar.\n\n' +
      'Después, en cada servicio eliges en **Ajustes → Cuenta de GitHub para clonar** con cuál se clona.',
    keywords: ['github', 'conectar', 'github app', 'instalar', 'privado', 'repositorio privado', 'token', 'conector', 'permiso', 'autorizar', 'cuenta'],
  },
  {
    id: 'repo-colaborador',
    category: 'github',
    question: 'El repositorio no aparece en la lista (soy colaborador, no dueño)',
    answer:
      'La GitHub App solo ve los repositorios de las cuentas donde está **instalada**. Un repo de otra persona u organización donde tú eres solo colaborador no aparece hasta que su dueño instale la App en esa cuenta (o añada el repo a la instalación existente).\n\n' +
      'Alternativas: pega la URL o escribe `owner/repo` en el selector (se comprueba al momento con la cuenta elegida y te dice si puede clonarlo), o conecta un **token personal clásico** con permiso `repo`, que sí ve los repos donde colaboras.\n\n' +
      'Si el despliegue falla con «No se pudo clonar el repositorio», GitHub responde igual cuando la URL no existe y cuando la credencial no alcanza a ese repo: revisa ambas cosas.',
    keywords: ['colaborador', 'no aparece', 'lista', 'repositorio', 'organizacion', 'no encuentra', 'repository not found', 'clonar', 'acceso', 'permisos', 'seleccionar repo'],
  },
  {
    id: 'token-caducado',
    category: 'github',
    question: 'El despliegue dice «GitHub rechazó la credencial»',
    answer:
      'Skyway envió una credencial y GitHub no la aceptó: el **token personal caducó**, se revocó o se rotó en GitHub. Los tokens clásicos caducan solos si les pusiste fecha.\n\n' +
      'Arreglo: borra el conector del proyecto y vuelve a crearlo con un token nuevo, o —mejor— conecta la **GitHub App** al proyecto y elígela en **Ajustes del servicio → Cuenta de GitHub para clonar**: emite un token nuevo en cada despliegue y no vuelve a pasar.\n\n' +
      'Si usabas la GitHub App y falla, puede que la instalación se desinstalara o se le quitara el repo: revísala en GitHub → Settings → Applications.',
    keywords: ['credencial', 'token', 'caducado', 'expirado', 'rechazo', 'authentication failed', 'bad credentials', 'invalid username', 'no clona', 'clone', 'permission'],
  },

  // ---------- cuenta y facturación ----------
  {
    id: 'usuarios-y-roles',
    category: 'cuenta-y-facturacion',
    question: '¿Cómo doy acceso a un compañero a mis proyectos?',
    answer:
      'Si eres **propietario** de la cuenta, entra en **Cuentas y clientes → tu cuenta → Usuarios** y crea un usuario **miembro** eligiendo a qué proyectos accede. Un miembro puede desplegar, ver logs y editar variables de esos proyectos, pero no crear o borrar proyectos ni tocar la facturación.\n\n' +
      'Los **propietarios** ven y gestionan todos los proyectos de la cuenta, sus usuarios y sus facturas. El número de usuarios está acotado por la cuota del plan.\n\n' +
      'Cada usuario entra con su propio email y contraseña (y, si quiere, con passkey).',
    keywords: ['usuarios', 'usuario', 'roles', 'rol', 'miembro', 'propietario', 'invitar', 'acceso', 'compañero', 'equipo', 'permisos', 'añadir usuario'],
  },
  {
    id: 'tokens-de-api',
    category: 'cuenta-y-facturacion',
    question: '¿Puedo desplegar o consultar el estado desde un script o una integración?',
    answer:
      'Sí. En **Mi perfil → Tokens de API** crea un token (`sky_…`): se muestra **una sola vez**, guárdalo. Se envía como `Authorization: Bearer sky_…` y tiene los mismos permisos que tu usuario.\n\n' +
      'Ejemplos: `POST /api/services/:id/deploy` lanza un despliegue; `GET /api/services/:id` devuelve estado y último despliegue; `GET /api/services/:id/logs/stream` sigue los logs por SSE. La referencia completa está en la documentación del servidor.\n\n' +
      'Puedes ponerle caducidad y revocarlo en cualquier momento desde el mismo sitio.',
    keywords: ['token', 'api', 'script', 'integracion', 'ci', 'automatizar', 'bearer', 'curl', 'agente', 'sky_', 'revocar'],
    links: [{ label: 'Mi perfil', to: '/account' }],
  },
  {
    id: 'facturacion',
    category: 'cuenta-y-facturacion',
    question: '¿Dónde veo mi plan, mi consumo y mis facturas?',
    answer:
      'En **Cuentas y clientes** (si eres propietario) entra en tu cuenta: verás el **plan** contratado con sus usos incluidos, los **medidores de cuota** en vivo (CPU, RAM, disco, proyectos, servicios, usuarios), el consumo del ciclo y la lista de **facturas** con descarga en PDF.\n\n' +
      'Las facturas se emiten por ciclo según el plan y los servicios adicionales contratados; si hay pago con tarjeta activado, encontrarás el enlace de pago en la propia factura. Las cuestiones sobre el plan (ampliar cuota, cambiar de plan, datos fiscales) las resuelve el administrador de la plataforma.',
    keywords: ['factura', 'facturas', 'facturacion', 'plan', 'precio', 'pago', 'pagar', 'tarjeta', 'stripe', 'consumo', 'cuota', 'ampliar', 'iva', 'pdf'],
    links: [{ label: 'Cuentas y clientes', to: '/workspaces' }],
  },
  {
    id: 'cuenta-suspendida',
    category: 'cuenta-y-facturacion',
    question: 'Me dice que el workspace está suspendido y no puedo desplegar',
    answer:
      'La cuenta se suspende cuando hay facturas pendientes más allá del plazo o por decisión del administrador. Mientras esté suspendida **no se pueden crear servicios ni lanzar despliegues**, aunque lo que ya está en marcha sigue funcionando.\n\n' +
      'Revisa en **Cuentas y clientes** si hay una factura vencida y págala (o avisa de la transferencia); la cuenta se reactiva al registrarse el pago. Si no hay deuda, contacta con el administrador de la plataforma.',
    keywords: ['suspendido', 'suspendida', 'bloqueado', 'impago', 'morosidad', 'vencida', 'no puedo desplegar', 'no puedo crear', 'reactivar'],
  },

  // ---------- seguridad ----------
  {
    id: 'passkeys-y-contrasena',
    category: 'seguridad',
    question: '¿Cómo protejo mi cuenta? Passkeys, contraseña y sesiones',
    answer:
      'En **Mi perfil** puedes:\n\n' +
      '- **Añadir una passkey** (huella, Face ID, llave de seguridad o el gestor de contraseñas): entras sin escribir contraseña y es resistente al phishing. Puedes tener varias y borrar las que ya no uses.\n' +
      '- **Cambiar contraseña**: al hacerlo se cierran todas tus demás sesiones abiertas y los tokens de sesión anteriores dejan de valer.\n' +
      '- **Revocar tokens de API** que ya no necesites.\n\n' +
      'Si sospechas que alguien ha entrado, cambia la contraseña (eso expulsa al intruso) y revisa tus tokens.',
    keywords: ['passkey', 'passkeys', 'webauthn', 'huella', 'face id', 'contraseña', 'password', 'cambiar', 'sesion', 'sesiones', 'cerrar sesion', 'seguridad', 'cuenta', 'phishing', '2fa'],
    links: [{ label: 'Mi perfil', to: '/account' }],
  },
  {
    id: 'secretos-seguros',
    category: 'seguridad',
    question: '¿Es seguro guardar contraseñas y claves de API en las Variables?',
    answer:
      'Las variables se guardan en el servidor y solo las ven los usuarios con acceso al proyecto; se inyectan al contenedor en el arranque y no se escriben en los logs de despliegue. Aun así, algunas buenas prácticas:\n\n' +
      '- Usa **referencias** `${{Base.PASSWORD}}` en lugar de copiar valores: un secreto vive en un solo sitio.\n' +
      '- No hagas `console.log(process.env)` ni imprimas la configuración al arrancar: acabaría en la pestaña Logs.\n' +
      '- Los **build args** que declares se guardan tapados en el panel y no se muestran.\n' +
      '- No expongas bases de datos con **Puerto público**: quedan abiertas a internet. Usa la red interna del proyecto.\n\n' +
      'Los secretos de las pilas (Supabase, etc.) los genera Skyway y viven en el servicio ancla de la pila.',
    keywords: ['secreto', 'secretos', 'seguro', 'seguridad', 'contraseña', 'api key', 'clave', 'exponer', 'filtrar', 'logs', 'build args', 'puerto publico'],
  },
];
