import {createHash} from 'node:crypto';

export function conformanceDigestForArtifacts(artifacts) {
  const bindings = artifacts
    .filter(({path}) => (path.startsWith('contracts/') || path.startsWith('conformance/')) &&
      !path.startsWith('conformance/evidence/'))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256: digest}) => `${path}\0${digest}\n`)
    .join('');
  return createHash('sha256').update(bindings).digest('hex');
}
