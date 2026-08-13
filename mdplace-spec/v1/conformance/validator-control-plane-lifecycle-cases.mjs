import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {validateAgainstSchemaPath} from './json-schema.mjs';
import {checkControlPlaneLifecycle} from './control-plane-lifecycle-checks.mjs';
import {checkTransitionTable} from './package-checks.mjs';
import {buildValidationReport} from './validation-report.mjs';
import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const profilePath = 'contracts/control-plane/launchagent-supervision-profile.json';
const profileSchemaPath = 'contracts/schemas/launchagent-supervision-profile.schema.json';
const lifecyclePath = 'contracts/transitions/launchagent-supervision-lifecycle.json';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
}

async function readPackageJson(packageRoot, path) {
  return JSON.parse(await readFile(join(packageRoot, path), 'utf8'));
}

async function writePackageJson(packageRoot, path, value) {
  await writeFile(join(packageRoot, path), `${JSON.stringify(value, null, 2)}\n`);
}

function lifecycleCheck(report) {
  const check = report.checks.find(({id}) => id === 'control-plane-lifecycle');
  assert.ok(check, 'validation report must include the focused lifecycle check');
  return check;
}

function transition(table, state, command) {
  const found = table.transitions.find((row) =>
    row.from_state === state && row.command_or_event === command,
  );
  assert.ok(found, `missing ${state}:${command}`);
  return found;
}

test('LaunchAgent supervision profile is closed, bounded, and wake-safe', async () => {
  const profile = await readJson(profilePath);

  assert.deepEqual(
    await validateAgainstSchemaPath(packageRoot, profileSchemaPath, profile),
    [],
  );
  assert.equal(profile.max_automatic_restart_attempts, 3);
  assert.deepEqual(profile.automatic_restart_delay_ticks, [1000, 5000, 30000]);
  assert.deepEqual(profile.wake_revalidation.checks, [
    'exclusive_writer', 'vault_filesystem', 'filesystem_drift',
  ]);
  assert.equal(profile.wake_revalidation.work_admission_while_pending, 'diagnostic_only');
  assert.equal(profile.wake_revalidation.work_admission_after_pass, 'work_admitting');
  assert.equal(profile.persistent_circuit_breaker.storage, 'durable_agent_state');
  assert.equal(profile.persistent_circuit_breaker.requires_owner_approval, true);
});

test('LaunchAgent supervision rejects unsafe backoff and circuit policies', async () => {
  const profile = await readJson(profilePath);
  const invalidProfiles = [
    {...profile, automatic_restart_delay_ticks: [1000, 5000, 30000, 60000]},
    {...profile, automatic_restart_delay_ticks: [1000, 30000, 5000]},
    {
      ...profile,
      wake_revalidation: {
        ...profile.wake_revalidation,
        checks: ['exclusive_writer', 'vault_filesystem'],
      },
    },
  ];

  for (const invalid of invalidProfiles) {
    assert.notDeepEqual(
      await validateAgainstSchemaPath(packageRoot, profileSchemaPath, invalid),
      [],
    );
  }
});

test('LaunchAgent supervision ceiling rejects a fourth automatic restart and nonpersistent breaker', async () => {
  const [profile, table] = await Promise.all([readJson(profilePath), readJson(lifecyclePath)]);
  const fourthAutomaticRestart = {...profile, max_automatic_restart_attempts: 4};
  const processLocalBreaker = {
    ...profile,
    persistent_circuit_breaker: {...profile.persistent_circuit_breaker, storage: 'process_memory'},
  };

  assert.notDeepEqual(
    await validateAgainstSchemaPath(packageRoot, profileSchemaPath, fourthAutomaticRestart),
    [],
  );
  assert.notDeepEqual(
    await validateAgainstSchemaPath(packageRoot, profileSchemaPath, processLocalBreaker),
    [],
  );
  assert.equal(
    transition(table, 'circuit_open', 'backoff_elapsed').failure_result.code,
    'control.restart_ceiling_reached',
  );
});

test('LaunchAgent supervision lifecycle is a complete authority-bound matrix', async () => {
  const table = await readJson(lifecyclePath);
  const checked = checkTransitionTable(table, 'launchagent-supervision');

  assert.deepEqual(checked.codes, []);
  assert.equal(table.transitions.length, table.states.length * table.commands.length);
  assert.equal(new Set(table.transitions.map((row) =>
    `${row.from_state}:${row.command_or_event}`,
  )).size, table.states.length * table.commands.length);
  for (const row of table.transitions) {
    assert.equal(row.failure_result.state_effect, 'unchanged');
  }
  assert.deepEqual(
    transition(table, 'circuit_open', 'approve_owner_recovery').actor_authority.roles,
    ['vault_owner'],
  );
  assert.deepEqual(
    transition(table, 'supervised', 'unexpected_exit').actor_authority.roles,
    ['operating_system'],
  );

  const wrongActor = structuredClone(table);
  transition(wrongActor, 'circuit_open', 'approve_owner_recovery').actor_authority = {
    roles: ['control_client'], quorum: 1, distinct_actors: false, delegation: 'forbidden',
  };
  assert.ok(checkTransitionTable(wrongActor, 'wrong-supervision-authority').codes
    .includes('transition.ambiguous_authority'));

  const missingPair = structuredClone(table);
  missingPair.transitions.pop();
  assert.ok(checkTransitionTable(missingPair, 'incomplete-supervision-matrix').codes
    .includes('transition.incomplete_matrix'));
});

test('LaunchAgent supervision enforces bounded backoff, wake checks, and owner recovery', async () => {
  const table = await readJson(lifecyclePath);

  const unexpectedExit = transition(table, 'supervised', 'unexpected_exit');
  assert.equal(unexpectedExit.allowed, true);
  assert.equal(unexpectedExit.terminal_state, 'backoff');
  assert.ok(unexpectedExit.preconditions.includes(
    'the persisted automatic restart attempt count is below the profile maximum',
  ));
  assert.ok(unexpectedExit.preconditions.includes(
    'work admission changes to diagnostic_only before restart scheduling',
  ));

  const finalFailure = transition(table, 'backoff', 'restart_ceiling_reached');
  assert.equal(finalFailure.allowed, true);
  assert.equal(finalFailure.terminal_state, 'circuit_open');
  assert.ok(finalFailure.emitted_records.includes('PersistentCircuitBreakerTripReceipt'));

  const afterCeiling = transition(table, 'circuit_open', 'backoff_elapsed');
  assert.equal(afterCeiling.allowed, false);
  assert.equal(afterCeiling.failure_result.code, 'control.restart_ceiling_reached');

  const wake = transition(table, 'supervised', 'wake_revalidate');
  assert.equal(wake.allowed, true);
  assert.equal(wake.terminal_state, 'recovering');
  assert.deepEqual(wake.preconditions.slice(-3), [
    'wake revalidation observes the retained Exclusive Writer Lock',
    'wake revalidation observes the bound vault filesystem profile',
    'wake revalidation observes the current filesystem drift result',
  ]);
  assert.ok(wake.filesystem_effects.includes('no work admission while wake validation is pending'));

  const approval = transition(table, 'circuit_open', 'approve_owner_recovery');
  assert.equal(approval.allowed, true);
  assert.equal(approval.terminal_state, 'recovering');
  assert.ok(approval.preconditions.includes('a durable doctor report binds the current circuit version'));
  assert.ok(approval.preconditions.includes('the vault owner approval binds that doctor report and recovery action'));

  const recovery = transition(table, 'recovering', 'complete_recovery');
  assert.equal(recovery.allowed, true);
  assert.equal(recovery.terminal_state, 'supervised');
  assert.ok(recovery.preconditions.includes('all three wake revalidation checks passed for the same persistent Agent core'));
});

test('control-plane lifecycle checker accepts canonical bound supervision evidence', async () => {
  assert.deepEqual(await checkControlPlaneLifecycle(packageRoot), {
    id: 'control-plane-lifecycle', verdict: 'pass', codes: [],
  });
});

test('control-plane lifecycle permits doctor-backed circuit state before owner approval', async () => {
  const copiedPackage = await copyCommittedPackage();
  const [agent, lifecycleReport] = await Promise.all([
    readPackageJson(copiedPackage, 'contracts/control-plane/agent-state.json'),
    readPackageJson(copiedPackage, 'conformance/evidence/control-plane-lifecycle-report.json'),
  ]);
  agent.state = 'blocked';
  agent.control_channel_state = 'diagnostic_only';
  agent.supervision_state = {
    state: 'circuit_open',
    automatic_restart_attempt_count: 3,
    next_restart_tick: null,
    circuit: {
      version: 3,
      state: 'open',
      storage: 'durable_agent_state',
      failure_count: 3,
      trip_threshold: 3,
      trip_receipt_digest: 'a'.repeat(64),
    },
  };
  agent.wake_revalidation.verdict = 'pending';
  agent.doctor_report = {
    report_id: lifecycleReport.doctor_report_binding.report_id,
    digest: lifecycleReport.doctor_report_binding.sha256,
  };
  agent.owner_recovery_authorization = null;
  await writePackageJson(copiedPackage, 'contracts/control-plane/agent-state.json', agent);

  assert.deepEqual(await checkControlPlaneLifecycle(copiedPackage), {
    id: 'control-plane-lifecycle', verdict: 'pass', codes: [],
  });
});

test('public validator rejects lifecycle boundary mutations with granular codes', async () => {
  const mutations = [
    {
      code: 'control.lifecycle_backoff_invalid',
      path: profilePath,
      mutate(profile) {
        profile.automatic_restart_delay_ticks = [1000, 5000, 10000];
      },
    },
    {
      code: 'control.lifecycle_wake_invalid',
      path: profilePath,
      mutate(profile) {
        profile.wake_revalidation.checks = ['vault_filesystem', 'exclusive_writer', 'filesystem_drift'];
      },
    },
    {
      code: 'control.lifecycle_breaker_invalid',
      path: profilePath,
      mutate(profile) {
        profile.persistent_circuit_breaker.storage = 'process_memory';
      },
    },
    {
      code: 'control.lifecycle_doctor_incomplete',
      path: 'conformance/evidence/control-plane-doctor-report.json',
      mutate(doctor) {
        doctor.readiness_observations.pop();
      },
    },
    {
      code: 'control.lifecycle_recovery_approval_invalid',
      path: 'conformance/evidence/control-plane-lifecycle-report.json',
      mutate(report) {
        report.vault_owner_recovery_approval.authenticated = false;
      },
    },
  ];

  for (const mutation of mutations) {
    const copiedPackage = await copyCommittedPackage();
    const document = await readPackageJson(copiedPackage, mutation.path);
    mutation.mutate(document);
    await writePackageJson(copiedPackage, mutation.path, document);

    const focused = await checkControlPlaneLifecycle(copiedPackage);
    assert.equal(focused.verdict, 'fail');
    assert.ok(focused.codes.includes(mutation.code), mutation.code);

    const report = await buildValidationReport(copiedPackage);
    assert.ok(lifecycleCheck(report).codes.includes(mutation.code), mutation.code);
    const cli = runPreparedPackage(copiedPackage);
    assert.equal(cli.status, 1);
    assert.ok(lifecycleCheck(JSON.parse(cli.stdout)).codes.includes(mutation.code), mutation.code);
  }
});
