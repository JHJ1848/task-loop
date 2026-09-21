#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
runtime_paths.py - 统一 Python 运行态环境与路径解析辅助模块
提供标准的项目根目录、脚本目录、Provider 目录路径，并规范化注册到 sys.path。
零外部依赖，100% 纯 Python 标准库。
"""

import os
import sys
from pathlib import Path

# 计算核心目录
SCRIPTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS_DIR.parent
PROVIDERS_DIR = SCRIPTS_DIR / "providers"


def ensure_runtime_paths():
    """将 scripts 目录、providers 目录与项目根目录规范注册到 sys.path 前端"""
    candidates = [str(SCRIPTS_DIR), str(PROVIDERS_DIR), str(PROJECT_ROOT)]
    for p in reversed(candidates):
        if p not in sys.path:
            sys.path.insert(0, p)


# 模块导入时自动执行一次路径注册
ensure_runtime_paths()

__all__ = ["SCRIPTS_DIR", "PROJECT_ROOT", "PROVIDERS_DIR", "ensure_runtime_paths"]
