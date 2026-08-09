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

export function authorityMatches(command, actual) {
  const expected = authorityByCommand.get(command);
  return expected !== undefined &&
    JSON.stringify(actual.roles) === JSON.stringify(expected.roles) &&
    actual.quorum === expected.quorum &&
    actual.distinct_actors === expected.distinct_actors &&
    actual.delegation === expected.delegation;
}
