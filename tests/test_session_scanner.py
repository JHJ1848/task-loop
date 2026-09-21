#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for Find Project Sessions
"""

import sys
import tempfile
import shutil
from pathlib import Path

# Add scripts directory
scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))

from find_project_sessions import find_sessions


def test_scanner():
    temp_dir = tempfile.mkdtemp(prefix="test_scanner_")
    try:
        sessions = find_sessions(temp_dir, "Auto")
        print(f"Scanner test passed. Discovered sessions count: {len(sessions)}")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    test_scanner()
