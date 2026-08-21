import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'schema-instances', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

export async function checkSchemaInstances(packageRoot, conformance) {
  const codes = [];
  const bindings = [
    ['package-manifest.yaml', 'contracts/schemas/package-manifest.schema.json'],
    ['conformance/state-observations/draft/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['conformance/state-observations/candidate/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['conformance/state-observations/release-ready/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['conformance/state-observations/released/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['normative/requirements.json', 'contracts/schemas/requirements.schema.json'],
    ['contracts/transitions/package-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/evidence-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/validator-extensions.json', 'contracts/schemas/validator-extension-registry.schema.json'],
    ['contracts/verdicts/validator-verdicts.json', 'contracts/schemas/verdict-table.schema.json'],
    ['contracts/semantic-operation-kinds.json', 'contracts/schemas/semantic-operation-kind-registry.schema.json'],
    ['contracts/transitions/semantic-kernel-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/control-plane/work-journal.json', 'contracts/schemas/work-journal.schema.json'],
    ['contracts/control-plane/scheduler-state.json', 'contracts/schemas/scheduler-state.schema.json'],
    ['contracts/control-plane/agent-state.json', 'contracts/schemas/agent-state.schema.json'],
    ['contracts/control-plane/launchagent-supervision-profile.json', 'contracts/schemas/launchagent-supervision-profile.schema.json'],
    ['contracts/control-plane/control-command.json', 'contracts/schemas/control-channel-command.schema.json'],
    ['contracts/control-plane/child-work-invocation.json', 'contracts/schemas/child-work-invocation.schema.json'],
    ['contracts/control-plane/recovery-matrix.json', 'contracts/schemas/control-plane-recovery-matrix.schema.json'],
    ['contracts/transitions/work-queue-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/retry-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/cancellation-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/readiness-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/agent-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/control-channel-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/exclusive-writer-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/launchagent-supervision-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/processing-policy-rules.json', 'contracts/schemas/processing-policy-rules.schema.json'],
    ['contracts/processing-policy-trust-store.json', 'contracts/schemas/processing-policy-trust-store.schema.json'],
    ['contracts/transitions/processing-policy-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/source-profile-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/vault-mutation-gate/authorized-plan.json', 'contracts/schemas/authorized-mutation-plan.schema.json'],
    ['contracts/vault-mutation-gate/operation-receipt.json', 'contracts/schemas/operation-receipt.schema.json'],
    ['contracts/vault-mutation-gate/mutation-journal.json', 'contracts/schemas/mutation-journal.schema.json'],
    ['contracts/vault-mutation-gate/crash-boundary-matrix.json', 'contracts/schemas/vault-mutation-crash-matrix.schema.json'],
    ['contracts/transitions/vault-mutation-gate-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/reference-vault-generation-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/reference-vault-redistribution-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/reference-vault/scale-manifest.json', 'contracts/schemas/scale-manifest.schema.json'],
    ['contracts/reference-vault/generator-interface.json', 'contracts/schemas/reference-vault-generator.schema.json'],
    ['contracts/reference-vault/corpus-manifest.json', 'contracts/schemas/corpus-manifest.schema.json'],
    ['conformance/manifest.yaml', 'contracts/schemas/conformance-manifest.schema.json'],
    ['traceability.yaml', 'contracts/schemas/traceability.schema.json'],
    ['claims-and-evidence.yaml', 'contracts/schemas/claims-and-evidence.schema.json'],
    ['conformance/evidence/invocations/validator-evidence-reference.json', 'contracts/schemas/validator-invocation.schema.json'],
    ['conformance/evidence/envelopes/validator-evidence-reference.json', 'contracts/schemas/evidence-envelope.schema.json'],
    ['conformance/evidence/evidence-recovery-report.json', 'contracts/schemas/evidence-recovery-report.schema.json'],
    ['conformance/evidence/semantic-kernel-recovery-report.json', 'contracts/schemas/semantic-kernel-recovery-report.schema.json'],
    ['conformance/evidence/control-plane-recovery-report.json', 'contracts/schemas/control-plane-recovery-report.schema.json'],
    ['conformance/evidence/control-plane-doctor-report.json', 'contracts/schemas/control-plane-doctor-report.schema.json'],
    ['conformance/evidence/control-plane-lifecycle-report.json', 'contracts/schemas/control-plane-lifecycle-report.schema.json'],
    ['conformance/evidence/core-processing-policy-recovery-report.json', 'contracts/schemas/core-processing-policy-recovery-report.schema.json'],
    ['conformance/evidence/vault-mutation-recovery-report.json', 'contracts/schemas/vault-mutation-recovery-report.schema.json'],
    ['conformance/evidence/reference-vault-recovery-report.json', 'contracts/schemas/reference-vault-recovery-report.schema.json'],
    ['contracts/intelligence-adapter/approved-context.json', 'contracts/schemas/intelligence-adapter-approved-context.schema.json'],
    ['contracts/intelligence-adapter/protocol-rules.json', 'contracts/schemas/intelligence-adapter-protocol-rules.schema.json'],
    ['contracts/transitions/intelligence-adapter-execution-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/intelligence-adapter-denial-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/intelligence-adapter-timeout-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/intelligence-adapter-retry-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/intelligence-adapter-fallback-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/intelligence-adapter-isolation-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/intelligence-adapter-recovery-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['conformance/evidence/intelligence-adapter-evidence.json', 'contracts/schemas/intelligence-adapter-evidence.schema.json'],
    ['conformance/evidence/intelligence-adapter-recovery-report.json', 'contracts/schemas/intelligence-adapter-recovery-report.schema.json'],
    ['contracts/local-intelligence-adapter/profile.json', 'contracts/schemas/local-intelligence-adapter-profile.schema.json'],
    ['contracts/local-intelligence-adapter/capability-evidence.json', 'contracts/schemas/local-adapter-capability-evidence.schema.json'],
    ['contracts/local-intelligence-adapter/isolation-evidence.json', 'contracts/schemas/local-adapter-isolation-evidence.schema.json'],
    ['contracts/local-intelligence-adapter/fixture-manifest.json', 'contracts/schemas/local-adapter-fixture-manifest.schema.json'],
    ['contracts/local-intelligence-adapter/claim-manifest.json', 'contracts/schemas/local-adapter-claim-manifest.schema.json'],
    ['contracts/verdicts/local-adapter-verdicts.json', 'contracts/schemas/local-adapter-verdict-table.schema.json'],
    ['contracts/transitions/local-adapter-capability-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/local-adapter-isolation-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/local-adapter-verdict-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/local-adapter-failure-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/local-adapter-recovery-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['conformance/evidence/local-adapter-evidence.json', 'contracts/schemas/local-adapter-evidence.schema.json'],
    ['conformance/evidence/local-adapter-recovery-report.json', 'contracts/schemas/local-adapter-recovery-report.schema.json'],
    ['conformance/evidence/invocations/local-adapter-profile.json', 'contracts/schemas/validator-invocation.schema.json'],
    ['conformance/evidence/envelopes/local-adapter-profile.json', 'contracts/schemas/evidence-envelope.schema.json'],
    ['contracts/remote-intelligence-adapter/profile.json', 'contracts/schemas/remote-intelligence-adapter-profile.schema.json'],
    ['contracts/remote-intelligence-adapter/credential-boundary-evidence.json', 'contracts/schemas/remote-adapter-credential-boundary-evidence.schema.json'],
    ['conformance/inputs/remote-adapter-provider-disclosure.json', 'contracts/schemas/remote-adapter-provider-disclosure.schema.json'],
    ['contracts/remote-intelligence-adapter/retention-evidence.json', 'contracts/schemas/remote-adapter-retention-evidence.schema.json'],
    ['contracts/remote-intelligence-adapter/fixture-manifest.json', 'contracts/schemas/remote-adapter-fixture-manifest.schema.json'],
    ['contracts/remote-intelligence-adapter/claim-manifest.json', 'contracts/schemas/remote-adapter-claim-manifest.schema.json'],
    ['contracts/verdicts/remote-adapter-verdicts.json', 'contracts/schemas/remote-adapter-verdict-table.schema.json'],
    ['contracts/transitions/remote-adapter-permitted-egress-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/remote-adapter-denial-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/remote-adapter-failure-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/remote-adapter-retry-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/remote-adapter-fallback-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/remote-adapter-recovery-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/remote-adapter-verdict-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['conformance/evidence/remote-adapter-evidence.json', 'contracts/schemas/remote-adapter-evidence.schema.json'],
    ['conformance/evidence/remote-adapter-recovery-report.json', 'contracts/schemas/remote-adapter-recovery-report.schema.json'],
    ['conformance/evidence/invocations/remote-adapter-profile.json', 'contracts/schemas/validator-invocation.schema.json'],
    ['conformance/evidence/envelopes/remote-adapter-profile.json', 'contracts/schemas/evidence-envelope.schema.json'],
  ];
  const fixtureEntries = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  for (const entry of fixtureEntries) {
    if (typeof entry?.path === 'string') {
      bindings.push([`conformance/${entry.path}`, 'contracts/schemas/conformance-fixture.schema.json']);
    }
  }
  const claimsRead = await readPackageFile(packageRoot, 'claims-and-evidence.yaml');
  if (claimsRead.status === 'present') {
    try {
      const claims = JSON.parse(claimsRead.content.toString('utf8'));
      for (const entry of claims.claims ?? []) {
        if (typeof entry.manifest_ref === 'string') {
          bindings.push([entry.manifest_ref, 'contracts/schemas/claim-manifest.schema.json']);
        }
      }
    } catch {
      codes.push('boundary.invalid_json');
    }
  }
  for (const [instancePath, schemaPath] of bindings) {
    const [instanceRead, schemaRead] = await Promise.all([
      readPackageFile(packageRoot, instancePath),
      readPackageFile(packageRoot, schemaPath),
    ]);
    if (schemaRead.status !== 'present') {
      codes.push('schema.required_artifact');
      continue;
    }
    if (instanceRead.status !== 'present') {
      codes.push(instanceRead.status === 'too_large' ? 'schema.resource_limit' : 'schema.instance_missing');
      continue;
    }
    let value;
    try {
      value = JSON.parse(instanceRead.content.toString('utf8'));
    } catch {
      codes.push('boundary.invalid_json');
      continue;
    }
    const errors = await validateAgainstSchemaPath(packageRoot, schemaPath, value);
    const code = schemaErrorCode(errors);
    if (code !== null) codes.push(code);
  }
  return result(codes);
}
