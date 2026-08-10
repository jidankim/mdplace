import {dirname, resolve} from 'node:path';

import {checkArtifactBindings, checkManifest} from './package-checks.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';
import {amendmentEvidenceMatches} from './amendment-evidence.mjs';
import {releaseEvidenceMatches} from './transition-evidence.mjs';

const rootManifestReference = 'package-manifest.yaml';
const observedManifestPattern = /^conformance\/release-targets\/[a-z][a-z0-9-]{2,63}\/(?:source|target)\/package-manifest\.yaml$/;

function manifestReferenceIsSafe(reference) {
  return reference === rootManifestReference || observedManifestPattern.test(reference ?? '');
}

function rolesHaveDistinctActors(roles, actors, index = 0, usedActorIds = new Set()) {
  if (index === roles.length) return true;
  return actors.some((actor) =>
    Array.isArray(actor?.roles) && actor.roles.includes(roles[index]) &&
    !usedActorIds.has(actor.principal_id) &&
    rolesHaveDistinctActors(roles, actors, index + 1, new Set([...usedActorIds, actor.principal_id])));
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

async function baseReferencesMatch(subject, packageRoot) {
  const manifestReference = subject.preconditions?.manifest_ref;
  if (!manifestReferenceIsSafe(manifestReference)) return false;
  const manifest = await readJson(packageRoot, manifestReference);
  return manifest !== null && subject.base_references?.package_series === manifest.package_series &&
    subject.base_references.release_version === manifest.release_version &&
    subject.base_references.normative_digest_ref === `${manifestReference}#/normative_digest` &&
    /^[a-f0-9]{64}$/.test(manifest.normative_digest);
}

async function candidatePreconditionsMatch(subject, packageRoot) {
  const preconditions = subject.preconditions;
  const manifestReference = preconditions?.manifest_ref;
  if (!manifestReferenceIsSafe(manifestReference) ||
      preconditions?.artifact_ledger_ref !== `${manifestReference}#/artifacts` ||
      preconditions?.normative_digest_ref !== `${manifestReference}#/normative_digest`) return false;
  const manifest = await readJson(packageRoot, manifestReference);
  if (manifest === null) return false;
  const stateManifestReference = preconditions.state_manifest_ref;
  const stateManifestReferenceIsSafe = stateManifestReference === manifestReference ||
    /^conformance\/state-observations\/[a-z][a-z0-9-]{2,63}\/package-manifest\.yaml$/.test(stateManifestReference ?? '');
  if (!stateManifestReferenceIsSafe) return false;
  const stateManifest = await readJson(packageRoot, stateManifestReference);
  let manifestSchemaErrors;
  let stateManifestSchemaErrors;
  try {
    [manifestSchemaErrors, stateManifestSchemaErrors] = await Promise.all([
      validateAgainstSchemaPath(packageRoot, 'contracts/schemas/package-manifest.schema.json', manifest),
      validateAgainstSchemaPath(packageRoot, stateManifestReference === manifestReference
        ? 'contracts/schemas/package-manifest.schema.json'
        : 'contracts/schemas/package-state-observation.schema.json', stateManifest),
    ]);
  } catch {
    return false;
  }
  if (manifestSchemaErrors.length > 0 || stateManifestSchemaErrors.length > 0) return false;
  if (stateManifest === null || stateManifest.package_series !== manifest.package_series ||
      stateManifest.release_version !== manifest.release_version ||
      stateManifest.validator_version !== manifest.validator_version ||
      stateManifest.normative_digest !== manifest.normative_digest ||
      stateManifest.lifecycle_state !== subject.from_state) return false;
  if (stateManifestReference !== manifestReference &&
      (stateManifest.schema_id !== 'mdplace.package-state-observation/v1' ||
       stateManifest.observer_id !== 'mdplace.package-validator/v1' ||
       stateManifest.identity_assurance !== 'trusted_local_validator' ||
       stateManifest.verification_method !== 'manifest_snapshot')) return false;
  const observedRoot = resolve(packageRoot, dirname(manifestReference));
  const [manifestCheck, artifactCheck] = await Promise.all([
    checkManifest(observedRoot, manifest),
    checkArtifactBindings(observedRoot, manifest).then(({check}) => check),
  ]);
  return manifestCheck.verdict === 'pass' && artifactCheck.verdict === 'pass';
}

async function commandPreconditionsMatch(subject, packageRoot, options) {
  if (!await candidatePreconditionsMatch(subject, packageRoot)) return false;
  switch (subject.command) {
    case 'submit':
    case 'approve':
      return true;
    case 'release':
      return releaseEvidenceMatches(subject, packageRoot, options);
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

export async function observeTransition(fixture, packageRoot, options = {}) {
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

  if (!await commandPreconditionsMatch(subject, packageRoot, options)) {
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
