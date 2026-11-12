#!/usr/bin/env node
/**
 * Migra los clientes del volcado SQL de la app antigua (PHP) a la app nueva.
 *
 * Solo traslada lo que el modelo nuevo (`clients`) necesita:
 *   nombre, apellidos, tipo/número de documento, teléfono, país del documento,
 *   correo, dirección, fecha de nacimiento, estado y fecha de alta.
 *
 * Por seguridad se ejecuta en modo simulación. Para escribir de verdad:
 *
 *   node scripts/import-old-clients.mjs --apply
 *
 * Opciones:
 *   --apply              Escribe en la base de datos (sin esto solo simula).
 *   --dump=RUTA          Volcado de origen. Por defecto busca el de `bankindon/`.
 *   --user=ID            Usuario nuevo que quedará como `created_by`.
 *   --verbose            Muestra también los clientes listos.
 *   --json               Imprime el informe completo en JSON.
 *
 * Notas de la migración:
 *  - Los duplicados se detectan con la misma regla que la app nueva
 *    (tipo + número sin acentos, mayúsculas ni signos).
 *  - Las fotos del dump antiguo son nombres de archivo, no imágenes reales;
 *    no se pueden trasladar a `client_documents`.
 *  - Los garantes de texto libre (`garante_nombre`) no existen como clientes
 *    en la app nueva; se informan para revisarlos a mano.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

const DEFAULT_DUMP = 'bankindon/u269370433_bankindon01(1).sql';
const PLACEHOLDER_PHONE = 'SIN TELÉFONO';
const PLACEHOLDER_LAST_NAME = 'SIN APELLIDO';

/* ------------------------------------------------------------------ */
/* Argumentos                                                          */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    apply: false,
    verbose: false,
    json: false,
    dump: process.env.OLD_DUMP ?? DEFAULT_DUMP,
    user: null,
  };

  for (const raw of argv) {
    if (raw === '--apply') options.apply = true;
    else if (raw === '--verbose') options.verbose = true;
    else if (raw === '--json') options.json = true;
    else if (raw.startsWith('--dump=')) options.dump = raw.slice('--dump='.length);
    else if (raw.startsWith('--user=')) options.user = Number(raw.slice('--user='.length));
    else if (!raw.startsWith('--')) options.dump = raw;
    else throw new Error(`Opción desconocida: ${raw}`);
  }

  if (options.user !== null && (!Number.isInteger(options.user) || options.user <= 0)) {
    throw new Error('--user debe ser un id de usuario válido.');
  }

  return options;
}

/* ------------------------------------------------------------------ */
/* Lectura del volcado SQL                                            */
/* ------------------------------------------------------------------ */

const ESCAPES = {
  0: '\0',
  b: '\b',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '\x1a',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '%': '%',
  _: '_',
};

function parseScalar(raw) {
  const value = raw.trim();
  if (/^null$/i.test(value)) return null;
  if (/^0x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), 'hex');
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Lee una tupla `(...)` de un INSERT y devuelve sus valores.
 * Respeta comillas simples/dobles y los escapes de MySQL.
 */
function parseTuple(sql, start) {
  const values = [];
  let index = start + 1;
  let token = '';
  let quoted = false;
  let wasQuoted = false;
  let quote = '';
  let stringValue = '';

  const push = () => {
    values.push(wasQuoted ? stringValue : parseScalar(token));
    token = '';
    stringValue = '';
    quoted = false;
    wasQuoted = false;
    quote = '';
  };

  while (index < sql.length) {
    const char = sql[index];

    if (quoted) {
      if (char === '\\') {
        const next = sql[index + 1];
        stringValue += ESCAPES[next] ?? next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) {
        if (sql[index + 1] === quote) {
          stringValue += quote;
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      stringValue += char;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quoted = true;
      wasQuoted = true;
      quote = char;
      index += 1;
      continue;
    }
    if (char === ',') {
      push();
      index += 1;
      continue;
    }
    if (char === ')') {
      push();
      return { values, next: index + 1 };
    }

    token += char;
    index += 1;
  }

  throw new Error('El INSERT de clientes está incompleto o mal formado.');
}

function extractClientRows(sql) {
  const marker = /INSERT\s+INTO\s+`clientes`\s*\(([^)]*)\)\s*VALUES/gi;
  const rows = [];
  let match;

  while ((match = marker.exec(sql)) !== null) {
    const columns = match[1]
      .split(',')
      .map((column) => column.trim().replace(/^`|`$/g, ''));

    let index = marker.lastIndex;
    while (index < sql.length) {
      while (index < sql.length && /[\s,]/.test(sql[index])) index += 1;
      if (sql[index] === ';') break;
      if (sql[index] !== '(') {
        throw new Error(`Se esperaba una tupla de valores en la posición ${index}.`);
      }
      const tuple = parseTuple(sql, index);
      const record = {};
      columns.forEach((column, columnIndex) => {
        record[column] = tuple.values[columnIndex];
      });
      rows.push(record);
      index = tuple.next;
    }
    marker.lastIndex = index;
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/* Normalización                                                       */
/* ------------------------------------------------------------------ */

const withoutAccents = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function cleanDocumentType(value) {
  const original = cleanText(value);
  const key = withoutAccents(original).toLowerCase();
  if (['cedula', 'cedula de identidad', 'cedula de ciudadania'].includes(key)) return 'Cédula';
  if (['pasaporte', 'passport'].includes(key)) return 'Pasaporte';
  if (key === 'dni') return 'DNI';
  if (key === 'nie') return 'NIE';
  if (key === 'tie') return 'TIE';
  return original || 'Otro';
}

function documentKey(type, number) {
  const normalize = (value) =>
    withoutAccents(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${normalize(type)}:${normalize(number)}`;
}

function cleanDocumentNumber(value) {
  return cleanText(value).toUpperCase();
}

/** País emisor del documento, según el tipo y (para pasaportes) la nacionalidad. */
function countryCode(documentType, nationality) {
  const type = withoutAccents(documentType).toLowerCase();
  if (['dni', 'nie', 'tie'].includes(type)) return 'ES';
  if (type === 'cedula') return 'DO';

  const country = withoutAccents(nationality).toLowerCase();
  if (country.includes('dominic')) return 'DO';
  if (country.includes('espana') || country.includes('espanol')) return 'ES';
  if (country.includes('estados unidos') || country.includes('usa')) return 'US';
  return 'OT';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(value) {
  const email = cleanText(value);
  if (!email) return { email: null, warning: null };
  if (!EMAIL_PATTERN.test(email)) {
    return { email: null, warning: `correo inválido «${email}»; se guardará vacío` };
  }
  return { email, warning: null };
}

function cleanDate(value) {
  const text = cleanText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return { date: null, warning: null };
  if (match[1] === '0000') {
    return { date: null, warning: 'fecha de nacimiento inválida (0000-00-00); se guardará vacía' };
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    year < 1900 ||
    parsed.getTime() > Date.now()
  ) {
    return { date: null, warning: `fecha de nacimiento fuera de rango «${text}»; se guardará vacía` };
  }
  return { date: `${match[1]}-${match[2]}-${match[3]}`, warning: null };
}

function cleanTimestamp(...candidates) {
  for (const candidate of candidates) {
    const text = cleanText(candidate);
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
    if (!match || match[1] === '0000') continue;
    return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Mapeo                                                               */
/* ------------------------------------------------------------------ */

function mapClient(record) {
  const warnings = [];
  const oldId = Number(record.id);
  const firstName = cleanText(record.nombre);
  const rawLastName = cleanText(record.apellidos) || cleanText(record.apellido);
  const lastName = rawLastName || PLACEHOLDER_LAST_NAME;
  const documentType = cleanDocumentType(record.tipo_documento);
  const documentNumber = cleanDocumentNumber(record.identificacion);
  const rawPhone = cleanText(record.telefono);
  const phone = rawPhone || PLACEHOLDER_PHONE;
  const email = cleanEmail(record.email);
  const birth = cleanDate(record.fecha_nacimiento);
  const address = cleanText(record.direccion) || null;
  const status = Number(record.activo) === 1 || record.activo === true ? 'active' : 'inactive';
  const createdAt = cleanTimestamp(record.fecha_registro, record.creado_en);

  if (!rawLastName) warnings.push('sin apellidos; se usará «SIN APELLIDO»');
  if (!rawPhone) warnings.push('sin teléfono; se usará «SIN TELÉFONO»');
  if (email.warning) warnings.push(email.warning);
  if (birth.warning) warnings.push(birth.warning);
  if (!createdAt) warnings.push('sin fecha de alta válida; se usará la fecha actual');

  const guarantorName = cleanText(record.garante_nombre);
  const guarantorOldId = Number(record.garante_id) || null;

  return {
    oldId,
    client: {
      firstName,
      lastName,
      documentType,
      documentNumber,
      phone,
      countryCode: countryCode(documentType, record.nacionalidad),
      email: email.email,
      address,
      birthDate: birth.date,
      status,
      createdAt,
      guarantorOldId,
    },
    warnings,
    guarantorName,
  };
}

/* ------------------------------------------------------------------ */
/* Proceso principal                                                   */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dumpPath = resolve(options.dump);

  if (!existsSync(dumpPath)) {
    throw new Error(`No se encontró el volcado: ${dumpPath}`);
  }
  if (!process.env.DB_NAME || !process.env.DB_USER) {
    throw new Error('Faltan DB_NAME o DB_USER en el entorno (.env).');
  }

  const sql = await readFile(dumpPath, 'utf8');
  const records = extractClientRows(sql);
  if (records.length === 0) {
    throw new Error('No se encontró ningún INSERT INTO `clientes` en el volcado.');
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME,
    multipleStatements: false,
  });

  try {
    const [userRows] = await connection.query(
      "SELECT id, name, role, status FROM users WHERE (? IS NULL OR id = ?) AND status = 'active' ORDER BY FIELD(role, 'admin', 'supervisor', 'collector'), id LIMIT 1",
      [options.user, options.user],
    );
    const creator = userRows[0];
    if (!creator) {
      throw new Error(
        options.user
          ? `No existe un usuario activo con id ${options.user}.`
          : 'No hay ningún usuario activo para asignar como creador de los clientes.',
      );
    }

    const [existingRows] = await connection.query(
      'SELECT id, document_type, document_number FROM clients',
    );
    const existing = new Map(
      existingRows.map((row) => [documentKey(row.document_type, row.document_number), row.id]),
    );

    const items = [];
    const seen = new Map();
    const mapped = [];

    for (const record of records) {
      const item = mapClient(record);
      const key = documentKey(item.client.documentType, item.client.documentNumber);

      if (!item.client.firstName || !item.client.documentNumber) {
        items.push({ ...item, status: 'invalid', message: 'sin nombre o número de documento' });
        continue;
      }
      if (existing.has(key)) {
        items.push({
          ...item,
          status: 'duplicate',
          message: `ya existe en la base nueva con id ${existing.get(key)}`,
        });
        continue;
      }
      if (seen.has(key)) {
        items.push({
          ...item,
          status: 'duplicate',
          message: `documento repetido en el volcado (también aparece en el id ${seen.get(key)})`,
        });
        continue;
      }

      seen.set(key, item.oldId);
      mapped.push(item);
      items.push({ ...item, status: 'ready' });
    }

    const ready = items.filter((item) => item.status === 'ready');
    const duplicates = items.filter((item) => item.status === 'duplicate');
    const invalid = items.filter((item) => item.status === 'invalid');
    const warnings = items.flatMap((item) =>
      item.warnings.map((warning) => ({ oldId: item.oldId, warning })),
    ).concat(
      items
        .filter((item) => item.guarantorName || item.client.guarantorOldId)
        .map((item) => ({
          oldId: item.oldId,
          warning: `garante de texto libre «${item.guarantorName || item.client.guarantorOldId}»; la app nueva solo admite garantes que sean clientes`,
        })),
    );

    let imported = 0;
    let guarantorsLinked = 0;

    if (options.apply) {
      await connection.beginTransaction();
      try {
        const oldToNew = new Map();
        for (const item of ready) {
          const client = item.client;
          const [result] = await connection.execute(
            `INSERT INTO clients
              (first_name, last_name, document_type, document_number, phone, country_code,
               email, address, birth_date, status, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              client.firstName,
              client.lastName,
              client.documentType,
              client.documentNumber,
              client.phone,
              client.countryCode,
              client.email,
              client.address,
              client.birthDate,
              client.status,
              creator.id,
              client.createdAt ?? new Date(),
              client.createdAt ?? new Date(),
            ],
          );
          oldToNew.set(item.oldId, result.insertId);
          imported += 1;
        }

        for (const item of ready) {
          if (!item.client.guarantorOldId) continue;
          const newId = oldToNew.get(item.oldId);
          const guarantorId = oldToNew.get(item.client.guarantorOldId);
          if (!newId || !guarantorId || newId === guarantorId) continue;
          await connection.execute('UPDATE clients SET guarantor_client_id=? WHERE id=?', [
            guarantorId,
            newId,
          ]);
          guarantorsLinked += 1;
        }

        await connection.execute(
          `INSERT INTO audit_events
            (actor_id, action, entity_type, entity_id, request_id, after_data)
           VALUES (?, 'client.import', 'client', NULL, ?, ?)`,
          [
            creator.id,
            randomUUID(),
            JSON.stringify({
              source: dumpPath,
              total: records.length,
              imported,
              duplicates: duplicates.length,
              invalid: invalid.length,
              warnings: warnings.length,
              guarantorsLinked,
            }),
          ],
        );

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }

    const report = {
      mode: options.apply ? 'apply' : 'dry-run',
      dump: dumpPath,
      database: process.env.DB_NAME,
      creator: { id: creator.id, name: creator.name, role: creator.role },
      total: records.length,
      ready: ready.length,
      imported,
      duplicates: duplicates.length,
      invalid: invalid.length,
      warnings,
      guarantorsLinked,
      items: items.map((item) => ({
        oldId: item.oldId,
        status: item.status,
        message: item.message ?? null,
        warnings: item.warnings,
        client: item.client,
      })),
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Origen:  ${dumpPath}`);
    console.log(`Destino: ${process.env.DB_NAME} en ${process.env.DB_HOST}:${process.env.DB_PORT}`);
    console.log(`Creador: ${creator.name} (id ${creator.id}, ${creator.role})`);
    console.log('');
    console.log(`Clientes en el volcado:      ${records.length}`);
    console.log(`Listos para importar:        ${ready.length}`);
    console.log(`Duplicados omitidos:         ${duplicates.length}`);
    console.log(`Inválidos omitidos:          ${invalid.length}`);
    console.log(`Avisos de datos:             ${warnings.length}`);
    if (options.apply) {
      console.log(`Importados:                  ${imported}`);
      console.log(`Garantes vinculados:         ${guarantorsLinked}`);
    }

    if (duplicates.length) {
      console.log('\nDuplicados:');
      for (const item of duplicates) {
        console.log(`  id ${String(item.oldId).padStart(3)} · ${item.client.documentType} ${item.client.documentNumber} · ${item.message}`);
      }
    }
    if (invalid.length) {
      console.log('\nInválidos:');
      for (const item of invalid) {
        console.log(`  id ${String(item.oldId).padStart(3)} · ${item.client.firstName} · ${item.message}`);
      }
    }
    if (warnings.length) {
      console.log('\nAvisos:');
      for (const warning of warnings) {
        console.log(`  id ${String(warning.oldId).padStart(3)} · ${warning.warning}`);
      }
    }
    if (options.verbose) {
      console.log('\nClientes listos:');
      for (const item of ready) {
        const client = item.client;
        console.log(
          `  id ${String(item.oldId).padStart(3)} · ${client.firstName} ${client.lastName} · ${client.documentType} ${client.documentNumber} · ${client.countryCode} · ${client.status}`,
        );
      }
    }

    if (!options.apply) {
      console.log('\nSimulación: no se escribió nada. Ejecuta con --apply para importar.');
    } else {
      console.log('\n✓ Migración completada.');
    }
  } finally {
    await connection.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  console.error('✗ La migración falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
