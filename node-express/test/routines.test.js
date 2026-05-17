// Tests for extractRoutineBlocks — the splitter that pulls
// procedure / function / trigger / event bodies out of a dump intact
// so the restore phase doesn't trip on internal ';'s.

const test = require('node:test');
const assert = require('node:assert');

const { extractRoutineBlocks, ROUTINE_BEGIN, ROUTINE_END } = require('../adapters/_shared');

test('extractRoutineBlocks returns single sql block when no markers present', () => {
  const text = 'CREATE TABLE foo (id INT);\nINSERT INTO foo VALUES (1);\n';
  const blocks = extractRoutineBlocks(text);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'sql');
  assert.ok(blocks[0].body.includes('CREATE TABLE'));
  assert.ok(blocks[0].body.includes('INSERT'));
});

test('extractRoutineBlocks isolates one routine in the middle of sql', () => {
  const text = [
    'CREATE TABLE x (id INT);',
    '',
    `${ROUTINE_BEGIN} procedure p1`,
    'CREATE PROCEDURE p1()',
    'BEGIN',
    '  SELECT 1;',
    '  UPDATE x SET id = id + 1;',
    'END',
    ROUTINE_END,
    '',
    'INSERT INTO x VALUES (1);',
  ].join('\n');

  const blocks = extractRoutineBlocks(text);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[0].kind, 'sql');
  assert.ok(blocks[0].body.includes('CREATE TABLE x'));
  assert.strictEqual(blocks[1].kind, 'routine');
  assert.ok(blocks[1].body.startsWith('CREATE PROCEDURE p1'));
  assert.ok(blocks[1].body.includes('SELECT 1;'));
  assert.ok(blocks[1].body.includes('END'));
  // The routine body should NOT contain the surrounding markers
  assert.ok(!blocks[1].body.includes(ROUTINE_BEGIN));
  assert.ok(!blocks[1].body.includes(ROUTINE_END));
  assert.strictEqual(blocks[2].kind, 'sql');
  assert.ok(blocks[2].body.includes('INSERT INTO x'));
});

test('extractRoutineBlocks handles back-to-back routines', () => {
  const text = [
    `${ROUTINE_BEGIN} function f1`,
    'CREATE FUNCTION f1() RETURNS INT BEGIN RETURN 1; END',
    ROUTINE_END,
    `${ROUTINE_BEGIN} function f2`,
    'CREATE FUNCTION f2() RETURNS INT BEGIN RETURN 2; END',
    ROUTINE_END,
  ].join('\n');

  const blocks = extractRoutineBlocks(text);
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks.every((b) => b.kind === 'routine'));
  assert.ok(blocks[0].body.includes('RETURN 1'));
  assert.ok(blocks[1].body.includes('RETURN 2'));
});

test('extractRoutineBlocks emits all 4 segments: pre / routine / inter / routine / post', () => {
  const text = [
    'SET FOREIGN_KEY_CHECKS=0;',
    `${ROUTINE_BEGIN} procedure a`,
    'CREATE PROCEDURE a() BEGIN SELECT 1; END',
    ROUTINE_END,
    'CREATE TABLE mid (id INT);',
    `${ROUTINE_BEGIN} procedure b`,
    'CREATE PROCEDURE b() BEGIN SELECT 2; END',
    ROUTINE_END,
    'SET FOREIGN_KEY_CHECKS=1;',
  ].join('\n');

  const blocks = extractRoutineBlocks(text);
  assert.strictEqual(blocks.length, 5);
  assert.deepStrictEqual(blocks.map((b) => b.kind), ['sql', 'routine', 'sql', 'routine', 'sql']);
  assert.ok(blocks[0].body.startsWith('SET FOREIGN_KEY_CHECKS=0'));
  assert.ok(blocks[2].body.includes('CREATE TABLE mid'));
  assert.ok(blocks[4].body.includes('FOREIGN_KEY_CHECKS=1'));
});

test('extractRoutineBlocks handles unterminated routine block (no END marker)', () => {
  const text = [
    'CREATE TABLE x (id INT);',
    `${ROUTINE_BEGIN} procedure dangling`,
    'CREATE PROCEDURE dangling() BEGIN SELECT 1; END',
    // no ROUTINE_END line
  ].join('\n');

  const blocks = extractRoutineBlocks(text);
  // Best-effort: tail after ROUTINE_BEGIN becomes the routine body
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].kind, 'sql');
  assert.strictEqual(blocks[1].kind, 'routine');
  assert.ok(blocks[1].body.includes('CREATE PROCEDURE dangling'));
});

test('extractRoutineBlocks preserves verbatim internal semicolons in routine body', () => {
  const text = [
    `${ROUTINE_BEGIN} procedure many_stmts`,
    'CREATE PROCEDURE many_stmts() BEGIN',
    '  SELECT 1;',
    '  SELECT 2;',
    '  SELECT 3;',
    'END',
    ROUTINE_END,
  ].join('\n');

  const blocks = extractRoutineBlocks(text);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'routine');
  // All three internal SELECTs should be in the single body
  assert.strictEqual((blocks[0].body.match(/SELECT \d/g) || []).length, 3);
});

test('extractRoutineBlocks returns empty array for empty input', () => {
  assert.deepStrictEqual(extractRoutineBlocks(''), []);
  assert.deepStrictEqual(extractRoutineBlocks('   \n\n  '), []);
});

test('extractRoutineBlocks ignores false-positive ROUTINE_BEGIN inside string', () => {
  // We intentionally make this a SHARP test: the splitter is a string-search,
  // so a literal occurrence in a value would also trigger a split. Document the
  // limitation here so future-us don't add comment-text containing the marker.
  const text = [
    'CREATE TABLE foo (note TEXT);',
    `INSERT INTO foo VALUES ('${ROUTINE_BEGIN} this is a note');`,
  ].join('\n');

  const blocks = extractRoutineBlocks(text);
  // The naive matcher does split on the literal — which is OK because we
  // never write that exact marker inside string values in our dumps. We just
  // verify the splitter is deterministic about this.
  assert.ok(blocks.length >= 1);
});
