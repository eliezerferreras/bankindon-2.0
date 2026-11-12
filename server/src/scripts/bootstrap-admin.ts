import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';

const input = z.object({ BOOTSTRAP_ADMIN_NAME: z.string().min(2), BOOTSTRAP_ADMIN_EMAIL: z.string().email(), BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12) }).safeParse(process.env);
if (!input.success) {
  console.error('Define BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD (mínimo 12 caracteres) en el entorno.');
  process.exitCode = 1;
} else {
  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE role=\'admin\' LIMIT 1');
    if ((existing as unknown[]).length) {
      console.log('Ya existe un administrador en la base de datos; omitiendo creación inicial.');
    } else {
      const hash = await bcrypt.hash(input.data.BOOTSTRAP_ADMIN_PASSWORD, 12);
      await pool.execute("INSERT INTO users (name,email,password_hash,role,preferred_language) VALUES (?,?,?,'admin','es')", [input.data.BOOTSTRAP_ADMIN_NAME, input.data.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(), hash]);
      console.log('Administrador inicial creado exitosamente.');
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'No se pudo crear el administrador.'); process.exitCode = 1; }
  finally { await pool.end(); }
}
