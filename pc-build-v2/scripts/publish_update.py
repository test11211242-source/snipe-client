"""Build on this Windows PC; GitHub only signs and publishes the finished file."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_BASE = "https://updates.artcsworld.xyz/downloads/v2"
PUBLIC_HEADERS = {"User-Agent": "CRToolsPublisher/1.0", "Cache-Control": "no-cache"}
WORKFLOW = "pc-build-v2-local-publish.yml"
SEMVER = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
CHECKS = [
    "lint", "typecheck", "release:verify-inputs", "test", "test:publisher",
    "test:python", "audit:release", "runtime:verify", "build:unpacked",
    "test:e2e:windows", "build", "installer-validation",
]


class PublishError(RuntimeError):
    pass


def version_tuple(value: str) -> tuple[int, ...]:
    if not isinstance(value, str) or len(value) > 32 or not SEMVER.fullmatch(value):
        raise PublishError("Version must be strict x.y.z semver.")
    return tuple(map(int, value.split(".")))


def select_version(current: str, published: str | None, requested: str | None) -> str:
    current_tuple = version_tuple(current)
    if published is not None and current_tuple < version_tuple(published):
        raise PublishError("Local package version is older than the public update. Sync main first.")
    selected = requested or current
    if requested is None and published is not None and current_tuple == version_tuple(published):
        selected = f"{current_tuple[0]}.{current_tuple[1]}.{current_tuple[2] + 1}"
    if version_tuple(selected) < current_tuple:
        raise PublishError("The selected version is older than package.json.")
    if published is not None and version_tuple(selected) <= version_tuple(published):
        raise PublishError("The release must be newer than the public update.")
    return selected


def fetch_public_manifest() -> dict | None:
    request = urllib.request.Request(
        f"{PUBLIC_BASE}/manifest.json", headers=PUBLIC_HEADERS
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read(128 * 1024 + 1)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise PublishError(f"Public update manifest returned HTTP {error.code}.") from error
    if len(body) > 128 * 1024:
        raise PublishError("Public manifest is too large.")
    manifest = json.loads(body)
    version_tuple(manifest.get("version"))
    if manifest.get("schemaVersion") != 1 or manifest.get("channel") != "stable":
        raise PublishError("Unsupported public update manifest.")
    return manifest


def file_hash(path: Path) -> str:
    digest = hashlib.sha512()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class Runner:
    def __init__(self, root: Path, log: Path):
        self.root = root
        self.log = log
        self.stage = "preflight"
        self.environment = os.environ.copy()

    def run(self, args: list[str], *, cwd: Path | None = None, capture: bool = False,
            env: dict | None = None) -> str:
        # No token/key is passed on the command line or recorded in this log.
        with self.log.open("a", encoding="utf-8") as output:
            output.write(f"\n[{self.stage}] {args[0]}\n")
            output.flush()
            result = subprocess.run(
                args, cwd=cwd or self.root, env=env if env is not None else self.environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture else output, stderr=output,
                encoding="utf-8", errors="replace", check=False,
            )
        if result.returncode:
            raise PublishError(f"{self.stage} failed (exit {result.returncode}).")
        return (result.stdout or "").strip() if capture else ""

    def git(self, *args: str, cwd: Path | None = None) -> str:
        return self.run(["git.exe", *args], cwd=cwd, capture=True)

    def gh(self, *args: str) -> str:
        return self.run(["gh.exe", *args], capture=True)

    def npm(self, *args: str) -> None:
        # Invoke npm's JS entry point directly: no cmd.exe quoting or shell interpolation.
        npm = shutil.which("npm.cmd")
        if npm is None:
            raise PublishError("npm.cmd is missing. Install Node.js 22 for Windows.")
        cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js"
        if not cli.is_file():
            raise PublishError(f"npm CLI was not found beside npm.cmd: {cli}")
        self.run(["node.exe", str(cli), *args])

    def step(self, name: str) -> None:
        self.stage = name
        print(f"==> {name}", flush=True)


def assert_release_source(runner: Runner, repository: Path) -> str:
    if runner.git("branch", "--show-current", cwd=repository) != "main":
        raise PublishError("Release from main after the reviewed changes have been merged.")
    if runner.git("status", "--porcelain", "--untracked-files=all", cwd=repository):
        raise PublishError("Main has uncommitted changes. Preserve and commit them before release.")
    runner.git("fetch", "origin", "main", cwd=repository)
    sha = runner.git("rev-parse", "HEAD", cwd=repository)
    if sha != runner.git("rev-parse", "origin/main", cwd=repository):
        raise PublishError("Main is not synchronized with origin/main. Sync it before release.")
    return sha


def windows_archive_tool() -> Path:
    candidates = [Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "7-Zip/7z.exe"]
    on_path = shutil.which("7z.exe")
    if on_path:
        candidates.insert(0, Path(on_path))
    for candidate in candidates:
        if not candidate.is_file():
            continue
        with candidate.open("rb") as executable:
            if executable.read(2) != b"MZ":
                continue
            executable.seek(0x3C)
            offset_bytes = executable.read(4)
            if len(offset_bytes) != 4:
                continue
            offset = struct.unpack("<I", offset_bytes)[0]
            if offset > candidate.stat().st_size - 6:
                continue
            executable.seek(offset)
            header = executable.read(6)
            if header == b"PE\0\0\x64\x86":
                return candidate.resolve()
    raise PublishError("Install 64-bit 7-Zip for Windows; the bundled builder archive tool is 32-bit.")


def build_local(runner: Runner) -> list[str]:
    node_version = runner.run(["node.exe", "--version"], capture=True)
    if not node_version.startswith("v22."):
        raise PublishError("Local releases require Node.js 22, matching the supported toolchain.")
    # electron-builder v26's bundled 7zip toolset contains an x86 binary even for x64.
    # Use its supported override with a verified x64 PE from the local 7-Zip installation.
    runner.environment["ELECTRON_BUILDER_7ZIP_PATH"] = str(windows_archive_tool())
    runner.step("install Node dependencies")
    runner.npm("ci")
    python = runner.root / ".venv/Scripts/python.exe"
    if not python.is_file():
        runner.step("create Windows Python test environment")
        runner.run([sys.executable, "-m", "venv", str(python.parents[1])])
    runner.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                "--only-binary=:all:", "-r", "python/requirements-dev.txt"])
    for name in CHECKS[:5]:
        runner.step(name)
        if name == "test":
            # Bound Windows worker forks so large-core PCs do not exhaust process/memory limits.
            runner.npm("test", "--", "--maxWorkers=8")
        else:
            runner.npm("run", name)
    runner.step("test:python")
    runner.run([str(python), "-m", "pytest", "tests"], cwd=runner.root / "python")
    runner.step("audit:release")
    runner.npm("run", "audit:release")
    runner.step("runtime:verify")
    # Runtime is rebuilt in the isolated release checkout, never in an existing installation.
    if not ((runner.root / "resources/python-runtime/python.exe").is_file() and
            (runner.root / "resources/runtime-integrity.json").is_file()):
        runner.npm("run", "runtime:build")
    runner.npm("run", "runtime:verify")
    for name in ["build:unpacked", "test:e2e:windows", "build"]:
        runner.step(name)
        runner.npm("run", name)
    version = json.loads((runner.root / "package.json").read_text("utf-8"))["version"]
    artifact = runner.root / "release" / f"CR_Tools_V2_Setup_{version}.exe"
    if not artifact.is_file() or not 0 < artifact.stat().st_size <= 500 * 1024 * 1024:
        raise PublishError("Expected local Windows installer was not built.")
    runner.step("installer-validation")
    with artifact.open("rb") as executable:
        if executable.read(2) != b"MZ":
            raise PublishError("The installer is not a Windows executable.")
    packaged_version = json.loads((runner.root / "release/win-unpacked/resources/app-version.json")
                                 .read_text("utf-8"))["version"]
    if packaged_version != version:
        raise PublishError("The packaged application version does not match the installer.")
    return CHECKS.copy()


def save_receipt(root: Path, destination: Path, sha: str, correlation: str,
                 checks: list[str], *, mode: str = "test") -> dict:
    version = json.loads((root / "package.json").read_text("utf-8"))["version"]
    artifact = root / "release" / f"CR_Tools_V2_Setup_{version}.exe"
    inventory = root / "resources/runtime-integrity.json"
    destination.mkdir(parents=True, exist_ok=False)
    shutil.copy2(artifact, destination / artifact.name)
    shutil.copy2(inventory, destination / inventory.name)
    receipt = {
        "schemaVersion": 1, "mode": mode, "platform": "win32", "version": version,
        "sourceSha": sha, "correlationId": correlation, "checks": checks,
        "artifact": {"fileName": artifact.name, "size": artifact.stat().st_size,
                     "sha512": file_hash(artifact)},
        "runtimeSha512": file_hash(inventory),
    }
    (destination / "local-build.json").write_text(json.dumps(receipt, indent=2) + "\n", "utf-8")
    return receipt


def wait_for_run(runner: Runner, repository_name: str, sha: str, correlation: str) -> dict:
    for _ in range(60):
        runs = json.loads(runner.gh(
            "api", f"repos/{repository_name}/actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=50"
        ))["workflow_runs"]
        matches = [run for run in runs if run["head_sha"] == sha and
                   f"[{correlation}]" in run["display_title"]]
        if len(matches) > 1:
            raise PublishError("Multiple workflow runs matched this local build.")
        if matches:
            return matches[0]
        time.sleep(2)
    raise PublishError("The signing/publication workflow was not found. Keep the local installer.")


def verify_public_artifact(receipt: dict) -> None:
    manifest = fetch_public_manifest()
    expected = receipt["artifact"]
    if manifest is None or manifest["version"] != receipt["version"]:
        raise PublishError("The public update version does not match this local build.")
    import base64
    artifact = manifest["artifact"]
    expected_url = f"{PUBLIC_BASE}/{expected['fileName']}"
    if (artifact["fileName"] != expected["fileName"] or artifact["size"] != expected["size"] or
            artifact["url"] != expected_url or
            base64.b64decode(artifact["sha512"], validate=True).hex() != expected["sha512"]):
        raise PublishError("The public manifest does not describe the exact locally built installer.")
    digest = hashlib.sha512()
    size = 0
    request = urllib.request.Request(expected_url, headers=PUBLIC_HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        while block := response.read(1024 * 1024):
            size += len(block)
            if size > expected["size"]:
                raise PublishError("Public installer exceeds its expected size.")
            digest.update(block)
    if size != expected["size"] or digest.hexdigest() != expected["sha512"]:
        raise PublishError("The public installer differs from the file built on this PC.")


def complete_publication(runner: Runner, destination: Path, state: dict) -> None:
    runner.step("wait for signing and publication (no GitHub build)")
    print(state["runUrl"], flush=True)
    try:
        runner.gh("run", "watch", str(state["runId"]), "--exit-status", "--interval", "10")
    except PublishError as error:
        raise PublishError(
            f"Publication did not finish successfully. Inspect {state['runUrl']}. "
            f"Re-run failed jobs, then use publish-update.cmd resume {state['runId']}; "
            "do not rebuild or reuse the version with a different installer."
        ) from error
    runner.step("verify exact local installer over public HTTPS")
    receipt = json.loads((destination / "local-build.json").read_text("utf-8"))
    verify_public_artifact(receipt)
    runner.step("remove temporary draft transport")
    try:
        runner.gh("release", "delete", state["tag"], "--yes", "--cleanup-tag")
    except PublishError:
        print(f"Update is published and verified; temporary draft may need cleanup: {state['tag']}")
    print(f"WINDOWS RELEASE OK {receipt['version']} build=local artifact={destination / receipt['artifact']['fileName']}")


def publish(args: argparse.Namespace, runner: Runner) -> None:
    if sys.platform != "win32":
        raise PublishError("This publisher builds on Windows only.")
    for command in ["git.exe", "node.exe", "npm.cmd", "pwsh.exe"]:
        if shutil.which(command) is None:
            raise PublishError(f"Required Windows command is missing: {command}")
    if args.mode == "resume":
        matches = []
        for state_file in (runner.root / "published").glob("*/local-*/publication.json"):
            state = json.loads(state_file.read_text("utf-8"))
            if str(state["runId"]) == args.version:
                matches.append((state_file.parent, state))
            elif state["runId"] is None:
                run = json.loads(runner.gh("api", f"repos/{state['repository']}/actions/runs/{args.version}"))
                receipt = json.loads((state_file.parent / "local-build.json").read_text("utf-8"))
                if (run["head_sha"] == receipt["sourceSha"] and
                        f"[{receipt['correlationId']}]" in run["display_title"] and
                        run["path"] == f".github/workflows/{WORKFLOW}"):
                    state.update(runId=run["id"], runUrl=run["html_url"])
                    state_file.write_text(json.dumps(state, indent=2) + "\n", "utf-8")
                    matches.append((state_file.parent, state))
        if len(matches) != 1:
            raise PublishError("Exactly one saved local publication must match the run ID.")
        complete_publication(runner, *matches[0])
        return
    package = json.loads((runner.root / "package.json").read_text("utf-8"))
    if args.mode == "test":
        if args.version and args.version != package["version"]:
            raise PublishError("Test builds keep package.json's version; no production version bump.")
        if args.plan:
            print(f"Mode: test\nBuild: local Windows\nVersion: {package['version']}\nPublish: no")
            return
        checks = build_local(runner)
        correlation = str(uuid.uuid4())
        destination = runner.root / "published" / package["version"] / f"local-{correlation}"
        save_receipt(runner.root, destination, runner.git("rev-parse", "HEAD"), correlation, checks)
        print(f"WINDOWS TEST BUILD OK {package['version']} build=local artifact={destination}")
        return
    if shutil.which("gh.exe") is None:
        raise PublishError("GitHub CLI is missing. Install gh and run gh auth login once.")
    repository = Path(runner.git("rev-parse", "--show-toplevel"))
    source_sha = assert_release_source(runner, repository)
    public = fetch_public_manifest()
    version = select_version(package["version"], public["version"] if public else None, args.version)
    print(f"Mode: release\nBuild: this Windows PC\nVersion: {version}\nSource: {source_sha}", flush=True)
    if args.plan:
        return
    runner.gh("auth", "status")
    repository_name = runner.gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
    # Ensure the signing-only workflow and required secret names are configured before building.
    runner.gh("api", f"repos/{repository_name}/actions/workflows/{WORKFLOW}")
    secrets = json.loads(runner.gh("api", f"repos/{repository_name}/actions/secrets?per_page=100"))
    names = {secret["name"] for secret in secrets["secrets"]}
    required = {"CR_TOOLS_V2_UPDATE_PRIVATE_KEY_B64", "SERVER_HOST", "SERVER_USER",
                "SSH_PRIVATE_KEY", "SERVER_KNOWN_HOSTS"}
    if required - names:
        raise PublishError("Missing repository secret names: " + ", ".join(sorted(required - names)))
    if not args.yes and input(f"Publish Windows {version}? Type PUBLISH: ").strip() != "PUBLISH":
        raise PublishError("Publication cancelled.")
    correlation = str(uuid.uuid4())
    destination = runner.root / "published" / version / f"local-{correlation}"
    # This checkout contains reviewed code. Only release metadata changes in the isolated worktree.
    workspace = Path(tempfile.mkdtemp(prefix="cr-tools-local-release-")) / "source"
    added = False
    try:
        runner.step("prepare isolated local release checkout")
        runner.git("worktree", "add", "--detach", str(workspace), source_sha, cwd=repository)
        added = True
        build_runner = Runner(workspace / "pc-build-v2", runner.log)
        build_runner.npm("version", version, "--no-git-tag-version", "--allow-same-version")
        checks = build_local(build_runner)
        runner.stage = "verify release metadata changes"
        changed = set(runner.git("diff", "--name-only", cwd=workspace).splitlines())
        allowed = {"pc-build-v2/package.json", "pc-build-v2/package-lock.json",
                   "pc-build-v2/resources/app-version.json"}
        if changed - allowed or runner.git("ls-files", "--others", "--exclude-standard", cwd=workspace):
            raise PublishError("Build unexpectedly changed source files; publication stopped.")
        if changed:
            runner.git("add", "--", *sorted(allowed), cwd=workspace)
            runner.git("commit", "-m", f"release: prepare local Windows {version}", cwd=workspace)
        release_sha = runner.git("rev-parse", "HEAD", cwd=workspace)
        save_receipt(build_runner.root, destination, release_sha, correlation, checks, mode="release")
        # Stop if another operation edited or advanced the original checkout during the build.
        if assert_release_source(runner, repository) != source_sha:
            raise PublishError("Main changed during the local build. No installer was uploaded.")
        runner.step("push reviewed release metadata")
        runner.git("push", "origin", "HEAD:main", cwd=workspace)
        runner.git("fetch", "origin", "main", cwd=repository)
        runner.git("merge", "--ff-only", "origin/main", cwd=repository)
        runner.step("upload finished installer to temporary draft (no compilation)")
        tag = f"local-windows-{version}-{correlation}"
        runner.gh("release", "create", tag, "--draft", "--target", release_sha,
                  "--title", f"Local Windows build {version}", "--notes",
                  "Temporary transport for a locally built installer. Deleted after public verification.",
                  str(destination / f"CR_Tools_V2_Setup_{version}.exe"),
                  str(destination / "runtime-integrity.json"), str(destination / "local-build.json"))
        state = {"runId": None, "runUrl": None, "tag": tag, "repository": repository_name}
        state_path = destination / "publication.json"
        state_path.write_text(json.dumps(state, indent=2) + "\n", "utf-8")
        runner.step("dispatch signing/publication only")
        runner.gh("workflow", "run", WORKFLOW, "--ref", "main", "-f", f"version={version}",
                  "-f", f"correlation_id={correlation}", "-f", f"local_build_tag={tag}",
                  "-f", f"critical={str(args.critical).lower()}",
                  "-f", f"bootstrap={str(public is None).lower()}")
        run = wait_for_run(runner, repository_name, release_sha, correlation)
        state.update(runId=run["id"], runUrl=run["html_url"])
        state_path.write_text(json.dumps(state, indent=2) + "\n", "utf-8")
        complete_publication(runner, destination, state)
    finally:
        if added:
            # Refuse to discard genuine source edits; generated ignored build files may be removed.
            cleanup_changes = set(runner.git("diff", "--name-only", "HEAD", cwd=workspace).splitlines())
            cleanup_allowed = {"pc-build-v2/package.json", "pc-build-v2/package-lock.json",
                               "pc-build-v2/resources/app-version.json"}
            if (workspace.resolve().parent == workspace.parent.resolve() and
                    workspace.parent.name.startswith("cr-tools-local-release-") and
                    not cleanup_changes - cleanup_allowed and
                    not runner.git("ls-files", "--others", "--exclude-standard", cwd=workspace)):
                runner.git("worktree", "remove", "--force", str(workspace), cwd=repository)
            else:
                print(f"Preserved release checkout with unexpected source edits: {workspace}", file=sys.stderr)
        if workspace.parent.is_dir() and not any(workspace.parent.iterdir()):
            workspace.parent.rmdir()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["test", "release", "resume"], nargs="?", default="release")
    parser.add_argument("version", nargs="?")
    parser.add_argument("--plan", "--dry-run", dest="plan", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--critical", action="store_true")
    args = parser.parse_args()
    if args.critical and args.mode != "release":
        parser.error("--critical requires release mode")
    if args.mode == "resume" and (not args.version or not args.version.isdigit()):
        parser.error("resume requires a numeric workflow run ID")
    handle, log_path = tempfile.mkstemp(prefix="cr-tools-local-publish-", suffix=".log")
    os.close(handle)
    runner = Runner(ROOT, Path(log_path))
    try:
        publish(args, runner)
    except (Exception, KeyboardInterrupt) as error:
        print(f"WINDOWS RELEASE FAILED at {runner.stage}: {error}; log={runner.log}", file=sys.stderr)
        return 1
    runner.log.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
