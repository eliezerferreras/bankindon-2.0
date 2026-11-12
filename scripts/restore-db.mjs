#!/usr/bin/env node
/**
 * Restaura una copia de seguridad en la base de datos indicada.
 *
 * Es una operación DESTRUCTIVA sobre la base destino (la sobrescribe), así que
 * exige confirmación explícita:
 *
 *   CONFIRM_RESTORE=yes node scripts/restore-db.mjs
 *   CONFIRM_RESTORE=yes BACKUP=backups/bankindon-2026-11-10_19-28-39.sql.gz node scripts/restore-db.mjs
 *
 * Por defecto usa la copia más reciente de `backups/` y restaura en `DB_NAME`.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import mysql from 'mysql2/promise';

const TARGET = process.env.RESTORE_DB ?? process.env.DB_NAME;

function binPath(name) {
  const candidates = [
    'C:/xampp/mysql/bin',
    'C:/Program Files/MariaDB 11.8/bin',
    'C:/Program Files/MariaDB 10.11/bin',
    'C:/Program Files/MySQL/MySQL Server 8.4/bin',
  ];
  for (const dir of candidates) {
    const full = `${dir}/${name}.exe`;
    if (existsSync(full)) return full;
  }
  return name; // Linux / macOS: PATH
}

async function latestBackup() {
  const dir = resolve(process.env.BACKUP_DIR ?? 'backups');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql.gz')).sort();
  if (files.length === 0) throw new Error(`No hay copias en ${dir}.`);
  return join(dir, files[files.length - 1]);
}

async function countRows(connection, database) {
  const [tables] = await connection.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [database],
  );
  const counts = {};
  for (const { t } of tables) {
    const [rows] = await connection.query(`SELECT COUNT(*) AS c FROM \`${database}\`.\`${t}\``);
    counts[t] = Number(rows[0].c);
  }
  return counts;
}

const connection = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ?? '',
});

let workDir;
try {
  if (process.env.CONFIRM_RESTORE !== 'yes') {
    throw new Error(
      'Confirmación requerida: esta operación SOBRESCRIBE la base destino.\n' +
        `  Base destino: ${TARGET}\n` +
        '  Ejecuta: CONFIRM_RESTORE=yes node scripts/restore-db.mjs',
    );
  }
  if (!TARGET) throw new Error('Falta DB_NAME (o RESTORE_DB) en el entorno.');

  const backup = process.env.BACKUP ? resolve(process.env.BACKUP) : await latestBackup();
  console.log(`Copia:  ${backup} (${((await stat(backup)).size / 1024).toFixed(1)} KB)`);
  console.log(`Destino: ${TARGET} en ${process.env.DB_HOST}:${process.env.DB_PORT}`);

  workDir = await mkdtemp(join(tmpdir(), 'bankindon-restore-'));
  const sqlFile = join(workDir, 'dump.sql');
  await pipeline(createReadStream(backup), createGunzip(), createWriteStream(sqlFile));

  const sql = await readFile(sqlFile, 'utf8');
  // El volcado trae el nombre original; se redirige al destino elegido.
  const rewritten = sql
    .replace(/CREATE DATABASE[^;]*;/gi, '')
    .replace(/^USE `?[^`;\s]+`?;/gim, `USE \`${TARGET}\`;`);
  await writeFile(sqlFile, rewritten, 'utf8');

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${TARGET}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );

  console.log('\nRestaurando…');
  const startedAt = Date.now();
  const fd = openSync(sqlFile, 'r');
  const code = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      binPath('mysql'),
      [
        `--host=${process.env.DB_HOST ?? '127.0.0.1'}`,
        `--port=${process.env.DB_PORT ?? 3306}`,
        `--user=${process.env.DB_USER}`,
        `--password=${process.env.DB_PASSWORD ?? ''}`,
        '--skip-ssl',
        TARGET,
      ],
      { stdio: [fd, 'ignore', 'inherit'] },
    );
    child.on('error', rejectPromise);
    child.on('close', resolvePromise);
  });
  closeSync(fd);
  if (code !== 0) throw new Error(`El cliente mysql terminó con código ${code}.`);

  const counts = await countRows(connection, TARGET);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\n✓ Restauración completada en ${seconds} s`);
  console.log(`  ${Object.keys(counts).length} tablas, ${total} filas en total`);
  for (const [table, count] of Object.entries(counts)) {
    console.log(`    ${table.padEnd(24)} ${String(count).padStart(6)}`);
  }
  console.log('\nLa contraseña del administrador vuelve a la del momento de la copia.');
} catch (error) {
  console.error('✗ Restauración fallida:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  await connection.end().catch(() => undefined);
}
