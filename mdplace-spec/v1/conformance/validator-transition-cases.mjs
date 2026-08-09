import assert from 'node:assert/strict';
import test from 'node:test';

import {completeTransition, validatePackage} from './validator-test-support.mjs';

const satisfiedPreconditions = {
  declared_conditions_met: true,
};
const normativeDigestReference = 'package-manifest.yaml#/normative_digest';
const baseReferences = {
  package_series: 'mdplace-spec/v1',
  release_version: '1.0.0',
  normative_digest_ref: normativeDigestReference,
};
const releaseSlots = ['README.md', 'product.md', 'architecture.md', 'contracts/', 'operations.md', 'security-and-privacy.md', 'performance.md', 'conformance/manifest.yaml', 'conformance/fixtures/', 'conformance/scenarios/', 'conformance/benchmarks/', 'conformance/manual-acceptance.md', 'traceability.yaml', 'claims-and-evidence.yaml', 'package-manifest.yaml'];
const releaseSlotsDigest = '6ecd59530fa555d73c05619d50eb0cc5b3ae31b0c633ba731e93c2727414c228';
const actor = (id, roles) => ({principal_id: `person:${id}`, identity_assurance: 'canonical_authenticated_human', roles, delegated: false});
const releaseSlotObservation = {
  receipt_id: 'slot-observation:release-001',
  observer_id: 'mdplace.package-validator/v1',
  identity_assurance: 'trusted_local_validator',
  verification_method: 'filesystem_lstat',
  observation_root: '.',
  package_series: 'mdplace-spec/v1',
  release_version: '1.0.0',
  normative_digest_ref: normativeDigestReference,
  required_release_slots_digest: releaseSlotsDigest,
  observed_slots: releaseSlots.map((path) => ({path, presence: 'present'})),
};
const releaseEvidence = {
  required_release_slots_observation: releaseSlotObservation,
  verified_artifact_digest_ref: normativeDigestReference,
  approval_receipts: [
    {receipt_id: 'approval:semantic-001', approval_kind: 'semantic', principal_id: 'person:owner-001', identity_assurance: 'canonical_authenticated_human', role: 'vault_owner', normative_digest_ref: normativeDigestReference, delegated: false},
    {receipt_id: 'approval:technical-001', approval_kind: 'technical', principal_id: 'person:reviewer-001', identity_assurance: 'canonical_authenticated_human', role: 'independent_technical_reviewer', normative_digest_ref: normativeDigestReference, delegated: false},
  ],
  immutable_target: {path: 'releases/1.0.0', status: 'reserved_empty'},
};

test('CLI rejects a non-current digest reference without side effects', async () => {
  // Given an otherwise authorized transition bound to an arbitrary digest reference.
  const fixture = {
    fixture_id: 'FIX-PKG-STATE-001',
    subject: {
      kind: 'transition',
      table: 'contracts/transitions/package-lifecycle.json',
      from_state: 'draft',
      command: 'submit',
      actors: [actor('author-001', ['package_author'])],
      base_references: {...baseReferences, normative_digest_ref: `literal:${'c'.repeat(64)}`},
      preconditions: satisfiedPreconditions,
      release_evidence: null,
      idempotency_key: 'fixture-stale-001',
      idempotency_status: 'new',
    },
    expected: {
      verdict: 'fail',
      codes: ['transition.stale_base'],
      outputs: ['transition rejected'],
      operations: ['validate base references'],
      receipts: ['PackageTransitionDenied'],
      filesystem_effects: ['none'],
      terminal_state: 'draft',
      illegal_transition: false,
    },
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'scenarios/stale.json', expected_verdict: 'fail'}]};
  const table = {states: ['draft'], commands: ['submit'], transitions: [completeTransition()]};

  // When the public validator CLI evaluates the transition attempt.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'contracts/transitions/package-lifecycle.json': table,
    'conformance/manifest.yaml': conformance,
    'conformance/scenarios/stale.json': fixture,
  });

  // Then the fixture oracle passes because the stale attempt is denied cleanly.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-STATE-001', verdict: 'pass', codes: []}]);
});

test('CLI denies an approval without both distinct authorities', async () => {
  // Given an approval transition attempted by only the vault owner.
  const fixture = {
    fixture_id: 'FIX-PKG-AUTH-001',
    subject: {
      kind: 'transition',
      table: 'contracts/transitions/package-lifecycle.json',
      from_state: 'candidate',
      command: 'approve',
      actors: [actor('owner-reviewer-001', ['vault_owner', 'independent_technical_reviewer'])],
      base_references: baseReferences,
      preconditions: satisfiedPreconditions,
      release_evidence: null,
      idempotency_key: 'fixture-authority-001',
      idempotency_status: 'new',
    },
    expected: {
      verdict: 'fail',
      codes: ['transition.authority_denied'],
      outputs: ['transition rejected'],
      operations: ['validate actor authority'],
      receipts: ['PackageTransitionDenied'],
      filesystem_effects: ['none'],
      terminal_state: 'candidate',
      illegal_transition: false,
    },
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'scenarios/authority.json', expected_verdict: 'fail'}]};
  const table = {
    states: ['candidate'],
    commands: ['approve'],
    transitions: [completeTransition({
      command_or_event: 'approve',
      from_state: 'candidate',
      actor_authority: {roles: ['vault_owner', 'independent_technical_reviewer'], quorum: 2, distinct_actors: true, delegation: 'forbidden'},
      terminal_state: 'release_ready',
    })],
  };

  // When the public validator CLI evaluates the transition attempt.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'contracts/transitions/package-lifecycle.json': table,
    'conformance/manifest.yaml': conformance,
    'conformance/scenarios/authority.json': fixture,
  });

  // Then the fixture proves denial, no filesystem effect, and unchanged state.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-AUTH-001', verdict: 'pass', codes: []}]);
});

test('CLI emits the declared observable result for an allowed transition', async () => {
  // Given an authorized submit against the current package references.
  const fixture = {
    fixture_id: 'FIX-PKG-POS-002',
    subject: {kind: 'transition', table: 'contracts/transitions/package-lifecycle.json', from_state: 'draft', command: 'submit', actors: [actor('author-001', ['package_author'])], base_references: baseReferences, preconditions: satisfiedPreconditions, release_evidence: null, idempotency_key: 'fixture-submit-001', idempotency_status: 'new'},
    expected: {verdict: 'pass', codes: [], outputs: ['transition accepted'], operations: ['submit'], receipts: ['PackageCandidateSubmitted'], filesystem_effects: ['none'], terminal_state: 'candidate', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/submit.json', expected_verdict: 'pass'}]};
  const table = {states: ['draft'], commands: ['submit'], transitions: [completeTransition()]};

  // When the public validator CLI evaluates the transition attempt.
  const result = await validatePackage({
    'package-manifest.yaml': {schema_id: 'mdplace.package-manifest/v1'},
    'contracts/transitions/package-lifecycle.json': table,
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/submit.json': fixture,
  });

  // Then the emitted receipt, effects, and terminal state match the normative row.
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: 'FIX-PKG-POS-002', verdict: 'pass', codes: []}]);
});

test('CLI rejects release when an observable release precondition is unmet', async () => {
  // Given an authorized release attempt whose required release slots are incomplete.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-009',
    subject: {
      kind: 'transition',
      table: 'contracts/transitions/package-lifecycle.json',
      from_state: 'release_ready',
      command: 'release',
      actors: [actor('coordinator-001', ['release_coordinator'])],
      base_references: baseReferences,
      preconditions: satisfiedPreconditions,
      release_evidence: {
        ...releaseEvidence,
        required_release_slots_observation: {
          ...releaseSlotObservation,
          observed_slots: releaseSlots.map((path) => ({path, presence: 'present'})),
        },
      },
      idempotency_key: 'fixture-release-missing-slot-001',
      idempotency_status: 'new',
    },
    expected: {verdict: 'fail', codes: ['transition.precondition_failed'], outputs: ['transition rejected'], operations: ['validate transition preconditions'], receipts: ['PackageTransitionDenied'], filesystem_effects: ['remove unverified staged target and preserve candidate'], terminal_state: 'release_ready', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'scenarios/missing-slot.json', expected_verdict: 'fail'}]};
  const table = {states: ['release_ready'], commands: ['release'], transitions: [completeTransition({
    command_or_event: 'release',
    from_state: 'release_ready',
    actor_authority: {roles: ['release_coordinator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    emitted_records: ['SpecificationPackageReleased'],
    filesystem_effects: ['publish immutable release tag'],
    terminal_state: 'released',
    failure_result: {code: 'transition.precondition_failed', state_effect: 'unchanged', emitted_records: ['PackageTransitionDenied'], filesystem_effects: ['remove unverified staged target and preserve candidate']},
  })]};

  // When the public validator evaluates the transition attempt.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'contracts/transitions/package-lifecycle.json': table,
    'conformance/manifest.yaml': conformance,
    'conformance/scenarios/missing-slot.json': fixture,
  });

  // Then no release effect occurs and the release-ready state is preserved.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: fixture.fixture_id, verdict: 'pass', codes: []}]);
});

test('CLI rejects release without digest-bound approval and target evidence', async () => {
  // Given a coordinator who asserts every boolean but supplies no release evidence.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-012',
    subject: {
      kind: 'transition', table: 'contracts/transitions/package-lifecycle.json',
      from_state: 'release_ready', command: 'release',
      actors: [actor('coordinator-001', ['release_coordinator'])],
      base_references: baseReferences, preconditions: satisfiedPreconditions, release_evidence: null,
      idempotency_key: 'fixture-unproven-release-001', idempotency_status: 'new',
    },
    expected: {verdict: 'fail', codes: ['transition.precondition_failed'], outputs: ['transition rejected'], operations: ['validate transition preconditions'], receipts: ['PackageTransitionDenied'], filesystem_effects: ['remove unverified staged target and preserve candidate'], terminal_state: 'release_ready', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'scenarios/unproven-release.json', expected_verdict: 'fail'}]};
  const table = {states: ['release_ready'], commands: ['release'], transitions: [completeTransition({
    command_or_event: 'release', from_state: 'release_ready',
    actor_authority: {roles: ['release_coordinator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    terminal_state: 'released',
    failure_result: {code: 'transition.precondition_failed', state_effect: 'unchanged', emitted_records: ['PackageTransitionDenied'], filesystem_effects: ['remove unverified staged target and preserve candidate']},
  })]};

  // When the public validator evaluates the unproven release.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'contracts/transitions/package-lifecycle.json': table,
    'conformance/manifest.yaml': conformance,
    'conformance/scenarios/unproven-release.json': fixture,
  });

  // Then assertions alone cannot stand in for receipts or digest bindings.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: fixture.fixture_id, verdict: 'pass', codes: []}]);
});

test('CLI rejects an idempotency-key conflict before transition effects', async () => {
  // Given an otherwise valid submit that reuses a key for a different command input.
  const fixture = {
    fixture_id: 'FIX-PKG-NEG-010',
    subject: {kind: 'transition', table: 'contracts/transitions/package-lifecycle.json', from_state: 'draft', command: 'submit', actors: [actor('author-001', ['package_author'])], base_references: baseReferences, preconditions: satisfiedPreconditions, release_evidence: null, idempotency_key: 'fixture-conflict-001', idempotency_status: 'conflict'},
    expected: {verdict: 'fail', codes: ['transition.idempotency_conflict'], outputs: ['transition rejected'], operations: ['validate idempotency key'], receipts: ['PackageTransitionDenied'], filesystem_effects: ['none'], terminal_state: 'draft', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'scenarios/idempotency-conflict.json', expected_verdict: 'fail'}]};
  const table = {states: ['draft'], commands: ['submit'], transitions: [completeTransition()]};

  // When the public validator evaluates the conflicting retry.
  const result = await validatePackage({
    'package-manifest.yaml': {},
    'contracts/transitions/package-lifecycle.json': table,
    'conformance/manifest.yaml': conformance,
    'conformance/scenarios/idempotency-conflict.json': fixture,
  });

  // Then the transition is denied before emitting the submit receipt or effects.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: fixture.fixture_id, verdict: 'pass', codes: []}]);
});
