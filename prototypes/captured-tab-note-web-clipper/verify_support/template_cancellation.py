from __future__ import annotations

# noqa: SIZE_OK — explicit parent-cancellation integration matrix; the approved support-file ceiling is 600 lines.

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path
from typing import Final, Literal, assert_never


Phase = Literal['launch', 'wait']
MAX_DELIVERY_ATTEMPTS: Final = 3
PRIVATE_TEST_VARIABLES: Final = (
    'MDPLACE_VERIFY_INTERNAL_TEST',
    'MDPLACE_VERIFY_TEST_CONTROL_FILE',
    'MDPLACE_VERIFY_TEST_FAULT',
    'MDPLACE_VERIFY_TEST_HANDOFF',
    'MDPLACE_VERIFY_TEST_LATCH_FILE',
    'MDPLACE_VERIFY_TEST_READY_FD',
    'MDPLACE_VERIFY_TEST_SEAM',
)

verifier = Path(sys.argv[1])
upstream = Path(sys.argv[2])
fixture_root = Path(sys.argv[3]) / 'parent-cancellation-fixture'
fixture_root.mkdir()
real_node = shutil.which('node')
if real_node is None:
    raise SystemExit('node unavailable')

wrapper_source = r'''#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "$QA_TARGET_CLI" ]]; then
    trap '' INT TERM
    (
        trap '' INT TERM
        while :; do
            sleep 60
        done
    ) &
    descendant_pid=$!
    pgid="$BASHPID"
    printf '%s\n%s\n%s\n' "$BASHPID" "$descendant_pid" "$pgid" > "$MDPLACE_VERIFY_TEST_CONTROL_FILE"
    wait "$descendant_pid"
fi
exec "$QA_REAL_NODE" "$@"
'''


def isolated_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for variable in PRIVATE_TEST_VARIABLES:
        environment.pop(variable, None)
    return environment


def pid_live(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def group_live(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def absence_snapshot(direct: int, descendant: int, pgid: int) -> tuple[bool, bool, bool]:
    return (
        direct > 0 and not pid_live(direct),
        descendant > 0 and not pid_live(descendant),
        pgid > 0 and not group_live(pgid),
    )


def wait_for_record(path: Path, process: subprocess.Popen[bytes]) -> list[int]:
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return []
        if path.exists():
            values = path.read_text(encoding='utf-8').splitlines()
            if len(values) == 3 and all(value.isdigit() for value in values):
                return [int(value) for value in values]
        time.sleep(0.005)
    return []


def wait_for_latch(path: Path, process: subprocess.Popen[bytes]) -> bool:
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        if path.exists():
            return True
        time.sleep(0.005)
    return False


def wait_for_signal_observation(path: Path, process: subprocess.Popen[bytes]) -> bool:
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        if path.exists() and 'signal' in path.read_text(encoding='utf-8').splitlines():
            return True
        time.sleep(0.005)
    return False


def run_case(
    phase: Phase,
    signum: signal.Signals,
    attempt: int = 1,
    *,
    expect_cleanup_omission: bool = False,
) -> bool:
    case_prefix = 'cleanup-omission-' if expect_cleanup_omission else ''
    case_root = fixture_root / f'{case_prefix}{phase}-{signum.name}-attempt-{attempt}'
    case_root.mkdir()
    bin_dir = case_root / 'bin'
    bin_dir.mkdir()
    wrapper = bin_dir / 'node'
    wrapper.write_text(wrapper_source, encoding='utf-8')
    wrapper.chmod(0o755)
    control = case_root / 'control'
    latch = case_root / 'latch'
    child_tmp = case_root / 'tmp'
    child_tmp.mkdir()
    env = isolated_environment()
    env.update({
        'MDPLACE_VERIFY_INTERNAL_TEST': '1',
        'MDPLACE_VERIFY_TEST_CONTROL_FILE': str(control),
        'MDPLACE_VERIFY_TEST_HANDOFF': phase,
        'MDPLACE_VERIFY_TEST_LATCH_FILE': str(latch),
        'QA_REAL_NODE': real_node,
        'QA_TARGET_CLI': str(upstream / 'dist/cli.cjs'),
        'MDPLACE_VERIFY_TIMEOUT_SECONDS': '2',
        'PATH': f'{bin_dir}:{env["PATH"]}',
        'TMPDIR': str(child_tmp),
        'WEB_CLIPPER_DIR': str(upstream),
    })
    if expect_cleanup_omission:
        env['MDPLACE_VERIFY_TEST_FAULT'] = 'cleanup-omission'
    env.pop('MDPLACE_EVIDENCE_DIR', None)
    process = subprocess.Popen(
        ['bash', str(verifier), 'template'],
        cwd=verifier.parent,
        env=env,
        start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    direct = descendant = command_pgid = -1
    stdout = stderr = b''
    elapsed = 99.0
    signal_delivered = True
    signal_observed = False
    repeated_signal_delivered = False
    stopped = phase == 'wait'
    communication_timed_out = False
    production_direct_absent = False
    production_descendant_absent = False
    production_group_absent = False
    production_snapshot_captured = False
    harness_fallback_cleanup_used = False
    harness_fallback_cleanup_clean = False
    try:
        record = wait_for_record(control, process)
        if len(record) == 3:
            direct, descendant, command_pgid = record
        latched = wait_for_latch(latch, process)
        if phase == 'launch' and latched:
            waited_pid, wait_status = os.waitpid(process.pid, os.WUNTRACED)
            stopped = waited_pid == process.pid and os.WIFSTOPPED(wait_status)
        precondition = (
            latched
            and stopped
            and pid_live(direct)
            and pid_live(descendant)
            and group_live(command_pgid)
        )
        forced_late_delivery = (
            attempt == 1
            and phase == 'wait'
            and signum == signal.SIGINT
        )
        started = time.monotonic()
        if forced_late_delivery:
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                signal_delivered = False
            else:
                process.wait(timeout=3.0)
        if signal_delivered:
            try:
                os.kill(process.pid, signum)
            except ProcessLookupError:
                signal_delivered = False
            else:
                if phase == 'launch':
                    os.kill(process.pid, signal.SIGCONT)
                signal_observed = wait_for_signal_observation(latch, process)
                if signal_observed:
                    try:
                        os.kill(process.pid, signum)
                    except ProcessLookupError:
                        repeated_signal_delivered = False
                    else:
                        repeated_signal_delivered = True
        try:
            stdout, stderr = process.communicate(timeout=3.0)
        except subprocess.TimeoutExpired:
            communication_timed_out = True
        elapsed = time.monotonic() - started
        (
            production_direct_absent,
            production_descendant_absent,
            production_group_absent,
        ) = absence_snapshot(direct, descendant, command_pgid)
        production_snapshot_captured = True
    finally:
        if process.poll() is None:
            harness_fallback_cleanup_used = True
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2.0)
        if command_pgid > 0 and group_live(command_pgid):
            harness_fallback_cleanup_used = True
            with suppress(ProcessLookupError):
                os.killpg(command_pgid, signal.SIGKILL)
        fallback_deadline = time.monotonic() + 2.0
        while True:
            fallback_snapshot = absence_snapshot(direct, descendant, command_pgid)
            if all(fallback_snapshot) or not harness_fallback_cleanup_used:
                break
            if time.monotonic() >= fallback_deadline:
                break
            time.sleep(0.01)
        harness_fallback_cleanup_clean = all(fallback_snapshot)

    if communication_timed_out:
        stdout, stderr = process.communicate(timeout=2.0)

    returncode = process.returncode
    match returncode:
        case int(raw_returncode):
            shell_status = raw_returncode if raw_returncode >= 0 else 128 - raw_returncode
        case None:
            shell_status = -999
        case unreachable:
            assert_never(unreachable)
    temp_entries = sorted(path.name for path in child_tmp.glob('mdplace-clipper-verify.*'))
    production_cleanup_clean = (
        production_snapshot_captured
        and production_direct_absent
        and production_descendant_absent
        and production_group_absent
    )
    vitest_absent = not (upstream / 'src/utils/mdplace-template-compiler.verify.test.ts').exists()
    expected_status = 128 + signum
    common_assertions = (
        precondition
        and elapsed < 1.0
        and production_cleanup_clean
        and not harness_fallback_cleanup_used
        and harness_fallback_cleanup_clean
        and not temp_entries
        and vitest_absent
        and not stderr
        and not communication_timed_out
        and len(stdout) <= 65536
    )
    production_assertion_passed = (
        signal_delivered
        and signal_observed
        and repeated_signal_delivered
        and common_assertions
        and shell_status == expected_status
    )
    late_delivery_safe = (
        not signal_delivered
        and common_assertions
        and shell_status == (expected_status if forced_late_delivery else 1)
    )
    should_retry = (
        not expect_cleanup_omission
        and late_delivery_safe
        and attempt < MAX_DELIVERY_ATTEMPTS
    )
    mutation_detected = (
        expect_cleanup_omission
        and signal_delivered
        and precondition
        and elapsed < 1.0
        and production_snapshot_captured
        and not production_cleanup_clean
        and not production_direct_absent
        and not production_descendant_absent
        and not production_group_absent
        and harness_fallback_cleanup_used
        and harness_fallback_cleanup_clean
        and not temp_entries
        and vitest_absent
        and not stderr
        and not communication_timed_out
        and signal_observed
        and repeated_signal_delivered
        and len(stdout) <= 65536
        and shell_status == expected_status
        and not production_assertion_passed
    )
    passed = mutation_detected if expect_cleanup_omission else production_assertion_passed
    print(json.dumps({
        'attempt': attempt,
        'case': f'{case_prefix}{phase}-{signum.name}-attempt-{attempt}',
        'communication_timed_out': communication_timed_out,
        'delivery': 'pid' if signal_delivered else 'late-process-absent',
        'direct_pid': direct,
        'descendant_pid': descendant,
        'elapsed_seconds': round(elapsed, 6),
        'expected_status': expected_status,
        'forced_late_delivery': forced_late_delivery,
        'harness_fallback_cleanup_clean': harness_fallback_cleanup_clean,
        'harness_fallback_cleanup_used': harness_fallback_cleanup_used,
        'immediate_group_absence': production_cleanup_clean,
        'mutation_detected': mutation_detected,
        'precondition': precondition,
        'production_assertion_passed': production_assertion_passed,
        'production_descendant_absence': production_descendant_absent,
        'production_direct_absence': production_direct_absent,
        'production_group_absence': production_group_absent,
        'production_snapshot_captured': production_snapshot_captured,
        'raw_returncode': returncode,
        'shell_status': shell_status,
        'private_handoff': phase,
        'repeated_signal_delivered': repeated_signal_delivered,
        'signal_observed': signal_observed,
        'status_matches_expected': shell_status == expected_status,
        'stderr_bytes': len(stderr),
        'stdout_bytes': len(stdout),
        'temp_entries_after_return': temp_entries,
        'vitest_absent_after_return': vitest_absent,
        'verdict': 'PASS' if passed else 'RETRY' if should_retry else 'FAIL',
    }, sort_keys=True))
    if should_retry:
        return run_case(
            phase,
            signum,
            attempt + 1,
            expect_cleanup_omission=expect_cleanup_omission,
        )
    return passed


print(json.dumps({
    'event': 'private_test_contract',
    'internal_gate': True,
    'surface': 'bash verify.sh template',
}, sort_keys=True))
mutation_control = run_case(
    'wait',
    signal.SIGTERM,
    expect_cleanup_omission=True,
)
print(json.dumps({
    'event': 'cleanup_omission_mutation',
    'passed': int(mutation_control),
    'total': 1,
    'verdict': 'PASS' if mutation_control else 'FAIL',
}, sort_keys=True))
results = [
    run_case(phase, signum)
    for phase in ('wait', 'launch')
    for signum in (signal.SIGINT, signal.SIGTERM)
]
print(json.dumps({
    'event': 'summary',
    'passed': sum(results),
    'total': len(results),
    'verdict': 'PASS' if all(results) else 'FAIL',
}, sort_keys=True))
raise SystemExit(0 if mutation_control and all(results) else 1)
