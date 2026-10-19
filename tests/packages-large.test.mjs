import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildStagePackage, readStagePackage } from '../src/core/packages.ts';

const MiB = 1024 * 1024;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');

test('80 MiB of distinct originals roundtrips above the old JSON cap and passes independent unzip/Node SHA checks', async () => {
  const now = '2026-10-18T12:00:00.000Z';
  const scheme = JSON.parse(readFileSync(new URL('../schemes/ecommerce-t2i/scheme.json', import.meta.url), 'utf8'));
  scheme.policies = { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' };
  const questions = [{ id: 'q1', title: '大文件技术验证', scene: '技术验证', category: '测试', difficulty: '测试', request: '原图分包技术验证', acceptance: ['字节完整恢复'], referenceNames: [], fields: {} }];
  const project = {
    id: 'large-project', name: '80 MiB 技术验证', background: '', period: '',
    members: [{ id: 'm1', name: '测试员' }],
    products: [{ id: 'p1', name: '技术测试', version: 'test', role: 'direct', demo: true, ownerId: 'm1', totalCost: null, commercialUse: 'unreviewed', commercialEvidence: '' }],
    questions, scheme, rulesConfirmed: false, expectedQuestionCount: 1, status: 'draft', revision: 1,
    createdAt: now, updatedAt: now, schemeHash: hash(scheme), questionsHash: hash(questions),
  };
  const originals = new Map();
  const assets = [];
  for (let index = 0; index < 4; index++) {
    // Signature-only technical fixture, deliberately not a decodable generated image.
    const bytes = Buffer.alloc(20 * MiB, index + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const asset = { id: `large-${index}`, projectId: project.id, questionId: 'q1', productId: 'p1', role: 'output', name: `技术原图-${index}.png`, mime: 'image/png', size: bytes.length, sha256: hash(bytes), createdAt: now };
    assets.push(asset);
    originals.set(asset.id, { ...asset, blob: new Blob([bytes], { type: asset.mime }) });
  }
  const bundle = { project, assets, evaluations: [], walkthroughs: [], experiences: [] };
  const result = await buildStagePackage({ bundle, snapshots: [structuredClone(project)], kind: 'baseline', senderId: 'm1', productIds: ['p1'] }, async id => originals.get(id), { packageId: 'large-test', now });
  assert.equal(result.manifest.media.reduce((sum, media) => sum + media.size, 0), 80 * MiB);
  assert.equal(result.manifest.parts.length, 4); // Two 20 MiB images plus ZIP overhead exceed a 40 MiB target.
  assert.ok(result.manifest.parts.every(part => part.size < 40 * MiB));
  const temporary = mkdtempSync(join(tmpdir(), 'eval-packages-'));
  try {
    for (const part of result.manifest.parts) {
      const file = result.files.find(file => file.name === part.name);
      const bytes = Buffer.from(await file.blob.arrayBuffer());
      assert.equal(hash(bytes), part.sha256, `independent part hash ${part.index}`);
      if (existsSync('/usr/bin/unzip')) {
        const path = join(temporary, part.name);
        writeFileSync(path, bytes);
        const report = execFileSync('/usr/bin/unzip', ['-t', path], { encoding: 'utf8' });
        assert.match(report, /No errors detected/);
      }
    }
    const restored = await readStagePackage(result.files.map(file => new File([file.blob], file.name)));
    assert.equal(restored.blobs.size, 4);
    for (const asset of assets) {
      const blob = restored.blobs.get(asset.sha256);
      assert.equal(blob.size, asset.size);
      assert.equal(hash(Buffer.from(await blob.arrayBuffer())), asset.sha256, `independent original hash ${asset.id}`);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
