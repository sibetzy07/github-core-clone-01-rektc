// REST v3 handler for the github-core-clone-01 forge.
// Node 22 stdlib only. Auth is enforced by app.ts before this handler runs.
// All timestamps come from the store's logical clock; no Date, no Math.random.
//
// The handler speaks plain git objects out of the store (blobs, trees, commits)
// so that PUT /contents really lands commits a later clone can see, and so
// pull-request merges can do a real merge-base + overlap conflict check.

import { createHash } from 'node:crypto';
import { globalId } from './store.ts';
import type { Comment, Issue, Label, Pull, PullFile, Repo, Store, User } from './store.ts';

export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

type JsonObject = Record<string, unknown>;

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

interface FlatEntry {
  oid: string;
  mode: string;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SCOPES = 'repo, read:org';
const INSTALLED_VERSION = '1.0.0';
const DEFAULT_BRANCH = 'main';

/** Monotonic per-reply counter for X-GitHub-Request-Id (contract: `req-<counter>`). */
let requestCounter = 0;

// -------------------------------------------------------------------------------------------
// Reply plumbing

function respond(status: number, value: unknown, extra: Record<string, string> = {}): HandlerResult {
  requestCounter += 1;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': `req-${requestCounter}`,
    ...extra,
  };
  if (status === 204 || value === null || value === undefined) {
    return { status, headers, body: Buffer.alloc(0) };
  }
  return { status, headers, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') };
}

function ok(value: unknown, extra: Record<string, string> = {}): HandlerResult {
  return respond(200, value, extra);
}

function created(value: unknown): HandlerResult {
  return respond(201, value);
}

function noContent(): HandlerResult {
  return respond(204, null);
}

function failure(status: number, message: string): HandlerResult {
  return respond(status, { message });
}

function notFound(message = 'Not Found'): HandlerResult {
  return failure(404, message);
}

// -------------------------------------------------------------------------------------------
// Small helpers

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a request path (already stripped of the /api/v3 prefix) into decoded segments. */
function splitPath(path: string): string[] {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return [];
  return trimmed.split('/').map(decodeSegment);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function strField(body: JsonObject, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: JsonObject, field: string, fallback: boolean): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse a JSON request body; empty bodies become {}. Returns null + the 400 on bad JSON. */
function parseBody(body: Buffer): { parsed: JsonObject } | { error: HandlerResult } {
  if (body.length === 0) return { parsed: {} };
  try {
    return { parsed: asObject(JSON.parse(body.toString('utf8'))) };
  } catch {
    return { error: failure(400, 'Problems parsing JSON') };
  }
}

function userView(user: User): JsonObject {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', user.id),
    avatar_url: `https://example.invalid/avatars/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    name: user.name,
    email: user.email,
  };
}

function labelView(label: Label): JsonObject {
  return { id: label.id, node_id: globalId('Label', label.id), name: label.name, color: label.color, description: label.description };
}

function repoView(repo: Repo): JsonObject {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, node_id: globalId('User', 1000), type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
  };
}

function issueView(issue: Issue, repo: Repo): JsonObject {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userView(issue.user),
    labels: issue.labels.map((name) => {
      // Labels are validated at creation, so this lookup always hits; the
      // fallback only guards a label deleted out from under the issue.
      const found = repo.labels.find((label) => label.name === name);
      return found !== undefined ? labelView(found) : { name, color: 'ededed', description: '' };
    }),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function commentView(comment: Comment, repo: Repo): JsonObject {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userView(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/comments/${comment.id}`,
  };
}

/** The live tip of a branch, falling back to the sha recorded when the PR was opened. */
function liveTip(repo: Repo, ref: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${ref}`) ?? fallback;
}

function pullView(pull: Pull, repo: Repo): JsonObject {
  const headSha = liveTip(repo, pull.headRef, pull.headSha);
  const baseSha = liveTip(repo, pull.baseRef, pull.baseSha);
  let mergeable = false;
  if (pull.state === 'open' && !pull.merged) {
    mergeable = !isConflicted(repo, headSha, baseSha);
  }
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    user: userView(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

// -------------------------------------------------------------------------------------------
// Git objects (SHA-1, blobs, trees, commits) — written from the git object format itself.

function gitOid(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

function storeObject(repo: Repo, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const oid = gitOid(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function readTree(repo: Repo, oid: string): TreeEntry[] {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** Flatten a tree into path -> blob. Directories are walked, never listed as entries. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, FlatEntry>): void {
  for (const entry of readTree(repo, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(repo, entry.oid, path, out);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
}

function treeOfCommit(repo: Repo, commitSha: string): string | null {
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

function flattenCommitTree(repo: Repo, commitSha: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const tree = treeOfCommit(repo, commitSha);
  if (tree !== null) flattenTree(repo, tree, '', out);
  return out;
}

interface DirNode {
  blob?: FlatEntry;
  children: Map<string, DirNode>;
}

function buildTreeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  const root: DirNode = { children: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as string;
      let child = node.children.get(part);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.blob = entry;
      node = child;
    }
  }
  const writeNode = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children) {
      if (child.blob !== undefined && child.children.size === 0) {
        entries.push({ mode: child.blob.mode, name, oid: child.blob.oid });
      } else {
        entries.push({ mode: '40000', name, oid: writeNode(child) });
      }
    }
    return storeObject(repo, 'tree', serializeTree(entries));
  };
  return writeNode(root);
}

function parsePerson(line: string): { name: string; email: string; epoch: number } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: '', email: '', epoch: 0 };
  return { name: match[1] as string, email: match[2] as string, epoch: Number(match[3]) };
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n+$/, '');
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorEpoch: 0,
    committerName: '',
    committerEmail: '',
    committerEpoch: 0,
    message,
  };
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header (e.g. gpgsig)
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const person = parsePerson(line.slice(7));
      info.authorName = person.name;
      info.authorEmail = person.email;
      info.authorEpoch = person.epoch;
    } else if (line.startsWith('committer ')) {
      const person = parsePerson(line.slice(10));
      info.committerName = person.name;
      info.committerEmail = person.email;
      info.committerEpoch = person.epoch;
    }
  }
  return info;
}

function makeCommit(store: Store, repo: Repo, treeOid: string, parents: string[], message: string): string {
  const epoch = store.nowEpoch();
  const person = `${store.viewer.name} <${store.viewer.email}> ${epoch} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${person}`, `committer ${person}`, '', message);
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

/** Commits reachable from `tip`, newest first (depth-first, first parent first). */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(sha);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

function ancestors(repo: Repo, tip: string): Set<string> {
  return new Set(walkCommits(repo, tip));
}

function isAncestor(repo: Repo, maybeAncestor: string, tip: string): boolean {
  if (maybeAncestor === tip) return true;
  return ancestors(repo, tip).has(maybeAncestor);
}

/** The nearest common ancestor of two tips (first one met walking out from `a`). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const bAncestors = ancestors(repo, b);
  const queue: string[] = [a];
  const seen = new Set<string>([a]);
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (bAncestors.has(sha)) return sha;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Paths whose blob oid differs between two flattened trees (missing counts as different). */
function changedPaths(before: Map<string, FlatEntry>, after: Map<string, FlatEntry>): Set<string> {
  const out = new Set<string>();
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path)?.oid !== after.get(path)?.oid) out.add(path);
  }
  return out;
}

/**
 * A PR is conflicted only when the head is not a descendant of the base and the
 * head changed a file the base also changed after their merge-base, to different
 * content. Anything else squashes cleanly.
 */
function isConflicted(repo: Repo, headSha: string, baseSha: string): boolean {
  if (headSha === baseSha) return false;
  if (isAncestor(repo, baseSha, headSha)) return false;
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return true;
  const baseFlat = flattenCommitTree(repo, base);
  const headFlat = flattenCommitTree(repo, headSha);
  const baseTipFlat = flattenCommitTree(repo, baseSha);
  const headChanged = changedPaths(baseFlat, headFlat);
  const baseChanged = changedPaths(baseFlat, baseTipFlat);
  for (const path of headChanged) {
    if (!baseChanged.has(path)) continue;
    if (headFlat.get(path)?.oid !== baseTipFlat.get(path)?.oid) return true;
  }
  return false;
}

/** Line counts for one file's diff, via a small longest-common-subsequence pass. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  const common = table[0] ?? 0;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined) return '';
  return object.data.toString('utf8');
}

/** Diff two commit trees into the pull-file list (sorted by filename, GitHub order). */
function diffTrees(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const before = flattenCommitTree(repo, baseSha);
  const after = flattenCommitTree(repo, headSha);
  const files: PullFile[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const additions = splitLines(blobText(repo, newEntry.oid)).length;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const deletions = splitLines(blobText(repo, oldEntry.oid)).length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const counts = lineDiff(blobText(repo, oldEntry.oid), blobText(repo, newEntry.oid));
      files.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return files;
}

// -------------------------------------------------------------------------------------------
// Pagination

function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, host: string): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, intParam(query, 'per_page', 30)));
  const page = Math.max(1, intParam(query, 'page', 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    const next = new URL(`http://${host}${path}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function pageHeaders(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

// -------------------------------------------------------------------------------------------
// Repo resolution

function resolveRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== store.viewer.login) return undefined;
  return store.getRepo(owner, name);
}

/** Resolve a ref name or raw sha to a commit sha, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

function commitView(repo: Repo, sha: string): JsonObject {
  const object = repo.objects.get(sha);
  const info = object !== undefined ? parseCommit(object.data) : null;
  const person = (name: string, email: string, epoch: number): JsonObject => ({
    name,
    email,
    date: epoch === 0 ? '' : new Date(epoch * 1000).toISOString(),
  });
  return {
    sha,
    commit: {
      message: info?.message ?? '',
      author: person(info?.authorName ?? '', info?.authorEmail ?? '', info?.authorEpoch ?? 0),
      committer: person(info?.committerName ?? '', info?.committerEmail ?? '', info?.committerEpoch ?? 0),
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// -------------------------------------------------------------------------------------------
// The handler

export async function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: Buffer,
): Promise<HandlerResult> {
  const host = headers.host ?? 'localhost';
  const relative = path.startsWith('/api/v3') ? path.slice('/api/v3'.length) : path;
  const parts = splitPath(relative);
  const verb = method.toUpperCase();

  // Bodies are JSON on every write; a body that does not parse is a 400.
  const needsBody = verb === 'POST' || verb === 'PATCH' || verb === 'PUT' || verb === 'DELETE';
  let parsed: JsonObject = {};
  if (needsBody) {
    const result = parseBody(body);
    if ('error' in result) return result.error;
    parsed = result.parsed;
  }

  // GET /api/v3/ — the API root.
  if (parts.length === 0) {
    if (verb !== 'GET') return notFound();
    return respond(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': SCOPES });
  }

  // GET /api/v3/meta
  if (parts.length === 1 && parts[0] === 'meta') {
    if (verb !== 'GET') return notFound();
    return ok({ installed_version: INSTALLED_VERSION });
  }

  // GET /api/v3/user and /api/v3/user/repos
  if (parts[0] === 'user') {
    if (parts.length === 1) {
      if (verb !== 'GET') return notFound();
      return ok(userView(store.viewer));
    }
    if (parts.length === 2 && parts[1] === 'repos') {
      if (verb === 'GET') {
        const repos = [...store.repos.values()];
        const { page, link } = paginate(repos, query, '/api/v3/user/repos', host);
        return respond(200, page.map(repoView), pageHeaders(link));
      }
      if (verb === 'POST') {
        const name = strField(parsed, 'name');
        if (name === undefined || name === '') return failure(422, 'name is required');
        if (store.getRepo(store.viewer.login, name) !== undefined) return failure(422, 'Repository already exists');
        const repo = store.createRepo(
          name,
          strField(parsed, 'description') ?? '',
          boolField(parsed, 'private', false),
          strField(parsed, 'default_branch') ?? DEFAULT_BRANCH,
        );
        return created(repoView(repo));
      }
      return notFound();
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = parts[1] as string;
    const repoName = parts[2] as string;
    const repo = resolveRepo(store, owner, repoName);
    if (repo === undefined) return notFound('Not Found');
    const rest = parts.slice(3);

    // GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
    if (rest.length === 0) {
      if (verb === 'GET') return ok(repoView(repo));
      if (verb === 'PATCH') {
        const description = strField(parsed, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof parsed.private === 'boolean') repo.private = parsed.private;
        repo.updatedAt = store.nowIso();
        return ok(repoView(repo));
      }
      if (verb === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return noContent();
      }
      return notFound();
    }

    // GET /branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (verb !== 'GET') return notFound();
      const branches: JsonObject[] = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return ok(branches);
    }

    // GET /commits[?sha=<ref>]
    if (rest.length === 1 && rest[0] === 'commits') {
      if (verb !== 'GET') return notFound();
      const tip = resolveRef(repo, query.get('sha'));
      if (tip === null) return ok([]);
      return ok(walkCommits(repo, tip).map((sha) => commitView(repo, sha)));
    }

    // POST /git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (verb !== 'POST') return notFound();
      const ref = strField(parsed, 'ref');
      const sha = strField(parsed, 'sha');
      if (ref === undefined || sha === undefined) return failure(422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) return failure(422, 'ref must start with refs/');
      if (repo.refs.has(ref)) return failure(422, 'Reference already exists');
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') return failure(422, 'sha is not a commit');
      repo.refs.set(ref, sha);
      return created({ ref, node_id: globalId('Ref', 0), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit' } });
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (verb === 'PUT') return putContents(store, repo, filePath, parsed);
      if (verb === 'DELETE') return deleteContents(store, repo, filePath, parsed);
      if (verb === 'GET') return getContents(repo, filePath, query.get('ref'));
      return notFound();
    }

    // POST /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (verb !== 'POST') return notFound();
      const name = strField(parsed, 'name');
      if (name === undefined || name === '') return failure(422, 'name is required');
      if (repo.labels.some((label) => label.name === name)) return failure(422, 'Label already exists');
      const label: Label = {
        id: repo.nextLabelId++,
        name,
        color: strField(parsed, 'color') ?? 'ededed',
        description: strField(parsed, 'description') ?? '',
      };
      repo.labels.push(label);
      return created(labelView(label));
    }

    // /issues...
    if (rest[0] === 'issues') {
      return handleIssues(store, repo, rest.slice(1), verb, query, parsed, path, host);
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      return handlePulls(store, repo, rest.slice(1), verb, query, parsed, path, host);
    }

    return notFound();
  }

  return notFound();
}

// -------------------------------------------------------------------------------------------
// Contents

function putContents(store: Store, repo: Repo, filePath: string, body: JsonObject): HandlerResult {
  if (filePath === '') return failure(422, 'path is required');
  const branch = strField(body, 'branch') ?? repo.defaultBranch;
  const refKey = `refs/heads/${branch}`;
  const tip = repo.refs.get(refKey);
  const flat = tip !== undefined ? flattenCommitTree(repo, tip) : new Map<string, FlatEntry>();
  const existing = flat.get(filePath);

  const givenSha = strField(body, 'sha');
  if (existing !== undefined) {
    if (givenSha === undefined) return failure(422, 'sha is required to update a file');
    if (givenSha !== existing.oid) return failure(409, 'sha does not match the current file');
  }

  const rawContent = strField(body, 'content');
  if (rawContent === undefined) return failure(422, 'content is required');
  const bytes = Buffer.from(rawContent.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = storeObject(repo, 'blob', bytes);
  flat.set(filePath, { oid: blobOid, mode: '100644' });
  const treeOid = buildTreeFromFlat(repo, flat);
  const message = strField(body, 'message') ?? `Update ${filePath}`;
  const commitSha = makeCommit(store, repo, treeOid, tip !== undefined ? [tip] : [], message);
  repo.refs.set(refKey, commitSha);
  repo.updatedAt = store.nowIso();
  const status = existing !== undefined ? 200 : 201;
  return respond(status, {
    content: {
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blobOid,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
    },
    commit: { sha: commitSha },
  });
}

function deleteContents(store: Store, repo: Repo, filePath: string, body: JsonObject): HandlerResult {
  if (filePath === '') return notFound();
  const branch = strField(body, 'branch') ?? repo.defaultBranch;
  const refKey = `refs/heads/${branch}`;
  const tip = repo.refs.get(refKey);
  if (tip === undefined) return notFound();
  const flat = flattenCommitTree(repo, tip);
  const existing = flat.get(filePath);
  if (existing === undefined) return notFound();
  const givenSha = strField(body, 'sha');
  if (givenSha !== undefined && givenSha !== existing.oid) return failure(409, 'sha does not match the current file');
  flat.delete(filePath);
  const treeOid = buildTreeFromFlat(repo, flat);
  const message = strField(body, 'message') ?? `Delete ${filePath}`;
  const commitSha = makeCommit(store, repo, treeOid, [tip], message);
  repo.refs.set(refKey, commitSha);
  repo.updatedAt = store.nowIso();
  return ok({ content: null, commit: { sha: commitSha } });
}

function getContents(repo: Repo, filePath: string, ref: string | null): HandlerResult {
  const tip = resolveRef(repo, ref);
  if (tip === null) return notFound();
  const treeOid = treeOfCommit(repo, tip);
  if (treeOid === null) return notFound();
  if (filePath === '') {
    return ok(listTreeEntries(repo, treeOid, ''));
  }
  const segments = filePath.split('/');
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    const entry = readTree(repo, currentTree).find((candidate) => candidate.name === segment);
    if (entry === undefined) return notFound();
    const isLast = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (isLast) return ok(listTreeEntries(repo, entry.oid, filePath));
      currentTree = entry.oid;
      continue;
    }
    if (!isLast) return notFound();
    const object = repo.objects.get(entry.oid);
    if (object === undefined) return notFound();
    return ok({
      name: segment,
      path: filePath,
      sha: entry.oid,
      size: object.data.length,
      type: 'file',
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
  }
  return notFound();
}

function listTreeEntries(repo: Repo, treeOid: string, dirPath: string): JsonObject[] {
  const entries: JsonObject[] = [];
  for (const entry of readTree(repo, treeOid)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      entries.push({ name: entry.name, path, sha: entry.oid, size: 0, type: 'dir' });
    } else {
      const object = repo.objects.get(entry.oid);
      entries.push({ name: entry.name, path, sha: entry.oid, size: object?.data.length ?? 0, type: 'file' });
    }
  }
  return entries;
}

// -------------------------------------------------------------------------------------------
// Issues

function findIssue(repo: Repo, number: number): Issue | undefined {
  // Numbers are dense from 1, so the array position is the lookup: O(1).
  if (!Number.isInteger(number) || number < 1 || number > repo.issues.length) return undefined;
  const issue = repo.issues[number - 1] as Issue | undefined;
  return issue !== undefined && issue.number === number ? issue : undefined;
}

function handleIssues(
  store: Store,
  repo: Repo,
  rest: string[],
  verb: string,
  query: URLSearchParams,
  body: JsonObject,
  path: string,
  host: string,
): HandlerResult {
  // POST / GET /issues
  if (rest.length === 0) {
    if (verb === 'POST') {
      const title = strField(body, 'title');
      if (title === undefined || title === '') return failure(422, 'title is required');
      const wanted: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((item): item is string => typeof item === 'string') : [];
      for (const name of wanted) {
        if (!repo.labels.some((label) => label.name === name)) return failure(422, `Label does not exist: ${name}`);
      }
      const stamped = store.nowIso();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: strField(body, 'body') ?? '',
        state: 'open',
        labels: wanted,
        user: store.viewer,
        createdAt: stamped,
        updatedAt: stamped,
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      return created(issueView(issue, repo));
    }
    if (verb === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      list = [...list].sort((a, b) => {
        const order = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
        return direction === 'asc' ? order : -order;
      });
      const { page, link } = paginate(list, query, path, host);
      return respond(200, page.map((issue) => issueView(issue, repo)), pageHeaders(link));
    }
    return notFound();
  }

  // /issues/{number}
  const number = Number.parseInt(rest[0] as string, 10);
  const issue = findIssue(repo, number);
  if (issue === undefined) return notFound('Not Found');

  if (rest.length === 1) {
    if (verb === 'GET') return ok(issueView(issue, repo));
    if (verb === 'PATCH') {
      const state = strField(body, 'state');
      if (state === 'closed' && issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedAt = store.nowIso();
      } else if (state === 'open' && issue.state !== 'open') {
        issue.state = 'open';
        issue.closedAt = null;
      }
      const title = strField(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = strField(body, 'body');
      if (text !== undefined) issue.body = text;
      issue.updatedAt = store.nowIso();
      return ok(issueView(issue, repo));
    }
    return notFound();
  }

  // /issues/{number}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (verb === 'POST') {
      const text = strField(body, 'body');
      if (text === undefined || text === '') return failure(422, 'body is required');
      const stamped = store.nowIso();
      const comment: Comment = { id: repo.nextCommentId++, body: text, user: store.viewer, createdAt: stamped, updatedAt: stamped };
      issue.comments.push(comment);
      return created(commentView(comment, repo));
    }
    if (verb === 'GET') {
      return ok(issue.comments.map((comment) => commentView(comment, repo)));
    }
    return notFound();
  }

  return notFound();
}

// -------------------------------------------------------------------------------------------
// Pull requests

function findPull(repo: Repo, number: number): Pull | undefined {
  // Numbers are dense from 1, so the array position is the lookup: O(1).
  if (!Number.isInteger(number) || number < 1 || number > repo.pulls.length) return undefined;
  const pull = repo.pulls[number - 1] as Pull | undefined;
  return pull !== undefined && pull.number === number ? pull : undefined;
}

/** Strip an optional `owner:` prefix from a head/base ref, GitHub-style. */
function bareRef(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

function handlePulls(
  store: Store,
  repo: Repo,
  rest: string[],
  verb: string,
  query: URLSearchParams,
  body: JsonObject,
  path: string,
  host: string,
): HandlerResult {
  // POST / GET /pulls
  if (rest.length === 0) {
    if (verb === 'POST') {
      const title = strField(body, 'title');
      const headRaw = strField(body, 'head');
      const baseRaw = strField(body, 'base');
      if (title === undefined || title === '') return failure(422, 'title is required');
      if (headRaw === undefined || baseRaw === undefined) return failure(422, 'head and base are required');
      const headRef = bareRef(headRaw);
      const baseRef = bareRef(baseRaw);
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) return failure(422, 'head or base branch does not exist');
      const headTree = treeOfCommit(repo, headSha);
      const baseTree = treeOfCommit(repo, baseSha);
      const stamped = store.nowIso();
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextPullNumber++,
        title,
        body: strField(body, 'body') ?? '',
        state: 'open',
        merged: false,
        headRef,
        baseRef,
        headSha,
        baseSha,
        mergeable: !isConflicted(repo, headSha, baseSha),
        mergeCommitSha: null,
        mergedAt: null,
        user: store.viewer,
        createdAt: stamped,
        updatedAt: stamped,
        files: diffTrees(repo, baseSha, headSha),
        headTreeOid: headTree,
        baseTreeOid: baseTree,
      };
      repo.pulls.push(pull);
      return created(pullView(pull, repo));
    }
    if (verb === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const { page, link } = paginate(list, query, path, host);
      return respond(200, page.map((pull) => pullView(pull, repo)), pageHeaders(link));
    }
    return notFound();
  }

  // /pulls/{number}
  const number = Number.parseInt(rest[0] as string, 10);
  const pull = findPull(repo, number);
  if (pull === undefined) return notFound('Not Found');

  if (rest.length === 1) {
    if (verb === 'GET') return ok(pullView(pull, repo));
    return notFound();
  }

  // GET /pulls/{number}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (verb !== 'GET') return notFound();
    return ok(pull.files);
  }

  // PUT /pulls/{number}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (verb !== 'PUT') return notFound();
    if (pull.merged || pull.state !== 'open') return failure(405, 'Pull request is already merged or closed');
    const headSha = liveTip(repo, pull.headRef, pull.headSha);
    const baseSha = liveTip(repo, pull.baseRef, pull.baseSha);
    if (isConflicted(repo, headSha, baseSha)) return failure(405, 'Merge conflict');
    const headTree = treeOfCommit(repo, headSha);
    if (headTree === null) return failure(405, 'Head has no tree');
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const mergeSha = makeCommit(store, repo, headTree, [baseSha], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeable = false;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = store.nowIso();
    pull.updatedAt = store.nowIso();
    return ok({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound();
}
