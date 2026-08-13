import {verifyControlPlaneReceipt} from './control-plane-authentication.mjs';

const deniedCapabilities = [
  'vault_read', 'vault_write', 'shell', 'arbitrary_network', 'semantic_append', 'vault_mutation',
];

export function childWorkInvocationIsValid(invocation) {
  const binding = invocation?.work_binding;
  const output = invocation?.output;
  const receipt = invocation?.completion_receipt;
  if (binding === undefined || output === undefined || receipt === undefined ||
      deniedCapabilities.some((capability) => invocation?.capabilities?.[capability] !== false) ||
      output.schema_valid !== true || output.semantic_authority !== 'none' ||
      !Array.isArray(invocation.endpoint_allowlist) ||
      invocation.endpoint_allowlist.length > invocation?.budgets?.max_network_requests) return false;
  return receipt.authenticated === true && receipt.invocation_id === invocation.invocation_id &&
    receipt.signer_agent_id === binding.persistent_agent_id &&
    receipt.work_id === binding.work_id && receipt.work_version === binding.work_version &&
    receipt.lease_id === binding.lease_id && receipt.journal_head_sequence === binding.journal_head_sequence &&
    receipt.output_digest === output.output_digest && verifyControlPlaneReceipt('child_completion', [
      receipt.receipt_id, receipt.invocation_id, receipt.work_id, receipt.work_version,
      receipt.lease_id, receipt.journal_head_sequence, receipt.output_digest,
    ], receipt, binding.persistent_agent_id);
}
