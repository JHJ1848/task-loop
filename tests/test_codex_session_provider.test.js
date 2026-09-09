const assert = require('assert');
const provider = require('../scripts/providers/codex_session_provider');

assert.strictEqual(provider.submit({ thread: 't', prompt: 'p' }, { desktop: () => ({ submitted: true }) }, { cli: false }).transport, 'desktop');
assert.strictEqual(provider.submit({ thread: 't', message: 'p' }, { sdk: () => ({ submitted: true }) }, { cli: false }).transport, 'sdk');
assert.strictEqual(provider.submit({ thread: 't', message: 'p' }, { api: () => ({ submitted: false }) }, { cli: false }).status, 'PREPARED_ONLY');
assert.strictEqual(provider.submit({ thread: 't', message: 'p' }, {}, { runCli: () => ({ status: 0 }) }).status, 'SUBMITTED');
assert.strictEqual(provider.submit({ message: 'p' }, {}, { cli: false }).status, 'PREPARED_ONLY');
assert.strictEqual(provider.submit(null, {}, { cli: false }).status, 'PREPARED_ONLY');
let asyncInvoked = false;
const asyncAdapter = async () => { asyncInvoked = true; return { submitted: true }; };
assert.strictEqual(provider.submit({ thread: 't', message: 'p' }, { desktop: asyncAdapter }, { cli: false }).status, 'PREPARED_ONLY');
assert.strictEqual(asyncInvoked, false);
console.log('Codex session provider Node.js tests PASSED!');
