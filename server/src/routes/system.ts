import fs from 'fs';
import os from 'os';
import net from 'net';
import { spawn } from 'child_process';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdmin, requireAuth, requireSession } from '../auth';
import { audit } from '../audit';
import { config } from '../config';
import { getSetting, setSetting } from '../db';
import { dockerDiskTotals, hostDisk } from '../disk';
import { dockerAvailable } from '../docker/client';
import { dockerErrorText } from '../docker/resources';
import { findOrphanBackups, findOrphanVolumes, OrphanVolume, purgeOrphans } from '../purge';
import { nixpacksAvailable } from '../deploy/builder';
import { channelsConfigured, dispatchToChannels } from '../notify';
import { verifyGithubToken } from '../github/client';
import { domainSchema } from './services';
import {
  SYSTEM_BACKUP_RETENTION,
  createSystemBackup,
  deleteSystemBackup,
  listSystemBackups,
  pruneSystemBackups,
  resolveSystemBackupFile,
} from '../sysbackup';

/** Palabra que hay que escribir para eliminar datos sin proyecto. */
const ORPHAN_CONFIRM_WORD = 'eliminar';

/** Tope de cada `docker … prune`: liberar espacio no debería llevar más. */
const PRUNE_TIMEOUT_MS = 5 * 60_000;

const SETTINGS_KEYS = [
  'rootDomain',
  'letsencryptEmail',
  'serverIp',
  'serverIpv6',
  'alertCpuPercent',
  'alertMemPercent',
  'alertSustainMinutes',
  'alertWebhookUrl',
  'alertDiscordUrl',
  'alertTelegramChat',
] as const;

/** Núcleos del host: no cambian en caliente, y `os.cpus()` construye la lista entera en cada llamada. */
const HOST_CPUS = os.cpus().length;

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);

    // Lo consulta cualquier usuario (el Layout pinta CPU/RAM), pero la ruta del
    // directorio de datos del host es detalle interno: solo la ve el admin.
    secured.get('/api/system', async (req) => ({
      version: config.version,
      docker: await dockerAvailable(),
      nixpacks: await nixpacksAvailable(),
      host: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: HOST_CPUS,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        load: os.loadavg().map((n) => Math.round(n * 100) / 100),
        uptime: os.uptime(),
      },
      disk: await hostDisk(),
      ...(currentUser(req)?.role === 'admin' ? { dataDir: config.dataDir } : {}),
    }));

    /** Desglose de lo que ocupa Docker (imágenes, contenedores, volúmenes, caché). */
    secured.get('/api/system/docker-usage', { preHandler: requireAdmin }, async (_req, reply) => {
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      try {
        // Del mismo `df` cacheado (60 s) que usa Monitor: no un segundo `df` sin tope por petición.
        return await dockerDiskTotals();
      } catch (err: any) {
        return reply.code(503).send({ error: err?.message || 'No se pudo consultar el uso de Docker' });
      }
    });

    /** Libera espacio: imágenes colgantes y caché de build (nunca volúmenes). */
    secured.post('/api/system/prune', { preHandler: requireAdmin }, async (req, reply) => {
      if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker no está disponible' });
      const run = (args: string[]) =>
        new Promise<string>((resolve) => {
          const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          p.stdout.on('data', (c) => (out += c.toString()));
          p.stderr.on('data', (c) => (out += c.toString()));
          // Un daemon que se atasca borrando capas dejaba la petición colgada
          // sin límite; pasado el plazo se corta y se contesta con lo que hay.
          const timer = setTimeout(() => {
            try {
              p.kill('SIGKILL');
            } catch {
              /* ya terminó */
            }
            out += '\n(se interrumpió: la limpieza tardó demasiado)';
          }, PRUNE_TIMEOUT_MS);
          p.on('error', (e) => {
            clearTimeout(timer);
            resolve(`error: ${e.message}`);
          });
          p.on('exit', () => {
            clearTimeout(timer);
            resolve(out);
          });
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

    // ---------- datos sin proyecto ----------
    /**
     * Volúmenes y copias de seguridad que dejaron proyectos o servicios ya
     * borrados (ver la regla en `purge.ts`). Solo el administrador y con
     * sesión de navegador: borrar datos no es algo que deba poder hacer un
     * token de API, ni siquiera el de un administrador; listarlos tampoco hace
     * falta fuera del panel.
     */
    secured.get('/api/system/orphans', { preHandler: [requireAdmin, requireSession] }, async () => {
      const docker = await dockerAvailable();
      let volumes: OrphanVolume[] = [];
      let volumesError: string | null = null;
      if (docker) {
        try {
          volumes = await findOrphanVolumes();
        } catch (err) {
          volumesError = `No se ha podido consultar Docker: ${dockerErrorText(err)}`;
        }
      }
      return { docker, volumes, volumesError, backups: findOrphanBackups(), confirmWord: ORPHAN_CONFIRM_WORD };
    });

    /**
     * Elimina los datos sin proyecto indicados. El servidor vuelve a calcular
     * la lista y solo borra lo que sigue siendo huérfano; el resto vuelve en
     * `skipped` con el motivo. Cada borrado queda en la auditoría.
     */
    secured.post('/api/system/orphans/purge', { preHandler: [requireAdmin, requireSession] }, async (req, reply) => {
      const body = z
        .object({
          confirm: z.string().max(100).default(''),
          volumes: z.array(z.string().trim().min(1).max(255)).max(1000).default([]),
          backups: z.array(z.string().trim().min(1).max(64)).max(1000).default([]),
        })
        .parse(req.body ?? {});
      if (body.confirm.trim().toLowerCase() !== ORPHAN_CONFIRM_WORD) {
        return reply.code(400).send({ error: `Escribe «${ORPHAN_CONFIRM_WORD}» para confirmar. No se ha eliminado nada.` });
      }
      if (body.volumes.length === 0 && body.backups.length === 0) {
        return reply.code(400).send({ error: 'Indica qué volúmenes o copias de seguridad quieres eliminar.' });
      }
      if (body.volumes.length > 0 && !(await dockerAvailable(true))) {
        return reply.code(503).send({ error: 'Docker no está disponible: no se ha eliminado nada.' });
      }
      const result = await purgeOrphans({ volumes: body.volumes, backups: body.backups }, (kind, _name, detail) => {
        audit(req, kind === 'volume' ? 'orphan_volume_deleted' : 'orphan_backup_deleted', {
          type: 'system',
          id: kind === 'volume' ? 'docker' : 'backups',
          detail,
        });
      });
      return result;
    });

    secured.get('/api/settings', { preHandler: requireAdmin }, async () => {
      const out: Record<string, string | boolean | null> = {};
      for (const key of SETTINGS_KEYS) out[key] = getSetting(key);
      out.hasGithubToken = !!getSetting('githubToken');
      out.hasTelegramToken = !!getSetting('alertTelegramToken');
      return { settings: out };
    });

    secured.put('/api/settings', { preHandler: requireAdmin }, async (req) => {
      const body = z
        .object({
          // Del dominio raíz salen los subdominios que el panel propone para
          // los servicios, y esos acaban en reglas Host() de Traefik.
          rootDomain: z.union([domainSchema, z.literal('')]).optional(),
          letsencryptEmail: z.union([z.string().trim().email(), z.literal('')]).optional(),
          serverIp: z.union([z.string().trim().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'IP inválida'), z.literal('')]).optional(),
          // Solo para dar por buenos los AAAA que apuntan a este servidor: si
          // no se indica, cualquier AAAA de un dominio se trata como ajeno.
          serverIpv6: z
            .union([z.string().trim().toLowerCase().refine((v) => net.isIPv6(v), 'IPv6 no válida'), z.literal('')])
            .optional(),
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
      setIf('serverIp', body.serverIp);
      setIf('serverIpv6', body.serverIpv6);
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

    /** Valida el token de GitHub: el guardado, o uno pasado para probar antes de guardar. */
    secured.post('/api/settings/github/test', { preHandler: requireAdmin }, async (req, reply) => {
      const body = z.object({ token: z.string().trim().optional() }).parse(req.body ?? {});
      const token = body.token || getSetting('githubToken');
      if (!token) return reply.code(400).send({ error: 'No hay ningún token de GitHub configurado' });
      try {
        const identity = await verifyGithubToken(token);
        return { ok: true, ...identity };
      } catch (err: any) {
        return reply.code(502).send({ error: err?.message || 'No se pudo validar el token' });
      }
    });

    /** Elimina el token de GitHub guardado. */
    secured.delete('/api/settings/github', { preHandler: requireAdmin }, async (req) => {
      setSetting('githubToken', null);
      audit(req, 'github_token_removed', { type: 'system', id: 'github' });
      return { ok: true };
    });

    // ---------- backups del propio panel (skyway.db) ----------
    /** Lista los snapshots de la base de datos del panel. */
    secured.get('/api/system/backups', { preHandler: requireAdmin }, async () => ({
      backups: listSystemBackups(),
      retention: SYSTEM_BACKUP_RETENTION,
      dataDir: config.dataDir,
    }));

    /** Crea un snapshot ahora (VACUUM INTO, consistente con la BD en uso). */
    secured.post('/api/system/backups', { preHandler: requireAdmin }, async (req, reply) => {
      try {
        const backup = createSystemBackup();
        pruneSystemBackups();
        audit(req, 'system_backup_created', { type: 'system', id: 'skyway-db', detail: backup.file });
        reply.code(201);
        return { backup };
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || 'No se pudo crear el backup del panel' });
      }
    });

    /**
     * Descarga un snapshot (para guardarlo fuera del servidor). Exige sesión de
     * navegador: la copia lleva en claro los secretos que la API nunca
     * devuelve (el token de Cloudflare del operador, el de Mailway, el de
     * GitHub…), y un token de API de administrador —el de una automatización o
     * uno robado— no debe poder llevárselos. Crearla, listarla y borrarla sí
     * se puede con token: no sacan nada del servidor.
     */
    secured.get('/api/system/backups/:file/download', { preHandler: [requireAdmin, requireSession] }, async (req, reply) => {
      const { file } = req.params as { file: string };
      const full = resolveSystemBackupFile(file);
      if (!full) return reply.code(404).send({ error: 'Backup no encontrado' });
      audit(req, 'system_backup_downloaded', { type: 'system', id: 'skyway-db', detail: file });
      reply.header('Content-Disposition', `attachment; filename="${file}"`);
      reply.type('application/octet-stream');
      return reply.send(fs.createReadStream(full));
    });

    secured.delete('/api/system/backups/:file', { preHandler: requireAdmin }, async (req, reply) => {
      const { file } = req.params as { file: string };
      if (!deleteSystemBackup(file)) return reply.code(404).send({ error: 'Backup no encontrado' });
      audit(req, 'system_backup_deleted', { type: 'system', id: 'skyway-db', detail: file });
      return { ok: true };
    });

    /** Envía una notificación de prueba a los canales configurados. */
    secured.post('/api/settings/alerts/test', { preHandler: requireAdmin }, async (_req, reply) => {
      const channels = channelsConfigured();
      if (channels.length === 0) {
        return reply.code(400).send({ error: 'No hay ningún canal configurado. Guarda primero los ajustes.' });
      }
      const failures = await dispatchToChannels({
        severity: 'info',
        title: 'Notificación de prueba',
        message: 'Si lees esto, Skyway puede avisarte por este canal.',
      });
      return { ok: failures.length === 0, channels, failures };
    });
  });
}
