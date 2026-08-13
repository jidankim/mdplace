export function isReferenceEvidence(path) {
  return path.startsWith('conformance/evidence/envelopes/') ||
    path.startsWith('conformance/evidence/claims/') ||
    path.startsWith('conformance/evidence/invocations/') ||
    path === 'conformance/evidence/core-processing-policy-recovery-report.json' ||
    path === 'conformance/evidence/evidence-recovery-report.json' ||
    path === 'conformance/evidence/semantic-kernel-recovery-report.json' ||
    path === 'conformance/evidence/control-plane-recovery-report.json' ||
    path === 'conformance/evidence/control-plane-doctor-report.json' ||
    path === 'conformance/evidence/control-plane-lifecycle-report.json';
}
