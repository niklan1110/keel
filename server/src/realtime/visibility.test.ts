import assert from 'node:assert/strict';
import test from 'node:test';
import { pickKeys, policyCondition, rowCheckQuery, rowLiteral } from './visibility.js';

test('policies combine like Postgres: permissive OR, restrictive AND, no USING grants nothing', () => {
  assert.equal(policyCondition([]), null);
  assert.equal(policyCondition([{ permissive: false, qual: 'true' }]), null, 'restrictive alone shows nothing');
  assert.equal(policyCondition([{ permissive: true, qual: null }]), null, 'permissive without USING shows nothing');
  assert.equal(policyCondition([{ permissive: true, qual: 'a = 1' }]), '((a = 1))');
  assert.equal(
    policyCondition([
      { permissive: true, qual: 'a = 1' },
      { permissive: true, qual: 'b = 2' },
      { permissive: false, qual: 'c = 3' },
      { permissive: false, qual: null },
    ]),
    '((a = 1) or (b = 2)) and (c = 3)',
  );
});

test('row literals quote every value and keep column order', () => {
  assert.equal(rowLiteral(['a', 'b', 'c'], { c: '3', a: '1' }), '("1",,"3")');
  assert.equal(rowLiteral(['a', 'b'], { a: null, b: '' }), '(,"")');
  assert.equal(rowLiteral(['a'], { a: 'say "hi" \\ bye,(x)' }), '("say \\"hi\\" \\\\ bye,(x)")');
  // Inherited properties are not values.
  assert.equal(rowLiteral(['constructor', 'toString'], {}), '(,)');
  assert.equal(rowLiteral([], {}), '()');
});

test('the visibility check runs the policies over a copy of the WAL row', () => {
  const q = rowCheckQuery({
    schema: 'public',
    table: 'todos',
    columns: ['id', 'title', 'user_id'],
    pk: ['id'],
    row: { id: '1', title: 'x', user_id: 'u1' },
    fillFromCurrent: true,
    condition: '((user_id = auth.uid()))',
  })!;
  assert.equal(q.text, `select 1 from json_populate_record($1::"public"."todos", '{}'::json) as "todos" where ((user_id = auth.uid())) limit 1`);
  assert.deepEqual(q.values, ['("1","x","u1")']);
  assert.ok(!/from "public"."todos"/.test(q.text), 'the table itself is not read');
});

test('columns missing from the WAL row come from the current row, which must exist', () => {
  const base = { schema: 's', table: 't"x', columns: ['id', 'big', 'owner'], pk: ['id'], condition: '(owner = 1)' };
  const q = rowCheckQuery({ ...base, row: { id: '7', owner: '1' }, fillFromCurrent: true })!;
  assert.match(q.text, /from "s"\."t""x" as "_keel_current", json_populate_record\(\$1::"s"\."t""x", '\{\}'::json\) as "_keel_wal" where "_keel_current"\."id" = \$2/);
  assert.match(q.text, /row\("_keel_wal"\."id", "_keel_current"\."big", "_keel_wal"\."owner"\)::"s"\."t""x"/);
  assert.match(q.text, /as "t""x" where \(owner = 1\)\) limit 1$/);
  assert.deepEqual(q.values, ['("7",,"1")', '7']);
  // No primary key (or no key value): can't fill in, so not visible.
  assert.equal(rowCheckQuery({ ...base, pk: [], row: { id: '7', owner: '1' }, fillFromCurrent: true }), null);
  assert.equal(rowCheckQuery({ ...base, row: { big: 'b', owner: '1' }, fillFromCurrent: true }), null);
  assert.equal(rowCheckQuery({ ...base, row: { id: null, owner: '1' }, fillFromCurrent: true }), null);
  // Deletes evaluate the old row as it is: unknown columns are NULL.
  const d = rowCheckQuery({ ...base, row: { id: '7' }, fillFromCurrent: false })!;
  assert.ok(!d.text.includes('_keel_current'));
  assert.deepEqual(d.values, ['("7",,)']);
});

test('old records on RLS tables are cut down to the primary key', () => {
  assert.deepEqual(pickKeys({ id: 1, org: 2, secret: 's' }, ['id', 'org']), { id: 1, org: 2 });
  assert.deepEqual(pickKeys({}, ['id']), {});
  assert.deepEqual(pickKeys({ secret: 's' }, []), {});
});
