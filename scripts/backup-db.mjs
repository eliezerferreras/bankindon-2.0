#!/usr/bin/env node
/**
 * Copia de seguridad lógica de la base de datos.
 *
 * Por qué no basta con un `mysqldump > copia.sql`:
 *  - la contraseña nunca debe viajar en la línea de comandos (es visible en el
 *    listado de procesos): se pasa por un archivo de opciones temporal;
 *  - los clientes recientes de MariaDB exigen TLS por defecto y fallan contra
 *    servidores locales que no lo ofrecen, así que se reintenta con variantes
 *    de SSL en lugar de dejar al usuario con un «código 2» sin explicación;
 *  - una copia truncada es peor que ninguna: si algo falla, se borra el archivo.
 *
 * Uso:
 *   node scripts/backup-db.mjs
 *   BACKUP_DIR=D:\copias RETENTION=30 node scripts/backup-db.mjs
 *
 * En Hostinger, programa este comando a diario desde el cron de hPanel.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const BACKUP_DIR = resolve(process.env.BACKUP_DIR ?? 'backups');
const RETENTION = Number(process.env.RETENTION ?? 14);

const ABSOLUTE_CANDIDATES = [
  process.env.MYSQLDUMP_PATH,
  'C:/Program Files/MariaDB 11.8/bin/mysqldump.exe',
  'C:/Program Files/MariaDB 10.11/bin/mysqldump.exe',
  'C:/Program Files/MariaDB 10.4/bin/mysqldump.exe',
  'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqldump.exe',
  'C:/xampp/mysql/bin/mysqldump.exe',
  '/usr/bin/mysqldump',
  '/usr/local/bin/mysqldump',
  '/opt/homebrew/bin/mysqldump',
].filter(Boolean);

/** Variantes de SSL, de la menos a la más explícita. */
const SSL_VARIANTS = [[], ['--skip-ssl'], ['--ssl-mode=DISABLED'], ['--ssl=0']];

/**
 * Ejecutables que existen realmente. En Windows `spawn('mysqldump')` no resuelve
 * la extensión `.exe`, así que se comprueban rutas absolutas y el nombre suelto
 * queda como último recurso (en Linux normalmente está en el PATH).
 */
function mysqldumpCandidates() {
  const found = [];
  const fromEnv = process.env.MYSQLDUMP_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`MYSQLDUMP_PATH no existe: ${fromEnv}`);
    found.push(fromEnv);
  }
  for (const candidate of ABSOLUTE_CANDIDATES) {
    if (existsSync(candidate) && !found.includes(candidate)) found.push(candidate);
  }
  found.push('mysqldump');
  return found;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/** Un intento de volcado. Devuelve `{ code, stderr }` en lugar de lanzar. */
async function attemptDump(dumpBinary, optionFile, targetFile, errorFile, sslArgs) {
  const args = [
    `--defaults-extra-file=${optionFile}`,
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--default-character-set=utf8mb4',
    ...sslArgs,
    '--databases',
    process.env.DB_NAME,
  ];

  const fd = openSync(targetFile, 'w');
  const errFd = openSync(errorFile, 'w');
  try {
    const code = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(dumpBinary, args, { stdio: ['ignore', fd, errFd] });
      child.on('error', rejectPromise);
      child.on('close', (value) => resolvePromise(value));
    });
    return { code, stderr: (await readFile(errorFile, 'utf8')).trim() };
  } finally {
    closeSync(fd);
    closeSync(errFd);
  }
}

async function pruneOldBackups() {
  const files = (await readdir(BACKUP_DIR))
    .filter((file) => /^bankindon-.*\.sql(\.gz)?$/.test(file))
    .sort()
    .reverse();
  const excess = files.slice(RETENTION);
  for (const file of excess) await rm(join(BACKUP_DIR, file), { force: true });
  return excess.length;
}

async function main() {
  if (!process.env.DB_NAME) throw new Error('Falta DB_NAME en el entorno.');
  if (!process.env.DB_USER) throw new Error('Falta DB_USER en el entorno.');
  await mkdir(BACKUP_DIR, { recursive: true });

  const dumpBinary = mysqldumpCandidates()[0];
  const base = join(BACKUP_DIR, `bankindon-${timestamp()}`);
  const plainFile = `${base}.sql`;
  const gzFile = `${base}.sql.gz`;
  const optionFile = join(BACKUP_DIR, `.dump-${process.pid}.cnf`);
  const errorFile = join(BACKUP_DIR, `.dump-${process.pid}.err`);

  await writeFile(
    optionFile,
    `[client]\nhost=${process.env.DB_HOST ?? '127.0.0.1'}\nport=${process.env.DB_PORT ?? 3306}\nuser=${process.env.DB_USER}\npassword=${process.env.DB_PASSWORD ?? ''}\n`,
    { mode: 0o600 },
  );

  console.log(`Copiando ${process.env.DB_NAME} con ${dumpBinary}…`);
  const startedAt = Date.now();

  let lastError = '';
  let succeed = false;
  try {
    for (const sslArgs of SSL_VARIANTS) {
      const { code, stderr } = await attemptDump(
        dumpBinary,
        optionFile,
        plainFile,
        errorFile,
        sslArgs,
      );
      if (code === 0) {
        // mysqldump puede terminar en 0 con avisos: se muestran igualmente.
        if (stderr && !/insecure passwordless login/i.test(stderr)) {
          console.warn(`  aviso de mysqldump: ${stderr.split('\n')[0]}`);
        }
        succeed = true;
        break;
      }
      lastError = stderr || `código ${code}`;
      // Solo tiene sentido reintentar si el problema es de negociación TLS.
      const isSslIssue = /SSL|TLS/i.test(lastError);
      if (!isSslIssue) break;
      console.log(`  reintentando sin TLS (${sslArgs.join(' ') || 'por defecto'})…`);
    }

    if (!succeed) throw new Error(lastError);

    const plainSize = (await stat(plainFile)).size;
    if (plainSize === 0) throw new Error('La copia quedó vacía.');

    await pipeline(createReadStream(plainFile), createGzip({ level: 9 }), createWriteStream(gzFile));
    const gzSize = (await stat(gzFile)).size;
    await rm(plainFile, { force: true });

    const pruned = await pruneOldBackups();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log(`✓ Copia creada: ${gzFile}`);
    console.log(
      `  ${(gzSize / 1024).toFixed(1)} KB comprimida (${(plainSize / 1024).toFixed(1)} KB) en ${seconds} s`,
    );
    if (pruned > 0) console.log(`  Eliminadas ${pruned} copia(s) antiguas (retención: ${RETENTION}).`);
    console.log(
      '\nGuarda una copia FUERA de este equipo: una copia en el mismo disco no protege de un fallo de disco.',
    );
  } finally {
    // Limpieza en cualquier caso: nunca dejar restos ni copias a medias.
    if (!succeed) await rm(plainFile, { force: true });
    await rm(optionFile, { force: true });
    await rm(errorFile, { force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error('✗ La copia falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
