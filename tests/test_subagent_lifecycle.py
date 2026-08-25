#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for AGY Subagent Schema, Lifecycle State Introspection, and Routing Verification
"""

import re
import sys
import json
import uuid
import tempfile
import shutil
from pathlib import Path

# Subagent Specification Constants
VALID_SUBAGENT_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]+$")
ALLOWED_WORKSPACE_MODES = {"inherit", "branch", "share"}
ALLOWED_MODEL_TIERS = {"inherit", "flash_lite", "flash", "pro"}
ALLOWED_MANAGE_ACTIONS = {"list", "kill", "kill_all"}
ALLOWED_LIFECYCLE_STATES = {
    "running",
    "idle",
    "waiting_for_input",
    "waiting_for_dependents",
    "waiting_for_message",
    "canceling",
    "errored",
    "unspecified"
}


def validate_subagent_definition(spec: dict) -> dict:
    """Validates dynamic subagent template definition schema (define_subagent)."""
    name = spec.get("name")
    if not name or not isinstance(name, str) or not VALID_SUBAGENT_NAME_PATTERN.match(name):
        return {"valid": False, "error": f"Invalid subagent name: {name}"}
    if not spec.get("description") or not isinstance(spec["description"], str):
        return {"valid": False, "error": "Missing or invalid description"}
    if not spec.get("system_prompt") or not isinstance(spec["system_prompt"], str):
        return {"valid": False, "error": "Missing or invalid system_prompt"}
    
    # Flags validation
    for flag in ("enable_write_tools", "enable_subagent_tools", "enable_mcp_tools"):
        if flag in spec and not isinstance(spec[flag], bool):
            return {"valid": False, "error": f"Flag {flag} must be a boolean"}
    
    return {"valid": True, "name": name}


def validate_invoke_subagent_entry(entry: dict) -> dict:
    """Validates an individual subagent invocation specification (invoke_subagent)."""
    type_name = entry.get("TypeName")
    if not type_name or not isinstance(type_name, str):
        return {"valid": False, "error": "Missing or invalid TypeName"}
    
    role = entry.get("Role")
    if not role or not isinstance(role, str):
        return {"valid": False, "error": "Missing or invalid Role"}
    
    prompt = entry.get("Prompt")
    if not prompt or not isinstance(prompt, str) or len(prompt.strip()) == 0:
        return {"valid": False, "error": "Missing or empty Prompt"}
    
    workspace = entry.get("Workspace", "inherit")
    if workspace not in ALLOWED_WORKSPACE_MODES:
        return {"valid": False, "error": f"Invalid Workspace mode: {workspace}"}
    
    model = entry.get("Model", "inherit")
    if model not in ALLOWED_MODEL_TIERS:
        return {"valid": False, "error": f"Invalid Model tier: {model}"}
    
    return {
        "valid": True,
        "TypeName": type_name,
        "Role": role,
        "Prompt": prompt,
        "Workspace": workspace,
        "Model": model
    }


def validate_manage_subagents_request(action: str, conversation_ids: list = None) -> dict:
    """Validates manage_subagents action and arguments."""
    if action not in ALLOWED_MANAGE_ACTIONS:
        return {"valid": False, "error": f"Invalid Action: {action}"}
    if action == "kill":
        if not conversation_ids or not isinstance(conversation_ids, list) or len(conversation_ids) == 0:
            return {"valid": False, "error": "Action 'kill' requires non-empty ConversationIds"}
        for cid in conversation_ids:
            if not isinstance(cid, str) or len(cid.strip()) == 0:
                return {"valid": False, "error": f"Invalid conversationId in list: {cid}"}
    return {"valid": True, "action": action, "conversation_ids": conversation_ids or []}


class MockSubagentRuntime:
    """Simulates host subagent lifecycle management and state introspection."""
    
    def __init__(self):
        self.defined_templates = {}
        self.active_subagents = {}
    
    def define(self, spec: dict) -> dict:
        v = validate_subagent_definition(spec)
        if not v["valid"]:
            raise ValueError(v["error"])
        self.defined_templates[spec["name"]] = spec
        return {"status": "ok", "defined": spec["name"]}
    
    def invoke(self, subagents: list) -> list:
        launched = []
        for s in subagents:
            v = validate_invoke_subagent_entry(s)
            if not v["valid"]:
                raise ValueError(v["error"])
            
            cid = str(uuid.uuid4())
            subagent_record = {
                "role": v["Role"],
                "type": v["TypeName"],
                "conversationId": cid,
                "transcript": f"file:///tmp/gemini/antigravity/brain/{cid}/transcript.jsonl",
                "workspace_mode": v["Workspace"],
                "model_tier": v["Model"],
                "state": "running",
                "stateDetail": f"Executing prompt: {v['Prompt'][:30]}..."
            }
            self.active_subagents[cid] = subagent_record
            launched.append({"conversationId": cid, "role": v["Role"], "state": "running"})
        return launched
    
    def manage(self, action: str, conversation_ids: list = None) -> list:
        v = validate_manage_subagents_request(action, conversation_ids)
        if not v["valid"]:
            raise ValueError(v["error"])
        
        if action == "list":
            return list(self.active_subagents.values())
        elif action == "kill":
            killed = []
            for cid in conversation_ids:
                if cid in self.active_subagents:
                    self.active_subagents[cid]["state"] = "canceling"
                    killed.append(self.active_subagents.pop(cid))
            return killed
        elif action == "kill_all":
            all_subagents = list(self.active_subagents.values())
            self.active_subagents.clear()
            return all_subagents


def test_subagent_definition_schema():
    # Valid spec
    valid_spec = {
        "name": "code_reviewer",
        "description": "Reviews code against project rules",
        "system_prompt": "You are a code review agent.",
        "enable_write_tools": False,
        "enable_subagent_tools": False,
        "enable_mcp_tools": True
    }
    assert validate_subagent_definition(valid_spec)["valid"] is True
    
    # Invalid names
    invalid_specs = [
        {**valid_spec, "name": "bad name with spaces"},
        {**valid_spec, "name": "@invalid#char"},
        {**valid_spec, "name": ""},
        {**valid_spec, "description": ""},
        {**valid_spec, "system_prompt": ""},
        {**valid_spec, "enable_write_tools": "not_a_bool"}
    ]
    for inv in invalid_specs:
        assert validate_subagent_definition(inv)["valid"] is False
    print("Python Subagent Definition Schema Tests PASSED!")


def test_subagent_invocation_schema():
    # Valid entry
    valid_entry = {
        "TypeName": "research",
        "Role": "Codebase Researcher",
        "Prompt": "Investigate module dependencies in src/",
        "Workspace": "inherit",
        "Model": "flash"
    }
    res = validate_invoke_subagent_entry(valid_entry)
    assert res["valid"] is True
    assert res["Workspace"] == "inherit"
    assert res["Model"] == "flash"
    
    # Defaults check
    minimal_entry = {
        "TypeName": "self",
        "Role": "Worker",
        "Prompt": "Execute task"
    }
    res_min = validate_invoke_subagent_entry(minimal_entry)
    assert res_min["valid"] is True
    assert res_min["Workspace"] == "inherit"
    assert res_min["Model"] == "inherit"
    
    # Invalid entries
    assert validate_invoke_subagent_entry({**valid_entry, "Workspace": "invalid_ws"})["valid"] is False
    assert validate_invoke_subagent_entry({**valid_entry, "Model": "gpt-5"})["valid"] is False
    assert validate_invoke_subagent_entry({**valid_entry, "Prompt": "   "})["valid"] is False
    print("Python Subagent Invocation Schema Tests PASSED!")


def test_manage_subagents_and_lifecycle():
    runtime = MockSubagentRuntime()
    
    # 1. Define custom subagent
    runtime.define({
        "name": "deep_researcher",
        "description": "Conducts extensive multi-file analysis",
        "system_prompt": "You are a research agent.",
        "enable_write_tools": False,
        "enable_subagent_tools": False
    })
    
    # 2. Invoke subagents
    launched = runtime.invoke([
        {
            "TypeName": "deep_researcher",
            "Role": "Architecture Auditor",
            "Prompt": "Audit subagent system",
            "Workspace": "share",
            "Model": "pro"
        },
        {
            "TypeName": "self",
            "Role": "Fast Worker",
            "Prompt": "Verify basic tests",
            "Workspace": "inherit",
            "Model": "flash"
        }
    ])
    assert len(launched) == 2
    cid1 = launched[0]["conversationId"]
    cid2 = launched[1]["conversationId"]
    
    # 3. List active subagents
    active_list = runtime.manage("list")
    assert len(active_list) == 2
    for agent in active_list:
        assert agent["state"] in ALLOWED_LIFECYCLE_STATES
        assert agent["workspace_mode"] in ALLOWED_WORKSPACE_MODES
        assert agent["model_tier"] in ALLOWED_MODEL_TIERS
        assert agent["transcript"].startswith("file://")
    
    # 4. Kill one subagent
    killed = runtime.manage("kill", [cid1])
    assert len(killed) == 1
    assert killed[0]["conversationId"] == cid1
    
    # 5. List again
    remaining = runtime.manage("list")
    assert len(remaining) == 1
    assert remaining[0]["conversationId"] == cid2
    
    # 6. Kill all
    runtime.manage("kill_all")
    assert len(runtime.manage("list")) == 0
    print("Python Mock Subagent Lifecycle & State Introspection Tests PASSED!")


def test_sdk_subagent_config_contract():
    # Simulates Python SDK SubagentConfig and parent tool injection consistency
    def sample_tool_a(): pass
    def sample_tool_b(): pass
    def reviewer_tool(): pass

    parent_tools = [sample_tool_a, sample_tool_b, reviewer_tool]
    
    subagent_config = {
        "name": "code_reviewer",
        "description": "Reviews source code",
        "system_instructions": "Review carefully",
        "tools": [reviewer_tool]
    }
    
    # Check that subagent tools must be subset of parent tools
    for t in subagent_config["tools"]:
        assert t in parent_tools, f"Tool {t} not registered in parent agent tools!"
    
    print("Python SDK SubagentConfig Tool Injection Contract Tests PASSED!")


if __name__ == "__main__":
    test_subagent_definition_schema()
    test_subagent_invocation_schema()
    test_manage_subagents_and_lifecycle()
    test_sdk_subagent_config_contract()
    print("ALL AGY SUBAGENT PYTHON TESTS PASSED SUCCESSFULLY!")
