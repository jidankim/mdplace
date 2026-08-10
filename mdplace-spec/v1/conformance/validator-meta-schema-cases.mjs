import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {validateJsonSchema} from './json-schema.mjs';

async function validate(schemaName, document) {
  const schema = JSON.parse(await readFile(new URL(`../contracts/schemas/${schemaName}`, import.meta.url), 'utf8'));
  return validateJsonSchema(schema, document);
}

test('traceability schema accepts a downstream requirement namespace and scope', async () => {
  // Given a Semantic Kernel traceability record using the shared contract.
  const document = {
    $schema: 'contracts/schemas/traceability.schema.json', schema_id: 'mdplace.traceability/v1',
    package_series: 'mdplace-spec/v1', release_version: '1.0.0',
    decisions: [{decision_id: 'DEC-002', url: 'https://github.com/jidankim/mdplace/issues/2#issuecomment-123', status: 'accepted', use: 'input_without_reopening'}],
    records: [{
      requirement_id: 'REQ-SK-001', decision_ids: ['DEC-002'], canonical_terms: ['Semantic Kernel'],
      normative_anchors: ['normative/semantic-kernel.md#req-sk-001'],
      schema_or_transition_refs: ['contracts/schemas/semantic-operation.schema.json'],
      positive_fixture_ids: ['FIX-SK-POS-001'], negative_fixture_ids: ['FIX-SK-NEG-001'],
      acceptance_gate: 'serialized append', scope: 'semantic-kernel', evidence_refs: ['conformance/evidence/sk-report.json'],
    }],
  };

  // When the shared traceability meta-schema validates it.
  const errors = await validate('traceability.schema.json', document);

  // Then package-foundation identifiers are not required.
  assert.deepEqual(errors, []);
});

test('conformance schemas accept downstream suite fixture and schema identifiers', async () => {
  // Given a downstream conformance suite and artifact fixture.
  const manifest = {
    $schema: '../contracts/schemas/conformance-manifest.schema.json',
    schema_id: 'mdplace.conformance-manifest/v1', suite_id: 'mdplace.semantic-kernel-conformance/v1',
    package_series: 'mdplace-spec/v1', release_version: '1.0.0', validator_version: '1.0.0',
    required_categories: ['positive'],
    fixtures: [{
      fixture_id: 'FIX-SK-POS-001', path: 'fixtures/semantic-kernel/append.json', category: 'positive',
      requirement_ids: ['REQ-SK-001'], expected_verdict: 'pass',
      observable_assertions: {inputs: true, outputs: true, operations: true, receipts: true, filesystem_effects: true, terminal_state: true, illegal_transition: false},
    }],
  };
  const fixture = {
    $schema: '../../../contracts/schemas/conformance-fixture.schema.json',
    schema_id: 'mdplace.conformance-fixture/v1', fixture_id: 'FIX-SK-POS-001', category: 'positive',
    requirement_ids: ['REQ-SK-001'],
    subject: {
      kind: 'extension', extension_id: 'mdplace.validator-extension/semantic-operation/v1',
      schema: 'contracts/schemas/semantic-operation.schema.json',
      document: {command: 'append', from_state: 'ready', actor_role: 'semantic_writer'},
    },
    expected: {verdict: 'pass', codes: [], outputs: [], operations: [], receipts: [], filesystem_effects: [], terminal_state: 'accepted', illegal_transition: false},
  };

  // When both shared conformance meta-schemas validate the downstream artifacts.
  const [manifestErrors, fixtureErrors] = await Promise.all([
    validate('conformance-manifest.schema.json', manifest),
    validate('conformance-fixture.schema.json', fixture),
  ]);

  // Then their extension identifiers remain representable.
  assert.deepEqual(manifestErrors, []);
  assert.deepEqual(fixtureErrors, []);
});

test('transition-table schema accepts downstream transition and authority vocabularies', async () => {
  // Given a Semantic Kernel lifecycle table using its own role and transition namespace.
  const document = {
    $schema: '../schemas/transition-table.schema.json', schema_id: 'mdplace.transition-table/v1',
    table_id: 'TRANS-SEMANTIC-KERNEL', lifecycle: 'Semantic Kernel append', version: '1.0.0',
    states: ['ready', 'accepted'], commands: ['append'], transitions: [{
      transition_id: 'TR-SK-001', command_or_event: 'append', from_state: 'ready', allowed: true,
      actor_authority: {roles: ['semantic_writer'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
      preconditions: ['base is current'], base_references: ['semantic_revision'],
      emitted_records: ['SemanticOperationAppended'], filesystem_effects: ['none'],
      idempotency: {key_fields: ['command_id'], retry_result: 'return original receipt'},
      terminal_state: 'accepted', failure_result: {code: 'semantic.stale', state_effect: 'unchanged', emitted_records: ['SemanticOperationDenied'], filesystem_effects: ['none']},
      recovery: 'Refresh the base and retry.',
    }],
  };

  // When the shared transition-table meta-schema validates it.
  const errors = await validate('transition-table.schema.json', document);

  // Then package-release roles and IDs are not imposed on downstream lifecycles.
  assert.deepEqual(errors, []);
});
