import {createHmac, timingSafeEqual} from 'node:crypto';

const conformanceKeyId = 'signer-key:primary-001';
const conformanceSignerAgentId = 'agent:primary-001';
const conformanceKey = Buffer.from('mdplace-control-plane-v1-conformance-only-key-2026', 'utf8');
const vaultOwnerKeyId = 'signer-key:vault-owner-001';
const vaultOwnerPrincipalId = 'person:owner-001';
const vaultOwnerKey = Buffer.from('mdplace-vault-owner-v1-conformance-only-key-2026', 'utf8');
const signatureScheme = 'hmac-sha256';
const trustedSigner = Object.freeze({
  keyId: conformanceKeyId,
  signerId: conformanceSignerAgentId,
  key: conformanceKey,
});
const trustedVaultOwner = Object.freeze({
  keyId: vaultOwnerKeyId,
  signerId: vaultOwnerPrincipalId,
  key: vaultOwnerKey,
});

function signatureBytes(kind, fields, signer = trustedSigner) {
  return createHmac('sha256', signer.key)
    .update([kind, signatureScheme, signer.keyId, signer.signerId, ...fields]
      .map((value) => value ?? '').join('\0'))
    .digest();
}

export function signControlPlaneReceipt(kind, fields) {
  return {
    signature_scheme: signatureScheme,
    signing_key_id: conformanceKeyId,
    signer_agent_id: conformanceSignerAgentId,
    signature_digest: signatureBytes(kind, fields).toString('hex'),
    authenticated: true,
  };
}

export function verifyControlPlaneReceipt(kind, fields, receipt, expectedAgentId = conformanceSignerAgentId) {
  if (receipt?.signature_scheme !== signatureScheme || receipt.signing_key_id !== trustedSigner.keyId ||
      receipt.signer_agent_id !== trustedSigner.signerId || expectedAgentId !== trustedSigner.signerId ||
      receipt.authenticated !== true ||
      typeof receipt.signature_digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.signature_digest)) return false;
  const supplied = Buffer.from(receipt.signature_digest, 'hex');
  const expected = signatureBytes(kind, fields, trustedSigner);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function signVaultOwnerRecoveryApproval(fields) {
  return {
    signature_scheme: signatureScheme,
    signing_key_id: trustedVaultOwner.keyId,
    signer_principal_id: trustedVaultOwner.signerId,
    signature_digest: signatureBytes('vault_owner_recovery_approval', fields, trustedVaultOwner).toString('hex'),
    authenticated: true,
  };
}

export function verifyVaultOwnerRecoveryApproval(fields, receipt) {
  if (receipt?.signature_scheme !== signatureScheme || receipt.signing_key_id !== trustedVaultOwner.keyId ||
      receipt.signer_principal_id !== trustedVaultOwner.signerId ||
      receipt.principal_id !== trustedVaultOwner.signerId || receipt.authenticated !== true ||
      typeof receipt.signature_digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.signature_digest)) return false;
  const supplied = Buffer.from(receipt.signature_digest, 'hex');
  const expected = signatureBytes('vault_owner_recovery_approval', fields, trustedVaultOwner);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export const controlPlaneConformanceTrust = Object.freeze({
  keyId: conformanceKeyId,
  signerAgentId: conformanceSignerAgentId,
  signatureScheme,
});

export const controlPlaneVaultOwnerTrust = Object.freeze({
  keyId: vaultOwnerKeyId,
  signerPrincipalId: vaultOwnerPrincipalId,
  signatureScheme,
});
