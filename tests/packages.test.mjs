import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildStagePackage, readStagePackage } from '../src/core/packages.ts';
import { validateArchiveMetadata, validateBackupStructure } from '../src/core/backup.ts';

const sourceScheme = JSON.parse(readFileSync(new URL('../schemes/ecommerce-t2i/scheme.json', import.meta.url), 'utf8'));
const now = '2026-10-18T12:00:00.000Z';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const blobHash = async blob => hash(Buffer.from(await blob.arrayBuffer()));
const options = { packageId: 'test-package', now };

function fixture(imageSizes = []) {
  const scheme = { ...structuredClone(sourceScheme), policies: { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' } };
  const questions = [{ id: 'q1', title: '白底主图', scene: '白底主图', category: '美妆', difficulty: '基础', request: '生成商品白底主图', acceptance: ['商品信息准确'], referenceNames: [], fields: {} }];
  const project = {
    id: 'project', name: '真实评测', background: '', period: '', members: [{ id: 'm1', name: '评测员' }],
    products: [1, 2].map(index => ({ id: `p${index}`, name: `产品 ${index}`, version: 'v1', role: 'direct', demo: false, ownerId: 'm1', totalCost: null, commercialUse: 'unreviewed', commercialEvidence: '' })),
    questions, scheme, rulesConfirmed: false, expectedQuestionCount: 50, status: 'draft', revision: 1,
    createdAt: now, updatedAt: now, schemeHash: hash(scheme), questionsHash: hash(questions),
  };
  const originals = new Map();
  const bundle = { project, evaluations: [], assets: [], walkthroughs: [], experiences: [] };
  for (const [index, size] of imageSizes.entries()) {
    // PNG signature with deterministic trailing bytes is a technical hash/ZIP fixture.
    const bytes = Buffer.concat([png, Buffer.alloc(Math.max(0, size - png.length), index + 1)]);
    const metadata = { id: `a${index}`, projectId: 'project', questionId: 'q1', productId: 'p1', role: 'output', name: `原图 ${index}.png`, mime: 'image/png', size: bytes.length, sha256: hash(bytes), createdAt: now };
    bundle.assets.push(metadata);
    originals.set(metadata.id, { ...metadata, blob: new Blob([bytes], { type: 'image/png' }) });
  }
  if (bundle.assets.length) bundle.evaluations.push({
    id: 'e1', projectId: 'project', questionId: 'q1', productId: 'p1', reviewerId: 'm1', revision: 1, parentId: null,
    status: 'draft', mediaIds: bundle.assets.map(asset => asset.id), bestMediaId: bundle.assets[0].id,
    mediaChecks: bundle.assets.map(asset => ({ mediaId: asset.id, usable: null, infringement: null })), tags: [], seconds: null,
    failed: false, failureReason: '', notes: '', schemeHash: project.schemeHash, questionsHash: project.questionsHash, createdAt: now,
  });
  const input = { bundle, snapshots: [structuredClone(project)], kind: 'baseline', senderId: 'm1', productIds: ['p1', 'p2'] };
  return { input, originals, load: async id => originals.get(id) };
}

const selectedFiles = result => result.files.map(file => new File([file.blob], file.name, { type: file.blob.type }));

function replaceManifest(result, edit, recalculate = true) {
  const manifest = structuredClone(result.manifest);
  edit(manifest);
  if (recalculate) { const { manifestHash, ...unsigned } = manifest; manifest.manifestHash = hash(unsigned); }
  return { manifest, files: [{ name: `${manifest.packageId}.eval.json`, blob: new Blob([JSON.stringify(manifest)]) }, ...result.files.slice(1)] };
}

async function alterZip(result, mutate) {
  const part = result.manifest.parts[0];
  const bytes = Buffer.from(await result.files[1].blob.arrayBuffer());
  const directoryOffset = bytes.readUInt32LE(bytes.length - 6);
  mutate(bytes, directoryOffset);
  const edited = replaceManifest(result, manifest => { manifest.parts[0].sha256 = hash(bytes); manifest.parts[0].size = bytes.length; });
  edited.files[1] = { name: part.name, blob: new Blob([bytes], { type: 'application/zip' }) };
  return edited;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('metadata-only assignments need no ZIP and match independently computed manifest SHA-256', async () => {
  const { input, load } = fixture();
  input.kind = 'assignment';
  const result = await buildStagePackage(input, load, options);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.manifest.media, []);
  assert.deepEqual(result.manifest.parts, []);
  const { manifestHash, ...unsigned } = result.manifest;
  assert.equal(manifestHash, hash(unsigned));
  const restored = await readStagePackage(selectedFiles(result));
  assert.deepEqual(restored.manifest.bundle, input.bundle);
  assert.equal(restored.blobs.size, 0);
});

test('original bytes survive STORE ZIP roundtrip; CRC and both SHA-256 layers match Node independently', async () => {
  const { input, load, originals } = fixture([png.length]);
  const result = await buildStagePackage(input, load, options);
  const file = result.files[1];
  assert.equal(await blobHash(file.blob), result.manifest.parts[0].sha256);
  const bytes = Buffer.from(await file.blob.arrayBuffer());
  const directory = bytes.readUInt32LE(bytes.length - 6);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(8), 0); // STORE, no deflate.
  const firstNameLength = bytes.readUInt16LE(26);
  const partSize = bytes.readUInt32LE(18);
  const document = bytes.subarray(30 + firstNameLength, 30 + firstNameLength + partSize);
  assert.equal(bytes.readUInt32LE(14), crc32(document));
  assert.equal(bytes.readUInt32LE(directory), 0x02014b50);
  const restored = await readStagePackage(selectedFiles(result));
  const expected = originals.get('a0');
  const image = restored.blobs.get(expected.sha256);
  assert.equal(image.type, 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal(await blobHash(image), expected.sha256);
});

test('identical content across asset IDs is archived once, while record references are retained', async () => {
  const fixtureData = fixture([png.length]);
  const copy = { ...fixtureData.input.bundle.assets[0], id: 'a-duplicate', name: '另一个引用.png' };
  fixtureData.input.bundle.assets.push(copy);
  fixtureData.originals.set(copy.id, { ...copy, blob: fixtureData.originals.get('a0').blob });
  const result = await buildStagePackage(fixtureData.input, fixtureData.load, options);
  assert.equal(result.manifest.media.length, 1);
  assert.equal(result.manifest.bundle.assets.length, 2);
  assert.equal((await readStagePackage(selectedFiles(result))).blobs.size, 1);
});

test('small target splits sequential STORE parts and requires all files regardless of selection order', async () => {
  const { input, load } = fixture([400, 401, 402]);
  const result = await buildStagePackage(input, load, { ...options, partBytes: 1000 });
  assert.equal(result.manifest.parts.length, 3);
  assert.ok(result.manifest.parts.every(part => part.size <= 1000));
  assert.deepEqual(result.manifest.media.map(media => media.part), [1, 2, 3]);
  assert.equal((await readStagePackage(selectedFiles(result).reverse())).blobs.size, 3);
  await assert.rejects(readStagePackage(selectedFiles(result).slice(0, -1)), /缺少 1 个 ZIP 分包/);
});

test('SHA-256 works across 64-byte, padding and one-MiB streaming boundaries', async () => {
  const sizes = [68, 119, 120, 127, 128, 129, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1];
  const { input, load } = fixture(sizes);
  const result = await buildStagePackage(input, load, options);
  for (const part of result.manifest.parts) {
    assert.equal(await blobHash(result.files.find(file => file.name === part.name).blob), part.sha256);
  }
  const restored = await readStagePackage(selectedFiles(result));
  for (const asset of input.bundle.assets) assert.equal(await blobHash(restored.blobs.get(asset.sha256)), asset.sha256);
});

test('unexpected, duplicate, mixed and absent input files are rejected', async () => {
  const { input, load } = fixture([80]);
  const result = await buildStagePackage(input, load, options);
  const files = selectedFiles(result);
  await assert.rejects(readStagePackage([]), /全部 ZIP/);
  await assert.rejects(readStagePackage([files[0], files[0], files[1]]), /重复/);
  await assert.rejects(readStagePackage([files[1]]), /清单/);
  await assert.rejects(readStagePackage([...files, new File(['x'], 'unrelated.png')]), /多余文件/);
  await assert.rejects(readStagePackage([...files, new File(['{}'], 'another.eval.json')]), /只能包含一份/);
});

test('tampered manifest and ZIP bytes fail the outer SHA-256 checks', async () => {
  const { input, load } = fixture([80]);
  const result = await buildStagePackage(input, load, options);
  const manifest = replaceManifest(result, value => { value.senderId = 'other'; }, false);
  await assert.rejects(readStagePackage(selectedFiles(manifest)), /清单 SHA-256/);
  const bytes = Buffer.from(await result.files[1].blob.arrayBuffer());
  bytes[35] ^= 1;
  const corruptZip = { ...result, files: [result.files[0], { ...result.files[1], blob: new Blob([bytes]) }] };
  await assert.rejects(readStagePackage(selectedFiles(corruptZip)), /SHA-256 校验失败/);
});

test('a re-signed archive with corrupt image data fails CRC32, even if its outer SHA is valid', async () => {
  const { input, load } = fixture([80]);
  const result = await buildStagePackage(input, load, options);
  const edited = await alterZip(result, bytes => {
    const next = 30 + bytes.readUInt16LE(26) + bytes.readUInt32LE(18);
    const data = next + 30 + bytes.readUInt16LE(next + 26);
    bytes[data + 20] ^= 1;
  });
  await assert.rejects(readStagePackage(selectedFiles(edited)), /CRC32/);
});

test('updating ZIP CRC still cannot bypass the per-image SHA-256', async () => {
  const { input, load } = fixture([80]);
  const result = await buildStagePackage(input, load, options);
  const edited = await alterZip(result, (bytes, directory) => {
    const local = 30 + bytes.readUInt16LE(26) + bytes.readUInt32LE(18);
    const data = local + 30 + bytes.readUInt16LE(local + 26);
    bytes[data + 20] ^= 1;
    const crc = crc32(bytes.subarray(data, data + bytes.readUInt32LE(local + 18)));
    bytes.writeUInt32LE(crc, local + 14);
    const central = directory + 46 + bytes.readUInt16LE(directory + 28);
    bytes.writeUInt32LE(crc, central + 16);
  });
  await assert.rejects(readStagePackage(selectedFiles(edited)), /原图 SHA-256/);
});

test('strict ZIP reader rejects compression, data descriptors, unsafe names and bomb sizes', async () => {
  const { input, load } = fixture([80]);
  const result = await buildStagePackage(input, load, options);
  for (const mutate of [
    (bytes, directory) => { bytes.writeUInt16LE(8, 8); bytes.writeUInt16LE(8, directory + 10); },
    (bytes, directory) => { bytes.writeUInt16LE(0x808, 6); bytes.writeUInt16LE(0x808, directory + 8); },
    (bytes, directory) => { bytes.write('../x.json', 30, 'ascii'); bytes.write('../x.json', directory + 46, 'ascii'); },
    (bytes, directory) => { bytes.writeUInt32LE(0xffffffff, 18); bytes.writeUInt32LE(0xffffffff, 22); bytes.writeUInt32LE(0xffffffff, directory + 20); bytes.writeUInt32LE(0xffffffff, directory + 24); },
  ]) {
    const edited = await alterZip(result, mutate);
    await assert.rejects(readStagePackage(selectedFiles(edited)), /ZIP/);
  }
  const unsafeManifest = replaceManifest(result, value => { value.media[0].path = '../secret.png'; });
  await assert.rejects(readStagePackage(selectedFiles(unsafeManifest)), /路径/);
});

test('part identity, local/central mismatch, prepended and appended hidden bytes are rejected', async () => {
  const { input, load } = fixture([80]);
  const result = await buildStagePackage(input, load, options);
  const wrongIdentity = await alterZip(result, (bytes, directory) => {
    const start = 30 + bytes.readUInt16LE(26);
    const size = bytes.readUInt32LE(18);
    const data = Buffer.from(bytes.subarray(start, start + size).toString().replace('test-package', 'evil-package'));
    data.copy(bytes, start);
    const crc = crc32(data);
    bytes.writeUInt32LE(crc, 14); bytes.writeUInt32LE(crc, directory + 16);
  });
  await assert.rejects(readStagePackage(selectedFiles(wrongIdentity)), /不属于当前数据包/);
  const mismatch = await alterZip(result, bytes => { bytes.writeUInt32LE(0, 14); });
  await assert.rejects(readStagePackage(selectedFiles(mismatch)), /文件头与目录不一致/);
  const trailing = await alterZip(result, () => {});
  const archive = Buffer.from(await trailing.files[1].blob.arrayBuffer());
  const longer = Buffer.concat([archive, Buffer.from('hidden')]);
  const extra = replaceManifest(trailing, value => { value.parts[0].sha256 = hash(longer); value.parts[0].size = longer.length; });
  extra.files[1] = { ...extra.files[1], blob: new Blob([longer]) };
  await assert.rejects(readStagePackage(selectedFiles(extra)), /ZIP32/);
});

test('oversized manifests, parts, images and unsupported data types are rejected', async () => {
  await assert.rejects(readStagePackage([new File([new Blob(['x'.repeat(10 * 1024 * 1024 + 1)])], 'x.eval.json')]), /10 MiB/);
  const { input, load } = fixture([80]);
  const result = await buildStagePackage(input, load, options);
  const oversized = replaceManifest(result, value => { value.parts[0].size = 50 * 1024 * 1024 + 1; });
  await assert.rejects(readStagePackage(selectedFiles(oversized)), /分包清单/);
  input.bundle.assets[0].size = 25 * 1024 * 1024 + 1;
  await assert.rejects(buildStagePackage(input, load, options), /大小/);
  input.bundle.assets[0].size = 80;
  input.bundle.assets[0].mime = 'image/svg+xml';
  await assert.rejects(buildStagePackage(input, load, options), /格式/);
});

test('missing or changed local originals abort export without returning a partial package', async () => {
  const { input } = fixture([80]);
  await assert.rejects(buildStagePackage(input, async () => undefined, options), /缺少或无法读取/);
  const wrong = fixture([80]);
  wrong.originals.get('a0').blob = new Blob([png, Buffer.alloc(12, 7)]);
  await assert.rejects(buildStagePackage(wrong.input, wrong.load, options), /SHA-256 不匹配/);
});

test('all rule/question snapshots must hash correctly and every evaluation must be traceable', async () => {
  const fixtureData = fixture([80]);
  fixtureData.input.snapshots[0].scheme.tags[0].name = '改写的历史标签';
  await assert.rejects(buildStagePackage(fixtureData.input, fixtureData.load, options), /快照内容|SHA-256/);
  const valid = fixture([80]);
  const result = await buildStagePackage(valid.input, valid.load, options);
  const corrupt = replaceManifest(result, value => {
    const past = structuredClone(value.snapshots[0]);
    past.revision = 2; past.scheme.tags[0].name = '损坏的历史标签';
    value.snapshots.push(past);
  });
  await assert.rejects(readStagePackage(selectedFiles(corrupt)), /修订 2.*SHA-256/);
  valid.input.bundle.evaluations[0].schemeHash = 'a'.repeat(64);
  await assert.rejects(buildStagePackage(valid.input, valid.load, options), /历史规则或题库快照缺失/);
});

test('submission scope is enforced without dropping other project product identities', async () => {
  const { input, load } = fixture([80]);
  input.kind = 'submission'; input.productIds = ['p1'];
  const result = await buildStagePackage(input, load, options);
  assert.equal(result.manifest.bundle.project.products.length, 2);
  input.productIds = ['p2'];
  await assert.rejects(buildStagePackage(input, load, options), /范围之外/);
});

test('metadata validator shares strict chains and does not load or encode base64', () => {
  const { input } = fixture([80]);
  assert.deepEqual(validateArchiveMetadata(input), []);
  assert.match(validateBackupStructure({ format: 'eval-studio-project-backup', schemaVersion: 1, ...input, blobs: [] }).join(), /原图缺失/);
  input.bundle.evaluations.push({ ...structuredClone(input.bundle.evaluations[0]), id: 'branch', parentId: null });
  assert.match(validateArchiveMetadata(input).join(), /分叉|链/);
});

test('baseline retains audited evidence; assignment, submissions and malformed audit fields are refused', async () => {
  const { input, load } = fixture([80]);
  const audit = { id: 'audit-1', projectId: 'project', packageId: 'previous-package', importedAt: now, senderId: 'm1', kind: 'submission', counts: { evaluations: 1 }, decisions: { e1: 'local' }, resolverId: 'm1', reason: '保留本地判断', conflicts: [], incoming: structuredClone(input.bundle), before: null };
  input.audits = [audit];
  const result = await buildStagePackage(input, load, options);
  assert.deepEqual((await readStagePackage(selectedFiles(result))).manifest.audits, [audit]);
  const assignment = fixture();
  assignment.input.kind = 'assignment'; assignment.input.audits = [audit];
  await assert.rejects(buildStagePackage(assignment.input, assignment.load, options), /分配包不能携带历史审计/);
  input.kind = 'submission';
  await assert.rejects(buildStagePackage(input, load, options), /不能携带历史审计/);
  input.kind = 'baseline';
  for (const change of [
    value => { value.counts.evaluations = -1; },
    value => { value.decisions.e1 = 'discard'; },
    value => { value.kind = 'unknown'; },
    value => { value.projectId = 'another-project'; },
    value => { value.incoming.project.id = 'another-project'; },
    value => { value.manifestHash = 'not-a-sha256'; },
  ]) {
    input.audits = [structuredClone(audit)]; change(input.audits[0]);
    await assert.rejects(buildStagePackage(input, load, options), /历史审计/);
  }
});

test('assignment packages cannot reveal scores, output images, mutable product data or history', async () => {
  const withOutput = fixture([80]); withOutput.input.kind = 'assignment';
  await assert.rejects(buildStagePackage(withOutput.input, withOutput.load, options), /不能携带评分/);

  const withExperience = fixture(); withExperience.input.kind = 'assignment';
  withExperience.input.bundle.experiences.push({ productId: 'p1', score: 2, notes: '私人判断' });
  await assert.rejects(buildStagePackage(withExperience.input, withExperience.load, options), /不能携带评分/);

  for (const mutate of [
    product => { product.totalCost = 0; },
    product => { product.commercialUse = 'allowed'; },
    product => { product.commercialEvidence = '协议依据'; },
  ]) {
    const data = fixture(); data.input.kind = 'assignment';
    mutate(data.input.bundle.project.products[0]);
    data.input.snapshots = [structuredClone(data.input.bundle.project)];
    await assert.rejects(buildStagePackage(data.input, data.load, options), /费用与商用判断必须清空/);
  }

  const historical = fixture(); historical.input.kind = 'assignment';
  historical.input.bundle.project.revision = 2;
  historical.input.snapshots.push(structuredClone(historical.input.bundle.project));
  await assert.rejects(buildStagePackage(historical.input, historical.load, options), /只能携带.*一份净化快照/);
});

test('submission packages cannot reveal other products mutable data in current or historical snapshots', async () => {
  const data = fixture([80]); data.input.kind = 'submission'; data.input.productIds = ['p1'];
  data.input.bundle.project.products[1].totalCost = 10;
  data.input.snapshots = [structuredClone(data.input.bundle.project)];
  await assert.rejects(buildStagePackage(data.input, data.load, options), /范围外产品.*费用或商用判断/);

  data.input.bundle.project.products[1].totalCost = null;
  data.input.bundle.project.revision = 2;
  data.input.snapshots.push(structuredClone(data.input.bundle.project));
  await assert.rejects(buildStagePackage(data.input, data.load, options), /历史快照.*范围外产品/);

  data.input.snapshots[0].products[1].totalCost = null;
  data.input.bundle.project.products[0].totalCost = 42;
  data.input.snapshots[1] = structuredClone(data.input.bundle.project);
  const result = await buildStagePackage(data.input, data.load, options);
  assert.equal((await readStagePackage(selectedFiles(result))).manifest.bundle.project.products[0].totalCost, 42);
});
