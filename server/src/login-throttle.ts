import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from './db/pool.js';
import { config } from './config.js';

/**
 * Throttle de intentos de acceso por cuenta.
 *
 * El límite global de peticiones no protege una cuenta concreta: un atacante
 * distribuido puede probar contraseñas contra el mismo correo sin acercarse a
 * ese límite. Aquí contamos los fallos por cuenta en una ventana temporal.
 *
 * Se guarda un hash del correo, no el correo: basta para contar y evita
 * almacenar datos personales en una tabla de alta rotación.
 *
 * Si la tabla no existe (migración 006 pendiente) el throttle se desactiva y
 * se registra un aviso: es preferible permitir el acceso a bloquear a todos
 * los usuarios por un problema de despliegue.
 */

const PRUNE_PROBABILITY = 1 / 50;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashAccount(email: string): string {
  return sha256(email.trim().toLowerCase());
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // Sal propia del despliegue: evita revertir el hash por diccionario de IPs.
  return sha256(`${config.APP_SECRET}:${ip}`);
}

export interface ThrottleDecision {
  blocked: boolean;
  failures: number;
  retryAfterMinutes: number;
}

export async function checkLoginThrottle(email: string): Promise<ThrottleDecision> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS failures FROM login_attempts
       WHERE email_hash = ? AND succeeded = 0
         AND attempted_at >= NOW() - INTERVAL ? MINUTE`,
      [hashAccount(email), config.LOGIN_WINDOW_MINUTES],
    );
    const failures = Number(rows[0]?.failures ?? 0);
    return {
      blocked: failures >= config.LOGIN_MAX_ATTEMPTS,
      failures,
      retryAfterMinutes: failures >= config.LOGIN_MAX_ATTEMPTS ? config.LOGIN_WINDOW_MINUTES : 0,
    };
  } catch (error) {
    console.warn(
      '[login-throttle] No se pudo consultar login_attempts; el throttle queda inactivo.',
      error instanceof Error ? error.message : error,
    );
    return { blocked: false, failures: 0, retryAfterMinutes: 0 };
  }
}

export async function recordLoginAttempt(input: {
  email: string;
  ip: string | undefined;
  succeeded: boolean;
}): Promise<void> {
  try {
    await pool.execute(
      'INSERT INTO login_attempts (email_hash, ip_hash, succeeded) VALUES (?,?,?)',
      [hashAccount(input.email), hashIp(input.ip), input.succeeded ? 1 : 0],
    );
    if (Math.random() < PRUNE_PROBABILITY) {
      await pool.execute(
        'DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL 30 DAY',
      );
    }
  } catch (error) {
    console.warn(
      '[login-throttle] No se pudo registrar el intento de acceso.',
      error instanceof Error ? error.message : error,
    );
  }
}

/** Tras un acceso correcto se limpia el contador de esa cuenta. */
export async function clearLoginFailures(email: string): Promise<void> {
  try {
    await pool.execute('DELETE FROM login_attempts WHERE email_hash = ? AND succeeded = 0', [
      hashAccount(email),
    ]);
  } catch {
    // Sin consecuencia funcional: los fallos caducan por la ventana temporal.
  }
}
