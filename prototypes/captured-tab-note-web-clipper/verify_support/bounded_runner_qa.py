from __future__ import annotations

# noqa: SIZE_OK — explicit process-supervision integration matrix; the approved support-file ceiling is 600 lines.

import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import suppress
from pathlib import Path
from typing import Final, Literal, assert_never


FIXTURE: Final = r"""
import json
import os
import signal
import sys
import time
from pathlib import Path

mode, control_raw = sys.argv[1:]
control = Path(control_raw)
if mode in {"exited-leader", "long-group"}:
    ready_read, ready_write = os.pipe()
    descendant = os.fork()
    if descendant == 0:
        os.close(ready_read)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.write(ready_write, b"R")
        os.close(ready_write)
        while True:
            time.sleep(60)
    os.close(ready_write)
    if os.read(ready_read, 1) != b"R":
        os._exit(125)
    os.close(ready_read)
    control.write_text(
        f"{os.getpid()}\n{descendant}\n{os.getpgrp()}\n",
        encoding="utf-8",
    )
    if mode == "exited-leader":
        os._exit(0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.waitpid(descendant, 0)
elif mode == "child-contract":
    blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set())
    open_fds = []
    for fd in range(3, 64):
        try:
            os.fstat(fd)
        except OSError:
            continue
        open_fds.append(fd)
    print(json.dumps({
        "int_default": signal.getsignal(signal.SIGINT) in {signal.SIG_DFL, signal.default_int_handler},
        "term_default": signal.getsignal(signal.SIGTERM) == signal.SIG_DFL,
        "int_unblocked": signal.SIGINT not in blocked,
        "term_unblocked": signal.SIGTERM not in blocked,
        "open_fds": open_fds,
    }, sort_keys=True))
else:
    raise SystemExit(125)
"""

Delivery = Literal["parent", "group"]
Seam = Literal["dispatch-pretransition", "exiting-posttransition"]
PRIVATE_TEST_VARIABLES: Final = (
    "MDPLACE_VERIFY_INTERNAL_TEST",
    "MDPLACE_VERIFY_TEST_CONTROL_FILE",
    "MDPLACE_VERIFY_TEST_FAULT",
    "MDPLACE_VERIFY_TEST_HANDOFF",
    "MDPLACE_VERIFY_TEST_LATCH_FILE",
    "MDPLACE_VERIFY_TEST_READY_FD",
    "MDPLACE_VERIFY_TEST_SEAM",
)


def isolated_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for variable in PRIVATE_TEST_VARIABLES:
        environment.pop(variable, None)
    return environment


def pid_live(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def group_live(pgid: int) -> bool:
    if pgid <= 0:
        return False
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def absence(identity: tuple[int, int, int]) -> tuple[bool, bool, bool]:
    direct, descendant, pgid = identity
    return not pid_live(direct), not pid_live(descendant), not group_live(pgid)


def wait_for_absence(identity: tuple[int, int, int]) -> bool:
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if all(absence(identity)):
            return True
        time.sleep(0.01)
    return all(absence(identity))


def wait_for_identity(path: Path, process: subprocess.Popen[bytes]) -> tuple[int, int, int]:
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if path.exists():
            values = path.read_text(encoding="utf-8").splitlines()
            if len(values) == 3 and all(value.isdigit() for value in values):
                return int(values[0]), int(values[1]), int(values[2])
        if process.poll() is not None:
            return -1, -1, -1
        time.sleep(0.005)
    return -1, -1, -1


def read_event(fd: int, expected: bytes, timeout: float) -> bool:
    ready, _, _ = select.select([fd], [], [], timeout)
    return bool(ready) and os.read(fd, len(expected)) == expected


def status_of(returncode: int | None) -> int:
    match returncode:
        case int(raw):
            return raw if raw >= 0 else 128 - raw
        case None:
            return -999
        case unreachable:
            assert_never(unreachable)


def fallback_cleanup(process: subprocess.Popen[bytes], identity: tuple[int, int, int]) -> bool:
    if process.poll() is None:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2.0)
    if group_live(identity[2]):
        with suppress(ProcessLookupError):
            os.killpg(identity[2], signal.SIGKILL)
    return wait_for_absence(identity)


def supervisor_command(runner: Path, root: Path, timeout: str, mode: str) -> list[str]:
    return [
        sys.executable,
        str(runner),
        timeout,
        str(root / "stdout"),
        str(root / "stderr"),
        sys.executable,
        "-c",
        FIXTURE,
        mode,
        str(root / "control"),
    ]


def run_final_case(runner: Path, seam: Seam, signum: signal.Signals, delivery: Delivery) -> bool:
    with tempfile.TemporaryDirectory(prefix="mdplace-final-seam-") as temporary:
        root = Path(temporary)
        read_fd, write_fd = os.pipe()
        env = isolated_environment()
        env.update({
            "MDPLACE_VERIFY_INTERNAL_TEST": "1",
            "MDPLACE_VERIFY_TEST_READY_FD": str(write_fd),
            "MDPLACE_VERIFY_TEST_SEAM": seam,
        })
        process = subprocess.Popen(
            supervisor_command(runner, root, "5", "exited-leader"),
            env=env,
            pass_fds=(write_fd,),
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        os.close(write_fd)
        identity = (-1, -1, -1)
        supervisor_stderr = b""
        precondition = cleanup_transition = repeat_delivered = False
        immediate_clean = fallback_used = False
        try:
            seam_ready = read_event(read_fd, b"SEAM\n", 3.0)
            if seam_ready:
                waited_pid, wait_status = os.waitpid(process.pid, os.WUNTRACED)
                stopped = waited_pid == process.pid and os.WIFSTOPPED(wait_status)
            else:
                stopped = False
            identity = wait_for_identity(root / "control", process)
            state = subprocess.run(
                ["ps", "-o", "stat=", "-p", str(identity[1])],
                check=False,
                capture_output=True,
                text=True,
            ).stdout.strip()
            precondition = (
                seam_ready
                and stopped
                and not pid_live(identity[0])
                and pid_live(identity[1])
                and bool(state)
                and "Z" not in state
                and group_live(identity[2])
            )
            if precondition:
                match delivery:
                    case "parent":
                        os.kill(process.pid, signum)
                    case "group":
                        os.killpg(process.pid, signum)
                    case unreachable:
                        assert_never(unreachable)
                os.kill(process.pid, signal.SIGCONT)
                cleanup_transition = read_event(read_fd, b"CLEANUP\n", 2.0)
                if cleanup_transition:
                    try:
                        match delivery:
                            case "parent":
                                os.kill(process.pid, signum)
                            case "group":
                                os.killpg(process.pid, signum)
                            case unreachable:
                                assert_never(unreachable)
                    except ProcessLookupError:
                        repeat_delivered = False
                    else:
                        repeat_delivered = True
            _, supervisor_stderr = process.communicate(timeout=4.0)
            immediate_clean = all(absence(identity))
        finally:
            os.close(read_fd)
            fallback_used = process.poll() is None or group_live(identity[2])
            cleanup_clean = fallback_cleanup(process, identity)
        expected_status = 128 + signum
        passed = (
            precondition
            and cleanup_transition
            and repeat_delivered
            and status_of(process.returncode) == expected_status
            and immediate_clean
            and not fallback_used
            and cleanup_clean
            and not supervisor_stderr
        )
        print(json.dumps({
            "case": f"final-{seam}-{signum.name}-{delivery}",
            "cleanup_transition": cleanup_transition,
            "expected_status": expected_status,
            "harness_fallback_cleanup_used": fallback_used,
            "immediate_group_absence": immediate_clean,
            "precondition": precondition,
            "repeated_signal_delivered": repeat_delivered,
            "shell_status": status_of(process.returncode),
            "verdict": "PASS" if passed else "FAIL",
        }, sort_keys=True))
        return passed


def run_status_cases(runner: Path) -> list[bool]:
    results: list[bool] = []
    with tempfile.TemporaryDirectory(prefix="mdplace-runner-status-") as temporary:
        root = Path(temporary)
        cases = (
            ("normal", (sys.executable, "-c", "print('ok')"), 0),
            ("nonzero", (sys.executable, "-c", "raise SystemExit(7)"), 7),
            ("popen-failure", (str(root / "missing-command"),), 1),
        )
        for name, command, expected in cases:
            case_root = root / name
            case_root.mkdir()
            completed = subprocess.run(
                [sys.executable, str(runner), "3", str(case_root / "stdout"), str(case_root / "stderr"), *command],
                env=isolated_environment(),
                check=False,
                capture_output=True,
            )
            passed = status_of(completed.returncode) == expected
            results.append(passed)
            print(json.dumps({"case": name, "shell_status": status_of(completed.returncode), "verdict": "PASS" if passed else "FAIL"}, sort_keys=True))
        marker = root / "open-failure-command-ran"
        completed = subprocess.run(
            [sys.executable, str(runner), "3", str(root / "absent/out"), str(root / "stderr"), sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).touch()"],
            env=isolated_environment(),
            check=False,
            capture_output=True,
        )
        passed = completed.returncode != 0 and not marker.exists()
        results.append(passed)
        print(json.dumps({"case": "open-failure", "command_started": marker.exists(), "shell_status": status_of(completed.returncode), "verdict": "PASS" if passed else "FAIL"}, sort_keys=True))
        contract_root = root / "child-contract"
        contract_root.mkdir()
        completed = subprocess.run(
            supervisor_command(runner, contract_root, "3", "child-contract"),
            env=isolated_environment(),
            check=False,
            capture_output=True,
        )
        contract = json.loads((contract_root / "stdout").read_text(encoding="utf-8"))
        passed = completed.returncode == 0 and contract == {"int_default": True, "term_default": True, "int_unblocked": True, "term_unblocked": True, "open_fds": []}
        results.append(passed)
        print(json.dumps({"case": "child-signal-mask-disposition-fd-closure", "observation": contract, "verdict": "PASS" if passed else "FAIL"}, sort_keys=True))
    return results


def run_timeout_case(runner: Path) -> bool:
    with tempfile.TemporaryDirectory(prefix="mdplace-runner-timeout-") as temporary:
        root = Path(temporary)
        process = subprocess.Popen(
            supervisor_command(runner, root, "1", "long-group"),
            env=isolated_environment(),
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        identity = wait_for_identity(root / "control", process)
        _, stderr = process.communicate(timeout=4.0)
        immediate_clean = all(absence(identity))
        fallback_used = process.poll() is None or group_live(identity[2])
        cleanup_clean = fallback_cleanup(process, identity)
        passed = status_of(process.returncode) == 124 and immediate_clean and not fallback_used and cleanup_clean and not stderr
        print(json.dumps({"case": "timeout", "harness_fallback_cleanup_used": fallback_used, "immediate_group_absence": immediate_clean, "shell_status": status_of(process.returncode), "verdict": "PASS" if passed else "FAIL"}, sort_keys=True))
        return passed


def run_forged_and_invalid_cases(runner: Path) -> list[bool]:
    with tempfile.TemporaryDirectory(prefix="mdplace-runner-private-") as temporary:
        root = Path(temporary)
        read_fd, write_fd = os.pipe()
        forged_env = isolated_environment()
        forged_env.update({
            "MDPLACE_VERIFY_TEST_SEAM": "forged",
            "MDPLACE_VERIFY_TEST_HANDOFF": "forged",
            "MDPLACE_VERIFY_TEST_READY_FD": str(write_fd),
            "MDPLACE_VERIFY_TEST_CONTROL_FILE": str(root / "control-forged"),
            "MDPLACE_VERIFY_TEST_LATCH_FILE": str(root / "latch-forged"),
            "MDPLACE_VERIFY_TEST_FAULT": "cleanup-omission",
        })
        forged = subprocess.run(
            [sys.executable, str(runner), "3", str(root / "forged.stdout"), str(root / "forged.stderr"), sys.executable, "-c", "raise SystemExit(0)"],
            env=forged_env,
            pass_fds=(write_fd,),
            check=False,
            capture_output=True,
        )
        os.close(write_fd)
        forged_event = os.read(read_fd, 1)
        os.close(read_fd)
        forged_passed = forged.returncode == 0 and not forged_event and not (root / "latch-forged").exists()
        invalid_env = isolated_environment()
        invalid_env.update({"MDPLACE_VERIFY_INTERNAL_TEST": "1", "MDPLACE_VERIFY_TEST_SEAM": "invalid"})
        invalid = subprocess.run(
            [sys.executable, str(runner), "3", str(root / "invalid.stdout"), str(root / "invalid.stderr"), sys.executable, "-c", "raise SystemExit(0)"],
            env=invalid_env,
            check=False,
            capture_output=True,
        )
        invalid_passed = invalid.returncode == 64
        print(json.dumps({"case": "forged-private-controls-without-gate", "ready_event": bool(forged_event), "shell_status": status_of(forged.returncode), "verdict": "PASS" if forged_passed else "FAIL"}, sort_keys=True))
        print(json.dumps({"case": "invalid-private-seam-fails-closed", "shell_status": status_of(invalid.returncode), "verdict": "PASS" if invalid_passed else "FAIL"}, sort_keys=True))
        return [forged_passed, invalid_passed]


def run_cleanup_omission_case(runner: Path) -> bool:
    with tempfile.TemporaryDirectory(prefix="mdplace-cleanup-omission-") as temporary:
        root = Path(temporary)
        env = isolated_environment()
        env.update({"MDPLACE_VERIFY_INTERNAL_TEST": "1", "MDPLACE_VERIFY_TEST_FAULT": "cleanup-omission"})
        process = subprocess.Popen(supervisor_command(runner, root, "5", "long-group"), env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        identity = wait_for_identity(root / "control", process)
        precondition = pid_live(identity[0]) and pid_live(identity[1]) and group_live(identity[2])
        os.kill(process.pid, signal.SIGTERM)
        _, stderr = process.communicate(timeout=3.0)
        production_absence = absence(identity)
        production_assertion_passed = status_of(process.returncode) == 143 and all(production_absence)
        mutation_detected = status_of(process.returncode) == 143 and precondition and not any(production_absence) and not production_assertion_passed
        fallback_used = group_live(identity[2])
        fallback_clean = fallback_cleanup(process, identity)
        passed = mutation_detected and fallback_used and fallback_clean and not stderr
        print(json.dumps({
            "case": "cleanup-omission",
            "harness_fallback_cleanup_clean": fallback_clean,
            "harness_fallback_cleanup_used": fallback_used,
            "mutation_detected": mutation_detected,
            "precondition": precondition,
            "production_assertion_passed": production_assertion_passed,
            "production_descendant_absence": production_absence[1],
            "production_direct_absence": production_absence[0],
            "production_group_absence": production_absence[2],
            "shell_status": status_of(process.returncode),
            "verdict": "PASS" if passed else "FAIL",
        }, sort_keys=True))
        return passed


runner_path = Path(sys.argv[1])
results = [
    run_final_case(runner_path, seam, signum, delivery)
    for seam in ("dispatch-pretransition", "exiting-posttransition")
    for signum in (signal.SIGINT, signal.SIGTERM)
    for delivery in ("parent", "group")
]
results.extend(run_status_cases(runner_path))
results.append(run_timeout_case(runner_path))
results.extend(run_forged_and_invalid_cases(runner_path))
results.append(run_cleanup_omission_case(runner_path))
print(json.dumps({"event": "summary", "passed": sum(results), "total": len(results), "verdict": "PASS" if all(results) else "FAIL"}, sort_keys=True))
raise SystemExit(0 if all(results) else 1)
