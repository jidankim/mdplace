import {createHash} from 'node:crypto';

import {isReferenceEvidence} from './reference-evidence.mjs';

export function conformanceDigestForArtifacts(artifacts) {
  const bindings = artifacts
    .filter(({path}) => (path.startsWith('contracts/') || path.startsWith('conformance/')) &&
      (!path.startsWith('conformance/evidence/') || isReferenceEvidence(path)))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(({path, sha256: digest}) => `${path}\0${digest}\n`)
    .join('');
  return createHash('sha256').update(bindings).digest('hex');
}
