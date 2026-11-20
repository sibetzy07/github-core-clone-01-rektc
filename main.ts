// The entrypoint: the forge's whole life in one file.
//
// The trial harness starts this process beside the suite's env and hands it
// MAKEFUN_ENV_URL. From there the life is three steps, in order:
//
//   bind -> register -> wait for done.
//
// Bind an ephemeral port (listen(0) lets the kernel pick one; never 8080,
// which the env itself listens on). POST that port to $MAKEFUN_ENV_URL/register
// so the env knows where to dial the forge. Then poll GET $MAKEFUN_ENV_URL/done
// until it answers {"done": true}, and exit 0. The env answers the poll at
// once ({"done": false} while the suite still runs), so this is a poll loop,
// not a held-open request. Nothing here exits early: a failed register or a
// failed poll is retried with backoff, because the env may still be starting
// when this process comes up. The only hard exits are a missing MAKEFUN_ENV_URL
// (exit 1 at once: there is no env to talk to) and a register the env refuses
// as a contract error (400/405).
//
// This file is the forge's own writing of that lifecycle. It imports the
// server from app.ts and nothing else: no package, no model call.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

/** One request may take this long before it is abandoned and retried. */
const CALL_BUDGET_MS = 30_000;
/** Backoff starts here and doubles to this ceiling. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pause after `failures` failed calls: exponential, capped at the ceiling. */
function backoffMs(failures: number): number {
  const step = Math.min(Math.max(0, failures), 8);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** step);
}

/**
 * Tell the env the port this process bound. 200 is the normal answer and 409
 * means a first register already won (this process simply keeps waiting, like
 * any other). A 400 or 405 is a contract error and ends the program; anything
 * else — a network error, a timeout, another status — is retried, since the
 * env may still be starting.
 */
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused with HTTP ')) throw err;
    }
    await pause(backoffMs(failures));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(CALL_BUDGET_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind, announce the port, then wait for the env to say the trial is over. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[forge] registered; waiting for the env to say done\n');

  await waitUntilDone();
  // Wait for the listener to actually close before exiting, so no connection
  // is cut mid-flight while the harness is still reading the last replies.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
