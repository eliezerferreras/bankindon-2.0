import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuración central validada.
 *
 * Reglas de diseño:
 * - Todo valor de entorno se valida UNA sola vez, al arrancar (fail-fast).
 * - Nada de `process.env.X` disperso por el código: eso impide auditar la
 *   configuración y provoca comportamientos distintos entre procesos.
 * - Los secretos son independientes entre sí (ver DOCUMENT_KEY).
 */

/** Convierte "1", "true", "yes", "on" en true; "0", "false", "" en false. */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .preprocess((value) => {
      if (value === undefined || value === '') return undefined;
      if (typeof value === 'boolean') return value;
      return /^(1|true|yes|on|si|sí)$/i.test(String(value).trim());
    }, z.boolean())
    .default(defaultValue);

/** Igual que `booleanFromEnv` pero sin valor por defecto: puede quedar indefinido. */
const optionalBooleanFromEnv = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on|si|sí)$/i.test(String(value).trim());
}, z.boolean().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  /** Origen exacto del frontend, sin barra final. */
  WEB_ORIGIN: z
    .string()
    .transform((val) => (/^https?:\/\//i.test(val) ? val : `https://${val}`))
    .pipe(z.string().url())
    .transform((value) => value.replace(/\/+$/, ''))
    .default('http://localhost:5173'),

  /** Orígenes adicionales permitidos, separados por comas (p. ej. el dominio con y sin www). */
  ALLOWED_ORIGINS: z.string().default(''),

  /** Firma de sesiones (JWT). Rotarla invalida todas las sesiones activas. */
  APP_SECRET: z.string().min(32, 'APP_SECRET debe tener al menos 32 caracteres.'),

  /**
   * Clave dedicada para cifrar documentos de identidad (AES-256-GCM).
   * Debe ser DISTINTA de APP_SECRET: rotar la firma de sesiones no puede
   * dejar ilegibles los documentos ya guardados. Si se omite, se usa
   * APP_SECRET por compatibilidad con instalaciones existentes (se avisa).
   */
  DOCUMENT_KEY: z.string().min(32).optional(),

  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  /** `null` = se deriva de NODE_ENV (secure en producción). */
  COOKIE_SECURE: optionalBooleanFromEnv,
  /** `false`, `true` o una lista de subredes separadas por comas (p. ej. la del proxy). */
  TRUST_PROXY: z.string().default('false'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  /** El devengo en segundo plano reserva una conexión propia para su lock. */
  DB_POOL_SIZE: z.coerce.number().int().min(2).max(100).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  ACCRUAL_ENABLED: booleanFromEnv(true),
  ACCRUAL_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  /** Al arrancar se ejecuta un ciclo inmediato (idempotente). */
  ACCRUAL_RUN_ON_BOOT: booleanFromEnv(true),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100_000).default(120),
  RATE_LIMIT_WINDOW: z.string().min(2).default('1 minute'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

function parseConfiguration() {
  const result = schema.safeParse(process.env);
  if (result.success) return result.data;

  // Mensaje legible en vez de volcar el objeto completo de Zod.
  const problems = result.error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('\n');
  throw new Error(
    `Configuración inválida. Revisa tu archivo .env (compara con .env.example):\n${problems}`,
  );
}

const parsed = parseConfiguration();

const trustProxy: boolean | string[] = (() => {
  const raw = parsed.TRUST_PROXY.trim();
  const lowered = raw.toLowerCase();
  if (lowered === 'true' || lowered === '1') return true;
  if (lowered === 'false' || lowered === '0' || lowered === '') return false;
  // Lista de subredes del proxy: "10.0.0.0/8,172.16.0.0/12".
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
})();

/**
 * Orígenes de confianza para las peticiones que modifican datos.
 *
 * Incluye `WEB_ORIGIN`, la lista adicional y, fuera de producción, el alias
 * `localhost` / `127.0.0.1` del mismo puerto. Para el navegador son orígenes
 * distintos aunque sea la misma aplicación, y esa diferencia bloqueaba el
 * acceso al abrir la app con la IP en lugar del nombre.
 */
function buildAllowedOrigins(webOrigin: string, extra: string, isProduction: boolean): string[] {
  const origins = new Set<string>([webOrigin]);
  for (const entry of extra.split(',')) {
    const value = entry.trim().replace(/\/+$/, '');
    if (value) origins.add(value);
  }
  if (!isProduction) {
    for (const host of ['localhost', '127.0.0.1']) {
      try {
        const alias = new URL(webOrigin);
        alias.hostname = host;
        origins.add(alias.origin);
      } catch {
        // WEB_ORIGIN ya está validada; no puede fallar aquí.
      }
    }
  }
  return [...origins];
}

export const config = {
  ...parsed,
  TRUST_PROXY: trustProxy,
  COOKIE_SECURE: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === 'production',
  DOCUMENT_KEY: parsed.DOCUMENT_KEY ?? parsed.APP_SECRET,
  /** true cuando los documentos comparten clave con la firma (a corregir). */
  DOCUMENT_KEY_SHARED: parsed.DOCUMENT_KEY === undefined,
  IS_PRODUCTION: parsed.NODE_ENV === 'production',
  ALLOWED_ORIGIN_LIST: buildAllowedOrigins(
    parsed.WEB_ORIGIN,
    parsed.ALLOWED_ORIGINS,
    parsed.NODE_ENV === 'production',
  ),
} as const;

export type AppConfig = typeof config;

if (config.DOCUMENT_KEY_SHARED) {
  console.warn(
    '[config] DOCUMENT_KEY no está definida y se reutiliza APP_SECRET. ' +
      'Define una DOCUMENT_KEY independiente antes de rotar APP_SECRET, ' +
      'o los documentos de identidad existentes quedarán ilegibles.',
  );
}
