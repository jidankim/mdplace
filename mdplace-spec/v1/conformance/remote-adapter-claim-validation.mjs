import {isDeepStrictEqual} from 'node:util';

import {
  remoteAdapterEvidenceDigest,
  remoteAdapterEvidencePaths,
  remoteSha256,
} from './remote-adapter-core.mjs';
import {remoteAdapterCases} from './remote-adapter-fixtures.mjs';
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

export function deriveRemoteAdapterVerdict(evidence) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return 'unsupported';
  const bindings = evidence.fixture_bindings;
  const receipts = evidence.receipt_sha256s;
  const mandatoryDigests = [
    evidence.credential_boundary_evidence_sha256,
    evidence.retention_evidence_sha256,
    evidence.fixture_manifest_sha256,
  ];
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
  if (!Array.isArray(bindings) || bindings.length === 0 || !Array.isArray(receipts) ||
      mandatoryDigests.some((digest) => digest === undefined)) return 'unsupported';
  if (bindings.length !== remoteAdapterCases.length || receipts.length !== bindings.length ||
      !isDeepStrictEqual(receipts, bindings.map(({receipt_sha256: digest}) => digest))) return 'inconclusive';
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
  const derivedVerdict = deriveRemoteAdapterVerdict(evidence);
  if (evidence === null || genericClaim === null || envelope === null ||
      evidence.verdict !== derivedVerdict || row.verdict !== derivedVerdict ||
      genericClaim.verdict !== derivedVerdict || genericBinding?.verdict !== derivedVerdict ||
      envelope.verdict !== derivedVerdict || codes.length > 0) {
    codes.push('remote.claim_verdict_invalid');
  }
  return codes;
}
