import Database from 'better-sqlite3';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import {
  activeDeploymentsByProject,
  closeDb,
  createDeployment,
  createProject,
  createService,
  createWorkspaceRow,
  getDeployment,
  getService,
  initDb,
  insertAlert,
  insertAudit,
  listAudit,
  listWorkspaceAlerts,
  resolveAlertsByDedupe,
  setServiceStopped,
  successfulDeploymentsBeyond,
  updateDeployment,
} from '../src/db';
import { decoyPasswordHash, hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync } from '../src/util';

// Conexión propia a la misma base para consultar el catálogo y los planes de
// consulta sin pasar por la API de `db.ts`.
let raw: Database.Database;

beforeAll(() => {
  initDb();
  raw = new Database(path.join(config.dataDir, 'skyway.db'));
});

afterAll(() => {
  raw.close();
  closeDb();
});

describe('migraciones', () => {
  it('son idempotentes: un segundo initDb sobre la misma base no falla', () => {
    expect(() => initDb()).not.toThrow();
  });

  it('crean los índices de despliegues activos y de alertas por workspace', () => {
    const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(idx).toContain('idx_deployments_active');
    expect(idx).toContain('idx_alerts_workspace');
  });
});

describe('despliegues', () => {
  const project = { id: '' };
  const service = { id: '' };

  beforeAll(() => {
    const p = createProject('Demo', 'demo');
    const s = createService(p.id, 'web', 'web', 'image', { image: 'nginx', domains: [] });
    project.id = p.id;
    service.id = s.id;
  });

  it('createDeployment limpia stopped_at y aparece como despliegue activo del proyecto', () => {
    setServiceStopped(service.id, true);
    const d = createDeployment(service.id, 'manual');
    expect(getService(service.id)!.stopped_at).toBeNull();
    expect(activeDeploymentsByProject(project.id)[service.id]?.id).toBe(d.id);
  });

  it('las consultas de despliegues activos usan el índice parcial', () => {
    const plan = raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT d.id FROM deployments d JOIN services s ON s.id = d.service_id
          WHERE s.project_id = ? AND d.status IN ('queued', 'building', 'deploying')`,
      )
      .all(project.id) as { detail: string }[];
    expect(plan.some((r) => r.detail.includes('idx_deployments_active'))).toBe(true);

    const plan2 = raw
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM deployments WHERE status IN ('queued', 'building', 'deploying')")
      .all() as { detail: string }[];
    expect(plan2.some((r) => r.detail.includes('idx_deployments_active'))).toBe(true);
  });

  it('updateDeployment ignora claves fuera de la lista blanca y successfulDeploymentsBeyond no arrastra logs', () => {
    const d = activeDeploymentsByProject(project.id)[service.id];
    // La clave `evil` no está en la lista blanca: ni rompe ni se escribe.
    updateDeployment(d.id, {
      status: 'success',
      image_tag: 'img:1',
      logs: 'x'.repeat(1000),
      finished_at: 1,
      evil: 1,
    } as Parameters<typeof updateDeployment>[1]);
    expect(getDeployment(d.id)!.status).toBe('success');

    const d2 = createDeployment(service.id, 'manual');
    updateDeployment(d2.id, { status: 'success', image_tag: 'img:2', logs: 'y'.repeat(1000), finished_at: 2 });

    const beyond = successfulDeploymentsBeyond(service.id, 1);
    expect(beyond).toHaveLength(1);
    expect(beyond[0].id).toBe(d.id);
    expect(beyond[0].logs).toBe('');
    expect(beyond[0].image_tag).toBe('img:1');
  });
});

describe('alertas', () => {
  it('deduplica de forma atómica por dedupe_key y vuelve a crearse tras resolver', () => {
    const base = { severity: 'warning' as const, type: 't', title: 'a', message: 'm', dedupe_key: 'k1' };
    const a1 = insertAlert(base);
    const a2 = insertAlert(base);
    expect(a1).not.toBeNull();
    expect(a2).toBeNull();

    resolveAlertsByDedupe('k1');
    expect(insertAlert(base)).not.toBeNull();
  });

  it('las alertas de un workspace se listan por su id', () => {
    const ws = createWorkspaceRow('Acme');
    insertAlert({ severity: 'info', type: 'bill', workspace_id: ws.id, title: 'w', message: 'm' });
    expect(listWorkspaceAlerts(ws.id)).toHaveLength(1);
  });
});

describe('auditoría', () => {
  it('filtra por prefijo literal: % y _ no actúan como comodines', () => {
    insertAudit({ actor: 'x', action: 'login_failed', target_type: null, target_id: null, detail: null, ip: null });
    insertAudit({ actor: 'x', action: 'logout', target_type: null, target_id: null, detail: null, ip: null });
    expect(listAudit({ action: 'login' })).toHaveLength(1);
    expect(listAudit({ action: 'log%' })).toHaveLength(0);
    expect(listAudit({ action: 'login_' })).toHaveLength(1);
    expect(listAudit({ action: 'logi_' })).toHaveLength(0);
  });
});

describe('contraseñas', () => {
  it('los hashes síncrono y asíncrono son intercambiables', async () => {
    const h1 = hashPassword('secreto123');
    const h2 = await hashPasswordAsync('secreto123');
    expect(await verifyPasswordAsync('secreto123', h1)).toBe(true);
    expect(verifyPassword('secreto123', h2)).toBe(true);
    expect(await verifyPasswordAsync('otra', h2)).toBe(false);
    expect(await verifyPasswordAsync('secreto123', 'basura')).toBe(false);
  });

  it('el hash señuelo es estable por proceso y no verifica nada', async () => {
    const decoy = decoyPasswordHash();
    expect(decoyPasswordHash()).toBe(decoy);
    expect(await verifyPasswordAsync('', decoy)).toBe(false);
  });
});
