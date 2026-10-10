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
  mensajeUsuario,
  planificar,
  proveedoresDeClaves,
  quitarBloqueWordpress,
} from '../src/envreplace';
import { mailRoleLoose, mailRoleOf } from '../src/mailenv';

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
  });

  it('una referencia pegada a la izquierda es parte del nombre; a la derecha, un límite', () => {
    // `${{api.SUB}}.dominio.es` es un subdominio que se decide al desplegar, no el dominio de una cookie.
    expect(aplicarMapa('https://${{api.SUB}}.dominio.es/x', MAPA)).toEqual({ valor: 'https://${{api.SUB}}.dominio.es/x', ocurrencias: 0 });
    expect(aplicarMapa('${{a.b}}www.dominio.es', MAPA).ocurrencias).toBe(0);
    expect(aplicarMapa('${{a.LOCAL}}ana@dominio.es', MAPA).ocurrencias).toBe(0);
    expect(aplicarMapa('dominio.es.${{a.TLD}}', MAPA).ocurrencias).toBe(0);
    // Lo que sigue al host (una ruta, un puerto) no cambia el host.
    expect(aplicarMapa('https://www.dominio.es${{web.RUTA}}', MAPA).valor).toBe('https://www.dominio2.es${{web.RUTA}}');
    expect(aplicarMapa('postgres://${{db.U}}:${{db.P}}@www.dominio.es:5432', MAPA).valor).toBe('postgres://${{db.U}}:${{db.P}}@www.dominio2.es:5432');
  });

  it('el host de una URL con usuario es un host; un usuario con «@» no cambia', () => {
    expect(aplicarMapa('https://admin:secreto@www.dominio.es/hook', MAPA)).toEqual({
      valor: 'https://admin:secreto@www.dominio2.es/hook',
      ocurrencias: 1,
    });
    expect(aplicarMapa('https://ana@dominio.es/x', MAPA).valor).toBe('https://ana@dominio2.es/x');
    // El último «@» de la autoridad separa el usuario: lo de antes es el usuario, aunque sea una dirección del mapa.
    expect(aplicarMapa('smtp://ana@dominio.es:clave@mail.example.com:587', MAPA).ocurrencias).toBe(0);
    // Fuera de una URL, el dominio de una dirección nunca es el host servido.
    expect(aplicarMapa('x@www.dominio.es', MAPA).ocurrencias).toBe(0);
    expect(aplicarMapa('git@dominio.es:tienda.git', MAPA).ocurrencias).toBe(0);
  });

  it('con la clave de un usuario SMTP, sus direcciones no cambian', () => {
    expect(aplicarMapa('ana@dominio.es', MAPA, { key: 'SMTP_USER' })).toEqual({ valor: 'ana@dominio.es', ocurrencias: 0 });
    expect(aplicarMapa('ana@dominio.es', MAPA, { key: 'smtp_from' }).valor).toBe('ana@dominio2.es');
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

  it('el usuario SMTP no cambia al pasar: el buzón sigue entrando con su dirección anterior', () => {
    const plan = planificar(
      [
        valor('ana@dominio.es', { key: 'SMTP_USER' }),
        valor('ana@dominio.es', { key: 'MAIL_USERNAME' }),
        valor('ana@dominio.es', { key: 'EMAIL_HOST_USER', ambito: 'project', serviceId: null }),
        valor('smtp://ana@dominio.es:clave@mail.example.com:587', { key: 'MAILER_DSN' }),
        // El remitente sí: Mailway acepta enviar como cualquier dirección del buzón.
        valor('ana@dominio.es', { key: 'SMTP_FROM' }),
        // Un usuario que no se muda es una mención sin mapa, como siempre.
        valor('contacto@dominio.es', { key: 'SMTP_USERNAME' }),
      ],
      MAPA,
      'dominio.es',
    );
    expect(plan.cambios.map((c) => c.key)).toEqual(['SMTP_FROM']);
    expect(plan.usuarios).toEqual([
      { ambito: 'project', key: 'EMAIL_HOST_USER', serviceId: null, nombres: ['ana@dominio.es'] },
      { ambito: 'service', key: 'MAIL_USERNAME', serviceId: 'svc_1', nombres: ['ana@dominio.es'] },
      { ambito: 'service', key: 'MAILER_DSN', serviceId: 'svc_1', nombres: ['ana@dominio.es'] },
      { ambito: 'service', key: 'SMTP_USER', serviceId: 'svc_1', nombres: ['ana@dominio.es'] },
    ]);
    expect(plan.avisosSinMapa).toEqual([{ ambito: 'service', key: 'SMTP_USERNAME', serviceId: 'svc_1', nombres: ['contacto@dominio.es'] }]);
    expect(mensajeUsuario('ana@dominio.es', 'SMTP_USER')).toBe(
      'ana@dominio.es aparece en SMTP_USER como usuario para entrar en el correo: no se cambia al pasar. ' +
        'El buzón sigue entrando con ese usuario hasta que se actualice o se dé de baja dominio.es.',
    );
  });

  it('menciones: el host de una URL con usuario, las que dependen de una referencia y los sufijos «@dominio»', () => {
    const plan = planificar(
      [
        valor('https://admin:secreto@www.dominio.es/hook', { key: 'WEBHOOK' }),
        valor('https://${{api.SUB}}.dominio.es/x', { key: 'API' }),
        valor('@dominio.es', { key: 'DOMINIO_PERMITIDO' }),
      ],
      MAPA,
      'dominio.es',
    );
    // El host servido tras «usuario:clave@» se cambia: no es una mención sin mapa.
    expect(plan.cambios.map((c) => c.key)).toEqual(['WEBHOOK']);
    expect(plan.avisosSinMapa).toEqual([
      { ambito: 'service', key: 'API', serviceId: 'svc_1', nombres: ['${{api.SUB}}.dominio.es'] },
      { ambito: 'service', key: 'DOMINIO_PERMITIDO', serviceId: 'svc_1', nombres: ['@dominio.es'] },
    ]);
    expect(mensajeSinMapa('${{api.SUB}}.dominio.es', 'API')).toBe('${{api.SUB}}.dominio.es aparece en API y depende de otra variable: no se cambia.');
    expect(mensajeSinMapa('@dominio.es', 'DOMINIO_PERMITIDO')).toBe('@dominio.es aparece en DOMINIO_PERMITIDO: no se cambia.');
    expect(mensajeSinMapa('pepe@dominio.es', 'K')).toBe('pepe@dominio.es aparece en K, pero no es un buzón ni un alias que se mude: no se cambia.');
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

  it('reconoce los nombres públicos de los frameworks y las variantes habituales', () => {
    const avisos = avisosDeVariables(
      ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'VITE_TURNSTILE_SITE_KEY', 'PUBLIC_NEXTAUTH_URL', 'AUTH_GOOGLE_ID', 'AUTH_GITHUB_ID'],
      [],
      'www.dominio2.es',
    );
    expect(avisos.map((a) => a.split(/[:→ ]/)[0])).toEqual(['Añade', 'Google', 'GitHub', 'Stripe', 'Añade']);
    expect(avisosDeVariables(['NEXT_PUBLIC_RECAPTCHA_SITE_KEY'], [], 'www.dominio2.es')).toEqual([
      'Añade dominio2.es a los nombres permitidos del widget.',
    ]);
    // Sin el tema como tramo propio del nombre, no hay aviso.
    expect(avisosDeVariables(['KEYCLOAK_AUTH_URL', 'OAUTH_URL', 'MYSTRIPE_KEY', 'GOOGLE_ANALYTICS_ID'], [], 'www.dominio2.es')).toEqual([]);
  });
});

describe('bots: usuarios con prefijo propio y proveedores de webhooks', () => {
  it('mailRoleLoose reconoce el nombre conocido más largo tras un prefijo propio; mailRoleOf no cambia', () => {
    expect(mailRoleLoose('TG_SMTP_LOGIN')).toBe('user');
    expect(mailRoleLoose('BOT_SMTP_USER')).toBe('user');
    expect(mailRoleLoose('MYAPP_EMAIL_HOST_USER')).toBe('user');
    expect(mailRoleLoose('tg_smtp_login')).toBe('user');
    expect(mailRoleLoose('SMTP_USER')).toBe('user');
    expect(mailRoleLoose('NOTIFY_MAIL_FROM')).toBe('from');
    expect(mailRoleLoose('BOT_SMTP_URL')).toBe('url');
    // Nada que reconocer: ni el nombre del servidor de Mailway ni un sufijo suelto.
    expect(mailRoleLoose('MAIL_HOSTNAME')).toBeNull();
    expect(mailRoleLoose('APP_USER')).toBeNull();
    expect(mailRoleLoose('TELEGRAM_BOT_TOKEN')).toBeNull();
    expect(mailRoleOf('TG_SMTP_LOGIN')).toBeNull();
  });

  it('al pasar, TG_SMTP_LOGIN y BOT_SMTP_USER son el usuario para entrar: no cambian y salen como nota', () => {
    const mapa: MapaCambio = { hosts: [], direcciones: [{ from: 'bot@dominio.es', to: 'bot@dominio2.es' }] };
    const plan = planificar(
      [
        valor('bot@dominio.es', { key: 'TG_SMTP_LOGIN' }),
        valor('bot@dominio.es', { key: 'BOT_SMTP_USER' }),
        valor('bot@dominio.es', { key: 'BOT_MAIL_FROM' }),
      ],
      mapa,
      'dominio.es',
    );
    expect(plan.cambios.map((c) => [c.key, c.despues])).toEqual([['BOT_MAIL_FROM', 'bot@dominio2.es']]);
    expect(plan.usuarios.map((u) => [u.key, u.nombres])).toEqual([
      ['BOT_SMTP_USER', ['bot@dominio.es']],
      ['TG_SMTP_LOGIN', ['bot@dominio.es']],
    ]);
    expect(aplicarMapa('bot@dominio.es', mapa, { key: 'TG_SMTP_LOGIN' }).valor).toBe('bot@dominio.es');
  });

  it('proveedoresDeClaves: uno por variable, el más concreto; webhook cuando el nombre no dice cuál', () => {
    expect(
      proveedoresDeClaves([
        'TELEGRAM_BOT_TOKEN',
        'TG_WEBHOOK_SECRET',
        'DISCORD_PUBLIC_KEY',
        'SLACK_SIGNING_SECRET',
        'WHATSAPP_TOKEN',
        'TWILIO_AUTH_TOKEN',
        'STRIPE_WEBHOOK_SECRET',
        'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
        'VITE_TELEGRAM_BOT_NAME',
        'BOT_TOKEN',
        'MY_BOT_TOKEN',
        'WEBHOOK_URL',
        'GITHUB_WEBHOOK_SECRET',
      ]),
    ).toEqual([
      { proveedor: 'telegram', clave: 'TELEGRAM_BOT_TOKEN' },
      { proveedor: 'telegram', clave: 'TG_WEBHOOK_SECRET' },
      { proveedor: 'discord', clave: 'DISCORD_PUBLIC_KEY' },
      { proveedor: 'slack', clave: 'SLACK_SIGNING_SECRET' },
      { proveedor: 'whatsapp', clave: 'WHATSAPP_TOKEN' },
      { proveedor: 'twilio', clave: 'TWILIO_AUTH_TOKEN' },
      { proveedor: 'stripe', clave: 'STRIPE_WEBHOOK_SECRET' },
      { proveedor: 'stripe', clave: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY' },
      { proveedor: 'telegram', clave: 'VITE_TELEGRAM_BOT_NAME' },
      { proveedor: 'webhook', clave: 'BOT_TOKEN' },
      { proveedor: 'webhook', clave: 'MY_BOT_TOKEN' },
      { proveedor: 'webhook', clave: 'WEBHOOK_URL' },
      { proveedor: 'webhook', clave: 'GITHUB_WEBHOOK_SECRET' },
    ]);
    // Sin el proveedor al principio del nombre (ni Stripe como tramo propio), nada.
    expect(proveedoresDeClaves(['SETTING_TG_ID', 'MYSTRIPE_KEY', 'DATABASE_URL', 'ROBOT_TOKENS'])).toEqual([]);
  });

  it('proveedoresDeClaves: los webhooks de salida (publicar en un canal) no reciben nada', () => {
    // Por el nombre: el webhook entrante de Slack y el de Discord son URLs a las que se publica.
    expect(proveedoresDeClaves(['SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'SLACK_ALERTS_WEBHOOK', 'NEXT_PUBLIC_DISCORD_WEBHOOK_URL'])).toEqual([]);
    // Por el valor, con cualquier nombre.
    expect(
      proveedoresDeClaves(['ALERTS_WEBHOOK_URL', 'AVISOS_WEBHOOK', 'TEAMS_WEBHOOK', 'WEBHOOK_URL'], {
        ALERTS_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/x',
        AVISOS_WEBHOOK: ' https://discord.com/api/webhooks/1/y ',
        TEAMS_WEBHOOK: 'https://empresa.webhook.office.com/webhookb2/z',
        WEBHOOK_URL: 'https://api.dominio.es/tg',
      }),
    ).toEqual([{ proveedor: 'webhook', clave: 'WEBHOOK_URL' }]);
    // Lo que recibe de Slack o de Discord sigue contando.
    expect(proveedoresDeClaves(['SLACK_SIGNING_SECRET', 'DISCORD_PUBLIC_KEY'], { SLACK_SIGNING_SECRET: 'x' })).toEqual([
      { proveedor: 'slack', clave: 'SLACK_SIGNING_SECRET' },
      { proveedor: 'discord', clave: 'DISCORD_PUBLIC_KEY' },
    ]);
  });

  it('planificar: una variable marcada como usuario (la referencia un SMTP_USER) no cambia y sale como nota', () => {
    const mapa: MapaCambio = { hosts: [], direcciones: [{ from: 'bot@dominio.es', to: 'bot@dominio2.es' }] };
    const plan = planificar(
      [
        valor('bot@dominio.es', { ambito: 'project', serviceId: null, key: 'LOGIN_CORREO', usuario: true }),
        valor('bot@dominio.es', { ambito: 'project', serviceId: null, key: 'AVISOS_PARA' }),
      ],
      mapa,
      'dominio.es',
    );
    expect(plan.cambios.map((c) => [c.key, c.despues])).toEqual([['AVISOS_PARA', 'bot@dominio2.es']]);
    expect(plan.usuarios.map((u) => [u.key, u.nombres])).toEqual([['LOGIN_CORREO', ['bot@dominio.es']]]);
  });
});
