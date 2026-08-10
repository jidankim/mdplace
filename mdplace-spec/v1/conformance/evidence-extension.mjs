import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

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
  for (const binding of document.evidence_bindings.filter(({mandatory}) => mandatory === true)) {
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

async function evidenceEnvelopeCodes(document, packageRoot) {
  const codes = [];
  const orderedCollections = [document.input_digests, document.output_digests, document.receipts, document.artifact_digests];
  if (orderedCollections.some((entries) => !ordinalsAreContiguous(entries))) codes.push('evidence.ordinal_invalid');
  const digestBindings = [
    ...(Array.isArray(document.input_digests) ? document.input_digests : []),
    ...(Array.isArray(document.output_digests) ? document.output_digests : []),
    ...(Array.isArray(document.artifact_digests) ? document.artifact_digests : []),
    ...(document.invocation === undefined ? [] : [document.invocation]),
  ];
  const matches = await Promise.all(digestBindings.map(({path, sha256}) => bindingMatches(packageRoot, path, sha256)));
  if (matches.some((match) => !match)) codes.push('evidence.artifact_digest_mismatch');
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  if (!requirements?.requirements?.some(({id}) => id === document.requirement_id)) {
    codes.push('evidence.requirement_unresolved');
  }
  const invocation = document.invocation === undefined ? null : await readJson(packageRoot, document.invocation.path);
  if (invocation !== null &&
      (invocation.invocation_id !== document.invocation.invocation_id ||
       invocation.package_series !== document.package_series ||
       invocation.release_version !== document.release_version ||
       invocation.validator_id !== document.validator_id ||
       invocation.validator_version !== document.validator_version ||
       !invocation.requirement_ids?.includes(document.requirement_id) ||
       !isDeepStrictEqual(invocation.subject, document.subject))) {
    codes.push('evidence.invocation_binding_mismatch');
  }
  return codes;
}

async function claimManifestCodes(document, packageRoot) {
  const codes = claimCodes(document);
  const requirements = new Map((document.evidence_requirements ?? []).map((entry) => [entry.evidence_kind, entry]));
  const bindings = new Map((document.evidence_bindings ?? []).map((entry) => [entry.evidence_kind, entry]));
  if (requirements.size !== document.evidence_requirements?.length ||
      bindings.size !== document.evidence_bindings?.length ||
      requirements.size !== bindings.size ||
      [...requirements].some(([kind, requirement]) => bindings.get(kind)?.mandatory !== requirement.mandatory)) {
    codes.push('claim.evidence_requirement_mismatch');
  }
  for (const binding of bindings.values()) {
    const hasReference = typeof binding.evidence_ref === 'string' && typeof binding.evidence_digest === 'string';
    if (binding.availability === 'present') {
      if (!hasReference || !await bindingMatches(packageRoot, binding.evidence_ref, binding.evidence_digest)) {
        codes.push('claim.evidence_digest_mismatch');
        continue;
      }
      const envelope = await readJson(packageRoot, binding.evidence_ref);
      if (envelope?.requirement_id !== document.requirement_id ||
          !isDeepStrictEqual(envelope?.subject, {...document.subject, schema: envelope?.subject?.schema}) ||
          envelope?.verdict !== binding.verdict) {
        codes.push('claim.evidence_binding_mismatch');
      }
    } else if (hasReference) {
      codes.push('claim.noncurrent_evidence_bound');
    }
  }
  const mandatory = [...bindings.values()].filter((binding) =>
    binding.mandatory === true && binding.applicability === 'applicable');
  const expectedVerdict = mandatory.some(({availability, verdict}) => availability === 'present' && verdict === 'fail')
    ? 'fail'
    : mandatory.some(({availability, verdict}) => availability === 'unsupported' || verdict === 'unsupported')
      ? 'unsupported'
      : mandatory.some(({availability, verdict}) => availability !== 'present' || verdict === 'inconclusive')
        ? 'inconclusive'
        : 'pass';
  if (document.verdict !== expectedVerdict && codes.length === 0) codes.push('claim.verdict_mismatch');
  return codes;
}

async function recoveryCodes(document, packageRoot) {
  const codes = [];
  if (document.fresh_evidence_supplied === false &&
      ['fail', 'inconclusive'].includes(document.prior_verdict) &&
      document.effective_verdict !== document.prior_verdict) {
    codes.push('evidence.recovery_verdict_upgrade');
  }
  for (const binding of document.recomputed_bindings ?? []) {
    const read = await readPackageFile(packageRoot, binding.path);
    const actual = read.status === 'present' ? createHash('sha256').update(read.content).digest('hex') : null;
    const actualMatch = actual !== null && actual === binding.expected_sha256;
    if (actual !== binding.observed_sha256 || binding.matches !== actualMatch) {
      codes.push('evidence.recovery_binding_mismatch');
    }
  }
  if (document.fresh_evidence_supplied === true && document.terminal_state !== 'awaiting_evidence') {
    codes.push('evidence.recovery_state_invalid');
  }
  return codes;
}

async function invocationCodes(document, packageRoot) {
  const codes = [];
  if (!ordinalsAreContiguous(document.input_digests)) codes.push('evidence.ordinal_invalid');
  const matches = await Promise.all((document.input_digests ?? [])
    .map(({path, sha256}) => bindingMatches(packageRoot, path, sha256)));
  if (matches.some((match) => !match)) codes.push('evidence.artifact_digest_mismatch');
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  if ((document.requirement_ids ?? []).some((requirementId) =>
    !requirements?.requirements?.some(({id}) => id === requirementId))) {
    codes.push('evidence.requirement_unresolved');
  }
  return codes;
}

async function observeTransitionAttempt(document, packageRoot, operations) {
  const table = await readJson(packageRoot, document.table_ref);
  const row = table?.transitions?.find(({from_state: state, command_or_event: command}) =>
    state === document.from_state && command === document.command);
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
  return observation({
    verdict: 'pass',
    output: 'evidence transition accepted',
    operations,
    terminalState: row.terminal_state,
  });
}

export async function observeEvidenceExtension(subject, packageRoot) {
  const resolveOperations = ['resolve validator extension'];
  const registry = await readJson(packageRoot, 'contracts/validator-extensions.json');
  const extension = registry?.extensions?.find(({extension_id: id}) => id === subject.extension_id);
  if (extension === undefined) {
    return observation({
      verdict: 'fail',
      codes: ['validator.extension_unsupported'],
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
  const schemaErrors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
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
        codes.push(...await evidenceEnvelopeCodes(subject.document, packageRoot));
      }
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'evidence envelope accepted' : 'evidence envelope rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    case 'claim-manifest.schema.json': {
      operations.push('evaluate mandatory evidence');
      codes.push(...await claimManifestCodes(subject.document, packageRoot));
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
      codes.push(...await recoveryCodes(subject.document, packageRoot));
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'recovery report accepted' : 'recovery report rejected',
        operations,
        terminalState: codes.length === 0 ? subject.document.effective_verdict : 'rejected',
      });
    }
    case 'evidence-transition-attempt.schema.json':
      operations.push('evaluate evidence lifecycle');
      if (codes.length > 0) {
        return observation({
          verdict: 'fail', codes, output: 'evidence transition rejected', operations, terminalState: 'rejected',
        });
      }
      return observeTransitionAttempt(subject.document, packageRoot, operations);
    case 'validator-invocation.schema.json':
      if (codes.length === 0) {
        operations.push('recompute referenced artifact digests');
        codes.push(...await invocationCodes(subject.document, packageRoot));
      }
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'validator invocation accepted' : 'validator invocation rejected',
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
