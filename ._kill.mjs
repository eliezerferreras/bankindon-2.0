import 'dotenv/config';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ?? '',
  timezone: 'Z',
});

// 1) Evidencia ANTES de matar la transacción bloqueada.
const [status] = await pool.query('SHOW ENGINE INNODB STATUS');
const text = status[0].Status ?? '';

console.log('=== Señales de atasco en InnoDB ===');
const interesting = text
  .split('\n')
  .filter((line) =>
    /checkpoint|log sequence|flushed|pending|LOG|TRANSACTION|lock wait|rollback|LSN/i.test(line),
  );
console.log(interesting.slice(0, 30).join('\n'));

// 2) Matar la conexión que retiene el bloqueo.
const [procs] = await pool.query('SHOW FULL PROCESSLIST');
const stuck = procs.filter(
  (p) => p.Command === 'Execute' && p.Time > 30 && p.db === process.env.DB_NAME,
);
console.log('\n=== Conexiones atascadas (>30 s ejecutando) ===');
if (!stuck.length) console.log('(ninguna)');
for (const p of stuck) {
  console.log(`  hilo ${p.Id} · ${p.Time} s · ${String(p.Info).slice(0, 60)}…`);
}

for (const p of stuck) {
  try {
    await pool.query(`KILL ${p.Id}`);
    console.log(`  → KILL ${p.Id} enviado`);
  } catch (error) {
    console.log(`  → no se pudo matar ${p.Id}: ${error.message}`);
  }
}

await new Promise((resolve) => setTimeout(resolve, 3000));

const [after] = await pool.query('SELECT * FROM information_schema.INNODB_TRX');
console.log(`\n=== Transacciones restantes: ${after.length} ===`);
for (const t of after) {
  console.log(`  trx ${t.trx_id} · ${t.trx_state} · hilo ${t.trx_mysql_thread_id}`);
}

await pool.end();
