import { countFailedLogins, getSetting, listProjects, listServices } from './db';
import { channelsConfigured } from './notify';
import { DatabaseConfig, SecurityFinding, ServiceRow } from './types';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Escáner de seguridad: revisa la configuración real de proyectos y servicios
 * y devuelve hallazgos con explicación y solución.
 */
export function securityFindings(): { findings: SecurityFinding[]; score: number; grade: string } {
  const findings: SecurityFinding[] = [];
  const projects = listProjects();
  const tlsConfigured = !!getSetting('letsencryptEmail');

  const servicesWithDomains: string[] = [];

  for (const project of projects) {
    for (const service of listServices(project.id)) {
      const cfg = service.config as any;
      const base = {
        projectId: project.id,
        projectName: project.name,
        serviceId: service.id,
        serviceName: service.name,
      };

      if (service.type === 'database' && cfg.hostPort) {
        findings.push({
          id: `db-exposed-${service.id}`,
          severity: 'critical',
          title: `Base de datos expuesta a internet: ${service.name}`,
          detail: `"${service.name}" (${(cfg as DatabaseConfig).template}) publica el puerto TCP ${cfg.hostPort} en el host. Cualquiera que alcance la IP del servidor puede intentar conectarse y lanzar ataques de fuerza bruta contra las credenciales.`,
          fix: 'Quita el "Puerto público" en Ajustes del servicio: los demás servicios del proyecto ya llegan por la red privada. Si necesitas acceso externo (p. ej. desde tu portátil), usa un túnel SSH (`ssh -L 5432:localhost:5432 servidor`) o una VPN como WireGuard/Tailscale.',
          ...base,
        });
      }

      if (service.type === 'git' && cfg.hostPort) {
        findings.push({
          id: `app-hostport-${service.id}`,
          severity: 'warning',
          title: `Aplicación con puerto directo: ${service.name}`,
          detail: `"${service.name}" publica el puerto ${cfg.hostPort} directamente, saltándose Traefik: sin TLS, sin dominio y expuesto en la IP del servidor.`,
          fix: 'Usa un dominio (Ajustes del servicio → Dominios) para servir el tráfico a través de Traefik con TLS, y elimina el puerto público salvo que sea imprescindible.',
          ...base,
        });
      }

      if (!cfg.cpus && !cfg.memoryMb) {
        findings.push({
          id: `no-limits-${service.id}`,
          severity: 'warning',
          title: `Sin límites de recursos: ${service.name}`,
          detail: `"${service.name}" puede consumir toda la CPU y RAM del servidor. Un pico de tráfico, una fuga de memoria o un ataque pueden tumbar los proyectos de todas las empresas a la vez.`,
          fix: 'Define límites en Ajustes del servicio → Recursos (se aplican en caliente). Para varias empresas en el mismo servidor, limita todos los servicios y deja margen para el sistema.',
          ...base,
        });
      }

      if (service.type === 'git' && (cfg.domains?.length ?? 0) > 0) {
        servicesWithDomains.push(service.name);
      }
    }
  }

  if (servicesWithDomains.length > 0 && !tlsConfigured) {
    findings.push({
      id: 'no-tls',
      severity: 'warning',
      title: 'Dominios sin TLS automático',
      detail: `Hay servicios con dominio (${servicesWithDomains.slice(0, 5).join(', ')}) pero no hay email de Let's Encrypt configurado: el tráfico va por HTTP sin cifrar, incluidas contraseñas y cookies de tus clientes.`,
      fix: 'Configura el email de Let\'s Encrypt en Ajustes → Dominios y TLS. Traefik emitirá y renovará certificados automáticamente para cada dominio.',
    });
  }

  const failed = countFailedLogins(DAY_MS);
  if (failed.count >= 10) {
    findings.push({
      id: 'bruteforce',
      severity: 'critical',
      title: `${failed.count} intentos de login fallidos en 24 h`,
      detail: `Posible ataque de fuerza bruta contra el panel. IPs implicadas: ${failed.ips.join(', ')}. Skyway limita los intentos por IP, pero el panel sigue siendo un objetivo.`,
      fix: 'Si no reconoces los intentos: cambia la contraseña (Panel de seguridad → Sesiones), pon el panel detrás de VPN o restringe el puerto por firewall, y usa el dominio con TLS en lugar del puerto 4000 abierto.',
    });
  } else if (failed.count > 0) {
    findings.push({
      id: 'failed-logins',
      severity: 'info',
      title: `${failed.count} intento(s) de login fallido(s) en 24 h`,
      detail: `IPs: ${failed.ips.join(', ')}. Puede ser un error tuyo tecleando o un escaneo automático.`,
      fix: 'Vigila el registro de actividad. Si crece, trata el panel como expuesto: VPN o firewall.',
    });
  }

  if (channelsConfigured().length === 0) {
    findings.push({
      id: 'no-channels',
      severity: 'info',
      title: 'Sin canal de notificaciones configurado',
      detail: 'Las alertas (caídas, CPU/RAM, despliegues fallidos) solo se ven dentro del panel. Si un servicio de una empresa se cae de madrugada, no te enterarás.',
      fix: 'Configura Discord, Telegram o un webhook en Ajustes → Alertas y notificaciones, y usa el botón de prueba.',
    });
  }

  findings.push({
    id: 'socket-info',
    severity: 'info',
    title: 'Recuerda: Skyway controla el Docker del host',
    detail: 'El panel monta /var/run/docker.sock: quien entre en Skyway controla todos los contenedores del servidor, de todas las empresas.',
    fix: 'Contraseña larga y única, panel accesible solo por dominio con TLS (o VPN), y revisa el registro de actividad periódicamente.',
  });

  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  const score = Math.max(5, 100 - critical * 25 - warning * 10);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'E';
  return { findings, score, grade };
}
