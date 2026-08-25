#!/usr/bin/env node
/**
 * Unit test for AGY Subagent Schema, Lifecycle State Introspection, and Routing Verification (Node.js)
 */

const assert = require('assert');
const crypto = require('crypto');

const VALID_SUBAGENT_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const ALLOWED_WORKSPACE_MODES = new Set(['inherit', 'branch', 'share']);
const ALLOWED_MODEL_TIERS = new Set(['inherit', 'flash_lite', 'flash', 'pro']);
const ALLOWED_MANAGE_ACTIONS = new Set(['list', 'kill', 'kill_all']);
const ALLOWED_LIFECYCLE_STATES = new Set([
  'running',
  'idle',
  'waiting_for_input',
  'waiting_for_dependents',
  'waiting_for_message',
  'canceling',
  'errored',
  'unspecified'
]);

function validateSubagentDefinition(spec) {
  const name = spec.name;
  if (!name || typeof name !== 'string' || !VALID_SUBAGENT_NAME_PATTERN.test(name)) {
    return { valid: false, error: `Invalid subagent name: ${name}` };
  }
  if (!spec.description || typeof spec.description !== 'string') {
    return { valid: false, error: 'Missing or invalid description' };
  }
  if (!spec.system_prompt || typeof spec.system_prompt !== 'string') {
    return { valid: false, error: 'Missing or invalid system_prompt' };
  }

  for (const flag of ['enable_write_tools', 'enable_subagent_tools', 'enable_mcp_tools']) {
    if (flag in spec && typeof spec[flag] !== 'boolean') {
      return { valid: false, error: `Flag ${flag} must be a boolean` };
    }
  }

  return { valid: true, name };
}

function validateInvokeSubagentEntry(entry) {
  const typeName = entry.TypeName;
  if (!typeName || typeof typeName !== 'string') {
    return { valid: false, error: 'Missing or invalid TypeName' };
  }

  const role = entry.Role;
  if (!role || typeof role !== 'string') {
    return { valid: false, error: 'Missing or invalid Role' };
  }

  const prompt = entry.Prompt;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { valid: false, error: 'Missing or empty Prompt' };
  }

  const workspace = entry.Workspace || 'inherit';
  if (!ALLOWED_WORKSPACE_MODES.has(workspace)) {
    return { valid: false, error: `Invalid Workspace mode: ${workspace}` };
  }

  const model = entry.Model || 'inherit';
  if (!ALLOWED_MODEL_TIERS.has(model)) {
    return { valid: false, error: `Invalid Model tier: ${model}` };
  }

  return {
    valid: true,
    TypeName: typeName,
    Role: role,
    Prompt: prompt,
    Workspace: workspace,
    Model: model
  };
}

function validateManageSubagentsRequest(action, conversationIds) {
  if (!ALLOWED_MANAGE_ACTIONS.has(action)) {
    return { valid: false, error: `Invalid Action: ${action}` };
  }
  if (action === 'kill') {
    if (!conversationIds || !Array.isArray(conversationIds) || conversationIds.length === 0) {
      return { valid: false, error: "Action 'kill' requires non-empty ConversationIds" };
    }
    for (const cid of conversationIds) {
      if (typeof cid !== 'string' || cid.trim().length === 0) {
        return { valid: false, error: `Invalid conversationId in list: ${cid}` };
      }
    }
  }
  return { valid: true, action, conversationIds: conversationIds || [] };
}

class MockSubagentRuntime {
  constructor() {
    this.definedTemplates = {};
    this.activeSubagents = {};
  }

  define(spec) {
    const v = validateSubagentDefinition(spec);
    if (!v.valid) {
      throw new Error(v.error);
    }
    this.definedTemplates[spec.name] = spec;
    return { status: 'ok', defined: spec.name };
  }

  invoke(subagents) {
    const launched = [];
    for (const s of subagents) {
      const v = validateInvokeSubagentEntry(s);
      if (!v.valid) {
        throw new Error(v.error);
      }

      const cid = crypto.randomUUID();
      const subagentRecord = {
        role: v.Role,
        type: v.TypeName,
        conversationId: cid,
        transcript: `file:///tmp/gemini/antigravity/brain/${cid}/transcript.jsonl`,
        workspace_mode: v.Workspace,
        model_tier: v.Model,
        state: 'running',
        stateDetail: `Executing prompt: ${v.Prompt.slice(0, 30)}...`
      };
      this.activeSubagents[cid] = subagentRecord;
      launched.push({ conversationId: cid, role: v.Role, state: 'running' });
    }
    return launched;
  }

  manage(action, conversationIds) {
    const v = validateManageSubagentsRequest(action, conversationIds);
    if (!v.valid) {
      throw new Error(v.error);
    }

    if (action === 'list') {
      return Object.values(this.activeSubagents);
    } else if (action === 'kill') {
      const killed = [];
      for (const cid of conversationIds) {
        if (this.activeSubagents[cid]) {
          this.activeSubagents[cid].state = 'canceling';
          killed.push(this.activeSubagents[cid]);
          delete this.activeSubagents[cid];
        }
      }
      return killed;
    } else if (action === 'kill_all') {
      const allSubagents = Object.values(this.activeSubagents);
      this.activeSubagents = {};
      return allSubagents;
    }
  }
}

function testSubagentDefinitionSchema() {
  const validSpec = {
    name: 'code_reviewer',
    description: 'Reviews code against project rules',
    system_prompt: 'You are a code review agent.',
    enable_write_tools: false,
    enable_subagent_tools: false,
    enable_mcp_tools: true
  };
  assert.strictEqual(validateSubagentDefinition(validSpec).valid, true);

  const invalidSpecs = [
    { ...validSpec, name: 'bad name with spaces' },
    { ...validSpec, name: '@invalid#char' },
    { ...validSpec, name: '' },
    { ...validSpec, description: '' },
    { ...validSpec, system_prompt: '' },
    { ...validSpec, enable_write_tools: 'not_a_bool' }
  ];
  for (const inv of invalidSpecs) {
    assert.strictEqual(validateSubagentDefinition(inv).valid, false);
  }
  console.log('Node.js Subagent Definition Schema Tests PASSED!');
}

function testSubagentInvocationSchema() {
  const validEntry = {
    TypeName: 'research',
    Role: 'Codebase Researcher',
    Prompt: 'Investigate module dependencies in src/',
    Workspace: 'inherit',
    Model: 'flash'
  };
  const res = validateInvokeSubagentEntry(validEntry);
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.Workspace, 'inherit');
  assert.strictEqual(res.Model, 'flash');

  const minimalEntry = {
    TypeName: 'self',
    Role: 'Worker',
    Prompt: 'Execute task'
  };
  const resMin = validateInvokeSubagentEntry(minimalEntry);
  assert.strictEqual(resMin.valid, true);
  assert.strictEqual(resMin.Workspace, 'inherit');
  assert.strictEqual(resMin.Model, 'inherit');

  assert.strictEqual(validateInvokeSubagentEntry({ ...validEntry, Workspace: 'invalid_ws' }).valid, false);
  assert.strictEqual(validateInvokeSubagentEntry({ ...validEntry, Model: 'gpt-5' }).valid, false);
  assert.strictEqual(validateInvokeSubagentEntry({ ...validEntry, Prompt: '   ' }).valid, false);
  console.log('Node.js Subagent Invocation Schema Tests PASSED!');
}

function testManageSubagentsAndLifecycle() {
  const runtime = new MockSubagentRuntime();

  // 1. Define custom subagent
  runtime.define({
    name: 'deep_researcher',
    description: 'Conducts extensive multi-file analysis',
    system_prompt: 'You are a research agent.',
    enable_write_tools: false,
    enable_subagent_tools: false
  });

  // 2. Invoke subagents
  const launched = runtime.invoke([
    {
      TypeName: 'deep_researcher',
      Role: 'Architecture Auditor',
      Prompt: 'Audit subagent system',
      Workspace: 'share',
      Model: 'pro'
    },
    {
      TypeName: 'self',
      Role: 'Fast Worker',
      Prompt: 'Verify basic tests',
      Workspace: 'inherit',
      Model: 'flash'
    }
  ]);
  assert.strictEqual(launched.length, 2);
  const cid1 = launched[0].conversationId;
  const cid2 = launched[1].conversationId;

  // 3. List active subagents
  const activeList = runtime.manage('list');
  assert.strictEqual(activeList.length, 2);
  for (const agent of activeList) {
    assert.strictEqual(ALLOWED_LIFECYCLE_STATES.has(agent.state), true);
    assert.strictEqual(ALLOWED_WORKSPACE_MODES.has(agent.workspace_mode), true);
    assert.strictEqual(ALLOWED_MODEL_TIERS.has(agent.model_tier), true);
    assert.strictEqual(agent.transcript.startsWith('file://'), true);
  }

  // 4. Kill one subagent
  const killed = runtime.manage('kill', [cid1]);
  assert.strictEqual(killed.length, 1);
  assert.strictEqual(killed[0].conversationId, cid1);

  // 5. List again
  const remaining = runtime.manage('list');
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].conversationId, cid2);

  // 6. Kill all
  runtime.manage('kill_all');
  assert.strictEqual(runtime.manage('list').length, 0);
  console.log('Node.js Mock Subagent Lifecycle & State Introspection Tests PASSED!');
}

function runAll() {
  testSubagentDefinitionSchema();
  testSubagentInvocationSchema();
  testManageSubagentsAndLifecycle();
  console.log('ALL AGY SUBAGENT NODE.JS TESTS PASSED SUCCESSFULLY!');
}

runAll();
