const semanticStateDigest = /^[a-f0-9]{64}$/;

export function completeControlPlaneOutputs(outputs, initial) {
  const digest = initial?.semantic_state_digest;
  return semanticStateDigest.test(digest)
    ? [...outputs, `semantic_state_digest:${digest}`]
    : [...outputs];
}
