// src/git.ts — git smart-HTTP for the github-core-clone-01 forge.
//
// Speaks the smart-HTTP surface real git clients use, with no git binary:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (protocol v2, or v0)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (protocol v0 only)
//   POST /{owner}/{repo}.git/git-upload-pack   (v2 ls-refs / fetch, v0 fetch)
//   POST /{owner}/{repo}.git/git-receive-pack  (v0 push, report-status in sideband)
//
// Everything is built from the object store in memory: blobs, trees, commits
// and tags are hashed with SHA-1 exactly the way git hashes them, packs are
// assembled from whole objects (never deltas) and read back with full delta
// resolution, and pkt-line framing follows the wire format (0000 flush,
// 0001 delim, 0002 response-end). A fetch walks the wanted graph once and
// subtracts what the client already holds, so an incremental fetch never
// re-sends an object and a shallow fetch never pulls history past its depth.
//
// Node 22 standard library only. No Date, no Math.random, no I/O: pushed
// objects are stored byte-exact, with the client's own timestamps untouched.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo, Store } from './store.ts';

/** The handler result shape the contract fixes for all four modules. */
export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-core-clone-01/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
/** Largest pkt-line git allows, including its 4-byte length header. */
const PKT_LINE_MAX = 65520;
/** Sideband payloads are kept well under the pkt-line ceiling. */
const SIDEBAND_CHUNK = 32768;

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function isOid(value: string): boolean {
  return HEX40.test(value);
}

function jsonResult(status: number, message: string): HandlerResult {
  return {
    status,
    headers: { 'content-type': JSON_TYPE },
    body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** One data packet: a 4-hex-digit length (payload + 4) followed by the payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  }
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode every pkt-line in `buf` starting at `start`. Stops after the first
 * flush when `stopAtFlush` is set and reports where the framed bytes ended,
 * so a receive-pack caller can find the raw pack that follows the commands.
 * Throws on a bad length header or a truncated packet.
 */
function decodePackets(
  buf: Buffer,
  start = 0,
  stopAtFlush = false,
): { packets: Packet[]; end: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error(`truncated pkt-line at offset ${offset}`);
    }
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(head)} at offset ${offset}`);
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) return { packets, end: offset };
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${length}`);
    }
    if (offset + length > buf.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, end: offset };
}

/** The text of every data packet, in order. */
function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Split a sideband payload into band-1 pkt-lines, each carrying at most one chunk. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// object model
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** git's object id: SHA-1 over `<type> <size>\0` plus the object's bytes. */
function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({
      mode,
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

interface CommitInfo {
  tree: string;
  parents: string[];
}

function readCommit(repo: Repo, oid: string): CommitInfo | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const data = object.data;
  const blank = data.indexOf('\n\n');
  const header = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (!isOid(tree)) return null;
  return { tree, parents: parents.filter((parent) => isOid(parent)) };
}

function readTagTarget(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const data = object.data;
  const blank = data.indexOf('\n\n');
  const header = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) {
      const target = line.slice(7).trim();
      return isOid(target) ? target : null;
    }
  }
  return null;
}

/** Follow annotated tags until a non-tag object; a missing object stops the walk. */
function peel(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    const target = readTagTarget(repo, current);
    if (!target) return current;
    current = target;
  }
}

/** Peel tags; return the commit id, or null when the chain ends elsewhere. */
function peelToCommit(repo: Repo, oid: string): string | null {
  const peeled = peel(repo, oid);
  const object = repo.objects.get(peeled);
  return object && object.type === 'commit' ? peeled : null;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Breadth-first over commits only, from `roots` (tags are peeled first).
 * Returns each reachable commit with its shallowest depth (a want is depth 1).
 * `depthLimit` caps the walk: a commit at the limit is kept but its parents
 * are not followed. `leaves` are boundary commits that are kept but never
 * descended past — the client's existing shallow boundary, whose history the
 * client does not hold.
 */
function collectCommits(
  repo: Repo,
  roots: readonly string[],
  depthLimit: number | undefined,
  leaves: ReadonlySet<string> | undefined,
): Map<string, number> {
  const depthOf = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const enqueue = (oid: string, depth: number): void => {
    const prev = depthOf.get(oid);
    if (prev !== undefined && prev <= depth) return;
    depthOf.set(oid, depth);
    queue.push([oid, depth]);
  };
  for (const root of roots) {
    if (!isOid(root)) continue;
    const peeled = peel(repo, root);
    if (repo.objects.get(peeled)?.type === 'commit') enqueue(peeled, 1);
  }
  let head = 0;
  while (head < queue.length) {
    const entry = queue[head++]!;
    const oid = entry[0];
    const depth = entry[1];
    if (depthOf.get(oid) !== depth) continue; // superseded by a shallower path
    if (leaves !== undefined && leaves.has(oid)) continue;
    if (depthLimit !== undefined && depth >= depthLimit) continue;
    const info = readCommit(repo, oid);
    if (!info) continue;
    for (const parent of info.parents) {
      if (repo.objects.get(parent)?.type === 'commit') enqueue(parent, depth + 1);
    }
  }
  return depthOf;
}

/**
 * The full object closure of `seeds`: commit → tree and parents, tree →
 * entries (gitlinks skipped), tag → target. Parent edges are followed only
 * into `allowedCommits`, so a depth-limited walk never leaks past its limit.
 */
function expandObjects(
  repo: Repo,
  seeds: Iterable<string>,
  allowedCommits: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...seeds];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid) || !isOid(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const info = readCommit(repo, oid);
      if (!info) continue;
      stack.push(info.tree);
      for (const parent of info.parents) {
        if (allowedCommits.has(parent)) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const target = readTagTarget(repo, oid);
      if (target) stack.push(target);
    }
  }
  return out;
}

interface FetchPlan {
  /** Object ids to send, in no particular order. */
  send: Set<string>;
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Commits that stop being shallow because their parents are now held. */
  unshallow: string[];
}

/**
 * Decide what one fetch transfers. `wants` are depth-limited; `haves` are
 * subtracted in full, except a have that is also a shallow boundary keeps
 * its own history held back (that is what makes a deepen actually deepen).
 * `notRoots` are deepen-not tips: their whole history is subtracted too,
 * without the shallow-boundary cutoff.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowList: readonly string[],
  depth: number | undefined,
  notRoots: readonly string[] = [],
): FetchPlan {
  const shallowSet = new Set(shallowList.filter((oid) => isOid(oid)));
  const commitsWanted = collectCommits(repo, wants, depth, undefined);
  const commitsHeld = collectCommits(repo, haves, undefined, shallowSet);
  const commitsNot = collectCommits(repo, notRoots, undefined, undefined);
  const heldCommits = new Set([...commitsHeld, ...commitsNot]);
  const wanted = expandObjects(repo, [...wants, ...commitsWanted.keys()], commitsWanted);
  const held = expandObjects(repo, [...haves, ...notRoots, ...heldCommits], heldCommits);
  const send = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) send.add(oid);

  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, atDepth] of commitsWanted) {
      if (atDepth !== depth || held.has(oid)) continue;
      const info = readCommit(repo, oid);
      if (!info) continue;
      const hasParent = info.parents.some((parent) => repo.objects.has(parent));
      const parentInWanted = info.parents.some((parent) => commitsWanted.has(parent));
      if (hasParent && !parentInWanted) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    if (!commitsWanted.has(boundary)) continue;
    const info = readCommit(repo, boundary);
    if (!info) continue;
    const available = info.parents.every(
      (parent) => !repo.objects.has(parent) || commitsWanted.has(parent) || commitsHeld.has(parent),
    );
    if (available) unshallow.push(boundary);
  }
  return { send, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A packfile of whole objects only — no deltas. The trailer is SHA-1 over the rest. */
function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (with delta resolution)
// ---------------------------------------------------------------------------------------------

function readEntryHeader(buf: Buffer, start: number): { typeCode: number; size: number; next: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start]!;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { typeCode, size, next: offset };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the next offset. */
function inflateAt(buf: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, limit);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0 || offset + consumed > limit) {
    throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  }
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) {
    throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  }
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA chains. A REF_DELTA base that is not in the pack
 * is looked up through `resolveBase` (the store, for a thin pack). Every
 * object's SHA-1 is recomputed; a mismatch or a bad trailer is an error.
 */
function readPack(
  pack: Buffer,
  resolveBase: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(pack, offset);
    offset = header.next;
    const entry: RawPackEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  // Resolve in passes: a delta whose base is not settled yet waits for a
  // later pass, so chains and forward references both settle. Each pass
  // resolves at least one entry or the pack is unresolvable.
  const resolved = new Map<number, GitObject & { oid: string }>();
  const byOid = new Map<string, number>();
  const objects = new Map<string, GitObject>();
  let remaining = raw.length;
  while (remaining > 0) {
    let progressed = false;
    for (const entry of raw) {
      if (resolved.has(entry.offset)) continue;
      let type: GitObjectType | undefined;
      let data: Buffer | undefined;
      if (entry.typeCode === 6) {
        const base = resolved.get(entry.baseOffset!);
        if (!base) continue;
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const baseOffset = byOid.get(entry.baseOid!);
        const base = baseOffset !== undefined ? resolved.get(baseOffset) : undefined;
        if (base) {
          type = base.type;
          data = applyDelta(base.data, entry.data);
        } else {
          const external = resolveBase(entry.baseOid!);
          if (!external) continue;
          type = external.type;
          data = applyDelta(external.data, entry.data);
        }
      } else {
        type = CODE_TYPE[entry.typeCode]!;
        data = entry.data;
      }
      const oid = hashObject(type, data);
      const settled = { type, data, oid };
      resolved.set(entry.offset, settled);
      byOid.set(oid, entry.offset);
      if (!objects.has(oid)) objects.set(oid, { type, data });
      remaining -= 1;
      progressed = true;
    }
    if (!progressed) throw new Error('pack has a delta whose base cannot be resolved');
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// ref advertisements
// ---------------------------------------------------------------------------------------------

function headRefOf(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch || 'main'}`;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

const UPLOAD_V0_CAPS =
  'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const headRef = headRefOf(repo);
  const caps =
    service === 'git-upload-pack'
      ? `${UPLOAD_V0_CAPS} symref=HEAD:${headRef} agent=${AGENT}`
      : `${RECEIVE_V0_CAPS} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const headOid = repo.refs.get(headRef) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\u0000${caps}\n`));
    for (const name of sortedRefNames(repo)) {
      const oid = repo.refs.get(name)!;
      parts.push(pktLine(`${oid} ${name}\n`));
      if (repo.objects.get(oid)?.type === 'tag') {
        const peeled = peel(repo, oid);
        if (peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const headRef = headRefOf(repo);
  const lines: string[] = [];
  if (args.prefixes.length === 0) {
    const headOid = repo.refs.get(headRef);
    // symref-target is only reported when the client asked for symrefs;
    // an unborn HEAD is only reported when the client asked for unborn refs.
    const symref = args.symrefs ? ` symref-target:${headRef}` : '';
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symref}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${symref}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel && repo.objects.get(oid)?.type === 'tag') {
      const peeled = peel(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
  /** deepen-not ref names, resolved to tip oids by the caller. */
  notRefs: string[];
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false, notRefs: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(depth) && depth > 0) args.depth = depth;
    } else if (line.startsWith('deepen-not ')) {
      args.notRefs.push(line.slice('deepen-not '.length).trim());
    } else if (line === 'done') {
      args.done = true;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since: accepted and
    // ignored — this server sends whole objects, unfiltered.
  }
  return args;
}

/** The objects for a send set, in deterministic order; every id is in the store. */
function packObjectsFor(repo: Repo, send: ReadonlySet<string>): GitObject[] {
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return objects;
}

/** deepen-not ref names resolved to the tip oids they name (unknown refs skipped). */
function resolveNotRoots(repo: Repo, notRefs: readonly string[]): string[] {
  const roots: string[] = [];
  for (const ref of notRefs) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined && isOid(oid)) roots.push(oid);
  }
  return roots;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, resolveNotRoots(repo, args.notRefs));
  const pack = writePack(packObjectsFor(repo, plan.send));
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  let acked = 0;
  for (const have of args.haves) {
    if (repo.objects.has(have)) {
      ackLines.push(`ACK ${have}\n`);
      acked += 1;
    }
  }
  if (args.haves.length === 0 || acked === 0) ackLines.push('NAK\n');
  else ackLines.push('ready\n');
  parts.push(pktLine('acknowledgments\n'));
  for (const line of ackLines) parts.push(pktLine(line));
  parts.push(FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, resolveNotRoots(repo, args.notRefs));
  const pack = writePack(packObjectsFor(repo, plan.send));
  const parts: Buffer[] = [];
  if (args.haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = 0;
    for (const have of args.haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked += 1;
      }
    }
    if (acked === 0) parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(FLUSH);
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0: push
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** True when `descendant` is the same commit as `ancestor` or descends from it. */
function isFastForward(repo: Repo, ancestorOid: string, descendantOid: string): boolean {
  const ancestor = peelToCommit(repo, ancestorOid);
  const descendant = peelToCommit(repo, descendantOid);
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const info = readCommit(repo, oid);
    if (info) for (const parent of info.parents) stack.push(parent);
  }
  return false;
}

function receivePackResponse(repo: Repo, body: Buffer): HandlerResult {
  let commands: PushCommand[];
  let packStart: number;
  try {
    const decoded = decodePackets(body, 0, true);
    const lines = dataLines(decoded.packets);
    commands = [];
    for (const raw of lines) {
      const text = raw.replace(/\n$/, '');
      if (!text) continue;
      const head = text.split('\u0000')[0]!;
      const fields = head.split(' ');
      if (fields.length < 3 || !isOid(fields[0]!) || !isOid(fields[1]!)) {
        throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
      }
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields.slice(2).join(' ') });
    }
    if (commands.length === 0) throw new Error('receive-pack sent no commands');
    packStart = decoded.end;
  } catch (err) {
    return {
      status: 400,
      headers: { 'content-type': TEXT_TYPE },
      body: Buffer.from(`malformed pkt-line request: ${(err as Error).message}\n`, 'utf8'),
    };
  }

  // Unpack first: the objects land even when a ref update is refused, and
  // an unpack failure refuses every ref with the same verdict.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) repo.objects.set(oid, { type: object.type, data: object.data });
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.replace(/[\r\n]+/g, ' ').slice(0, 120) || 'unpack failed';
    }
  }

  const verdicts: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'invalid ref name' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'already exists' });
    } else if (command.oldOid !== current) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.newOid === current) {
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
    } else if (command.ref.startsWith('refs/tags/')) {
      // Tags never fast-forward-update without force.
      verdicts.push({ ref: command.ref, ok: false, reason: 'already exists' });
    } else if (isFastForward(repo, current, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }

  // report-status, pkt-lined inside sideband band 1.
  const reportLines: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const verdict of verdicts) {
    reportLines.push(
      verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`,
    );
  }
  reportLines.push('flush');
  const inner = pktLines(reportLines);
  const parts = sidebandPackets(inner);
  return {
    status: 200,
    headers: { 'content-type': RECEIVE_RESULT },
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST dispatch
// ---------------------------------------------------------------------------------------------

function uploadPackResponse(repo: Repo, body: Buffer, wantsV2: boolean): HandlerResult {
  let packets: Packet[];
  try {
    packets = decodePackets(body, 0).packets;
  } catch (err) {
    return {
      status: 400,
      headers: { 'content-type': TEXT_TYPE },
      body: Buffer.from(`malformed pkt-line request: ${(err as Error).message}\n`, 'utf8'),
    };
  }
  const lines = dataLines(packets);
  const first = (lines[0] ?? '').replace(/\n$/, '');
  // The argument section starts after the delim packet; without one, the
  // lines after the command line are the arguments.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  let argLines: string[];
  if (delimIndex >= 0) {
    argLines = dataLines(packets.slice(delimIndex + 1));
  } else {
    argLines = lines.slice(1);
  }
  argLines = argLines.filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));

  if (first.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const raw of argLines) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: lsRefsResponse(repo, args) };
  }
  if (first.startsWith('command=fetch')) {
    const args = parseFetchArgs(argLines);
    const response = wantsV2 ? fetchResponseV2(repo, args) : fetchResponseV0(repo, args);
    return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: response };
  }
  if (first.startsWith('want ')) {
    // Protocol v0 fetch: want/have lines with no command line.
    const args = parseFetchArgs(lines);
    return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchResponseV0(repo, args) };
  }
  return {
    status: 400,
    headers: { 'content-type': TEXT_TYPE },
    body: Buffer.from(`unknown git-upload-pack command ${JSON.stringify(first.slice(0, 40))}\n`, 'utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Git smart-HTTP. `path` is the full path without query (for example
 * `/adaiversen/myrepo.git/info/refs`), `query` the parsed query string,
 * `headers` a lowercase-keyed record, `body` the raw request bytes.
 * Git routes never enforce auth. A missing repo is 404 on info/refs and on
 * both POST services, and the handler never throws.
 */
export async function handleGit(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: Buffer,
): Promise<HandlerResult> {
  try {
    const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (!match) return jsonResult(404, 'Not Found');
    const owner = match[1]!;
    const repoName = match[2]!;
    const service = match[3]!;
    const repo = store.getRepo(owner, repoName);
    if (!repo) return jsonResult(404, 'Not Found');

    const lowered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;
    const wantsV2 = (lowered['git-protocol'] ?? '').trim().toLowerCase() === 'version=2';

    if (service === 'info/refs') {
      if (method !== 'GET') return jsonResult(404, 'Not Found');
      const requested = query.get('service');
      if (requested === 'git-upload-pack') {
        const ad = wantsV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
        return { status: 200, headers: { 'content-type': UPLOAD_AD }, body: ad };
      }
      if (requested === 'git-receive-pack') {
        return {
          status: 200,
          headers: { 'content-type': RECEIVE_AD },
          body: v0Advertisement(repo, 'git-receive-pack'),
        };
      }
      return jsonResult(404, 'Not Found');
    }

    if (method !== 'POST') return jsonResult(404, 'Not Found');
    if (service === 'git-upload-pack') return uploadPackResponse(repo, body, wantsV2);
    return receivePackResponse(repo, body);
  } catch (err) {
    return jsonResult(500, `internal error: ${(err as Error).message}`);
  }
}
