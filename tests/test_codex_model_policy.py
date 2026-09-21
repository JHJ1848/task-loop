import importlib.util
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SPEC = importlib.util.spec_from_file_location("codex_model_policy", os.path.join(ROOT, "scripts", "providers", "codex_model_policy.py"))
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


class TestCodexModelPolicy(unittest.TestCase):
    def test_defaults_and_roles(self):
        self.assertEqual(POLICY.CODEX_MODEL_DEFAULTS["main"], {"model": "gpt-6-astra", "reasoning_effort": "medium"})
        self.assertEqual(POLICY.CODEX_MODEL_DEFAULTS["topic"], {"model": "gpt-5.6-terra", "reasoning_effort": "xhigh"})
        self.assertEqual(POLICY.CODEX_MODEL_DEFAULTS["subagent"], {"model": "gpt-5.6-luna", "reasoning_effort": "max"})
        self.assertEqual(POLICY.role_for_session({"module_key": "subagent"}), "subagent")

    def test_sticky_and_explicit_precedence(self):
        topic = POLICY.apply_initial_model_config({"module_key": "topic"}, "topic")
        self.assertEqual(topic["model_config"]["model"], "gpt-5.6-terra")
        self.assertEqual(topic["model_config"]["reasoning_effort"], "xhigh")
        explicit = {"module_key": "topic", "model_config": {"model": "custom-model", "reasoning_effort": "low", "source": "user", "explicit": True}}
        self.assertEqual(POLICY.apply_initial_model_config(explicit, "topic"), explicit)
        self.assertEqual(POLICY.resolve_model_config({"thinking": "max"}, "topic"), {"model": "gpt-5.6-terra", "reasoning_effort": "max", "role": "topic"})

    def test_stale_generated_default_is_corrected(self):
        stale = {"module_key": "subagent", "model_config": {"model": "gpt-5.6-terra", "reasoning_effort": "xhigh", "role": "topic", "source": "task-loop-default", "explicit": False}}
        corrected = POLICY.apply_initial_model_config(stale, "subagent")
        self.assertEqual(corrected["model_config"]["model"], "gpt-5.6-luna")
        self.assertEqual(corrected["model_config"]["reasoning_effort"], "max")

    def test_create_request(self):
        request = POLICY.build_create_thread_request(
            project_id="project-1", title="topic", prompt="init", role="topic"
        )
        self.assertEqual(request["model"], "gpt-5.6-terra")
        self.assertEqual(request["thinking"], "xhigh")
        self.assertEqual(request["target"], {"type": "project", "projectId": "project-1", "environment": {"type": "worktree"}})


if __name__ == "__main__":
    unittest.main()
