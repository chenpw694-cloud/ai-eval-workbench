import { readFileSync } from 'node:fs';
const sourceScheme = JSON.parse(readFileSync(new URL('../../schemes/ecommerce-t2i/scheme.json', import.meta.url), 'utf8'));
const stamp = '2026-10-20T12:00:00.000Z';
const clone = value => structuredClone(value);
export function fixture(productCount = 3, questionCount = 2, imagesPerQuestion = 1) {
  const members = Array.from({ length: productCount }, (_, index) => ({ id: `m${index + 1}`, name: `评测员 ${index + 1}` }));
  const products = members.map((member, index) => ({ id: `p${index + 1}`, name: `真实产品 ${index + 1}`, version: 'v1', role: 'direct', demo: false, ownerId: member.id, totalCost: (index + 1) * 10, commercialUse: 'allowed', commercialEvidence: '协议明确允许商用' }));
  const questions = Array.from({ length: questionCount }, (_, index) => ({ id: `q${index + 1}`, title: `题目 ${index + 1}`, scene: '场景图', category: '美妆', difficulty: '基础', request: '制作商品场景图', acceptance: ['商品与参考要求一致'], referenceNames: [], fields: {} }));
  const project = { id: 'project', name: '真实评测', background: '试跑', period: '3 天', members, products, questions, scheme: { ...clone(sourceScheme), policies: { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' } }, rulesConfirmed: true, expectedQuestionCount: questionCount, status: 'active', revision: 1, createdAt: stamp, updatedAt: stamp, schemeHash: 'scheme-v1', questionsHash: 'questions-v1' };
  const assets = [];
  const evaluations = [];
  const walkthroughs = [];
  const experiences = [];
  for (const [productIndex, product] of products.entries()) {
    for (const question of questions) {
      const mediaIds = Array.from({ length: imagesPerQuestion }, (_, index) => `${product.id}-${question.id}-${index + 1}`);
      for (const id of mediaIds) assets.push({ id, projectId: project.id, questionId: question.id, productId: product.id, role: 'output', name: `${id}.png`, mime: 'image/png', size: 1, sha256: `sha-${id}`, createdAt: stamp });
      evaluations.push({ id: `${product.id}-${question.id}-v1`, projectId: project.id, productId: product.id, questionId: question.id, reviewerId: product.ownerId, revision: 1, parentId: null, status: 'submitted', mediaIds, bestMediaId: mediaIds[0] ?? null, mediaChecks: mediaIds.map(mediaId => ({ mediaId, usable: true, infringement: false })), tags: [], seconds: 30 + productIndex * 10, failed: false, failureReason: '', notes: '', schemeHash: project.schemeHash, questionsHash: project.questionsHash, createdAt: stamp });
    }
    for (const task of ['background', 'color', 'expand']) walkthroughs.push({ id: `${product.id}-${task}`, projectId: project.id, productId: product.id, task, status: 'submitted', completed: true, steps: 1, tags: [], notes: '' });
    experiences.push({ productId: product.id, score: 5, notes: '' });
  }
  return { project, assets, evaluations, walkthroughs, experiences };
}
