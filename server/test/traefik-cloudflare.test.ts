/**
 * Traefik detrás del proxy de Cloudflare: en el 443 respeta el
 * X-Forwarded-For de Cloudflare, y solo de sus rangos, para que las apps
 * reciban la IP del visitante. La lista del docker-compose.yml tiene que ser
 * exactamente la de `CLOUDFLARE_IPV4` y `CLOUDFLARE_IPV6`, y en el 80 no se
 * confía en nadie: el bucle del modo «Flexible» tiene que seguir viéndose (si
 * Traefik creyera el «https» que Cloudflare manda por el 80, la web se
 * serviría sin cifrar entre Cloudflare y el servidor sin que nadie lo notara).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from '../src/domains';

const compose = fs.readFileSync(path.resolve(__dirname, '../../docker-compose.yml'), 'utf8');
/** Los flags de los «command» del compose (`- --algo=valor`). */
const flags = compose
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('- --'))
  .map((l) => l.slice(2));

describe('Traefik detrás del proxy de Cloudflare', () => {
  it('en el 443 confía exactamente en los rangos publicados de Cloudflare', () => {
    const confianza = flags.filter((f) => f.startsWith('--entrypoints.websecure.forwardedHeaders.trustedIPs='));
    expect(confianza).toHaveLength(1);
    expect(confianza[0].split('=')[1].split(',')).toEqual([...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6]);
  });

  it('en el 80 no confía en nadie, y en ningún puerto en cualquiera', () => {
    expect(flags.filter((f) => f.startsWith('--entrypoints.web.forwardedHeaders'))).toEqual([]);
    expect(flags.filter((f) => f.includes('forwardedHeaders.insecure'))).toEqual([]);
  });
});
