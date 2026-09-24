/**
 * Reparto de las variables del servicio para el `docker run` del comando previo
 * al despliegue (`preDeployCommand`).
 *
 * Ese `docker run` es un proceso hijo de Skyway, y `--env CLAVE` (sin valor) le
 * pide al CLI que lea el valor de SU propio entorno; para que funcionara, las
 * variables del servicio se le entregaban tal cual como entorno. Pero el CLI
 * resuelve con ese mismo entorno su binario y su conexión con el demonio: `PATH`
 * decide qué ejecutable `docker` arranca, `LD_*` qué bibliotecas carga,
 * `DOCKER_HOST`/`DOCKER_CONFIG` contra qué demonio habla y con qué credenciales,
 * `*_PROXY` y `SSL_CERT_*` por dónde sale y en quién confía. Quien puede editar
 * las variables de un servicio podía así ejecutar lo que quisiera en el proceso
 * de Skyway, que tiene el socket de Docker del anfitrión.
 *
 * Los nombres reservados van en `explicit`: se pasan como `--env CLAVE=VALOR`,
 * de modo que el contenedor los recibe igual pero el proceso `docker` no los ve
 * en su entorno. El resto va en `inherited` y viaja como hasta ahora (entorno
 * del hijo más `--env CLAVE`), sin dejar el valor en la línea de órdenes.
 */

/**
 * Nombres que el CLI de Docker, el cargador dinámico o las herramientas que ese
 * CLI puede invocar (git, ayudantes de credenciales, Node) respetan al arrancar.
 * La comparación es exacta y distingue mayúsculas: `MY_PATH` o `PATHFINDER` no
 * tienen nada que ver con `PATH`.
 */
export const PRE_DEPLOY_RESERVED_NAME =
  /^(?:PATH|HOME|SHELL|USER|LOGNAME|TMPDIR|PWD|IFS|CURL_CA_BUNDLE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|http_proxy|https_proxy|no_proxy|all_proxy|(?:LD|DOCKER|SSL_CERT|GIT|NODE)_\w*)$/;

export function partitionPreDeployEnv(
  vars: Record<string, string>,
): { inherited: Record<string, string>; explicit: Record<string, string> } {
  const inherited: Record<string, string> = {};
  const explicit: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    (PRE_DEPLOY_RESERVED_NAME.test(key) ? explicit : inherited)[key] = value;
  }
  return { inherited, explicit };
}
