import { FastifyInstance } from 'fastify';
import { canAccessProject, currentUser, requireAuth } from '../auth';
import { getSetting, listDeployments, listProjects, listServices, openAlertCountsByService } from '../db';
import { dockerAvailable } from '../docker/client';
import { aggregateReplicaState, configuredReplicas, getRuntime, replicaName } from '../docker/containers';
import { ContainerState } from '../types';

/**
 * Vista global de sitios web: todos los servicios desplegables (repo/imagen)
 * de todos los proyectos accesibles, con su estado, dominios y último deploy.
 */
export async function websiteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/websites', async (req) => {
    const user = currentUser(req)!;
    const dockerUp = await dockerAvailable();
    const tls = !!getSetting('letsencryptEmail');
    const sites: any[] = [];

    for (const project of listProjects()) {
      if (!canAccessProject(user, project.id)) continue;
      const alertCounts = openAlertCountsByService(project.id);
      for (const service of listServices(project.id)) {
        if (service.type === 'database') continue;
        const cfg = service.config as any;
        const total = configuredReplicas(service);
        let running = 0;
        const states: ContainerState[] = [];
        let startedAt: string | null = null;
        if (dockerUp) {
          for (let i = 1; i <= total; i++) {
            try {
              const runtime = await getRuntime(replicaName(project, service, i));
              states.push(runtime.state);
              if (runtime.state === 'running') {
                running += 1;
                if (!startedAt) startedAt = runtime.startedAt;
              }
            } catch {
              /* réplica ilocalizable */
            }
          }
        }
        const lastDeploy = listDeployments(service.id, 1)[0] ?? null;
        sites.push({
          id: service.id,
          name: service.name,
          type: service.type,
          image: service.type === 'image' ? cfg.image : undefined,
          repoUrl: service.type === 'git' ? cfg.repoUrl : undefined,
          projectId: project.id,
          projectName: project.name,
          client: project.client,
          domains: cfg.domains ?? [],
          hostPort: cfg.hostPort ?? null,
          state: aggregateReplicaState(states),
          startedAt,
          replicas: { running, total },
          alerts: alertCounts[service.id] ?? 0,
          lastDeploy: lastDeploy
            ? { status: lastDeploy.status, created_at: lastDeploy.created_at, finished_at: lastDeploy.finished_at }
            : null,
        });
      }
    }

    // Con dominio primero (son los "sitios"), después el resto, por nombre.
    sites.sort((a, b) => {
      const ad = a.domains.length > 0 ? 0 : 1;
      const bd = b.domains.length > 0 ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name);
    });

    return { sites, tls, serverIp: getSetting('serverIp') };
  });
}
