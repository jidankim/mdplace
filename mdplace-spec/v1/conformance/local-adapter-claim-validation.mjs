import {isDeepStrictEqual} from 'node:util';

import {
  localAdapterEvidenceEvaluatedAt,
  localAdapterEvidenceDigest,
  localAdapterEvidencePaths,
  sha256,
} from './local-adapter-core.mjs';
import {readPackageFile} from './safe-path.mjs';

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {read, document: null};
  try {
    return {read, document: JSON.parse(read.content.toString('utf8'))};
  } catch {
    return {read, document: null};
  }
}

const evidenceEvaluationTime = Date.parse(localAdapterEvidenceEvaluatedAt);

function expectedVerdict(capability, isolation) {
  const statuses = [capability?.status, isolation?.status];
  if (statuses.includes('unsupported')) return 'unsupported';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  const evidence = [capability, isolation];
  return statuses.every((status) => status === 'current') && evidence.every((value) => {
    const observed = Date.parse(value?.observed_at);
    const expires = Date.parse(value?.expires_at);
    return Number.isFinite(observed) && Number.isFinite(expires) &&
      observed <= evidenceEvaluationTime && expires > evidenceEvaluationTime;
  }) ? 'pass' : 'fail';
}

export async function localAdapterClaimMaterialCodes(document, packageRoot) {
  const codes = [];
  const row = Array.isArray(document?.rows) && document.rows.length === 1 ? document.rows[0] : null;
  if (row?.id !== 'local-adapter' || row?.owner !== 'local-adapter') {
    return ['local.claim_row_invalid'];
  }
  const [capability, isolation, fixtureManifest] = await Promise.all([
    readJson(packageRoot, 'contracts/local-intelligence-adapter/capability-evidence.json'),
    readJson(packageRoot, 'contracts/local-intelligence-adapter/isolation-evidence.json'),
    readJson(packageRoot, 'contracts/local-intelligence-adapter/fixture-manifest.json'),
  ]);
  if ([capability, isolation, fixtureManifest].some(({document: value}) => value === null)) {
    codes.push('local.required_evidence_missing');
    return codes;
  }
  const fixturePaths = fixtureManifest.document.fixtures.map(({path}) => `conformance/${path}`);
  const expectedPaths = [...localAdapterEvidencePaths, ...fixturePaths];
  const material = Array.isArray(row.evidence_material) ? row.evidence_material : [];
  const paths = material.map(({path}) => path);
  if (material.length !== expectedPaths.length || !isDeepStrictEqual(paths, expectedPaths) ||
      material.some(({ordinal}, index) => ordinal !== index) || new Set(paths).size !== paths.length) {
    codes.push('local.claim_material_invalid');
    return codes;
  }
  for (const entry of material) {
    const read = await readPackageFile(packageRoot, entry.path);
    if (read.status !== 'present' || sha256(read.content) !== entry.sha256) {
      codes.push('local.claim_material_digest_mismatch');
      break;
    }
  }
  if (localAdapterEvidenceDigest(material) !== row.evidence_digest) {
    codes.push('local.claim_evidence_digest_mismatch');
  }
  if (!isDeepStrictEqual(row.dependencies_elevated, {
    core: false,
    product_readiness: false,
    remote_adapter: false,
    codex_adapter: false,
    placement_automation: false,
  })) codes.push('local.claim_dependency_elevation');
  return codes;
}

export async function localAdapterClaimCodes(document, packageRoot) {
  const codes = await localAdapterClaimMaterialCodes(document, packageRoot);
  const row = Array.isArray(document?.rows) && document.rows.length === 1 ? document.rows[0] : null;
  if (row === null) return codes;
  const [capability, isolation] = await Promise.all([
    readJson(packageRoot, 'contracts/local-intelligence-adapter/capability-evidence.json'),
    readJson(packageRoot, 'contracts/local-intelligence-adapter/isolation-evidence.json'),
  ]);
  const verdict = expectedVerdict(capability.document, isolation.document);
  if (row.verdict !== verdict) codes.push('local.claim_verdict_invalid');
  return codes;
}
