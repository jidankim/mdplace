import {canonicalJson} from './semantic-kernel-core.mjs';
import {createAdapterReceipt, sha256} from './intelligence-adapter-core.mjs';
import {forbiddenActionCode, preflightCode, validateProposal} from './intelligence-adapter-validation.mjs';
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
    raw_output_sha256: rawOutput === null ? null : sha256(rawOutput),
    semantic_effects: [],
    filesystem_effects: [],
    tool_invocations: [],
  };
}

function result({verdict, codes, outputs, operations, receipts, transmissions, observations, terminalState, illegalTransition}) {
  return {
    verdict,
    codes,
    outputs,
    operations,
    receipts: receipts.map((receipt) => JSON.stringify(receipt)),
    filesystem_effects: ['none'],
    network_effects: transmissions.length === 0
      ? ['none']
      : transmissions.map(({destination, sha256: digest, byte_length: length}) =>
        `transmit:${destination}:${digest}:${length}`),
    observations: observations.map(canonicalJson),
    terminal_state: terminalState,
    illegal_transition: illegalTransition,
  };
}

function receiptBudget(inputBytes, outputBytes, double) {
  return {
    input_bytes: inputBytes,
    output_bytes: outputBytes,
    runtime_ms: double.duration_ms,
    cost_microunits: double.cost_microunits,
  };
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

async function observeRecovery(subject) {
  const attempt = subject.attempts[0];
  const {recovery} = subject;
  if (recovery.crash_point === 'after_receipt' && recovery.prior_receipts.length === 1) {
    const receipt = recovery.prior_receipts[0];
    return result({
      verdict: 'pass', codes: [], outputs: ['durable Adapter Run Receipt preserved idempotently'],
      operations: ['read exact recovery evidence', 'verify Adapter Run Receipt digest', 'preserve receipt without retransmission'],
      receipts: [receipt], transmissions: [], observations: [{receipt_id: receipt.receipt_id, new_transmission: false}],
      terminalState: 'recovered', illegalTransition: false,
    });
  }
  if (recovery.crash_point === 'before_transmission') {
    const budget = receiptBudget(0, 0, attempt.double);
    const receipt = receiptFor(attempt, null, null, null, 'recovered', 'adapter.recovery_before_transmission_denied', budget);
    return result({
      verdict: 'fail', codes: ['adapter.recovery_before_transmission_denied'], outputs: ['pre-transmission crash recovered with zero bytes sent'],
      operations: ['read exact recovery evidence', 'prove zero-byte transmission', 'record Adapter Run Receipt'],
      receipts: [receipt], transmissions: [], observations: [{attempt_id: attempt.envelope.attempt_id, exact_transmitted_bytes: 0}],
      terminalState: 'denied', illegalTransition: false,
    });
  }
  return null;
}

async function observeIllegalTransition(subject, packageRoot) {
  const attempt = subject.attempts[0];
  const illegal = subject.illegal_transition;
  const table = await readJson(packageRoot, illegal.table);
  const row = table?.transitions?.find(({from_state: state, command_or_event: command}) =>
    state === illegal.from_state && command === illegal.command);
  const code = row?.allowed === false ? 'adapter.illegal_transition' : 'adapter.lifecycle_evidence_invalid';
  const budget = receiptBudget(0, 0, attempt.double);
  const receipt = receiptFor(attempt, null, null, null, 'denied', code, budget);
  return result({
    verdict: 'fail', codes: [code], outputs: ['illegal Intelligence Adapter lifecycle transition denied'],
    operations: ['read complete lifecycle table', 'observe state-command pair', 'record Adapter Run Receipt'],
    receipts: [receipt], transmissions: [], observations: [{table: illegal.table, from_state: illegal.from_state, command: illegal.command, allowed: false}],
    terminalState: 'denied', illegalTransition: true,
  });
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
    const recovered = await observeRecovery(subject);
    if (recovered !== null) return recovered;
  }
  if (subject.operation === 'observe_illegal_transition') {
    return observeIllegalTransition(subject, packageRoot);
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalRuntime = 0;
  let totalCost = 0;
  for (let index = 0; index < subject.attempts.length; index += 1) {
    const attempt = subject.attempts[index];
    const envelope = attempt.envelope;
    operations.push(`bind exact Processing Envelope ${envelope.envelope_id}`);
    const preflight = preflightCode(attempt, context);
    operations.push(`verify isolation and Adapter Isolation Canary ${envelope.attempt_id}`);
    const bytes = canonicalJson(envelope);
    const inputBytes = Buffer.byteLength(bytes);
    const prospectiveInput = totalInput + inputBytes;
    const prospectiveRuntime = totalRuntime + attempt.double.duration_ms;
    const prospectiveCost = totalCost + attempt.double.cost_microunits;
    const chainCode = prospectiveInput > subject.chain_budget.input_bytes
      ? 'adapter.input_budget_exhausted'
      : null;
    const denial = preflight ?? chainCode;
    if (denial !== null) {
      const budget = receiptBudget(inputBytes, 0, attempt.double);
      const receipt = receiptFor(attempt, null, null, null, outcomeForCode(denial), denial, budget);
      receipts.push(receipt);
      operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
      return result({verdict: 'fail', codes: [denial], outputs: [outputFor(denial)], operations, receipts, transmissions, observations, terminalState: terminalFor(denial), illegalTransition: false});
    }

    const transmission = {destination: envelope.destination.endpoint, sha256: sha256(bytes), byte_length: inputBytes};
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

    const rawOutput = attempt.double.raw_output;
    const outputBytes = rawOutput === null ? 0 : Buffer.byteLength(rawOutput);
    totalOutput += outputBytes;
    totalRuntime = prospectiveRuntime;
    totalCost = prospectiveCost;
    const budget = receiptBudget(inputBytes, outputBytes, attempt.double);
    observations.push(observedTransmission(attempt, bytes, budget, rawOutput));
    operations.push(`observe instrumented Intelligence Adapter double ${envelope.attempt_id}`);

    if (attempt.double.behavior === 'transient_failure') {
      const nextClass = subject.attempts[index + 1]?.attempt_class;
      const retryPermitted = nextClass === 'retry' && subject.chain_budget.max_retries === 1;
      const fallbackAttempted = nextClass === 'fallback' && attempt.attempt_class === 'retry';
      const fallbackPermitted = fallbackAttempted && subject.chain_budget.max_fallbacks === 1;
      const code = retryPermitted ? 'adapter.retry_scheduled' : fallbackPermitted ? 'adapter.fallback_scheduled'
        : fallbackAttempted || attempt.attempt_class === 'fallback' ? 'adapter.fallback_exhausted' : 'adapter.retry_exhausted';
      const outcome = retryPermitted ? 'retry_scheduled' : fallbackPermitted ? 'fallback_scheduled' : outcomeForCode(code);
      const receipt = receiptFor(attempt, transmission, rawOutput, null, outcome, code, budget);
      receipts.push(receipt);
      operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
      if (retryPermitted || fallbackPermitted) continue;
      return result({verdict: 'fail', codes: [code], outputs: [outputFor(code)], operations, receipts, transmissions, observations, terminalState: terminalFor(code), illegalTransition: false});
    }

    let code = attempt.double.behavior === 'timeout' || attempt.double.duration_ms > envelope.ceilings.runtime_ms ||
      totalRuntime > subject.chain_budget.runtime_ms
      ? 'adapter.timeout'
      : null;
    if (code === null && (outputBytes > envelope.ceilings.output_bytes || totalOutput > subject.chain_budget.output_bytes)) {
      code = 'adapter.output_budget_exhausted';
    }
    if (code === null && (attempt.double.cost_microunits > envelope.ceilings.cost_microunits ||
        totalCost > subject.chain_budget.cost_microunits)) {
      code = 'adapter.cost_budget_exhausted';
    }
    if (code === null) code = forbiddenActionCode(attempt.double.requested_actions);
    let proposal = null;
    if (code === null) {
      if (attempt.double.behavior === 'malformed_output' || rawOutput === null) code = 'adapter.malformed_output';
      else {
        const validated = await validateProposal(rawOutput, envelope, packageRoot);
        proposal = validated.proposal;
        code = validated.code;
        operations.push(`validate inert Intelligence Proposal ${envelope.attempt_id}`);
      }
    }
    if (code !== null) {
      const receipt = receiptFor(attempt, transmission, rawOutput, null, outcomeForCode(code), code, budget);
      receipts.push(receipt);
      operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
      return result({verdict: 'fail', codes: [code], outputs: [outputFor(code)], operations, receipts, transmissions, observations, terminalState: terminalFor(code), illegalTransition: false});
    }

    const receipt = receiptFor(attempt, transmission, rawOutput, proposal, 'accepted', 'adapter.proposal_accepted_as_advice', budget);
    receipts.push(receipt);
    operations.push(`record Adapter Run Receipt ${receipt.receipt_id}`);
    return result({verdict: 'pass', codes: [], outputs: ['validated Intelligence Proposal remains inert advice'], operations, receipts, transmissions, observations, terminalState: 'proposal_advice_available', illegalTransition: false});
  }
  return result({verdict: 'fail', codes: ['adapter.retry_exhausted'], outputs: [outputFor('adapter.retry_exhausted')], operations, receipts, transmissions, observations, terminalState: 'retry_exhausted', illegalTransition: false});
}
