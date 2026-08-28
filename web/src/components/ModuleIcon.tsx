import { Package } from 'lucide-react';
import { Service } from '../types';
import { cx } from '../utils';
import dockerSvg from '../assets/icons/docker.svg?raw';
import ghostSvg from '../assets/icons/ghost.svg?raw';
import githubSvg from '../assets/icons/github.svg?raw';
import grafanaSvg from '../assets/icons/grafana.svg?raw';
import kongSvg from '../assets/icons/kong.svg?raw';
import mariadbSvg from '../assets/icons/mariadb.svg?raw';
import metabaseSvg from '../assets/icons/metabase.svg?raw';
import minioSvg from '../assets/icons/minio.svg?raw';
import mongodbSvg from '../assets/icons/mongodb.svg?raw';
import mysqlSvg from '../assets/icons/mysql.svg?raw';
import n8nSvg from '../assets/icons/n8n.svg?raw';
import nginxSvg from '../assets/icons/nginx.svg?raw';
import plausibleSvg from '../assets/icons/plausible.svg?raw';
import postgresqlSvg from '../assets/icons/postgresql.svg?raw';
import redisSvg from '../assets/icons/redis.svg?raw';
import supabaseSvg from '../assets/icons/supabase.svg?raw';
import traefikSvg from '../assets/icons/traefik.svg?raw';
import uptimekumaSvg from '../assets/icons/uptimekuma.svg?raw';
import wordpressSvg from '../assets/icons/wordpress.svg?raw';

/*
 * Canon de logos oficiales: los SVG salen de simple-icons (CC0) mediante
 * `npm run logos -w web` (scripts/fetch-logos.mjs), que además imprime el
 * color oficial de cada marca. Los tintes de CHIP se afinan a mano desde
 * ese color para leerse sobre la UI oscura (fg aclarado, bg al 14-22%).
 */
export type ModuleKind =
  | 'github'
  | 'postgres'
  | 'redis'
  | 'mysql'
  | 'mongo'
  | 'mariadb'
  | 'minio'
  | 'wordpress'
  | 'n8n'
  | 'docker'
  | 'plausible'
  | 'uptimekuma'
  | 'ghost'
  | 'grafana'
  | 'nginx'
  | 'traefik'
  | 'supabase'
  | 'kong'
  | 'metabase'
  | 'generic';

const SVGS: Record<Exclude<ModuleKind, 'generic'>, string> = {
  github: githubSvg,
  postgres: postgresqlSvg,
  redis: redisSvg,
  mysql: mysqlSvg,
  mongo: mongodbSvg,
  mariadb: mariadbSvg,
  minio: minioSvg,
  wordpress: wordpressSvg,
  n8n: n8nSvg,
  docker: dockerSvg,
  plausible: plausibleSvg,
  uptimekuma: uptimekumaSvg,
  ghost: ghostSvg,
  grafana: grafanaSvg,
  nginx: nginxSvg,
  traefik: traefikSvg,
  supabase: supabaseSvg,
  kong: kongSvg,
  metabase: metabaseSvg,
};

/** Colores de chip por módulo (logos oficiales sobre tinte de su marca). */
const CHIP: Record<ModuleKind, { bg: string; fg: string }> = {
  github: { bg: 'color-mix(in oklab, var(--color-txt) 9%, transparent)', fg: 'var(--color-txt)' },
  postgres: { bg: 'rgba(51,103,145,.28)', fg: '#93bce2' },
  redis: { bg: 'rgba(220,56,44,.16)', fg: '#e0837b' },
  mysql: { bg: 'rgba(68,121,161,.22)', fg: '#8ab4d4' },
  mongo: { bg: 'rgba(71,162,72,.16)', fg: '#7fc98a' },
  mariadb: { bg: 'rgba(0,110,133,.22)', fg: '#7ac2d1' }, // oficial #003545, aclarado para fondo oscuro
  minio: { bg: 'rgba(199,46,73,.16)', fg: '#e58397' }, // oficial #C72E49
  wordpress: { bg: 'rgba(33,117,155,.22)', fg: '#7db8d4' },
  n8n: { bg: 'rgba(234,75,113,.16)', fg: '#ef8ba5' },
  docker: { bg: 'rgba(36,150,237,.16)', fg: '#7cbdf0' },
  plausible: { bg: 'rgba(88,80,236,.18)', fg: '#a8a2f4' }, // oficial #5850EC
  uptimekuma: { bg: 'rgba(92,221,139,.14)', fg: '#8ce7ae' }, // oficial #5CDD8B
  ghost: { bg: 'color-mix(in oklab, var(--color-txt) 9%, transparent)', fg: 'var(--color-txt)' }, // oficial #15171A: neutro, como GitHub
  grafana: { bg: 'rgba(244,104,0,.15)', fg: '#f6a468' }, // oficial #F46800
  nginx: { bg: 'rgba(0,150,57,.16)', fg: '#69c288' }, // oficial #009639
  traefik: { bg: 'rgba(36,161,193,.16)', fg: '#7dc7da' }, // oficial #24A1C1
  supabase: { bg: 'rgba(63,207,142,.15)', fg: '#5fd8a0' }, // oficial #3FCF8E
  kong: { bg: 'rgba(0,52,89,.35)', fg: '#7fb3d5' }, // oficial #003459: muy oscuro, se aclara para leerse
  metabase: { bg: 'rgba(80,158,227,.16)', fg: '#8cc0ef' }, // oficial #509EE3
  generic: { bg: 'color-mix(in oklab, var(--color-warn) 13%, transparent)', fg: 'var(--color-warn)' },
};

const KINDS = new Set<string>([...Object.keys(SVGS), 'generic']);

/** ¿Es una marca que este bundle sabe pintar? (el servidor las manda como texto). */
export function isModuleKind(value: string): value is ModuleKind {
  return KINDS.has(value);
}

/** Deduce el módulo a partir del servicio (repo, plantilla de BD o nombre de imagen). */
export function moduleKind(service: Pick<Service, 'type' | 'config'>): ModuleKind {
  if (service.type === 'git') return 'github';
  // Las pilas de aplicaciones declaran el logo de cada servicio: adivinarlo por
  // el nombre de la imagen falla justo donde importa (postgrest no es Postgres).
  const declared = service.config.icon;
  if (declared && isModuleKind(declared)) return declared;
  if (service.type === 'database') {
    const t = service.config.template;
    if (t === 'postgres' || t === 'redis' || t === 'mysql' || t === 'mongo' || t === 'minio') return t;
    return 'docker';
  }
  const image = (service.config.image ?? '').toLowerCase();
  // Antes que Postgres: `supabase/postgres-meta` y `postgrest/postgrest`
  // contienen «postgres» pero no son la base de datos. Se admite prefijo de
  // registro (ghcr.io/…) porque la imagen la escribe el usuario a mano.
  if (/(^|\/)supabase\/postgres(:|$)/.test(image)) return 'postgres';
  if (image.includes('supabase/') || image.includes('postgrest') || image.includes('gotrue')) return 'supabase';
  if (/(^|\/)kong(\/kong)?(:|$)/.test(image)) return 'kong';
  if (image.includes('metabase')) return 'metabase';
  if (image.includes('wordpress')) return 'wordpress';
  if (image.includes('n8n')) return 'n8n';
  if (image.includes('postgres')) return 'postgres';
  if (image.includes('redis')) return 'redis';
  if (image.includes('mariadb')) return 'mariadb';
  if (image.includes('mysql')) return 'mysql';
  if (image.includes('mongo')) return 'mongo';
  if (image.includes('minio')) return 'minio';
  if (image.includes('plausible')) return 'plausible';
  if (image.includes('uptime-kuma') || image.includes('uptimekuma')) return 'uptimekuma';
  if (image.includes('ghost')) return 'ghost';
  if (image.includes('grafana')) return 'grafana';
  if (image.includes('nginx')) return 'nginx';
  if (image.includes('traefik')) return 'traefik';
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

/** Píldora compacta de servicio viva con el tinte y color de su marca oficial */
export function ModuleBadge({
  kind,
  name,
  className,
}: {
  kind: ModuleKind;
  name: string;
  className?: string;
}) {
  const { bg, fg } = CHIP[kind] ?? CHIP.generic;
  return (
    <span
      className={cx(
        'inline-flex max-w-[140px] items-center gap-1.5 truncate rounded-lg px-2 py-0.5 text-xs font-semibold transition-all duration-150',
        className,
      )}
      style={{
        backgroundColor: bg,
        color: fg,
        border: `1px solid color-mix(in srgb, ${fg} 30%, transparent)`,
        boxShadow: `0 1px 3px color-mix(in srgb, ${fg} 8%, transparent)`,
      }}
      title={`${name} (${kind})`}
    >
      <span className="shrink-0 flex items-center justify-center">
        <ModuleLogo kind={kind} size={11} />
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

