import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';

const input = z.object({ RESET_ADMIN_EMAIL: z.string().email().optional(), RESET_ADMIN_PASSWORD: z.string().min(12).max(200) }).safeParse(process.env);
if (!input.success) {
  console.error('Define RESET_ADMIN_PASSWORD. La contraseña debe tener entre 12 y 200 caracteres. RESET_ADMIN_EMAIL es opcional si solo existe un administrador.');
  process.exitCode = 1;
} else {
  try {
    const [rows] = input.data.RESET_ADMIN_EMAIL
      ? await pool.execute("SELECT id FROM users WHERE email=? AND role='admin' AND status='active' LIMIT 2", [input.data.RESET_ADMIN_EMAIL.toLowerCase()])
      : await pool.query("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 2");
    const admins = rows as Array<{id:string}>;
    if (!admins.length) throw new Error('No se encontró un administrador activo.');
    if (!input.data.RESET_ADMIN_EMAIL && admins.length !== 1) throw new Error('Hay más de un administrador activo; define RESET_ADMIN_EMAIL para elegir la cuenta.');
    const admin = admins[0];
    const passwordHash = await bcrypt.hash(input.data.RESET_ADMIN_PASSWORD, 12);
    await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, admin.id]);
    await pool.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_data) VALUES (?,'user.admin_password_reset','user',?,JSON_OBJECT('method','local_cli'))", [admin.id, admin.id]);
    console.log('Contraseña del administrador actualizada. Ya puedes iniciar sesión con la nueva contraseña.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'No se pudo actualizar la contraseña.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
