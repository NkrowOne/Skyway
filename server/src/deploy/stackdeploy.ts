import { getDeployment, getProject, getService, updateDeployment } from '../db';
import { emitDeploy } from '../events';
import { containerName, execInContainer } from '../docker/containers';
import { StackDef } from '../stacks';
import { awaitDeployment, triggerDeploy } from './deployer';

/**
 * Despliegue coordinado de una pila. Los servicios NO se pueden lanzar todos a
 * la vez: el que depende de la base de datos se cae en bucle si la base aún no
 * acepta conexiones, y Skyway daría por fallido ese primer despliegue. Así que
 * se despliegan por etapas, esperando a que cada base esté realmente lista
 * antes de arrancar lo que cuelga de ella.
 */

const READY_TIMEOUT_MS = 5 * 60_000;
const READY_INTERVAL_MS = 3_000;

export interface StackStep {
  serviceId: string;
  /** Clave del servicio dentro de la pila (la de StackServiceDef). */
  key: string;
  stage: number;
  readyCmd?: string;
}

/**
 * Escribe en el log del despliegue ya terminado. Las esperas y el SQL de
 * inicialización ocurren DESPUÉS de que su despliegue acabe, y este es el sitio
 * donde el usuario los va a buscar.
 */
function appendLog(deploymentId: string, line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
  const row = getDeployment(deploymentId);
  if (row) updateDeployment(deploymentId, { logs: `${row.logs}${stamped}\n` });
  emitDeploy(deploymentId, { type: 'log', line: stamped });
}

/** Sondea un comando dentro del contenedor hasta que salga con código 0. */
async function waitUntilReady(
  container: string,
  cmd: string,
  log: (line: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  log(`Esperando a que el servicio acepte conexiones (hasta ${READY_TIMEOUT_MS / 60_000} min)...`);
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await execInContainer(container, cmd, { timeoutMs: 15_000, maxOutput: 4_000 });
      if (res.exitCode === 0) {
        log('Listo: acepta conexiones.');
        return true;
      }
      lastError = res.output.trim().split('\n').pop() || `código ${res.exitCode}`;
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  log(`✖ Sigue sin aceptar conexiones tras ${READY_TIMEOUT_MS / 60_000} min (${lastError}).`);
  return false;
}

/** Aplica el SQL de inicialización de la pila dentro del contenedor de la base. */
async function applyPostInit(
  container: string,
  stack: StackDef,
  log: (line: string) => void,
): Promise<void> {
  const postInit = stack.postInit!;
  log(`Aplicando la inicialización de ${stack.label} (${postInit.description})...`);
  // El SQL viaja por variable de entorno del exec y NUNCA se interpola en el
  // shell (mismo patrón que la consola de datos); las credenciales que necesita
  // las lee psql del propio entorno del contenedor.
  const res = await execInContainer(
    container,
    'printf "%s" "$SKYWAY_STACK_SQL" | psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -f -',
    { env: [`SKYWAY_STACK_SQL=${postInit.sql}`], timeoutMs: 120_000 },
  );
  if (res.exitCode === 0) {
    log('Inicialización aplicada.');
    return;
  }
  log(`✖ La inicialización falló (código ${res.exitCode ?? 'n/a'}):`);
  for (const line of res.output.trim().split('\n').slice(-15)) log(`  ${line}`);
  log('La pila puede quedar a medias: revisa el error y vuelve a desplegar este servicio.');
}

/**
 * Despliega los servicios de una pila por etapas. Se ejecuta en segundo plano:
 * cada servicio tiene su propio despliegue con su log, como cualquier otro.
 */
export async function runStackDeploy(stack: StackDef, steps: StackStep[]): Promise<void> {
  const stages = [...new Set(steps.map((s) => s.stage))].sort((a, b) => a - b);

  for (const stage of stages) {
    await Promise.all(
      steps
        .filter((s) => s.stage === stage)
        .map(async (step) => {
          const service = getService(step.serviceId);
          const project = service ? getProject(service.project_id) : undefined;
          if (!service || !project) return;

          const deployment = triggerDeploy(step.serviceId, 'stack');
          const finished = await awaitDeployment(deployment.id);
          const log = (line: string) => appendLog(deployment.id, line);
          if (finished?.status !== 'success') return; // su propio log ya explica el fallo

          const container = containerName(project, service);
          if (step.readyCmd) {
            const ready = await waitUntilReady(container, step.readyCmd, log);
            if (!ready) return;
          }
          if (stack.postInit && stack.postInit.service === step.key) {
            await applyPostInit(container, stack, log);
          }
        }),
    );
  }
}
