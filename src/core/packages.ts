import { isAnchorMode } from './ratings.ts';
import type { Asset, Project, ProjectBundle, StageAudit } from './model.ts';
import { validateArchiveMetadata } from './backup.ts';

export type StagePackage = {
  format: 'eval-studio-stage-package'; schemaVersion: 1 | 2;
  packageId: string; exportedAt: string; senderId: string;
  kind: 'assignment' | 'submission' | 'baseline'; productIds: string[];
  bundle: ProjectBundle; snapshots: Project[]; audits?: StageAudit[];
  media: { sha256: string; mime: string; size: number; path: string; part: number }[];
  parts: { index: number; name: string; sha256: string; size: number; entries: string[] }[];
  manifestHash: string;
};

type PackageInput = Pick<StagePackage, 'bundle' | 'snapshots' | 'kind' | 'senderId' | 'productIds'> & { audits?: StageAudit[] };
type PackageOptions = { partBytes?: number; packageId?: string; now?: string };
type ZipEntry = { name: string; blob: Blob; crc: number };
const MiB = 1024 * 1024;
const MAX_MANIFEST = 10 * MiB;
const MAX_PART = 50 * MiB;
const MAX_IMAGE = 25 * MiB;
const MAX_TOTAL = 8 * 1024 * MiB;
const MAX_PARTS = 256;
const MAX_MEDIA = 10000;
const CHUNK = MiB;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const mimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

// Incremental SHA-256 keeps peak working memory independent of the ZIP size.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

class Sha256 {
  private state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buffer = new Uint8Array(64);
  private used = 0;
  private bytes = 0;
  private words = new Uint32Array(64);

  update(data: Uint8Array) {
    this.bytes += data.length;
    let offset = 0;
    if (this.used) {
      const length = Math.min(64 - this.used, data.length);
      this.buffer.set(data.subarray(0, length), this.used);
      this.used += length;
      offset += length;
      if (this.used === 64) { this.block(this.buffer); this.used = 0; }
    }
    while (offset + 64 <= data.length) { this.block(data.subarray(offset, offset + 64)); offset += 64; }
    if (offset < data.length) { this.buffer.set(data.subarray(offset), 0); this.used = data.length - offset; }
  }

  private block(data: Uint8Array) {
    const w = this.words;
    for (let i = 0; i < 16; i++) w[i] = ((data[i * 4] << 24) | (data[i * 4 + 1] << 16) | (data[i * 4 + 2] << 8) | data[i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let a = this.state[0], b = this.state[1], c = this.state[2], d = this.state[3];
    let e = this.state[4], f = this.state[5], g = this.state[6], h = this.state[7];
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0; this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0; this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0; this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0; this.state[7] = (this.state[7] + h) >>> 0;
  }

  finish(): string {
    const bits = this.bytes * 8;
    this.buffer[this.used++] = 0x80;
    if (this.used > 56) { this.buffer.fill(0, this.used); this.block(this.buffer); this.used = 0; }
    this.buffer.fill(0, this.used, 56);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bits / 0x100000000), false);
    view.setUint32(60, bits >>> 0, false);
    this.block(this.buffer);
    return [...this.state].map(word => word.toString(16).padStart(8, '0')).join('');
  }
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let j = 0; j < 8; j++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[i] = value >>> 0;
}

async function checksum(blob: Blob): Promise<{ sha256: string; crc: number }> {
  const sha = new Sha256();
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
    sha.update(bytes);
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return { sha256: sha.finish(), crc: (crc ^ 0xffffffff) >>> 0 };
}

/** Streaming digest shared by final archive files; does not load a full ZIP into RAM. */
export async function hashBlob(blob: Blob): Promise<string> { return (await checksum(blob)).sha256; }

async function digest(value: unknown): Promise<string> {
  return (await checksum(new Blob([canonical(value)]))).sha256;
}

async function validateSnapshots(bundle: ProjectBundle, snapshots: Project[]) {
  for (const snapshot of [bundle.project, ...snapshots]) {
    if (await digest(snapshot.scheme) !== snapshot.schemeHash || await digest(snapshot.questions) !== snapshot.questionsHash) throw new Error(`项目修订 ${snapshot.revision} 的规则或题库 SHA-256 不匹配。`);
  }
  const pairs = new Set(snapshots.map(snapshot => `${snapshot.schemeHash}:${snapshot.questionsHash}`));
  if (bundle.evaluations.some(record => !pairs.has(`${record.schemeHash}:${record.questionsHash}`))) throw new Error('评测记录引用的历史规则或题库快照缺失。');
}

function auditErrors(raw: unknown, kind: StagePackage['kind']): string[] {
  if (kind === 'assignment' && raw !== undefined) return ['任务分配包不能携带历史审计'];
  return kind === 'submission' && Array.isArray(raw) && raw.length ? ['提交包不能携带历史审计'] : [];
}

function scopeErrors(input: PackageInput): string[] {
  const selected = new Set(input.productIds);
  if (!Array.isArray(input.productIds) || selected.size !== input.productIds.length || input.productIds.some(id => typeof id !== 'string' || !input.bundle.project.products.some(product => product.id === id))) return ['产品范围无效或重复'];
  const defaults = (product: Project['products'][number]) => product.totalCost === null && product.commercialUse === 'unreviewed' && product.commercialEvidence === '';
  if (input.kind === 'assignment') {
    const errors: string[] = [];
    if (input.bundle.evaluations.length || input.bundle.walkthroughs.length || input.bundle.experiences.length || input.bundle.assets.some(asset => asset.role === 'output')) errors.push('任务分配包不能携带评分、走查、体验记录或输出原图');
    if (input.snapshots.length !== 1 || canonical(input.snapshots[0]) !== canonical(input.bundle.project)) errors.push('任务分配包只能携带与当前项目相同的一份净化快照');
    if (input.bundle.project.products.some(product => !defaults(product))) errors.push('任务分配包的所有产品费用与商用判断必须清空为默认值');
    return errors;
  }
  if (input.kind !== 'submission') return [];
  if ([input.bundle.project, ...input.snapshots].some(snapshot => !Array.isArray(snapshot.products) || snapshot.products.some(product => !object(product) || !selected.has(product.id) && !defaults(product)))) return ['提交包的当前或历史快照包含范围外产品的费用或商用判断'];
  if (input.bundle.evaluations.some(record => !selected.has(record.productId)) || input.bundle.walkthroughs.some(record => !selected.has(record.productId)) || input.bundle.experiences.some(record => !selected.has(record.productId)) || input.bundle.assets.some(asset => asset.role === 'output' && !selected.has(asset.productId ?? ''))) return ['提交包包含所选产品范围之外的评测记录或原图'];
  return [];
}

function sameKeys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
}

function manifestErrors(raw: unknown): string[] {
  if (!object(raw) || raw.format !== 'eval-studio-stage-package' || ![1,2].includes(Number(raw.schemaVersion))) return ['不是支持的阶段数据包'];
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return ['阶段包版本无效'];
  const anchorScheme = object(raw.bundle) && object(raw.bundle.project) && object(raw.bundle.project.scheme) && object(raw.bundle.project.scheme.rating) && raw.bundle.project.scheme.rating.mode === 'anchors';
  if (raw.schemaVersion !== (anchorScheme ? 2 : 1)) return ['阶段包版本与评分方式不一致，请升级工作台'];
  const keys = ['format', 'schemaVersion', 'packageId', 'exportedAt', 'senderId', 'kind', 'productIds', 'bundle', 'snapshots', 'media', 'parts', 'manifestHash', ...(raw.audits === undefined ? [] : ['audits'])];
  if (!sameKeys(raw, keys) || !identity(raw.packageId) || !validDate(raw.exportedAt) || typeof raw.senderId !== 'string' || !raw.senderId.trim() || raw.senderId.length > 200 || !['assignment', 'submission', 'baseline'].includes(String(raw.kind)) || !Array.isArray(raw.productIds) || !hash(raw.manifestHash) || !Array.isArray(raw.media) || raw.media.length > MAX_MEDIA || !Array.isArray(raw.parts) || raw.parts.length > MAX_PARTS) return ['数据包清单字段或数量无效'];
  const errors = validateArchiveMetadata(raw);
  if (errors.length) return errors;
  const manifest = raw as unknown as StagePackage;
  errors.push(...scopeErrors(manifest), ...auditErrors(manifest.audits, manifest.kind));
  const hashes = new Set<string>();
  const paths = new Set<string>();
  let mediaBytes = 0;
  for (const item of raw.media) {
    if (!object(item) || !sameKeys(item, ['sha256', 'mime', 'size', 'path', 'part']) || !hash(item.sha256) || hashes.has(item.sha256) || typeof item.mime !== 'string' || !mimes.has(item.mime) || !positiveInteger(item.size) || item.size > MAX_IMAGE || item.path !== `images/${item.sha256}.bin` || !positiveInteger(item.part)) return ['原图清单的摘要、路径、格式或大小无效'];
    hashes.add(item.sha256); paths.add(String(item.path)); mediaBytes += item.size;
  }
  if (mediaBytes > MAX_TOTAL) errors.push('原图总量超过 8 GiB 上限');
  const names = new Set<string>();
  const listedPaths = new Set<string>();
  let partBytes = 0;
  for (const [position, item] of raw.parts.entries()) {
    if (!object(item) || !sameKeys(item, ['index', 'name', 'sha256', 'size', 'entries']) || item.index !== position + 1 || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.zip$/.test(item.name) || names.has(item.name) || !hash(item.sha256) || !positiveInteger(item.size) || item.size < 22 || item.size > MAX_PART || !Array.isArray(item.entries) || !item.entries.length || item.entries.length > MAX_MEDIA || new Set(item.entries).size !== item.entries.length || item.entries.some(path => typeof path !== 'string' || !paths.has(path) || listedPaths.has(path))) return ['ZIP 分包清单的文件名、索引、大小或图片列表无效'];
    names.add(item.name); partBytes += item.size;
    for (const path of item.entries) {
      listedPaths.add(String(path));
      if (!manifest.media.some(media => media.path === path && media.part === item.index)) errors.push('原图所属分包与清单不一致');
    }
  }
  if (listedPaths.size !== paths.size || partBytes > MAX_TOTAL + MAX_PARTS * 2 * MiB) errors.push('分包缺少原图、存在多余原图或总量超限');
  const assetHashes = new Set(manifest.bundle.assets.map(asset => asset.sha256));
  if (assetHashes.size !== hashes.size || manifest.bundle.assets.some(asset => !manifest.media.some(media => media.sha256 === asset.sha256 && media.mime === asset.mime && media.size === asset.size))) errors.push('项目原图元数据与归档清单不一致');
  return [...new Set(errors)];
}

function imageSignature(bytes: Uint8Array, mime: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  return mime === 'image/png' ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'image/webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
        : mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
}

function partDocument(packageId: string, index: number, entries: string[]) {
  return new Blob([JSON.stringify({ packageId, index, entries })], { type: 'application/json' });
}

function plannedSize(packageId: string, index: number, entries: Pick<StagePackage['media'][number], 'path' | 'size'>[]) {
  const paths = entries.map(entry => entry.path);
  return 22 + 76 + 2 * 'part.json'.length + partDocument(packageId, index, paths).size + entries.reduce((sum, entry) => sum + 76 + 2 * entry.path.length + entry.size, 0);
}

function zip(entries: ZipEntry[]): Blob {
  const chunks: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true);
    lv.setUint32(14, entry.crc, true); lv.setUint32(18, entry.blob.size, true); lv.setUint32(22, entry.blob.size, true); lv.setUint16(26, name.length, true);
    const directory = new Uint8Array(46);
    const cv = new DataView(directory.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint32(16, entry.crc, true); cv.setUint32(20, entry.blob.size, true); cv.setUint32(24, entry.blob.size, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    chunks.push(local, name, entry.blob);
    central.push(directory, name);
    offset += local.length + name.length + entry.blob.size;
    centralSize += directory.length + name.length;
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

export async function buildStagePackage(input: PackageInput, loadAsset: (id: string) => Promise<Asset | undefined>, options: PackageOptions = {}): Promise<{ manifest: StagePackage; files: { name: string; blob: Blob }[] }> {
  const packageId = options.packageId ?? crypto.randomUUID();
  const exportedAt = options.now ?? new Date().toISOString();
  const target = options.partBytes ?? 40 * MiB;
  if (!identity(packageId) || !validDate(exportedAt) || !Number.isSafeInteger(target) || target < 256 || target > MAX_PART) throw new Error('分包 ID、时间或目标大小无效（256 B–50 MiB）。');
  const data = structuredClone(input);
  const errors = [...validateArchiveMetadata(data), ...scopeErrors(data), ...auditErrors(data.audits, data.kind)];
  if (errors.length) throw new Error(errors.join('；'));
  await validateSnapshots(data.bundle, data.snapshots);
  const unique = new Map<string, typeof data.bundle.assets[number]>();
  for (const asset of data.bundle.assets) {
    const previous = unique.get(asset.sha256);
    if (previous && (previous.mime !== asset.mime || previous.size !== asset.size)) throw new Error('同一原图摘要存在不同格式或大小。');
    unique.set(asset.sha256, previous ?? asset);
  }
  const media = [...unique.values()].sort((left, right) => left.sha256.localeCompare(right.sha256)).map(asset => ({ sha256: asset.sha256, mime: asset.mime, size: asset.size, path: `images/${asset.sha256}.bin`, part: 0 }));
  if (media.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL) throw new Error('原图总量超过 8 GiB 上限。');
  const groups: typeof media[] = [];
  for (const item of media) {
    let current = groups[groups.length - 1];
    if (!current || (current.length && plannedSize(packageId, groups.length, [...current, item]) > target)) { current = []; groups.push(current); }
    current.push(item); item.part = groups.length;
  }
  if (groups.length > MAX_PARTS) throw new Error('ZIP 分包数量超过 256，请增大每包目标大小。');
  const files: { name: string; blob: Blob }[] = [];
  const parts: StagePackage['parts'] = [];
  for (const [position, group] of groups.entries()) {
    const index = position + 1;
    const document = partDocument(packageId, index, group.map(item => item.path));
    const entries: ZipEntry[] = [{ name: 'part.json', blob: document, crc: (await checksum(document)).crc }];
    for (const item of group) {
      const expected = unique.get(item.sha256)!;
      const asset = await loadAsset(expected.id);
      if (!asset || asset.sha256 !== expected.sha256 || asset.mime !== expected.mime || asset.size !== expected.size || !(asset.blob instanceof Blob) || asset.blob.size !== expected.size || !imageSignature(new Uint8Array(await asset.blob.slice(0, 16).arrayBuffer()), item.mime)) throw new Error(`缺少或无法读取原图：${expected.name}。未生成数据包。`);
      const checks = await checksum(asset.blob);
      if (checks.sha256 !== item.sha256) throw new Error(`原图 SHA-256 不匹配：${expected.name}。未生成数据包。`);
      entries.push({ name: item.path, blob: asset.blob, crc: checks.crc });
    }
    const blob = zip(entries);
    if (blob.size > MAX_PART) throw new Error('单个 ZIP 分包超过 50 MiB。');
    const name = `${packageId}.part-${String(index).padStart(3, '0')}.zip`;
    files.push({ name, blob });
    parts.push({ index, name, sha256: (await checksum(blob)).sha256, size: blob.size, entries: group.map(item => item.path) });
  }
  const manifest: StagePackage = {
    format: 'eval-studio-stage-package', schemaVersion: isAnchorMode(input.bundle.project.scheme) ? 2 : 1, packageId, exportedAt,
    senderId: data.senderId, kind: data.kind, productIds: data.productIds,
    bundle: data.bundle, snapshots: data.snapshots, ...(data.audits === undefined ? {} : { audits: data.audits }),
    media, parts, manifestHash: '',
  };
  const { manifestHash: _, ...unsigned } = manifest;
  manifest.manifestHash = await digest(unsigned);
  const validation = manifestErrors(manifest);
  if (validation.length) throw new Error(validation.join('；'));
  const json = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
  if (json.size > MAX_MANIFEST) throw new Error('元数据清单超过 10 MiB 上限。');
  return { manifest, files: [{ name: `${packageId}.eval.json`, blob: json }, ...files] };
}

async function bytesAt(blob: Blob, start: number, length: number) {
  if (!Number.isSafeInteger(start) || start < 0 || length < 0 || start + length > blob.size) throw new Error('ZIP 数据截断或偏移无效。');
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

async function readZip(file: Blob, expectedPaths: string[]): Promise<Map<string, { blob: Blob; crc: number }>> {
  if (file.size < 22 || file.size > MAX_PART) throw new Error('ZIP 分包大小无效或超过 50 MiB。');
  const end = new DataView((await bytesAt(file, file.size - 22, 22)).buffer);
  const count = end.getUint16(10, true);
  const directorySize = end.getUint32(12, true);
  const directoryOffset = end.getUint32(16, true);
  if (end.getUint32(0, true) !== 0x06054b50 || end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0 || end.getUint16(8, true) !== count || end.getUint16(20, true) !== 0 || count !== expectedPaths.length || count > MAX_MEDIA + 1 || directorySize > 2 * MiB || directoryOffset + directorySize !== file.size - 22) throw new Error('ZIP32 目录无效，不支持多卷、ZIP64、注释或隐藏内容。');
  const directory = await bytesAt(file, directoryOffset, directorySize);
  const view = new DataView(directory.buffer);
  const expected = new Set(expectedPaths);
  const entries = new Map<string, { blob: Blob; crc: number }>();
  let cursor = 0;
  let localOffset = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directory.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 中央目录被截断。');
    const version = view.getUint16(cursor + 6, true), flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true), compressed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true);
    const length = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    if (version !== 20 || ![0, 0x800].includes(flags) || method !== 0 || compressed !== size || !length || length > 100 || extra || comment || view.getUint16(cursor + 34, true) !== 0 || view.getUint32(cursor + 38, true) !== 0 || view.getUint32(cursor + 42, true) !== localOffset || cursor + 46 + length > directory.length) throw new Error('ZIP 仅支持未加密的 STORE 文件，禁止压缩、额外字段、链接或重叠数据。');
    const name = decoder.decode(directory.subarray(cursor + 46, cursor + 46 + length));
    if (!expected.has(name) || entries.has(name) || (name !== 'part.json' && !/^images\/[a-f0-9]{64}\.bin$/.test(name)) || (name === 'part.json' ? size > MiB : size > MAX_IMAGE) || size <= 0) throw new Error('ZIP 包含多余、重复、不安全路径或超限文件。');
    const local = new DataView((await bytesAt(file, localOffset, 30)).buffer);
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(4, true) !== version || local.getUint16(6, true) !== flags || local.getUint16(8, true) !== method || local.getUint32(14, true) !== crc || local.getUint32(18, true) !== size || local.getUint32(22, true) !== size || local.getUint16(26, true) !== length || local.getUint16(28, true) !== 0 || decoder.decode(await bytesAt(file, localOffset + 30, length)) !== name) throw new Error('ZIP 本地文件头与目录不一致。');
    const dataStart = localOffset + 30 + length;
    const dataEnd = dataStart + size;
    if (dataEnd > directoryOffset) throw new Error('ZIP 文件数据越界或重叠。');
    entries.set(name, { blob: file.slice(dataStart, dataEnd), crc });
    localOffset = dataEnd;
    cursor += 46 + length;
  }
  if (cursor !== directory.length || localOffset !== directoryOffset || entries.size !== expected.size) throw new Error('ZIP 包含未列出的数据或缺少文件。');
  return entries;
}

export async function readStagePackage(files: File[]): Promise<{ manifest: StagePackage; blobs: Map<string, Blob> }> {
  if (!files.length || files.length > MAX_PARTS + 1) throw new Error('请一次选择清单 .eval.json 与全部 ZIP 分包（最多 256 包）。');
  const names = new Set<string>();
  for (const file of files) {
    if (!(file instanceof Blob) || typeof file.name !== 'string' || names.has(file.name)) throw new Error('选择的文件名重复或文件无效。');
    names.add(file.name);
  }
  const manifests = files.filter(file => file.name.endsWith('.eval.json'));
  if (manifests.length !== 1 || manifests[0].size > MAX_MANIFEST) throw new Error('需要且只能包含一份不超过 10 MiB 的 .eval.json 清单。');
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(await manifests[0].arrayBuffer())); }
  catch { throw new Error('清单不是有效的 UTF-8 JSON。'); }
  const errors = manifestErrors(raw);
  if (errors.length) throw new Error(errors.join('；'));
  const manifest = raw as StagePackage;
  if (manifests[0].name !== `${manifest.packageId}.eval.json`) throw new Error('清单文件名与数据包 ID 不一致，请保留原始文件名。');
  const { manifestHash, ...unsigned } = manifest;
  if (await digest(unsigned) !== manifestHash) throw new Error('清单 SHA-256 校验失败，文件可能损坏或被修改。');
  await validateSnapshots(manifest.bundle, manifest.snapshots);
  const missing = manifest.parts.filter(part => !names.has(part.name));
  if (missing.length) throw new Error(`缺少 ${missing.length} 个 ZIP 分包：${missing.map(part => part.name).join('、')}。请同时选择清单与全部分包。`);
  const expectedNames = new Set([manifests[0].name, ...manifest.parts.map(part => part.name)]);
  if (files.some(file => !expectedNames.has(file.name))) throw new Error('选择中存在当前数据包之外的多余文件，请只选择这一包的清单和分包。');
  const blobs = new Map<string, Blob>();
  for (const part of manifest.parts) {
    const file = files.find(file => file.name === part.name)!;
    if (file.size !== part.size || file.size > MAX_PART) throw new Error(`${part.name} 的大小不符或超过 50 MiB。`);
    if ((await checksum(file)).sha256 !== part.sha256) throw new Error(`${part.name} 的 SHA-256 校验失败。`);
    const entries = await readZip(file, ['part.json', ...part.entries]);
    const document = entries.get('part.json')!;
    if ((await checksum(document.blob)).crc !== document.crc) throw new Error(`${part.name} 的 part.json CRC32 校验失败。`);
    let metadata: unknown;
    try { metadata = JSON.parse(decoder.decode(await document.blob.arrayBuffer())); }
    catch { throw new Error(`${part.name} 的 part.json 无法读取。`); }
    if (!object(metadata) || !sameKeys(metadata, ['packageId', 'index', 'entries']) || metadata.packageId !== manifest.packageId || metadata.index !== part.index || canonical(metadata.entries) !== canonical(part.entries)) throw new Error(`${part.name} 不属于当前数据包，或分包内容清单不符。`);
    for (const path of part.entries) {
      const media = manifest.media.find(item => item.path === path)!;
      const entry = entries.get(path)!;
      if (entry.blob.size !== media.size) throw new Error(`原图大小与清单不符：${path}。`);
      const checks = await checksum(entry.blob);
      if (checks.crc !== entry.crc) throw new Error(`原图 CRC32 校验失败：${path}。`);
      if (checks.sha256 !== media.sha256) throw new Error(`原图 SHA-256 校验失败：${path}。`);
      if (!imageSignature(new Uint8Array(await entry.blob.slice(0, 16).arrayBuffer()), media.mime)) throw new Error(`原图格式与内容不符：${path}。`);
      blobs.set(media.sha256, entry.blob.slice(0, entry.blob.size, media.mime));
    }
  }
  if (blobs.size !== manifest.media.length) throw new Error('数据包原图不完整。');
  return { manifest, blobs };
}
