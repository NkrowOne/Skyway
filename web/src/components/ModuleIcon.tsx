import { Package } from 'lucide-react';
import { Service } from '../types';
import { cx } from '../utils';
import dockerSvg from '../assets/icons/docker.svg?raw';
import githubSvg from '../assets/icons/github.svg?raw';
import mongodbSvg from '../assets/icons/mongodb.svg?raw';
import mysqlSvg from '../assets/icons/mysql.svg?raw';
import n8nSvg from '../assets/icons/n8n.svg?raw';
import postgresqlSvg from '../assets/icons/postgresql.svg?raw';
import redisSvg from '../assets/icons/redis.svg?raw';
import wordpressSvg from '../assets/icons/wordpress.svg?raw';

export type ModuleKind = 'github' | 'postgres' | 'redis' | 'mysql' | 'mongo' | 'wordpress' | 'n8n' | 'docker' | 'generic';

const SVGS: Record<Exclude<ModuleKind, 'generic'>, string> = {
  github: githubSvg,
  postgres: postgresqlSvg,
  redis: redisSvg,
  mysql: mysqlSvg,
  mongo: mongodbSvg,
  wordpress: wordpressSvg,
  n8n: n8nSvg,
  docker: dockerSvg,
};

/** Colores de chip por módulo (logos oficiales simple-icons sobre tinte de su marca). */
const CHIP: Record<ModuleKind, { bg: string; fg: string }> = {
  github: { bg: 'color-mix(in oklab, var(--color-txt) 9%, transparent)', fg: 'var(--color-txt)' },
  postgres: { bg: 'rgba(51,103,145,.28)', fg: '#93bce2' },
  redis: { bg: 'rgba(220,56,44,.16)', fg: '#e0837b' },
  mysql: { bg: 'rgba(68,121,161,.22)', fg: '#8ab4d4' },
  mongo: { bg: 'rgba(71,162,72,.16)', fg: '#7fc98a' },
  wordpress: { bg: 'rgba(33,117,155,.22)', fg: '#7db8d4' },
  n8n: { bg: 'rgba(234,75,113,.16)', fg: '#ef8ba5' },
  docker: { bg: 'rgba(36,150,237,.16)', fg: '#7cbdf0' },
  generic: { bg: 'color-mix(in oklab, var(--color-warn) 13%, transparent)', fg: 'var(--color-warn)' },
};

/** Deduce el módulo a partir del servicio (repo, plantilla de BD o nombre de imagen). */
export function moduleKind(service: Pick<Service, 'type' | 'config'>): ModuleKind {
  if (service.type === 'git') return 'github';
  if (service.type === 'database') {
    const t = service.config.template;
    if (t === 'postgres' || t === 'redis' || t === 'mysql' || t === 'mongo') return t;
    return 'docker';
  }
  const image = (service.config.image ?? '').toLowerCase();
  if (image.includes('wordpress')) return 'wordpress';
  if (image.includes('n8n')) return 'n8n';
  if (image.includes('postgres')) return 'postgres';
  if (image.includes('redis')) return 'redis';
  if (image.includes('mysql') || image.includes('mariadb')) return 'mysql';
  if (image.includes('mongo')) return 'mongo';
  return image ? 'docker' : 'generic';
}

/** Color de marca del módulo (para pintar ModuleLogo desnudo, sin chip). */
export function moduleFg(kind: ModuleKind): string {
  return CHIP[kind].fg;
}

/** Logo oficial del módulo, coloreado con currentColor. */
export function ModuleLogo({ kind, size = 17, className }: { kind: ModuleKind; size?: number; className?: string }) {
  if (kind === 'generic') return <Package size={size} className={className} />;
  return (
    <span
      aria-hidden
      className={cx('inline-flex [&>svg]:h-full [&>svg]:w-full [&>svg]:fill-current', className)}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: SVGS[kind] }}
    />
  );
}

/** Chip cuadrado con el logo del módulo sobre su tinte de marca. */
export function ModuleChip({
  kind,
  size = 36,
  iconSize,
  radius = 10,
  className,
}: {
  kind: ModuleKind;
  size?: number;
  iconSize?: number;
  radius?: number;
  className?: string;
}) {
  const { bg, fg } = CHIP[kind];
  return (
    <span
      className={cx('flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size, borderRadius: radius, background: bg, color: fg }}
    >
      <ModuleLogo kind={kind} size={iconSize ?? Math.round(size * 0.47)} />
    </span>
  );
}
