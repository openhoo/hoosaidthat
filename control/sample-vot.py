#!/usr/bin/env python3
"""Read-only diagnostics during one test on a dedicated, already booted iPhone simulator."""
import argparse
import json
import os
import re
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path

LABEL = "com.apple.VoiceOverTouch"
EXE = "/System/Library/CoreServices/VoiceOverTouch.app/vot"
PREDICATE = ('process == "vot" OR '
             '(process == "testmanagerd" AND eventMessage CONTAINS[c] "VoiceOver") OR '
             '(process == "AccessibilityUIServer" AND category BEGINSWITH "AXSpeech")')

def select_pid(record, udid):
    """Accept only a running job in this simulator with the exact executable."""
    def field(pattern):
        m = re.search("^\\s*" + pattern + r"\s*=(?:>|)\s*(.*?)\s*$", record, re.M)
        return m[1] if m else ""
    pid = field("pid")
    if (field("state") == "running" and field("SIMULATOR_UDID").upper() == udid
            and field("XPC_SERVICE_NAME") == LABEL and field("program").endswith(EXE)
            and pid.isdigit() and int(pid) > 1):
        return int(pid)

def read_command(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=4)
        return r.stdout if r.returncode == 0 else ""
    except subprocess.TimeoutExpired:
        return ""

def capture(udid, out, budget, settle):
    os.umask(0o077)
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    sim = ["/usr/bin/xcrun", "simctl", "spawn", udid]
    service = "user/{}/{}".format(os.getuid(), LABEL)
    def verified_pid():
        pid = select_pid(read_command(sim + ["launchctl", "print", service]), udid)
        # Check the live host process too; never pass a partial process name to sample.
        if pid and read_command(["/bin/ps", "-ww", "-p", str(pid), "-o", "comm="]).strip().endswith(EXE):
            return pid

    status = {"simulator": udid, "sample": "VoiceOver not found for this simulator"}
    live = None
    reader = None
    def stop(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        live = subprocess.Popen(sim + ["log", "stream", "--style", "compact", "--level", "info",
                                      "--timeout", str(budget), "--predicate", PREDICATE],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        def save_log():
            with live.stdout as pipe, (out / "accessibility.log").open("xb") as stream:
                remaining = 2 * 1024 * 1024
                while remaining:
                    chunk = os.read(pipe.fileno(), min(remaining, 65536))
                    if not chunk:
                        break
                    stream.write(chunk)
                    remaining -= len(chunk)
                if not remaining:
                    status["logCapped"] = True
        reader = threading.Thread(target=save_log, daemon=True)
        reader.start()
        deadline = time.monotonic() + budget
        target, since = None, None
        while time.monotonic() < deadline:
            pid = verified_pid()
            if pid != target:
                target, since = pid, time.monotonic()
            if pid and time.monotonic() - since >= settle:
                status.update(pid=pid, sample="starting")
                # One 2-second sample. Symbolication can finish after sampling.
                with (out / "sample-status.txt").open("xb") as info:
                    try:
                        sample_file = out / "vot.sample.txt"
                        r = subprocess.run(["/bin/sh", "-c",
                                            'ulimit -f 8192; exec /usr/bin/sample "$1" 2 1 -file "$2"',
                                            "sample", str(pid), str(sample_file)],
                                           stdout=info, stderr=info, timeout=15)
                        ok = r.returncode == 0 and sample_file.is_file() and sample_file.stat().st_size > 0
                        status.update(sample="captured" if ok else "sample failed", sampleExit=r.returncode)
                    except subprocess.TimeoutExpired:
                        status["sample"] = "sample timed out"
                break
            time.sleep(1)
        # Keep collecting later failures after capturing the process once.
        if live.poll() is None:
            try:
                live.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
    except KeyboardInterrupt:
        status["stoppedByTest"] = True
    finally:
        if live is not None:
            if live.poll() is None:
                try:
                    os.killpg(live.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    live.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(live.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    live.wait(timeout=2)
            status["logStreamExit"] = live.returncode
        if reader is not None:
            reader.join(timeout=2)
        (out / "status.json").write_text(json.dumps(status, indent=2) + "\n")
    return 0 if status["sample"] == "captured" else 2

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("udid", type=uuid.UUID)
    parser.add_argument("new_output_dir", type=Path)
    parser.add_argument("--seconds", type=int, default=240)
    parser.add_argument("--after", type=int, default=8, help="seconds after observing stable vot PID")
    a = parser.parse_args()
    if not 5 <= a.seconds <= 600 or not 0 <= a.after <= a.seconds - 3:
        parser.error("--seconds must be 5..600; --after must leave at least three seconds")
    raise SystemExit(capture(str(a.udid).upper(), a.new_output_dir.resolve(), a.seconds, a.after))
