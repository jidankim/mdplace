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
  if (evidence === null || genericClaim === null || envelope === null ||
      row.verdict !== evidence.verdict || genericClaim.verdict !== row.verdict ||
      genericBinding?.verdict !== row.verdict || envelope.verdict !== row.verdict || codes.length > 0) {
    codes.push('remote.claim_verdict_invalid');
  }
  return codes;
}
