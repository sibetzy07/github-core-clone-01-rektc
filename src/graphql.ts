// src/graphql.ts — GraphQL v4 (GitHub-compatible) for the forge.
//
// A small hand-written executor, Node 22 stdlib only: a lexer plus a
// recursive-descent parser for the documents gh and github-mcp-server send,
// resolved against the store. No GraphQL library, no schema language — the
// schema lives in the SCHEMA / ENUM_INFO tables below, which double as the
// `__type` introspection source and the unknown-field validator.
//
// Supported surface (the documents in checks-graphql.ts):
//   Query.viewer, Query.repository, Query.node, Query.__type, Query.__schema
//   Repository / Issue / PullRequest reads, issues/pullRequests/files
//   connections with cursor pagination, and the createIssue / closeIssue /
//   createPullRequest / mergePullRequest / addComment mutations. A JSON array
//   body is GitHub operation batching: one result per operation, in order.

import { createHash } from 'node:crypto';
import { decodeGlobalId, globalId } from './store.ts';
import type { Comment, Issue, Pull, PullFile, Repo, Store, User } from './store.ts';

export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// -------------------------------------------------------------------------------------------
// Small helpers

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A GraphQL-level failure raised by a resolver; becomes one `errors` entry. */
class GqlError extends Error {}

interface ExecError {
  message: string;
  path?: (string | number)[];
}

/** Wrap a store object for resolution; `__typename` drives fragment matching. */
function wrap(typename: string, extra: AnyRecord): AnyRecord {
  return { __typename: typename, ...extra };
}

function repoWrapper(repo: Repo): AnyRecord {
  return wrap('Repository', { _repo: repo });
}

function issueWrapper(repo: Repo, issue: Issue): AnyRecord {
  return wrap('Issue', { _repo: repo, _issue: issue });
}

function pullWrapper(repo: Repo, pull: Pull): AnyRecord {
  return wrap('PullRequest', { _repo: repo, _pull: pull });
}

function userWrapper(user: User): AnyRecord {
  return wrap('User', { _user: user });
}

function commentWrapper(repo: Repo, comment: Comment): AnyRecord {
  return wrap('IssueComment', { _repo: repo, _comment: comment });
}

// -------------------------------------------------------------------------------------------
// Lexer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function describeToken(token: Token): string {
  return token.kind === 'eof' ? 'end of the document' : `${token.kind} "${token.value}"`;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Syntax Error: Unterminated block string.');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n) {
        const c = input[j] as string;
        if (c === '"') break;
        if (c === '\\') {
          const e = input[j + 1];
          if (e === undefined) break;
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (e === 'u') {
            const hex = input.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Syntax Error: Invalid unicode escape.');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          if (e in simple) {
            out += simple[e] as string;
            j += 2;
            continue;
          }
          throw new Error(`Syntax Error: Invalid escape sequence "\\${e}".`);
        }
        if (c === '\n' || c === '\r') throw new Error('Syntax Error: Unterminated string.');
        out += c;
        j += 1;
      }
      if (j >= n || input[j] !== '"') throw new Error('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character "${ch}".`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// Parser: document -> operations + named fragments

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  args: ArgumentNode[];
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionSetNode | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionSetNode;
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface SelectionSetNode {
  selections: SelectionNode[];
}

type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; ofType: TypeNode }
  | { kind: 'nonNull'; ofType: TypeNode };

interface VarDefNode {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VarDefNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionSetNode;
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionSetNode;
}

interface ParsedDocument {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

function typeToString(type: TypeNode): string {
  if (type.kind === 'named') return type.name;
  if (type.kind === 'list') return `[${typeToString(type.ofType)}]`;
  return `${typeToString(type.ofType)}!`;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.atPunct(value)) return false;
    this.index += 1;
    return true;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) {
      throw new Error(`Syntax Error: Expected "${value}", found ${describeToken(this.peek())}.`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new Error(`Syntax Error: Expected ${what}, found ${describeToken(token)}.`);
    }
    return token.value;
  }

  parseDocument(): ParsedDocument {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          directives: [],
          selectionSet: this.parseSelectionSet(),
        });
      } else if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        const fragment = this.parseFragment();
        if (fragments.has(fragment.name)) {
          throw new Error(`Syntax Error: Duplicate fragment "${fragment.name}".`);
        }
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const keyword = this.expectName('an operation');
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`Syntax Error: Unexpected operation "${keyword}".`);
    }
    const name = this.peek().kind === 'name' ? this.next().value : null;
    const variableDefinitions = this.atPunct('(') ? this.parseVariableDefinitions() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation: keyword, name, variableDefinitions, directives, selectionSet };
  }

  private parseFragment(): FragmentNode {
    this.expectName('"fragment"');
    const name = this.expectName('a fragment name');
    const on = this.expectName('"on"');
    if (on !== 'on') throw new Error('Syntax Error: Expected "on" in fragment definition.');
    const typeCondition = this.expectName('a type name');
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, directives, selectionSet };
  }

  private parseVariableDefinitions(): VarDefNode[] {
    this.expectPunct('(');
    const defs: VarDefNode[] = [];
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated variable definitions.');
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.eatPunct('=')) defaultValue = this.parseValue();
      this.parseDirectives();
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.eatPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName('a type name') };
    }
    if (this.eatPunct('!')) type = { kind: 'nonNull', ofType: type };
    return type;
  }

  private parseSelectionSet(): SelectionSetNode {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated selection set.');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return { selections };
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name');
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, directives, selectionSet };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      const selectionSet = this.parseSelectionSet();
      return { kind: 'inline', typeCondition: null, directives, selectionSet };
    }
    return this.parseField();
  }

  private parseField(): FieldNode {
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.eatPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseArguments(): ArgumentNode[] {
    this.expectPunct('(');
    const args: ArgumentNode[] = [];
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated arguments.');
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    if (this.eatPunct('$')) return { kind: 'variable', name: this.expectName('a variable name') };
    if (this.eatPunct('[')) {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) {
        if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated list.');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (this.eatPunct('{')) {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated object.');
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    const token = this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Syntax Error: Unexpected ${describeToken(token)}.`);
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName('a directive name');
      const args = this.atPunct('(') ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }
}

function parseDocument(input: string): ParsedDocument {
  return new Parser(lex(input)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// Values and directives

function resolveValue(node: ValueNode, variables: AnyRecord): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: ArgumentNode[], variables: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

interface Ctx {
  store: Store;
  variables: AnyRecord;
  fragments: Map<string, FragmentNode>;
}

function directiveSkips(directives: DirectiveNode[], ctx: Ctx): boolean {
  for (const directive of directives) {
    const arg = directive.args.find((entry) => entry.name === 'if');
    if (arg === undefined) continue;
    const value = resolveValue(arg.value, ctx.variables);
    if (directive.name === 'skip' && value === true) return true;
    if (directive.name === 'include' && value === false) return true;
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// Schema tables: field -> named return type (lists carry their element type).

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

const SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: 'ID' },
  User: { id: 'ID', databaseId: 'Int', login: 'String', name: 'String', email: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    description: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Ref: { name: 'String' },
  Issue: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    state: 'String',
    body: 'String',
    createdAt: 'String',
    updatedAt: 'String',
    closedAt: 'String',
    author: 'User',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'String',
    files: 'PullRequestChangedFileConnection',
    createdAt: 'String',
    updatedAt: 'String',
    mergedAt: 'String',
    author: 'User',
  },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: {
    nodes: 'PullRequestChangedFile',
    edges: 'PullRequestChangedFileEdge',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  PullRequestChangedFile: {
    path: 'String',
    filename: 'String',
    status: 'String',
    additions: 'Int',
    deletions: 'Int',
    changes: 'Int',
  },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'String', updatedAt: 'String', author: 'User' },
  CommentEdge: { node: 'IssueComment', cursor: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
};

const ENUM_INFO: Record<string, string[]> = {
  SearchType: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

/** The types a `... on Node` fragment applies to. */
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest']);

// -------------------------------------------------------------------------------------------
// Store lookups

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function findIssueById(store: Store, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return null;
}

function findPullById(store: Store, id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return null;
}

/** Issue lookup by number is O(1): numbers are dense from 1, so index number-1. */
function findIssueByNumber(repo: Repo, number: number): Issue | undefined {
  const direct = repo.issues[number - 1];
  if (direct !== undefined && direct.number === number) return direct;
  return repo.issues.find((issue) => issue.number === number);
}

function findPullByNumber(repo: Repo, number: number): Pull | undefined {
  const direct = repo.pulls[number - 1];
  if (direct !== undefined && direct.number === number) return direct;
  return repo.pulls.find((pull) => pull.number === number);
}

// -------------------------------------------------------------------------------------------
// Cursors: base64 of the item number, opaque to the client.

function encodeCursor(number: number): string {
  return Buffer.from(String(number), 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  if (/^\d+$/.test(text)) return Number(text);
  if (/^\d+$/.test(cursor)) return Number(cursor);
  return null;
}

// -------------------------------------------------------------------------------------------
// Git object helpers: flatten commit trees, diff them, find a merge base, detect conflicts.

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function parseTreeEntries(data: Buffer): TreeEntry[] {
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
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function parseCommitObject(data: Buffer): { tree: string | null; parents: string[] } {
  const text = data.toString('utf8');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(text)?.[1] ?? null;
  const parents: string[] = [];
  const parentPattern = /^parent ([0-9a-f]{40})$/gm;
  let match: RegExpExecArray | null;
  while ((match = parentPattern.exec(text)) !== null) parents.push(match[1] as string);
  return { tree, parents };
}

function treeOfCommit(repo: Repo, sha: string): string | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommitObject(object.data).tree;
}

function commitParents(repo: Repo, sha: string): string[] {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommitObject(object.data).parents;
}

function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTreeEntries(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      flattenTree(repo, entry.sha, path, out);
    } else {
      out.set(path, entry.sha);
    }
  }
}

function flattenCommitTree(repo: Repo, sha: string): Map<string, string> {
  const out = new Map<string, string>();
  const tree = treeOfCommit(repo, sha);
  if (tree !== null) flattenTree(repo, tree, '', out);
  return out;
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

/** Line additions/deletions between two texts, via a longest-common-subsequence pass. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const cols = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * cols);
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

/** Diff two commit trees into the pull-file list, sorted by filename. */
function diffCommitTrees(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const before = flattenCommitTree(repo, baseSha);
  const after = flattenCommitTree(repo, headSha);
  const files: PullFile[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const additions = splitLines(blobText(repo, newEntry)).length;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const deletions = splitLines(blobText(repo, oldEntry)).length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry !== newEntry) {
      const counts = lineDiff(blobText(repo, oldEntry), blobText(repo, newEntry));
      files.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return files;
}

function ancestorsOf(repo: Repo, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(repo, current)) stack.push(parent);
  }
  return seen;
}

/** Nearest common ancestor of two commits (breadth-first from the head side). */
function mergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
  const baseAncestors = ancestorsOf(repo, baseSha);
  const queue = [headSha];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (baseAncestors.has(current)) return current;
    for (const parent of commitParents(repo, current)) queue.push(parent);
  }
  return null;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) !== after.get(path)) changed.add(path);
  }
  return changed;
}

/** True when head and base-tip both changed the same path differently since the merge base. */
function isConflicted(repo: Repo, headSha: string, baseSha: string): boolean {
  if (headSha === '' || baseSha === '') return true;
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return true;
  const baseFlat = flattenCommitTree(repo, base);
  const headFlat = flattenCommitTree(repo, headSha);
  const tipFlat = flattenCommitTree(repo, baseSha);
  const headChanged = changedPaths(baseFlat, headFlat);
  const tipChanged = changedPaths(baseFlat, tipFlat);
  for (const path of headChanged) {
    if (!tipChanged.has(path)) continue;
    if (headFlat.get(path) !== tipFlat.get(path)) return true;
  }
  return false;
}

/** Store a merge commit (tree = head tree, parent = base tip) and return its sha. */
function makeMergeCommit(store: Store, repo: Repo, headTree: string, baseSha: string, pull: Pull): string {
  const epoch = store.nowEpoch();
  const who = `${store.viewer.name} <${store.viewer.email}> ${epoch} +0000`;
  const content = Buffer.from(
    `tree ${headTree}\nparent ${baseSha}\nauthor ${who}\ncommitter ${who}\n\nMerge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`,
    'utf8',
  );
  const header = Buffer.from(`commit ${content.length}\0`, 'utf8');
  const sha = createHash('sha1').update(header).update(content).digest('hex');
  repo.objects.set(sha, { type: 'commit', data: content });
  return sha;
}

// -------------------------------------------------------------------------------------------
// Connections

function pageInfoWrapper(hasNextPage: boolean, hasPreviousPage: boolean, startCursor: string | null, endCursor: string | null): AnyRecord {
  return wrap('PageInfo', { _hasNextPage: hasNextPage, _hasPreviousPage: hasPreviousPage, _startCursor: startCursor, _endCursor: endCursor });
}

function issueConnection(repo: Repo, args: AnyRecord): AnyRecord {
  let list = repo.issues.slice();
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  // CREATED_AT order is number order: created_at is strictly increasing per
  // issue (the store's logical clock), so sorting by number is exact. The
  // other order fields compare their own value, with number as the tiebreak.
  const orderBy = isRecord(args['orderBy']) ? args['orderBy'] : null;
  const field = orderBy !== null ? String(orderBy['field'] ?? 'CREATED_AT') : 'CREATED_AT';
  const direction = orderBy !== null ? String(orderBy['direction'] ?? 'DESC') : 'DESC';
  const descending = direction !== 'ASC';
  list.sort((a, b) => {
    let cmp: number;
    if (field === 'UPDATED_AT') {
      cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    } else if (field === 'COMMENTS') {
      cmp = a.comments.length - b.comments.length;
    } else {
      cmp = a.number - b.number;
    }
    if (cmp === 0) cmp = a.number - b.number;
    return descending ? -cmp : cmp;
  });
  let start = 0;
  const after = decodeCursor(args['after']);
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args['first'] === 'number' && args['first'] >= 0 ? args['first'] : list.length;
  const page = list.slice(start, start + first);
  const nodes = page.map((issue) => issueWrapper(repo, issue));
  const edges = page.map((issue) => wrap('IssueEdge', { _node: issueWrapper(repo, issue), _cursor: encodeCursor(issue.number) }));
  const pageInfo = pageInfoWrapper(
    start + page.length < list.length,
    start > 0,
    page.length > 0 ? encodeCursor((page[0] as Issue).number) : null,
    page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null,
  );
  return wrap('IssueConnection', { _nodes: nodes, _edges: edges, _pageInfo: pageInfo, _total: list.length });
}

function pullConnection(repo: Repo, args: AnyRecord): AnyRecord {
  const list = repo.pulls.slice().sort((a, b) => b.number - a.number);
  let start = 0;
  const after = decodeCursor(args['after']);
  if (after !== null) {
    const index = list.findIndex((pull) => pull.number === after);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args['first'] === 'number' && args['first'] >= 0 ? args['first'] : list.length;
  const page = list.slice(start, start + first);
  const nodes = page.map((pull) => pullWrapper(repo, pull));
  const edges = page.map((pull) => wrap('PullRequestEdge', { _node: pullWrapper(repo, pull), _cursor: encodeCursor(pull.number) }));
  const pageInfo = pageInfoWrapper(
    start + page.length < list.length,
    start > 0,
    page.length > 0 ? encodeCursor((page[0] as Pull).number) : null,
    page.length > 0 ? encodeCursor((page[page.length - 1] as Pull).number) : null,
  );
  return wrap('PullRequestConnection', { _nodes: nodes, _edges: edges, _pageInfo: pageInfo, _total: list.length });
}

function filesConnection(pull: Pull, args: AnyRecord): AnyRecord {
  const first = typeof args['first'] === 'number' && args['first'] >= 0 ? args['first'] : pull.files.length;
  const page = pull.files.slice(0, first);
  const nodes = page.map((file) => wrap('PullRequestChangedFile', { _file: file }));
  const edges = page.map((file, index) => wrap('PullRequestChangedFileEdge', { _node: nodes[index], _cursor: encodeCursor(index + 1) }));
  const pageInfo = pageInfoWrapper(page.length < pull.files.length, false, page.length > 0 ? encodeCursor(1) : null, page.length > 0 ? encodeCursor(page.length) : null);
  return wrap('PullRequestChangedFileConnection', { _nodes: nodes, _edges: edges, _pageInfo: pageInfo, _total: pull.files.length });
}

// -------------------------------------------------------------------------------------------
// Introspection

function typeInfoWrapper(name: string): AnyRecord | null {
  const enumValues = ENUM_INFO[name];
  if (enumValues !== undefined) {
    return wrap('__Type', { _name: name, _kind: 'ENUM', _fields: [], _enumValues: enumValues });
  }
  if (name === 'Node') {
    return wrap('__Type', { _name: 'Node', _kind: 'INTERFACE', _fields: ['id'], _enumValues: [] });
  }
  const fields = SCHEMA[name];
  if (fields === undefined) return null;
  return wrap('__Type', { _name: name, _kind: 'OBJECT', _fields: Object.keys(fields), _enumValues: [] });
}

function resolveNode(store: Store, id: unknown): AnyRecord | null {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = findRepoById(store, decoded.id);
    return repo === undefined ? null : repoWrapper(repo);
  }
  if (decoded.kind === 'Issue') {
    const found = findIssueById(store, decoded.id);
    return found === null ? null : issueWrapper(found.repo, found.issue);
  }
  if (decoded.kind === 'PullRequest') {
    const found = findPullById(store, decoded.id);
    return found === null ? null : pullWrapper(found.repo, found.pull);
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// Resolvers

type Resolver = (source: AnyRecord, args: AnyRecord, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_source, _args, ctx) => userWrapper(ctx.store.viewer),
    repository: (_source, args, ctx) => {
      const repo = ctx.store.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
      return repo === undefined ? null : repoWrapper(repo);
    },
    node: (_source, args, ctx) => resolveNode(ctx.store, args['id']),
    __type: (_source, args) => typeInfoWrapper(String(args['name'] ?? '')),
    __schema: () => wrap('__Schema', {}),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const decoded = decodeGlobalId(asString(input['repositoryId']) ?? '');
      if (decoded === null || decoded.kind !== 'Repository') {
        throw new GqlError('createIssue: repositoryId is not a repository global id.');
      }
      const repo = findRepoById(ctx.store, decoded.id);
      if (repo === undefined) throw new GqlError('createIssue: repository not found.');
      const title = asString(input['title']) ?? '';
      if (title === '') throw new GqlError('createIssue: title is required.');
      const stamped = ctx.store.nowIso();
      const issue: Issue = {
        id: ctx.store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: asString(input['body']) ?? '',
        state: 'open',
        labels: [],
        user: ctx.store.viewer,
        createdAt: stamped,
        updatedAt: stamped,
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      return wrap('CreateIssuePayload', { _repo: repo, _issue: issue });
    },
    closeIssue: (_source, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const decoded = decodeGlobalId(asString(input['issueId']) ?? '');
      if (decoded === null || decoded.kind !== 'Issue') {
        throw new GqlError('closeIssue: issueId is not an issue global id.');
      }
      const found = findIssueById(ctx.store, decoded.id);
      if (found === null) throw new GqlError('closeIssue: issue not found.');
      const stamped = ctx.store.nowIso();
      found.issue.state = 'closed';
      found.issue.closedAt = stamped;
      found.issue.updatedAt = stamped;
      return wrap('CloseIssuePayload', { _repo: found.repo, _issue: found.issue });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const decoded = decodeGlobalId(asString(input['repositoryId']) ?? '');
      if (decoded === null || decoded.kind !== 'Repository') {
        throw new GqlError('createPullRequest: repositoryId is not a repository global id.');
      }
      const repo = findRepoById(ctx.store, decoded.id);
      if (repo === undefined) throw new GqlError('createPullRequest: repository not found.');
      const headRef = asString(input['headRefName']) ?? '';
      const baseRef = asString(input['baseRefName']) ?? '';
      const title = asString(input['title']) ?? '';
      if (title === '') throw new GqlError('createPullRequest: title is required.');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        throw new GqlError('createPullRequest: head or base branch does not exist.');
      }
      const stamped = ctx.store.nowIso();
      const pull: Pull = {
        id: ctx.store.nextPullId++,
        number: repo.nextPullNumber++,
        title,
        body: asString(input['body']) ?? '',
        state: 'open',
        merged: false,
        headRef,
        baseRef,
        headSha,
        baseSha,
        mergeable: !isConflicted(repo, headSha, baseSha),
        mergeCommitSha: null,
        mergedAt: null,
        user: ctx.store.viewer,
        createdAt: stamped,
        updatedAt: stamped,
        files: diffCommitTrees(repo, baseSha, headSha),
        headTreeOid: treeOfCommit(repo, headSha),
        baseTreeOid: treeOfCommit(repo, baseSha),
      };
      repo.pulls.push(pull);
      return wrap('CreatePullRequestPayload', { _repo: repo, _pull: pull });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const decoded = decodeGlobalId(asString(input['pullRequestId']) ?? '');
      if (decoded === null || decoded.kind !== 'PullRequest') {
        throw new GqlError('mergePullRequest: pullRequestId is not a pull request global id.');
      }
      const found = findPullById(ctx.store, decoded.id);
      if (found === null) throw new GqlError('mergePullRequest: pull request not found.');
      const { repo, pull } = found;
      if (pull.merged || pull.state !== 'open') {
        throw new GqlError('mergePullRequest: pull request is already merged or closed.');
      }
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      if (isConflicted(repo, headSha, baseSha)) throw new GqlError('mergePullRequest: merge conflict.');
      const headTree = treeOfCommit(repo, headSha);
      if (headTree === null) throw new GqlError('mergePullRequest: head has no tree.');
      const mergeSha = makeMergeCommit(ctx.store, repo, headTree, baseSha, pull);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeable = false;
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = ctx.store.nowIso();
      pull.updatedAt = ctx.store.nowIso();
      return wrap('MergePullRequestPayload', { _repo: repo, _pull: pull });
    },
    addComment: (_source, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const decoded = decodeGlobalId(asString(input['subjectId']) ?? '');
      if (decoded === null || decoded.kind !== 'Issue') {
        throw new GqlError('addComment: subjectId is not an issue global id.');
      }
      const found = findIssueById(ctx.store, decoded.id);
      if (found === null) throw new GqlError('addComment: issue not found.');
      const stamped = ctx.store.nowIso();
      const comment: Comment = {
        id: found.repo.nextCommentId++,
        body: asString(input['body']) ?? '',
        user: ctx.store.viewer,
        createdAt: stamped,
        updatedAt: stamped,
      };
      found.issue.comments.push(comment);
      return wrap('AddCommentPayload', {
        _repo: found.repo,
        _commentEdge: wrap('CommentEdge', { _node: commentWrapper(found.repo, comment), _cursor: encodeCursor(comment.id) }),
      });
    },
  },
  User: {
    id: (source) => globalId('User', (source['_user'] as User).id),
    databaseId: (source) => (source['_user'] as User).id,
    login: (source) => (source['_user'] as User).login,
    name: (source) => (source['_user'] as User).name,
    email: (source) => (source['_user'] as User).email,
  },
  Repository: {
    id: (source) => globalId('Repository', (source['_repo'] as Repo).id),
    databaseId: (source) => (source['_repo'] as Repo).id,
    name: (source) => (source['_repo'] as Repo).name,
    nameWithOwner: (source) => (source['_repo'] as Repo).fullName,
    description: (source) => (source['_repo'] as Repo).description,
    owner: (_source, _args, ctx) => userWrapper(ctx.store.viewer),
    defaultBranchRef: (source) => {
      const repo = source['_repo'] as Repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? wrap('Ref', { _name: repo.defaultBranch }) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source['_repo'] as Repo;
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const issue = findIssueByNumber(repo, number);
      return issue === undefined ? null : issueWrapper(repo, issue);
    },
    issues: (source, args) => issueConnection(source['_repo'] as Repo, args),
    pullRequests: (source, args) => pullConnection(source['_repo'] as Repo, args),
    pullRequest: (source, args) => {
      const repo = source['_repo'] as Repo;
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const pull = findPullByNumber(repo, number);
      return pull === undefined ? null : pullWrapper(repo, pull);
    },
  },
  Ref: {
    name: (source) => source['_name'],
  },
  Issue: {
    id: (source) => globalId('Issue', (source['_issue'] as Issue).id),
    number: (source) => (source['_issue'] as Issue).number,
    title: (source) => (source['_issue'] as Issue).title,
    state: (source) => ((source['_issue'] as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (source) => (source['_issue'] as Issue).body,
    createdAt: (source) => (source['_issue'] as Issue).createdAt,
    updatedAt: (source) => (source['_issue'] as Issue).updatedAt,
    closedAt: (source) => (source['_issue'] as Issue).closedAt,
    author: (source) => userWrapper((source['_issue'] as Issue).user),
  },
  IssueConnection: {
    nodes: (source) => source['_nodes'],
    edges: (source) => source['_edges'],
    pageInfo: (source) => source['_pageInfo'],
    totalCount: (source) => source['_total'],
  },
  IssueEdge: {
    node: (source) => source['_node'],
    cursor: (source) => source['_cursor'],
  },
  PullRequestConnection: {
    nodes: (source) => source['_nodes'],
    edges: (source) => source['_edges'],
    pageInfo: (source) => source['_pageInfo'],
    totalCount: (source) => source['_total'],
  },
  PullRequestEdge: {
    node: (source) => source['_node'],
    cursor: (source) => source['_cursor'],
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => source['_nodes'],
    edges: (source) => source['_edges'],
    pageInfo: (source) => source['_pageInfo'],
    totalCount: (source) => source['_total'],
  },
  PullRequestChangedFileEdge: {
    node: (source) => source['_node'],
    cursor: (source) => source['_cursor'],
  },
  PageInfo: {
    hasNextPage: (source) => source['_hasNextPage'],
    hasPreviousPage: (source) => source['_hasPreviousPage'],
    startCursor: (source) => source['_startCursor'],
    endCursor: (source) => source['_endCursor'],
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source['_pull'] as Pull).id),
    number: (source) => (source['_pull'] as Pull).number,
    title: (source) => (source['_pull'] as Pull).title,
    body: (source) => (source['_pull'] as Pull).body,
    state: (source) => {
      const pull = source['_pull'] as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => (source['_pull'] as Pull).merged,
    headRefName: (source) => (source['_pull'] as Pull).headRef,
    baseRefName: (source) => (source['_pull'] as Pull).baseRef,
    mergeable: (source, _args, ctx) => {
      const repo = source['_repo'] as Repo;
      const pull = source['_pull'] as Pull;
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      return isConflicted(repo, headSha, baseSha) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (source, args) => filesConnection(source['_pull'] as Pull, args),
    createdAt: (source) => (source['_pull'] as Pull).createdAt,
    updatedAt: (source) => (source['_pull'] as Pull).updatedAt,
    mergedAt: (source) => (source['_pull'] as Pull).mergedAt,
    author: (source) => userWrapper((source['_pull'] as Pull).user),
  },
  PullRequestChangedFile: {
    path: (source) => (source['_file'] as PullFile).filename,
    filename: (source) => (source['_file'] as PullFile).filename,
    status: (source) => (source['_file'] as PullFile).status,
    additions: (source) => (source['_file'] as PullFile).additions,
    deletions: (source) => (source['_file'] as PullFile).deletions,
    changes: (source) => (source['_file'] as PullFile).changes,
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', (source['_comment'] as Comment).id),
    body: (source) => (source['_comment'] as Comment).body,
    createdAt: (source) => (source['_comment'] as Comment).createdAt,
    updatedAt: (source) => (source['_comment'] as Comment).updatedAt,
    author: (source) => userWrapper((source['_comment'] as Comment).user),
  },
  CommentEdge: {
    node: (source) => source['_node'],
    cursor: (source) => source['_cursor'],
  },
  CreateIssuePayload: {
    issue: (source) => issueWrapper(source['_repo'] as Repo, source['_issue'] as Issue),
  },
  CloseIssuePayload: {
    issue: (source) => issueWrapper(source['_repo'] as Repo, source['_issue'] as Issue),
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => pullWrapper(source['_repo'] as Repo, source['_pull'] as Pull),
  },
  MergePullRequestPayload: {
    pullRequest: (source) => pullWrapper(source['_repo'] as Repo, source['_pull'] as Pull),
  },
  AddCommentPayload: {
    commentEdge: (source) => source['_commentEdge'],
  },
  __Type: {
    name: (source) => source['_name'],
    kind: (source) => source['_kind'],
    description: () => null,
    fields: (source) =>
      ((source['_fields'] as string[]) ?? []).map((name) => wrap('__Field', { _name: name })),
    enumValues: (source) =>
      ((source['_enumValues'] as string[]) ?? []).map((name) => wrap('__EnumValue', { _name: name })),
  },
  __Field: {
    name: (source) => source['_name'],
    description: () => null,
  },
  __EnumValue: {
    name: (source) => source['_name'],
    description: () => null,
  },
  __Schema: {
    queryType: () => typeInfoWrapper('Query'),
    mutationType: () => typeInfoWrapper('Mutation'),
    types: () => {
      const names = [...Object.keys(SCHEMA), ...Object.keys(ENUM_INFO), 'Node'];
      const out: AnyRecord[] = [];
      for (const name of names) {
        const info = typeInfoWrapper(name);
        if (info !== null) out.push(info);
      }
      return out;
    },
  },
};

// -------------------------------------------------------------------------------------------
// Validation: unknown fields (and malformed selections) become GraphQL errors, not crashes.

function validateSelections(selections: SelectionNode[], typeName: string, doc: ParsedDocument, errors: ExecError[]): void {
  const fields = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (fields === undefined || !(selection.name in fields)) {
        errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
        continue;
      }
      const returnType = fields[selection.name] as string;
      if (SCALARS.has(returnType)) {
        if (selection.selectionSet !== null) {
          errors.push({ message: `Field "${selection.name}" must not have a selection since type "${returnType}" has no subfields.` });
        }
      } else if (selection.selectionSet === null) {
        errors.push({ message: `Field "${selection.name}" of type "${returnType}" must have a selection of subfields.` });
      } else {
        validateSelections(selection.selectionSet.selections, returnType, doc, errors);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      validateSelections(fragment.selectionSet.selections, fragment.typeCondition, doc, errors);
      continue;
    }
    validateSelections(selection.selectionSet.selections, selection.typeCondition ?? typeName, doc, errors);
  }
}

function validateDocument(doc: ParsedDocument): ExecError[] {
  const errors: ExecError[] = [];
  for (const fragment of doc.fragments.values()) {
    if (SCHEMA[fragment.typeCondition] === undefined && fragment.typeCondition !== 'Node' && ENUM_INFO[fragment.typeCondition] === undefined) {
      errors.push({ message: `Unknown type "${fragment.typeCondition}".` });
      continue;
    }
    validateSelections(fragment.selectionSet.selections, fragment.typeCondition, doc, errors);
  }
  for (const operation of doc.operations) {
    if (operation.operation === 'subscription') {
      errors.push({ message: 'Subscriptions are not supported.' });
      continue;
    }
    const rootType = operation.operation === 'query' ? 'Query' : 'Mutation';
    validateSelections(operation.selectionSet.selections, rootType, doc, errors);
  }
  return errors;
}

// -------------------------------------------------------------------------------------------
// Execution

function fragmentApplies(typeCondition: string, runtimeType: string): boolean {
  return typeCondition === runtimeType || (typeCondition === 'Node' && NODE_TYPES.has(runtimeType));
}

function completeValue(
  value: unknown,
  returnType: string,
  selectionSet: SelectionSetNode,
  ctx: Ctx,
  errors: ExecError[],
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(entry, returnType, selectionSet, ctx, errors, [...path, index]));
  }
  if (typeof value === 'object') {
    return executeSelectionSet(returnType, value as AnyRecord, selectionSet.selections, ctx, errors, path);
  }
  return value;
}

function executeSelectionSet(
  staticType: string,
  source: AnyRecord,
  selections: SelectionNode[],
  ctx: Ctx,
  errors: ExecError[],
  path: (string | number)[],
): AnyRecord {
  const runtimeType = typeof source['__typename'] === 'string' ? (source['__typename'] as string) : staticType;
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (directiveSkips(selection.directives, ctx)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined || !fragmentApplies(fragment.typeCondition, runtimeType)) continue;
      Object.assign(out, executeSelectionSet(fragment.typeCondition, source, fragment.selectionSet.selections, ctx, errors, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (directiveSkips(selection.directives, ctx)) continue;
      if (selection.typeCondition !== null && !fragmentApplies(selection.typeCondition, runtimeType)) continue;
      Object.assign(
        out,
        executeSelectionSet(selection.typeCondition ?? staticType, source, selection.selectionSet.selections, ctx, errors, path),
      );
      continue;
    }
    if (directiveSkips(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = runtimeType;
      continue;
    }
    const resolver = RESOLVERS[runtimeType]?.[selection.name];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${runtimeType}".`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    const args = resolveArgs(selection.args, ctx.variables);
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (selection.selectionSet === null) {
      out[key] = value;
      continue;
    }
    const returnType = SCHEMA[runtimeType]?.[selection.name] ?? SCHEMA[staticType]?.[selection.name] ?? 'String';
    out[key] = completeValue(value, returnType, selection.selectionSet, ctx, errors, [...path, key]);
  }
  return out;
}

function executeDocument(store: Store, query: string, variables: AnyRecord, operationName: string | undefined): AnyRecord {
  let doc: ParsedDocument;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((entry) => entry.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  if (operation.operation === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  const ctx: Ctx = { store, variables: {}, fragments: doc.fragments };
  const errors: ExecError[] = [];
  for (const definition of operation.variableDefinitions) {
    if (Object.prototype.hasOwnProperty.call(variables, definition.name)) {
      ctx.variables[definition.name] = variables[definition.name];
    } else if (definition.defaultValue !== null) {
      ctx.variables[definition.name] = resolveValue(definition.defaultValue, ctx.variables);
    } else if (definition.type.kind === 'nonNull') {
      errors.push({ message: `Variable "$${definition.name}" of required type "${typeToString(definition.type)}" was not provided.` });
    } else {
      ctx.variables[definition.name] = null;
    }
  }
  if (errors.length > 0) return { data: null, errors };
  const validationErrors = validateDocument(doc);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const rootType = operation.operation === 'query' ? 'Query' : 'Mutation';
  const execErrors: ExecError[] = [];
  const data = executeSelectionSet(rootType, {}, operation.selectionSet.selections, ctx, execErrors, []);
  if (execErrors.length > 0) return { data, errors: execErrors };
  return { data };
}

function runOperation(store: Store, entry: unknown): AnyRecord {
  if (!isRecord(entry) || typeof entry['query'] !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isRecord(entry['variables']) ? entry['variables'] : {};
  const operationName = typeof entry['operationName'] === 'string' ? entry['operationName'] : undefined;
  return executeDocument(store, entry['query'], variables, operationName);
}

// -------------------------------------------------------------------------------------------
// Handler: POST /api/graphql. Auth is enforced by app.ts; the handler also 401s when the
// Authorization header is absent (or the token mismatches, when one is configured).

let requestCounter = 0;

export async function handleGraphql(
  store: Store,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<HandlerResult> {
  const headersOut = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `req-${++requestCounter}`,
  };
  const json = (status: number, value: unknown): HandlerResult => ({
    status,
    headers: headersOut,
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  });
  const auth = headers['authorization'] ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '' || (expected !== '' && token !== expected)) {
    return json(401, { message: 'Requires authentication' });
  }
  if (method !== 'POST') {
    return json(404, { message: 'Not Found' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return json(400, { message: 'Problems parsing JSON' });
  }
  if (Array.isArray(parsed)) {
    return json(200, parsed.map((entry) => runOperation(store, entry)));
  }
  return json(200, runOperation(store, parsed));
}
