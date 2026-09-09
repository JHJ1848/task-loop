const assert = require('assert');
const provider = require('../scripts/providers/codex_session_dispatch');

const queue = provider.dispatch({ thread: 'thread-1', message: 'hello', mode: 'queue' }, () => ({ status: 0 }));
assert.deepStrictEqual(queue.command.slice(1), ['queue', '--thread', 'thread-1', '--message', 'hello']);
assert.strictEqual(queue.status, 'SUBMITTED');
assert.strictEqual(queue.submitted, true);

const resume = provider.dispatch({ thread: 'thread-2', message: 'continue', mode: 'resume' }, () => ({ status: 0 }));
assert.deepStrictEqual(resume.command.slice(1), ['exec', 'resume', 'thread-2', 'continue']);
assert.strictEqual(resume.status, 'SUBMITTED');

const failed = provider.dispatch({ thread: 'thread-3', message: 'nope' }, () => ({ status: 7 }));
assert.strictEqual(failed.status, 'PREPARED_ONLY');
assert.strictEqual(failed.submitted, false);

const launchFailure = provider.dispatch({ thread: 'thread-3b', message: 'nope' }, () => {
  throw new Error('permission denied');
});
assert.strictEqual(launchFailure.status, 'PREPARED_ONLY');
assert.match(launchFailure.reason, /launch failed/);

const argvSeen = [];
provider.dispatch({ thread: 'thread-3c', message: 'argv' }, (argv) => {
  argvSeen.push(argv);
  return { status: 0 };
});
assert.deepStrictEqual(argvSeen[0].slice(1), ['queue', '--thread', 'thread-3c', '--message', 'argv']);

const prepared = provider.dispatch({ thread: 'thread-4', message: 'preview', dryRun: true });
assert.strictEqual(prepared.status, 'PREPARED_ONLY');
assert.strictEqual(prepared.submitted, false);

console.log('Codex session dispatch Node.js tests PASSED!');
