from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from contextlib import suppress
from enum import Enum, auto
from types import FrameType
from typing import assert_never


class ReceivedSignal(RuntimeError):
    def __init__(self, signum: int) -> None:
        self.signum = signum
        super().__init__(f'received signal {signum}')


class SupervisorPhase(Enum):
    SETUP = auto()
    ACQUIRING = auto()
    WAITING = auto()
    DISPATCHING = auto()
    CLEANUP = auto()
    EXITING = auto()


class TestSeam(Enum):
    DISPATCH_PRETRANSITION = 'dispatch-pretransition'
    EXITING_POSTTRANSITION = 'exiting-posttransition'


def parse_timeout(raw_timeout: str) -> int:
    try:
        timeout = int(raw_timeout)
    except ValueError as error:
        raise SystemExit(f'timeout must be a positive integer: {raw_timeout!r}') from error
    if timeout <= 0:
        raise SystemExit(f'timeout must be a positive integer: {raw_timeout!r}')
    return timeout


def shell_status(returncode: int) -> int:
    return returncode if returncode >= 0 else 128 - returncode


timeout_seconds = parse_timeout(sys.argv[1])
stdout_path = sys.argv[2]
stderr_path = sys.argv[3]
command = sys.argv[4:]
if not command:
    raise SystemExit('bounded command is required')

internal_test = os.environ.get('MDPLACE_VERIFY_INTERNAL_TEST') == '1'
test_seam: TestSeam | None = None
test_ready_fd: int | None = None
cleanup_omission = False
if internal_test:
    raw_test_seam = os.environ.get('MDPLACE_VERIFY_TEST_SEAM', '')
    test_seams: dict[str, TestSeam | None] = {
        '': None,
        TestSeam.DISPATCH_PRETRANSITION.value: TestSeam.DISPATCH_PRETRANSITION,
        TestSeam.EXITING_POSTTRANSITION.value: TestSeam.EXITING_POSTTRANSITION,
    }
    try:
        test_seam = test_seams[raw_test_seam]
    except KeyError:
        print(f'ERROR: invalid private runner seam: {raw_test_seam}', file=sys.stderr)
        raise SystemExit(64) from None
    raw_ready_fd = os.environ.get('MDPLACE_VERIFY_TEST_READY_FD', '')
    if raw_ready_fd:
        try:
            test_ready_fd = int(raw_ready_fd)
        except ValueError:
            print(f'ERROR: invalid private runner ready fd: {raw_ready_fd}', file=sys.stderr)
            raise SystemExit(64) from None
    if (test_seam is None) != (test_ready_fd is None):
        print('ERROR: private runner seam and ready fd must be set together', file=sys.stderr)
        raise SystemExit(64)
    raw_test_fault = os.environ.get('MDPLACE_VERIFY_TEST_FAULT', '')
    test_faults = {'': False, 'cleanup-omission': True}
    try:
        cleanup_omission = test_faults[raw_test_fault]
    except KeyError:
        print(f'ERROR: invalid private runner fault: {raw_test_fault}', file=sys.stderr)
        raise SystemExit(64) from None

grace_seconds = 0.25
group_reap_seconds = 2.0
process: subprocess.Popen[bytes] | None = None
received_signal: int | None = None
phase = SupervisorPhase.SETUP
cleanup_notified = False
handled_signals = {signal.SIGINT, signal.SIGTERM}
signal.pthread_sigmask(signal.SIG_BLOCK, handled_signals)
signal_read_fd, signal_write_fd = os.pipe()
os.set_blocking(signal_read_fd, False)
os.set_blocking(signal_write_fd, False)
os.set_inheritable(signal_read_fd, False)
os.set_inheritable(signal_write_fd, False)
signal.set_wakeup_fd(signal_write_fd, warn_on_full_buffer=False)


def signal_group(active_process: subprocess.Popen[bytes], signum: int) -> None:
    try:
        os.killpg(active_process.pid, signum)
    except (ProcessLookupError, PermissionError):
        return


def group_live(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_group(active_process: subprocess.Popen[bytes]) -> None:
    global cleanup_notified, phase
    phase = SupervisorPhase.CLEANUP
    if received_signal is not None:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if test_ready_fd is not None and not cleanup_notified:
        os.write(test_ready_fd, b'CLEANUP\n')
        cleanup_notified = True
    signal_group(active_process, signal.SIGTERM)
    with suppress(subprocess.TimeoutExpired):
        active_process.wait(timeout=grace_seconds)
    if cleanup_omission:
        return
    signal_group(active_process, signal.SIGKILL)
    if active_process.poll() is None:
        try:
            active_process.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired as error:
            raise SystemExit('command did not exit after process-group SIGKILL') from error
    deadline = time.monotonic() + group_reap_seconds
    while group_live(active_process.pid):
        if time.monotonic() >= deadline:
            raise SystemExit('command process group remained after SIGKILL')
        time.sleep(0.01)


def latch_test_seam(candidate: TestSeam) -> None:
    if test_seam is candidate and test_ready_fd is not None:
        os.write(test_ready_fd, b'SEAM\n')
        os.kill(os.getpid(), signal.SIGSTOP)


def receive_signal(signum: int, _frame: FrameType | None) -> None:
    global received_signal
    previous_handler_mask = signal.pthread_sigmask(signal.SIG_BLOCK, handled_signals)
    try:
        try:
            observed_signal = os.read(signal_read_fd, 1)
        except BlockingIOError:
            observed_signum = signum
        else:
            observed_signum = observed_signal[0] if observed_signal else signum
        if received_signal is not None:
            return
        received_signal = observed_signum
        match phase:
            case SupervisorPhase.SETUP:
                os._exit(128 + observed_signum)
            case SupervisorPhase.EXITING:
                if process is not None:
                    stop_group(process)
                os._exit(128 + observed_signum)
            case SupervisorPhase.ACQUIRING | SupervisorPhase.DISPATCHING:
                return
            case SupervisorPhase.WAITING:
                raise ReceivedSignal(observed_signum)
            case SupervisorPhase.CLEANUP:
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                return
            case unreachable:
                assert_never(unreachable)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_handler_mask)


signal.signal(signal.SIGINT, receive_signal)
signal.signal(signal.SIGTERM, receive_signal)
bootstrap_pending = signal.sigpending()
received_signal = next(
    (candidate for candidate in (signal.SIGINT, signal.SIGTERM) if candidate in bootstrap_pending),
    None,
)
signal.pthread_sigmask(signal.SIG_UNBLOCK, handled_signals)

try:
    phase = SupervisorPhase.ACQUIRING
    if received_signal is not None:
        raise ReceivedSignal(received_signal)
    with open(stdout_path, 'wb') as stdout_file, open(stderr_path, 'wb') as stderr_file:
        if received_signal is not None:
            raise ReceivedSignal(received_signal)
        process = subprocess.Popen(
            command,
            stdout=stdout_file,
            stderr=stderr_file,
            start_new_session=True,
        )
        phase = SupervisorPhase.WAITING
        try:
            if received_signal is not None:
                raise ReceivedSignal(received_signal)
            returncode = process.wait(timeout=timeout_seconds)
        finally:
            phase = SupervisorPhase.DISPATCHING
        if received_signal is not None:
            raise ReceivedSignal(received_signal)
        raise SystemExit(shell_status(returncode))
except subprocess.TimeoutExpired:
    if process is not None:
        stop_group(process)
    raise SystemExit(124)
except ReceivedSignal as interruption:
    if process is not None:
        stop_group(process)
    raise SystemExit(128 + interruption.signum)
finally:
    phase = SupervisorPhase.DISPATCHING
    if received_signal is not None:
        if process is not None:
            stop_group(process)
    latch_test_seam(TestSeam.DISPATCH_PRETRANSITION)
    phase = SupervisorPhase.EXITING
    latch_test_seam(TestSeam.EXITING_POSTTRANSITION)
    if received_signal is not None:
        if process is not None:
            stop_group(process)
        raise SystemExit(128 + received_signal)
