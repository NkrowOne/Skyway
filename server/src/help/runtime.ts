import { IssueSeverity } from './types';

/**
 * Reglas sobre los logs de la APLICACIÓN (lo que escribe el proceso una vez
 * arrancado), no del build: de eso se ocupa `deploy/diagnose.ts`. Aquí el
 * proceso ya existe y lo que se busca es la excepción que explica por qué se
 * cae, no conecta o no responde.
 */

export interface RuntimeFinding {
  id: string;
  severity: IssueSeverity;
  title: string;
  cause: string;
  fix: string;
  /** Línea que casó, recortada y sin secretos. */
  evidence: string;
}

interface RuntimeRule {
  id: string;
  severity: IssueSeverity;
  test: RegExp;
  title: string | ((line: string) => string);
  cause: string;
  fix: string;
}

/** Longitud máxima de la evidencia: una línea de log entera puede ser un JSON de kilobytes. */
export const EVIDENCE_MAX = 200;

/** Tope de hallazgos por escaneo: más de cinco ya no orienta, abruma. */
const MAX_FINDINGS = 5;

/**
 * Tapa lo que tenga pinta de secreto antes de enseñar una línea de log:
 * `password=…`, `token: …`, cabeceras Bearer, URLs con credenciales
 * (`://user:pass@host`) y claves con prefijos reconocibles (`sk-…`, `ghp_…`).
 * La línea sigue siendo legible —se conserva la clave— pero el valor no viaja.
 */
export function maskSecrets(text: string): string {
  return (
    text
      // usuario:contraseña dentro de una URL
      .replace(/(\w+:\/\/)([^\s/:@]+):([^\s@]+)@/g, '$1$2:•••@')
      // clave=valor / clave: valor / "clave": "valor" con nombres sensibles
      .replace(
        /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|auth|credential|contrase[ñn]a|clave)[\w-]*["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^\s"',;&]+)/gi,
        '$1•••',
      )
      // cabeceras/tokens Bearer sueltos
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1•••')
      // prefijos de claves conocidas
      .replace(/\b(sk|ghp|gho|ghu|ghs|github_pat|xox[abp]|AKIA|skai|sky)[-_][A-Za-z0-9_-]{8,}/g, '$1_•••')
  );
}

/** Evidencia lista para enseñar: sin sello de tiempo ni prefijo de réplica, tapada y recortada. */
export function toEvidence(line: string): string {
  const clean = line
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s/, '')
    .replace(/^\[r\d+\]\s/, '')
    .trim();
  const masked = maskSecrets(clean);
  return masked.length > EVIDENCE_MAX ? `${masked.slice(0, EVIDENCE_MAX - 1)}…` : masked;
}

/** Nombre de la variable que falta, si la línea lo dice. */
function envVarIn(line: string): string | null {
  const m =
    /process\.env\.([A-Z][A-Z0-9_]+)/.exec(line) ||
    /KeyError: ['"]([A-Z][A-Z0-9_]+)['"]/.exec(line) ||
    /environment variable[s]?\s+['"`]?([A-Z][A-Z0-9_]+)/i.exec(line) ||
    /\b([A-Z][A-Z0-9_]{2,})\b (?:is not defined|is not set|is required|is missing|must be set|no está definid)/.exec(line) ||
    /Missing (?:required )?env(?:ironment)?(?: variable)?s?:?\s+['"`]?([A-Z][A-Z0-9_]+)/i.exec(line);
  return m ? m[1] : null;
}

/**
 * Reglas en orden: una línea casa como mucho con UNA (la primera). Las más
 * concretas van arriba —la de variable ausente antes que la de excepción
 * genérica, porque un `KeyError: 'DATABASE_URL'` es las dos cosas y la primera
 * es la que dice qué hacer.
 */
const RULES: RuntimeRule[] = [
  {
    id: 'env-missing',
    severity: 'critical',
    test: /is not defined|is not set\b|process\.env\.[A-Z_]+.*undefined|undefined.*process\.env\.[A-Z_]+|KeyError: ['"][A-Z][A-Z0-9_]+['"]|environment variable|Missing (?:required )?env|env(?:ironment)? var(?:iable)?s? .*(?:missing|required)|must be set\b|no está definid/i,
    title: (line) => {
      const v = envVarIn(line);
      return v ? `Falta la variable de entorno ${v}` : 'Falta una variable de entorno';
    },
    cause:
      'La aplicación lee una variable de entorno que no existe en el contenedor. Las variables se inyectan al crear el contenedor: una añadida después no llega hasta el siguiente despliegue.',
    fix:
      'Añádela en la pestaña Variables (o revisa el nombre exacto, mayúsculas incluidas) y pulsa Desplegar. Si viene del .env.example del repo, «Importar del repositorio» la propone con su fichero de origen.',
  },
  {
    id: 'prisma',
    severity: 'critical',
    test: /PrismaClientInitializationError|@prisma\/client did not initialize|prisma generate|Error: P10\d\d|PrismaClientKnownRequestError: .*P10\d\d/i,
    title: 'Prisma no puede arrancar',
    cause:
      'El cliente de Prisma no se generó durante el build (`@prisma/client did not initialize`) o no alcanza la base de datos (códigos P1000–P1003: credenciales, host o base inexistente).',
    fix:
      'Si es de inicialización, añade `npx prisma generate` al build (script `postinstall` o Comando de compilación). Si es P1001/P1000, revisa que DATABASE_URL sea una referencia `${{Base.DATABASE_URL}}` y que la base esté en marcha; para tablas que faltan, ejecuta `prisma migrate deploy` en el comando de arranque.',
  },
  {
    id: 'mongo',
    severity: 'critical',
    test: /Mongo(?:Server|Network|oose)?(?:Selection)?Error|MongoServerSelectionError|failed to connect to server .*27017|ECONNREFUSED .*27017/i,
    title: 'No conecta con MongoDB',
    cause:
      'El driver de Mongo no encuentra el servidor o este rechaza la conexión: host equivocado (`localhost` no es la base dentro del contenedor), servicio parado o credenciales incorrectas en la URL.',
    fix:
      'Usa `${{NombreDelMongo.MONGO_URL}}` en Variables en vez de una URL a mano, comprueba que el servicio de Mongo está en marcha y que la URL lleva `authSource=admin` si el usuario es el generado por Skyway.',
  },
  {
    id: 'redis',
    severity: 'warning',
    test: /ioredis|MaxRetriesPerRequestError|Redis connection to|ReplyError: (?:NOAUTH|WRONGPASS)|ECONNREFUSED .*6379|redis.*ECONNREFUSED/i,
    title: 'No conecta con Redis',
    cause:
      'El cliente de Redis no llega al servidor (host o puerto equivocados, servicio parado) o el servidor exige contraseña y no se envía (`NOAUTH`/`WRONGPASS`).',
    fix:
      'Referencia `${{NombreDelRedis.REDIS_URL}}` en Variables: incluye host interno, puerto y contraseña. Si usas variables sueltas, el host es el nombre del servicio de Redis, no localhost.',
  },
  {
    id: 'db-connection-refused',
    severity: 'critical',
    test: /ECONNREFUSED|connection refused|getaddrinfo ENOTFOUND|EAI_AGAIN|could not connect to server|Connection refused|could not translate host name|Name or service not known|ETIMEDOUT .*(?:5432|3306|27017|6379)/i,
    title: 'Conexión rechazada o host no encontrado',
    cause:
      'La aplicación intenta conectar con un host que no responde (`ECONNREFUSED`) o que no existe (`ENOTFOUND`/`EAI_AGAIN`). Dentro del contenedor `localhost` es el propio contenedor, no la base de datos; y una referencia `${{…}}` sin resolver deja el texto literal como host.',
    fix:
      'Comprueba en Variables que el host es el nombre interno del servicio de destino (mejor con una referencia `${{Base.DATABASE_URL}}`), que ese servicio está en marcha y que está en el mismo proyecto. Luego redespliega.',
  },
  {
    id: 'db-auth-failed',
    severity: 'critical',
    test: /password authentication failed|Access denied for user|AuthenticationFailed|authentication failed for user|SASL authentication failed|auth failed|FATAL:\s+role .* does not exist/i,
    title: 'La base de datos rechaza las credenciales',
    cause:
      'Usuario o contraseña incorrectos: un valor copiado a mano y luego rotado, una referencia que apunta a otra variable, o un usuario que no existe en esa base.',
    fix:
      'En Variables sustituye el valor por la referencia a la base de datos (`${{Base.DATABASE_URL}}` o `${{Base.PGPASSWORD}}`) y redespliega. Las credenciales reales están en la pestaña Variables del servicio de base de datos.',
  },
  {
    id: 'db-missing-object',
    severity: 'warning',
    test: /database ["'][^"']+["'] does not exist|relation ["'][^"']+["'] does not exist|no such table|Unknown database|Table ['"`][^'"`]+['"`] doesn't exist|Unknown column|column ["'][^"']+["'] does not exist|pending migrations|migrations? (?:are|is) pending|has not been migrated/i,
    title: 'Falta una base de datos, tabla o columna',
    cause:
      'La base de datos existe y responde, pero el esquema no es el que espera el código: las migraciones no se han ejecutado, apuntas a otra base o la URL trae un nombre de base distinto del creado.',
    fix:
      'Ejecuta las migraciones al arrancar (por ejemplo `npx prisma migrate deploy && npm start`, `python manage.py migrate && gunicorn …` en el Comando de arranque) o lánzalas una vez desde la pestaña Consultas. Comprueba también el nombre de la base en la URL.',
  },
  {
    id: 'port-in-use',
    severity: 'critical',
    test: /EADDRINUSE|address already in use|Address already in use|bind: address already in use/i,
    title: 'El puerto ya está ocupado dentro del contenedor',
    cause:
      'Dos procesos del mismo contenedor intentan escuchar en el mismo puerto: el comando de arranque lanza la app dos veces, o un proceso auxiliar (un worker, un proxy) usa el mismo `PORT`.',
    fix:
      'Revisa el Comando de arranque para que solo un proceso escuche en `PORT`; si necesitas dos procesos que escuchan, sepáralos en dos servicios o dale un puerto fijo distinto al segundo.',
  },
  {
    id: 'permission-denied',
    severity: 'critical',
    test: /EACCES|permission denied|Permission denied|EPERM|operation not permitted/i,
    title: 'Permiso denegado',
    cause:
      'El proceso no puede leer, escribir o ejecutar algo: un volumen montado con dueño distinto al usuario de la imagen, un fichero sin bit de ejecución o un puerto privilegiado (< 1024) con un usuario sin privilegios.',
    fix:
      'Si es un volumen, ajusta el dueño en el Dockerfile (`RUN chown -R app:app /data`) o arranca como root; si es un script, `chmod +x` en el repo; si es el puerto, usa uno ≥ 1024 (3000, 8080) y ajusta el Puerto interno.',
  },
  {
    id: 'module-not-found',
    severity: 'critical',
    test: /Cannot find module|ModuleNotFoundError|ImportError|No module named|Error: Cannot find package|MODULE_NOT_FOUND|cannot open shared object file|Could not resolve/i,
    title: 'Falta un módulo o dependencia',
    cause:
      'El código importa algo que no está en la imagen: una dependencia que no figura en `package.json`/`requirements.txt`, una `devDependency` que hace falta en producción, o un fichero compilado que el build no generó.',
    fix:
      'Declara la dependencia y commitea el lockfile (`npm i -S paquete`); si es una devDependency necesaria en runtime, muévela a dependencies o no uses `--omit=dev`. Si es un fichero de `dist/`, comprueba que el build (`npm run build`) se ejecuta antes del arranque.',
  },
  {
    id: 'out-of-memory',
    severity: 'critical',
    test: /heap out of memory|JavaScript heap|FATAL ERROR: .*Allocation failed|OOMKilled|Out of memory|\bKilled\b|MemoryError|Cannot allocate memory/i,
    title: 'El proceso se quedó sin memoria',
    cause:
      'La aplicación superó la RAM asignada al servicio y el sistema la mató (código de salida 137) o el runtime abortó por falta de heap.',
    fix:
      'Sube la RAM en Ajustes → Recursos (se aplica en caliente) o reduce el consumo: en Node, `NODE_OPTIONS=--max-old-space-size=…` acorde al límite; en Python, revisa cargas en memoria de ficheros grandes. Si pasa durante el build, construye una imagen más ligera.',
  },
  {
    id: 'listen-localhost',
    severity: 'critical',
    test: /(?:listening|listen|escuchando|running|ready|started|server|serving|Local:|available)[^\n]{0,60}(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):\d+/i,
    title: 'La aplicación escucha solo en localhost',
    cause:
      'El proceso está vivo, pero escucha en `127.0.0.1`/`localhost`: desde fuera del contenedor (Traefik, el healthcheck, otros servicios) no se puede llegar a esa dirección, así que el dominio da 502 y la validación de salud falla.',
    fix:
      'Haz que la app escuche en `0.0.0.0` (`app.listen(PORT, "0.0.0.0")`, `--host 0.0.0.0` en Vite/uvicorn/Next, `HOST=0.0.0.0` en frameworks que lo leen) y redespliega.',
  },
  {
    id: 'ssl',
    severity: 'warning',
    test: /self[- ]signed certificate|SELF_SIGNED_CERT_IN_CHAIN|SSL required|SSL\/TLS required|no encryption|sslmode|unable to verify the first certificate|certificate verify failed|UNABLE_TO_VERIFY_LEAF_SIGNATURE|The server does not support SSL connections|SSL SYSCALL error|ssl3_get_record/i,
    title: 'Problema de SSL con un servicio externo o la base de datos',
    cause:
      'El cliente y el servidor no se ponen de acuerdo en el cifrado: la base gestionada del proyecto no usa SSL en la red interna y el cliente lo exige, o al contrario, un servicio externo presenta un certificado que el contenedor no reconoce.',
    fix:
      'Para bases del proyecto, quita `sslmode=require`/`ssl: true` o pon `sslmode=disable`: el tráfico no sale de la red privada. Para servicios externos con certificado propio, añade la CA a la imagen o configura el cliente para aceptarla (nunca desactives la verificación en producción sin saber por qué).',
  },
  {
    id: 'cors',
    severity: 'warning',
    test: /blocked by CORS|CORS policy|Access-Control-Allow-Origin|CORS error|Not allowed by CORS/i,
    title: 'El navegador bloquea las peticiones por CORS',
    cause:
      'El frontend se sirve desde un dominio y llama a la API en otro, y la API no envía la cabecera `Access-Control-Allow-Origin` para ese origen (o lo envía para el dominio antiguo).',
    fix:
      'Configura el origen permitido en la API con el dominio real del frontend (normalmente una variable como `CORS_ORIGIN` o `FRONTEND_URL` en Variables) y redespliega; o sirve frontend y API bajo el mismo dominio.',
  },
  {
    id: 'unhandled-exception',
    severity: 'warning',
    test: /UnhandledPromiseRejection|unhandledRejection|uncaughtException|Traceback \(most recent call last\)|^panic:|\bpanic:|FATAL|Unhandled exception|Exception in thread|goroutine \d+ \[running\]|Segmentation fault|core dumped/i,
    title: 'Excepción no controlada',
    cause:
      'La aplicación lanzó una excepción que nadie capturó y el proceso terminó (o el runtime lo marcó como fatal). Las líneas siguientes del log suelen traer el mensaje concreto y el fichero.',
    fix:
      'Lee las líneas inmediatamente posteriores en la pestaña Logs para ver la excepción exacta. Si aparece en cada arranque, suele ser de configuración (variables, conexiones); si es esporádica, captúrala en el código y registra el contexto.',
  },
];

/**
 * Recorre los logs de la aplicación y devuelve las reglas que casan, una vez
 * cada una, en el orden de la tabla (las de arriba son las más accionables) y
 * con la primera línea que la delató como evidencia. Máximo cinco.
 */
export function detectRuntimeIssues(logs: string): RuntimeFinding[] {
  if (!logs) return [];
  const found = new Map<string, RuntimeFinding>();
  for (const rawLine of logs.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const rule of RULES) {
      if (found.has(rule.id)) continue;
      if (!rule.test.test(line)) continue;
      found.set(rule.id, {
        id: rule.id,
        severity: rule.severity,
        title: typeof rule.title === 'function' ? rule.title(line) : rule.title,
        cause: rule.cause,
        fix: rule.fix,
        evidence: toEvidence(line),
      });
      // Una línea cuenta para una sola regla: la primera en orden.
      break;
    }
  }
  return RULES.filter((r) => found.has(r.id))
    .map((r) => found.get(r.id)!)
    .slice(0, MAX_FINDINGS);
}
