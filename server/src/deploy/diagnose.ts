import { Diagnosis } from '../types';

interface Rule {
  id: string;
  test: (error: string, logs: string) => boolean;
  title: string;
  cause: string;
  /** Texto fijo, o una función cuando el remedio depende de lo que diga el log. */
  fix: string | ((error: string, logs: string) => string);
}

const has = (haystack: string, ...needles: string[]) => {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
};

/**
 * Qué mirar cuando la validación de salud falla. Si en el log consta que la
 * imagen expone otro puerto, eso va primero: explica una sonda que no responde
 * nunca aunque la aplicación esté perfectamente viva, y es de lo que más cuesta
 * ver a simple vista.
 */
function healthcheckFix(_error: string, logs: string): string {
  const base =
    'Consulte las «últimas líneas del contenedor fallido» en este registro: contienen el error de la aplicación. Compruebe también ' +
    'que la ruta de healthcheck existe, responde 2xx sin autenticación y que el puerto interno es el correcto.';
  const desajuste = /declara EXPOSE ([\d, ]+) y el puerto interno del servicio es (\d+)/.exec(logs);
  if (!desajuste) return base;
  return (
    `Este registro ya lo advierte más arriba: la imagen declara EXPOSE ${desajuste[1].trim()} y el servicio está configurado ` +
    `en el ${desajuste[2]}. Si la aplicación escucha en el puerto que indica la imagen, la sonda consulta un puerto sin ` +
    `proceso y no responderá nunca. Corrija «Puerto interno» en Ajustes del servicio. ${base}`
  );
}

/**
 * Qué mirar cuando el proceso sale con 0. Si en el log consta que se cambió de
 * constructor, eso va primero: es la causa que más veces explica «falla algo
 * que llevaba meses funcionando» sin que nadie tocara el repo.
 */
function cleanExitFix(_error: string, logs: string): string {
  const base =
    'El comando de arranque debe ser el proceso que permanece en ejecución: `exec python main.py` en lugar de iniciarlo en segundo ' +
    'plano, o `wait` al final del script si es necesario iniciar varios procesos.';
  if (has(logs, 'se ignora el Dockerfile')) {
    return (
      'Este despliegue no se construyó como el que estaba funcionando: railway.json solicita Nixpacks y se ignoró el ' +
      'Dockerfile, por lo que el comando de arranque es distinto. Compruebe que el comando que infiere Nixpacks (o el ' +
      '`startCommand` de railway.json) es realmente el proceso que permanece en ejecución. Si lo que funcionaba era el ' +
      'Dockerfile, establezca "builder": "DOCKERFILE" en railway.json. ' +
      base
    );
  }
  return (
    base +
    ' Si el problema comenzó al reconstruir y el commit es el mismo, revise también las dependencias: sin versiones fijadas, ' +
    'cada compilación resuelve las últimas y la de hoy puede no ser la de la imagen que sigue en ejecución.'
  );
}

/**
 * Qué hacer cuando GitHub rechaza la credencial. El remedio no es el mismo
 * según con qué se intentó clonar, y el log lo dice: `resolveGitAuth` deja
 * escrito cuál eligió antes de intentarlo.
 */
function credentialFix(_error: string, logs: string): string {
  if (has(logs, 'conector de GitHub')) {
    return (
      'El token de ese conector ya no es válido. Elimínelo y vuelva a crearlo con un token nuevo en Ajustes del servicio → GitHub. ' +
      'Se recomienda conectar la GitHub App al proyecto y seleccionar esa conexión en el servicio: emite un token por despliegue ' +
      'y no caduca, por lo que el problema no se repite.'
    );
  }
  if (has(logs, 'GitHub App')) {
    return (
      'La instalación de la GitHub App ya no autoriza este repositorio: es posible que se haya desinstalado, suspendido o que se ' +
      'haya retirado el repositorio. Revísela en Ajustes → GitHub y, si es necesario, vuelva a instalarla en la cuenta.'
    );
  }
  return 'El token global de GitHub ya no es válido. Actualícelo en Ajustes → GitHub (requiere el permiso `repo` para repositorios privados).';
}

/**
 * Reglas de diagnóstico de fallos de despliegue, evaluadas en orden.
 * La primera que casa gana: pon las más específicas arriba.
 */
const RULES: Rule[] = [
  {
    id: 'docker-unavailable',
    test: (e) => has(e, 'Docker no está disponible'),
    title: 'Skyway no puede comunicarse con Docker',
    cause: 'El daemon de Docker no responde en el socket configurado. Sin él no es posible construir ni iniciar ningún contenedor.',
    fix: 'Compruebe en el servidor que Docker está en ejecución (`systemctl status docker`) y que el contenedor de Skyway monta `/var/run/docker.sock` (así viene en el docker-compose incluido).',
  },
  // Las tres formas de fallar al clonar se separan a propósito: mandan a sitios
  // distintos y juntarlas hacía que un token caducado te dijera «configura un
  // token», que es justo lo que ya tenías hecho.
  {
    id: 'git-auth-rejected',
    test: (e, l) => has(e + l, 'invalid username or token', 'authentication failed', 'bad credentials'),
    title: 'GitHub rechazó la credencial',
    cause:
      'Skyway envió una credencial, pero GitHub no la aceptó. Un token que funcionaba y deja de hacerlo ha caducado, ' +
      'se ha revocado o se ha rotado en GitHub sin actualizarlo en Skyway (los tokens personales clásicos caducan automáticamente).',
    fix: credentialFix,
  },
  {
    id: 'git-no-credentials',
    test: (e, l) => has(e + l, 'could not read username', 'terminal prompts disabled'),
    title: 'El repositorio es privado y no hay credencial',
    cause: 'GitHub solicitó autenticación y Skyway no disponía de ninguna credencial para este servicio.',
    fix:
      'Conecte la GitHub App al proyecto (Ajustes → GitHub): es la opción que no caduca. Como alternativa, añada un token ' +
      'personal en el conector del servicio o un token global en Ajustes → GitHub.',
  },
  {
    id: 'repo-not-found',
    test: (e, l) => has(e + l, 'repository not found'),
    title: 'No se pudo clonar el repositorio',
    cause:
      'La URL no existe, o la credencial es válida pero no tiene acceso a este repositorio en concreto. GitHub responde lo mismo en ambos ' +
      'casos para no revelar si un repositorio privado existe.',
    fix:
      'Compruebe la URL. Si es correcta: con la GitHub App, añada el repositorio a la instalación en GitHub; con un token ' +
      'personal de alcance restringido, concédale acceso a este repositorio; con uno clásico, requiere el permiso `repo`.',
  },
  {
    id: 'branch-not-found',
    test: (e, l) => has(e + l, 'remote branch', 'not found in upstream', "couldn't find remote ref"),
    title: 'La rama no existe',
    cause: 'La rama configurada no existe en el repositorio remoto (es posible que se haya renombrado o eliminado).',
    fix: 'Compruebe el nombre exacto de la rama en GitHub (por ejemplo `main` frente a `master`) y corríjalo en Ajustes del servicio.',
  },
  {
    id: 'no-builder',
    test: (e) => has(e, 'No se encontró Dockerfile y Nixpacks no está instalado'),
    title: 'No es posible construir este repositorio',
    cause: 'El repositorio no tiene Dockerfile y el servidor no tiene Nixpacks instalado para detectar y construir el proyecto automáticamente.',
    fix: 'Opción A: añada un `Dockerfile` al repositorio. Opción B: instale Nixpacks en el servidor (`curl -sSL https://nixpacks.com/install.sh | bash`); la imagen oficial de Skyway ya lo incluye.',
  },
  {
    id: 'oom-killed',
    test: (e, l) => has(e + l, 'código de salida: 137', 'exit code 137', 'oom-kill', 'out of memory'),
    title: 'El proceso se finalizó por falta de memoria (OOM)',
    cause: 'El contenedor superó su límite de RAM (o el servidor se quedó sin memoria) y el kernel finalizó el proceso. El código de salida 137 corresponde a SIGKILL.',
    fix: 'Aumente el límite de RAM en Ajustes → Recursos del servicio (o elimínelo), reduzca el consumo de la aplicación o libere memoria del servidor. Si ocurre durante la compilación, construya una imagen más ligera.',
  },
  {
    id: 'port-in-use',
    test: (e, l) => has(e + l, 'port is already allocated', 'address already in use'),
    title: 'El puerto público ya está en uso',
    cause: 'Otro proceso o contenedor del servidor ya escucha en el puerto público que se intenta asignar.',
    fix: 'Cambie el «Puerto público» del servicio a uno libre, o elimínelo y acceda por dominio a través de Traefik (recomendado).',
  },
  {
    id: 'no-space',
    test: (e, l) => has(e + l, 'no space left on device'),
    title: 'Sin espacio en disco',
    cause: 'El disco del servidor está lleno: no es posible escribir capas de imagen ni volúmenes.',
    fix: 'Libere espacio: `docker system prune -a` elimina imágenes y capas sin usar (compruebe antes qué elimina). Skyway ya purga imágenes antiguas, pero otros contenedores o registros pueden estar ocupando disco.',
  },
  {
    id: 'registry-rate-limit',
    test: (e, l) => has(e + l, 'toomanyrequests', 'rate limit'),
    title: 'Límite de descargas de Docker Hub alcanzado',
    cause: 'Docker Hub limita las descargas anónimas de imágenes por IP (100 cada 6 horas).',
    fix: 'Espere unos minutos y vuelva a intentarlo, o ejecute `docker login` en el servidor con una cuenta de Docker Hub para ampliar el límite.',
  },
  {
    id: 'pull-denied',
    test: (e, l) => has(e + l, 'pull access denied', 'manifest unknown', 'not found: manifest'),
    title: 'No se pudo descargar la imagen base',
    cause: 'La imagen o la versión (tag) indicada no existe públicamente, o requiere autenticación.',
    fix: 'Compruebe el nombre y la versión de la imagen (en bases de datos, el campo «Versión»). Pruebe con la versión por defecto de la plantilla.',
  },
  {
    id: 'exec-format',
    test: (e, l) => has(e + l, 'exec format error'),
    title: 'Arquitectura incompatible',
    cause: 'La imagen se construyó para otra arquitectura de CPU (por ejemplo ARM frente a x86) y el binario no puede ejecutarse en este servidor.',
    fix: 'Construya la imagen para la arquitectura del servidor o utilice imágenes base multiarquitectura (la mayoría de las oficiales lo son).',
  },
  {
    id: 'cmd-not-found',
    test: (e, l) => has(e + l, 'código de salida: 127', 'exit code 127', 'executable file not found', 'no such file or directory: unknown'),
    title: 'Comando de arranque no encontrado',
    cause: 'El comando configurado (o el CMD de la imagen) no existe dentro del contenedor. El código 127 corresponde a «command not found».',
    fix: 'Revise el «Comando de arranque» en Ajustes del servicio (compruebe que esa herramienta está instalada en la imagen) o déjelo vacío para utilizar el CMD del Dockerfile.',
  },
  {
    id: 'build-typescript',
    test: (e, l) => has(e, 'terminó con código') && /error TS\d+/.test(l),
    title: 'El compilador de TypeScript falló',
    cause:
      'La compilación no llegó a empaquetar nada: `tsc` encontró errores de tipos. Tenga en cuenta el más habitual, «Cannot find module X»: casi nunca es un error de tipos, sino que esa dependencia no está en la imagen. `npm ci` instala exactamente lo que indica el package-lock.json de la raíz, por lo que un paquete que en su equipo está en node_modules pero no declarado (o el package.json de un subproyecto que no es un workspace) no existe en la imagen. Los errores «implicitly has an any type» que aparecen a continuación suelen ser consecuencia del módulo que falta, no errores independientes.',
    fix:
      'Reproduzca la compilación limpia en local: elimine node_modules y ejecute `npm ci` y `npm run build`. Si falla igualmente, es necesario declarar la dependencia (`npm i -S paquete`, confirmando también el package-lock). Si el error procede de un subdirectorio que se despliega por separado (un worker, una función), exclúyalo de la compilación de la web retirándolo de las «references» del tsconfig raíz. Revise también la versión de Node: si el registro incluye avisos EBADENGINE, fije la versión necesaria con «engines.node» en package.json o con la variable NIXPACKS_NODE_VERSION del servicio.',
  },
  {
    id: 'build-npm',
    // «terminó con código» a secas: el fallo del gestor de paquetes es el mismo
    // se construya con Dockerfile o con Nixpacks, y antes solo casaba el primero.
    test: (e, l) => has(e, 'terminó con código') && has(l, 'npm err', 'yarn error', 'pnpm err'),
    title: 'La compilación de Node.js falló',
    cause: 'El gestor de paquetes falló durante la construcción de la imagen: suele deberse a una dependencia que no se instala, un script de compilación que falla o una versión de Node incompatible.',
    fix: 'Consulte las últimas líneas del registro (contienen el error concreto de npm/yarn/pnpm). Compruebe que `npm run build` funciona en local con la misma versión de Node que utiliza el Dockerfile.',
  },
  {
    id: 'dockerfile-error',
    test: (e, l) => has(e + l, 'dockerfile parse error', 'unknown instruction', 'copy failed', 'file not found in build context'),
    title: 'Error en el Dockerfile',
    cause: 'El Dockerfile contiene una instrucción no válida o hace referencia a archivos que no existen en el contexto de compilación (es posible que el directorio raíz no esté bien configurado).',
    fix: 'Revise el Dockerfile y el campo «Directorio raíz» del servicio: las rutas de COPY/ADD son relativas a ese directorio.',
  },
  {
    id: 'postgres18-volume-layout',
    test: (e, l) => has(e + l, 'unused mount/volume', 'appears to be PostgreSQL data in', 'docker-library/postgres/pull/1259'),
    title: 'Postgres 18+ rechaza el volumen (cambio de formato en la versión 18)',
    cause: 'Desde la versión 18, la imagen oficial almacena los datos en un subdirectorio versionado de /var/lib/postgresql y no arranca si el volumen está montado en la ruta antigua (/var/lib/postgresql/data), aunque esté vacío, o si encuentra datos con el formato de una versión anterior.',
    fix: 'Con Skyway 0.13.1 o superior es suficiente con volver a desplegar: la ruta de montaje se elige según la versión. Si el volumen contiene datos de un Postgres anterior, mantenga esa versión en Ajustes (p. ej. 16-alpine) o migre con Backups (volcado con la versión anterior y restauración en la nueva). Para empezar de cero, elimine el servicio marcando «borrar también el volumen».',
  },
  {
    id: 'postgres-version-mismatch',
    test: (e, l) => has(e + l, 'database files are incompatible with server', 'no puede abrir los datos de otra', 'formato antiguo (anterior a 18)', 'formato de Postgres 18+', 'subdirectorio data/'),
    title: 'La versión de Postgres no coincide con los datos del volumen',
    cause: 'El volumen se inicializó con otra versión mayor de PostgreSQL: una versión mayor no puede abrir directamente los datos creados por otra.',
    fix: 'Vuelva en Ajustes a la versión que creó los datos, o migre: cree un backup con la versión original → cambie la versión → elimine el servicio con su volumen → vuelva a crearlo → restaure el backup. El propio error del despliegue indica la versión exacta que contiene el volumen.',
  },
  {
    // Va antes que 'healthcheck-failed': el mensaje contiene ambas señales y
    // salir con 0 tiene una causa muy concreta que merece decirse aparte.
    id: 'exited-clean',
    test: (e) => has(e, 'terminó enseguida') && has(e, 'código 0'),
    title: 'El proceso finalizó por sí mismo, sin error',
    cause:
      'El código de salida 0 indica que el comando de arranque completó su trabajo y finalizó, no que fallara. Skyway ' +
      'espera un proceso que permanezca en ejecución: si el comando inicia la aplicación en segundo plano y finaliza, o el script llega al ' +
      'final, el contenedor se detiene y el despliegue se considera fallido.',
    fix: cleanExitFix,
  },
  {
    id: 'healthcheck-failed',
    test: (e) => has(e, 'no pasó la validación', 'no respondió 2xx', 'Se restauró la versión anterior', 'Se mantuvo la versión anterior'),
    title: 'La versión nueva no superó la validación de salud',
    cause: 'Skyway inició la versión nueva y la comprobó antes de retirar la anterior: el proceso finalizó al arrancar o el healthcheck no respondió 2xx a tiempo. La versión anterior sigue en servicio.',
    fix: healthcheckFix,
  },
  {
    id: 'container-died',
    test: (e) => has(e, 'El contenedor terminó inesperadamente'),
    title: 'La aplicación arrancó pero se cerró inmediatamente',
    cause: 'La imagen se construyó correctamente, pero el proceso finalizó nada más arrancar: suele deberse a una variable de entorno que falta (p. ej. DATABASE_URL), un error de conexión con la base de datos o un puerto interno mal configurado.',
    fix: 'Abra la pestaña «Logs» del servicio para ver el error exacto de la aplicación. Compruebe las Variables (posibles credenciales ausentes) y que el «Puerto interno» coincide con el puerto en el que escucha la aplicación.',
  },
  {
    id: 'nixpacks-misdetect',
    test: (e, l) =>
      has(e, 'nixpacks terminó con código') &&
      has(l, 'Relative import path', 'deno cache', 'error: Module not found', 'no lockfile found', 'no start command could be found'),
    title: 'Nixpacks no detectó correctamente qué construir',
    cause:
      'El repositorio no tiene Dockerfile, por lo que Skyway recurre a Nixpacks, que infiere el tipo de proyecto a partir de los archivos del repositorio. En monorepos con varias aplicaciones y lenguajes mezclados (ejemplos de Deno, paquetes de Node, documentación…) esa inferencia falla: selecciona un entorno de ejecución incorrecto o un archivo de entrada que no corresponde a ninguna aplicación real, y la compilación falla con un error ajeno a su código.',
    fix:
      'Dirija la compilación a una aplicación concreta: establezca el «Directorio raíz» del servicio en el subdirectorio de esa aplicación (p. ej. `apps/web`) y, si esa aplicación incluye su propio Dockerfile, indíquelo en «Ruta del Dockerfile» (relativa al directorio raíz). Tenga en cuenta que los repositorios que en realidad son una pila de varios contenedores (Supabase, Mastodon, n8n con sus dependencias…) no se despliegan como un único servicio de Skyway: utilice su docker-compose oficial o cree un servicio de imagen por cada componente.',
  },
  {
    id: 'build-node-version',
    // Va casi al final: los avisos EBADENGINE salen también en builds que van
    // bien, así que solo se apunta este diagnóstico cuando no ha casado ninguna
    // causa más concreta y el build sí ha fallado.
    test: (e, l) => has(e, 'terminó con código') && has(l, 'EBADENGINE', 'Unsupported engine'),
    title: 'La versión de Node no es la que requieren las dependencias',
    cause:
      'El registro incluye avisos «Unsupported engine»: alguna dependencia exige una versión de Node superior a la utilizada para construir. Cuando el repositorio no indica qué versión necesita, Nixpacks selecciona una por defecto que resulta insuficiente con paquetes recientes (Vite 7, supabase-js…), y el fallo aparece más tarde, al ejecutar la compilación, con un error que no menciona la versión.',
    fix:
      'Declare la versión en el propio repositorio, que es lo que Nixpacks consulta: «engines»: { "node": ">=22" } en package.json, o un archivo .nvmrc. Si prefiere no modificar el repositorio, defina la variable NIXPACKS_NODE_VERSION del servicio con el número de versión mayor (por ejemplo 22): las variables del servicio se aplican a la compilación. Las versiones disponibles son las que incluye el Nixpacks instalado: si necesita una muy reciente, actualice Skyway para que se reinstale.',
  },
  {
    id: 'build-generic',
    test: (e) => has(e, 'docker terminó con código', 'nixpacks terminó con código'),
    title: 'La construcción de la imagen falló',
    cause: 'El proceso de compilación finalizó con error. La causa concreta se encuentra en las últimas líneas del registro de despliegue.',
    fix: 'Revise el registro completo: el error real suele estar justo antes del final. Compruebe que el proyecto compila en local.',
  },
];

export function diagnose(error: string | null, logs: string): Diagnosis | null {
  if (!error) return null;
  // Para decidir QUÉ falló basta la cola: el error está al final.
  const tail = logs.slice(-6000);
  for (const rule of RULES) {
    if (rule.test(error, tail)) {
      // Para decidir QUÉ HACER hace falta el log entero. Las señales que afinan
      // el remedio —con qué credencial se clonó, con qué constructor se
      // construyó— se escriben al principio, y un build con mucha salida (pip,
      // npm) las deja a decenas de miles de caracteres de la cola.
      const fix = typeof rule.fix === 'function' ? rule.fix(error, logs) : rule.fix;
      return { id: rule.id, title: rule.title, cause: rule.cause, fix };
    }
  }
  return {
    id: 'unknown',
    title: 'Fallo de despliegue',
    cause: 'No se ha podido identificar un patrón conocido en el error.',
    fix: 'Revise el registro completo del despliegue; si la aplicación llegó a arrancar, consulte también la pestaña «Logs» del servicio.',
  };
}

/** Explica códigos de salida comunes de contenedores (para alertas de caída). */
export function explainExitCode(code: number | null): string {
  switch (code) {
    case 137:
      return 'Código 137 (SIGKILL): normalmente el kernel finalizó el proceso por exceder el límite de memoria (OOM). Aumente el límite de RAM o reduzca el consumo.';
    case 139:
      return 'Código 139 (SIGSEGV): el proceso realizó un acceso no válido a memoria; suele deberse a un error en la aplicación o a una dependencia nativa incompatible.';
    case 143:
      return 'Código 143 (SIGTERM): el proceso recibió una señal de apagado. Si nadie lo detuvo manualmente, otro componente lo está finalizando (por ejemplo, un reinicio de Docker).';
    case 126:
      return 'Código 126: el comando de arranque existe pero no es ejecutable (permisos o formato).';
    case 127:
      return 'Código 127: el comando de arranque no existe dentro del contenedor.';
    case 1:
      return 'Código 1: la aplicación finalizó con un error genérico; consulte su registro para ver la excepción exacta.';
    case 0:
      return 'Código 0: el proceso finalizó correctamente, pero no debería haber finalizado. Compruebe que el comando de arranque ejecuta un proceso de larga duración.';
    default:
      return code === null
        ? 'Sin código de salida registrado.'
        : `Código de salida ${code}. Consulte el registro del servicio para ver el error de la aplicación.`;
  }
}
