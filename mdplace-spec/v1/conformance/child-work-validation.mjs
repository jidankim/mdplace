import {createHash} from 'node:crypto';

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
  const signature = createHash('sha256').update([
    receipt.receipt_id, receipt.invocation_id, receipt.work_id, receipt.work_version,
    receipt.lease_id, receipt.journal_head_sequence, receipt.output_digest, receipt.signer_agent_id,
  ].join('\0')).digest('hex');
  return receipt.authenticated === true && receipt.invocation_id === invocation.invocation_id &&
    receipt.work_id === binding.work_id && receipt.work_version === binding.work_version &&
    receipt.lease_id === binding.lease_id && receipt.journal_head_sequence === binding.journal_head_sequence &&
    receipt.output_digest === output.output_digest && receipt.signature_digest === signature;
}
