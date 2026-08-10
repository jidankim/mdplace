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
async function releaseAssetsMatch(evidence, manifest, packageRoot, options) {
  const assets = evidence.release_assets;
  const validationPath = 'conformance/evidence/validation-report.json';
  const traceabilityPath = 'conformance/evidence/traceability-report.json';
  if (assets?.specification_digest_ref !== digestReference ||
      assets?.conformance_digest_ref !== 'package-manifest.yaml#/conformance_digest' ||
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
    report.normative_digest === manifest.normative_digest &&
    report.conformance_digest === manifest.conformance_digest && report.verdict === 'pass';
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  const traceability = await readJson(packageRoot, 'traceability.yaml');
  const requirementIds = Array.isArray(requirements?.requirements)
    ? requirements.requirements.map(({id}) => id)
    : [];
  const tracedIds = Array.isArray(traceability?.records)
    ? traceability.records.map(({requirement_id: id}) => id)
    : [];
  const unresolvedIds = requirementIds.filter((id) => !tracedIds.includes(id));
  const [validationSchemaErrors, traceabilitySchemaErrors] = await Promise.all([
    validateAgainstSchemaPath(packageRoot, 'contracts/schemas/validation-report.schema.json', validationReport),
    validateAgainstSchemaPath(packageRoot, 'contracts/schemas/traceability-report.schema.json', traceabilityReport),
  ]);
  let validationReportMatches = true;
  if (options.verifyPublishedReports !== false) {
    const {buildValidationReport} = await import('./validation-report.mjs');
    validationReportMatches = isDeepStrictEqual(
      validationReport,
      await buildValidationReport(packageRoot, {verifyPublishedReports: false}),
    );
  }
  return validationSchemaErrors.length === 0 && traceabilitySchemaErrors.length === 0 &&
    validationReportMatches && validationReport.schema_id === 'mdplace.validation-report/v1' &&
    traceabilityReport.schema_id === 'mdplace.traceability-report/v1' &&
    reportBindingMatches(validationReport) && reportBindingMatches(traceabilityReport) &&
    requirementIds.length > 0 && new Set(requirementIds).size === requirementIds.length &&
    new Set(tracedIds).size === tracedIds.length && equalSets(requirementIds, tracedIds) &&
    traceabilityReport.requirements_total === requirementIds.length &&
    traceabilityReport.records_total === tracedIds.length &&
    Array.isArray(traceabilityReport.unresolved_requirement_ids) &&
    equalSets(traceabilityReport.unresolved_requirement_ids, unresolvedIds) && unresolvedIds.length === 0;
}

export async function releaseEvidenceMatches(subject, packageRoot, options = {}) {
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
    approvalsMatch && immutableTargetMatches && await releaseAssetsMatch(evidence, manifest, packageRoot, options);
}
