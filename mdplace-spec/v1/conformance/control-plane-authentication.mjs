import {createHmac, timingSafeEqual} from 'node:crypto';

const conformanceKeyId = 'signer-key:primary-001';
const conformanceSignerAgentId = 'agent:primary-001';
const conformanceKey = Buffer.from('mdplace-control-plane-v1-conformance-only-key-2026', 'utf8');

function signatureBytes(kind, fields, key = conformanceKey) {
  return createHmac('sha256', key)
    .update([kind, ...fields].map((value) => value ?? '').join('\0'))
    .digest();
}

export function signControlPlaneReceipt(kind, fields) {
  return {
    signature_scheme: 'hmac-sha256',
    signing_key_id: conformanceKeyId,
    signer_agent_id: conformanceSignerAgentId,
    signature_digest: signatureBytes(kind, fields).toString('hex'),
    authenticated: true,
  };
}

export function verifyControlPlaneReceipt(kind, fields, receipt, expectedAgentId = conformanceSignerAgentId) {
  if (receipt?.signature_scheme !== 'hmac-sha256' || receipt.signing_key_id !== conformanceKeyId ||
      receipt.signer_agent_id !== expectedAgentId || receipt.authenticated !== true ||
      typeof receipt.signature_digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.signature_digest)) return false;
  const supplied = Buffer.from(receipt.signature_digest, 'hex');
  const expected = signatureBytes(kind, fields);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export const controlPlaneConformanceTrust = Object.freeze({
  keyId: conformanceKeyId,
  signerAgentId: conformanceSignerAgentId,
  signatureScheme: 'hmac-sha256',
});
