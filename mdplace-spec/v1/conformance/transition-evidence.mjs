import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {validateAgainstSchemaPath} from './json-schema.mjs';
import {inspectAbsentPackageEntry, inspectPackageEntry, readPackageFile} from './safe-path.mjs';

const digestReference = 'package-manifest.yaml#/normative_digest';

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

async function releaseAssetsMatch(evidence, manifest, packageRoot) {
  const assets = evidence.release_assets;
  const validationPath = 'conformance/evidence/validation-report.json';
  const traceabilityPath = 'conformance/evidence/traceability-report.json';
  if (assets?.specification_digest_ref !== digestReference ||
      assets?.conformance_digest_ref !== `package-manifest.yaml#/artifacts/${validationPath}/sha256` ||
      assets?.validator_version_ref !== 'package-manifest.yaml#/validator_version' ||
      assets?.validation_report_ref !== validationPath ||
      assets?.traceability_report_ref !== traceabilityPath ||
      assets?.traceability_report_digest_ref !== `package-manifest.yaml#/artifacts/${traceabilityPath}/sha256`) {
    return false;
  }
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const validationBinding = artifacts.find(({path}) => path === validationPath);
  const traceabilityBinding = artifacts.find(({path}) => path === traceabilityPath);
  const [validationRead, traceabilityRead] = await Promise.all([
    readPackageFile(packageRoot, validationPath),
    readPackageFile(packageRoot, traceabilityPath),
  ]);
  if (validationRead.status !== 'present' || traceabilityRead.status !== 'present' ||
      validationBinding?.authority !== 'informative' || traceabilityBinding?.authority !== 'informative' ||
      createHash('sha256').update(validationRead.content).digest('hex') !== validationBinding.sha256 ||
      createHash('sha256').update(traceabilityRead.content).digest('hex') !== traceabilityBinding.sha256) return false;
  let validationReport;
  let traceabilityReport;
  try {
    validationReport = JSON.parse(validationRead.content.toString('utf8'));
    traceabilityReport = JSON.parse(traceabilityRead.content.toString('utf8'));
  } catch {
    return false;
  }
  const reportBindingMatches = (report) => report.package_series === manifest.package_series &&
    report.release_version === manifest.release_version &&
    report.validator_version === manifest.validator_version &&
    report.normative_digest === manifest.normative_digest && report.verdict === 'pass';
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  const traceability = await readJson(packageRoot, 'traceability.yaml');
  const requirementIds = Array.isArray(requirements?.requirements)
    ? requirements.requirements.map(({id}) => id)
    : [];
  const tracedIds = Array.isArray(traceability?.records)
    ? traceability.records.map(({requirement_id: id}) => id)
    : [];
  const unresolvedIds = requirementIds.filter((id) => !tracedIds.includes(id));
  return validationReport.schema_id === 'mdplace.validation-report/v1' &&
    traceabilityReport.schema_id === 'mdplace.traceability-report/v1' &&
    reportBindingMatches(validationReport) && reportBindingMatches(traceabilityReport) &&
    requirementIds.length > 0 && new Set(requirementIds).size === requirementIds.length &&
    new Set(tracedIds).size === tracedIds.length && equalSets(requirementIds, tracedIds) &&
    traceabilityReport.requirements_total === requirementIds.length &&
    traceabilityReport.records_total === tracedIds.length &&
    Array.isArray(traceabilityReport.unresolved_requirement_ids) &&
    equalSets(traceabilityReport.unresolved_requirement_ids, unresolvedIds) && unresolvedIds.length === 0;
}

export async function releaseEvidenceMatches(subject, packageRoot) {
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
      approval.delegated === false && approval.normative_digest_ref === digestReference);
  const slotObservationMatches = observation.observer_id === 'mdplace.package-validator/v1' &&
    observation.identity_assurance === 'trusted_local_validator' &&
    observation.verification_method === 'filesystem_lstat' &&
    observation.package_series === manifest.package_series &&
    observation.release_version === manifest.release_version &&
    observation.normative_digest_ref === digestReference &&
    observation.required_release_slots_digest === slotDigest &&
    new Set(observedPaths).size === observedPaths.length && equalSets(observedPaths, requiredSlots) &&
    observedSlots.every(({presence}) => presence === 'present') && observedPresenceMatches;
  const immutableTarget = evidence.immutable_target;
  const immutableTargetMatches = /^conformance\/release-targets\/[a-z][a-z0-9-]{2,63}$/.test(immutableTarget?.observation_root ?? '') &&
    immutableTarget?.path === `releases/${manifest.release_version}` &&
    immutableTarget?.status === 'absent_available' &&
    (await inspectAbsentPackageEntry(
      packageRoot,
      observedPath(immutableTarget.observation_root, immutableTarget.path),
    )).status === 'absent';
  return slotObservationMatches && evidence.verified_artifact_digest_ref === digestReference &&
    approvalsMatch && immutableTargetMatches && await releaseAssetsMatch(evidence, manifest, packageRoot);
}

export async function amendmentEvidenceMatches(subject, packageRoot) {
  const evidence = subject.amendment_evidence;
  if (evidence === null || evidence === undefined) return false;
  const rootIsSafe = /^conformance\/release-targets\/[a-z][a-z0-9-]{2,63}$/.test(evidence.observation_root ?? '');
  if (!rootIsSafe || typeof evidence.source_manifest !== 'string' ||
      !Array.isArray(evidence.changed_requirement_ids) || evidence.changed_requirement_ids.length === 0) return false;
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
  const observedSourceDigest = createHash('sha256').update(sourceArtifacts
    .filter((artifact) => artifact?.authority === 'normative' &&
      typeof artifact.path === 'string' && typeof artifact.sha256 === 'string')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256}) => `${path}\0${sha256}\n`).join('')).digest('hex');
  const sourceRequirementsPath = sourceArtifacts.find(({path}) => path === 'normative/requirements.json')?.path;
  const sourceRequirements = sourceRequirementsPath === undefined ? null : await readJson(
    packageRoot,
    observedPath(evidence.observation_root, observedPath(sourceDirectory, sourceRequirementsPath)),
  );
  const targetRequirements = await readJson(packageRoot, 'normative/requirements.json');
  const [sourceSchemaErrors, targetSchemaErrors] = sourceRequirements === null || targetRequirements === null
    ? [[{keyword: 'invalidSchema'}], [{keyword: 'invalidSchema'}]]
    : await Promise.all([
      validateAgainstSchemaPath(packageRoot, 'contracts/schemas/requirements.schema.json', sourceRequirements),
      validateAgainstSchemaPath(packageRoot, 'contracts/schemas/requirements.schema.json', targetRequirements),
    ]);
  const sourceEntries = Array.isArray(sourceRequirements?.requirements) ? sourceRequirements.requirements : [];
  const targetEntries = Array.isArray(targetRequirements?.requirements) ? targetRequirements.requirements : [];
  const sourceIds = sourceEntries.map(({id}) => id);
  const targetIds = targetEntries.map(({id}) => id);
  const targetById = new Map(targetEntries.map((entry) => [entry.id, entry]));
  const changedIds = sourceEntries
    .filter((entry) => targetById.has(entry.id) && !isDeepStrictEqual(entry, targetById.get(entry.id)))
    .map(({id}) => id);
  const newIds = targetIds.filter((id) => !sourceIds.includes(id));
  const requirementIdsMatch = sourceSchemaErrors.length === 0 && targetSchemaErrors.length === 0 &&
    sourceEntries.length > 0 && targetEntries.length > 0 &&
    new Set(sourceIds).size === sourceIds.length && new Set(targetIds).size === targetIds.length &&
    sourceIds.every((id) => targetById.has(id)) && equalSets(changedIds, evidence.changed_requirement_ids ?? []) &&
    equalSets(newIds, evidence.new_requirement_ids ?? []);
  if (sourceManifest === null || sourceManifest.lifecycle_state !== 'released' ||
      sourceManifest.package_series !== subject.base_references.package_series ||
      sourceManifest.release_version !== subject.base_references.release_version ||
      sourceManifest.normative_digest !== evidence.source_digest ||
      observedSourceDigest !== sourceManifest.normative_digest || !artifactBindingsMatch || !requirementIdsMatch ||
      !/^[a-f0-9]{64}$/.test(evidence.source_digest) ||
      !isGreaterSemver(evidence.target_version, sourceManifest.release_version) ||
      evidence.target_path !== `releases/${evidence.target_version}`) return false;
  const target = await inspectAbsentPackageEntry(
    packageRoot,
    observedPath(evidence.observation_root, evidence.target_path),
  );
  return target.status === 'absent';
}
