import { Diagnosis } from '../types';

interface Rule {
  id: string;
  test: (error: string, logs: string) => boolean;
  title: string;
  cause: string;
  fix: string;
}

const has = (haystack: string, ...needles: string[]) => {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
};

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
  {
    id: 'repo-not-found',
    test: (e, l) => has(e + l, 'repository not found', 'could not read username', 'authentication failed', 'invalid username or token'),
    title: 'No se pudo clonar el repositorio',
    cause: 'La URL no existe o el repositorio es privado y Skyway no tiene credenciales válidas para leerlo.',
    fix: 'Revisa la URL del repo. Si es privado, configura un token de GitHub (con permiso `repo`) en Ajustes → GitHub y vuelve a desplegar.',
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
    id: 'build-npm',
    test: (e, l) => has(e, 'docker terminó con código') && has(l, 'npm err', 'yarn error', 'pnpm err'),
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
    id: 'container-died',
    test: (e) => has(e, 'El contenedor terminó inesperadamente'),
    title: 'La aplicación arrancó pero se cerró enseguida',
    cause: 'La imagen se construyó bien, pero el proceso murió nada más arrancar: suele ser una variable de entorno que falta (p. ej. DATABASE_URL), un error de conexión a la base de datos, o un puerto interno mal configurado.',
    fix: 'Abre la pestaña Logs del servicio para ver el error exacto de tu aplicación. Comprueba las Variables (¿faltan credenciales?) y que el "Puerto interno" coincide con el que escucha tu app.',
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
  const tail = logs.slice(-6000);
  for (const rule of RULES) {
    if (rule.test(error, tail)) {
      return { id: rule.id, title: rule.title, cause: rule.cause, fix: rule.fix };
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
