import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {sha256} from './local-adapter-core.mjs';
import {localAdapterRecoveryTarget} from './local-adapter-evidence-validation.mjs';

export async function currentClaimBinding(packageRoot) {
  const bytes = await readFile(resolve(
    packageRoot,
    'contracts/local-intelligence-adapter/claim-manifest.json',
  ));
  const claim = JSON.parse(bytes.toString('utf8'));
  return {claim_manifest_sha256: sha256(bytes), evidence_digest: claim.rows[0].evidence_digest};
}

export function authoredRecoveryRecord(definition, scenario, claimBinding) {
  if (scenario.operation !== 'recover') return null;
  const target = localAdapterRecoveryTarget(scenario);
  if (target === null) throw new Error(`Recovery target is incomplete for ${scenario.scenario_id}`);
  const recoveryBinding = definition[2].recoveryBinding;
  return {
    ...target,
    claim_manifest_sha256: recoveryBinding === 'stale_claim'
      ? '0'.repeat(64)
      : claimBinding.claim_manifest_sha256,
    evidence_digest: recoveryBinding === 'stale_evidence'
      ? '0'.repeat(64)
      : claimBinding.evidence_digest,
  };
}
