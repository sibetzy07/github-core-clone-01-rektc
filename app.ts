// The forge's HTTP front door: one server, four surfaces, one store.
//
// Routing is deliberately thin here. This file owns only the things every surface
// shares: reading the request body, the bearer-token gate for the API surfaces,
// the X-GitHub-Request-Id header on REST replies, and the JSON 404 for anything
// it does not recognise. The real work lives in src/git.ts (smart HTTP),
// src/rest.ts (REST v3), src/graphql.ts (GraphQL v4) and src/mcp.ts (MCP), each
// of which receives the store and the raw request and answers with a status,
// headers and a Buffer body.
//
// The store is created once per process and shared by every handler, so a
// repository or an issue created over MCP reads back over REST as the same
// object. Nothing here touches the wall clock or Math.random: the store owns
// the only clock (a logical counter), and request ids come from a counter too.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleGit } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import type { HandlerResult } from './src/store.ts';

const JSON_MIME = 'application/json; charset=utf-8';
const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';

/** The bearer token the process was handed, or '' when there is none (local runs). */
function expectedToken(): string {
  return process.env[TOKEN_ENV] ?? '';
}

/** The Authorization header's token, or null when the header is absent or malformed. */
function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return null;
  const prefix = 'Bearer ';
  if (!raw.startsWith(prefix)) return null;
  const token = raw.slice(prefix.length).trim();
  return token === '' ? null : token;
}

/** Whether the request carries a token this process accepts. */
function authorized(req: IncomingMessage): boolean {
  const presented = bearerOf(req);
  if (presented === null) return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return presented === expected;
}

/** A lowercase-keyed copy of the request headers, for the handlers. */
function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
  }
  return out;
}

/** Read the whole request body into one Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The request path (no query string), or '/' when the URL does not parse. */
function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://forge').pathname;
  } catch {
    return '/';
  }
}

/** The request query string, parsed, or an empty set when the URL does not parse. */
function requestQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://forge').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function unauthorizedResult(): HandlerResult {
  return { status: 401, headers: { 'content-type': JSON_MIME }, body: jsonBytes({ message: 'Requires authentication' }) };
}

function notFoundResult(): HandlerResult {
  return { status: 404, headers: { 'content-type': JSON_MIME }, body: jsonBytes({ message: 'Not Found' }) };
}

/** Write a handler's answer onto the response, always with a content-length. */
function answer(res: ServerResponse, result: HandlerResult, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = { ...extraHeaders, ...result.headers };
  if (headers['content-length'] === undefined) headers['content-length'] = String(result.body.length);
  res.writeHead(result.status, headers);
  res.end(result.body);
}

/** Whether `path` is a git smart-HTTP route: /{owner}/{repo}.git/... */
function isGitRoute(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);
}

/** Build the server. It binds nothing until the caller listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = requestPath(req);
      const method = req.method ?? 'GET';
      try {
        // The boot probe: 200 {"ok":true}, twice, fast.
        if (method === 'GET' && path === '/healthz') {
          answer(res, { status: 200, headers: { 'content-type': JSON_MIME }, body: jsonBytes({ ok: true }) });
          return;
        }

        const body = await readBody(req);
        const query = requestQuery(req);
        const headers = flatHeaders(req);

        // Git smart HTTP: no bearer gate (the protocol carries its own shape);
        // a missing repository is a 404 the git module answers.
        if (isGitRoute(path)) {
          const result = await handleGit(store, method, path, query, headers, body);
          answer(res, result);
          return;
        }

        // GraphQL v4: one POST endpoint, bearer required.
        if (path === '/api/graphql') {
          if (!authorized(req)) {
            answer(res, unauthorizedResult());
            return;
          }
          const result = await handleGraphql(store, method, headers, body);
          answer(res, result);
          return;
        }

        // MCP: one POST endpoint, bearer required.
        if (path === '/mcp') {
          if (!authorized(req)) {
            answer(res, unauthorizedResult());
            return;
          }
          const result = await handleMcp(store, method, headers, body);
          answer(res, result);
          return;
        }

        // REST v3: every reply JSON with a request id, bearer required.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            requestCounter += 1;
            answer(res, unauthorizedResult(), { 'x-github-request-id': `req-${requestCounter}` });
            return;
          }
          const result = await handleRest(store, method, path, query, headers, body);
          requestCounter += 1;
          answer(res, result, { 'x-github-request-id': `req-${requestCounter}` });
          return;
        }

        // Anything else: GitHub's JSON 404.
        answer(res, notFoundResult());
      } catch (err) {
        // A handler must never take the server down. Answer 500 JSON and keep going.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[forge] handler error on ${method} ${path}: ${message}\n`);
        if (!res.headersSent) {
          answer(res, { status: 500, headers: { 'content-type': JSON_MIME }, body: jsonBytes({ message: 'Internal Server Error' }) });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
