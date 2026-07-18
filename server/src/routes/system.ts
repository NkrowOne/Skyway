import os from 'os';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { audit } from '../audit';
import { config } from '../config';
import { getSetting, setSetting } from '../db';
import { dockerAvailable } from '../docker/client';
import { nixpacksAvailable } from '../deploy/builder';
import { channelsConfigured, dispatchToChannels } from '../notify';

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
      dataDir: config.dataDir,
    }));

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
