import os
import json
import unittest

class TestPluginManifest(unittest.TestCase):
    def setUp(self):
        self.root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

    def test_plugin_json_exists_and_valid(self):
        plugin_path = os.path.join(self.root_dir, "plugin.json")
        self.assertTrue(os.path.exists(plugin_path), "plugin.json must exist at root")
        with open(plugin_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data.get("name"), "task-loop")
        self.assertTrue("version" in data)
        self.assertTrue("capabilities" in data)

    def test_hooks_json_exists_and_valid(self):
        hooks_path = os.path.join(self.root_dir, "hooks.json")
        self.assertTrue(os.path.exists(hooks_path), "hooks.json must exist at root")
        with open(hooks_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertTrue("session-context-injector" in data)
        self.assertTrue("allowlist-safety-gate" in data)

    def test_rules_exist(self):
        rules_path = os.path.join(self.root_dir, "rules", "task-loop-governance.md")
        self.assertTrue(os.path.exists(rules_path), "rules/task-loop-governance.md must exist")

    def test_independent_skills_exist(self):
        expected_skills = ["task-loop", "session-control", "subagent", "hook", "init"]
        for skill_name in expected_skills:
            skill_path = os.path.join(self.root_dir, "skills", skill_name, "SKILL.md")
            self.assertTrue(os.path.exists(skill_path), f"skills/{skill_name}/SKILL.md must exist")
            with open(skill_path, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertTrue(content.startswith("---"), f"skills/{skill_name}/SKILL.md must have YAML frontmatter")
            self.assertTrue('description: "[task-loop]' in content, f"skills/{skill_name}/SKILL.md description must start with [task-loop]")

    def test_zcode_plugin_manifest_exists_and_valid(self):
        manifest_path = os.path.join(self.root_dir, ".zcode-plugin", "plugin.json")
        self.assertTrue(os.path.exists(manifest_path), ".zcode-plugin/plugin.json must exist")
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        import re
        self.assertIsNotNone(
            re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", data.get("name", "")),
            ".zcode-plugin name must satisfy the ZCode manifest regex",
        )
        self.assertEqual(data.get("name"), "task-loop")
        self.assertTrue("skills" in data)

    def test_zcode_hooks_json_exists_and_valid(self):
        hooks_path = os.path.join(self.root_dir, "hooks", "hooks.json")
        self.assertTrue(os.path.exists(hooks_path), "hooks/hooks.json must exist for ZCode")
        with open(hooks_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIn("hooks", data, "ZCode hooks.json must use the outer hooks wrapper")
        allowed_events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop"]
        raw = json.dumps(data)
        for event_name, matchers in data["hooks"].items():
            self.assertIn(event_name, allowed_events, f"unsupported ZCode hook event: {event_name}")
            self.assertTrue(isinstance(matchers, list) and matchers, f"{event_name} must list matcher entries")
            for entry in matchers:
                self.assertTrue(entry.get("hooks"), f"{event_name} matcher must contain hook commands")
                for hook in entry["hooks"]:
                    self.assertIn(hook.get("type"), ("command", "process"))
                    if hook.get("type") == "command":
                        self.assertIsInstance(hook.get("timeout"), (int, float))
                        self.assertLess(hook.get("timeout"), 60)
                    self.assertTrue(
                        "${CLAUDE_PLUGIN_ROOT}" in hook.get("command", "") or "${ZCODE_PLUGIN_ROOT}" in hook.get("command", ""),
                        "plugin hook command must be plugin-root relative",
                    )
        for script in ("inject_session_context_zcode.js", "enforce_allowlist_zcode.js"):
            self.assertIn(script, raw, f"hooks/hooks.json must reference {script}")
            self.assertTrue(
                os.path.exists(os.path.join(self.root_dir, "scripts", "hooks", script)),
                f"scripts/hooks/{script} must exist",
            )

if __name__ == "__main__":
    unittest.main()
