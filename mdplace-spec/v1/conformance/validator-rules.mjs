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
]);

const conformanceExecutables = new Set([
  'conformance/fixture-observer.mjs',
  'conformance/json-schema.mjs',
  'conformance/package-checks.mjs',
  'conformance/safe-path.mjs',
  'conformance/schema-instances.mjs',
  'conformance/traceability-checks.mjs',
  'conformance/transition-observer.mjs',
  'conformance/transition-evidence.mjs',
  'conformance/validator-boundary-cases.mjs',
  'conformance/validator-contract-cases.mjs',
  'conformance/validator-final-review-cases.mjs',
  'conformance/validator-fixture-cases.mjs',
  'conformance/validator-meta-schema-cases.mjs',
  'conformance/validator-package-cases.mjs',
  'conformance/validator-precondition-cases.mjs',
  'conformance/validator-rules.mjs',
  'conformance/validator-security-cases.mjs',
  'conformance/validator-test-support.mjs',
  'conformance/validator-transition-cases.mjs',
  'conformance/validator.mjs',
  'conformance/validator.test.mjs',
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
