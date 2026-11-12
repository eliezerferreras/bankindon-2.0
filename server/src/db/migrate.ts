import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool } from './pool.js';
import { splitStatements } from './sql-splitter.js';

export { splitStatements };

/**
 * Migrador de esquema.
 *
 * Correcciones respecto a la versión anterior:
 *  1. Lock de aviso (`GET_LOCK`): dos despliegues simultáneos ya no aplican la
 *     misma migración dos veces ni dejan el esquema a medias.
 *  2. Divisor de sentencias real (ver `sql-splitter.ts`): antes se hacía
 *     `sql.split(';')`, que rompe cualquier `;` dentro de una cadena, un
 *     comentario o un cuerpo de trigger.
 *  3. Checksum por migración: detecta que un archivo ya aplicado fue editado
 *     (la causa habitual de que un entorno se comporte distinto de otro).
 *  4. Se registra la migración solo si TODAS sus sentencias se aplicaron.
 *
 * Nota importante sobre MySQL: el DDL provoca un COMMIT implícito, así que una
 * migración con varias sentencias DDL no es atómica. Por eso cada archivo debe
 * ser idempotente (`CREATE TABLE IF NOT EXISTS`, etc.) o agrupar los cambios
 * por tabla en un único `ALTER TABLE`, que sí es atómico en MySQL 8.
 */

const MIGRATION_LOCK = 'bankindon:migrate';
const LOCK_TIMEOUT_SECONDS = 60;
const CHECKSUM_COLUMN = 'checksum';

const migrationDirectory = fileURLToPath(new URL('../../../database/migrations/', import.meta.url));

interface AppliedMigration {
  version: string;
  checksum: string | null;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function ensureMigrationsTable(connection: PoolConnection): Promise<void> {
  await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const [columns] = await connection.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = ?`,
    [CHECKSUM_COLUMN],
  );
  if (columns.length === 0) {
    // Las migraciones ya aplicadas quedan con checksum NULL: se aceptan y se
    // rellenan en la siguiente ejecución sin volver a ejecutarse.
    await connection.query(
      `ALTER TABLE schema_migrations ADD COLUMN ${CHECKSUM_COLUMN} CHAR(64) NULL`,
    );
  }
}

async function loadApplied(connection: PoolConnection): Promise<Map<string, AppliedMigration>> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const applied = new Map<string, AppliedMigration>();
  for (const row of rows) {
    applied.set(String(row.version), {
      version: String(row.version),
      checksum: row.checksum === null || row.checksum === undefined ? null : String(row.checksum),
    });
  }
  return applied;
}

async function acquireLock(connection: PoolConnection): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
    MIGRATION_LOCK,
    LOCK_TIMEOUT_SECONDS,
  ]);
  return Number(rows[0]?.acquired) === 1;
}

async function run(): Promise<void> {
  const connection = await pool.getConnection();
  let hasLock = false;
  let pending = 0;

  try {
    if (!(await acquireLock(connection))) {
      throw new Error(
        'Otro proceso está aplicando migraciones (no se obtuvo el lock). ' +
          'Espera a que termine y reintenta; no ejecutes migraciones en paralelo.',
      );
    }
    hasLock = true;

    await ensureMigrationsTable(connection);
    const applied = await loadApplied(connection);

    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
      .sort();

    if (files.length === 0) {
      console.log('No hay migraciones en database/migrations/.');
      return;
    }

    for (const file of files) {
      const version = file.replace(/\.sql$/i, '');
      const sql = await readFile(`${migrationDirectory}/${file}`, 'utf8');
      const checksum = checksumOf(sql);
      const previous = applied.get(version);

      if (previous) {
        if (previous.checksum && previous.checksum !== checksum) {
          console.warn(
            `[aviso] ${file} ya estaba aplicada pero su contenido cambió. ` +
              'No se vuelve a ejecutar. Crea una migración nueva para los cambios.',
          );
        } else if (!previous.checksum) {
          await connection.execute('UPDATE schema_migrations SET checksum=? WHERE version=?', [
            checksum,
            version,
          ]);
        }
        continue;
      }

      const statements = splitStatements(sql);
      console.log(`Aplicando ${file} (${statements.length} sentencias)…`);

      for (const [position, statement] of statements.entries()) {
        try {
          await connection.query(statement);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Falló ${file} en la sentencia ${position + 1}/${statements.length}: ${detail}\n` +
              `Sentencia: ${statement.slice(0, 300)}${statement.length > 300 ? '…' : ''}`,
          );
        }
      }

      await connection.execute('INSERT INTO schema_migrations (version, checksum) VALUES (?,?)', [
        version,
        checksum,
      ]);
      pending += 1;
      console.log(`Migración aplicada: ${file}`);
    }

    console.log(
      pending === 0 ? 'No hay migraciones pendientes.' : `Migraciones aplicadas: ${pending}.`,
    );
  } finally {
    if (hasLock) {
      await connection.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]).catch(() => undefined);
    }
    connection.release();
    await pool.end();
  }
}

try {
  await run();
} catch (error) {
  console.error('❌ Error al migrar:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
