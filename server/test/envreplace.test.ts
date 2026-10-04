/**
 * Sustitución de variables del cambio de dominio (`envreplace.ts`): límites de
 * nombre, mapa exacto de hosts y direcciones, menciones que no se cambian,
 * una sola pasada, idempotencia desde el original, huella, bloque de
 * WordPress y avisos. Módulo puro: sin base de datos ni red.
 */
import { describe, expect, it } from 'vitest';
import {
  MapaCambio,
  ValorVariable,
  anadirBloqueWordpress,
  aplicarMapa,
  avisosDeVariables,
  mensajeSinMapa,
  planificar,
  quitarBloqueWordpress,
} from '../src/envreplace';

const MAPA: MapaCambio = {
  hosts: [
    { from: 'dominio.es', to: 'dominio2.es' },
    { from: 'www.dominio.es', to: 'www.dominio2.es' },
  ],
  direcciones: [{ from: 'ana@dominio.es', to: 'ana@dominio2.es' }],
};

const valor = (v: string, extra: Partial<ValorVariable> = {}): ValorVariable => ({
  ambito: 'service',
  serviceId: 'svc_1',
  key: 'K',
  valor: v,
  origen: null,
  ...extra,
});

describe('aplicarMapa: límites de nombre', () => {
  it('cambia el host servido conservando esquema, ruta, consulta y puerto', () => {
    expect(aplicarMapa('https://www.dominio.es/tienda?x=1#y', MAPA)).toEqual({ valor: 'https://www.dominio2.es/tienda?x=1#y', ocurrencias: 1 });
    expect(aplicarMapa('http://dominio.es:8080/api', MAPA).valor).toBe('http://dominio2.es:8080/api');
    expect(aplicarMapa('https://dominio.es,https://www.dominio.es', MAPA)).toEqual({
      valor: 'https://dominio2.es,https://www.dominio2.es',
      ocurrencias: 2,
    });
  });

  it('no toca otros dominios que contienen el nombre', () => {
    for (const v of ['midominio.es', 'https://midominio.es', 'dominio.es.mx', 'https://dominio.es.mx/x', 'x-dominio.es', 'dominio.esp']) {
      expect(aplicarMapa(v, MAPA), v).toEqual({ valor: v, ocurrencias: 0 });
    }
  });

  it('un subdominio que no está en el mapa no cambia aunque su padre sí', () => {
    expect(aplicarMapa('api.dominio.es', MAPA).ocurrencias).toBe(0);
    expect(aplicarMapa('https://api.www.dominio.es', MAPA).ocurrencias).toBe(0);
  });

  it('una dirección solo cambia si está en el mapa: servir el dominio no basta', () => {
    expect(aplicarMapa('contacto@dominio.es', MAPA)).toEqual({ valor: 'contacto@dominio.es', ocurrencias: 0 });
    expect(aplicarMapa('ana@dominio.es', MAPA)).toEqual({ valor: 'ana@dominio2.es', ocurrencias: 1 });
    expect(aplicarMapa('"Tienda" <ana@dominio.es>', MAPA).valor).toBe('"Tienda" <ana@dominio2.es>');
    // Una dirección más larga que la del mapa no es la del mapa.
    expect(aplicarMapa('mariana@dominio.es', MAPA).ocurrencias).toBe(0);
    expect(aplicarMapa('ana@dominio.es.mx', MAPA).ocurrencias).toBe(0);
  });

  it('sin distinguir mayúsculas', () => {
    expect(aplicarMapa('HTTPS://WWW.DOMINIO.ES/X', MAPA).valor).toBe('HTTPS://www.dominio2.es/X');
    expect(aplicarMapa('Ana@Dominio.ES', MAPA).valor).toBe('ana@dominio2.es');
  });

  it('nunca toca lo que va dentro de ${{…}}', () => {
    expect(aplicarMapa('${{web.PUBLIC_URL}}', MAPA)).toEqual({ valor: '${{web.PUBLIC_URL}}', ocurrencias: 0 });
    expect(aplicarMapa('${{ www.dominio.es }}/https://www.dominio.es', MAPA).valor).toBe('${{ www.dominio.es }}/https://www.dominio2.es');
    expect(aplicarMapa('${{a.b}}www.dominio.es', MAPA).valor).toBe('${{a.b}}www.dominio2.es');
  });

  it('el dominio de una cookie (`.dominio.es`) sigue al host servido', () => {
    expect(aplicarMapa('.dominio.es', MAPA).valor).toBe('.dominio2.es');
    expect(aplicarMapa('Domain=.dominio.es; Path=/', MAPA).valor).toBe('Domain=.dominio2.es; Path=/');
  });

  it('una sola pasada: no hay reemplazos en cadena', () => {
    const cadena: MapaCambio = { hosts: [{ from: 'a.es', to: 'b.es' }, { from: 'b.es', to: 'c.es' }], direcciones: [] };
    expect(aplicarMapa('a.es b.es', cadena)).toEqual({ valor: 'b.es c.es', ocurrencias: 2 });
  });

  it('gana el nombre más largo en la misma posición', () => {
    const solapados: MapaCambio = {
      hosts: [
        { from: 'dominio.es', to: 'APEX' },
        { from: 'www.dominio.es', to: 'WWW' },
      ],
      direcciones: [],
    };
    expect(aplicarMapa('www.dominio.es y dominio.es', solapados).valor).toBe('www y apex');
  });

  it('idempotente desde el original, también si el nuevo es subdominio del viejo', () => {
    const sub: MapaCambio = { hosts: [{ from: 'dominio.es', to: 'nuevo.dominio.es' }], direcciones: [] };
    const original = 'https://dominio.es/x';
    const una = aplicarMapa(original, sub).valor;
    expect(una).toBe('https://nuevo.dominio.es/x');
    expect(aplicarMapa(original, sub).valor).toBe(una);
    // Y aplicarlo al resultado tampoco lo vuelve a cambiar.
    expect(aplicarMapa(una, sub)).toEqual({ valor: una, ocurrencias: 0 });
  });
});

describe('planificar', () => {
  it('propone solo las variables con cambios y enseña lo que no cambia', () => {
    const plan = planificar(
      [
        valor('https://www.dominio.es', { key: 'SITE_URL' }),
        valor('postgres://u:clave@db.dominio.es:5432/app', { key: 'DATABASE_URL' }),
        valor('https://www.dominio.es contacto@dominio.es ana@dominio.es', { key: 'MEZCLA' }),
        valor('nada que ver', { key: 'OTRA' }),
      ],
      MAPA,
      'dominio.es',
    );
    expect(plan.cambios.map((c) => c.key)).toEqual(['MEZCLA', 'SITE_URL']);
    const mezcla = plan.cambios.find((c) => c.key === 'MEZCLA')!;
    expect(mezcla).toMatchObject({
      ocurrencias: 2,
      antes: 'https://www.dominio.es contacto@dominio.es ana@dominio.es',
      despues: 'https://www.dominio2.es contacto@dominio.es ana@dominio2.es',
      sinMapa: ['contacto@dominio.es'],
      gestionada: null,
      excluida: false,
    });
    // En una URL con usuario se enseña el host, no «clave@…».
    expect(plan.avisosSinMapa).toEqual([
      { ambito: 'service', key: 'DATABASE_URL', serviceId: 'svc_1', nombres: ['db.dominio.es'] },
      { ambito: 'service', key: 'MEZCLA', serviceId: 'svc_1', nombres: ['contacto@dominio.es'] },
    ]);
    expect(mensajeSinMapa('db.dominio.es', 'DATABASE_URL')).toBe('db.dominio.es aparece en DATABASE_URL, pero no lo sirve este proyecto: no se cambia.');
    expect(mensajeSinMapa('db.dominio.es')).toBe('db.dominio.es no lo sirve este proyecto: no se cambia.');
  });

  it('las direcciones de mailto: son direcciones; las menciones dentro de ${{…}} no cuentan', () => {
    const plan = planificar(
      [valor('mailto:pepe@dominio.es'), valor('${{db.dominio.es}}', { key: 'REF' })],
      MAPA,
      'dominio.es',
    );
    expect(plan.avisosSinMapa).toEqual([{ ambito: 'service', key: 'K', serviceId: 'svc_1', nombres: ['pepe@dominio.es'] }]);
  });

  it('deja fuera las variables de correo (las refresca el correo) y conserva el origen de las gestionadas', () => {
    const plan = planificar(
      [
        valor('ana@dominio.es', { key: 'SMTP_FROM', origen: 'mail.smtp.from' }),
        valor('https://www.dominio.es', { key: 'APP_URL', origen: 'self.public_url' }),
      ],
      MAPA,
      'dominio.es',
    );
    expect(plan.cambios).toHaveLength(1);
    expect(plan.cambios[0]).toMatchObject({ key: 'APP_URL', gestionada: 'self.public_url' });
  });

  it('las compartidas del proyecto y los argumentos de compilación entran, en orden estable', () => {
    const plan = planificar(
      [
        valor('https://www.dominio.es', { ambito: 'build', key: 'NEXT_PUBLIC_URL' }),
        valor('https://www.dominio.es', { ambito: 'project', serviceId: null, key: 'BASE_URL' }),
        valor('https://www.dominio.es', { key: 'APP_URL' }),
      ],
      MAPA,
      'dominio.es',
    );
    expect(plan.cambios.map((c) => `${c.ambito}:${c.key}`)).toEqual(['project:BASE_URL', 'service:APP_URL', 'build:NEXT_PUBLIC_URL']);
  });

  it('la huella cambia con el valor original y con las exclusiones, no con el orden de entrada', () => {
    const a = valor('https://www.dominio.es', { key: 'A' });
    const b = valor('https://dominio.es', { key: 'B' });
    const base = planificar([a, b], MAPA, 'dominio.es');
    expect(base.huella).toMatch(/^[0-9a-f]{64}$/);
    expect(planificar([b, a], MAPA, 'dominio.es').huella).toBe(base.huella);
    // Otra persona cambia la variable entre la vista previa y «Pasar».
    expect(planificar([{ ...a, valor: 'https://www.dominio.es/otra' }, b], MAPA, 'dominio.es').huella).not.toBe(base.huella);
    // El usuario desmarca una: sigue en el plan, marcada, y la huella cambia.
    const excl = planificar([a, b], MAPA, 'dominio.es', { excluidas: [{ ambito: 'service', serviceId: 'svc_1', key: 'A' }] });
    expect(excl.cambios.find((c) => c.key === 'A')?.excluida).toBe(true);
    expect(excl.huella).not.toBe(base.huella);
    // Una variable que no cambia no cuenta.
    expect(planificar([a, b, valor('sin dominio', { key: 'C' })], MAPA, 'dominio.es').huella).toBe(base.huella);
  });

  it('sin mapa (solo menciones) no propone cambios', () => {
    const plan = planificar([valor('https://www.dominio.es')], { hosts: [], direcciones: [] }, 'dominio.es');
    expect(plan.cambios).toEqual([]);
    expect(plan.avisosSinMapa[0].nombres).toEqual(['www.dominio.es']);
  });
});

describe('bloque de WordPress', () => {
  const extra = "define('WP_MEMORY_LIMIT','256M');";

  it('se añade, se sustituye (sin duplicarse) y se quita dejando el valor como estaba', () => {
    const una = anadirBloqueWordpress(extra, 'https://www.dominio2.es');
    expect(una).toBe(
      `${extra}\n/* skyway:cambio-de-dominio */define('WP_HOME','https://www.dominio2.es');define('WP_SITEURL','https://www.dominio2.es');/* fin */`,
    );
    expect(anadirBloqueWordpress(una, 'https://www.dominio2.es')).toBe(una);
    const otra = anadirBloqueWordpress(una, 'https://otra.es');
    expect(otra.match(/skyway:cambio-de-dominio/g)).toHaveLength(1);
    expect(otra).toContain("define('WP_HOME','https://otra.es')");
    expect(quitarBloqueWordpress(una)).toBe(extra);
    expect(quitarBloqueWordpress(otra)).toBe(extra);
  });

  it('con el valor vacío queda solo el bloque, y quitarlo lo deja vacío', () => {
    const bloque = anadirBloqueWordpress('', 'https://dominio2.es');
    expect(bloque.startsWith('/* skyway:cambio-de-dominio */')).toBe(true);
    expect(quitarBloqueWordpress(bloque)).toBe('');
    expect(quitarBloqueWordpress(`${extra}\n`)).toBe(`${extra}\n`);
    expect(quitarBloqueWordpress(anadirBloqueWordpress(`${extra}\n`, 'https://dominio2.es'))).toBe(`${extra}\n`);
  });

  it('escapa las comillas de la URL (cadena PHP)', () => {
    expect(anadirBloqueWordpress('', "https://x.es/'a")).toContain("define('WP_HOME','https://x.es/\\'a')");
  });
});

describe('avisosDeVariables', () => {
  it('avisa de lo que el cambio no puede hacer solo, una vez por tema', () => {
    const avisos = avisosDeVariables(
      ['NEXTAUTH_URL', 'AUTH_URL', 'GOOGLE_CLIENT_ID', 'GITHUB_CLIENT_ID', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TURNSTILE_SITE_KEY', 'SESSION_COOKIE_DOMAIN'],
      ['wordpress'],
      'www.dominio2.es',
      'www.dominio.es',
    );
    expect(avisos).toEqual([
      'Añade https://www.dominio2.es/api/auth/callback/<proveedor> en cada proveedor de inicio de sesión.',
      'Google Cloud → Credenciales: añade https://www.dominio2.es como origen autorizado y su URL de vuelta.',
      'GitHub → Developer settings → OAuth Apps: cambia la Authorization callback URL.',
      'Stripe → Webhooks: crea el endpoint en https://www.dominio2.es/… (Stripe no sigue redirecciones) y actualiza STRIPE_WEBHOOK_SECRET.',
      'Añade dominio2.es a los nombres permitidos del widget.',
      'Las sesiones abiertas se cerrarán al pasar.',
      "Haz una copia de la base de datos y ejecuta wp search-replace 'https://www.dominio.es' 'https://www.dominio2.es' --all-tables. " +
        'Mientras tanto, la redirección mantiene funcionando los enlaces.',
    ]);
  });

  it('sin nada que avisar, ninguna línea; RECAPTCHA_ cuenta como widget', () => {
    expect(avisosDeVariables(['DATABASE_URL', 'PORT'], ['node'], 'www.dominio2.es')).toEqual([]);
    expect(avisosDeVariables(['RECAPTCHA_SECRET'], [], 'app.dominio2.es')).toEqual(['Añade dominio2.es a los nombres permitidos del widget.']);
  });
});
