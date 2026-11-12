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

const show = (title, rows) => {
  console.log(`\n=== ${title} ===`);
  if (!rows?.length) { console.log('(nada)'); return; }
  console.table(rows);
};

try {
  const [vars] = await pool.query(
    `SHOW VARIABLES WHERE Variable_name IN
     ('innodb_buffer_pool_size','innodb_log_file_size','innodb_lock_wait_timeout',
      'max_connections','version','wait_timeout','innodb_buffer_pool_instances')`,
  );
  show('configuración del motor', vars);

  const [procs] = await pool.query('SHOW FULL PROCESSLIST');
  show(
    'conexiones abiertas (id, usuario, host, bd, comando, tiempo, estado)',
    procs.map((p) => ({
      id: p.Id,
      db: p.db,
      cmd: p.Command,
      seg: p.Time,
      state: p.State,
      info: p.Info ? String(p.Info).slice(0, 70) : null,
    })),
  );

  const [trx] = await pool.query('SELECT * FROM information_schema.INNODB_TRX');
  show(
    'TRANSACCIONES ABIERTAS',
    trx.map((t) => ({
      trx_id: t.trx_id,
      estado: t.trx_state,
      inicio: t.trx_started,
      segundos: Math.round(t.trx_time ?? 0),
      hilo_mysql: t.trx_mysql_thread_id,
      filas_modificadas: t.trx_rows_modified,
      bloqueos: t.trx_lock_structs,
      consulta: t.trx_query ? String(t.trx_query).slice(0, 80) : null,
    })),
  );

  try {
    const [locks] = await pool.query('SELECT * FROM information_schema.INNODB_LOCKS');
    show('BLOQUEOS ACTIVOS', locks);
  } catch (e) {
    console.log('\nINNODB_LOCKS no disponible:', e.message);
  }

  try {
    const [waits] = await pool.query('SELECT * FROM information_schema.INNODB_LOCK_WAITS');
    show('ESPERAS POR BLOQUEO', waits);
  } catch (e) {
    console.log('\nINNODB_LOCK_WAITS no disponible:', e.message);
  }

  const [tables] = await pool.query(
    `SELECT TABLE_NAME AS tabla, TABLE_ROWS AS filas, DATA_LENGTH AS datos
     FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
     ORDER BY TABLE_NAME`,
  );
  console.log(`\nTablas en ${process.env.DB_NAME}: ${tables.length}`);
} catch (error) {
  console.error('ERROR:', error.code, error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
