import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'node:url';
import { extname, relative, resolve, sep } from 'node:path';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { pool } from './db/pool.js';
import { runAccrualCycle, setAccrualLogger } from './accrual.js';

/**
 * Punto de entrada del API.
 *
 * Responsabilidades de este archivo (y solo estas):
 *   1. Componer plugins de plataforma (seguridad, CORS, cookies, límites).
 *   2. Traducir errores a respuestas HTTP coherentes.
 *   3. Servir el build web en producción.
 *   4. Orquestar el ciclo de vida: devengo periódico y apagado ordenado.
 *
 * La lógica de negocio vive en `routes.ts` y los módulos de dominio.
 */

const isProduction = config.NODE_ENV === 'production';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    // Nunca registrar cookies ni cabeceras de autorización.
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  },
  requestIdHeader: 'x-request-id',
  bodyLimit: 1_048_576,
  // Detrás de Nginx/traefik/Cloudflare, sin esto `request.ip` es la IP del
  // proxy: el rate limit agruparía a todos los usuarios y el registro de
  // auditoría guardaría una IP falsa.
  trustProxy: config.TRUST_PROXY,
});

const isSecureHttp = config.COOKIE_SECURE;

await app.register(helmet, {
  // La CSP solo tiene sentido en producción; en desarrollo el API no sirve HTML.
  contentSecurityPolicy: isProduction
    ? {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // React aplica estilos como atributo `style` en varias vistas.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: isSecureHttp ? [] : null,
        },
      }
    : false,
  // HSTS solo debe enviarse cuando la conexión ya es HTTPS de extremo a extremo.
  hsts: isSecureHttp ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: isSecureHttp ? { policy: 'same-origin' } : false,
});

await app.register(cors, {
  origin: config.WEB_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

await app.register(cookie);

await app.register(rateLimit, {
  global: true,
  max: config.RATE_LIMIT_MAX,
  timeWindow: config.RATE_LIMIT_WINDOW,
  // Los sondeos de Docker/Kubernetes no deben consumir cuota ni bloquearse.
  allowList: (request) => request.url.startsWith('/api/health'),
});

/**
 * ¿El `Origin` de la petición es de confianza?
 *
 * Se acepta si coincide con `WEB_ORIGIN` **o** si es el mismo host que la propia
 * petición. Lo segundo evita el fallo más común en desarrollo y tras un proxy
 * que conserva `Host`: abrir la app en `127.0.0.1` cuando `WEB_ORIGIN` dice
 * `localhost` (son el mismo servidor, pero cadenas distintas).
 *
 * Un sitio atacante no puede falsear esto: el navegador fija `Host` con el
 * dominio visitado y `Origin` con el de la página, así que una petición
 * cruzada siempre los tendrá distintos.
 */
function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // Cliente no navegador (CLI, jobs, healthchecks).
  const normalized = origin.replace(/\/+$/, '');
  if (config.ALLOWED_ORIGIN_LIST.includes(normalized)) return true;
  try {
    return new URL(normalized).host === host;
  } catch {
    return false;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.addHook('onRequest', async (request, reply) => {
  if (!MUTATING_METHODS.has(request.method)) return;
  if (request.url.startsWith('/api/health')) return;
  const origin = request.headers.origin;
  if (isAllowedOrigin(origin, request.headers.host)) return;
  request.log.warn({ origin, host: request.headers.host, url: request.url }, 'Origen no permitido en petición mutante.');
  await reply.code(403).send({ error: 'Origen no autorizado.' });
});

app.setErrorHandler((error: FastifyError, request, reply) => {
  const status = error.statusCode ?? 500;

  // Errores de validación del esquema de Fastify.
  if (error.validation) {
    return reply.code(400).send({ error: 'La solicitud tiene datos inválidos.' });
  }

  // Errores de cliente conocidos (429 del rate limit, 413 de body limit, 404,
  // 401...). Antes se devolvían como 500, lo que rompía el backoff del cliente
  // y ocultaba la causa real en los logs.
  if (status >= 400 && status < 500) {
    if (status === 429) {
      return reply.code(429).send({ error: 'Demasiadas solicitudes. Espera un momento y reintenta.' });
    }
    if (status === 413) {
      return reply.code(413).send({ error: 'La solicitud supera el tamaño permitido.' });
    }
    request.log.warn({ err: error, status }, 'Solicitud rechazada por el cliente.');
    return reply.code(status).send({
      error: error.message || 'La solicitud no se pudo procesar.',
    });
  }

  request.log.error({ err: error }, 'API request failed');
  return reply.code(500).send({
    error: isProduction ? 'Ocurrió un error interno.' : error.message,
  });
});

app.setNotFoundHandler((request, reply) => {
  if (request.method !== 'GET' || request.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'No se encontró el recurso solicitado.' });
  }
  if (!isProduction) {
    return reply.code(404).send({ error: 'No se encontró el recurso solicitado.' });
  }
  return serveStatic(request.url, reply);
});

// ---------------------------------------------------------------------------
// Servido de archivos estáticos del frontend (solo producción)
// ---------------------------------------------------------------------------

const webRoot = resolve(fileURLToPath(new URL('../../dist/web/', import.meta.url)));
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Impide que una ruta codificada (`..`, `%2e%2e`) escape del directorio web. */
function isContained(candidate: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(webRoot);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}

async function serveStatic(url: string, reply: import('fastify').FastifyReply) {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return reply.code(400).send({ error: 'La ruta solicitada no es válida.' });
  }

  let filePath = resolve(webRoot, `.${pathname}`);
  if (!isContained(filePath)) return reply.code(404).send({ error: 'No se encontró el recurso solicitado.' });

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
    const finalInfo = await stat(filePath);
    if (!finalInfo.isFile() || !isContained(filePath)) throw new Error('not a file');

    const extension = extname(filePath).toLowerCase();
    reply.type(CONTENT_TYPES[extension] ?? 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    // Los assets llevan hash en el nombre: cacheables de forma indefinida.
    reply.header(
      'Cache-Control',
      extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    return reply.send(createReadStream(filePath));
  } catch {
    if (extname(pathname)) return reply.code(404).send({ error: 'No se encontró el recurso solicitado.' });
    const indexPath = resolve(webRoot, 'index.html');
    if (!isContained(indexPath)) return reply.code(500).send({ error: 'No se pudo servir la interfaz.' });
    return reply.type(CONTENT_TYPES['.html']).header('Cache-Control', 'no-cache').send(createReadStream(indexPath));
  }
}

// ---------------------------------------------------------------------------
// Rutas de negocio
// ---------------------------------------------------------------------------

await registerRoutes(app);

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

setAccrualLogger({
  error: (payload, message) => app.log.error(payload as object, message),
  warn: (payload, message) => app.log.warn(payload as object, message),
});

let accrualRunning = false;
let accrualTimer: NodeJS.Timeout | undefined;

async function accrue(reason: 'boot' | 'interval'): Promise<void> {
  if (accrualRunning) {
    app.log.warn({ reason }, 'El ciclo de devengo anterior sigue en curso; se omite este.');
    return;
  }
  accrualRunning = true;
  try {
    const summary = await runAccrualCycle();
    if (!summary.ran) {
      app.log.info({ reason }, 'Otra instancia está ejecutando el devengo; se omite.');
    } else {
      const level = summary.failed > 0 ? 'warn' : 'info';
      app.log[level](
        { reason, ...summary },
        summary.failed > 0 ? 'El devengo terminó con préstamos fallidos.' : 'Devengo completado.',
      );
    }
  } catch (error) {
    // Se reintenta en el siguiente intervalo; nunca se cae el proceso por esto.
    app.log.error({ err: error, reason }, 'El devengo diario no completó; se reintentará.');
  } finally {
    accrualRunning = false;
  }
}

function startAccrualSchedule(): void {
  if (!config.ACCRUAL_ENABLED) {
    app.log.warn('Devengo automático deshabilitado (ACCRUAL_ENABLED=false).');
    return;
  }
  if (config.ACCRUAL_RUN_ON_BOOT) void accrue('boot');
  accrualTimer = setInterval(
    () => void accrue('interval'),
    config.ACCRUAL_INTERVAL_MINUTES * 60 * 1000,
  );
  accrualTimer.unref();
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Apagando el servidor…');

  if (accrualTimer) clearInterval(accrualTimer);

  // Si el cierre se atasca (conexiones que no drenan), no dejamos el
  // contenedor colgado: el orquestador debe poder reiniciarnos.
  const forceExit = setTimeout(() => {
    app.log.error('El apagado ordenado excedió 15 s; se fuerza la salida.');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  try {
    await app.close();
    await pool.end();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Error durante el apagado.');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Un fallo no capturado deja el proceso en estado indefinido: es más seguro
// reiniciar (el orquestador lo hace) que seguir sirviendo datos inconsistentes.
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'Promesa rechazada sin manejar; reiniciando.');
  void shutdown('unhandledRejection');
});
process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'Excepción no capturada; reiniciando.');
  void shutdown('uncaughtException');
});

await app.listen({ host: config.HOST, port: config.PORT });
startAccrualSchedule();
