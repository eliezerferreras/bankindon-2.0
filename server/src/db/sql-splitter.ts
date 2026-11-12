/**
 * Divisor de scripts SQL en sentencias individuales.
 *
 * Vive en su propio módulo (sin conexión a base de datos) para poder probarlo
 * de forma aislada.
 *
 * La versión anterior hacía `sql.split(';')`, que rompe cualquier `;` dentro
 * de una cadena, un comentario o un identificador entre comillas invertidas.
 * Aquí se recorre el texto con un autómata que distingue esos contextos.
 *
 * Los comentarios se descartan del resultado: el SQL que se envía a MySQL es
 * solo el ejecutable. La excepción son los comentarios versionados `/*! ... *\/`,
 * que MySQL sí ejecuta (los usan los volcados de `mysqldump`) y que por tanto
 * deben conservarse literalmente.
 *
 * También se descartan los fragmentos que quedan vacíos tras quitar
 * comentarios: enviarlos a MySQL produce el error 1065 («Query was empty»).
 */

type Mode = 'code' | 'single' | 'double' | 'backtick' | 'lineComment' | 'blockComment';

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  /** ¿El fragmento actual contiene algo ejecutable? */
  let hasCode = false;
  /** Conservar el cuerpo del comentario de bloque (comentario ejecutable). */
  let keepComment = false;
  let index = 0;
  let mode: Mode = 'code';

  const flush = () => {
    if (hasCode) statements.push(current.trim());
    current = '';
    hasCode = false;
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    switch (mode) {
      case 'code': {
        // Comentario de línea: "-- ..." o "# ..."
        if (char === '-' && next === '-') {
          mode = 'lineComment';
          index += 2;
          continue;
        }
        if (char === '#') {
          mode = 'lineComment';
          index += 1;
          continue;
        }
        if (char === '/' && next === '*') {
          // `/*!` es un comentario ejecutable: su contenido es SQL real.
          keepComment = sql[index + 2] === '!';
          mode = 'blockComment';
          if (keepComment) {
            current += char + next;
            hasCode = true;
          }
          index += 2;
          continue;
        }
        if (char === ';') {
          flush();
          break;
        }
        if (char === "'") {
          mode = 'single';
          current += char;
          hasCode = true;
          break;
        }
        if (char === '"') {
          mode = 'double';
          current += char;
          hasCode = true;
          break;
        }
        if (char === '`') {
          mode = 'backtick';
          current += char;
          hasCode = true;
          break;
        }
        if (!/\s/.test(char)) hasCode = true;
        current += char;
        break;
      }
      case 'single':
      case 'double': {
        const quote = mode === 'single' ? "'" : '"';
        // Barra invertida escapa el carácter siguiente.
        if (char === '\\' && index + 1 < sql.length) {
          current += char + next;
          index += 2;
          continue;
        }
        // '' dentro de la cadena representa una comilla literal.
        if (char === quote && next === quote) {
          current += char + next;
          index += 2;
          continue;
        }
        if (char === quote) mode = 'code';
        current += char;
        break;
      }
      case 'backtick': {
        if (char === '`') mode = 'code';
        current += char;
        break;
      }
      case 'lineComment': {
        // Se ignora el contenido hasta el fin de línea.
        if (char === '\n') mode = 'code';
        break;
      }
      case 'blockComment': {
        if (char === '*' && next === '/') {
          if (keepComment) current += char + next;
          mode = 'code';
          keepComment = false;
          index += 2;
          continue;
        }
        if (keepComment) current += char;
        break;
      }
    }
    index += 1;
  }

  flush();
  return statements;
}
