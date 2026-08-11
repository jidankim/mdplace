export const manifestFields = new Set([
  '$schema',
  'schema_id',
  'package_series',
  'release_version',
  'lifecycle_state',
  'validator_version',
  'normative_vocabulary',
  'authority',
  'layout',
  'artifacts',
  'normative_digest',
  'conformance_digest',
  'amendment_policy',
  'conformance',
]);

export const transitionFields = new Set([
  'transition_id',
  'command_or_event',
  'from_state',
  'allowed',
  'actor_authority',
  'preconditions',
  'base_references',
  'emitted_records',
  'filesystem_effects',
  'idempotency',
  'terminal_state',
  'failure_result',
  'recovery',
]);

const authorityByCommand = new Map([
  ['submit', {roles: ['package_author'], quorum: 1, distinct_actors: false, delegation: 'permitted'}],
  ['approve', {roles: ['vault_owner', 'independent_technical_reviewer'], quorum: 2, distinct_actors: true, delegation: 'forbidden'}],
  ['release', {roles: ['release_coordinator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}],
  ['amend', {roles: ['package_author'], quorum: 1, distinct_actors: false, delegation: 'permitted'}],
  ['record_verdict', {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}],
  ['readback', {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}],
  ['mark_stale', {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}],
  ['supply_fresh_evidence', {roles: ['evidence_supplier'], quorum: 1, distinct_actors: false, delegation: 'permitted'}],
  ['append_operation', {roles: ['semantic_kernel'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}],
  ['recover_operation', {roles: ['semantic_kernel'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}],
]);

const conformanceExecutables = new Set([
  'conformance/digest-bindings.mjs',
  'conformance/evidence-claim-validation.mjs',
  'conformance/evidence-core.mjs',
  'conformance/evidence-envelope-validation.mjs',
  'conformance/evidence-extension.mjs',
  'conformance/evidence-freshness.mjs',
  'conformance/evidence-invocation-validation.mjs',
  'conformance/evidence-recovery-validation.mjs',
  'conformance/evidence-transition-validation.mjs',
  'conformance/amendment-evidence.mjs',
  'conformance/fixture-observer.mjs',
  'conformance/semantic-kernel-checks.mjs',
  'conformance/semantic-kernel-core.mjs',
  'conformance/semantic-kernel-observer.mjs',
  'conformance/json-schema.mjs',
  'conformance/package-checks.mjs',
  'conformance/pattern-evaluation.mjs',
  'conformance/requirement-checks.mjs',
  'conformance/safe-path.mjs',
  'conformance/schema-instances.mjs',
  'conformance/traceability-checks.mjs',
  'conformance/transition-observer.mjs',
  'conformance/transition-evidence.mjs',
  'conformance/validator-boundary-cases.mjs',
  'conformance/validator-contract-cases.mjs',
  'conformance/validator-evidence-cases.mjs',
  'conformance/validator-evidence-domain-invariants.mjs',
  'conformance/validator-evidence-envelope-integrity.mjs',
  'conformance/validator-evidence-extension-binding.mjs',
  'conformance/validator-evidence-fixture-support.mjs',
  'conformance/validator-evidence-fresh-replacement.mjs',
  'conformance/validator-evidence-fresh-report.mjs',
  'conformance/validator-evidence-mark-stale-churn.mjs',
  'conformance/validator-evidence-nested-subjects.mjs',
  'conformance/validator-evidence-readback-replay.mjs',
  'conformance/validator-evidence-recovery-resolution.mjs',
  'conformance/validator-evidence-stale-recovery.mjs',
  'conformance/validator-evidence-stale-semantics.mjs',
  'conformance/validator-evidence-support.mjs',
  'conformance/validator-evidence-table-validation.mjs',
  'conformance/validator-evidence-transitive-bindings.mjs',
  'conformance/validator-evidence-verdict-resolution.mjs',
  'conformance/validator-final-review-cases.mjs',
  'conformance/validator-review-round-two-cases.mjs',
  'conformance/validator-review-round-three-cases.mjs',
  'conformance/validator-fixture-cases.mjs',
  'conformance/validator-meta-schema-cases.mjs',
  'conformance/validator-package-cases.mjs',
  'conformance/validator-precondition-cases.mjs',
  'conformance/validator-rules.mjs',
  'conformance/validator-security-cases.mjs',
  'conformance/validator-test-support.mjs',
  'conformance/validator-evidence-checks.mjs',
  'conformance/validator-transition-cases.mjs',
  'conformance/validation-report.mjs',
  'conformance/validator.mjs',
  'conformance/validator.test.mjs',
  'conformance/validator-semantic-kernel-cases.mjs',
]);

export function authorityMatches(command, actual) {
  const expected = authorityByCommand.get(command);
  return expected !== undefined && actual !== null && typeof actual === 'object' &&
    Array.isArray(actual.roles) &&
    JSON.stringify(actual.roles) === JSON.stringify(expected.roles) &&
    actual.quorum === expected.quorum &&
    actual.distinct_actors === expected.distinct_actors &&
    actual.delegation === expected.delegation;
}

export function packageArtifactPathAllowed(path) {
  if (typeof path !== 'string') return false;
  if (/^(?:README|product|architecture|operations|security-and-privacy|performance)\.md$/.test(path)) return true;
  if (/^(?:package-manifest|traceability|claims-and-evidence)\.yaml$/.test(path)) return true;
  if (/^normative\/[a-z0-9][a-z0-9./-]*\.(?:md|json|yaml)$/.test(path)) return true;
  if (/^contracts\/[a-z0-9][a-z0-9./-]*\.json$/.test(path)) return true;
  if (path.endsWith('.mjs')) return conformanceExecutables.has(path);
  return /^conformance\/[A-Za-z0-9][A-Za-z0-9./-]*\.(?:md|json|yaml|txt)$/.test(path);
}
