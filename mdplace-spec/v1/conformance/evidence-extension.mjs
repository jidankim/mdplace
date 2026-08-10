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
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  if (!requirements?.requirements?.some(({id}) => id === document.requirement_id)) {
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
       !isDeepStrictEqual(invocationSubject, document.subject)) {
      codes.push('evidence.invocation_binding_mismatch');
    }
  }
  return codes;
}

async function claimManifestCodes(document, packageRoot, context) {
  const codes = claimCodes(document);
  const requirementsDocument = await readJson(packageRoot, 'normative/requirements.json');
  if (typeof document.requirement_id === 'string' &&
      !requirementsDocument?.requirements?.some(({id}) => id === document.requirement_id)) {
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

async function expectedRecoveryBindings(claimBinding, claim, packageRoot) {
  const expected = new Map();
  addExpectedBinding(expected, claimBinding?.path, claimBinding?.sha256);
  const claimBindings = Array.isArray(claim?.evidence_bindings) ? claim.evidence_bindings : [];
  for (const binding of claimBindings.filter(isRecord)) {
    addExpectedBinding(expected, binding.evidence_ref, binding.evidence_digest);
    if (typeof binding.evidence_ref !== 'string') continue;
    const envelope = await readJson(packageRoot, binding.evidence_ref);
    if (envelope === null) continue;
    addExpectedBinding(expected, envelope.invocation?.path, envelope.invocation?.sha256);
    for (const digestBinding of [
      ...(Array.isArray(envelope.input_digests) ? envelope.input_digests : []),
      ...(Array.isArray(envelope.output_digests) ? envelope.output_digests : []),
      ...(Array.isArray(envelope.artifact_digests) ? envelope.artifact_digests : []),
    ]) {
      if (isRecord(digestBinding)) addExpectedBinding(expected, digestBinding.path, digestBinding.sha256);
    }
    if (typeof envelope.invocation?.path !== 'string') continue;
    const invocation = await readJson(packageRoot, envelope.invocation.path);
    if (invocation === null) continue;
    addExpectedBinding(expected, invocation.subject?.path, invocation.subject?.sha256);
    const invocationInputs = Array.isArray(invocation.input_digests) ? invocation.input_digests : [];
    for (const digestBinding of invocationInputs.filter(isRecord)) {
      addExpectedBinding(expected, digestBinding.path, digestBinding.sha256);
    }
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
  if (document.fresh_evidence_supplied === true &&
      (claimResult.digestMatches !== true || claimResult.codes.length > 0 ||
       !hasFreshMandatoryEvidence(claimResult.document) ||
       claimResult.document?.verdict !== document.effective_verdict)) {
    codes.push('evidence.fresh_evidence_required');
  }
  const expectedBindings = await expectedRecoveryBindings(document.claim, claimResult.document, packageRoot);
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
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  if ((document.requirement_ids ?? []).some((requirementId) =>
    !requirements?.requirements?.some(({id}) => id === requirementId))) {
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

async function mandatoryInvocationDigests(claim, packageRoot) {
  const digests = new Set();
  const bindings = Array.isArray(claim?.evidence_bindings) ? claim.evidence_bindings : [];
  for (const binding of bindings.filter((entry) => isRecord(entry) && entry.mandatory === true &&
    entry.applicability !== 'not_applicable' && entry.availability === 'present')) {
    const envelope = await readJson(packageRoot, binding.evidence_ref);
    if (typeof envelope?.invocation?.sha256 === 'string') digests.add(envelope.invocation.sha256);
  }
  return digests;
}

async function freshClaimIsNew(recordedClaim, freshClaim, packageRoot) {
  if (recordedClaim.claim_id !== freshClaim.claim_id || recordedClaim.profile !== freshClaim.profile ||
      recordedClaim.requirement_id !== freshClaim.requirement_id ||
      !isDeepStrictEqual(recordedClaim.subject, freshClaim.subject)) return false;
  const [recordedInvocations, freshInvocations] = await Promise.all([
    mandatoryInvocationDigests(recordedClaim, packageRoot),
    mandatoryInvocationDigests(freshClaim, packageRoot),
  ]);
  return freshInvocations.size > 0 &&
    [...freshInvocations].every((invocationDigest) => !recordedInvocations.has(invocationDigest));
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
      (['record_verdict', 'supply_fresh_evidence'].includes(document.command) &&
       document.recovery_report !== null)) {
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
    if (document.command === 'supply_fresh_evidence' && document.from_state !== 'awaiting_evidence') {
      const recordedClaim = await validateClaimBinding(
        document.recorded_claim,
        document.fresh_claim.claim_id,
        packageRoot,
        context,
      );
      if (recordedClaim.codes.length > 0 || recordedClaim.document === null) {
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
