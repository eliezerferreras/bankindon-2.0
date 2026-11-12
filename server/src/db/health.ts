import { pingDatabase } from './pool.js';

/**
 * Sonda de disponibilidad de la base de datos.
 * Se mantiene como fachada para no romper importaciones existentes, pero
 * delega en `pingDatabase` para que solo haya una implementación.
 */
export async function checkDatabase(): Promise<boolean> {
  const result = await pingDatabase();
  return result.ok;
}

export { pingDatabase };
