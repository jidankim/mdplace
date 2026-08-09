import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {completeTransition, validatePackage} from './validator-test-support.mjs';

test('CLI rejects an unknown package-manifest field', async () => {
  // Given a boundary document with an undeclared property.
  const manifest = {
    schema_id: 'mdplace.package-manifest/v1',
    unexpected: true,
  };

  // When the public validator CLI checks the package.
  const result = await validatePackage({'package-manifest.yaml': manifest});

  // Then the package is rejected with the stable closed-schema code.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.ok(report.checks.some(({codes}) => codes.includes('schema.unknown_field')));
});

test('CLI rejects duplicate stable requirement identifiers', async () => {
  // Given two normative requirements that reuse one stable identifier.
  const requirements = {
    schema_id: 'mdplace.requirements/v1',
    requirements: [{id: 'REQ-PKG-001'}, {id: 'REQ-PKG-001'}],
  };

  // When the public validator CLI checks the requirement index.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'normative/requirements.json': requirements,
  });

  // Then reuse is rejected independently of the requirement prose.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('requirements.duplicate_id')));
});

test('CLI rejects an incomplete transition row', async () => {
  // Given a lifecycle row that omits its required recovery contract.
  const table = {
    schema_id: 'mdplace.transition-table/v1',
    states: ['draft'],
    commands: ['submit'],
    transitions: [{
      transition_id: 'TR-PKG-001',
      command_or_event: 'submit',
      from_state: 'draft',
      allowed: true,
      actor_authority: {},
      preconditions: [],
      base_references: [],
      emitted_records: [],
      filesystem_effects: [],
      idempotency: {},
      terminal_state: 'candidate',
      failure_result: {},
    }],
  };

  // When the public validator CLI checks the transition table.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'contracts/transitions/package-lifecycle.json': table,
  });

  // Then the incomplete row is rejected before lifecycle evaluation.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('schema.required_field')));
});

test('CLI rejects ambiguous actor authority', async () => {
  // Given an approval row that permits either approver instead of both distinct authorities.
  const table = {
    schema_id: 'mdplace.transition-table/v1',
    states: ['candidate'],
    commands: ['approve'],
    transitions: [completeTransition({
      command_or_event: 'approve',
      from_state: 'candidate',
      actor_authority: {roles: ['vault_owner_or_reviewer'], quorum: 1, distinct_actors: false, delegation: 'permitted'},
      terminal_state: 'release_ready',
    })],
  };

  // When the public validator CLI checks the transition table.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'contracts/transitions/package-lifecycle.json': table,
  });

  // Then authority cannot be inferred or expressed as an alternative.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('transition.ambiguous_authority')));
});

test('CLI rejects a manifest artifact whose bytes do not match its binding', async () => {
  // Given an existing normative artifact bound to the wrong SHA-256 digest.
  const result = await validatePackage({
    'package-manifest.yaml': {
      artifacts: [{
        path: 'normative/package-contract.md',
        authority: 'normative',
        media_type: 'text/markdown',
        sha256: 'a'.repeat(64),
      }],
    },
  });

  // When the public validator hashes the declared artifact, the package is rejected.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('artifact.hash_mismatch')));
});

test('CLI rejects a normative digest that does not bind the normative artifact ledger', async () => {
  // Given valid artifact hashes but an unrelated aggregate normative digest.
  const result = await validatePackage({
    'package-manifest.yaml': {normative_digest: 'a'.repeat(64)},
  });

  // When the public validator recomputes the documented ledger digest, it rejects the package.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('package.normative_digest_mismatch')));
});

test('CLI rejects an incomplete package traceability map', async () => {
  // Given two normative requirements but a direct package traceability map for only one.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'normative/requirements.json': {requirements: [{id: 'REQ-PKG-001'}, {id: 'REQ-PKG-002'}]},
    'traceability.yaml': {records: [{requirement_id: 'REQ-PKG-001'}]},
  });

  // When the public validator resolves package-level bindings, it rejects the untraced ID.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('traceability.untraced_requirement')));
});

test('CLI rejects a contract schema that leaves an object open', async () => {
  // Given a Draft 2020-12 schema whose nested object permits undeclared fields.
  const openSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:mdplace:schema:open-fixture:v1',
    type: 'object',
    additionalProperties: false,
    properties: {nested: {type: 'object'}},
  };

  // When the public validator inspects the schema contract itself.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'contracts/schemas/open-fixture.schema.json': openSchema,
  });

  // Then the open object violates the package-wide closed-schema convention.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('schema.object_open')));
});

test('CLI applies the requirements schema to the package boundary', async () => {
  // Given a requirements document whose artifact hash is valid but whose root has an unknown field.
  const requirements = {
    $schema: '../contracts/schemas/requirements.schema.json',
    schema_id: 'mdplace.requirements/v1',
    package_series: 'mdplace-spec/v1',
    requirements: [],
    unexpected: true,
  };

  // When the public validator applies the named Draft 2020-12 contract.
  const requirementsSchema = JSON.parse(await readFile(
    new URL('../contracts/schemas/requirements.schema.json', import.meta.url),
    'utf8',
  ));
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'contracts/schemas/requirements.schema.json': requirementsSchema,
    'normative/requirements.json': requirements,
  });

  // Then recomputed artifact bindings cannot bypass the closed object schema.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('schema.unknown_field')));
});

test('CLI rejects an instance that does not name its bound schema', async () => {
  // Given a structurally valid requirement index that declares an unrelated schema path.
  const requirementsSchema = JSON.parse(await readFile(
    new URL('../contracts/schemas/requirements.schema.json', import.meta.url),
    'utf8',
  ));
  const requirements = {
    $schema: 'does-not-exist.json',
    schema_id: 'mdplace.requirements/v1',
    package_series: 'mdplace-spec/v1',
    requirements: [{
      id: 'REQ-PKG-001',
      title: 'Fixture requirement',
      normative_anchor: 'normative/package-contract.md#req-pkg-001-fixture',
      decision_urls: ['https://github.com/jidankim/mdplace/issues/10#issuecomment-5186946153'],
      canonical_terms: ['Specification Package'],
      acceptance_gate: 'The fixture remains bound to its named schema.',
      scope: 'foundation',
    }],
  };

  // When the package applies the fixed requirements contract.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'contracts/schemas/requirements.schema.json': requirementsSchema,
    'normative/requirements.json': requirements,
  });

  // Then a noncanonical schema declaration cannot masquerade as the named instance.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('schema.constraint')));
});

test('CLI rejects a released package whose required release slots are absent', async () => {
  // Given a manifest that claims release while only the candidate foundation exists.
  const result = await validatePackage({
    'package-manifest.yaml': {lifecycle_state: 'released'},
  });

  // When the public validator checks release state against filesystem-visible slots.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('package.required_release_slot_missing')));
});
