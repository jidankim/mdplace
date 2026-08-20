import {createHash} from 'node:crypto';

export const localAdapterRequirementIds = Array.from(
  {length: 10},
  (_, index) => `REQ-LIA-${String(index + 1).padStart(3, '0')}`,
);

export const localAdapterEvidenceEvaluatedAt = '2026-08-22T00:00:00.000Z';

export const localAdapterCategories = [
  'positive',
  'negative',
  'exact_boundary',
  'over_boundary',
  'stale_state',
  'authority_denial',
  'illegal_transition',
  'crash_recovery',
];

export const localAdapterEvidencePaths = [
  'contracts/local-intelligence-adapter/profile.json',
  'contracts/local-intelligence-adapter/capability-evidence.json',
  'contracts/local-intelligence-adapter/isolation-evidence.json',
  'contracts/local-intelligence-adapter/fixture-manifest.json',
  'conformance/evidence/local-adapter-evidence.json',
];

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function localAdapterEvidenceDigest(material) {
  return sha256(material
    .map(({ordinal, label, path, sha256: digest}) => `${ordinal}\0${label}\0${path}\0${digest}\n`)
    .join(''));
}
