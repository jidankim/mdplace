import {isDeepStrictEqual} from 'node:util';

import {
  bindingMatches,
  descendValidation,
  isRecord,
  ordinalsAreContiguous,
  readJson,
  requirementCatalog,
} from './evidence-core.mjs';

export async function evidenceEnvelopeCodes(document, packageRoot, context, observeNested) {
  const codes = [];
  const orderedCollections = [document.input_digests, document.output_digests, document.receipts,
    document.artifact_digests];
  if (orderedCollections.some((entries) => !ordinalsAreContiguous(entries))) codes.push('evidence.ordinal_invalid');
  const digestBindings = [
    ...(Array.isArray(document.input_digests) ? document.input_digests : []),
    ...(Array.isArray(document.output_digests) ? document.output_digests : []),
    ...(Array.isArray(document.artifact_digests) ? document.artifact_digests : []),
    ...(document.invocation === undefined ? [] : [document.invocation]),
  ];
  const artifactPaths = digestBindings.map(({path}) => path);
  if (new Set(artifactPaths).size !== artifactPaths.length) codes.push('evidence.artifact_reference_duplicate');
  const receipts = Array.isArray(document.receipts) ? document.receipts : [];
  const receiptIds = receipts.filter(isRecord).map(({receipt_id: receiptId}) => receiptId);
  if (new Set(receiptIds).size !== receiptIds.length) codes.push('evidence.receipt_duplicate');
  const matches = await Promise.all(digestBindings.map(({path, sha256}) => bindingMatches(packageRoot, path, sha256)));
  if (matches.some((match) => !match)) codes.push('evidence.artifact_digest_mismatch');
  const requirements = await requirementCatalog(packageRoot);
  if (!requirements.valid) codes.push('schema.constraint');
  if (!requirements.ids.has(document.requirement_id)) codes.push('evidence.requirement_unresolved');
  const invocation = document.invocation === undefined ? null : await readJson(packageRoot, document.invocation.path);
  if (document.invocation !== undefined && invocation === null) {
    codes.push('evidence.invocation_binding_mismatch');
  } else if (invocation !== null) {
    const nestedContext = descendValidation(context, document.invocation);
    if (nestedContext === null) {
      codes.push('evidence.validation_cycle');
    } else {
      const observed = await observeNested({
        extension_id: document.extension_id,
        schema: 'contracts/schemas/validator-invocation.schema.json',
        document: invocation,
      }, packageRoot, nestedContext);
      if (observed.verdict !== 'pass') codes.push(...observed.codes);
    }
    const {path: invocationSubjectPath, ...invocationSubject} = invocation.subject ?? {};
    if (invocation.invocation_id !== document.invocation.invocation_id ||
        invocation.package_series !== document.package_series ||
        invocation.release_version !== document.release_version ||
        invocation.validator_id !== document.validator_id ||
        invocation.validator_version !== document.validator_version ||
        !invocation.requirement_ids?.includes(document.requirement_id) ||
        typeof invocationSubjectPath !== 'string' ||
        !isDeepStrictEqual(invocationSubject, document.subject) ||
        !isDeepStrictEqual(invocation.input_digests, document.input_digests) ||
        !isDeepStrictEqual(invocation.execution_context, document.execution_context)) {
      codes.push('evidence.invocation_binding_mismatch');
    }
  }
  return codes;
}
