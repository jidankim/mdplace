import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

const maximumEvidenceDepth = 32;

function observation({verdict, codes = [], output, operations, terminalState, illegalTransition = false}) {
  return {
    verdict,
    codes: [...new Set(codes)],
    outputs: [output],
    operations,
    receipts: ['EvidenceValidationReceipt'],
    filesystem_effects: ['none'],
    terminal_state: terminalState,
    illegal_transition: illegalTransition,
  };
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validationContext(context) {
  return context ?? {depth: 0, bindings: new Set()};
}

function descendValidation(context, binding) {
  const current = validationContext(context);
  const key = `${binding?.path}\0${binding?.sha256}`;
  if (current.depth >= maximumEvidenceDepth || current.bindings.has(key)) return null;
  return {depth: current.depth + 1, bindings: new Set([...current.bindings, key])};
}

function bindingCodes(document, manifest, extension) {
  const codes = [];
  if (document.package_series !== manifest.package_series || document.release_version !== manifest.release_version) {
    codes.push('evidence.specification_version_mismatch');
  }
  if (document.validator_id !== extension.validator_id ||
      document.validator_version !== manifest.validator_version ||
      document.validator_version !== extension.validator_version) {
    codes.push('evidence.validator_version_mismatch');
  }
  return codes;
}

function evidenceName(schemaPath) {
  return schemaPath.split('/').at(-1).replace('.schema.json', '').replaceAll('-', ' ');
}

function evidenceOperations() {
  return [
    'resolve validator extension',
    'validate extension document',
    'verify specification and validator bindings',
  ];
}

function claimCodes(document) {
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

function ordinalsAreContiguous(entries) {
  return Array.isArray(entries) && entries.every(({ordinal}, index) => ordinal === index);
}

async function bindingMatches(packageRoot, path, expectedDigest) {
  const read = await readPackageFile(packageRoot, path);
  return read.status === 'present' && createHash('sha256').update(read.content).digest('hex') === expectedDigest;
}

async function requirementCatalog(packageRoot) {
  const document = await readJson(packageRoot, 'normative/requirements.json');
  const rows = Array.isArray(document?.requirements) ? document.requirements : [];
  const valid = Array.isArray(document?.requirements) && rows.every(isRecord);
  return {ids: new Set(rows.filter(isRecord).map(({id}) => id)), valid};
}

async function evidenceEnvelopeCodes(document, packageRoot, context) {
  const codes = [];
  const orderedCollections = [document.input_digests, document.output_digests, document.receipts, document.artifact_digests];
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
  if (!requirements.ids.has(document.requirement_id)) {
    codes.push('evidence.requirement_unresolved');
  }
  const invocation = document.invocation === undefined ? null : await readJson(packageRoot, document.invocation.path);
  if (document.invocation !== undefined && invocation === null) {
    codes.push('evidence.invocation_binding_mismatch');
  } else if (invocation !== null) {
    const nestedContext = descendValidation(context, document.invocation);
    if (nestedContext === null) {
      codes.push('evidence.validation_cycle');
    } else {
      const invocationObservation = await observeEvidenceExtension({
        extension_id: document.extension_id,
        schema: 'contracts/schemas/validator-invocation.schema.json',
        document: invocation,
      }, packageRoot, nestedContext);
      if (invocationObservation.verdict !== 'pass') codes.push(...invocationObservation.codes);
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

async function claimManifestCodes(document, packageRoot, context) {
  const codes = claimCodes(document);
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
      const nestedContext = descendValidation(context, {
        path: binding.evidence_ref,
        sha256: binding.evidence_digest,
      });
      if (nestedContext === null) {
        codes.push('evidence.validation_cycle');
      } else {
        const envelopeObservation = await observeEvidenceExtension({
          extension_id: envelope.extension_id,
          schema: 'contracts/schemas/evidence-envelope.schema.json',
          document: envelope,
        }, packageRoot, nestedContext);
        if (envelopeObservation.verdict !== 'pass') codes.push(...envelopeObservation.codes);
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

async function validateClaimBinding(binding, expectedClaimId, packageRoot, context, options = {}) {
  const codes = [];
  if (!isRecord(binding) || typeof binding.path !== 'string' || typeof binding.sha256 !== 'string') {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches: false};
  }
  const read = await readPackageFile(packageRoot, binding.path);
  if (read.status !== 'present') {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches: false};
  }
  const actualDigest = createHash('sha256').update(read.content).digest('hex');
  const digestMatches = actualDigest === binding.sha256;
  if (!digestMatches && options.allowDigestMismatch !== true) {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches};
  }
  let document;
  try {
    document = JSON.parse(read.content.toString('utf8'));
  } catch {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches};
  }
  if (document === null || document.claim_id !== expectedClaimId || binding.claim_id !== expectedClaimId) {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches};
  }
  let claimSchemaCode;
  try {
    claimSchemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/claim-manifest.schema.json',
      document,
    ));
  } catch {
    claimSchemaCode = 'schema.instance_missing';
  }
  if (claimSchemaCode !== null) {
    return {codes: [claimSchemaCode], document: null, digestMatches};
  }
  const nestedContext = descendValidation(context, binding);
  if (nestedContext === null) return {codes: ['evidence.validation_cycle'], document: null, digestMatches};
  const observed = await observeEvidenceExtension({
    extension_id: 'mdplace.validator-extension/evidence/v1',
    schema: 'contracts/schemas/claim-manifest.schema.json',
    document,
  }, packageRoot, nestedContext);
  if (observed.verdict !== 'pass') codes.push(...observed.codes);
  return {
    codes,
    document: codes.length === 0 || options.retainSemanticFailure === true ? document : null,
    digestMatches,
  };
}

function addExpectedBinding(expected, path, sha256) {
  if (typeof path !== 'string' || typeof sha256 !== 'string') return;
  const prior = expected.get(path);
  if (prior !== undefined && prior !== sha256) expected.set(path, null);
  else expected.set(path, sha256);
}

function hasFreshMandatoryEvidence(claim) {
  const bindings = Array.isArray(claim?.evidence_bindings) ? claim.evidence_bindings : [];
  const mandatoryBindings = bindings.filter((binding) => isRecord(binding) &&
    binding.mandatory === true && binding.applicability !== 'not_applicable');
  return mandatoryBindings.length > 0 && mandatoryBindings.every((binding) =>
    binding.availability === 'present' && typeof binding.evidence_ref === 'string' &&
    typeof binding.evidence_digest === 'string');
}

async function addTransitiveBindings(expected, binding, schemaPath, packageRoot, context = {depth: 0, seen: new Set()}) {
  const path = binding?.path ?? binding?.evidence_ref;
  const sha256 = binding?.sha256 ?? binding?.evidence_digest;
  addExpectedBinding(expected, path, sha256);
  if (typeof path !== 'string' || typeof sha256 !== 'string' || context.depth >= maximumEvidenceDepth) return;
  const key = `${path}\0${sha256}`;
  if (context.seen.has(key)) return;
  const document = await readJson(packageRoot, path);
  if (!isRecord(document)) return;
  const nestedContext = {depth: context.depth + 1, seen: new Set([...context.seen, key])};
  const schemaName = schemaPath?.split('/').at(-1);
  if (schemaName === 'claim-manifest.schema.json') {
    const evidenceBindings = Array.isArray(document.evidence_bindings) ? document.evidence_bindings : [];
    for (const evidenceBinding of evidenceBindings.filter(isRecord)) {
      await addTransitiveBindings(expected, evidenceBinding, 'contracts/schemas/evidence-envelope.schema.json',
        packageRoot, nestedContext);
    }
    return;
  }
  if (schemaName === 'evidence-envelope.schema.json') {
    for (const digestBinding of [
      ...(Array.isArray(document.input_digests) ? document.input_digests : []),
      ...(Array.isArray(document.output_digests) ? document.output_digests : []),
      ...(Array.isArray(document.artifact_digests) ? document.artifact_digests : []),
    ].filter(isRecord)) {
      addExpectedBinding(expected, digestBinding.path, digestBinding.sha256);
    }
    await addTransitiveBindings(expected, document.invocation, 'contracts/schemas/validator-invocation.schema.json',
      packageRoot, nestedContext);
    return;
  }
  if (schemaName === 'validator-invocation.schema.json') {
    const inputDigests = Array.isArray(document.input_digests) ? document.input_digests : [];
    for (const digestBinding of inputDigests.filter(isRecord)) {
      addExpectedBinding(expected, digestBinding.path, digestBinding.sha256);
    }
    await addTransitiveBindings(expected, document.subject, document.subject?.schema, packageRoot, nestedContext);
    return;
  }
  if (schemaName === 'evidence-recovery-report.schema.json') {
    await addTransitiveBindings(expected, document.claim, 'contracts/schemas/claim-manifest.schema.json',
      packageRoot, nestedContext);
    if (document.recorded_claim !== null) {
      await addTransitiveBindings(expected, document.recorded_claim, 'contracts/schemas/claim-manifest.schema.json',
        packageRoot, nestedContext);
    }
    for (const recomputed of (Array.isArray(document.recomputed_bindings) ? document.recomputed_bindings : [])
      .filter(isRecord)) {
      addExpectedBinding(expected, recomputed.path, recomputed.expected_sha256);
    }
    return;
  }
  if (schemaName === 'evidence-transition-attempt.schema.json') {
    if (document.recorded_claim !== null) {
      await addTransitiveBindings(expected, document.recorded_claim, 'contracts/schemas/claim-manifest.schema.json',
        packageRoot, nestedContext);
    }
    if (document.fresh_claim !== null) {
      await addTransitiveBindings(expected, document.fresh_claim, 'contracts/schemas/claim-manifest.schema.json',
        packageRoot, nestedContext);
    }
    if (document.recovery_report !== null) {
      await addTransitiveBindings(expected, document.recovery_report,
        'contracts/schemas/evidence-recovery-report.schema.json', packageRoot, nestedContext);
    }
  }
}

async function expectedRecoveryBindings(claimBinding, packageRoot, recordedClaimBinding = null) {
  const expected = new Map();
  await addTransitiveBindings(expected, claimBinding, 'contracts/schemas/claim-manifest.schema.json', packageRoot);
  if (recordedClaimBinding !== null) {
    await addTransitiveBindings(expected, recordedClaimBinding, 'contracts/schemas/claim-manifest.schema.json', packageRoot);
  }
  return expected;
}

async function recoveryCodes(document, packageRoot, context) {
  const codes = [];
  let stale = false;
  const claimResult = await validateClaimBinding(document.claim, document.claim_id, packageRoot, context, {
    allowDigestMismatch: true,
    retainSemanticFailure: true,
  });
  if (claimResult.document === null) codes.push(...claimResult.codes);
  if (claimResult.document !== null && claimResult.digestMatches === false) stale = true;
  if (document.fresh_evidence_supplied === false && !stale && claimResult.document !== null &&
      claimResult.document.claim_id === document.claim_id &&
      claimResult.document.verdict !== document.prior_verdict) {
    codes.push('evidence.recovery_claim_verdict_mismatch');
  }
  let recordedClaimResult = null;
  if (document.fresh_evidence_supplied === true) {
    if (isRecord(document.recorded_claim)) {
      recordedClaimResult = await validateClaimBinding(
        document.recorded_claim,
        document.claim_id,
        packageRoot,
        context,
        {retainSemanticFailure: true},
      );
    }
    if (recordedClaimResult !== null && recordedClaimResult.document !== null &&
        recordedClaimResult.document.verdict !== document.prior_verdict) {
      codes.push('evidence.recovery_claim_verdict_mismatch');
    }
    if (claimResult.digestMatches !== true || claimResult.codes.length > 0 ||
        !hasFreshMandatoryEvidence(claimResult.document) ||
        claimResult.document?.verdict !== document.effective_verdict ||
        recordedClaimResult?.document === null || recordedClaimResult === null) {
      codes.push('evidence.fresh_evidence_required');
    } else if (!await freshClaimIsNew(recordedClaimResult.document, claimResult.document, packageRoot)) {
      codes.push('evidence.fresh_evidence_replayed');
    }
  } else if (isRecord(document.recorded_claim)) {
    codes.push('evidence.fresh_evidence_inconsistent');
  }
  const expectedBindings = await expectedRecoveryBindings(
    document.claim,
    packageRoot,
    recordedClaimResult?.document === null ? null : document.recorded_claim,
  );
  const recomputedBindings = Array.isArray(document.recomputed_bindings) ? document.recomputed_bindings : [];
  const suppliedBindings = new Map(recomputedBindings.map((binding) => [binding?.path, binding?.expected_sha256]));
  if (suppliedBindings.size !== recomputedBindings.length || expectedBindings.size !== suppliedBindings.size ||
      [...expectedBindings].some(([path, sha256]) => sha256 === null || suppliedBindings.get(path) !== sha256)) {
    codes.push('evidence.recovery_binding_set_mismatch');
  }
  for (const binding of recomputedBindings) {
    if (!isRecord(binding)) {
      codes.push('evidence.recovery_binding_mismatch');
      stale = true;
      continue;
    }
    const read = await readPackageFile(packageRoot, binding.path);
    const actual = read.status === 'present' ? createHash('sha256').update(read.content).digest('hex') : null;
    const actualMatch = actual !== null && actual === binding.expected_sha256;
    if (!actualMatch) stale = true;
    if (actual !== binding.observed_sha256 || binding.matches !== actualMatch) {
      codes.push('evidence.recovery_binding_mismatch');
    }
  }
  if (claimResult.codes.length > 0 && !stale) codes.push(...claimResult.codes);
  if (document.fresh_evidence_supplied === false) {
    const expectedVerdict = stale && document.prior_verdict === 'pass'
      ? 'inconclusive'
      : document.prior_verdict;
    if (document.effective_verdict !== expectedVerdict &&
        !(stale && document.prior_verdict === 'pass' && document.effective_verdict === 'pass')) {
      codes.push('evidence.recovery_verdict_upgrade');
    }
  }
  if (stale && document.fresh_evidence_supplied === false) {
    if (document.effective_verdict === 'pass') codes.push('evidence.recovery_stale_pass');
    if (document.terminal_state !== 'evidence_stale') codes.push('evidence.recovery_state_invalid');
  } else if (!stale && document.fresh_evidence_supplied === false && document.terminal_state !== 'verdict_recorded') {
    codes.push('evidence.recovery_state_invalid');
  }
  if (document.fresh_evidence_supplied === true && document.terminal_state !== 'awaiting_evidence') {
    codes.push('evidence.recovery_state_invalid');
  }
  return codes;
}

async function invocationCodes(document, packageRoot, extension, context) {
  const codes = [];
  if (!ordinalsAreContiguous(document.input_digests)) codes.push('evidence.ordinal_invalid');
  const inputDigests = Array.isArray(document.input_digests) ? document.input_digests : [];
  const inputPaths = inputDigests.filter(isRecord).map(({path}) => path);
  const inputLabels = inputDigests.filter(isRecord).map(({label}) => label);
  if (new Set(inputPaths).size !== inputPaths.length || new Set(inputLabels).size !== inputLabels.length) {
    codes.push('evidence.invocation_input_duplicate');
  }
  const matches = await Promise.all(inputDigests.filter(isRecord)
    .map(({path, sha256}) => bindingMatches(packageRoot, path, sha256)));
  if (matches.some((match) => !match)) codes.push('evidence.artifact_digest_mismatch');
  const requirements = await requirementCatalog(packageRoot);
  if (!requirements.valid) codes.push('schema.constraint');
  if ((document.requirement_ids ?? []).some((requirementId) => !requirements.ids.has(requirementId))) {
    codes.push('evidence.requirement_unresolved');
  }
  if (!extension.subject_schemas.includes(document.subject?.schema)) {
    codes.push('validator.extension_schema_denied');
    return codes;
  }
  if (!await bindingMatches(packageRoot, document.subject?.path, document.subject?.sha256)) {
    codes.push('evidence.subject_digest_mismatch');
    return codes;
  }
  const subjectDocument = await readJson(packageRoot, document.subject.path);
  if (subjectDocument === null) {
    codes.push('evidence.subject_binding_mismatch');
    return codes;
  }
  try {
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      document.subject.schema,
      subjectDocument,
    ));
    if (schemaCode !== null) codes.push(schemaCode);
  } catch {
    codes.push('schema.instance_missing');
  }
  if (codes.length === 0) {
    const nestedContext = descendValidation(context, document.subject);
    if (nestedContext === null) {
      codes.push('evidence.validation_cycle');
    } else {
      const observed = await observeEvidenceExtension({
        extension_id: document.extension_id,
        schema: document.subject.schema,
        document: subjectDocument,
      }, packageRoot, nestedContext);
      if (observed.verdict !== 'pass') codes.push(...observed.codes);
    }
  }
  return codes;
}

async function validateRecoveryReportBinding(binding, packageRoot, context) {
  if (!isRecord(binding) || typeof binding.report_id !== 'string' ||
      typeof binding.path !== 'string' || typeof binding.sha256 !== 'string' ||
      !await bindingMatches(packageRoot, binding.path, binding.sha256)) {
    return {codes: ['evidence.recovery_report_binding_mismatch'], document: null};
  }
  const document = await readJson(packageRoot, binding.path);
  if (document === null || document.report_id !== binding.report_id) {
    return {codes: ['evidence.recovery_report_binding_mismatch'], document: null};
  }
  const nestedContext = descendValidation(context, binding);
  if (nestedContext === null) return {codes: ['evidence.validation_cycle'], document: null};
  const observed = await observeEvidenceExtension({
    extension_id: 'mdplace.validator-extension/evidence/v1',
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document,
  }, packageRoot, nestedContext);
  return {codes: observed.verdict === 'pass' ? [] : observed.codes, document, observed};
}

function evidenceProof(envelope, invocation) {
  const collections = [
    envelope?.input_digests,
    envelope?.output_digests,
    envelope?.artifact_digests,
  ];
  if (!isRecord(envelope) || !isRecord(invocation) ||
      collections.some((entries) => !Array.isArray(entries) || entries.some((entry) => !isRecord(entry)))) {
    return null;
  }
  return {
    inputs: envelope.input_digests.map(({ordinal, sha256}) => ({ordinal, sha256})),
    outputs: envelope.output_digests.map(({ordinal, sha256}) => ({ordinal, sha256})),
    artifacts: envelope.artifact_digests.map(({ordinal, sha256}) => ({ordinal, sha256})),
  };
}

async function mandatoryEvidenceObservations(claim, packageRoot) {
  const observations = new Map();
  const bindings = Array.isArray(claim?.evidence_bindings) ? claim.evidence_bindings : [];
  for (const binding of bindings.filter((entry) => isRecord(entry) && entry.mandatory === true &&
    entry.applicability !== 'not_applicable')) {
    const envelope = binding.availability === 'present'
      ? await readJson(packageRoot, binding.evidence_ref)
      : null;
    const invocation = typeof envelope?.invocation?.path === 'string'
      ? await readJson(packageRoot, envelope.invocation.path)
      : null;
    observations.set(binding.evidence_kind, {
      availability: binding.availability,
      envelopeDigest: binding.evidence_digest,
      invocationDigest: envelope?.invocation?.sha256,
      invocationId: invocation?.invocation_id,
      proof: evidenceProof(envelope, invocation),
    });
  }
  return observations;
}

async function freshClaimIsNew(recordedClaim, freshClaim, packageRoot) {
  if (recordedClaim.claim_id !== freshClaim.claim_id || recordedClaim.profile !== freshClaim.profile ||
      recordedClaim.requirement_id !== freshClaim.requirement_id ||
      !isDeepStrictEqual(recordedClaim.subject, freshClaim.subject)) return false;
  const [recordedEvidence, freshEvidence] = await Promise.all([
    mandatoryEvidenceObservations(recordedClaim, packageRoot),
    mandatoryEvidenceObservations(freshClaim, packageRoot),
  ]);
  return freshEvidence.size > 0 && freshEvidence.size === recordedEvidence.size &&
    [...freshEvidence].every(([kind, fresh]) => {
      const recorded = recordedEvidence.get(kind);
      if (recorded === undefined || fresh.availability !== 'present' || fresh.proof === null) return false;
      if (recorded.availability !== 'present') return true;
      return fresh.envelopeDigest !== recorded.envelopeDigest &&
        (recorded.invocationDigest === undefined || fresh.invocationDigest !== recorded.invocationDigest) &&
        (recorded.invocationId === undefined || fresh.invocationId !== recorded.invocationId) &&
        (recorded.proof === null || !isDeepStrictEqual(fresh.proof, recorded.proof));
    });
}

async function observeTransitionAttempt(document, packageRoot, operations, context) {
  const table = await readJson(packageRoot, document.table_ref);
  const rows = Array.isArray(table?.transitions) ? table.transitions : [];
  const row = rows.find((candidate) => isRecord(candidate) &&
    candidate.from_state === document.from_state && candidate.command_or_event === document.command);
  if (row === undefined) {
    return observation({
      verdict: 'fail',
      codes: ['evidence.transition_unresolved'],
      output: 'evidence transition rejected',
      operations,
      terminalState: 'rejected',
    });
  }
  if (row.actor_authority !== undefined && !isDeepStrictEqual(row.actor_authority, document.actor_authority)) {
    return observation({
      verdict: 'fail',
      codes: ['evidence.authority_denied'],
      output: 'evidence transition denied',
      operations,
      terminalState: document.from_state,
      illegalTransition: true,
    });
  }
  if (row.allowed !== true) {
    return observation({
      verdict: 'fail',
      codes: ['evidence.transition_denied'],
      output: 'evidence transition denied',
      operations,
      terminalState: row.terminal_state,
      illegalTransition: true,
    });
  }
  const freshnessCommand = ['record_verdict', 'supply_fresh_evidence'].includes(document.command);
  if (freshnessCommand &&
      (document.fresh_evidence_supplied !== true || !isRecord(document.fresh_claim))) {
    return observation({
      verdict: 'fail',
      codes: ['evidence.fresh_evidence_required'],
      output: 'evidence transition denied',
      operations,
      terminalState: document.from_state,
      illegalTransition: true,
    });
  }
  if ((!freshnessCommand &&
       (document.fresh_evidence_supplied !== false || document.fresh_claim !== null)) ||
      (document.command !== 'supply_fresh_evidence' && document.recorded_claim !== null) ||
      (document.command === 'supply_fresh_evidence' && document.from_state === 'awaiting_evidence' &&
       document.recorded_claim !== null) ||
      (document.command === 'supply_fresh_evidence' && document.recovery_report !== null)) {
    return observation({
      verdict: 'fail',
      codes: ['evidence.fresh_evidence_inconsistent'],
      output: 'evidence transition denied',
      operations,
      terminalState: document.from_state,
      illegalTransition: true,
    });
  }
  if (['readback', 'mark_stale'].includes(document.command)) {
    if (!isRecord(document.recovery_report)) {
      return observation({
        verdict: 'fail', codes: ['evidence.recovery_report_required'], output: 'evidence transition denied',
        operations, terminalState: document.from_state, illegalTransition: true,
      });
    }
    const recovery = await validateRecoveryReportBinding(document.recovery_report, packageRoot, context);
    const expectedState = document.command === 'mark_stale' ? 'evidence_stale' : row.terminal_state;
    if (recovery.codes.length > 0 || recovery.observed?.terminal_state !== expectedState) {
      return observation({
        verdict: 'fail',
        codes: ['evidence.recovery_report_invalid', ...recovery.codes],
        output: 'evidence transition denied',
        operations,
        terminalState: document.from_state,
        illegalTransition: true,
      });
    }
  }
  if (['record_verdict', 'supply_fresh_evidence'].includes(document.command)) {
    const freshClaim = await validateClaimBinding(
      document.fresh_claim,
      document.fresh_claim.claim_id,
      packageRoot,
      context,
    );
    if (freshClaim.codes.length > 0 || !hasFreshMandatoryEvidence(freshClaim.document)) {
      return observation({
        verdict: 'fail',
        codes: ['evidence.fresh_evidence_required', ...freshClaim.codes],
        output: 'evidence transition denied',
        operations,
        terminalState: document.from_state,
        illegalTransition: true,
      });
    }
    if (document.command === 'record_verdict') {
      if (!isRecord(document.recovery_report)) {
        return observation({
          verdict: 'fail', codes: ['evidence.recovery_report_required'], output: 'evidence transition denied',
          operations, terminalState: document.from_state, illegalTransition: true,
        });
      }
      const recovery = await validateRecoveryReportBinding(document.recovery_report, packageRoot, context);
      if (recovery.codes.length > 0 || recovery.observed?.terminal_state !== 'awaiting_evidence' ||
          recovery.document?.fresh_evidence_supplied !== true ||
          !isDeepStrictEqual(recovery.document?.claim, document.fresh_claim)) {
        return observation({
          verdict: 'fail',
          codes: ['evidence.recovery_report_invalid', ...recovery.codes],
          output: 'evidence transition denied',
          operations,
          terminalState: document.from_state,
          illegalTransition: true,
        });
      }
    }
    if (document.command === 'supply_fresh_evidence' && document.from_state !== 'awaiting_evidence') {
      const recordedClaim = await validateClaimBinding(
        document.recorded_claim,
        document.fresh_claim.claim_id,
        packageRoot,
        context,
        {retainSemanticFailure: document.from_state === 'evidence_stale'},
      );
      if (recordedClaim.document === null ||
          (recordedClaim.codes.length > 0 && document.from_state !== 'evidence_stale')) {
        return observation({
          verdict: 'fail',
          codes: ['evidence.recorded_claim_required', ...recordedClaim.codes],
          output: 'evidence transition denied',
          operations,
          terminalState: document.from_state,
          illegalTransition: true,
        });
      }
      if (document.recorded_claim.sha256 === document.fresh_claim.sha256 ||
          !await freshClaimIsNew(recordedClaim.document, freshClaim.document, packageRoot)) {
        return observation({
          verdict: 'fail',
          codes: ['evidence.fresh_evidence_replayed'],
          output: 'evidence transition denied',
          operations,
          terminalState: document.from_state,
          illegalTransition: true,
        });
      }
    }
  }
  return observation({
    verdict: 'pass',
    output: 'evidence transition accepted',
    operations,
    terminalState: row.terminal_state,
  });
}

export async function observeEvidenceExtension(subject, packageRoot, context) {
  const currentContext = validationContext(context);
  const resolveOperations = ['resolve validator extension'];
  if (!isRecord(subject)) {
    return observation({
      verdict: 'fail', codes: ['schema.constraint'], output: 'validator extension rejected',
      operations: resolveOperations, terminalState: 'rejected',
    });
  }
  const registry = await readJson(packageRoot, 'contracts/validator-extensions.json');
  const extension = Array.isArray(registry?.extensions)
    ? registry.extensions.find((candidate) => candidate?.extension_id === subject.extension_id)
    : undefined;
  if (extension === undefined) {
    return observation({
      verdict: 'fail',
      codes: ['validator.extension_unsupported'],
      output: 'validator extension rejected',
      operations: resolveOperations,
      terminalState: 'rejected',
    });
  }
  if (!Array.isArray(extension.subject_schemas)) {
    return observation({
      verdict: 'fail',
      codes: ['schema.constraint'],
      output: 'validator extension rejected',
      operations: resolveOperations,
      terminalState: 'rejected',
    });
  }
  const operations = [...resolveOperations, 'validate extension document'];
  if (!extension.subject_schemas?.includes(subject.schema)) {
    return observation({
      verdict: 'fail',
      codes: ['validator.extension_schema_denied'],
      output: 'validator extension rejected',
      operations,
      terminalState: 'rejected',
    });
  }
  let schemaErrors;
  try {
    schemaErrors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
  } catch {
    return observation({
      verdict: 'fail',
      codes: ['schema.instance_missing'],
      output: 'validator extension rejected',
      operations,
      terminalState: 'rejected',
    });
  }
  const schemaCode = schemaErrorCode(schemaErrors);
  if (schemaCode !== null) {
    return observation({
      verdict: 'fail',
      codes: [schemaCode],
      output: `${evidenceName(subject.schema)} rejected`,
      operations,
      terminalState: 'rejected',
    });
  }
  operations.push('verify specification and validator bindings');
  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  const codes = bindingCodes(subject.document, manifest ?? {}, extension);
  const schemaName = subject.schema.split('/').at(-1);
  switch (schemaName) {
    case 'evidence-envelope.schema.json':
      if (codes.length === 0) {
        operations.push('recompute referenced artifact digests');
        codes.push(...await evidenceEnvelopeCodes(subject.document, packageRoot, currentContext));
      }
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'evidence envelope accepted' : 'evidence envelope rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    case 'claim-manifest.schema.json': {
      operations.push('evaluate mandatory evidence', 'validate bound evidence envelopes');
      codes.push(...await claimManifestCodes(subject.document, packageRoot, currentContext));
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'claim manifest accepted' : 'claim manifest rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    }
    case 'evidence-recovery-report.schema.json': {
      operations.push('recompute evidence bindings', 'preserve non-pass verdict');
      codes.push(...await recoveryCodes(subject.document, packageRoot, currentContext));
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'recovery report accepted' : 'recovery report rejected',
        operations,
        terminalState: codes.length === 0 ? subject.document.terminal_state : 'rejected',
      });
    }
    case 'evidence-transition-attempt.schema.json':
      operations.push('evaluate evidence lifecycle');
      if (codes.length > 0) {
        return observation({
          verdict: 'fail', codes, output: 'evidence transition rejected', operations, terminalState: 'rejected',
        });
      }
      return observeTransitionAttempt(subject.document, packageRoot, operations, currentContext);
    case 'validator-invocation.schema.json':
      if (codes.length === 0) {
        operations.push('recompute referenced artifact digests');
        codes.push(...await invocationCodes(subject.document, packageRoot, extension, currentContext));
      }
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'validator invocation accepted' : 'validator invocation rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    case 'verdict-table.schema.json':
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'verdict table accepted' : 'verdict table rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    default:
      return observation({
        verdict: 'fail',
        codes: ['validator.extension_schema_unsupported'],
        output: 'validator extension rejected',
        operations,
        terminalState: 'rejected',
      });
  }
}
