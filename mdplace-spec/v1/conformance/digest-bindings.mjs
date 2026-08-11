import {createHash} from 'node:crypto';

export function conformanceDigestForArtifacts(artifacts) {
  const isReferenceEvidence = (path) => path.startsWith('conformance/evidence/envelopes/') ||
    path.startsWith('conformance/evidence/claims/') ||
    path.startsWith('conformance/evidence/invocations/') ||
    path === 'conformance/evidence/evidence-recovery-report.json';
  const bindings = artifacts
    .filter(({path}) => (path.startsWith('contracts/') || path.startsWith('conformance/')) &&
      (!path.startsWith('conformance/evidence/') || isReferenceEvidence(path)))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256: digest}) => `${path}\0${digest}\n`)
    .join('');
  return createHash('sha256').update(bindings).digest('hex');
}
