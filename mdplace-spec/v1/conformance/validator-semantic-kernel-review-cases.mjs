import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeFixture} from './fixture-observer.mjs';
import {validateAgainstSchemaPath, validateJsonSchema} from './json-schema.mjs';
import {commandDigestFromAction} from './semantic-kernel-core.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function semanticFixture(path) {
  return JSON.parse(await readFile(
    new URL(`./scenarios/semantic-kernel/${path}`, import.meta.url),
    'utf8',
  ));
}

test('JSON Schema maximum length and collection boundaries are enforced', () => {
  assert.deepEqual(validateJsonSchema({type: 'string', maxLength: 2}, '😀😀'), []);
  assert.deepEqual(validateJsonSchema({type: 'string', maxLength: 2}, 'abc'), [
    {path: '$', keyword: 'maxLength'},
  ]);
  assert.deepEqual(validateJsonSchema({type: 'array', maxItems: 2}, [1, 2, 3]), [
    {path: '$', keyword: 'maxItems'},
  ]);
});

test('Semantic Kernel scenario bounds reject an oversized batch, state, and record', async () => {
  const fixture = await semanticFixture('snapshot-suffix-equivalence.json');
  fixture.subject.document.action.records = Array(65).fill('{}\n');
  fixture.subject.document.action.snapshot.semantic_state = Array.from({length: 129}, (_, index) => ({
    key: `note:${String(index).padStart(3, '0')}/placement`,
    value: 'cat:research',
  }));
  fixture.subject.document.action.records[0] = 'x'.repeat(32_769);

  const errors = await validateAgainstSchemaPath(
    packageRoot,
    fixture.subject.schema,
    fixture.subject.document,
  );

  assert.ok(errors.some(({path, keyword}) => path === '$/action/records' && keyword === 'maxItems'));
  assert.ok(errors.some(({path, keyword}) => path === '$/action/records/0' && keyword === 'maxLength'));
  assert.ok(errors.some(({path, keyword}) => path === '$/action/snapshot/semantic_state' && keyword === 'maxItems'));
});

test('duplicate prior receipt identities are rejected independently of array order', async () => {
  const fixture = await semanticFixture('duplicate-compatible-idempotent.json');
  const duplicate = {
    ...fixture.subject.document.initial.prior_receipts[0],
    command_digest: 'a'.repeat(64),
    operation_id: 'operation:other-001',
    receipt_id: 'receipt:other-001',
  };
  fixture.subject.document.initial.prior_receipts.push(duplicate);
  const reversed = structuredClone(fixture);
  reversed.subject.document.initial.prior_receipts.reverse();

  const [forward, backward] = await Promise.all([
    observeFixture(fixture, packageRoot),
    observeFixture(reversed, packageRoot),
  ]);

  assert.deepEqual(forward.codes, ['semantic.identity_history_invalid']);
  assert.deepEqual(backward.codes, forward.codes);
});

test('append rejects reuse of an immutable operation identity', async () => {
  const fixture = await semanticFixture('valid-serialized-second-append.json');
  fixture.subject.document.action.operation_id = fixture.subject.document.initial.head.operation_id;
  fixture.subject.document.action.command_digest = commandDigestFromAction(fixture.subject.document.action);
  const earlierFixture = structuredClone(fixture);
  earlierFixture.subject.document.initial.head = {sequence: 2, operation_id: 'operation:002'};
  earlierFixture.subject.document.initial.operation_ids = ['operation:001', 'operation:002'];
  earlierFixture.subject.document.action.base_references[0].sequence = 2;
  earlierFixture.subject.document.action.base_references[0].operation_id = 'operation:002';
  earlierFixture.subject.document.action.ordering = {
    sequence: 3,
    predecessor_operation_id: 'operation:002',
    sort_key: '000003:command:002',
  };
  earlierFixture.subject.document.action.command_digest = commandDigestFromAction(
    earlierFixture.subject.document.action,
  );

  const [observed, earlierObserved] = await Promise.all([
    observeFixture(fixture, packageRoot),
    observeFixture(earlierFixture, packageRoot),
  ]);

  for (const result of [observed, earlierObserved]) {
    assert.deepEqual(result.codes, ['semantic.operation_duplicate']);
    assert.ok(result.outputs.includes('canonical_record:none'));
  }
});

test('append rejects an incomplete operation identity history', async () => {
  const fixture = await semanticFixture('valid-serialized-second-append.json');
  fixture.subject.document.initial.operation_ids = [];

  const observed = await observeFixture(fixture, packageRoot);

  assert.deepEqual(observed.codes, ['semantic.identity_history_invalid']);
});
