// In-memory store for the github-core-clone-01 forge.
// Node 22 stdlib only. No file I/O, no network, no Date.now(),
// no Math.random() — all timestamps come from the logical clock below.

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeable: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  user: User;
  createdAt: string;
  updatedAt: string;
  files: PullFile[];
  headTreeOid: string | null;
  baseTreeOid: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

/** Logical clock epoch: 2025-01-01T00:00:00Z. */
const BASE_EPOCH = 1735689600;

export class Store {
  viewer: User = {
    id: 1000,
    login: 'adaiversen',
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
  };

  repos: Map<string, Repo> = new Map();

  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  tick = 0;

  nowIso(): string {
    const iso = new Date((BASE_EPOCH + this.tick) * 1000).toISOString();
    this.tick += 1;
    return iso;
  }

  nowEpoch(): number {
    const epoch = BASE_EPOCH + this.tick;
    this.tick += 1;
    return epoch;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(
    name: string,
    description: string,
    isPrivate: boolean,
    defaultBranch: string,
  ): Repo {
    const owner = this.viewer.login;
    const stamped = this.nowIso();
    const repo: Repo = {
      // Allocate and advance the counter in one expression so the stored
      // id and nextRepoId can never disagree if this body is edited later.
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch,
      createdAt: stamped,
      updatedAt: stamped,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }
}

export function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(gid: string): { kind: string; id: number } | null {
  if (typeof gid !== 'string' || gid.length === 0) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(gid)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(gid, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Reject inputs that do not round-trip exactly (catches bad padding / aliases).
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== gid) {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep <= 0 || sep === decoded.length - 1) {
    return null;
  }
  const kind = decoded.slice(0, sep);
  const idText = decoded.slice(sep + 1);
  if (!/^\d+$/.test(idText)) {
    return null;
  }
  const id = Number(idText);
  if (!Number.isSafeInteger(id)) {
    return null;
  }
  return { kind, id };
}
