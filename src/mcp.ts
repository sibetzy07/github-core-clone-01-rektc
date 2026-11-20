// src/mcp.ts — Model Context Protocol endpoint (POST /mcp).
//
// JSON-RPC 2.0 over Streamable HTTP, answered as application/json. The
// handler speaks both protocol eras the conformance client negotiates:
//
//   modern  2026-07-28: `server/discover` answers identity, capabilities and
//           supportedVersions in one request; no handshake, no session.
//   legacy  2025-11-25 and earlier: `initialize` echoes the revision the
//           client offered, then `notifications/initialized`.
//
// Every request is handled from the arguments it carries — no shared mutable
// request state — so concurrent tools/call requests keep their own ids and
// their own objects. The tools act on the same Store the REST surface reads,
// so a repo or issue created over MCP reads back over /api/v3 unchanged.
//
// Auth is enforced by app.ts before this handler runs, but the handler also
// returns 401 when the Authorization header is absent (or the wrong token
// when MAKEFUN_SHOP_TOKEN is set), in case app.ts is bypassed in tests.
//
// Node 22 standard library only. No Date, no Math.random, no I/O: every
// timestamp comes from the store's logical clock.

import type { Issue, Pull, Repo, Store, User } from './store.ts';

/** The handler result shape the contract fixes for all four modules. */
export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '0.1.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
const JSON_TYPE = 'application/json; charset=utf-8';

type JsonRpcId = string | number | null;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/**
 * The tool list, built once as a fixed literal. tools/list returns this same
 * object every time, so two calls answer the same list byte for byte.
 */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Only issues in this state: "open", "closed" or "all".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch the changes come from.' },
        base: { type: 'string', description: 'The base branch the changes go into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Only pull requests in this state: "open", "closed" or "all".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        issue_number: { type: 'integer', description: 'The number of the issue.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// small helpers

/** Whether `value` is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON-RPC success body. */
function rpcResult(id: JsonRpcId, result: unknown): HandlerResult {
  return {
    status: 200,
    headers: { 'content-type': JSON_TYPE },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })),
  };
}

/** A JSON-RPC error body. `status` is the HTTP status that carries it. */
function rpcError(id: JsonRpcId, code: number, message: string, status = 200): HandlerResult {
  return {
    status,
    headers: { 'content-type': JSON_TYPE },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })),
  };
}

/** A plain JSON body (non-JSON-RPC replies: 401, 405). */
function jsonReply(status: number, value: unknown): HandlerResult {
  return {
    status,
    headers: { 'content-type': JSON_TYPE },
    body: Buffer.from(JSON.stringify(value)),
  };
}

/** A tool result: one text block holding the value as JSON. */
function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** A tool execution error: isError:true with the message as text. */
function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The first defined, non-null argument under any of the given names. */
function pick(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** The argument as a non-empty string, or undefined. */
function pickString(args: Record<string, unknown>, names: readonly string[]): string | undefined {
  const value = pick(args, names);
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The argument as an integer, or undefined (accepts a digit string too). */
function pickInt(args: Record<string, unknown>, names: readonly string[]): number | undefined {
  const value = pick(args, names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** The argument as a boolean, or undefined (accepts "true"/"false" too). */
function pickBool(args: Record<string, unknown>, names: readonly string[]): boolean | undefined {
  const value = pick(args, names);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** A tool name normalized for matching: lowercase, punctuation stripped. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The owner/repo pair an argument map names, from owner+repo, their aliases,
 * or a full_name of the form "owner/repo". Null when neither route names
 * both halves.
 */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = pickString(args, ['owner', 'owner_login', 'ownerLogin', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repoName', 'project', 'project_name']);
  if ((owner === undefined || repo === undefined) && pickString(args, ['full_name', 'fullName', 'repo_full_name', 'repository_full_name']) !== undefined) {
    const full = pickString(args, ['full_name', 'fullName', 'repo_full_name', 'repository_full_name']) as string;
    const slash = full.indexOf('/');
    if (slash > 0 && slash < full.length - 1) {
      if (owner === undefined) owner = full.slice(0, slash);
      if (repo === undefined) repo = full.slice(slash + 1);
    }
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// REST-shaped views of store objects (the same shapes /api/v3 returns)

function userJson(user: User): Record<string, unknown> {
  return { login: user.login, id: user.id, type: 'User' };
}

function repoJson(repo: Repo, viewer: User): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(viewer),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
  };
}

function pullJson(pull: Pull, ownerLogin: string): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${ownerLogin}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${ownerLogin}:${pull.baseRef}` },
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable,
  };
}

/** An issue by number: the array slot first (numbers are dense), then a scan. */
function issueByNumber(repo: Repo, number: number): Issue | undefined {
  const at = repo.issues[number - 1];
  if (at !== undefined && at.number === number) return at;
  return repo.issues.find((issue) => issue.number === number);
}

/** A pull request by number: the array slot first, then a scan. */
function pullByNumber(repo: Repo, number: number): Pull | undefined {
  const at = repo.pulls[number - 1];
  if (at !== undefined && at.number === number) return at;
  return repo.pulls.find((pull) => pull.number === number);
}

/** The state filter a list call asks for: "open", "closed" or "all". */
function listState(args: Record<string, unknown>): 'open' | 'closed' | 'all' | null {
  const state = pickString(args, ['state', 'status']);
  if (state === undefined) return 'open';
  if (state === 'open' || state === 'closed' || state === 'all') return state;
  return null;
}

// ---------------------------------------------------------------------------
// the tools

/**
 * Run one tool against the store. Returns the tool result object
 * ({content, isError?}) — never throws for a bad argument or a missing
 * object; those are tool errors the caller can read.
 */
function runTool(store: Store, canonical: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (canonical) {
    case 'create_repo': {
      const name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (name === undefined) return toolFail('Missing required argument: name');
      if (store.getRepo(store.viewer.login, name) !== undefined) {
        return toolFail(`Repository already exists: ${store.viewer.login}/${name}`);
      }
      const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
      const isPrivate = pickBool(args, ['private', 'is_private']) ?? false;
      const repo = store.createRepo(name, description, isPrivate, 'main');
      return toolOk(repoJson(repo, store.viewer));
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolFail('Missing required argument: owner and repo (or full_name)');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolFail(`Repository not found: ${target.owner}/${target.repo}`);
      return toolOk(repoJson(repo, store.viewer));
    }
    case 'create_issue': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolFail('Missing required argument: owner and repo (or full_name)');
      const title = pickString(args, ['title', 'issue_title', 'subject']);
      if (title === undefined) return toolFail('Missing required argument: title');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolFail(`Repository not found: ${target.owner}/${target.repo}`);
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
      const now = store.nowIso();
      const issue: Issue = {
        id: store.nextIssueId,
        number: repo.nextIssueNumber,
        title,
        body,
        state: 'open',
        labels: [],
        user: store.viewer,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      store.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      return toolOk(issueJson(issue));
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolFail('Missing required argument: owner and repo (or full_name)');
      const state = listState(args);
      if (state === null) return toolFail('Invalid argument: state must be "open", "closed" or "all"');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolFail(`Repository not found: ${target.owner}/${target.repo}`);
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return toolOk(issues.map((issue) => issueJson(issue)));
    }
    case 'create_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolFail('Missing required argument: owner and repo (or full_name)');
      const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
      const head = pickString(args, ['head', 'head_ref', 'head_branch', 'headRef', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
      const base = pickString(args, ['base', 'base_ref', 'base_branch', 'baseRef', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
      const missing: string[] = [];
      if (title === undefined) missing.push('title');
      if (head === undefined) missing.push('head');
      if (base === undefined) missing.push('base');
      if (missing.length > 0) return toolFail(`Missing required argument: ${missing.join(', ')}`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolFail(`Repository not found: ${target.owner}/${target.repo}`);
      const headSha = repo.refs.get(`refs/heads/${head as string}`);
      if (headSha === undefined) return toolFail(`Head ref not found: ${head as string}`);
      const baseSha = repo.refs.get(`refs/heads/${base as string}`);
      if (baseSha === undefined) return toolFail(`Base ref not found: ${base as string}`);
      const body = pickString(args, ['body', 'description', 'content', 'text']) ?? '';
      const now = store.nowIso();
      const pull: Pull = {
        id: store.nextPullId,
        number: repo.nextPullNumber,
        title: title as string,
        body,
        state: 'open',
        merged: false,
        headRef: head as string,
        baseRef: base as string,
        headSha,
        baseSha,
        mergeable: true,
        mergeCommitSha: null,
        mergedAt: null,
        user: store.viewer,
        createdAt: now,
        updatedAt: now,
        files: [],
        headTreeOid: null,
        baseTreeOid: null,
      };
      store.nextPullId += 1;
      repo.nextPullNumber += 1;
      repo.pulls.push(pull);
      return toolOk(pullJson(pull, repo.owner));
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolFail('Missing required argument: owner and repo (or full_name)');
      const number = pickInt(args, ['pull_number', 'pullNumber', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
      if (number === undefined) return toolFail('Missing required argument: pull_number');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolFail(`Repository not found: ${target.owner}/${target.repo}`);
      const pull = pullByNumber(repo, number);
      if (pull === undefined) return toolFail(`Pull request not found: #${number}`);
      if (pull.merged) return toolFail(`Pull request #${number} is already merged`);
      if (pull.state !== 'open') return toolFail(`Pull request #${number} is ${pull.state}`);
      const mergedAt = store.nowIso();
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = mergedAt;
      pull.updatedAt = mergedAt;
      pull.mergeCommitSha = pull.headSha;
      // Fast-forward the base branch to the head, as a clean merge does:
      // the merged content is then what the base branch reads.
      repo.refs.set(`refs/heads/${pull.baseRef}`, pull.headSha);
      return toolOk({ sha: pull.headSha, merged: true, message: 'Pull request successfully merged.' });
    }
    case 'list_pull_requests': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolFail('Missing required argument: owner and repo (or full_name)');
      const state = listState(args);
      if (state === null) return toolFail('Invalid argument: state must be "open", "closed" or "all"');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolFail(`Repository not found: ${target.owner}/${target.repo}`);
      const pulls = state === 'all' ? repo.pulls : repo.pulls.filter((pull) => pull.state === state);
      return toolOk(pulls.map((pull) => pullJson(pull, repo.owner)));
    }
    case 'get_issue': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolFail('Missing required argument: owner and repo (or full_name)');
      const number = pickInt(args, ['issue_number', 'issueNumber', 'number', 'index']);
      if (number === undefined) return toolFail('Missing required argument: issue_number');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolFail(`Repository not found: ${target.owner}/${target.repo}`);
      const issue = issueByNumber(repo, number);
      if (issue === undefined) return toolFail(`Issue not found: #${number}`);
      return toolOk(issueJson(issue));
    }
    default:
      return toolFail(`Unknown tool: ${canonical}`);
  }
}

/**
 * The canonical tool a name calls, matched by suffix and case-insensitively
 * (so "github__create_issue" and "create_issue" both hit create_issue), plus
 * the obvious aliases the conformance suite recognizes. Null for unknown.
 */
function resolveToolName(name: string): string | null {
  const normalized = normalizeName(name);
  const canonicals: readonly string[] = [
    'create_repo',
    'get_repo',
    'create_issue',
    'list_issues',
    'create_pull_request',
    'merge_pull_request',
    'list_pull_requests',
    'get_issue',
  ];
  const aliases: Record<string, string> = {
    createrepository: 'create_repo',
    repocreate: 'create_repo',
    reposcreate: 'create_repo',
    repositorycreate: 'create_repo',
    getrepository: 'get_repo',
    repoget: 'get_repo',
    reposget: 'get_repo',
    repositoryget: 'get_repo',
    issuecreate: 'create_issue',
    issuescreate: 'create_issue',
    issueslist: 'list_issues',
    issuelist: 'list_issues',
    pullrequestcreate: 'create_pull_request',
    pullscreate: 'create_pull_request',
    createpr: 'create_pull_request',
    prcreate: 'create_pull_request',
    pullrequestmerge: 'merge_pull_request',
    pullsmerge: 'merge_pull_request',
    mergepr: 'merge_pull_request',
    prmerge: 'merge_pull_request',
    pullrequestslist: 'list_pull_requests',
    pullslist: 'list_pull_requests',
    issueget: 'get_issue',
    issuesget: 'get_issue',
  };
  for (const canonical of canonicals) {
    const wanted = normalizeName(canonical);
    if (normalized === wanted || normalized.endsWith(wanted)) return canonical;
  }
  const alias = aliases[normalized];
  if (alias !== undefined) return alias;
  for (const [suffix, canonical] of Object.entries(aliases)) {
    if (normalized.endsWith(suffix)) return canonical;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the handler

/**
 * Handle one MCP request. `method` is the HTTP method, `headers` is a
 * lowercase-keyed record, `body` is the raw request Buffer (may be non-JSON:
 * that is a -32700 parse error, HTTP 400).
 */
export async function handleMcp(
  store: Store,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<HandlerResult> {
  if (method !== 'POST') {
    return jsonReply(405, { message: 'Method Not Allowed' });
  }

  // Auth: a missing Authorization header is 401 here as well as in app.ts.
  // When MAKEFUN_SHOP_TOKEN is set the bearer token must match it; when it
  // is unset (local dev only) any non-empty Bearer token is accepted.
  const authorization = headers['authorization'];
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authed =
    typeof authorization === 'string' &&
    authorization.startsWith('Bearer ') &&
    authorization.slice('Bearer '.length).trim() !== '' &&
    (expected === '' || authorization === `Bearer ${expected}`);
  if (!authed) {
    return jsonReply(401, { message: 'Requires authentication' });
  }

  // A body that is not JSON is a parse error: HTTP 400, JSON-RPC -32700.
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(request)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const id: JsonRpcId =
    typeof request['id'] === 'string' || typeof request['id'] === 'number' ? (request['id'] as string | number) : null;
  const isNotification = !Object.prototype.hasOwnProperty.call(request, 'id');

  // A notification carries no id and gets no response body (202, empty).
  if (isNotification) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  const methodName = request['method'];
  if (typeof methodName !== 'string' || methodName === '') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  const params: Record<string, unknown> = isRecord(request['params']) ? (request['params'] as Record<string, unknown>) : {};

  switch (methodName) {
    case 'server/discover': {
      return rpcResult(id, {
        resultType: 'discover',
        protocolVersion: PREFERRED_REVISION,
        supportedVersions: [...SUPPORTED_REVISIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
    }
    case 'initialize': {
      // Echo the revision the client offered only when it is one this
      // server speaks; otherwise negotiate down to the newest handshake
      // revision instead of claiming a future one.
      const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
      const negotiated = (SUPPORTED_REVISIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      // The same fixed literal every time: byte-identical across calls.
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params['name'];
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
      }
      const canonical = resolveToolName(name);
      if (canonical === null) {
        return rpcError(id, -32601, `Method not found: unknown tool "${name}"`);
      }
      const args: Record<string, unknown> = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
      const result = runTool(store, canonical, args);
      return rpcResult(id, result);
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${methodName}`);
    }
  }
}
