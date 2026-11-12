import assert from 'node:assert/strict';
import test from 'node:test';
import { splitStatements } from '../../server/src/db/sql-splitter.js';

/**
 * El migrador ejecuta cada sentencia por separado. Un divisor incorrecto es
 * silencioso: no falla al dividir, falla después con un SQL inválido o, peor,
 * ejecuta una sentencia truncada. Estas pruebas fijan los casos que rompían
 * la implementación anterior basada en `split(';')`.
 */

test('separa sentencias simples', () => {
  const result = splitStatements('CREATE TABLE a (id INT); CREATE TABLE b (id INT);');
  assert.equal(result.length, 2);
  assert.match(result[0], /CREATE TABLE a/);
  assert.match(result[1], /CREATE TABLE b/);
});

test('ignora el punto y coma final y las líneas vacías', () => {
  assert.deepEqual(splitStatements('\n\nSELECT 1;\n\n'), ['SELECT 1']);
});

test('no divide por un punto y coma dentro de una cadena', () => {
  const result = splitStatements("INSERT INTO t (v) VALUES ('a;b'); SELECT 2;");
  assert.equal(result.length, 2);
  assert.equal(result[0], "INSERT INTO t (v) VALUES ('a;b')");
  assert.equal(result[1], 'SELECT 2');
});

test('respeta una comilla escapada dentro de la cadena', () => {
  const result = splitStatements("INSERT INTO t (v) VALUES ('O''Brien; Jr'); SELECT 3;");
  assert.equal(result.length, 2);
  assert.match(result[0], /O''Brien; Jr/);
});

test('no divide por un punto y coma en un comentario de línea y lo elimina', () => {
  const result = splitStatements('-- nota: usa ; con cuidado\nSELECT 1;\nSELECT 2;');
  assert.deepEqual(result, ['SELECT 1', 'SELECT 2']);
});

test('no divide por un punto y coma en un comentario de bloque y lo elimina', () => {
  assert.deepEqual(splitStatements('/* a; b; c */ SELECT 1;'), ['SELECT 1']);
});

test('no divide por un punto y coma dentro de un identificador entre comillas invertidas', () => {
  const result = splitStatements('SELECT `col;rara` FROM t; SELECT 2;');
  assert.equal(result.length, 2);
  assert.match(result[0], /`col;rara`/);
});

test('un comentario de cabecera no impide ejecutar la sentencia siguiente', () => {
  const result = splitStatements('-- cabecera\n-- con varias líneas\nALTER TABLE t ADD KEY k (c);');
  assert.deepEqual(result, ['ALTER TABLE t ADD KEY k (c)']);
});

test('un comentario final no genera una sentencia vacía', () => {
  assert.deepEqual(splitStatements('SELECT 1;\n-- fin del archivo\n'), ['SELECT 1']);
});

test('un script con solo comentarios no produce sentencias', () => {
  assert.deepEqual(splitStatements('   \n-- solo un comentario\n/* y otro */\n'), []);
});

test('conserva los comentarios ejecutables de MySQL (/*! ... */)', () => {
  const result = splitStatements('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;');
  assert.equal(result.length, 2);
  assert.match(result[0], /^\/\*!40101 SET NAMES utf8mb4 \*\/$/);
});

test('conserva el texto completo de un ALTER de varias líneas', () => {
  const sql = 'ALTER TABLE expenses\n  ADD KEY idx_expenses_spent_at (spent_at);\nALTER TABLE installments\n  ADD KEY idx_installment_loan_status (loan_id, status);';
  const result = splitStatements(sql);
  assert.equal(result.length, 2);
  assert.match(result[0], /ADD KEY idx_expenses_spent_at/);
  assert.match(result[1], /ADD KEY idx_installment_loan_status/);
});
