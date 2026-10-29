import json
import os
import shutil
import select
import signal
import subprocess
import sys
import tempfile
import time


def identity(pid):
    try:
        with open(f"/proc/{pid}/stat") as source:
            fields = source.read().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return {"pid": pid, "startTime": fields[19], "groupId": int(fields[2])}
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def matches(process):
    current = identity(process["pid"])
    return current is not None and current["startTime"] == process["startTime"]


def mounted_paths(directory):
    def decode(value):
        for code, character in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
            value = value.replace(code, character)
        return value

    with open("/proc/self/mountinfo") as source:
        paths = [decode(line.split()[4]) for line in source]
    return sorted((mount for mount in paths if mount == directory or mount.startswith(directory + "/")), key=len, reverse=True)


def signal_process(process, action):
    if not matches(process):
        return
    try:
        if process.get("group"):
            os.killpg(process["pid"], action)
        elif hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
            descriptor = os.pidfd_open(process["pid"])
            try:
                if matches(process):
                    signal.pidfd_send_signal(descriptor, action)
            finally:
                os.close(descriptor)
        else:
            os.kill(process["pid"], action)
    except ProcessLookupError:
        pass


owner = {"pid": int(sys.argv[1]), "startTime": sys.argv[2]}
directory = tempfile.mkdtemp(prefix="omp-agent-desktop-", dir=sys.argv[3])
ledger = os.path.join(directory, "resources.json")
resources = {"processes": []}
with open(ledger, "w") as destination:
    json.dump(resources, destination)
stop = False


def request_stop(_signum, _frame):
    global stop
    stop = True


signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGHUP, request_stop)
signal.signal(signal.SIGINT, request_stop)
try:
    print(json.dumps({"directory": directory}), flush=True)
    sys.stdout.close()
except BrokenPipeError:
    pass


# The only writer belongs to the originating worker, including before readiness publication.
def worker_connected():
    readable, _, _ = select.select([sys.stdin.fileno()], [], [], 0)
    return not readable or bool(os.read(sys.stdin.fileno(), 1))

while not stop and matches(owner) and worker_connected():
    try:
        with open(ledger) as source:
            resources = json.load(source)
    except FileNotFoundError:
        break
    time.sleep(0.05)

try:
    with open(ledger) as source:
        resources = json.load(source)
except FileNotFoundError:
    pass

# Capture descendants before TERM: a group leader may exit before its children.
# The private runtime environment also finds children created just before omp died,
# including desktop-entry launchers whose application starts a new process group.
processes = {(process["pid"], process["startTime"]): process for process in resources["processes"]}
groups = {process["pid"] for process in processes.values() if process.get("group") and matches(process)}
for entry in os.scandir("/proc"):
    if not entry.name.isdecimal():
        continue
    pid = int(entry.name)
    if pid == os.getpid():
        continue
    process = identity(pid)
    if process is None:
        continue
    owned = process["groupId"] in groups
    if not owned:
        try:
            if entry.stat().st_uid == os.getuid():
                with open(f"/proc/{pid}/environ", "rb") as source:
                    environment = source.read().split(b"\0")
                    bus = resources.get("busAddress")
                    owned = (("XDG_RUNTIME_DIR=" + directory).encode() in environment or
                             bool(bus and ("DBUS_SESSION_BUS_ADDRESS=" + bus).encode() in environment))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    if owned:
        processes.setdefault((pid, process["startTime"]), process)

for action in (signal.SIGTERM, signal.SIGKILL):
    for process in processes.values():
        signal_process(process, action)
    if action == signal.SIGTERM:
        time.sleep(0.5)

script = resources.get("scriptName")
if script:
    try:
        subprocess.run(["qdbus6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", script], timeout=1, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        pass

# Fail closed if an owned mount cannot be detached: never walk into portal files.
for mount in mounted_paths(directory):
    unmount = shutil.which("fusermount3") or shutil.which("fusermount")
    if unmount is None:
        raise RuntimeError("Cannot safely remove mounted agent desktop runtime")
    subprocess.run([unmount, "-u", "-z", mount], check=True, timeout=2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
shutil.rmtree(directory)
