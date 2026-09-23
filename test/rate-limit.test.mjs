// Unit tests for the shared rate-limit retry helper (plain Node, no Electron).
import assert from "node:assert/strict";
import {
  withRateLimitRetry,
  isRateLimitError,
  isTransientError,
  errorSummary,
  sanitizeResumeCheckpoint,
  createProgressTracker,
} from '../dist-electron/rate-limit.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    failed++;
  }
}

console.log('\n=== Rate Limit Retry Tests ===');

await test('isRateLimitError matches 429 messages, codes and statuses', () => {
  assert.equal(isRateLimitError(new Error('RateLimitCapacityError: 429 You have reached the request limit')), true);
  assert.equal(isRateLimitError(new Error('Too Many Requests')), true);
  assert.equal(isRateLimitError(Object.assign(new Error('provider error'), { code: 429 })), true);
  assert.equal(isRateLimitError(Object.assign(new Error('provider error'), { status: 429 })), true);
  assert.equal(isRateLimitError(new Error('Invalid API key')), false);
  assert.equal(isRateLimitError(new Error('socket hang up')), false);
});

await test('withRateLimitRetry retries rate-limited operations until success', async () => {
  let calls = 0;
  const retries = [];
  const result = await withRateLimitRetry(
    async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('429 rate limit exceeded'), { code: 429 });
      return 'ok';
    },
    { baseDelayMs: 1, onRetry: (info) => retries.push(info.attempt) }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(retries, [2, 3]);
});

await test('withRateLimitRetry gives up after maxAttempts and rethrows', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRateLimitRetry(
      async () => {
        calls++;
        throw new Error('429 Too Many Requests');
      },
      { maxAttempts: 3, baseDelayMs: 1 }
    ),
    /429/
  );
  assert.equal(calls, 3);
});

await test('withRateLimitRetry does not retry non-rate-limit errors', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRateLimitRetry(
      async () => {
        calls++;
        throw new Error('Invalid API key provided');
      },
      { baseDelayMs: 1 }
    ),
    /Invalid API key/
  );
  assert.equal(calls, 1);
});

await test('withRateLimitRetry uses exponential backoff delays', async () => {
  const delays = [];
  let calls = 0;
  await withRateLimitRetry(
    async () => {
      calls++;
      if (calls < 4) throw new Error('rate limit');
      return true;
    },
    { baseDelayMs: 10, onRetry: ({ delayMs }) => delays.push(delayMs) }
  );
  assert.deepEqual(delays, [10, 20, 40]);
});

await test('prepareAttempt runs before every attempt and can abort the run', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRateLimitRetry(
      async () => {
        calls++;
        throw new Error('429');
      },
      {
        baseDelayMs: 1,
        prepareAttempt: () => {
          if (calls >= 1) throw new Error('RunCancelledError');
        },
      }
    ),
    /RunCancelledError/
  );
  assert.equal(calls, 1); // cancellation prevented any retry
});

await test('isTransientError matches connection and overload errors, not tool timeouts or auth', () => {
  assert.equal(isTransientError(new Error('socket hang up')), true);
  assert.equal(isTransientError(new Error('fetch failed')), true);
  assert.equal(isTransientError(new Error('Connection error: read ECONNRESET')), true);
  assert.equal(isTransientError(new Error('Request timed out')), true);
  assert.equal(isTransientError(Object.assign(new Error('provider error'), { status: 503 })), true);
  assert.equal(isTransientError(new Error('APIConnectionError: network unreachable')), true);
  assert.equal(isTransientError(new Error('429 rate limited')), true);
  assert.equal(isTransientError(new Error('Invalid API key')), false);
  assert.equal(isTransientError(new Error('Command timed out')), false);
  assert.equal(isTransientError(new Error('Execution timeout exceeded')), false);
});

await test('a failure after observable progress resets the attempt counter', async () => {
  let calls = 0;
  let progressed = false;
  const attempts = [];
  const resets = [];
  const result = await withRateLimitRetry(
    async () => {
      calls++;
      if (calls === 2 || calls === 3) {
        // these attempts made progress before failing -> each counts as a new incident
        progressed = true;
      }
      if (calls < 5) throw Object.assign(new Error('429 rate limit'), { code: 429 });
      return 'ok';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 1,
      madeProgress: () => {
        const value = progressed;
        progressed = false;
        return value;
      },
      onRetry: (info) => {
        attempts.push(info.attempt);
        resets.push(info.reset);
      },
    }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 5);
  // failures 1 and 4 had no progress -> counted normally; failures 2 and 3 had
  // progress -> the countdown restarted at 1 each time (next retry = attempt 2)
  assert.deepEqual(attempts, [2, 2, 2, 3]);
  assert.deepEqual(resets, [false, true, true, false]);
});

await test('progress-based resets are capped so hopeless loops still terminate', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRateLimitRetry(
      async () => {
        calls++;
        throw new Error('connection error');
      },
      { maxAttempts: 2, baseDelayMs: 1, maxProgressResets: 3, madeProgress: () => true }
    ),
    /connection error/
  );
  // first attempt + 3 resets + final attempt without reset
  assert.equal(calls, 5);
});

await test('madeProgress is not consulted after the first failure', async () => {
  let calls = 0;
  let probes = 0;
  const result = await withRateLimitRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('429 rate limited');
      return 'ok';
    },
    {
      baseDelayMs: 1,
      madeProgress: () => {
        probes++;
        return false;
      },
    }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.equal(probes, 1); // probed after the second failure, never the first
});

await test('sanitizeResumeCheckpoint drops trailing unanswered tool calls', () => {
  const msgs = [
    { id: '1', type: 'human' },
    { id: '2', type: 'ai', tool_calls: [{ id: 'c1', name: 'read' }] },
    { id: '3', type: 'tool' },
    { id: '4', type: 'ai', tool_calls: [{ id: 'c2', name: 'write' }] }, // unanswered
  ];
  const checkpoint = sanitizeResumeCheckpoint(msgs);
  assert.equal(checkpoint.length, 3);
  assert.equal(checkpoint[checkpoint.length - 1].type, 'tool');
  // all-AI-tool_calls edge case: everything is pruned
  assert.deepEqual(sanitizeResumeCheckpoint([msgs[1]]), []);
  assert.deepEqual(sanitizeResumeCheckpoint([]), []);
});

await test('sanitizeResumeCheckpoint prunes trailing duplicate read/inspection loops', () => {
  const loopMsgs = [
    { type: 'human', text: 'build an app' },
    { type: 'ai', tool_calls: [{ name: 'execute', args: { command: 'npm run build' } }] },
    { type: 'tool', content: 'build ok' },
    { type: 'ai', tool_calls: [{ name: 'read_file', args: { file_path: 'src/App.tsx' } }] },
    { type: 'tool', content: 'app content' },
    { type: 'ai', tool_calls: [{ name: 'read_file', args: { file_path: 'src/App.tsx' } }] },
    { type: 'tool', content: 'app content' },
    { type: 'ai', tool_calls: [{ name: 'read_file', args: { file_path: 'src/App.tsx' } }] },
    { type: 'tool', content: 'app content' },
    { type: 'ai', tool_calls: [{ name: 'read_file', args: { file_path: 'src/App.tsx' } }] }, // trailing unanswered
  ];
  const cleaned = sanitizeResumeCheckpoint(loopMsgs);
  // Trailing unanswered dropped + 2 duplicate pairs pruned = 1 read_file pair remains
  assert.equal(cleaned.length, 5);
  assert.equal(cleaned[cleaned.length - 1].type, 'tool');
  assert.equal(cleaned[cleaned.length - 2].tool_calls[0].name, 'read_file');
});

await test('createProgressTracker counts superstep and tool-result progress per attempt', () => {
  const tracker = createProgressTracker();
  tracker.beginAttempt(2);
  assert.equal(tracker.madeProgress(), false);
  tracker.noteSuperstep(3);
  assert.equal(tracker.madeProgress(), true);
  assert.equal(tracker.madeProgress(), false); // consumed
  tracker.noteToolResult();
  assert.equal(tracker.madeProgress(), true);
  // a new attempt clears the marker
  tracker.beginAttempt(5);
  assert.equal(tracker.madeProgress(), false);
  // replayed state at or below baseline is not progress
  tracker.noteSuperstep(5);
  assert.equal(tracker.madeProgress(), false);
});

await test('errorSummary flattens and caps error text', () => {
  assert.equal(errorSummary(new Error('  429 Too   Many\nRequests  ')), '429 Too Many Requests');
  assert.equal(errorSummary(Object.assign(new Error('x'), { message: 'y'.repeat(200) })).length, 91);
  assert.equal(errorSummary('no-error'), 'no-error');
  assert.equal(errorSummary(''), 'unknown error');
});

await test('isTransientError returns false for RunCancelledError and AbortError', () => {
  const cancelErr = new Error('Execution cancelled by user');
  cancelErr.name = 'RunCancelledError';
  assert.equal(isTransientError(cancelErr), false);

  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';
  assert.equal(isTransientError(abortErr), false);
});

await test('withRateLimitRetry aborts immediately without retrying when cancelled', async () => {
  let attempts = 0;
  const controller = new AbortController();
  const cancelErr = new Error('Execution cancelled by user');
  cancelErr.name = 'RunCancelledError';

  await assert.rejects(
    () => withRateLimitRetry(
      async () => {
        attempts++;
        throw cancelErr;
      },
      {
        signal: controller.signal,
        baseDelayMs: 5000,
        maxAttempts: 3,
      }
    ),
    (err) => err.name === 'RunCancelledError'
  );

  assert.equal(attempts, 1);
});

await test('withRateLimitRetry aborts backoff delay immediately via signal', async () => {
  let attempts = 0;
  const controller = new AbortController();

  const start = Date.now();
  const runPromise = withRateLimitRetry(
    async () => {
      attempts++;
      throw Object.assign(new Error('429 rate limit'), { code: 429 });
    },
    {
      signal: controller.signal,
      baseDelayMs: 10000,
      maxAttempts: 3,
    }
  );

  // Trigger abort after 50ms while sleeping in backoff
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(runPromise, (err) => err.name === 'AbortError' || err.message?.includes('aborted'));
  const duration = Date.now() - start;
  assert.ok(duration < 2000, `Expected instant abort, took ${duration}ms`);
  assert.equal(attempts, 1);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

