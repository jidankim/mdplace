export function isReferenceEvidence(path) {
  return path.startsWith('conformance/evidence/envelopes/') ||
    path.startsWith('conformance/evidence/claims/') ||
    path.startsWith('conformance/evidence/invocations/') ||
    path === 'conformance/evidence/core-processing-policy-recovery-report.json' ||
    path === 'conformance/evidence/evidence-recovery-report.json' ||
    path === 'conformance/evidence/intelligence-adapter-evidence.json' ||
    path === 'conformance/evidence/intelligence-adapter-recovery-report.json' ||
    path === 'conformance/evidence/local-adapter-evidence.json' ||
    path === 'conformance/evidence/local-adapter-recovery-report.json' ||
    path === 'conformance/evidence/remote-adapter-evidence.json' ||
    path === 'conformance/evidence/remote-adapter-recovery-report.json' ||
    path === 'conformance/evidence/codex-adapter-evidence.json' ||
    path === 'conformance/evidence/codex-adapter-recovery-report.json' ||
    path === 'conformance/evidence/semantic-kernel-recovery-report.json' ||
    path === 'conformance/evidence/control-plane-recovery-report.json' ||
    path === 'conformance/evidence/control-plane-doctor-report.json' ||
    path === 'conformance/evidence/control-plane-lifecycle-report.json' ||
    path === 'conformance/evidence/vault-mutation-recovery-report.json' ||
    path === 'conformance/evidence/reference-vault-recovery-report.json';
}
