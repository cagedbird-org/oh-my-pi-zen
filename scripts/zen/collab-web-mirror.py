#!/usr/bin/python3
"""从 npm 校验并原子更新 collab-web 与 relay；写入各自 ROOT，relay 失败自动回滚。"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

WEB_NAME = "@oh-my-pi-zen/collab-web"
RELAY_NAME = "@oh-my-pi-zen/collab-relay-linux-x64"
REGISTRIES = os.environ.get(
    "OMP_COLLAB_WEB_REGISTRIES",
    "https://registry.npmmirror.com,https://registry.npmjs.org",
).split(",")


def version_key(value):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-zen\.([1-9]\d*)", value)
    if not match:
        raise ValueError(f"invalid zen version: {value}")
    return tuple(map(int, match.groups()))


def latest(name):
    candidates = []
    for registry in REGISTRIES:
        url = f"{registry.rstrip('/')}/{urllib.parse.quote(name, safe='@')}/latest"
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                metadata = json.load(response)
            if metadata["name"] != name:
                raise ValueError("unexpected package name")
            candidates.append((version_key(metadata["version"]), metadata))
        except (OSError, ValueError, KeyError) as error:
            print(f"metadata unavailable for {name} at {registry}: {error}", file=sys.stderr)
    # Stable ordering prefers npmmirror when both registries have the same version.
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def switch_current(root, target):
    current = root / "current"
    if target is None:
        current.unlink(missing_ok=True)
        return
    pending = root / f".current-{uuid.uuid4().hex}"
    try:
        pending.symlink_to(target)
        os.replace(pending, current)
    finally:
        pending.unlink(missing_ok=True)


def restart_relay():
    command = shlex.split(os.environ.get("OMP_COLLAB_RELAY_RESTART", "systemctl restart collab-relay.service"))
    subprocess.run(command, check=True, timeout=15)


def read_exact(connection, length):
    result = bytearray()
    while len(result) < length:
        chunk = connection.recv(length - len(result))
        if not chunk:
            raise ValueError("WebSocket closed without a close frame")
        result.extend(chunk)
    return bytes(result)


def websocket_health(address, timeout):
    host = address.hostname
    port = address.port or 7466
    key = base64.b64encode(os.urandom(16)).decode()
    room = "hc" + secrets.token_urlsafe(18)
    with socket.create_connection((host, port), timeout=timeout) as connection:
        connection.settimeout(timeout)
        connection.sendall((
            f"GET /r/{room}?role=guest HTTP/1.1\r\n"
            f"Host: {address.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode())
        headers = bytearray()
        while not headers.endswith(b"\r\n\r\n"):
            headers.extend(read_exact(connection, 1))
            if len(headers) > 16384:
                raise ValueError("oversized WebSocket handshake")
        lines = headers.decode("iso-8859-1").split("\r\n")
        if lines[0].split(" ")[1] != "101":
            raise ValueError(f"WebSocket handshake failed: {lines[0]}")
        fields = {key.lower(): value.strip() for key, value in
                  (line.split(":", 1) for line in lines[1:] if ":" in line)}
        expected = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
        ).digest()).decode()
        if fields.get("sec-websocket-accept") != expected:
            raise ValueError("invalid WebSocket accept key")
        first, second = read_exact(connection, 2)
        if first != 0x88 or second & 0x80 or not 2 <= second <= 125:
            raise ValueError("expected an unmasked WebSocket close frame")
        payload = read_exact(connection, second)
        if struct.unpack("!H", payload[:2])[0] != 4004:
            raise ValueError("expected WebSocket close code 4004")


def relay_health():
    address = urllib.parse.urlsplit("//" + os.environ.get("OMP_COLLAB_RELAY_HEALTH", "127.0.0.1:7466"))
    deadline = time.monotonic() + 15
    error = None
    while time.monotonic() < deadline:
        try:
            timeout = min(1, deadline - time.monotonic())
            with urllib.request.urlopen(f"http://{address.netloc}/healthz", timeout=timeout) as response:
                if not response.read(2).startswith(b"ok"):
                    raise ValueError("relay /healthz did not return ok")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            websocket_health(address, min(1, remaining))
            return
        except (OSError, ValueError) as failure:
            error = failure
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))
    raise ValueError(f"relay health check failed within 15s: {error}")


def source_hash(directory):
    value = (directory / "source-hash").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("invalid relay source-hash")
    return value


def update(name, root, relay=False):
    metadata = latest(name)
    if metadata is None:
        print(f"No published {name} package available; keeping current release")
        return
    version = metadata["version"]
    current = root / "current"
    previous = os.readlink(current) if current.is_symlink() else None
    if previous and (current / ("collab-relay" if relay else "index.html")).is_file():
        try:
            if version_key(Path(previous).name) >= version_key(version):
                print(f"Already current: {name}@{Path(previous).name}")
                return
        except ValueError:
            pass  # Older web deployments used SHA-based release names.
    integrity = next((part[7:] for part in metadata["dist"]["integrity"].split() if part.startswith("sha512-")), None)
    if integrity is None:
        raise ValueError("package has no sha512 integrity")
    expected = base64.b64decode(integrity, validate=True)
    if len(expected) != 64:
        raise ValueError("invalid sha512 integrity")
    releases = root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".tmp.", dir=root) as temporary:
        temporary = Path(temporary)
        archive = temporary / "package.tgz"
        digest = hashlib.sha512()
        with urllib.request.urlopen(metadata["dist"]["tarball"], timeout=60) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if not hmac.compare_digest(digest.digest(), expected):
            raise ValueError("sha512 integrity mismatch; keeping current release")
        extracted = temporary / "extracted"
        with tarfile.open(archive, "r:gz") as package:
            for member in package.getmembers():
                parts = PurePosixPath(member.name).parts
                if not parts or parts[0] != "package" or ".." in parts or not (member.isfile() or member.isdir()):
                    raise ValueError(f"unsafe package member: {member.name}")
            package.extractall(extracted, filter="data")
        payload = extracted / "package"
        manifest = json.loads((payload / "package.json").read_text())
        if manifest.get("name") != name or manifest.get("version") != version:
            raise ValueError("package manifest does not match registry metadata")
        if relay:
            new_hash = source_hash(payload)
            if not (payload / "collab-relay").is_file():
                raise ValueError("package has no collab-relay binary")
            changed = not previous or not (current / "source-hash").is_file() or source_hash(current) != new_hash
        else:
            payload = payload / "dist"
            if not (payload / "index.html").is_file():
                raise ValueError("package has no dist/index.html")
        for file in [payload, *payload.rglob("*")]:
            file.chmod(0o755 if file.is_dir() or (relay and file.name == "collab-relay") else 0o644)
        destination = releases / version
        if destination.exists():
            if destination.is_symlink():
                raise ValueError("release directory is a symlink")
            shutil.rmtree(destination)
        os.replace(payload, destination)
        os.utime(destination, None)
        switch_current(root, f"releases/{version}")
        if relay and changed:
            try:
                restart_relay()
                relay_health()
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                switch_current(root, previous)
                try:
                    restart_relay()
                except (OSError, subprocess.SubprocessError) as rollback_error:
                    print(f"relay rollback restart failed: {rollback_error}", file=sys.stderr)
                shutil.rmtree(destination)
                raise ValueError(f"relay update rolled back: {error}") from error
    old = sorted((file for file in releases.iterdir() if file.is_dir() and not file.is_symlink()),
                 key=lambda file: file.stat().st_mtime_ns, reverse=True)
    for file in old[3:]:
        shutil.rmtree(file)
    print(f"Updated {name} to {version}; sha512 verified; retained {min(len(old), 3)} releases")


def main():
    failed = False
    for name, root, relay in [
        (WEB_NAME, Path(os.environ.get("OMP_COLLAB_WEB_ROOT", "/srv/omp-collab-web")), False),
        (RELAY_NAME, Path(os.environ.get("OMP_COLLAB_RELAY_ROOT", "/srv/omp-collab-relay")), True),
    ]:
        try:
            update(name, root, relay)
        except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
            print(f"{name} update failed: {error}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
