import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const normativeDigestReference = 'package-manifest.yaml#/normative_digest';

function rolesHaveDistinctActors(roles, actors, index = 0, usedActorIds = new Set()) {
  if (index === roles.length) return true;
  return actors.some((actor) =>
    actor.roles.includes(roles[index]) &&
    !usedActorIds.has(actor.principal_id) &&
    rolesHaveDistinctActors(roles, actors, index + 1, new Set([...usedActorIds, actor.principal_id])));
}

function equalSets(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

async function entryExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function releaseEvidenceMatches(subject, packageRoot) {
  const evidence = subject.release_evidence;
  if (evidence === null || evidence === undefined) return false;
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package-manifest.yaml'), 'utf8'));
  const requiredSlots = manifest.layout?.required_release_slots ?? [];
  const observation = evidence.required_release_slots_observation ?? {};
  const observedSlots = observation.observed_slots ?? [];
  const observedPaths = observedSlots.map(({path}) => path);
  const approvals = evidence.approval_receipts ?? [];
  const semantic = approvals.find(({approval_kind: kind}) => kind === 'semantic');
  const technical = approvals.find(({approval_kind: kind}) => kind === 'technical');
  const slotDigest = createHash('sha256').update(
    [...requiredSlots].sort().map((path) => `${path}\n`).join(''),
  ).digest('hex');
  const observationRootIsSafe = observation.observation_root === '.' ||
    /^conformance\/release-targets\/[a-z][a-z0-9-]{2,63}$/.test(observation.observation_root ?? '');
  const observationRoot = observationRootIsSafe
    ? resolve(packageRoot, observation.observation_root)
    : packageRoot;
  const observedPresenceMatches = observationRootIsSafe && (await Promise.all(
    observedSlots.map(async ({path, presence}) =>
      await entryExists(resolve(observationRoot, path)) === (presence === 'present')),
  )).every(Boolean);
  const approvalsMatch = approvals.length === 2 && semantic !== undefined && technical !== undefined &&
    semantic.role === 'vault_owner' && technical.role === 'independent_technical_reviewer' &&
    semantic.principal_id !== technical.principal_id &&
    approvals.every((approval) => approval.identity_assurance === 'canonical_authenticated_human' &&
      approval.delegated === false && approval.normative_digest_ref === normativeDigestReference);
  const slotObservationMatches = observation.observer_id === 'mdplace.package-validator/v1' &&
    observation.identity_assurance === 'trusted_local_validator' &&
    observation.verification_method === 'filesystem_lstat' &&
    observation.package_series === manifest.package_series &&
    observation.release_version === manifest.release_version &&
    observation.normative_digest_ref === normativeDigestReference &&
    observation.required_release_slots_digest === slotDigest &&
    new Set(observedPaths).size === observedPaths.length &&
    equalSets(observedPaths, requiredSlots) &&
    observedSlots.every(({presence}) => presence === 'present') && observedPresenceMatches;
  return slotObservationMatches &&
    evidence.verified_artifact_digest_ref === normativeDigestReference && approvalsMatch &&
    evidence.immutable_target?.path === `releases/${manifest.release_version}` &&
    evidence.immutable_target?.status === 'reserved_empty';
}

async function baseReferencesMatch(subject, packageRoot) {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package-manifest.yaml'), 'utf8'));
  return subject.base_references.package_series === manifest.package_series &&
    subject.base_references.release_version === manifest.release_version &&
    subject.base_references.normative_digest_ref === normativeDigestReference &&
    /^[a-f0-9]{64}$/.test(manifest.normative_digest);
}

function denied(subject, code, operations, filesystemEffects = ['none'], receipts = ['PackageTransitionDenied']) {
  return {
    verdict: 'fail',
    codes: [code],
    outputs: ['transition rejected'],
    operations,
    receipts,
    filesystem_effects: filesystemEffects,
    terminal_state: subject.from_state,
    illegal_transition: false,
  };
}

export async function observeTransition(fixture, packageRoot) {
  const {subject} = fixture;
  const table = JSON.parse(await readFile(resolve(packageRoot, subject.table), 'utf8'));
  const row = table.transitions.find((candidate) =>
    candidate.from_state === subject.from_state && candidate.command_or_event === subject.command);
  if (!await baseReferencesMatch(subject, packageRoot)) {
    return denied(subject, 'transition.stale_base', ['validate base references']);
  }
  if (row === undefined) {
    return {...denied(subject, 'transition.undefined', ['evaluate transition']), illegal_transition: true};
  }

  const expectedRoles = row.actor_authority.roles;
  const actorIds = subject.actors.map(({principal_id: principalId}) => principalId);
  const actualRoles = [...new Set(subject.actors.flatMap(({roles}) => roles))];
  const actorRolesMatch = actualRoles.length === expectedRoles.length &&
    expectedRoles.every((role) => actualRoles.includes(role));
  const actorCountMatches = new Set(actorIds).size === actorIds.length &&
    actorIds.length >= row.actor_authority.quorum;
  const distinctActorsMatch = !row.actor_authority.distinct_actors ||
    rolesHaveDistinctActors(expectedRoles, subject.actors);
  const delegationMatches = row.actor_authority.delegation !== 'forbidden' ||
    subject.actors.every(({delegated}) => delegated === false);
  const identityAssuranceMatches = subject.actors.every(({identity_assurance: assurance}) =>
    assurance === 'canonical_authenticated_human');
  if (!actorRolesMatch || !actorCountMatches || !distinctActorsMatch || !delegationMatches ||
      !identityAssuranceMatches) {
    return denied(subject, 'transition.authority_denied', ['validate actor authority']);
  }
  if (!row.allowed) {
    return {
      ...denied(subject, row.failure_result.code, [subject.command], row.failure_result.filesystem_effects,
        row.failure_result.emitted_records),
      terminal_state: row.terminal_state,
      illegal_transition: true,
    };
  }
  if (subject.idempotency_status === 'conflict') {
    return denied(subject, 'transition.idempotency_conflict', ['validate idempotency key']);
  }

  const releasePreconditionsMet = subject.command !== 'release' ||
    await releaseEvidenceMatches(subject, packageRoot);
  if (!subject.preconditions.declared_conditions_met || !releasePreconditionsMet) {
    return denied(subject, row.failure_result.code, ['validate transition preconditions'],
      row.failure_result.filesystem_effects, row.failure_result.emitted_records);
  }
  if (subject.idempotency_status === 'matching_receipt') {
    return {
      verdict: 'pass',
      codes: [],
      outputs: ['original transition receipt returned'],
      operations: ['read idempotency receipt'],
      receipts: row.emitted_records,
      filesystem_effects: ['none'],
      terminal_state: row.terminal_state,
      illegal_transition: false,
    };
  }
  return {
    verdict: 'pass',
    codes: [],
    outputs: ['transition accepted'],
    operations: [subject.command],
    receipts: row.emitted_records,
    filesystem_effects: row.filesystem_effects,
    terminal_state: row.terminal_state,
    illegal_transition: false,
  };
}
