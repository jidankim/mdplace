import {isDeepStrictEqual} from 'node:util';

import {
  bindingMatches,
  descendValidation,
  isRecord,
  readJson,
  requirementCatalog,
} from './evidence-core.mjs';

function mandatoryEvidenceCodes(document) {
  if (document.verdict !== 'pass' || !Array.isArray(document.evidence_bindings)) return [];
  const codes = [];
  if (document.applicability === 'unknown') codes.push('claim.mandatory_evidence_inconclusive');
  for (const binding of document.evidence_bindings.filter((entry) => isRecord(entry) &&
    entry.mandatory === true && entry.applicability !== 'not_applicable')) {
    if (binding.applicability === 'unknown') {
      codes.push('claim.mandatory_evidence_inconclusive');
      continue;
    }
    switch (binding.availability) {
      case 'missing':
        codes.push('claim.mandatory_evidence_missing');
        break;
      case 'stale':
        codes.push('claim.mandatory_evidence_stale');
        break;
      case 'skipped':
        codes.push('claim.mandatory_evidence_skipped');
        break;
      case 'unsupported':
        codes.push('claim.mandatory_evidence_unsupported');
        break;
      case 'present':
        if (binding.verdict === 'unsupported') codes.push('claim.mandatory_evidence_unsupported');
        if (binding.verdict === 'inconclusive') codes.push('claim.mandatory_evidence_inconclusive');
        if (binding.verdict === 'fail') codes.push('claim.mandatory_evidence_failed');
        break;
      default:
        codes.push('claim.mandatory_evidence_missing');
    }
  }
  return codes;
}

export async function claimManifestCodes(document, packageRoot, context, observeNested) {
  const codes = mandatoryEvidenceCodes(document);
  const requirementsDocument = await requirementCatalog(packageRoot);
  if (!requirementsDocument.valid) codes.push('schema.constraint');
  if (typeof document.requirement_id === 'string' && !requirementsDocument.ids.has(document.requirement_id)) {
    codes.push('claim.requirement_unresolved');
  }
  const verdictTable = await readJson(packageRoot, 'contracts/verdicts/validator-verdicts.json');
  const verdictRows = Array.isArray(verdictTable?.rows) ? verdictTable.rows : [];
  if (!Array.isArray(verdictTable?.rows)) codes.push('schema.instance_missing');
  const requirementEntries = Array.isArray(document.evidence_requirements) ? document.evidence_requirements : [];
  const bindingEntries = Array.isArray(document.evidence_bindings) ? document.evidence_bindings : [];
  if (requirementEntries.length !== document.evidence_requirements?.length ||
      bindingEntries.length !== document.evidence_bindings?.length ||
      requirementEntries.some((entry) => !isRecord(entry)) || bindingEntries.some((entry) => !isRecord(entry))) {
    return [...codes, 'schema.constraint'];
  }
  const requirements = new Map(requirementEntries.map((entry) => [entry.evidence_kind, entry]));
  const bindings = new Map(bindingEntries.map((entry) => [entry.evidence_kind, entry]));
  if (requirements.size !== document.evidence_requirements?.length ||
      bindings.size !== document.evidence_bindings?.length ||
      requirements.size !== bindings.size ||
      [...requirements].some(([kind, requirement]) => bindings.get(kind)?.mandatory !== requirement.mandatory)) {
    codes.push('claim.evidence_requirement_mismatch');
  }
  for (const binding of bindings.values()) {
    const verdictRow = verdictRows.find((row) => isRecord(row) && row.verdict === binding.verdict);
    if (!Array.isArray(verdictRow?.permitted_availability) ||
        !verdictRow.permitted_availability.includes(binding.availability)) {
      codes.push('claim.verdict_availability_mismatch');
    }
    const hasReference = typeof binding.evidence_ref === 'string' && typeof binding.evidence_digest === 'string';
    const hasPartialReference = typeof binding.evidence_ref === 'string' || typeof binding.evidence_digest === 'string';
    if (binding.availability === 'present') {
      if (!hasReference || !await bindingMatches(packageRoot, binding.evidence_ref, binding.evidence_digest)) {
        codes.push('claim.evidence_digest_mismatch');
        continue;
      }
      const envelope = await readJson(packageRoot, binding.evidence_ref);
      if (envelope === null) {
        codes.push('claim.evidence_binding_mismatch');
        continue;
      }
      const nestedContext = descendValidation(context, {path: binding.evidence_ref, sha256: binding.evidence_digest});
      if (nestedContext === null) {
        codes.push('evidence.validation_cycle');
      } else {
        const observed = await observeNested({
          extension_id: envelope.extension_id,
          schema: 'contracts/schemas/evidence-envelope.schema.json',
          document: envelope,
        }, packageRoot, nestedContext);
        if (observed.verdict !== 'pass') codes.push(...observed.codes);
      }
      if (envelope.requirement_id !== document.requirement_id ||
          !isDeepStrictEqual(envelope?.subject, {...document.subject, schema: envelope?.subject?.schema}) ||
          envelope.verdict !== binding.verdict) {
        codes.push('claim.evidence_binding_mismatch');
      }
    } else if (hasPartialReference) {
      codes.push('claim.noncurrent_evidence_bound');
    }
  }
  if ((document.applicability === 'not_applicable' &&
       bindingEntries.some(({applicability}) => applicability !== 'not_applicable')) ||
      (document.applicability === 'unknown' &&
       !bindingEntries.some(({applicability}) => applicability === 'unknown'))) {
    codes.push('claim.applicability_mismatch');
  }
  const mandatory = [...bindings.values()].filter((binding) =>
    binding.mandatory === true && binding.applicability !== 'not_applicable');
  const expectedVerdict = mandatory.some(({verdict}) => verdict === 'fail')
    ? 'fail'
    : mandatory.some(({availability, verdict}) => availability === 'unsupported' || verdict === 'unsupported')
      ? 'unsupported'
      : document.applicability === 'unknown' || mandatory.some(({availability, applicability, verdict}) =>
        applicability === 'unknown' || availability !== 'present' || verdict === 'inconclusive')
        ? 'inconclusive'
        : 'pass';
  if (document.verdict !== expectedVerdict && codes.length === 0) codes.push('claim.verdict_mismatch');
  return codes;
}
