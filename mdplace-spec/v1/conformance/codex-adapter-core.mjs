import {createHash} from 'node:crypto';

export const codexDecisionInputs = [
  'https://github.com/jidankim/mdplace/issues/11#issuecomment-5118839348',
  'https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093',
];

export const codexDecisionIds = ['DEC-011', 'DEC-008'];
export const codexAdapterRequirementIds = Array.from(
  {length: 8},
  (_, index) => `REQ-CODEX-${String(index + 1).padStart(3, '0')}`,
);
export const codexAdapterEvidenceEvaluatedAt = '2026-08-24T00:00:00.000Z';
export const codexAdapterCategories = [
  'positive',
  'negative',
  'exact_boundary',
  'over_boundary',
  'stale_state',
  'authority_denial',
  'illegal_transition',
  'crash_recovery',
];
export const codexAdapterEvidencePaths = [
  'normative/codex-intelligence-adapter-profile.md',
  'contracts/codex-intelligence-adapter/profile.json',
  'contracts/codex-intelligence-adapter/boundary.json',
  'contracts/codex-intelligence-adapter/authentication-prerequisite.json',
  'contracts/codex-intelligence-adapter/capability-proof.json',
  'contracts/codex-intelligence-adapter/network-proof.json',
  'contracts/codex-intelligence-adapter/fixture-manifest.json',
  'contracts/verdicts/codex-adapter-verdicts.json',
  'conformance/evidence/codex-adapter-evidence.json',
];

export function codexSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function codexAdapterEvidenceDigest(material) {
  return codexSha256(material
    .map(({ordinal, label, path, sha256}) => `${ordinal}\0${label}\0${path}\0${sha256}\n`)
    .join(''));
}
