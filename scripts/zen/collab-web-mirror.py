#!/usr/bin/python3
"""从 npm 安装 zen collab 静态站点；校验成功后才切换，缺包时保留现站。

systemd 的只读沙箱不变；所有临时文件和版本都写入 ROOT。
测试可设置 OMP_COLLAB_WEB_ROOT 和 OMP_COLLAB_WEB_REGISTRIES（逗号分隔）。
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

NAME = "@oh-my-pi-zen/collab-web"
ROOT = Path(os.environ.get("OMP_COLLAB_WEB_ROOT", "/srv/omp-collab-web"))
REGISTRIES = os.environ.get(
    "OMP_COLLAB_WEB_REGISTRIES",
    "https://registry.npmmirror.com,https://registry.npmjs.org",
).split(",")


def version_key(value):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-zen\.([1-9]\d*)", value)
    if not match:
        raise ValueError(f"invalid zen version: {value}")
    return tuple(map(int, match.groups()))


def main():
    candidates = []
    for registry in REGISTRIES:
        url = f"{registry.rstrip('/')}/{urllib.parse.quote(NAME, safe='@')}/latest"
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                metadata = json.load(response)
            if metadata["name"] != NAME:
                raise ValueError("unexpected package name")
            candidates.append((version_key(metadata["version"]), metadata))
        except (OSError, ValueError, KeyError) as error:
            print(f"metadata unavailable at {registry}: {error}", file=sys.stderr)
    if not candidates:
        print("No published collab-web package available; keeping current site")
        return
    # Stable sort prefers npmmirror when both registries have the same version.
    _, metadata = max(candidates, key=lambda item: item[0])
    version = metadata["version"]
    current = ROOT / "current"
    if current.is_symlink() and (current / "index.html").is_file():
        previous = Path(os.readlink(current)).name
        try:
            if version_key(previous) >= version_key(version):
                print(f"Already current: {previous}; keeping current site")
                return
        except ValueError:
            pass  # The previous mirror used SHA-based release names.
    integrity = next((part[7:] for part in metadata["dist"]["integrity"].split() if part.startswith("sha512-")), None)
    if integrity is None:
        raise ValueError("package has no sha512 integrity")
    expected = base64.b64decode(integrity, validate=True)
    if len(expected) != 64:
        raise ValueError("invalid sha512 integrity")
    releases = ROOT / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".tmp.", dir=ROOT) as temporary:
        temporary = Path(temporary)
        archive = temporary / "package.tgz"
        digest = hashlib.sha512()
        with urllib.request.urlopen(metadata["dist"]["tarball"], timeout=60) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if not hmac.compare_digest(digest.digest(), expected):
            raise ValueError("sha512 integrity mismatch; keeping current site")
        extracted = temporary / "extracted"
        with tarfile.open(archive, "r:gz") as package:
            for member in package.getmembers():
                parts = PurePosixPath(member.name).parts
                if not parts or parts[0] != "package" or ".." in parts or not (member.isfile() or member.isdir()):
                    raise ValueError(f"unsafe package member: {member.name}")
            package.extractall(extracted, filter="data")
        manifest = json.loads((extracted / "package/package.json").read_text())
        if manifest.get("name") != NAME or manifest.get("version") != version:
            raise ValueError("package manifest does not match registry metadata")
        site = extracted / "package/dist"
        if not (site / "index.html").is_file():
            raise ValueError("package has no dist/index.html")
        for file in [site, *site.rglob("*")]:
            file.chmod(0o755 if file.is_dir() else 0o644)
        destination = releases / version
        if destination.exists():
            if destination.is_symlink():
                raise ValueError("release directory is a symlink")
            shutil.rmtree(destination)
        os.replace(site, destination)
        os.utime(destination, None)
        pending = ROOT / f".current-{uuid.uuid4().hex}"
        try:
            pending.symlink_to(f"releases/{version}")
            os.replace(pending, current)
        finally:
            pending.unlink(missing_ok=True)
    old = sorted((file for file in releases.iterdir() if file.is_dir() and not file.is_symlink()),
                 key=lambda file: file.stat().st_mtime_ns, reverse=True)
    for file in old[3:]:
        shutil.rmtree(file)
    print(f"Updated {NAME} to {version}; sha512 verified; retained {min(len(old), 3)} releases")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(f"collab-web update failed: {error}", file=sys.stderr)
        sys.exit(1)
