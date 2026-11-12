#!/usr/bin/env node
/**
 * Prueba de humo del API contra una instancia real.
 *
 * No sustituye a las pruebas unitarias: comprueba lo que solo puede romperse
 * al desplegar (configuración, cookies, middleware, migraciones, arranque).
 *
 * Requisitos: el API escuchando en BASE_URL y un administrador creado con las
 * credenciales de SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD.
 *
 * Uso: BASE_URL=http://127.0.0.1:4000 node tests/smoke/api-smoke.mjs
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@ci.test';
const ADMIN_PASSWORD =
  process.env.SMOKE_ADMIN_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'ci-password-123456';

let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { response, body };
}

async function main() {
  console.log(`\nPrueba de humo contra ${BASE_URL}\n`);

  console.log('Salud del servicio');
  {
    const { response, body } = await request('/api/health/live');
    ok('GET /api/health/live responde 200', response.status === 200, `status ${response.status}`);
    ok('Informa estar vivo', body.status === 'ok', JSON.stringify(body));
  }
  {
    const { response, body } = await request('/api/health/ready');
    ok('GET /api/health/ready responde 200', response.status === 200, `status ${response.status}`);
    ok('La base de datos está disponible', body.database?.ok === true, JSON.stringify(body.database));
  }

  console.log('\nProtección CSRF');
  {
    const { response } = await request('/api/auth/login', {
      method: 'POST',
      headers: { Origin: 'https://atacante.example' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: 'x' }),
    });
    ok('Un origen ajeno recibe 403', response.status === 403, `status ${response.status}`);
  }

  console.log('\nSesión');
  {
    const { response } = await request('/api/auth/me');
    ok('Sin cookie, /api/auth/me responde 401', response.status === 401, `status ${response.status}`);
  }

  let sessionCookie = '';
  {
    const { response, body } = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    ok('Acceso con credenciales válidas', response.status === 200, `status ${response.status}`);
    ok('Devuelve el usuario', body.user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());

    const raw = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
    const combined = raw.join(';');
    ok('Establece la cookie de sesión', /session=/.test(combined), combined.slice(0, 80));
    ok('La cookie es HttpOnly', /HttpOnly/i.test(combined));
    ok('La cookie es SameSite=Lax', /SameSite=Lax/i.test(combined));
    sessionCookie = (combined.match(/session=[^;]+/) ?? [''])[0];
  }

  console.log('\nEndpoints autenticados');
  {
    const { response, body } = await request('/api/auth/me', { headers: { Cookie: sessionCookie } });
    ok('GET /api/auth/me con sesión', response.status === 200, `status ${response.status}`);
    ok('El rol llega correctamente', body.user?.role === 'admin', JSON.stringify(body.user));
  }
  {
    const { response } = await request('/api/dashboard', { headers: { Cookie: sessionCookie } });
    ok('GET /api/dashboard con sesión', response.status === 200, `status ${response.status}`);
  }
  {
    const { response } = await request('/api/loans', { headers: { Cookie: sessionCookie } });
    ok('GET /api/loans con sesión', response.status === 200, `status ${response.status}`);
  }

  console.log('\nCierre de sesión');
  {
    const { response } = await request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: sessionCookie },
    });
    ok('POST /api/auth/logout', response.status === 200, `status ${response.status}`);
  }

  // Este bloque va al final a propósito: deja la cuenta de prueba bloqueada
  // durante la ventana del throttle.
  console.log('\nThrottle de intentos fallidos');
  {
    const target = `throttle-${Date.now()}@example.test`;
    let blockedAt = 0;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const { response } = await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: target, password: `incorrecta-${attempt}` }),
      });
      if (response.status === 429) {
        blockedAt = attempt;
        break;
      }
    }
    ok('La cuenta se bloquea tras varios fallos', blockedAt > 0, `bloqueada en el intento ${blockedAt}`);
  }

  console.log(`\n${passed} comprobaciones correctas, ${failures.length} fallidas.`);
  if (failures.length > 0) {
    console.error('\nFallos:');
    for (const failure of failures) console.error(`  • ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nLa prueba de humo no pudo completarse:', error);
  process.exitCode = 1;
});
