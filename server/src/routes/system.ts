import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { audit } from '../audit';
import { config } from '../config';
import { getSetting, setSetting } from '../db';
import { docker, dockerAvailable } from '../docker/client';
import { nixpacksAvailable } from '../deploy/builder';
import { channelsConfigured, dispatchToChannels } from '../notify';

export async function diskUsage(): Promise<{ total: number; free: number } | null> {
  try {
    const st = await fs.promises.statfs(config.dataDir);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}

const SETTINGS_KEYS = [
  'rootDomain',
  'letsencryptEmail',
  'alertCpuPercent',
  'alertMemPercent',
  'alertSustainMinutes',
  'alertWebhookUrl',
  'alertDiscordUrl',
  'alertTelegramChat',
] as const;

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
      disk: await diskUsage(),
      dataDir: config.dataDir,
    }));

    /** Desglose de lo que ocupa Docker (imágenes, contenedores, volúmenes, caché). */
    secured.get('/api/system/docker-usage', async (_req, reply) => {
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      try {
        const df: any = await docker.df();
        const sum = (arr: any[], pick: (x: any) => number) => (arr || []).reduce((acc, x) => acc + (pick(x) || 0), 0);
        return {
          images: { count: (df.Images || []).length, size: df.LayersSize || sum(df.Images || [], (i) => i.Size) },
          containers: { count: (df.Containers || []).length, size: sum(df.Containers || [], (c) => c.SizeRw) },
          volumes: {
            count: (df.Volumes || []).length,
            size: sum(df.Volumes || [], (v) => Math.max(0, v.UsageData?.Size ?? 0)),
          },
          buildCache: { size: sum(df.BuildCache || [], (b) => b.Size) },
        };
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || 'No se pudo consultar el uso de Docker' });
      }
    });

    /** Libera espacio: imágenes colgantes y caché de build (nunca volúmenes). */
    secured.post('/api/system/prune', async (req, reply) => {
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const run = (args: string[]) =>
        new Promise<string>((resolve) => {
          const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          p.stdout.on('data', (c) => (out += c.toString()));
          p.stderr.on('data', (c) => (out += c.toString()));
          p.on('error', (e) => resolve(`error: ${e.message}`));
          p.on('exit', () => resolve(out));
        });
      const imageOut = await run(['image', 'prune', '-f']);
      const builderOut = await run(['builder', 'prune', '-f']);
      const reclaimed = [imageOut, builderOut]
        .map((o) => o.match(/Total reclaimed space:\s*(.+)/i)?.[1]?.trim())
        .filter(Boolean)
        .join(' + ') || '0B';
      audit(req, 'system_prune', { type: 'system', id: 'docker', detail: `liberado: ${reclaimed}` });
      return { ok: true, reclaimed };
    });

    secured.get('/api/settings', async () => {
      const out: Record<string, string | boolean | null> = {};
      for (const key of SETTINGS_KEYS) out[key] = getSetting(key);
      out.hasGithubToken = !!getSetting('githubToken');
      out.hasTelegramToken = !!getSetting('alertTelegramToken');
      return { settings: out };
    });

    secured.put('/api/settings', async (req) => {
      const body = z
        .object({
          rootDomain: z.string().trim().optional(),
          letsencryptEmail: z.union([z.string().trim().email(), z.literal('')]).optional(),
          githubToken: z.string().trim().optional(),
          alertCpuPercent: z.union([z.coerce.number().min(10).max(100), z.literal('')]).optional(),
          alertMemPercent: z.union([z.coerce.number().min(10).max(100), z.literal('')]).optional(),
          alertSustainMinutes: z.union([z.coerce.number().min(1).max(120), z.literal('')]).optional(),
          alertWebhookUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
          alertDiscordUrl: z.union([z.string().trim().url(), z.literal('')]).optional(),
          alertTelegramToken: z.string().trim().optional(),
          alertTelegramChat: z.string().trim().optional(),
        })
        .parse(req.body);

      const setIf = (key: string, value: string | number | undefined) => {
        if (value !== undefined) setSetting(key, value === '' ? null : String(value));
      };
      setIf('rootDomain', body.rootDomain);
      setIf('letsencryptEmail', body.letsencryptEmail);
      setIf('githubToken', body.githubToken);
      setIf('alertCpuPercent', body.alertCpuPercent);
      setIf('alertMemPercent', body.alertMemPercent);
      setIf('alertSustainMinutes', body.alertSustainMinutes);
      setIf('alertWebhookUrl', body.alertWebhookUrl);
      setIf('alertDiscordUrl', body.alertDiscordUrl);
      setIf('alertTelegramToken', body.alertTelegramToken);
      setIf('alertTelegramChat', body.alertTelegramChat);
      audit(req, 'settings_updated');
      return { ok: true };
    });

    /** Envía una notificación de prueba a los canales configurados. */
    secured.post('/api/settings/alerts/test', async (_req, reply) => {
      const channels = channelsConfigured();
      if (channels.length === 0) {
        return reply.code(400).send({ error: 'No hay ningún canal configurado. Guarda primero los ajustes.' });
      }
      const failures = await dispatchToChannels({
        severity: 'info',
        title: 'Notificación de prueba',
        message: 'Si lees esto, Skyway puede avisarte por este canal. ✅',
      });
      return { ok: failures.length === 0, channels, failures };
    });
  });
}
