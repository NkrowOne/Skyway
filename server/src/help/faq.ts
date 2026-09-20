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
      'Acceda al proyecto y pulse **Nuevo servicio → Repositorio de GitHub**. Seleccione la cuenta de GitHub con la que se va a clonar, el repositorio y la rama (puede pegar la URL o escribir `owner/repo` si no aparece en la lista).\n\n' +
      'Skyway construye la imagen con el `Dockerfile` del repositorio o, si no existe, detecta el lenguaje con Nixpacks y la construye automáticamente. El primer despliegue se inicia al crear el servicio y puede seguirse en tiempo real en la pestaña **Despliegues**.\n\n' +
      'Si la aplicación escucha en un puerto distinto del 3000, modifíquelo en **Ajustes → Puerto interno** (Skyway inyecta la variable `PORT`; se recomienda que la aplicación la lea).',
    keywords: ['nuevo servicio', 'crear', 'desplegar', 'deploy', 'repositorio', 'repo', 'github', 'empezar', 'primera vez', 'aplicacion', 'app', 'subir'],
  },
  {
    id: 'tipos-de-servicio',
    category: 'primeros-pasos',
    question: '¿Qué tipos de servicio puedo crear en un proyecto?',
    answer:
      'Existen cuatro tipos, disponibles desde **Nuevo servicio**:\n\n' +
      '- **Repositorio de GitHub**: su código, construido en cada despliegue.\n' +
      '- **Base de datos**: PostgreSQL, Redis, MySQL, MongoDB o MinIO gestionados, con copias de seguridad y consola de consultas.\n' +
      '- **Imagen Docker**: cualquier imagen pública (`nginx`, `ghcr.io/…`). Sin puerto interno funciona como *worker* en segundo plano.\n' +
      '- **Aplicación completa**: pilas listas para usar (Supabase, WordPress, Ghost, n8n, Metabase) que crean varios servicios ya conectados entre sí.\n\n' +
      'Todos los servicios de un proyecto comparten una red privada y se localizan entre sí por el nombre del servicio.',
    keywords: ['tipos', 'servicio', 'imagen', 'docker', 'pila', 'stack', 'supabase', 'wordpress', 'n8n', 'ghost', 'metabase', 'worker'],
  },
  {
    id: 'importar-desde-railway',
    category: 'primeros-pasos',
    question: '¿Cómo importo un proyecto desde Railway?',
    answer:
      'En la página de proyectos, la opción **Importar de Railway** (disponible para el administrador de la plataforma) solicita un token de la cuenta de Railway, analiza el proyecto y muestra el plan antes de crear nada: qué servicios se recrean, qué bases de datos pasan a ser gestionadas por Skyway, qué variables se traducen y qué avisos existen. El token no se almacena.\n\n' +
      'Se conservan las variables con sus referencias `${{Servicio.VAR}}`, los dominios y los volúmenes; las variables propias de Railway (`RAILWAY_PRIVATE_DOMAIN`, `PORT`…) se traducen a sus equivalentes en Skyway, y el `railway.json` del repositorio se sigue respetando al construir.\n\n' +
      'Los datos de las bases de datos no se transfieren automáticamente: el último paso es **Copiar datos desde otra base** en cada base de datos nueva, indicando la URL pública de la base de Railway. También es posible instalar cualquier **plantilla pública de Railway** en un proyecto pegando su URL en Nuevo servicio.',
    keywords: ['railway', 'importar', 'migrar', 'migracion', 'plantilla', 'template', 'railway.json', 'traer proyecto', 'mover', 'heroku'],
  },
  {
    id: 'rama-y-directorio-raiz',
    category: 'primeros-pasos',
    question: 'Mi repositorio es un monorepo: ¿cómo despliego solo una carpeta?',
    answer:
      'En **Ajustes del servicio**, establezca el **Directorio raíz** en la carpeta de la aplicación (por ejemplo `apps/api`). La compilación se ejecuta desde ese directorio: las rutas de `COPY` del Dockerfile y la detección de Nixpacks son relativas a él.\n\n' +
      'Si la aplicación tiene su propio Dockerfile en otra ruta, indíquelo en **Dockerfile** (también relativa al directorio raíz). Para desplegar varias aplicaciones del mismo repositorio, cree un servicio por aplicación, cada uno con su directorio raíz.\n\n' +
      'La **Rama** se modifica en el mismo apartado. Compruebe la diferencia entre `main` y `master`: si la rama no existe, el despliegue falla con el mensaje «La rama no existe».',
    keywords: ['monorepo', 'directorio raiz', 'root', 'carpeta', 'subdirectorio', 'rama', 'branch', 'main', 'master', 'workspace', 'apps'],
  },
  {
    id: 'dockerfile-vs-nixpacks',
    category: 'primeros-pasos',
    question: '¿Necesito un Dockerfile o Skyway construye mi aplicación automáticamente?',
    answer:
      'No es necesario. Si el repositorio contiene un `Dockerfile`, se utiliza. En caso contrario, **Nixpacks** detecta el lenguaje (Node, Python, Go, Ruby, PHP, Rust, Java…) a partir de los archivos del repositorio y construye la imagen con un comando de compilación y de arranque adecuados.\n\n' +
      'Es posible forzar una u otra opción en **Ajustes → Constructor** (Automático, Dockerfile o Nixpacks). Con Nixpacks también se dispone de **Comando de compilación** y de la variable `NIXPACKS_NODE_VERSION` para fijar la versión de Node.\n\n' +
      'Un `Dockerfile` ofrece control total y compilaciones reproducibles: si la detección de Nixpacks no es correcta (por ejemplo, en monorepos con varios lenguajes), es la opción recomendada.',
    keywords: ['dockerfile', 'nixpacks', 'constructor', 'builder', 'build', 'construir', 'detecta', 'lenguaje', 'node', 'python', 'railpack', 'version de node'],
  },
  {
    id: 'comando-de-arranque',
    category: 'primeros-pasos',
    question: '¿Cómo cambio el comando con el que arranca mi aplicación?',
    answer:
      'En **Ajustes del servicio → Comando de arranque**. Si se deja vacío, se utiliza el `CMD` del Dockerfile (o el que infiere Nixpacks). Ejemplos: `npm run start`, `gunicorn app:app`, `node dist/server.js`.\n\n' +
      'El comando debe ser **el proceso que permanece en ejecución**: si inicia la aplicación en segundo plano y finaliza, el contenedor se detiene y el despliegue se considera fallido («El proceso finalizó por sí mismo, sin error»). Utilice `exec` en los scripts de arranque, o `wait` al final del script si es necesario iniciar varios procesos.\n\n' +
      'Los repositorios que incluyen `railway.json` con `deploy.startCommand` lo aplican automáticamente.',
    keywords: ['comando', 'arranque', 'start', 'startCommand', 'cmd', 'entrypoint', 'npm start', 'gunicorn', 'codigo 0', 'termina', 'se cierra', 'exit 0'],
  },
  {
    id: 'puerto-interno-y-healthcheck',
    category: 'primeros-pasos',
    question: '¿Qué son el puerto interno y la ruta de healthcheck?',
    answer:
      'El **Puerto interno** (Ajustes del servicio) es el puerto en el que escucha el proceso **dentro** del contenedor. Traefik entrega en él las peticiones del dominio, por lo que si no coincide con el puerto real el dominio responde **502 Bad Gateway** aunque la aplicación esté en ejecución. Skyway proporciona ese número en la variable `PORT`: la opción más fiable es que la aplicación ejecute `listen(process.env.PORT)`.\n\n' +
      'La aplicación debe escuchar en `0.0.0.0`, no en `127.0.0.1`/`localhost`: desde fuera del contenedor no es posible acceder a localhost.\n\n' +
      'La **Ruta de healthcheck** (por ejemplo `/health`) es la que Skyway consulta al desplegar: solo cuando responde 2xx se retira la versión anterior. Sin ruta, se espera un periodo de gracia y se comprueba que el proceso siga en ejecución. Debe responder sin autenticación.',
    keywords: ['puerto', 'port', 'interno', 'healthcheck', 'health', 'salud', '502', 'bad gateway', 'localhost', '0.0.0.0', 'escucha', 'listen', 'no responde', 'validacion'],
  },

  // ---------- despliegues ----------
  {
    id: 'despliegue-falla-donde-mirar',
    category: 'despliegues',
    question: 'Un despliegue ha fallado. ¿Dónde consulto el error y qué debo hacer?',
    answer:
      'Abra el servicio y acceda a **Despliegues**: el despliegue fallido incluye una tarjeta de **diagnóstico** con la causa probable y la solución recomendada, y a continuación el registro completo de la compilación. Las tres causas más habituales son:\n\n' +
      '- **La compilación falla**: el error real se encuentra en las últimas líneas del registro (un `npm ERR!`, un `error TS…`, un paquete que no se instala). Reprodúzcalo en local con `npm ci && npm run build`.\n' +
      '- **La aplicación arranca y finaliza**: falta una variable (`DATABASE_URL`…), no conecta con la base de datos o el puerto interno no es el correcto. Consulte la pestaña **Logs** (Aplicación).\n' +
      '- **No supera la validación de salud**: la ruta de healthcheck no responde 2xx o el puerto interno es incorrecto. La versión anterior sigue en servicio mientras tanto.\n\n' +
      'También puede consultar aquí «mi despliegue falla» con el servicio seleccionado: el asistente revisa el último despliegue y el registro.',
    keywords: ['despliegue', 'deploy', 'falla', 'fallo', 'fallido', 'error', 'rojo', 'build', 'no despliega', 'diagnostico', 'que hago', 'donde miro', 'log de build'],
  },
  {
    id: 'redesplegar-tras-cambios',
    category: 'despliegues',
    question: '¿Cómo vuelvo a desplegar sin hacer un commit nuevo?',
    answer:
      'En la cabecera del servicio, pulse **Desplegar**. Si el commit y la configuración de compilación no han cambiado, Skyway **reutiliza la imagen** y solo recrea el contenedor (tarda unos segundos): es lo necesario tras modificar variables, puerto o comando de arranque.\n\n' +
      '**Reconstruir** fuerza una compilación desde cero sin reutilizar nada: utilícelo si sospecha de una dependencia en caché o si el Dockerfile lee algún recurso externo.\n\n' +
      'Tras guardar un ajuste que requiere recrear el contenedor, el panel lo indica con el botón **Desplegar ahora**.',
    keywords: ['redesplegar', 'redeploy', 'desplegar', 'reconstruir', 'rebuild', 'forzar', 'cache', 'imagen', 'volver a desplegar', 'aplicar cambios', 'desplegar ahora'],
  },
  {
    id: 'auto-deploy',
    category: 'despliegues',
    question: '¿Se despliega automáticamente cuando hago push?',
    answer:
      'Sí, si **Auto-deploy** está activado en Ajustes del servicio (lo está por defecto). Skyway detecta los cambios de tres formas, y todas respetan el mismo interruptor:\n\n' +
      '- Con la **GitHub App** conectada, el push se recibe al instante por webhook, sin configuración adicional.\n' +
      '- Sin App, el **sondeo** comprueba la rama cada minuto y despliega si hay un commit nuevo.\n' +
      '- Además, es posible crear un **webhook por servicio** en GitHub con la URL y el secreto que se muestran en Ajustes.\n\n' +
      'Solo se despliega la rama configurada; un commit ya construido no se vuelve a desplegar, y si hay un despliegue en curso no se encola otro.',
    keywords: ['auto deploy', 'autodeploy', 'automatico', 'push', 'webhook', 'commit', 'no se despliega', 'no despliega solo', 'sondeo', 'polling', 'github app'],
  },
  {
    id: 'rollback',
    category: 'despliegues',
    question: 'He desplegado una versión incorrecta. ¿Cómo vuelvo a la versión anterior?',
    answer:
      'En **Despliegues**, localice un despliegue anterior correcto y pulse **Volver a esta versión**. Skyway conserva las imágenes de los últimos despliegues correctos, por lo que no es necesario reconstruir nada: se inicia esa imagen con la configuración que tenía ese commit.\n\n' +
      'Si el despliegue incorrecto no superó la validación de salud, la versión anterior **no ha dejado de servir en ningún momento**: Skyway solo retira la versión anterior cuando la nueva responde.\n\n' +
      'Un despliegue en curso se puede **Cancelar** desde la misma lista.',
    keywords: ['rollback', 'volver', 'version anterior', 'revertir', 'deshacer', 'restaurar version', 'cancelar despliegue', 'roto'],
  },
  {
    id: 'replicas',
    category: 'despliegues',
    question: '¿Cómo ejecuto varias copias de mi servicio?',
    answer:
      'En **Ajustes → Recursos → Réplicas** (de 1 a 10). Traefik reparte el tráfico del dominio entre todas y el panel muestra cuántas están en ejecución. Los despliegues sustituyen las réplicas una a una.\n\n' +
      'Requisitos: el servicio no puede tener **volúmenes** (varias copias escribiendo en el mismo disco se sobrescribirían) ni **Puerto público** (solo una puede ocuparlo). Las réplicas consumen CPU y RAM de la cuota de la cuenta.\n\n' +
      'En la pestaña **Logs**, las líneas de las réplicas 2 en adelante llevan el prefijo `[r2]`, `[r3]`…',
    keywords: ['replicas', 'escalar', 'scale', 'copias', 'instancias', 'balanceo', 'alta disponibilidad', 'horizontal'],
  },
  {
    id: 'metricas-y-cuotas',
    category: 'despliegues',
    question: '¿Cuánta CPU y memoria consume mi servicio y cómo cambio sus límites?',
    answer:
      'La pestaña **Métricas** muestra CPU, memoria, red y disco en tiempo real y el histórico a 24 h / 7 d / 30 d con media y pico. En **Monitor** se muestran todos los servicios a la vez.\n\n' +
      'Los límites se ajustan en **Ajustes → Recursos** (CPUs, RAM, Disco) y se aplican **en caliente**, sin volver a desplegar. Si un proceso supera la RAM asignada, el sistema lo finaliza (código de salida 137) y Skyway lo diagnostica como falta de memoria.\n\n' +
      'La suma de recursos de todos los servicios está limitada por la **cuota de la cuenta**; puede consultarla en Cuentas y clientes y, si necesita ampliarla, solicítelo al administrador.',
    keywords: ['metricas', 'cpu', 'memoria', 'ram', 'recursos', 'limite', 'cuota', 'consumo', '137', 'oom', 'out of memory', 'lento', 'disco'],
  },
  {
    id: 'servicio-parado',
    category: 'despliegues',
    question: '¿Cómo detengo, inicio o reinicio un servicio sin volver a desplegar?',
    answer:
      'En la cabecera del servicio dispone de **Detener**, **Iniciar** y **Reiniciar**. Detener conserva la imagen, las variables y los volúmenes: al iniciar, el servicio vuelve exactamente al estado anterior, sin compilación.\n\n' +
      'Un servicio detenido manualmente aparece en gris y no genera alertas de caída. Si necesita que deje de consumir cuota, es suficiente con detenerlo; para liberarla por completo, elimínelo desde Ajustes.\n\n' +
      'Si el servicio está caído sin que nadie lo haya detenido, consulte primero **Logs**: casi siempre hay una excepción justo antes del cierre.',
    keywords: ['parar', 'detener', 'stop', 'iniciar', 'start', 'reiniciar', 'restart', 'apagar', 'encender', 'detenido', 'gris'],
  },

  // ---------- variables ----------
  {
    id: 'variables-basico',
    category: 'variables',
    question: '¿Cómo añado variables de entorno a mi servicio?',
    answer:
      'Abra el servicio → pestaña **Variables** → **Añadir variable**, introduzca clave y valor y pulse **Guardar variables**. También puede pegar un bloque con una línea `CLAVE=valor` por variable en el modo de edición en bloque.\n\n' +
      'Las variables llegan al contenedor en el siguiente despliegue: tras guardar aparece **Desplegar ahora**. Skyway añade automáticamente `PORT` y las `RAILWAY_*` de compatibilidad, sin sobrescribir las suyas.\n\n' +
      'Las variables que todos los servicios del proyecto deben compartir (`NODE_ENV`, una clave de API común) se definen en **Variables compartidas** del proyecto: cada servicio las hereda y puede sobrescribirlas.',
    keywords: ['variables', 'entorno', 'env', 'environment', 'añadir', 'secreto', 'clave', 'config', 'compartidas', 'guardar', '.env'],
  },
  {
    id: 'referencias-entre-servicios',
    category: 'variables',
    question: '¿Cómo uso la URL de mi base de datos en la aplicación sin copiarla manualmente?',
    answer:
      'Mediante una **referencia**: en las variables del servicio, escriba `${{Postgres.DATABASE_URL}}` (nombre del servicio de base de datos y variable). Al desplegar se sustituye por el valor real, y si en algún momento se rota la contraseña solo es necesario cambiarla en un lugar.\n\n' +
      'La pestaña Variables incluye un panel de **Referencias del proyecto** con todas las variables de los servicios del mismo proyecto listas para insertar. Para las compartidas del proyecto, utilice `${{shared.NOMBRE}}`.\n\n' +
      'Una referencia que apunta a un servicio o variable inexistente **se mantiene literal** en el entorno (`${{…}}` como texto) y la aplicación fallará al conectar: el asistente lo detecta como «referencia sin resolver».',
    keywords: ['referencia', 'referencias', '${{', 'database_url', 'conectar', 'url interna', 'hermano', 'otro servicio', 'shared', 'compartida', 'sin resolver'],
  },
  {
    id: 'importar-env-repo',
    category: 'variables',
    question: 'Mi repositorio tiene un .env.example. ¿Puedo importar sus variables?',
    answer:
      'Sí, de dos formas:\n\n' +
      '- **Automática**: en cada despliegue, Skyway lee `.env.example`, `.env.sample`, `.env.template`… (y un `.env` si está en el repositorio) y crea las variables con valor útil que aún no existan. Las que vienen vacías o con un valor de ejemplo (`changeme`, `<tu-clave>`) quedan **pendientes** y el panel lo indica en la pestaña Variables para que complete su valor. Se desactiva en Ajustes («Importar las variables del .env del repositorio al desplegar»).\n' +
      '- **Manual**: en **Variables → Importar del repositorio** se muestra una vista previa (qué se importa, qué queda pendiente y qué se ignora y por qué) antes de aplicar.\n\n' +
      'Nunca se importan `PORT` ni las `RAILWAY_*`, ni valores que apuntan a `localhost` (no existe dentro del contenedor: utilice el nombre del servicio).',
    keywords: ['importar', '.env', 'env.example', 'ejemplo', 'plantilla', 'repositorio', 'pendientes', 'importar del repositorio', 'automatico', 'faltan variables'],
  },
  {
    id: 'variables-no-aplican',
    category: 'variables',
    question: 'He cambiado una variable y la aplicación sigue igual. ¿Por qué?',
    answer:
      'Las variables se inyectan al **crear el contenedor**, por lo que un cambio no se aplica hasta el siguiente despliegue. Pulse **Desplegar** (o **Desplegar ahora** en el aviso de la pestaña Variables). Como el código no ha cambiado, se reutiliza la imagen y el proceso tarda unos segundos.\n\n' +
      'Si aun así no se aplica: compruebe que ha guardado los cambios (**Guardar variables**), que el nombre es exactamente el que lee el código (mayúsculas incluidas) y que no hay una variable con el mismo nombre en el servicio que sobrescriba la compartida del proyecto.\n\n' +
      'Las variables que se utilizan **durante la compilación** (por ejemplo `VITE_*` o `NEXT_PUBLIC_*`, que se incrustan al compilar) requieren **Reconstruir**, no solo volver a desplegar.',
    keywords: ['variable', 'no aplica', 'no cambia', 'sigue igual', 'no se actualiza', 'redesplegar', 'vite', 'next_public', 'build', 'no funciona'],
  },

  // ---------- dominios ----------
  {
    id: 'anadir-dominio',
    category: 'dominios',
    question: '¿Cómo añado un dominio a mi servicio?',
    answer:
      'En **Ajustes del servicio → Dominios**, escriba el nombre (`app.midominio.com`) y guarde. Skyway configura Traefik, solicita el certificado TLS a Let\'s Encrypt y redirige HTTP a HTTPS: normalmente el dominio está en servicio en uno o dos minutos.\n\n' +
      'Previamente, en el proveedor de DNS, cree un registro **A** del dominio que apunte a la **IP del servidor** (el panel la muestra junto al campo y permite **comprobar el DNS** al momento). Para `www` y otros subdominios puede utilizar un **CNAME** al dominio principal.\n\n' +
      'El dominio requiere que el servicio tenga **Puerto interno**: un worker sin puerto no puede tener dominio.',
    keywords: ['dominio', 'domain', 'dns', 'registro a', 'cname', 'https', 'ssl', 'tls', 'certificado', 'subdominio', 'traefik', 'lets encrypt', 'apuntar', 'ip'],
  },
  {
    id: 'dominio-502',
    category: 'dominios',
    question: 'Mi dominio responde 502 Bad Gateway o 404. ¿Cuál es la causa?',
    answer:
      '**502/504**: Traefik llega al contenedor pero no hay respuesta en el puerto esperado. Casi siempre se debe a que el **Puerto interno** (Ajustes) no coincide con el puerto en el que escucha la aplicación, o a que la aplicación escucha en `localhost` en lugar de `0.0.0.0`. Compruebe en **Logs** en qué puerto arranca y ajuste uno u otro; lo recomendable es que la aplicación lea la variable `PORT`.\n\n' +
      '**404 de Traefik**: el dominio no está asignado a ningún servicio en ejecución. Compruebe que está escrito exactamente igual en Ajustes → Dominios, que el servicio se ha desplegado después de añadirlo y que tiene puerto interno.\n\n' +
      '**503**: el servicio está detenido o reiniciándose. Consulte su estado y el registro.',
    keywords: ['502', '503', '504', 'bad gateway', 'gateway timeout', '404', 'not found', 'dominio no funciona', 'no carga', 'no responde', 'se queda cargando', 'caido', 'traefik'],
  },
  {
    id: 'certificado-tls',
    category: 'dominios',
    question: 'El navegador indica que el certificado no es válido o que la conexión no es segura',
    answer:
      'El certificado lo emite Let\'s Encrypt cuando el dominio ya resuelve a la IP del servidor. Si lo acaba de añadir, espere un par de minutos y recargue la página.\n\n' +
      'Si el problema persiste, compruebe el **DNS** (el registro A debe apuntar a la IP del servidor y no estar detrás de un proxy como Cloudflare en modo «nube naranja» mientras se emite el certificado), que el puerto 80 llega al servidor (Let\'s Encrypt valida por HTTP) y que no se ha superado el límite de emisiones de Let\'s Encrypt por intentos repetidos (5 por semana y dominio).\n\n' +
      'Con Cloudflare, puede activar el proxy **después** de que el certificado se haya emitido, en modo SSL «Full».',
    keywords: ['certificado', 'ssl', 'tls', 'https', 'no es segura', 'inseguro', 'invalido', 'lets encrypt', 'cloudflare', 'expirado', 'NET::ERR_CERT'],
  },
  {
    id: 'url-interna',
    category: 'dominios',
    question: '¿Cómo se conectan entre sí los servicios de un proyecto sin salir a internet?',
    answer:
      'Todos los servicios de un proyecto están en la misma red privada y se resuelven por el **nombre del servicio** (en minúsculas y con guiones, tal como aparece en Ajustes → Dirección interna). Por ejemplo, desde la aplicación se accede a la base de datos como `postgres:5432` o a otra API como `http://api:3000`.\n\n' +
      'No es necesario un dominio ni un **Puerto público** para la comunicación entre servicios; el puerto público expone el servicio directamente en la IP del servidor sin pasar por Traefik y, en bases de datos, las deja accesibles desde internet.\n\n' +
      'Para no escribir los hosts manualmente, utilice referencias `${{Servicio.VARIABLE}}` en Variables.',
    keywords: ['interno', 'interna', 'red', 'privada', 'conectar servicios', 'hostname', 'host', 'puerto publico', 'exponer', 'direccion interna', 'nombre del servicio'],
  },

  // ---------- bases de datos ----------
  {
    id: 'crear-base-de-datos',
    category: 'bases-de-datos',
    question: '¿Cómo creo una base de datos y la conecto a mi aplicación?',
    answer:
      '**Nuevo servicio → Base de datos**: seleccione PostgreSQL, Redis, MySQL, MongoDB o MinIO y la versión. Skyway genera usuario y contraseña, crea el volumen persistente y publica variables como `DATABASE_URL`, `PGHOST`, `REDIS_URL`… en la pestaña **Variables** de la base de datos.\n\n' +
      'En la aplicación no copie el valor: escriba `${{NombreDeLaBase.DATABASE_URL}}` en sus Variables. La URL utiliza el nombre interno del servicio, que solo funciona desde dentro del proyecto.\n\n' +
      'Para consultarla desde su equipo dispone de la pestaña **Consultas** en el panel; abrir un **Puerto público** la expondría a internet y no es recomendable.',
    keywords: ['base de datos', 'bbdd', 'database', 'postgres', 'postgresql', 'mysql', 'redis', 'mongo', 'mongodb', 'minio', 'crear', 'conectar', 'database_url', 'credenciales', 'contraseña'],
  },
  {
    id: 'consola-de-consultas',
    category: 'bases-de-datos',
    question: '¿Puedo ver las tablas y ejecutar consultas sin instalar nada?',
    answer:
      'Sí: la pestaña **Consultas** de la base de datos incluye un explorador de tablas, colecciones o claves, un editor con fragmentos e historial, y exportación del resultado a CSV o JSON.\n\n' +
      'Por defecto funciona en **solo lectura**; para ejecutar `UPDATE`, `DELETE` o `DROP` es necesario activar explícitamente la escritura en esa consulta. Está disponible en las bases de datos que crea Skyway y en los servicios de imagen que sean un PostgreSQL (como el de la pila de Supabase).\n\n' +
      'Para trabajar con archivos dentro del contenedor (subir un volcado, descargar un archivo), utilice la pestaña **Archivos**.',
    keywords: ['consultas', 'consola', 'sql', 'query', 'tablas', 'explorar', 'psql', 'cliente', 'csv', 'exportar', 'archivos', 'ficheros'],
  },
  {
    id: 'backups-y-restauracion',
    category: 'bases-de-datos',
    question: '¿Cómo hago copias de seguridad de mi base de datos y las restauro?',
    answer:
      'En la pestaña **Backups** de la base de datos (PostgreSQL, MySQL y MongoDB), pulse **Crear copia ahora**: se genera un volcado comprimido que puede **Descargar**, **Restaurar** o **Eliminar**.\n\n' +
      'Para automatizarlo, en **Ajustes** de la base de datos active la copia **diaria o semanal** y elija cuántas conservar (se realizan de madrugada). Skyway genera una alerta si una copia programada falla.\n\n' +
      'Restaurar **sobrescribe** los datos actuales con los de la copia: el panel solicita confirmación. Para cambiar de versión mayor de PostgreSQL, el procedimiento es: copia con la versión anterior → cambiar versión → restaurar.',
    keywords: ['backup', 'backups', 'copia', 'copia de seguridad', 'restaurar', 'restore', 'dump', 'volcado', 'programado', 'diario', 'semanal', 'perder datos', 'version de postgres'],
  },
  {
    id: 'migrar-datos-externos',
    category: 'bases-de-datos',
    question: 'Tengo mis datos en otra base (Railway, otro servidor). ¿Cómo los importo?',
    answer:
      'Si es administrador o propietario del workspace, en la base de datos de destino encontrará **Copiar datos desde otra base**: indique la URL de conexión de origen (`postgres://…`, `mysql://…`, `mongodb://…`); Skyway comprueba que responde y realiza el volcado y la restauración, con el registro en tiempo real.\n\n' +
      'La copia **sobrescribe** el destino, por lo que debe realizarse antes de apuntar la aplicación a la base de datos nueva. Redis y MinIO no se copian por esta vía.\n\n' +
      'Si procede de Railway con el proyecto completo, el **importador de Railway** (en la página de proyectos) recrea servicios, variables y dominios y deja la copia de datos como último paso.',
    keywords: ['migrar', 'migracion', 'importar datos', 'railway', 'copiar', 'otra base', 'externa', 'mover', 'traer datos', 'volcar'],
  },

  // ---------- logs y errores ----------
  {
    id: 'ver-logs',
    category: 'logs-y-errores',
    question: '¿Dónde veo los logs de mi aplicación y cómo busco en ellos?',
    answer:
      'En la pestaña **Logs** del servicio. La vista **Aplicación** muestra en tiempo real lo que escribe el proceso (con todas las réplicas) y carga el historial al desplazarse hacia arriba; **Build** muestra el registro del despliegue vigente.\n\n' +
      'Dispone de **Buscar en los logs…** para filtrar, **Marcas de tiempo** para ver la hora de cada línea y **Descargar** para obtener el registro completo. Si el contenedor se detiene, el visor lo indica y se vuelve a conectar automáticamente al arrancar.\n\n' +
      'Para buscar una cadena en **todos** los servicios a la vez, utilice el buscador de logs del **Monitor**.',
    keywords: ['logs', 'log', 'ver', 'consola', 'salida', 'stdout', 'buscar', 'descargar', 'seguir', 'en vivo', 'historial', 'monitor'],
  },
  {
    id: 'app-no-arranca',
    category: 'logs-y-errores',
    question: 'La aplicación se cierra nada más arrancar o se reinicia en bucle',
    answer:
      'Abra **Logs → Aplicación** y localice la última excepción antes del cierre. Las causas más comunes, por orden:\n\n' +
      '- **Falta una variable** (`X is not defined`, `KeyError`, `Missing required env`): añádala en Variables y vuelva a desplegar.\n' +
      '- **No conecta con la base de datos** (`ECONNREFUSED`, `getaddrinfo ENOTFOUND`): el host debe ser el nombre del servicio, no `localhost`; utilice una referencia `${{Base.DATABASE_URL}}`.\n' +
      '- **Credenciales rechazadas** (`password authentication failed`, `Access denied`): la referencia apunta a otra variable o hay un valor copiado manualmente que ha caducado.\n' +
      '- **Falta memoria** (código 137, `heap out of memory`): aumente la RAM en Ajustes → Recursos.\n' +
      '- **Módulo no encontrado** (`Cannot find module`, `ModuleNotFoundError`): la dependencia no está en `package.json`/`requirements.txt`, o falta un paso de compilación.\n\n' +
      'El asistente puede realizar esta revisión: consulte «mi servicio no arranca» con el servicio seleccionado.',
    keywords: ['no arranca', 'no funciona', 'se cierra', 'se cae', 'crash', 'reinicia', 'bucle', 'restarting', 'loop', 'caido', 'caida', 'excepcion', 'error', 'falla', 'exit', 'codigo de salida', 'econnrefused', 'not defined', 'cannot find module', 'app', 'aplicacion', 'servicio'],
  },
  {
    id: 'alertas',
    category: 'logs-y-errores',
    question: '¿Cómo recibo aviso de que un servicio se ha caído?',
    answer:
      'Skyway supervisa todos los servicios y crea una **alerta** cuando uno se cae, entra en bucle de reinicios, mantiene CPU o RAM al límite, supera su cuota de disco o falla un despliegue o una copia de seguridad. Las alertas se muestran en el **panel de notificaciones** y en la página **Alertas**, con una explicación de la causa probable.\n\n' +
      'El administrador puede conectar canales externos (Discord, Telegram o un webhook) desde Ajustes → Alertas y notificaciones. Si un servicio genera alertas de forma esperada, puede silenciarlas en Ajustes del servicio.\n\n' +
      'Para compartir el estado con sus usuarios, active la **Página de estado** pública del proyecto: disponibilidad de 90 días e incidencias, sin necesidad de iniciar sesión.',
    keywords: ['alertas', 'alerta', 'notificacion', 'aviso', 'discord', 'telegram', 'caida', 'monitorizar', 'uptime', 'disponibilidad', 'pagina de estado', 'status page', 'campana'],
  },
  {
    id: 'pagina-de-estado',
    category: 'logs-y-errores',
    question: '¿Puedo publicar una página de estado para mis usuarios?',
    answer:
      'Sí. En la cabecera del proyecto, pulse **Página de estado**: se obtiene un enlace público (con un token en la URL, sin inicio de sesión) que muestra el estado de cada servicio, la disponibilidad de los últimos 90 días y las incidencias.\n\n' +
      'Es posible publicar un **aviso de mantenimiento** en la parte superior y **rotar el enlace** si se ha compartido en exceso. La activación y la rotación del token las realiza el administrador del workspace.',
    keywords: ['pagina de estado', 'status', 'estado publico', 'enlace publico', 'mantenimiento', 'incidencias', 'compartir estado'],
  },

  // ---------- github ----------
  {
    id: 'conectar-github-app',
    category: 'github',
    question: '¿Cómo conecto mi cuenta de GitHub para desplegar repositorios privados?',
    answer:
      'La opción recomendada es la **GitHub App**: en el proyecto (o al crear el servicio), pulse **Conectar con GitHub**, seleccione su cuenta u organización e indique qué repositorios puede ver Skyway. No caduca, no almacena contraseñas ni tokens y activa el despliegue automático por webhook.\n\n' +
      'Si no puede instalar Apps en su cuenta, conecte un **token personal** (conector) desde el proyecto: un token clásico con permiso `repo` ve los mismos repositorios que su usuario. El token se almacena en el servidor y no se vuelve a mostrar.\n\n' +
      'A continuación, en cada servicio, seleccione en **Ajustes → Cuenta de GitHub para clonar** la cuenta con la que se clona.',
    keywords: ['github', 'conectar', 'github app', 'instalar', 'privado', 'repositorio privado', 'token', 'conector', 'permiso', 'autorizar', 'cuenta'],
  },
  {
    id: 'repo-colaborador',
    category: 'github',
    question: 'El repositorio no aparece en la lista (soy colaborador, no propietario)',
    answer:
      'La GitHub App solo ve los repositorios de las cuentas donde está **instalada**. Un repositorio de otra persona u organización en el que solo es colaborador no aparece hasta que su propietario instale la App en esa cuenta (o añada el repositorio a la instalación existente).\n\n' +
      'Alternativas: pegue la URL o escriba `owner/repo` en el selector (se comprueba al momento con la cuenta seleccionada y se indica si es posible clonarlo), o conecte un **token personal clásico** con permiso `repo`, que sí ve los repositorios en los que colabora.\n\n' +
      'Si el despliegue falla con «No se pudo clonar el repositorio», tenga en cuenta que GitHub responde lo mismo cuando la URL no existe y cuando la credencial no tiene acceso a ese repositorio: compruebe ambos aspectos.',
    keywords: ['colaborador', 'no aparece', 'lista', 'repositorio', 'organizacion', 'no encuentra', 'repository not found', 'clonar', 'acceso', 'permisos', 'seleccionar repo'],
  },
  {
    id: 'token-caducado',
    category: 'github',
    question: 'El despliegue indica «GitHub rechazó la credencial»',
    answer:
      'Skyway envió una credencial y GitHub no la aceptó: el **token personal ha caducado**, se ha revocado o se ha rotado en GitHub. Los tokens clásicos caducan automáticamente si se les asignó una fecha.\n\n' +
      'Solución: elimine el conector del proyecto y vuelva a crearlo con un token nuevo o, preferiblemente, conecte la **GitHub App** al proyecto y selecciónela en **Ajustes del servicio → Cuenta de GitHub para clonar**: emite un token nuevo en cada despliegue y el problema no se repite.\n\n' +
      'Si utilizaba la GitHub App y falla, es posible que la instalación se haya desinstalado o que se haya retirado el repositorio: compruébelo en GitHub → Settings → Applications.',
    keywords: ['credencial', 'token', 'caducado', 'expirado', 'rechazo', 'authentication failed', 'bad credentials', 'invalid username', 'no clona', 'clone', 'permission'],
  },

  // ---------- cuenta y facturación ----------
  {
    id: 'usuarios-y-roles',
    category: 'cuenta-y-facturacion',
    question: '¿Cómo doy acceso a un compañero a mis proyectos?',
    answer:
      'Si es **propietario** de la cuenta, acceda a **Cuentas y clientes → su cuenta → Usuarios** y cree un usuario **miembro** indicando a qué proyectos accede. Un miembro puede desplegar, ver el registro y editar variables de esos proyectos, pero no crear ni eliminar proyectos ni modificar la facturación.\n\n' +
      'Los **propietarios** ven y gestionan todos los proyectos de la cuenta, sus usuarios y sus facturas. El número de usuarios está limitado por la cuota del plan.\n\n' +
      'Cada usuario inicia sesión con su propio correo electrónico y contraseña (y, opcionalmente, con passkey).',
    keywords: ['usuarios', 'usuario', 'roles', 'rol', 'miembro', 'propietario', 'invitar', 'acceso', 'compañero', 'equipo', 'permisos', 'añadir usuario'],
  },
  {
    id: 'tokens-de-api',
    category: 'cuenta-y-facturacion',
    question: '¿Puedo desplegar o consultar el estado desde un script o una integración?',
    answer:
      'Sí. En **Mi perfil → Tokens de API**, cree un token (`sky_…`): se muestra **una sola vez**, por lo que debe guardarlo. Se envía como `Authorization: Bearer sky_…` y tiene los mismos permisos que su usuario.\n\n' +
      'Ejemplos: `POST /api/services/:id/deploy` inicia un despliegue; `GET /api/services/:id` devuelve el estado y el último despliegue; `GET /api/services/:id/logs/stream` sigue el registro por SSE. La referencia completa está en la documentación del servidor.\n\n' +
      'Puede asignarle una fecha de caducidad y revocarlo en cualquier momento desde el mismo apartado.',
    keywords: ['token', 'api', 'script', 'integracion', 'ci', 'automatizar', 'bearer', 'curl', 'agente', 'sky_', 'revocar'],
    links: [{ label: 'Mi perfil', to: '/account' }],
  },
  {
    id: 'facturacion',
    category: 'cuenta-y-facturacion',
    question: '¿Dónde veo mi plan, mi consumo y mis facturas?',
    answer:
      'En **Cuentas y clientes** (si es propietario), acceda a su cuenta: se muestra el **plan** contratado con sus usos incluidos, los **medidores de cuota** en tiempo real (CPU, RAM, disco, proyectos, servicios, usuarios), el consumo del ciclo y la lista de **facturas** con descarga en PDF.\n\n' +
      'Las facturas se emiten por ciclo según el plan y los servicios adicionales contratados; si el pago con tarjeta está activado, encontrará el enlace de pago en la propia factura. Las cuestiones sobre el plan (ampliar cuota, cambiar de plan, datos fiscales) las gestiona el administrador de la plataforma.',
    keywords: ['factura', 'facturas', 'facturacion', 'plan', 'precio', 'pago', 'pagar', 'tarjeta', 'stripe', 'consumo', 'cuota', 'ampliar', 'iva', 'pdf'],
    links: [{ label: 'Cuentas y clientes', to: '/workspaces' }],
  },
  {
    id: 'cuenta-suspendida',
    category: 'cuenta-y-facturacion',
    question: 'El workspace está suspendido y no puedo desplegar',
    answer:
      'La cuenta se suspende cuando hay facturas pendientes fuera de plazo o por decisión del administrador. Mientras esté suspendida, **no es posible crear servicios ni iniciar despliegues**, aunque los servicios en ejecución siguen funcionando.\n\n' +
      'Compruebe en **Cuentas y clientes** si hay una factura vencida y realice el pago (o notifique la transferencia); la cuenta se reactiva al registrarse el pago. Si no hay deuda pendiente, contacte con el administrador de la plataforma.',
    keywords: ['suspendido', 'suspendida', 'bloqueado', 'impago', 'morosidad', 'vencida', 'no puedo desplegar', 'no puedo crear', 'reactivar'],
  },

  // ---------- seguridad ----------
  {
    id: 'passkeys-y-contrasena',
    category: 'seguridad',
    question: '¿Cómo protejo mi cuenta? Passkeys, contraseña y sesiones',
    answer:
      'En **Mi perfil** puede:\n\n' +
      '- **Añadir una passkey** (huella, Face ID, llave de seguridad o el gestor de contraseñas): permite iniciar sesión sin escribir la contraseña y es resistente al phishing. Puede registrar varias y eliminar las que ya no utilice.\n' +
      '- **Cambiar la contraseña**: al hacerlo se cierran todas las demás sesiones abiertas y los tokens de sesión anteriores dejan de ser válidos.\n' +
      '- **Revocar los tokens de API** que ya no necesite.\n\n' +
      'Si sospecha que alguien ha accedido a su cuenta, cambie la contraseña (esto cierra las sesiones ajenas) y revise sus tokens.',
    keywords: ['passkey', 'passkeys', 'webauthn', 'huella', 'face id', 'contraseña', 'password', 'cambiar', 'sesion', 'sesiones', 'cerrar sesion', 'seguridad', 'cuenta', 'phishing', '2fa'],
    links: [{ label: 'Mi perfil', to: '/account' }],
  },
  {
    id: 'secretos-seguros',
    category: 'seguridad',
    question: '¿Es seguro guardar contraseñas y claves de API en las Variables?',
    answer:
      'Las variables se almacenan en el servidor y solo son visibles para los usuarios con acceso al proyecto; se inyectan en el contenedor al arrancar y no se escriben en el registro de despliegue. No obstante, se recomiendan las siguientes prácticas:\n\n' +
      '- Utilice **referencias** `${{Base.PASSWORD}}` en lugar de copiar valores: cada secreto se guarda en un único lugar.\n' +
      '- No ejecute `console.log(process.env)` ni imprima la configuración al arrancar: aparecería en la pestaña Logs.\n' +
      '- Los **build args** que declare se guardan ocultos en el panel y no se muestran.\n' +
      '- No exponga bases de datos con **Puerto público**: quedarían accesibles desde internet. Utilice la red interna del proyecto.\n\n' +
      'Los secretos de las pilas (Supabase, etc.) los genera Skyway y se almacenan en el servicio principal de la pila.',
    keywords: ['secreto', 'secretos', 'seguro', 'seguridad', 'contraseña', 'api key', 'clave', 'exponer', 'filtrar', 'logs', 'build args', 'puerto publico'],
  },
];
