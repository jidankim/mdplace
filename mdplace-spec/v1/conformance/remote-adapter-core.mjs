import {createHash} from 'node:crypto';

export const remoteAdapterRequirementIds = Array.from(
  {length: 10},
  (_, index) => `REQ-RAP-${String(index + 1).padStart(3, '0')}`,
);

export const remoteAdapterEvidenceEvaluatedAt = '2026-08-23T00:00:00.000Z';

export const remoteAdapterCategories = [
  'positive',
  'negative',
  'exact_boundary',
  'over_boundary',
  'stale_state',
  'authority_denial',
  'illegal_transition',
  'crash_recovery',
];

export const remoteAdapterEvidencePaths = [
  'contracts/remote-intelligence-adapter/profile.json',
  'contracts/remote-intelligence-adapter/credential-boundary-evidence.json',
  'conformance/evidence/remote-adapter-provider-disclosure.txt',
  'contracts/remote-intelligence-adapter/retention-evidence.json',
  'contracts/remote-intelligence-adapter/fixture-manifest.json',
  'conformance/evidence/remote-adapter-evidence.json',
];

export function remoteSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function remoteAdapterEvidenceDigest(material) {
  return remoteSha256(material
    .map(({ordinal, label, path, sha256}) => `${ordinal}\0${label}\0${path}\0${sha256}\n`)
    .join(''));
}
