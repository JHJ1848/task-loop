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

if __name__ == "__main__":
    unittest.main()
