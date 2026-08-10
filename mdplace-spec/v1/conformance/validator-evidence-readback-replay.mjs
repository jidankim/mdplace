import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {digest, extensionId, validatorVersion, committedPackageRoot} from './validator-evidence-support.mjs';

test('readback requires a digest-bound recursively validated Recovery Report', async () => {
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'readback',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: null,
    fresh_claim: null,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_report_required'));
});

test('transition freshness fields cannot contradict their bound evidence', async () => {
  const claimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'readback',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: null,
    fresh_claim: {claim_id: 'CLAIM-RECOVERY-001', path: claimPath, sha256: digest(claimContent)},
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_inconsistent'));
});

test('fresh-evidence supply rejects a replayed Claim Manifest chain', async () => {
  const claimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const claim = {claim_id: 'CLAIM-RECOVERY-001', path: claimPath, sha256: digest(claimContent)};
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'supply_fresh_evidence',
    actor_authority: {roles: ['evidence_supplier'], quorum: 1, distinct_actors: false, delegation: 'permitted'},
    fresh_evidence_supplied: true,
    recorded_claim: claim,
    recovery_report: null,
    fresh_claim: claim,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});

test('readback accepts a digest-bound recursively validated Recovery Report', async () => {
  const reportPath = 'conformance/evidence/evidence-recovery-report.json';
  const reportContent = await readFile(new URL(`../${reportPath}`, import.meta.url));
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'readback',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: {
      report_id: 'evidence-recovery:pass-readback',
      path: reportPath,
      sha256: digest(reportContent),
    },
    fresh_claim: null,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'verdict_recorded');
});
