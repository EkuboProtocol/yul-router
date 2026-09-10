#!/usr/bin/env python3
"""Replay the feasibility experiments in a disposable worktree at the pinned baseline."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=("single-hop", "indexed-paths"), default="single-hop")
    parser.add_argument("--fuzz-runs", type=int, default=10000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.fuzz_runs <= 0:
        parser.error("--fuzz-runs must be positive")
    here = Path(__file__).resolve().parent
    manifest = json.loads((here / "manifest.json").read_text())
    for name, expected in manifest["sha256"].items():
        actual = hashlib.sha256((here / name).read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f"Artifact checksum mismatch: {name}")
    reference = json.loads((here / "baseline.json").read_text())
    refs = reference["deployedBytecode"]["immutableReferences"]["self"]
    if refs != [{"start": 34, "length": 32}]:
        raise RuntimeError("Unexpected baseline immutable layout")
    repo = Path(subprocess.check_output(["git", "-C", str(here), "rev-parse", "--show-toplevel"], text=True).strip())
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = (args.output or Path.home() / "Documents" / f"huff-feasibility-{stamp}").expanduser().resolve()
    output.mkdir(parents=True, exist_ok=False)
    worktree = repo / ".worktrees" / f"huff-replay-{stamp}"
    branch = f"research/huff-replay-{stamp}"
    created = False
    env = dict(os.environ, COMPARISON="true", FOUNDRY_ISOLATE="true")

    def run(command, log_name, cwd=worktree):
        with (output / log_name).open("w") as log:
            subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)

    try:
        run(["git", "worktree", "add", str(worktree), "-b", branch, manifest["baseline_commit"]], "worktree.log", repo)
        created = True
        run(["git", "apply", "--unidiff-zero", str(here / f"{args.variant}.patch")], "apply.log")
        run(["git", "submodule", "update", "--init", "--recursive"], "dependencies.log")
        core = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=worktree / "lib/evm-contracts", text=True).strip()
        if core != manifest["core_commit"]:
            raise RuntimeError("Unexpected Core revision")
        run(["forge", "build"], "build.log")
        (worktree / "out/huff-init.hex").write_text((here / "huff-init.hex").read_text().strip())
        shutil.copy(here / "baseline.json", worktree / "out/ComparisonBaseline.json")
        run(["forge", "test", "--match-test", "test_Feasibility", "-vv"], "validation.log")
        validation = (output / "validation.log").read_text()
        count = 6 if args.variant == "single-hop" else 8
        if not re.search(rf"{count} passed; 0 failed", validation):
            raise RuntimeError("Expected validation tests were not executed")
        run(["forge", "test", "--match-test", "testFuzz_Feasibility", "--fuzz-runs", str(args.fuzz_runs), "--fuzz-seed", "0x42", "-vv"], "fuzz.log")
        fuzz = (output / "fuzz.log").read_text()
        if "[PASS] testFuzz_Feasibility" not in fuzz or f"runs: {args.fuzz_runs}," not in fuzz:
            raise RuntimeError("Expected fuzz cases were not executed")
        measured = json.loads((worktree / "snapshots/matrix.json").read_text())
        expected = json.loads((here / f"{args.variant}-gas.json").read_text())
        compared = {}
        for key in expected:
            if key.endswith("_yul") and key[:-4] + "_huff" in expected:
                for k in (key, key[:-4] + "_huff"):
                    if measured.get(k) != expected[k]:
                        compared[k] = {"expected": expected[k], "actual": measured.get(k)}
        (output / "gas.json").write_text(json.dumps(measured, indent=2) + "\n")
        (output / "gas-differences.json").write_text(json.dumps(compared, indent=2) + "\n")
        shutil.copy(worktree / "src/YulRouter.yul", output / "prototype.yul")
        shutil.copy(worktree / "test/YulRouter.t.sol", output / "tests.sol")
        shutil.copy(worktree / "out/YulRouter.yul/YulRouter.json", output / "artifact.json")
        run(["forge", "--version"], "forge-version.txt")
        config = json.loads(subprocess.check_output(["forge", "config", "--json"], cwd=worktree, env=env, text=True))
        keys = ("solc", "evm_version", "optimizer", "optimizer_runs", "via_ir", "isolate")
        (output / "config.json").write_text(json.dumps({k: config.get(k) for k in keys}, indent=2) + "\n")
        if compared:
            raise RuntimeError(f"Gas differs from the recorded measurements; see {output}")
        print(f"{args.variant}: {count} validation tests and {args.fuzz_runs} fuzz cases passed; gas reproduced exactly. Evidence: {output}")
    finally:
        if created:
            # Only remove the worktree and branch created by this invocation.
            for path, target in (("src/YulRouter.yul", "prototype.yul"), ("test/YulRouter.t.sol", "tests.sol")):
                if (worktree / path).exists():
                    shutil.copy(worktree / path, output / target)
            subprocess.run(["git", "worktree", "remove", "--force", str(worktree)], cwd=repo, check=True)
            subprocess.run(["git", "branch", "-D", branch], cwd=repo, check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
