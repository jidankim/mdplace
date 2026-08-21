import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  localAdapterClaimCodes,
  localAdapterClaimMaterialCodes,
} from './local-adapter-claim-validation.mjs';
import {sha256} from './local-adapter-core.mjs';
import {readPackageFile} from './safe-path.mjs';

function canonicalTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {read, document: null};
  try {
    return {read, document: JSON.parse(read.content.toString('utf8'))};
  } catch {
    return {read, document: null};
  }
}

export async function localAdapterEvidenceStatus({
  raw,
  digest,
  schemaPath,
  evaluatedAt,
  profileSha256,
  packageRoot,
}) {
  if (raw === null && digest === null) return 'missing';
  if (typeof raw !== 'string' || typeof digest !== 'string' || sha256(raw) !== digest) {
    return 'malformed';
  }
  let document;
  try {
    document = JSON.parse(raw);
    const code = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, document));
    if (code !== null) return 'malformed';
  } catch {
    return 'malformed';
  }
  if (document.profile_sha256 !== profileSha256) return 'malformed';
  if (document.status === 'unsupported' || document.status === 'inconclusive') return document.status;
  const evaluated = canonicalTimestamp(evaluatedAt);
  const observed = canonicalTimestamp(document.observed_at);
  const expires = canonicalTimestamp(document.expires_at);
  if (evaluated === null || observed === null || expires === null || observed > evaluated) return 'malformed';
  return expires <= evaluated ? 'stale' : 'current';
}

export async function localAdapterAttemptObservation(document, packageRoot) {
  if (typeof document.attempt_observation_json !== 'string' ||
      sha256(document.attempt_observation_json) !== document.attempt_observation_sha256) {
    return {code: 'local.isolation_observation_malformed', document: null};
  }
  try {
    const parsed = JSON.parse(document.attempt_observation_json);
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/local-adapter-attempt-observation.schema.json',
      parsed,
    ));
    const started = Date.parse(parsed.observed_started_at);
    const completed = Date.parse(parsed.observed_completed_at);
    const timingIsCanonical = Number.isFinite(started) && Number.isFinite(completed) && completed >= started &&
      new Date(started).toISOString() === parsed.observed_started_at &&
      new Date(completed).toISOString() === parsed.observed_completed_at;
    return schemaCode === null && timingIsCanonical && parsed.scenario_id === document.scenario_id
      ? {code: null, document: parsed}
      : {code: 'local.isolation_observation_malformed', document: null};
  } catch {
    return {code: 'local.isolation_observation_malformed', document: null};
  }
}

const recoveryBoundaries = new Map([
  ['crash_before_receipt', 'before_receipt'],
  ['crash_after_receipt', 'after_receipt'],
]);

export function localAdapterRecoveryTarget(document) {
  if (document?.operation !== 'recover') return null;
  let envelope;
  try {
    envelope = JSON.parse(document.processing_envelope_json);
  } catch {
    return null;
  }
  const crashBoundary = recoveryBoundaries.get(document.behavior) ?? null;
  return typeof envelope?.attempt_id === 'string' &&
    Number.isInteger(envelope.attempt_sequence) && crashBoundary !== null
    ? {
        attempt_id: envelope.attempt_id,
        attempt_sequence: envelope.attempt_sequence,
        crash_boundary: crashBoundary,
      }
    : null;
}

export async function localAdapterRecoveryRecord(fixtureId, packageRoot) {
  const report = await readJson(
    packageRoot,
    'conformance/evidence/local-adapter-recovery-report.json',
  );
  return Array.isArray(report.document?.cases)
    ? report.document.cases.find(({fixture_id: id}) => id === fixtureId) ?? null
    : null;
}

export async function localAdapterRecoveryValidation(recoveryRecord, document, packageRoot) {
  const claim = await readJson(packageRoot, 'contracts/local-intelligence-adapter/claim-manifest.json');
  let claimSchemaValid = false;
  try {
    claimSchemaValid = claim.document !== null && schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/local-adapter-claim-manifest.schema.json',
      claim.document,
    )) === null;
  } catch {
    claimSchemaValid = false;
  }
  const target = localAdapterRecoveryTarget(document);
  const attemptRevalidated = target !== null &&
    recoveryRecord?.attempt_id === target.attempt_id &&
    recoveryRecord?.attempt_sequence === target.attempt_sequence &&
    recoveryRecord?.crash_boundary === target.crash_boundary;
  const claimDigestRevalidated = claimSchemaValid &&
    typeof recoveryRecord?.claim_manifest_sha256 === 'string' &&
    recoveryRecord.claim_manifest_sha256 === sha256(claim.read.content);
  const requiredEvidence = [
    ['contracts/local-intelligence-adapter/capability-evidence.json', 'contracts/schemas/local-adapter-capability-evidence.schema.json'],
    ['contracts/local-intelligence-adapter/isolation-evidence.json', 'contracts/schemas/local-adapter-isolation-evidence.schema.json'],
    ['contracts/local-intelligence-adapter/fixture-manifest.json', 'contracts/schemas/local-adapter-fixture-manifest.schema.json'],
    ['conformance/evidence/local-adapter-evidence.json', 'contracts/schemas/local-adapter-evidence.schema.json'],
  ];
  const evidenceResults = await Promise.all(requiredEvidence.map(async ([path, schemaPath]) => {
    const value = await readJson(packageRoot, path);
    if (value.document === null) return false;
    try {
      return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, value.document)) === null;
    } catch {
      return false;
    }
  }));
  const materialCodes = claimSchemaValid
    ? await localAdapterClaimMaterialCodes(claim.document, packageRoot)
    : ['local.claim_material_invalid'];
  const materialInvalid = materialCodes.some((code) => [
    'local.required_evidence_missing',
    'local.claim_material_invalid',
    'local.claim_material_digest_mismatch',
    'local.claim_evidence_digest_mismatch',
  ].includes(code));
  const evidenceDigestMatches = claimSchemaValid &&
    typeof recoveryRecord?.evidence_digest === 'string' &&
    recoveryRecord.evidence_digest === claim.document.rows[0].evidence_digest;
  const parsedEvidenceRevalidated = evidenceResults.every(Boolean) &&
    !materialInvalid && evidenceDigestMatches;
  let code = null;
  if (!claimDigestRevalidated) code = 'local.recovery_claim_digest_mismatch';
  else if (!parsedEvidenceRevalidated) code = 'local.recovery_evidence_digest_mismatch';
  else if (!attemptRevalidated) code = 'local.recovery_attempt_mismatch';
  else if ((await localAdapterClaimCodes(claim.document, packageRoot)).length > 0) {
    code = 'local.recovery_claim_invalid';
  }
  return {code, attemptRevalidated, claimDigestRevalidated, parsedEvidenceRevalidated};
}
