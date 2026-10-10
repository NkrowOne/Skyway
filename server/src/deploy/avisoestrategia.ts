/**
 * Avisos de lo que la estrategia de despliegue y la parada limpia cambian en
 * servicios que ya funcionaban, fuera del registro del despliegue (que se lee
 * cuando ya ha pasado).
 *
 * Hasta esta versión, todo servicio sin volúmenes ni puerto público se
 * desplegaba «sin corte», y la parada daba 10 s de gracia. Ahora, un servicio
 * sin dominio, healthcheck ni llamadas de otros servicios (o un bot de Telegram
 * o Discord sin dominio) se despliega con «una sola copia»: unos segundos sin
 * servicio en cada despliegue, más la gracia (30 s por defecto) si el proceso
 * no atiende SIGTERM. Para un bot es lo correcto; para una API interna a la que
 * otro servicio llama desde su código (que Skyway no ve) es un corte nuevo. El
 * registro lo decía, pero solo después del corte.
 */

import { ESTRATEGIA_ALERT_TYPE, fireAlert, PARADA_FORZADA_ALERT_TYPE, resolveServiceAlerts } from '../alerts';
import { getSetting, lastSuccessfulImage, listProjects, listServices, setSetting } from '../db';
import type { ServiceRow } from '../types';
import { estrategiaEfectiva } from './estrategia';

/** Ajuste que marca que el aviso único ya se dio (o que no hacía falta). */
const CLAVE_AVISO_UNICO = 'avisoEstrategiaUnaSolaCopia';

/**
 * Una sola vez por instalación, al arrancar: una alerta (solo en el panel, sin
 * canales externos) por cada servicio ya desplegado que su próximo despliegue
 * hará con «una sola copia» elegida por Skyway. Los servicios que se crean
 * después ya nacen con la regla y Ajustes la enseña. Devuelve cuántos avisos
 * ha creado.
 */
export function avisarServiciosQuePasanAUnaSolaCopia(): number {
  if (getSetting(CLAVE_AVISO_UNICO)) return 0;
  let avisos = 0;
  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      if (service.type === 'database' || !lastSuccessfulImage(service.id)) continue;
      const e = estrategiaEfectiva(service);
      if (!e.automatica || e.estrategia !== 'recreate') continue;
      fireAlert({
        severity: 'info',
        type: ESTRATEGIA_ALERT_TYPE,
        serviceId: service.id,
        title: `«${service.name}» se desplegará con una sola copia`,
        message:
          (e.motivo === 'bot'
            ? `«${service.name}» usa una biblioteca de bots de Telegram o Discord y no tiene dominio. `
            : `«${service.name}» no tiene dominio, ruta de healthcheck ni llamadas de otros servicios. `) +
          'Desde esta versión de Skyway, a partir de su próximo despliegue se detiene la versión anterior antes de arrancar la ' +
          'nueva, para que un bot o un worker nunca tenga dos copias a la vez. Hasta ahora se desplegaba sin corte: ahora estará ' +
          'unos segundos sin servicio en cada despliegue.',
        explanation:
          'Si otro servicio lo llama por la red interna desde su código o su configuración (por ejemplo, un proxy_pass de nginx), ' +
          'elige «Sin corte» en Ajustes del servicio → Despliegue y parada. La parada es ahora SIGTERM con 30 s de gracia (antes, ' +
          '10 s): si el proceso no atiende SIGTERM, ese tiempo se suma a los segundos sin servicio; haz que lo atienda o baja la ' +
          'gracia en el mismo apartado.',
        dedupe: true,
        quiet: true,
      });
      avisos += 1;
    }
  }
  setSetting(CLAVE_AVISO_UNICO, String(Date.now()));
  return avisos;
}

/**
 * Tras parar la versión anterior en un despliegue con «una sola copia»: si
 * alguna copia se detuvo con SIGKILL al agotar la gracia, una alerta del
 * servicio (solo en el panel) que lo recuerde fuera del registro; si ninguna,
 * se resuelve la que hubiera. En «sin corte» una parada forzada solo alarga el
 * despliegue, sin dejar el servicio sin atender, y no se avisa.
 */
export function anotarParadaForzada(service: ServiceRow, forzadas: number, graciaSegundos: number): void {
  if (forzadas === 0) {
    resolveServiceAlerts(service.id, PARADA_FORZADA_ALERT_TYPE);
    return;
  }
  fireAlert({
    severity: 'warning',
    type: PARADA_FORZADA_ALERT_TYPE,
    serviceId: service.id,
    title: `«${service.name}» no atiende SIGTERM`,
    message:
      `Al desplegar, la versión anterior de «${service.name}» no terminó con SIGTERM en ${graciaSegundos} s y se detuvo con ` +
      'SIGKILL. Con «una sola copia», ese tiempo se suma a los segundos sin servicio de cada despliegue.',
    explanation:
      'Haz que el proceso principal del contenedor atienda SIGTERM (un manejador que cierre y salga) y, si el comando de arranque ' +
      'va envuelto en un shell, empiézalo con «exec». Mientras tanto, baja la gracia de parada en Ajustes del servicio → ' +
      'Despliegue y parada. Esta alerta se cierra sola en el primer despliegue cuya parada no necesite SIGKILL.',
    dedupe: true,
    quiet: true,
  });
}
