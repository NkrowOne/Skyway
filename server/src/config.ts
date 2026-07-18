import path from 'path';
import fs from 'fs';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  buildsDir: path.join(dataDir, 'builds'),
  webDist: process.env.WEB_DIST
    ? path.resolve(process.env.WEB_DIST)
    : path.resolve(__dirname, '../../web/dist'),
  jwtSecretEnv: process.env.JWT_SECRET || null,
  buildConcurrency: Number(process.env.BUILD_CONCURRENCY || 2),
  version: '0.1.0',
};

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.buildsDir, { recursive: true });
}
