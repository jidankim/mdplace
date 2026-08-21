import {readPackageFile} from './safe-path.mjs';
import {remoteSha256} from './remote-adapter-core.mjs';

export async function currentRemoteClaimBinding(packageRoot) {
  const read = await readPackageFile(packageRoot, 'contracts/remote-intelligence-adapter/claim-manifest.json');
  if (read.status !== 'present') {
    return {claim_manifest_sha256: '0'.repeat(64), evidence_digest: '0'.repeat(64)};
  }
  try {
    const claim = JSON.parse(read.content.toString('utf8'));
    return {
      claim_manifest_sha256: remoteSha256(read.content),
      evidence_digest: claim.rows?.[0]?.evidence_digest ?? '0'.repeat(64),
    };
  } catch {
    return {claim_manifest_sha256: '0'.repeat(64), evidence_digest: '0'.repeat(64)};
  }
}

export function authoredRemoteRecoveryRecord(fixtureId, scenario, binding) {
  const record = {
    fixture_id: fixtureId,
    scenario_id: scenario.scenario_id,
    crash_boundary: 'after_egress',
    claim_manifest_sha256: binding.claim_manifest_sha256,
    evidence_digest: binding.evidence_digest,
  };
  if (scenario.behavior === 'recover_stale_claim') record.claim_manifest_sha256 = '0'.repeat(64);
  if (scenario.behavior === 'recover_stale_evidence') record.evidence_digest = '0'.repeat(64);
  return record;
}

export async function remoteAdapterRecoveryRecord(fixtureId, packageRoot) {
  const read = await readPackageFile(packageRoot, 'conformance/evidence/remote-adapter-recovery-report.json');
  if (read.status !== 'present') return null;
  try {
    const report = JSON.parse(read.content.toString('utf8'));
    return report.cases?.find(({fixture_id: id}) => id === fixtureId) ?? null;
  } catch {
    return null;
  }
}
