import {isDeepStrictEqual} from 'node:util';

import {
  remoteAdapterEvidenceDigest,
  remoteAdapterEvidencePaths,
  remoteSha256,
} from './remote-adapter-core.mjs';
import {remoteAdapterCases} from './remote-adapter-fixtures.mjs';
import {
  observeRemoteAdapterScenario,
  remoteAdapterReceiptDigest,
} from './remote-adapter-observer.mjs';
import {
  authoredRemoteRecoveryRecord,
  currentRemoteClaimBinding,
} from './remote-adapter-recovery-authoring.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

const dependencyBoundary = {
  core: false,
  product_readiness: false,
  local_adapter: false,
  codex_adapter: false,
  placement_automation: false,
  other_profiles: false,
};
const digestPattern = /^[a-f0-9]{64}$/;
const providerFactDimensions = [
  'residency',
  'retention',
  'training',
  'deletion',
  'entitlement',
  'privacy_behavior',
];

async function schemaIsValid(packageRoot, schema, document) {
  try {
    return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schema, document)) === null;
  } catch {
    return false;
  }
}

async function readMandatoryDocument(packageRoot, path, digest, schema) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status === 'absent') return {status: 'missing', document: null};
  if (read.status !== 'present') return {status: 'invalid', document: null};
  if (remoteSha256(read.content) !== digest) return {status: 'invalid', document: null};
  let document;
  try {
    document = JSON.parse(read.content.toString('utf8'));
  } catch {
    return {status: 'invalid', document: null};
  }
  return {
    status: await schemaIsValid(packageRoot, schema, document) ? 'present' : 'invalid',
    document,
  };
}

function receiptMatchesFixture(receipt, fixture) {
  const scenario = fixture.subject?.document;
  if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) return false;
  let attempts;
  let retention;
  try {
    attempts = JSON.parse(scenario.attempt_observations_json)
      .map(({payload_base64: ignored, ...attempt}) => {
        void ignored;
        return attempt;
      });
  } catch {
    return false;
  }
  try {
    retention = scenario.retention_evidence_json === null
      ? null
      : JSON.parse(scenario.retention_evidence_json);
  } catch {
    retention = null;
  }
  const providerFactStatuses = Object.fromEntries(providerFactDimensions.map((dimension) => [
    dimension,
    retention?.facts?.find((fact) => fact.dimension === dimension)?.status ?? 'unsupported',
  ]));
  const expected = fixture.expected;
  const reason = expected.terminal_state === 'recovered'
    ? 'remote.recovery_completed'
    : expected.codes[0] ?? 'remote.egress_permitted';
  return receipt.receipt_id === `remote-adapter-receipt:${scenario.scenario_id.toLowerCase()}` &&
    receipt.scenario_id === scenario.scenario_id && receipt.outcome === expected.terminal_state &&
    receipt.reason === reason && isDeepStrictEqual(receipt.attempts, attempts) &&
    receipt.credential_boundary_sha256 === scenario.credential_evidence_sha256 &&
    receipt.retention_evidence_sha256 === scenario.retention_evidence_sha256 &&
    isDeepStrictEqual(receipt.provider_fact_statuses, providerFactStatuses);
}

export async function deriveRemoteAdapterVerdict(
  evidence,
  packageRoot,
  {validateObservations = true} = {},
) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return 'unsupported';
  const bindings = evidence.fixture_bindings;
  const receipts = evidence.receipt_sha256s;
  const mandatoryDigests = [
    evidence.credential_boundary_evidence_sha256,
    evidence.retention_evidence_sha256,
    evidence.fixture_manifest_sha256,
  ];
  if (!Array.isArray(bindings) || bindings.length === 0 || !Array.isArray(receipts) || receipts.length === 0 ||
      evidence.network_operations === undefined || mandatoryDigests.some((digest) => digest === undefined)) {
    return 'unsupported';
  }
  const invalidBinding = (binding) => binding === null || typeof binding !== 'object' ||
    Array.isArray(binding) || typeof binding.fixture_id !== 'string' || typeof binding.path !== 'string' ||
    !digestPattern.test(binding.fixture_sha256) || !digestPattern.test(binding.receipt_sha256) ||
    !['pass', 'fail', 'unsupported', 'inconclusive'].includes(binding.verdict);
  if ((evidence.network_operations !== undefined && evidence.network_operations !== 0) ||
      mandatoryDigests.some((digest) => digest !== undefined && !digestPattern.test(digest)) ||
      (Array.isArray(bindings) && bindings.some(invalidBinding)) ||
      (Array.isArray(bindings) && !bindings.some(invalidBinding) &&
        (new Set(bindings.map(({fixture_id: id}) => id)).size !== bindings.length ||
          new Set(bindings.map(({path}) => path)).size !== bindings.length))) return 'fail';
  if (bindings.length !== remoteAdapterCases.length || receipts.length !== bindings.length) return 'inconclusive';
  if (!isDeepStrictEqual(receipts, bindings.map(({receipt_sha256: digest}) => digest))) return 'fail';
  const expectedBindings = remoteAdapterCases.map(([caseId], index) => ({
    fixture_id: `FIX-RAP-PROFILE-${String(index + 1).padStart(3, '0')}`,
    path: `conformance/scenarios/remote-intelligence-adapter/${caseId}.json`,
  }));
  if (!isDeepStrictEqual(
    bindings.map(({fixture_id: fixtureId, path}) => ({fixture_id: fixtureId, path})),
    expectedBindings,
  )) return 'fail';
  if (!await schemaIsValid(
    packageRoot,
    'contracts/schemas/remote-adapter-evidence.schema.json',
    evidence,
  )) return 'fail';
  const [credential, retention, fixtureManifest] = await Promise.all([
    readMandatoryDocument(
      packageRoot,
      'contracts/remote-intelligence-adapter/credential-boundary-evidence.json',
      evidence.credential_boundary_evidence_sha256,
      'contracts/schemas/remote-adapter-credential-boundary-evidence.schema.json',
    ),
    readMandatoryDocument(
      packageRoot,
      'contracts/remote-intelligence-adapter/retention-evidence.json',
      evidence.retention_evidence_sha256,
      'contracts/schemas/remote-adapter-retention-evidence.schema.json',
    ),
    readMandatoryDocument(
      packageRoot,
      'contracts/remote-intelligence-adapter/fixture-manifest.json',
      evidence.fixture_manifest_sha256,
      'contracts/schemas/remote-adapter-fixture-manifest.schema.json',
    ),
  ]);
  if ([credential, retention, fixtureManifest].some(({status}) => status === 'missing')) return 'unsupported';
  if ([credential, retention, fixtureManifest].some(({status}) => status !== 'present')) return 'fail';
  if (!isDeepStrictEqual(
    fixtureManifest.document.fixtures.map(({fixture_id: fixtureId, path}) => ({
      fixture_id: fixtureId,
      path: `conformance/${path}`,
    })),
    expectedBindings,
  )) return 'fail';
  let recoveryReport = null;
  let currentClaimBinding = null;
  if (validateObservations) {
    const recoveryRead = await readPackageFile(
      packageRoot,
      'conformance/evidence/remote-adapter-recovery-report.json',
    );
    if (recoveryRead.status !== 'present') return 'fail';
    try {
      recoveryReport = JSON.parse(recoveryRead.content.toString('utf8'));
    } catch {
      return 'fail';
    }
    if (!await schemaIsValid(
      packageRoot,
      'contracts/schemas/remote-adapter-recovery-report.schema.json',
      recoveryReport,
    )) return 'fail';
    currentClaimBinding = await currentRemoteClaimBinding(packageRoot);
    if (recoveryReport.claim_manifest_sha256 !== currentClaimBinding.claim_manifest_sha256 ||
        recoveryReport.evidence_digest !== currentClaimBinding.evidence_digest) return 'fail';
    const expectedRecoveryFixtureIds = remoteAdapterCases.flatMap(([, , overrides], index) =>
      overrides.operation === 'recover'
        ? [`FIX-RAP-PROFILE-${String(index + 1).padStart(3, '0')}`]
        : []);
    if (!isDeepStrictEqual(
      recoveryReport.cases.map(({fixture_id: fixtureId}) => fixtureId),
      expectedRecoveryFixtureIds,
    )) return 'fail';
  }
  for (const [index, binding] of bindings.entries()) {
    const fixtureRead = await readPackageFile(packageRoot, binding.path);
    if (fixtureRead.status === 'absent') return 'unsupported';
    if (fixtureRead.status !== 'present') return 'fail';
    if (remoteSha256(fixtureRead.content) !== binding.fixture_sha256) return 'fail';
    let fixture;
    let receipt;
    try {
      fixture = JSON.parse(fixtureRead.content.toString('utf8'));
      if (!Array.isArray(fixture.expected?.receipts) || fixture.expected.receipts.length !== 1) return 'fail';
      receipt = JSON.parse(fixture.expected.receipts[0]);
    } catch {
      return 'fail';
    }
    if (!await schemaIsValid(packageRoot, 'contracts/schemas/conformance-fixture.schema.json', fixture) ||
        !await schemaIsValid(
          packageRoot,
          'contracts/schemas/remote-adapter-scenario.schema.json',
          fixture.subject?.document,
        ) || !await schemaIsValid(
          packageRoot,
          'contracts/schemas/remote-adapter-profile-receipt.schema.json',
          receipt,
        ) || fixture.fixture_id !== expectedBindings[index].fixture_id ||
        fixture.expected?.verdict !== binding.verdict || receipt.receipt_sha256 !== binding.receipt_sha256 ||
        receipt.receipt_sha256 !== remoteAdapterReceiptDigest(receipt) ||
        !receiptMatchesFixture(receipt, fixture)) return 'fail';
    if (validateObservations) {
      let recoveryRecord = null;
      if (fixture.subject.document.operation === 'recover') {
        recoveryRecord = authoredRemoteRecoveryRecord(
          fixture.fixture_id,
          fixture.subject.document,
          currentClaimBinding,
        );
        const expectedCurrent = fixture.subject.document.behavior === 'recover_current';
        const reportRecord = recoveryReport.cases.find(
          ({fixture_id: fixtureId}) => fixtureId === fixture.fixture_id,
        );
        if (!isDeepStrictEqual(reportRecord, {
          ...recoveryRecord,
          attempts_revalidated: true,
          claim_digest_revalidated: expectedCurrent,
          parsed_evidence_revalidated: true,
          terminal_state: expectedCurrent ? 'recovered' : 'recovery_required',
          receipt_sha256: receipt.receipt_sha256,
        })) return 'fail';
      }
      const observed = await observeRemoteAdapterScenario(fixture.subject, packageRoot, recoveryRecord);
      if (!isDeepStrictEqual(observed, fixture.expected)) return 'fail';
    }
  }
  return 'pass';
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

export async function remoteAdapterClaimCodes(claim, packageRoot) {
  const codes = [];
  const row = Array.isArray(claim?.rows) && claim.rows.length === 1 ? claim.rows[0] : null;
  if (row === null || row.id !== 'remote-adapter' || row.owner !== 'remote-adapter' ||
      !['pass', 'fail', 'unsupported', 'inconclusive'].includes(row.verdict) ||
      !isDeepStrictEqual(row.dependencies_elevated, dependencyBoundary)) {
    codes.push('remote.claim_boundary_invalid');
    return codes;
  }
  const expectedPaths = [
    ...remoteAdapterEvidencePaths,
    ...remoteAdapterCases.map(([caseId]) => `conformance/scenarios/remote-intelligence-adapter/${caseId}.json`),
  ];
  const material = Array.isArray(row.evidence_material) ? row.evidence_material : [];
  if (!isDeepStrictEqual(material.map(({path}) => path), expectedPaths) ||
      material.some(({ordinal}, index) => ordinal !== index) ||
      new Set(material.map(({label}) => label)).size !== material.length) {
    codes.push('remote.claim_material_invalid');
    return codes;
  }
  for (const entry of material) {
    const read = await readPackageFile(packageRoot, entry.path);
    if (read.status !== 'present' || remoteSha256(read.content) !== entry.sha256) {
      codes.push('remote.claim_material_digest_mismatch');
      break;
    }
  }
  if (row.evidence_digest !== remoteAdapterEvidenceDigest(material)) {
    codes.push('remote.claim_evidence_digest_mismatch');
  }
  const [evidence, genericClaim, envelope] = await Promise.all([
    readJson(packageRoot, 'conformance/evidence/remote-adapter-evidence.json'),
    readJson(packageRoot, 'conformance/claim-manifests/remote-intelligence-adapter.json'),
    readJson(packageRoot, 'conformance/evidence/envelopes/remote-adapter-profile.json'),
  ]);
  const genericBinding = genericClaim?.evidence_bindings?.find(
    ({evidence_kind: kind}) => kind === 'remote_adapter_conformance',
  );
  const derivedVerdict = await deriveRemoteAdapterVerdict(evidence, packageRoot);
  if (evidence === null || genericClaim === null || envelope === null ||
      evidence.verdict !== derivedVerdict || row.verdict !== derivedVerdict ||
      genericClaim.verdict !== derivedVerdict || genericBinding?.verdict !== derivedVerdict ||
      envelope.verdict !== derivedVerdict || codes.length > 0) {
    codes.push('remote.claim_verdict_invalid');
  }
  return codes;
}
