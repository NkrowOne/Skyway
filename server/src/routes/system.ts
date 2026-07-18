import os from 'os';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { config } from '../config';
import { getSetting, setSetting } from '../db';
import { dockerAvailable } from '../docker/client';
import { nixpacksAvailable } from '../deploy/builder';

const SETTINGS_KEYS = ['rootDomain', 'letsencryptEmail'] as const;

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    secured.get('/api/system', async () => ({
      version: config.version,
      docker: await dockerAvailable(),
      nixpacks: await nixpacksAvailable(),
      host: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        load: os.loadavg().map((n) => Math.round(n * 100) / 100),
        uptime: os.uptime(),
      },
      dataDir: config.dataDir,
    }));

    secured.get('/api/settings', async () => {
      const out: Record<string, string | boolean | null> = {};
      for (const key of SETTINGS_KEYS) out[key] = getSetting(key);
      out.hasGithubToken = !!getSetting('githubToken');
      return { settings: out };
    });

    secured.put('/api/settings', async (req) => {
      const body = z
        .object({
          rootDomain: z.string().trim().optional(),
          letsencryptEmail: z.union([z.string().trim().email(), z.literal('')]).optional(),
          githubToken: z.string().trim().optional(),
        })
        .parse(req.body);
      if (body.rootDomain !== undefined) setSetting('rootDomain', body.rootDomain || null);
      if (body.letsencryptEmail !== undefined) setSetting('letsencryptEmail', body.letsencryptEmail || null);
      if (body.githubToken !== undefined) setSetting('githubToken', body.githubToken || null);
      return { ok: true };
    });
  });
}
