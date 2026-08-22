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
 * ver a ojo.
 */
function healthcheckFix(_error: string, logs: string): string {
  const base =
    'Mira las "últimas líneas del contenedor fallido" en este log: ahí está el error de tu app. Comprueba también ' +
    'que la ruta de healthcheck existe, responde 2xx sin autenticación y que el puerto interno es el correcto.';
  const desajuste = /declara EXPOSE ([\d, ]+) y el puerto interno del servicio es (\d+)/.exec(logs);
  if (!desajuste) return base;
  return (
    `Arriba en este log ya se avisa: la imagen declara EXPOSE ${desajuste[1].trim()} y el servicio está configurado ` +
    `en el ${desajuste[2]}. Si tu aplicación escucha donde dice la imagen, la sonda va a un puerto donde no hay ` +
    `nadie y no responderá nunca. Corrige «Puerto interno» en Ajustes del servicio. ${base}`
  );
}

/**
 * Qué mirar cuando el proceso sale con 0. Si en el log consta que se cambió de
 * constructor, eso va primero: es la causa que más veces explica «falla algo
 * que llevaba meses funcionando» sin que nadie tocara el repo.
 */
function cleanExitFix(_error: string, logs: string): string {
  const base =
    'Que el comando de arranque SEA el proceso que se queda: `exec python main.py` en vez de lanzarlo en segundo ' +
    'plano, o `wait` al final del script si de verdad lanzas varias cosas.';
  if (has(logs, 'se ignora el Dockerfile')) {
    return (
      'Este despliegue no se construyó como el que estaba funcionando: railway.json pide Nixpacks y se ignoró el ' +
      'Dockerfile, así que el comando de arranque es otro. Comprueba que el comando que infiere Nixpacks (o el ' +
      '`startCommand` de railway.json) es de verdad el proceso que se queda vivo. Si lo que funcionaba era el ' +
      'Dockerfile, pon "builder": "DOCKERFILE" en railway.json. ' +
      base
    );
  }
  return (
    base +
    ' Si esto empezó al reconstruir y el commit es el mismo, mira también las dependencias: sin versiones fijadas, ' +
    'cada build resuelve las últimas y la de hoy puede no ser la de la imagen que sigue corriendo.'
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
      'El token de ese conector ya no vale. Bórralo y vuelve a crearlo con un token nuevo en Ajustes del servicio → GitHub. ' +
      'Mejor todavía: conecta la GitHub App al proyecto y elige esa conexión en el servicio — emite un token por despliegue ' +
      'y no caduca, así que no vuelve a pasar.'
    );
  }
  if (has(logs, 'GitHub App')) {
    return (
      'La instalación de la GitHub App ya no autoriza este repositorio: puede que se desinstalara, se suspendiera o se le ' +
      'quitara el repo. Revísala en Ajustes → GitHub y, si hace falta, vuelve a instalarla en la cuenta.'
    );
  }
  return 'El token global de GitHub ya no vale. Actualízalo en Ajustes → GitHub (necesita permiso `repo` para repos privados).';
}

/**
 * Reglas de diagnóstico de fallos de despliegue, evaluadas en orden.
 * La primera que casa gana: pon las más específicas arriba.
 */
const RULES: Rule[] = [
  {
    id: 'docker-unavailable',
    test: (e) => has(e, 'Docker no está disponible'),
    title: 'Skyway no puede hablar con Docker',
    cause: 'El daemon de Docker no responde en el socket configurado. Sin él no se puede construir ni arrancar nada.',
    fix: 'Comprueba en el servidor que Docker está corriendo (`systemctl status docker`) y que el contenedor de Skyway monta `/var/run/docker.sock` (así viene en el docker-compose incluido).',
  },
  // Las tres formas de fallar al clonar se separan a propósito: mandan a sitios
  // distintos y juntarlas hacía que un token caducado te dijera «configura un
  // token», que es justo lo que ya tenías hecho.
  {
    id: 'git-auth-rejected',
    test: (e, l) => has(e + l, 'invalid username or token', 'authentication failed', 'bad credentials'),
    title: 'GitHub rechazó la credencial',
    cause:
      'Skyway sí envió una credencial, pero GitHub no la aceptó. Un token que funcionaba y deja de hacerlo está caducado, ' +
      'revocado o se rotó en GitHub sin actualizarlo aquí (los tokens personales clásicos caducan solos).',
    fix: credentialFix,
  },
  {
    id: 'git-no-credentials',
    test: (e, l) => has(e + l, 'could not read username', 'terminal prompts disabled'),
    title: 'El repositorio es privado y no hay credencial',
    cause: 'GitHub pidió autenticación y Skyway no tenía ninguna credencial que ofrecer para este servicio.',
    fix:
      'Conecta la GitHub App al proyecto (Ajustes → GitHub): es la opción que no caduca. Como alternativa, añade un token ' +
      'personal en el conector del servicio o un token global en Ajustes → GitHub.',
  },
  {
    id: 'repo-not-found',
    test: (e, l) => has(e + l, 'repository not found'),
    title: 'No se pudo clonar el repositorio',
    cause:
      'La URL no existe, o la credencial es válida pero no alcanza a ESTE repositorio. GitHub responde lo mismo en ambos ' +
      'casos para no revelar si un repo privado existe.',
    fix:
      'Comprueba la URL. Si es correcta: con la GitHub App, añade el repositorio a la instalación en GitHub; con un token ' +
      'personal de alcance fino, dale acceso a este repositorio; con uno clásico, necesita el permiso `repo`.',
  },
  {
    id: 'branch-not-found',
    test: (e, l) => has(e + l, 'remote branch', 'not found in upstream', "couldn't find remote ref"),
    title: 'La rama no existe',
    cause: 'La rama configurada no existe en el repositorio remoto (¿se renombró o se borró?).',
    fix: 'Comprueba el nombre exacto de la rama en GitHub (por ejemplo `main` vs `master`) y corrígelo en Ajustes del servicio.',
  },
  {
    id: 'no-builder',
    test: (e) => has(e, 'No se encontró Dockerfile y Nixpacks no está instalado'),
    title: 'No hay forma de construir este repositorio',
    cause: 'El repo no tiene Dockerfile y el servidor no tiene Nixpacks instalado para detectar y construir el proyecto automáticamente.',
    fix: 'Opción A: añade un `Dockerfile` al repositorio. Opción B: instala Nixpacks en el servidor (`curl -sSL https://nixpacks.com/install.sh | bash`); la imagen oficial de Skyway ya lo trae.',
  },
  {
    id: 'oom-killed',
    test: (e, l) => has(e + l, 'código de salida: 137', 'exit code 137', 'oom-kill', 'out of memory'),
    title: 'El proceso fue matado por falta de memoria (OOM)',
    cause: 'El contenedor superó su límite de RAM (o el servidor se quedó sin memoria) y el kernel lo mató. El código de salida 137 = SIGKILL.',
    fix: 'Sube el límite de RAM en Ajustes → Recursos del servicio (o quítalo), reduce el consumo de la app, o libera memoria del servidor. Si pasa durante el build, construye una imagen más ligera.',
  },
  {
    id: 'port-in-use',
    test: (e, l) => has(e + l, 'port is already allocated', 'address already in use'),
    title: 'El puerto público ya está ocupado',
    cause: 'Otro proceso o contenedor del servidor ya escucha en el puerto público que intentas asignar.',
    fix: 'Cambia el "Puerto público" del servicio a uno libre, o quítalo y accede por dominio a través de Traefik (recomendado).',
  },
  {
    id: 'no-space',
    test: (e, l) => has(e + l, 'no space left on device'),
    title: 'Sin espacio en disco',
    cause: 'El disco del servidor está lleno: no se pueden escribir capas de imagen ni volúmenes.',
    fix: 'Libera espacio: `docker system prune -a` borra imágenes y capas sin usar (revisa antes qué elimina). Skyway ya purga imágenes antiguas, pero otros contenedores/logs pueden estar ocupando disco.',
  },
  {
    id: 'registry-rate-limit',
    test: (e, l) => has(e + l, 'toomanyrequests', 'rate limit'),
    title: 'Límite de descargas de Docker Hub alcanzado',
    cause: 'Docker Hub limita las descargas anónimas de imágenes por IP (100 cada 6 horas).',
    fix: 'Espera un rato y reintenta, o haz `docker login` en el servidor con una cuenta de Docker Hub para ampliar el límite.',
  },
  {
    id: 'pull-denied',
    test: (e, l) => has(e + l, 'pull access denied', 'manifest unknown', 'not found: manifest'),
    title: 'No se pudo descargar la imagen base',
    cause: 'La imagen o la versión (tag) indicada no existe públicamente, o requiere autenticación.',
    fix: 'Revisa el nombre/versión de la imagen (en bases de datos, el campo "Versión"). Prueba con la versión por defecto de la plantilla.',
  },
  {
    id: 'exec-format',
    test: (e, l) => has(e + l, 'exec format error'),
    title: 'Arquitectura incompatible',
    cause: 'La imagen se construyó para otra arquitectura de CPU (por ejemplo ARM vs x86) y el binario no puede ejecutarse en este servidor.',
    fix: 'Construye para la arquitectura del servidor o usa imágenes base multi-arquitectura (la mayoría de las oficiales lo son).',
  },
  {
    id: 'cmd-not-found',
    test: (e, l) => has(e + l, 'código de salida: 127', 'exit code 127', 'executable file not found', 'no such file or directory: unknown'),
    title: 'Comando de arranque no encontrado',
    cause: 'El comando configurado (o el CMD de la imagen) no existe dentro del contenedor. Código 127 = "command not found".',
    fix: 'Revisa el "Comando de arranque" en Ajustes del servicio (¿está instalada esa herramienta en la imagen?) o déjalo vacío para usar el CMD del Dockerfile.',
  },
  {
    id: 'build-typescript',
    test: (e, l) => has(e, 'terminó con código') && /error TS\d+/.test(l),
    title: 'El compilador de TypeScript falló',
    cause:
      'El build no llegó a empaquetar nada: `tsc` encontró errores de tipos. Ojo con el más habitual, «Cannot find module X»: casi nunca es un error de tipos, es que esa dependencia no está en la imagen. `npm ci` instala EXACTAMENTE lo que dice el package-lock.json de la raíz, así que un paquete que en tu máquina está en node_modules pero no declarado —o el package.json de un subproyecto que no es un workspace— aquí no existe. Los «implicitly has an any type» que salen detrás suelen ser el eco del módulo que falta, no errores independientes.',
    fix:
      'Reproduce el build limpio en local: borra node_modules, `npm ci` y `npm run build`. Si falla igual, falta declarar la dependencia (`npm i -S paquete`, commiteando también el package-lock). Si el error viene de un subdirectorio que se despliega por su cuenta (un worker, una función), sácalo del build de la web quitándolo de las «references» del tsconfig raíz. Y revisa la versión de Node: si el log trae avisos EBADENGINE, fija la que necesitas con «engines.node» en package.json o con la variable NIXPACKS_NODE_VERSION del servicio.',
  },
  {
    id: 'build-npm',
    // «terminó con código» a secas: el fallo del gestor de paquetes es el mismo
    // se construya con Dockerfile o con Nixpacks, y antes solo casaba el primero.
    test: (e, l) => has(e, 'terminó con código') && has(l, 'npm err', 'yarn error', 'pnpm err'),
    title: 'El build de Node.js falló',
    cause: 'El gestor de paquetes falló durante la construcción de la imagen: suele ser una dependencia que no instala, un script de build que falla o una versión de Node incompatible.',
    fix: 'Mira las últimas líneas del log (el error concreto de npm/yarn/pnpm está ahí). Comprueba que `npm run build` funciona en local con la misma versión de Node que usa tu Dockerfile.',
  },
  {
    id: 'dockerfile-error',
    test: (e, l) => has(e + l, 'dockerfile parse error', 'unknown instruction', 'copy failed', 'file not found in build context'),
    title: 'Error en el Dockerfile',
    cause: 'El Dockerfile tiene una instrucción inválida o referencia ficheros que no existen en el contexto de build (¿directorio raíz mal configurado?).',
    fix: 'Revisa el Dockerfile y el campo "Directorio raíz" del servicio: las rutas de COPY/ADD son relativas a ese directorio.',
  },
  {
    id: 'postgres18-volume-layout',
    test: (e, l) => has(e + l, 'unused mount/volume', 'appears to be PostgreSQL data in', 'docker-library/postgres/pull/1259'),
    title: 'Postgres 18+ rechaza el volumen (cambio de formato en la 18)',
    cause: 'Desde la 18, la imagen oficial guarda los datos en un subdirectorio versionado de /var/lib/postgresql y se niega a arrancar si el volumen está montado en la ruta antigua (/var/lib/postgresql/data) — aunque esté vacío — o si encuentra datos con el formato de una versión anterior.',
    fix: 'Con Skyway 0.13.1+ basta con redesplegar: la ruta de montaje ya se elige según la versión. Si el volumen tiene datos de un Postgres anterior, mantén esa versión en Ajustes (p. ej. 16-alpine) o migra con Backups (volcado con la versión vieja y restauración en la nueva). Para empezar de cero, borra el servicio marcando «borrar también el volumen».',
  },
  {
    id: 'postgres-version-mismatch',
    test: (e, l) => has(e + l, 'database files are incompatible with server', 'no puede abrir los datos de otra', 'formato antiguo (anterior a 18)', 'formato de Postgres 18+', 'subdirectorio data/'),
    title: 'La versión de Postgres no coincide con los datos del volumen',
    cause: 'El volumen fue inicializado por otra versión mayor de PostgreSQL: una versión mayor no puede abrir directamente los datos creados por otra.',
    fix: 'Vuelve en Ajustes a la versión que creó los datos, o migra: Backup con la versión original → cambia la versión → borra el servicio con su volumen → recréalo → restaura el backup. El propio error del despliegue indica la versión exacta que tiene el volumen.',
  },
  {
    // Va antes que 'healthcheck-failed': el mensaje contiene ambas señales y
    // salir con 0 tiene una causa muy concreta que merece decirse aparte.
    id: 'exited-clean',
    test: (e) => has(e, 'terminó enseguida') && has(e, 'código 0'),
    title: 'El proceso terminó por su cuenta, sin error',
    cause:
      'Código de salida 0 significa que el comando de arranque hizo su trabajo y terminó, no que se estrellara. Skyway ' +
      'espera un proceso que se quede vivo: si el comando lanza la app en segundo plano y devuelve, o el script llega al ' +
      'final, el contenedor se para y el despliegue se da por fallido.',
    fix: cleanExitFix,
  },
  {
    id: 'healthcheck-failed',
    test: (e) => has(e, 'no pasó la validación', 'no respondió 2xx', 'Se restauró la versión anterior', 'Se mantuvo la versión anterior'),
    title: 'La versión nueva no superó la validación de salud',
    cause: 'Skyway arrancó la versión nueva y la comprobó antes de retirar la anterior: o el proceso murió al arrancar, o el healthcheck no respondió 2xx a tiempo. La versión anterior sigue sirviendo.',
    fix: healthcheckFix,
  },
  {
    id: 'container-died',
    test: (e) => has(e, 'El contenedor terminó inesperadamente'),
    title: 'La aplicación arrancó pero se cerró enseguida',
    cause: 'La imagen se construyó bien, pero el proceso murió nada más arrancar: suele ser una variable de entorno que falta (p. ej. DATABASE_URL), un error de conexión a la base de datos, o un puerto interno mal configurado.',
    fix: 'Abre la pestaña Logs del servicio para ver el error exacto de tu aplicación. Comprueba las Variables (¿faltan credenciales?) y que el "Puerto interno" coincide con el que escucha tu app.',
  },
  {
    id: 'nixpacks-misdetect',
    test: (e, l) =>
      has(e, 'nixpacks terminó con código') &&
      has(l, 'Relative import path', 'deno cache', 'error: Module not found', 'no lockfile found', 'no start command could be found'),
    title: 'Nixpacks detectó mal qué hay que construir',
    cause:
      'El repositorio no tiene Dockerfile, así que Skyway recurre a Nixpacks, que adivina el tipo de proyecto mirando los ficheros del repo. En monorepos con varias apps y lenguajes mezclados (ejemplos de Deno, paquetes de Node, docs…) esa adivinanza falla: elige el runtime equivocado o un fichero de entrada que no es el de ninguna app real, y el build revienta con un error que no tiene que ver con tu código.',
    fix:
      'Apunta el build a UNA aplicación concreta: pon el "Directorio raíz" del servicio al subdirectorio de esa app (p. ej. `apps/web`), y si esa app trae su propio Dockerfile indícalo en "Ruta del Dockerfile" (es relativa al directorio raíz). Ojo: los repos que en realidad son una pila de varios contenedores (Supabase, Mastodon, n8n con sus dependencias…) no se despliegan como un servicio único de Skyway; usa su docker-compose oficial o crea un servicio por imagen para cada pieza.',
  },
  {
    id: 'build-node-version',
    // Va casi al final: los avisos EBADENGINE salen también en builds que van
    // bien, así que solo se apunta este diagnóstico cuando no ha casado ninguna
    // causa más concreta y el build sí ha fallado.
    test: (e, l) => has(e, 'terminó con código') && has(l, 'EBADENGINE', 'Unsupported engine'),
    title: 'La versión de Node no es la que piden tus dependencias',
    cause:
      'El log trae avisos «Unsupported engine»: alguna dependencia exige una versión de Node mayor que la que se usó para construir. Cuando el repositorio no dice qué versión quiere, Nixpacks elige una por defecto que se queda corta con paquetes recientes (Vite 7, supabase-js…), y el fallo aparece más tarde, al ejecutar el build, con un error que no menciona la versión.',
    fix:
      'Declara la versión en el propio repositorio, que es lo que Nixpacks mira: «engines»: { "node": ">=22" } en package.json, o un fichero .nvmrc. Si prefieres no tocar el repo, define la variable NIXPACKS_NODE_VERSION del servicio con el número mayor (por ejemplo 22): las variables del servicio llegan al build. Las versiones disponibles son las que trae el Nixpacks instalado: si necesitas una muy reciente, actualiza Skyway para que se reinstale.',
  },
  {
    id: 'build-generic',
    test: (e) => has(e, 'docker terminó con código', 'nixpacks terminó con código'),
    title: 'La construcción de la imagen falló',
    cause: 'El proceso de build terminó con error. La causa concreta está en las últimas líneas del log de despliegue.',
    fix: 'Revisa el log completo: el error real suele estar justo antes del final. Verifica que el proyecto compila en local.',
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
    cause: 'No se pudo identificar un patrón conocido en el error.',
    fix: 'Revisa el log completo del despliegue; si la app llegó a arrancar, mira también la pestaña Logs del servicio.',
  };
}

/** Explica códigos de salida comunes de contenedores (para alertas de caída). */
export function explainExitCode(code: number | null): string {
  switch (code) {
    case 137:
      return 'Código 137 (SIGKILL): normalmente el kernel mató el proceso por exceder el límite de memoria (OOM). Sube el límite de RAM o reduce el consumo.';
    case 139:
      return 'Código 139 (SIGSEGV): el proceso hizo un acceso inválido a memoria; suele ser un bug en la aplicación o una dependencia nativa incompatible.';
    case 143:
      return 'Código 143 (SIGTERM): el proceso recibió una señal de apagado. Si nadie lo detuvo manualmente, algo lo está terminando (¿reinicio de Docker?).';
    case 126:
      return 'Código 126: el comando de arranque existe pero no es ejecutable (permisos o formato).';
    case 127:
      return 'Código 127: el comando de arranque no existe dentro del contenedor.';
    case 1:
      return 'Código 1: la aplicación terminó con error genérico; revisa sus logs para ver la excepción exacta.';
    case 0:
      return 'Código 0: el proceso terminó "bien" pero no debería haber terminado. ¿El comando de arranque ejecuta un proceso de larga duración?';
    default:
      return code === null
        ? 'Sin código de salida registrado.'
        : `Código de salida ${code}. Revisa los logs del servicio para ver el error de la aplicación.`;
  }
}
