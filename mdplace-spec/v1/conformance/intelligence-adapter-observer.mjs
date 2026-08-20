import {isDeepStrictEqual} from 'node:util';

import {canonicalJson} from './semantic-kernel-core.mjs';
import {
  adapterReceiptTiming,
  createAdapterReceipt,
  sha256,
} from './intelligence-adapter-core.mjs';
import {
  forbiddenActionCode,
  highestPrecedenceCode,
  preflightCode,
  validateProposal,
} from './intelligence-adapter-validation.mjs';
import {readPackageFile} from './safe-path.mjs';

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

function outcomeForCode(code) {
  if (code === 'adapter.timeout') return 'timeout';
  if (code === 'adapter.retry_exhausted') return 'retry_exhausted';
  if (code === 'adapter.fallback_exhausted') return 'fallback_exhausted';
  if (code === 'adapter.malformed_output') return 'malformed_output';
  if (code.endsWith('budget_exhausted')) return 'budget_exhausted';
  if (code === 'adapter.isolation_failed' || code === 'adapter.canary_failed') return 'isolation_failure';
  if (code === 'adapter.recovery_unknown_completion') return 'recovery_required';
  return 'denied';
}

function outputFor(code) {
  const outputs = {
    'adapter.timeout': 'Intelligence Adapter Attempt timed out',
    'adapter.retry_exhausted': 'authorized retry exhausted',
    'adapter.fallback_exhausted': 'authorized fallback exhausted',
    'adapter.malformed_output': 'raw adapter output rejected as inert malformed data',
    'adapter.recovery_unknown_completion': 'adapter recovery requires exact completion evidence',
  };
  return outputs[code] ?? `Intelligence Adapter Attempt denied: ${code}`;
}

function terminalFor(code) {
  if (code === 'adapter.timeout') return 'timed_out';
  if (code === 'adapter.retry_exhausted') return 'retry_exhausted';
  if (code === 'adapter.fallback_exhausted') return 'fallback_exhausted';
  if (code === 'adapter.recovery_unknown_completion') return 'recovery_required';
  return 'denied';
}

function observedTransmission(attempt, bytes, budget, rawOutput) {
  const envelope = attempt.envelope;
  const timing = adapterReceiptTiming(attempt, budget);
  return {
    attempt_id: envelope.attempt_id,
    attempt_class: attempt.attempt_class,
    exact_transmitted_utf8: bytes,
    exact_transmitted_sha256: sha256(bytes),
    exact_transmitted_bytes: Buffer.byteLength(bytes),
    exact_destination: envelope.destination.endpoint,
    effective_capabilities: attempt.isolation.effective_capabilities,
    declared_retention_artifacts: envelope.retention_artifacts,
    isolation: attempt.isolation,
    measured_budget: budget,
    ...timing,
    provider_request_id: attempt.double.provider_request_id,
    raw_output_sha256: rawOutput === null ? null : sha256(rawOutput),
    semantic_effects: [],
    filesystem_effects: [],
    tool_invocations: [],
  };
}

function result({verdict, codes, outputs, operations, receipts, transmissions, observations, terminalState, illegalTransition, networkEffects = null}) {
  const remoteTransmissions = transmissions.filter(({locality}) => locality === 'remote');
  return {
    verdict,
    codes,
    outputs,
    operations,
    receipts: receipts.map((receipt) => JSON.stringify(receipt)),
    filesystem_effects: ['none'],
    network_effects: networkEffects ?? (remoteTransmissions.length === 0
      ? ['none']
      : remoteTransmissions.map(({destination, sha256: digest, byte_length: length}) =>
        `transmit:${destination}:${digest}:${length}`)),
    observations: observations.map(canonicalJson),
    terminal_state: terminalState,
    illegal_transition: illegalTransition,
  };
}

function receiptBudget(inputBytes, outputBytes, double) {
  return {
    input_bytes: inputBytes,
    output_bytes: outputBytes,
    runtime_ms: measuredRuntime(double),
    cost_microunits: double.cost_microunits,
  };
}

function zeroReceiptBudget() {
  return {input_bytes: 0, output_bytes: 0, runtime_ms: 0, cost_microunits: 0};
}

function receiptFor(attempt, transmission, rawOutput, proposal, outcome, reason, budget) {
  return createAdapterReceipt({
    attempt,
    transmission,
    isolation: attempt.isolation,
    budget,
    rawOutput,
    proposal,
    outcome,
    reason,
  });
}

const canonicalTimestampPattern = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;

function measuredRuntime(double) {
  const started = Date.parse(double.observed_started_at);
  const completed = Date.parse(double.observed_completed_at);
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
    ? completed - started
    : 0;
}

function observedTimingIsValid(double) {
  const {observed_started_at: startedAt, observed_completed_at: completedAt} = double;
  if (!canonicalTimestampPattern.test(startedAt) || !canonicalTimestampPattern.test(completedAt)) return false;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) &&
    new Date(started).toISOString() === startedAt && new Date(completed).toISOString() === completedAt &&
    completed >= started && measuredRuntime(double) === double.duration_ms;
}

async function evaluateTransmittedAttempt({
  attempt,
  nextAttempt,
  context,
  packageRoot,
  subject,
  inputBytes,
  totalInput,
  totalOutput,
  totalRuntime,
  totalCost,
  retriesUsed,
  fallbacksUsed,
}) {
  const {double, envelope} = attempt;
  const rawOutput = double.raw_output;
  const outputBytes = rawOutput === null ? 0 : Buffer.byteLength(rawOutput);
  const budget = receiptBudget(inputBytes, outputBytes, double);
  const nextTotalOutput = totalOutput + outputBytes;
  const nextTotalRuntime = totalRuntime + budget.runtime_ms;
  const nextTotalCost = totalCost + double.cost_microunits;

  let code = highestPrecedenceCode([
    forbiddenActionCode(double.requested_actions),
    double.behavior === 'timeout' || budget.runtime_ms > envelope.ceilings.runtime_ms ||
        nextTotalRuntime > subject.chain_budget.runtime_ms
      ? 'adapter.timeout'
      : null,
    outputBytes > envelope.ceilings.output_bytes || nextTotalOutput > subject.chain_budget.output_bytes
      ? 'adapter.output_budget_exhausted'
      : null,
    double.cost_microunits > envelope.ceilings.cost_microunits ||
        nextTotalCost > subject.chain_budget.cost_microunits
      ? 'adapter.cost_budget_exhausted'
      : null,
    observedTimingIsValid(double) ? null : 'adapter.malformed_output',
  ]);

  if (code === null && double.behavior === 'transient_failure') {
    const nextClass = nextAttempt?.attempt_class;
    const nextInputBytes = nextAttempt === undefined ? 0 : Buffer.byteLength(canonicalJson(nextAttempt.envelope));
    const nextAuthorized = nextAttempt !== undefined && preflightCode(nextAttempt, context) === null &&
      totalInput + nextInputBytes <= subject.chain_budget.input_bytes;
    const retryPermitted = nextAuthorized && nextClass === 'retry' && attempt.attempt_class === 'primary' &&
      retriesUsed < subject.chain_budget.max_retries;
    const fallbackAttempted = nextClass === 'fallback' && attempt.attempt_class === 'retry';
    const fallbackPermitted = nextAuthorized && fallbackAttempted &&
      fallbacksUsed < subject.chain_budget.max_fallbacks;
    code = retryPermitted ? 'adapter.retry_scheduled' : fallbackPermitted ? 'adapter.fallback_scheduled'
      : fallbackAttempted || attempt.attempt_class === 'fallback' ? 'adapter.fallback_exhausted' : 'adapter.retry_exhausted';
    return {
      rawOutput,
      proposal: null,
      code,
      outcome: retryPermitted ? 'retry_scheduled' : fallbackPermitted ? 'fallback_scheduled' : outcomeForCode(code),
      continueChain: retryPermitted || fallbackPermitted,
      scheduledClass: retryPermitted ? 'retry' : fallbackPermitted ? 'fallback' : null,
      proposalValidated: false,
      budget,
      totalOutput: nextTotalOutput,
      totalRuntime: nextTotalRuntime,
      totalCost: nextTotalCost,
    };
  }

  let proposal = null;
  let proposalValidated = false;
  if (code === null) {
    if (double.behavior === 'malformed_output' || rawOutput === null) code = 'adapter.malformed_output';
    else {
      const validated = await validateProposal(rawOutput, envelope, packageRoot);
      proposal = validated.proposal;
      code = validated.code;
      proposalValidated = true;
    }
  }
  return {
    rawOutput,
    proposal,
    code,
    outcome: code === null ? 'accepted' : outcomeForCode(code),
    continueChain: false,
    scheduledClass: null,
    proposalValidated,
    budget,
    totalOutput: nextTotalOutput,
    totalRuntime: nextTotalRuntime,
    totalCost: nextTotalCost,
  };
}

function recoveryBehaviorMatches(subject) {
  const behavior = subject.attempts[0].double.behavior;
  const crashPoint = subject.recovery.crash_point;
  if (crashPoint === 'before_transmission') return behavior === 'crash_before_transmit';
  if (crashPoint === 'after_transmission_before_receipt') return behavior === 'crash_after_transmit';
  if (crashPoint === 'after_receipt') {
    return behavior !== 'crash_before_transmit' && behavior !== 'crash_after_transmit';
  }
  return false;
}

async function observeRecovery(subject, context, packageRoot) {
  const attempt = subject.attempts[0];
  const {recovery} = subject;
  const bytes = canonicalJson(attempt.envelope);
  const expectedTransmission = {
    destination: attempt.envelope.destination.endpoint,
    sha256: sha256(bytes),
    byte_length: Buffer.byteLength(bytes),
  };
  const observedPriorTransmission = recovery.transmission_observed === true &&
    isDeepStrictEqual(recovery.prior_transmission, expectedTransmission);
  const compatibleBehavior = recoveryBehaviorMatches(subject);
  if (recovery.crash_point === 'after_receipt' && recovery.prior_receipts.length === 1 &&
      compatibleBehavior && observedPriorTransmission && chainPreflightCode(subject, context) === null &&
      preflightCode(attempt, context) === null) {
    const evaluated = await evaluateTransmittedAttempt({
      attempt,
      nextAttempt: subject.attempts[1],
      context,
      packageRoot,
      subject,
      inputBytes: expectedTransmission.byte_length,
      totalInput: expectedTransmission.byte_length,
      totalOutput: 0,
      totalRuntime: 0,
      totalCost: 0,
      retriesUsed: 0,
      fallbacksUsed: 0,
    });
    const expectedReceipt = evaluated.code === null
      ? receiptFor(attempt, expectedTransmission, evaluated.rawOutput, evaluated.proposal,
        'accepted', 'adapter.proposal_accepted_as_advice', evaluated.budget)
      : receiptFor(attempt, expectedTransmission, evaluated.rawOutput, null,
        evaluated.outcome, evaluated.code, evaluated.budget);
    if (isDeepStrictEqual(recovery.prior_receipts[0], expectedReceipt)) {
      const receipt = recovery.prior_receipts[0];
      return result({
        verdict: 'pass', codes: [], outputs: ['durable Adapter Run Receipt preserved idempotently'],
        operations: ['read exact recovery evidence', 'verify Adapter Run Receipt digest', 'preserve receipt without retransmission'],
        receipts: [receipt], transmissions: [], observations: [{receipt_id: receipt.receipt_id, new_transmission: false}],
        terminalState: 'recovered', illegalTransition: false, networkEffects: ['none'],
      });
    }
  }
  if (recovery.crash_point === 'before_transmission' && recovery.transmission_observed === false &&
      compatibleBehavior && recovery.prior_transmission === null && recovery.prior_receipts.length === 0) {
    const budget = zeroReceiptBudget();
    const receipt = receiptFor(attempt, null, null, null, 'denied', 'adapter.recovery_before_transmission_denied', budget);
    return result({
      verdict: 'fail', codes: ['adapter.recovery_before_transmission_denied'], outputs: ['pre-transmission crash recovered with zero bytes sent'],
      operations: ['read exact recovery evidence', 'prove zero-byte transmission', 'record Adapter Run Receipt'],
      receipts: [receipt], transmissions: [], observations: [{attempt_id: attempt.envelope.attempt_id, exact_transmitted_bytes: 0}],
      terminalState: 'denied', illegalTransition: false, networkEffects: ['none'],
    });
  }
  const transmission = observedPriorTransmission ? expectedTransmission : null;
  const budget = transmission === null
    ? zeroReceiptBudget()
    : {input_bytes: transmission.byte_length, output_bytes: 0, runtime_ms: 0, cost_microunits: 0};
  const code = 'adapter.recovery_unknown_completion';
  const receipt = receiptFor(attempt, transmission, null, null, 'recovery_required', code, budget);
  const observations = observedPriorTransmission
    ? [{...observedTransmission(attempt, bytes, budget, null), new_transmission: false}]
    : [{attempt_id: attempt.envelope.attempt_id, new_transmission: false, prior_transmission_valid: false}];
  return result({
    verdict: 'fail', codes: [code], outputs: [outputFor(code)],
    operations: ['read exact recovery evidence', 'observe prior transmission without retransmission', 'record Adapter Run Receipt'],
    receipts: [receipt], transmissions: [], observations, terminalState: 'recovery_required',
    illegalTransition: false, networkEffects: ['none'],
  });
}

async function observeIllegalTransition(subject, packageRoot) {
  const attempt = subject.attempts[0];
  const illegal = subject.illegal_transition;
  const table = await readJson(packageRoot, illegal.table);
  const row = table?.transitions?.find(({from_state: state, command_or_event: command}) =>
    state === illegal.from_state && command === illegal.command);
  const explicitlyDenied = row?.allowed === false;
  const code = 'adapter.illegal_transition';
  const budget = zeroReceiptBudget();
  const receipt = receiptFor(attempt, null, null, null, 'denied', code, budget);
  return result({
    verdict: 'fail', codes: [code], outputs: ['illegal Intelligence Adapter lifecycle transition denied'],
    operations: ['read complete lifecycle table', 'observe state-command pair', 'record Adapter Run Receipt'],
    receipts: [receipt], transmissions: [], observations: [{table: illegal.table, from_state: illegal.from_state, command: illegal.command, allowed: row?.allowed ?? null}],
    terminalState: 'denied', illegalTransition: explicitlyDenied,
  });
}

function chainBudgetNarrower(requested, approved) {
  return ['max_attempts', 'max_retries', 'max_fallbacks', 'input_bytes', 'output_bytes', 'runtime_ms', 'cost_microunits']
    .every((field) => requested[field] <= approved[field]);
}

function chainPreflightCode(subject, context) {
  const attempts = subject.attempts;
  const classes = attempts.map(({attempt_class: attemptClass}) => attemptClass);
  const retryCount = classes.filter((attemptClass) => attemptClass === 'retry').length;
  const fallbackCount = classes.filter((attemptClass) => attemptClass === 'fallback').length;
  if (!chainBudgetNarrower(subject.chain_budget, context.chain_budget)) return 'adapter.policy_binding_denied';
  if (attempts.length > subject.chain_budget.max_attempts || attempts.length > context.chain_budget.max_attempts ||
      retryCount > subject.chain_budget.max_retries || retryCount > context.chain_budget.max_retries) {
    return 'adapter.retry_exhausted';
  }
  if (fallbackCount > subject.chain_budget.max_fallbacks || fallbackCount > context.chain_budget.max_fallbacks) {
    return 'adapter.fallback_exhausted';
  }
  const expectedClasses = ['primary', 'retry', 'fallback'].slice(0, attempts.length);
  if (!isDeepStrictEqual(classes, expectedClasses)) {
    return classes.includes('fallback') ? 'adapter.fallback_exhausted' : 'adapter.retry_exhausted';
  }
  const valuesAreUnique = (values) => new Set(values).size === values.length;
  if (!valuesAreUnique(attempts.map(({envelope}) => envelope.attempt_id)) ||
      !valuesAreUnique(attempts.map(({envelope}) => envelope.envelope_id)) ||
      !valuesAreUnique(attempts.map(({envelope}) => envelope.authorization_id)) ||
      attempts.some(({envelope}, index) => envelope.attempt_sequence !== index) ||
      new Set(attempts.map(({envelope}) => envelope.chain_id)).size !== 1) {
    return retryCount > 0 ? 'adapter.retry_exhausted' : fallbackCount > 0
      ? 'adapter.fallback_exhausted'
      : 'adapter.policy_binding_denied';
  }
  return null;
}

export async function observeIntelligenceAdapterScenario(subject, packageRoot) {
  const context = await readJson(packageRoot, subject.authorization_ref);
  const operations = ['read trusted Intelligence Adapter authorization context'];
  const receipts = [];
  const transmissions = [];
  const observations = [];
  if (context === null) {
    return result({verdict: 'fail', codes: ['adapter.policy_binding_denied'], outputs: ['trusted authorization context unavailable'], operations, receipts, transmissions, observations, terminalState: 'denied', illegalTransition: false});
  }
  if (subject.operation === 'recover') {
    return observeRecovery(subject, context, packageRoot);
  }
  if (subject.operation === 'observe_illegal_transition') {
    return observeIllegalTransition(subject, packageRoot);
  }

  const chainDenial = highestPrecedenceCode([
    preflightCode(subject.attempts[0], context),
    chainPreflightCode(subject, context),
  ]);
  if (chainDenial !== null) {
    const attempt = subject.attempts[0];
    const budget = zeroReceiptBudget();
    const receipt = receiptFor(attempt, null, null, null, outcomeForCode(chainDenial), chainDenial, budget);
    return result({
      verdict: 'fail', codes: [chainDenial], outputs: [outputFor(chainDenial)],
      operations: [...operations, 'validate complete authorized attempt chain', `record Adapter Run Receipt ${receipt.receipt_id}`],
      receipts: [receipt], transmissions, observations, terminalState: terminalFor(chainDenial),
      illegalTransition: false, networkEffects: ['none'],
    });
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalRuntime = 0;
  let totalCost = 0;
  let retriesUsed = 0;
  let fallbacksUsed = 0;
  for (let index = 0; index < subject.attempts.length; index += 1) {
    const attempt = subject.attempts[index];
    const envelope = attempt.envelope;
    operations.push(`bind exact Processing Envelope ${envelope.envelope_id}`);
    const preflight = preflightCode(attempt, context);
    operations.push(`verify isolation and Adapter Isolation Canary ${envelope.attempt_id}`);
    const bytes = canonicalJson(envelope);
    const inputBytes = Buffer.byteLength(bytes);
    const prospectiveInput = totalInput + inputBytes;
    const chainCode = prospectiveInput > subject.chain_budget.input_bytes
      ? 'adapter.input_budget_exhausted'
      : null;
    const denial = highestPrecedenceCode([preflight, chainCode]);
    if (denial !== null) {
      const budget = zeroReceiptBudget();
      const receipt = receiptFor(attempt, null, null, null, outcomeForCode(denial), denial, budget);
      receipts.push(receipt);
      operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
      return result({verdict: 'fail', codes: [denial], outputs: [outputFor(denial)], operations, receipts, transmissions, observations, terminalState: terminalFor(denial), illegalTransition: false});
    }

    if (attempt.double.behavior === 'crash_before_transmit') {
      const code = 'adapter.recovery_before_transmission_denied';
      const budget = zeroReceiptBudget();
      const receipt = receiptFor(attempt, null, null, null, 'denied', code, budget);
      receipts.push(receipt);
      operations.push(`observe pre-transmission adapter crash ${envelope.attempt_id}`);
      operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
      return result({verdict: 'fail', codes: [code], outputs: ['pre-transmission crash denied with zero bytes sent'], operations, receipts, transmissions, observations, terminalState: 'denied', illegalTransition: false, networkEffects: ['none']});
    }

    const transmission = {
      destination: envelope.destination.endpoint,
      locality: envelope.destination.locality,
      sha256: sha256(bytes),
      byte_length: inputBytes,
    };
    transmissions.push(transmission);
    totalInput = prospectiveInput;
    operations.push(`transmit exact Processing Envelope bytes ${envelope.attempt_id}`);

    if (attempt.double.behavior === 'crash_after_transmit' || subject.recovery.crash_point === 'after_transmission_before_receipt') {
      const budget = receiptBudget(inputBytes, 0, attempt.double);
      const code = 'adapter.recovery_unknown_completion';
      const receipt = receiptFor(attempt, transmission, null, null, 'recovery_required', code, budget);
      receipts.push(receipt);
      observations.push(observedTransmission(attempt, bytes, budget, null));
      operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
      return result({verdict: 'fail', codes: [code], outputs: [outputFor(code)], operations, receipts, transmissions, observations, terminalState: 'recovery_required', illegalTransition: false});
    }

    const evaluated = await evaluateTransmittedAttempt({
      attempt,
      nextAttempt: subject.attempts[index + 1],
      context,
      packageRoot,
      subject,
      inputBytes,
      totalInput,
      totalOutput,
      totalRuntime,
      totalCost,
      retriesUsed,
      fallbacksUsed,
    });
    totalOutput = evaluated.totalOutput;
    totalRuntime = evaluated.totalRuntime;
    totalCost = evaluated.totalCost;
    observations.push(observedTransmission(attempt, bytes, evaluated.budget, evaluated.rawOutput));
    operations.push(`observe instrumented Intelligence Adapter double ${envelope.attempt_id}`);

    if (evaluated.proposalValidated) operations.push(`validate inert Intelligence Proposal ${envelope.attempt_id}`);
    if (evaluated.code !== null) {
      const receipt = receiptFor(attempt, transmission, evaluated.rawOutput, null,
        evaluated.outcome, evaluated.code, evaluated.budget);
      receipts.push(receipt);
      operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
      if (evaluated.continueChain) {
        if (evaluated.scheduledClass === 'retry') retriesUsed += 1;
        if (evaluated.scheduledClass === 'fallback') fallbacksUsed += 1;
        continue;
      }
      return result({verdict: 'fail', codes: [evaluated.code], outputs: [outputFor(evaluated.code)], operations, receipts, transmissions, observations, terminalState: terminalFor(evaluated.code), illegalTransition: false});
    }

    const receipt = receiptFor(attempt, transmission, evaluated.rawOutput, evaluated.proposal,
      'accepted', 'adapter.proposal_accepted_as_advice', evaluated.budget);
    receipts.push(receipt);
    operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
    return result({verdict: 'pass', codes: [], outputs: ['validated Intelligence Proposal remains inert advice'], operations, receipts, transmissions, observations, terminalState: 'proposal_advice_available', illegalTransition: false});
  }
  return result({verdict: 'fail', codes: ['adapter.retry_exhausted'], outputs: [outputFor('adapter.retry_exhausted')], operations, receipts, transmissions, observations, terminalState: 'retry_exhausted', illegalTransition: false});
}
