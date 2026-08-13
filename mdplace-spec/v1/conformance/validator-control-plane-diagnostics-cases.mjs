import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {observeControlPlaneScenario} from './control-plane-observer.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const blockedFixturePath = new URL(
  './scenarios/control-plane/readiness-work-journal-unavailable.json', import.meta.url,
);
const localControlFixturePath = new URL(
  './scenarios/control-plane/authenticated-local-control-access.json', import.meta.url,
);

async function fixture(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('diagnostic-only channel serves status and doctor while Agent remains blocked', async () => {
  const blocked = await fixture(blockedFixturePath);
  const local = await fixture(localControlFixturePath);
  const initial = structuredClone(blocked.subject.document.initial);
  initial.agent_state = 'blocked';
  initial.control_channel = {
    ...local.subject.document.initial.control_channel,
    state: 'diagnostic_only',
  };

  for (const commandKind of ['status', 'doctor']) {
    const action = structuredClone(local.subject.document.action);
    action.command_kind = commandKind;
    const result = await observeControlPlaneScenario({
      schema: local.subject.schema,
      document: {...local.subject.document, initial, action},
    }, packageRoot);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.terminal_state, 'blocked');
    assert.ok(result.outputs.includes('blocked_reason:control.readiness_journal_unavailable'));
    assert.ok(result.outputs.includes(`semantic_state_digest:${initial.semantic_state_digest}`));
    assert.deepEqual(result.filesystem_effects, ['none']);
  }
});

test('diagnostic-only channel rejects work admission', async () => {
  const blocked = await fixture(blockedFixturePath);
  const local = await fixture(localControlFixturePath);
  const initial = structuredClone(blocked.subject.document.initial);
  initial.agent_state = 'blocked';
  initial.control_channel = {
    ...local.subject.document.initial.control_channel,
    state: 'diagnostic_only',
  };
  const action = structuredClone(local.subject.document.action);
  action.command_kind = 'enqueue';
  const result = await observeControlPlaneScenario({
    schema: local.subject.schema,
    document: {...local.subject.document, initial, action},
  }, packageRoot);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.codes, ['control.work_admission_blocked']);
  assert.equal(result.terminal_state, 'blocked');
  assert.deepEqual(result.filesystem_effects, ['none']);
});

test('readiness and Control Channel contracts compose without a ready-before-open cycle', async () => {
  const [readiness, channel] = await Promise.all([
    fixture(new URL('../contracts/transitions/readiness-lifecycle.json', import.meta.url)),
    fixture(new URL('../contracts/transitions/control-channel-lifecycle.json', import.meta.url)),
  ]);
  const startingReady = readiness.transitions.find(({transition_id: id}) => id === 'TR-CPREADY-001');
  const diagnosticOpen = channel.transitions.find(({transition_id: id}) => id === 'TR-CPCHANNEL-001');
  assert.ok(startingReady.preconditions.some((condition) => condition.includes('six Readiness Gates')));
  assert.ok(startingReady.filesystem_effects.includes('promote Control Channel from diagnostic-only to work-admitting'));
  assert.ok(diagnosticOpen.preconditions.some((condition) => condition.includes('starting or blocked')));
  assert.ok(diagnosticOpen.preconditions.every((condition) => !condition.includes('Agent is ready')));
  assert.ok(diagnosticOpen.preconditions.every((condition) => !condition.includes('retains the Exclusive Writer Lock')));
  assert.ok(diagnosticOpen.preconditions.every((condition) => !condition.includes('peer credentials')));
  assert.ok(diagnosticOpen.base_references.every((reference) => !reference.includes('writer lock')));
  assert.ok(diagnosticOpen.base_references.every((reference) => !reference.includes('peer credentials')));
  assert.ok(diagnosticOpen.idempotency.key_fields.every((field) => !field.includes('writer lock')));
  assert.ok(diagnosticOpen.idempotency.key_fields.every((field) => !field.includes('peer credentials')));
  const diagnosticSubmit = channel.transitions.find(({from_state, command_or_event: command}) =>
    from_state === 'diagnostic_only' && command === 'submit_control_command',
  );
  assert.ok(diagnosticSubmit.preconditions.some((condition) => condition.includes('peer credentials')));
  const wakeDemotion = channel.transitions.find(({from_state, command_or_event: command}) =>
    from_state === 'work_admitting' && command === 'close_control_channel',
  );
  assert.equal(wakeDemotion.allowed, true);
  assert.equal(wakeDemotion.terminal_state, 'diagnostic_only');
  assert.ok(wakeDemotion.preconditions.some((condition) => condition.includes('wake revalidation')));
  assert.ok(wakeDemotion.filesystem_effects.includes(
    'atomically demote Control Channel from work-admitting to diagnostic-only',
  ));
  assert.ok(wakeDemotion.filesystem_effects.every((effect) => !effect.includes('remove')));
});
