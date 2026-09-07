#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unified Test Suite Runner (Python)
Discovers and executes all tests/test_*.py suites with consistent output,
error aggregation, UTF-8 safety, and strict exit code propagation.

Usage:
  python scripts/run_all_tests.py            # Runs all Python tests (test_*.py)
  python scripts/run_all_tests.py --all      # Runs both Python and Node.js tests
"""

import os
import sys
import time
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
TESTS_DIR = ROOT_DIR / "tests"


def find_test_files(directory, suffix=".py"):
    if not directory.exists():
        return []
    return sorted(
        [
            p
            for p in directory.glob(f"test_*{suffix}")
            if p.is_file()
        ]
    )


def run_single_test(file_path, is_node=False):
    rel_path = str(file_path.relative_to(ROOT_DIR)).replace("\\", "/")
    cmd = ["node", str(file_path)] if is_node else [sys.executable, str(file_path)]

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["NODE_ENV"] = "test"

    start = time.time()
    res = subprocess.run(
        cmd,
        cwd=str(ROOT_DIR),
        env=env,
    )
    duration = f"{time.time() - start:.2f}"

    if res.returncode == 0:
        return {"rel_path": rel_path, "success": True, "duration": duration}
    else:
        return {"rel_path": rel_path, "success": False, "duration": duration, "code": res.returncode}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    args = sys.argv[1:]
    run_node_too = "--all" in args or "--both" in args

    print("====================================================")
    print(" task-loop Test Runner (Python Fallback)")
    print("====================================================")

    py_files = find_test_files(TESTS_DIR, suffix=".py")
    node_files = []
    if run_node_too:
        node_files = sorted([p for p in TESTS_DIR.glob("*.test.js") if p.is_file()])

    total = len(py_files) + len(node_files)
    extra = f" and {len(node_files)} Node.js test suites." if run_node_too else "."
    print(f"Found {len(py_files)} Python test suites{extra}")
    print("----------------------------------------------------")

    results = []
    index = 0

    for f in py_files:
        index += 1
        rel = str(f.relative_to(ROOT_DIR)).replace("\\", "/")
        print(f"\n[{index}/{total}] RUNNING: {rel}")
        r = run_single_test(f, is_node=False)
        results.append(r)

    for f in node_files:
        index += 1
        rel = str(f.relative_to(ROOT_DIR)).replace("\\", "/")
        print(f"\n[{index}/{total}] RUNNING: {rel} (Node.js)")
        r = run_single_test(f, is_node=True)
        results.append(r)

    print("\n====================================================")
    print(" TEST EXECUTION SUMMARY")
    print("====================================================")

    failed = [r for r in results if not r["success"]]
    for r in results:
        status = "PASS" if r["success"] else f"FAIL (code {r['code']})"
        print(f"  {r['rel_path'].ljust(45)} [{status}] ({r['duration']}s)")

    print("----------------------------------------------------")
    passed_count = len(results) - len(failed)
    print(f"Total: {len(results)} | Passed: {passed_count} | Failed: {len(failed)}")

    if failed:
        print(f"\nFAILED SUITES ({len(failed)}):")
        for f in failed:
            print(f"  - {f['rel_path']}")
        sys.exit(1)
    else:
        print("\nALL TEST SUITES PASSED SUCCESSFULLY!")
        sys.exit(0)


if __name__ == "__main__":
    main()
