import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export function virtualDescriptorIdentity(descriptor) {
  return {
    device: descriptor.device,
    inode: descriptor.inode,
    size: Buffer.byteLength(descriptor.bytes_utf8),
    content_sha256: createHash('sha256').update(descriptor.bytes_utf8).digest('hex'),
  };
}

function identityMismatchCode(expected, observed) {
  if (expected.device !== observed.device || expected.inode !== observed.inode) {
    return 'descriptor.identity_mismatch';
  }
  if (expected.size !== observed.size) return 'descriptor.size_mismatch';
  if (expected.content_sha256 !== observed.content_sha256) return 'descriptor.hash_mismatch';
  return null;
}

function invalid(code) {
  return {valid: false, code};
}

export function observeVirtualVaultProbe(probe) {
  const vault = probe.virtual_vault;
  if (vault.source_components.length !== vault.component_kinds.length ||
      vault.source_components.some((component) =>
        component === '.' || component === '..' || component.includes('/') ||
        component.includes('\\') || component.includes('\0'))) {
    return invalid('path.traversal_denied');
  }
  if (vault.component_kinds.includes('symlink')) return invalid('path.symlink_detected');
  if (vault.component_kinds.at(-1) !== 'file') return invalid('descriptor.probe_invalid');

  const firstIdentity = virtualDescriptorIdentity(vault.source_descriptor);
  const preconditionCode = identityMismatchCode(probe.authorized_precondition_identity, firstIdentity);
  if (preconditionCode !== null) return invalid(preconditionCode);

  const secondIdentity = virtualDescriptorIdentity(vault.second_observation);
  if (vault.second_observation.descriptor_id !== vault.source_descriptor.descriptor_id ||
      firstIdentity.device !== secondIdentity.device || firstIdentity.inode !== secondIdentity.inode) {
    return invalid('descriptor.identity_mismatch');
  }
  if (firstIdentity.size !== secondIdentity.size) return invalid('descriptor.size_mismatch');
  if (vault.path_descriptor_after_validation !== vault.source_descriptor.descriptor_id) {
    return invalid('descriptor.identity_drift');
  }
  if (vault.target_exists) return invalid('target.collision');
  if (!probe.journal_complete) return invalid('journal.incomplete');
  if (probe.receipt_echo !== 'complete' ||
      !isDeepStrictEqual(probe.receipt_precondition_identity, firstIdentity)) {
    return invalid('receipt.echo_mismatch');
  }

  const resultIdentity = virtualDescriptorIdentity(vault.result_descriptor);
  if (vault.result_descriptor.descriptor_id !== vault.source_descriptor.descriptor_id ||
      !isDeepStrictEqual(resultIdentity, probe.authorized_result_identity)) {
    return invalid('readback.identity_mismatch');
  }
  if (!isDeepStrictEqual(probe.receipt_result_identity, resultIdentity)) {
    return invalid('receipt.echo_mismatch');
  }
  if (vault.readback_descriptor === null) {
    return invalid(probe.console_output === 'success'
      ? 'receipt.readback_required'
      : 'readback.identity_mismatch');
  }
  const readbackIdentity = virtualDescriptorIdentity(vault.readback_descriptor);
  if (vault.readback_descriptor.descriptor_id !== vault.result_descriptor.descriptor_id ||
      !isDeepStrictEqual(readbackIdentity, resultIdentity)) {
    return invalid('readback.identity_mismatch');
  }
  return {valid: true, code: null};
}
