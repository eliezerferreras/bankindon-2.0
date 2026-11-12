import mysql from 'mysql2/promise';
import { config } from '../config.js';

/**
 * Pool de conexiones MySQL.
 *
 * Decisiones que afectan a la corrección del dinero:
 * - `decimalNumbers: false` + `bigNumberStrings: true`: los DECIMAL y los IDs
 *   BIGINT llegan como cadenas. Convertirlos a `number` perdería precisión en
 *   importes grandes; todo el dominio trabaja en céntimos con `bigint`.
 * - `timezone: 'Z'` + `dateStrings` implícito: MySQL guarda DATETIME sin zona;
 *   tratamos todo como UTC y calculamos la fecha de negocio con la zona de
 *   `company_settings`.
 * - `multipleStatements: false`: cada consulta es una sola sentencia, lo que
 *   limita el daño de una inyección.
 */
export const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  connectionLimit: config.DB_POOL_SIZE,
  waitForConnections: true,
  // Cola acotada: mejor rechazar rápido que acumular peticiones sin límite.
  queueLimit: 500,
  connectTimeout: config.DB_CONNECT_TIMEOUT_MS,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: 'Z',
  charset: 'utf8mb4',
  decimalNumbers: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  multipleStatements: false,
});

/**
 * Comprueba que la base de datos responde. Usado por el readiness probe.
 * No lanza: devuelve el resultado para que la ruta decida el código HTTP.
 */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    const connection = await pool.getConnection();
    try {
      await connection.query('SELECT 1');
    } finally {
      connection.release();
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
