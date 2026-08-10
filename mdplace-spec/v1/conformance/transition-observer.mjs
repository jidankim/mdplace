import {createHash} from 'node:crypto';

import {checkArtifactBindings, checkManifest} from './package-checks.mjs';
import {inspectAbsentPackageEntry, inspectPackageEntry, readPackageFile} from './safe-path.mjs';

const normativeDigestReference = 'package-manifest.yaml#/normative_digest';

function rolesHaveDistinctActors(roles, actors, index = 0, usedActorIds = new Set()) {
  if (index === roles.length) return true;
  return actors.some((actor) =>
    Array.isArray(actor?.roles) && actor.roles.includes(roles[index]) &&
    !usedActorIds.has(actor.principal_id) &&
    rolesHaveDistinctActors(roles, actors, index + 1, new Set([...usedActorIds, actor.principal_id])));
}

function equalSets(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

function observedPath(root, path) {
  return root === '.' ? path : `${root}/${path}`;
}

function isGreaterSemver(target, source) {
  const semver = /^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
  if (!semver.test(target) || !semver.test(source)) return false;
  const targetParts = target.split('.').map(Number);
  const sourceParts = source.split('.').map(Number);
  return targetParts.some((part, index) => part > sourceParts[index] &&
    targetParts.slice(0, index).every((earlier, earlierIndex) => earlier === sourceParts[earlierIndex]));
}

async function releaseEvidenceMatches(subject, packageRoot) {
  const evidence = subject.release_evidence;
  if (evidence === null || evidence === undefined) return false;
  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  if (manifest === null) return false;
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
  const observedPresenceMatches = observationRootIsSafe && (await Promise.all(
    observedSlots.map(async ({path, presence}) => {
      if (typeof path !== 'string') return false;
      const inspected = await inspectPackageEntry(
        packageRoot,
        observedPath(observation.observation_root, path),
        path.endsWith('/') ? 'directory' : 'file',
      );
      return inspected.status === (presence === 'present' ? 'present' : 'absent');
    }),
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
  const immutableTarget = evidence.immutable_target;
  const immutableTargetMatches = /^conformance\/release-targets\/[a-z][a-z0-9-]{2,63}$/.test(immutableTarget?.observation_root ?? '') &&
    immutableTarget?.path === `releases/${manifest.release_version}` &&
    immutableTarget?.status === 'absent_available' &&
    (await inspectAbsentPackageEntry(
      packageRoot,
      observedPath(immutableTarget.observation_root, immutableTarget.path),
    )).status === 'absent';
  return slotObservationMatches &&
    evidence.verified_artifact_digest_ref === normativeDigestReference && approvalsMatch &&
    immutableTargetMatches;
}

async function baseReferencesMatch(subject, packageRoot) {
  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  return manifest !== null && subject.base_references?.package_series === manifest.package_series &&
    subject.base_references.release_version === manifest.release_version &&
    subject.base_references.normative_digest_ref === normativeDigestReference &&
    /^[a-f0-9]{64}$/.test(manifest.normative_digest);
}

async function candidatePreconditionsMatch(subject, packageRoot) {
  const preconditions = subject.preconditions;
  if (preconditions?.manifest_ref !== 'package-manifest.yaml' ||
      preconditions?.artifact_ledger_ref !== 'package-manifest.yaml#/artifacts' ||
      preconditions?.normative_digest_ref !== normativeDigestReference) return false;
  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  if (manifest === null) return false;
  const [manifestCheck, artifactCheck] = await Promise.all([
    checkManifest(packageRoot, manifest),
    checkArtifactBindings(packageRoot, manifest).then(({check}) => check),
  ]);
  return manifestCheck.verdict === 'pass' && artifactCheck.verdict === 'pass';
}

async function amendmentEvidenceMatches(subject, packageRoot) {
  const evidence = subject.amendment_evidence;
  if (evidence === null || evidence === undefined) return false;
  const rootIsSafe = /^conformance\/release-targets\/[a-z][a-z0-9-]{2,63}$/.test(evidence.observation_root ?? '');
  if (!rootIsSafe || typeof evidence.source_manifest !== 'string' ||
      !Array.isArray(evidence.changed_requirement_ids) || evidence.changed_requirement_ids.length === 0) {
    return false;
  }
  const sourceManifest = await readJson(packageRoot, observedPath(evidence.observation_root, evidence.source_manifest));
  const sourceArtifacts = Array.isArray(sourceManifest?.artifacts) ? sourceManifest.artifacts : [];
  const sourceDirectory = evidence.source_manifest.split('/').slice(0, -1).join('/');
  const artifactPaths = sourceArtifacts.map((artifact) => artifact?.path);
  const artifactBindingsMatch = sourceArtifacts.length > 0 && new Set(artifactPaths).size === artifactPaths.length &&
    (await Promise.all(sourceArtifacts.map(async (artifact) => {
      if (artifact === null || typeof artifact !== 'object' || typeof artifact.path !== 'string' ||
          typeof artifact.sha256 !== 'string' || !['normative', 'informative'].includes(artifact.authority)) return false;
      const read = await readPackageFile(
        packageRoot,
        observedPath(evidence.observation_root, observedPath(sourceDirectory, artifact.path)),
      );
      return read.status === 'present' && createHash('sha256').update(read.content).digest('hex') === artifact.sha256;
    }))).every(Boolean);
  const observedSourceDigest = createHash('sha256').update(
    sourceArtifacts
      .filter((artifact) => artifact?.authority === 'normative' &&
        typeof artifact.path === 'string' && typeof artifact.sha256 === 'string')
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({path, sha256}) => `${path}\0${sha256}\n`)
      .join(''),
  ).digest('hex');
  if (sourceManifest === null || sourceManifest.lifecycle_state !== 'released' ||
      sourceManifest.package_series !== subject.base_references.package_series ||
      sourceManifest.release_version !== subject.base_references.release_version ||
      sourceManifest.normative_digest !== evidence.source_digest ||
      observedSourceDigest !== sourceManifest.normative_digest || !artifactBindingsMatch ||
      !/^[a-f0-9]{64}$/.test(evidence.source_digest) ||
      !isGreaterSemver(evidence.target_version, sourceManifest.release_version) ||
      evidence.target_path !== `releases/${evidence.target_version}`) return false;
  const target = await inspectAbsentPackageEntry(
    packageRoot,
    observedPath(evidence.observation_root, evidence.target_path),
  );
  return target.status === 'absent';
}

async function commandPreconditionsMatch(subject, packageRoot) {
  if (!await candidatePreconditionsMatch(subject, packageRoot)) return false;
  switch (subject.command) {
    case 'submit':
    case 'approve':
      return true;
    case 'release':
      return releaseEvidenceMatches(subject, packageRoot);
    case 'amend':
      return amendmentEvidenceMatches(subject, packageRoot);
    default:
      return false;
  }
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
  const table = await readJson(packageRoot, subject.table);
  const row = table?.transitions?.find((candidate) =>
    candidate.from_state === subject.from_state && candidate.command_or_event === subject.command);
  if (!await baseReferencesMatch(subject, packageRoot)) {
    return denied(subject, 'transition.stale_base', ['validate base references']);
  }
  if (row === undefined) {
    return {...denied(subject, 'transition.undefined', ['evaluate transition']), illegal_transition: true};
  }

  const expectedRoles = row.actor_authority.roles;
  const actors = Array.isArray(subject.actors) ? subject.actors : [];
  const actorIds = actors.map(({principal_id: principalId}) => principalId);
  const actualRoles = [...new Set(actors.flatMap(({roles}) => Array.isArray(roles) ? roles : []))];
  const actorRolesMatch = actualRoles.length === expectedRoles.length &&
    expectedRoles.every((role) => actualRoles.includes(role));
  const actorCountMatches = new Set(actorIds).size === actorIds.length &&
    actorIds.length >= row.actor_authority.quorum;
  const distinctActorsMatch = !row.actor_authority.distinct_actors ||
    rolesHaveDistinctActors(expectedRoles, actors);
  const delegationMatches = row.actor_authority.delegation !== 'forbidden' ||
    actors.every(({delegated}) => delegated === false);
  const identityAssuranceMatches = actors.every(({identity_assurance: assurance}) =>
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

  if (!await commandPreconditionsMatch(subject, packageRoot)) {
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
