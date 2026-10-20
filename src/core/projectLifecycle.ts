import type { Project } from './model.ts';

/** A restart creates a separate collection scope; source evidence is never copied. */
export function buildRestartedProject(
  source: Project,
  options: { name: string; keepQuestions: boolean },
  makeId: () => string,
  now: string
): Project {
  const usedIds = new Set([source.id, ...source.members.map(row => row.id), ...source.products.map(row => row.id)]);
  const allocate = () => {
    const id = makeId();
    if (!id || usedIds.has(id)) throw new Error('新项目标识重复，请重试');
    usedIds.add(id);
    return id;
  };
  const id = allocate();
  const ownerIds = new Map<string, string>();
  const members = source.members.map(member => {
    const memberId = allocate();
    ownerIds.set(member.id, memberId);
    return { ...structuredClone(member), id: memberId };
  });
  const products = source.products.map(product => ({
    ...structuredClone(product), id: allocate(), ownerId: ownerIds.get(product.ownerId) ?? '',
    totalCost: null, commercialUse: 'unreviewed' as const, commercialEvidence: ''
  }));
  // Construct explicitly: sourceSnapshot and future evidence fields must not leak into a restart.
  return {
    id, name: options.name.trim() || `${source.name}（重新开始）`,
    background: source.background, period: source.period, members, products,
    questions: options.keepQuestions ? structuredClone(source.questions) : [],
    scheme: structuredClone(source.scheme), rulesConfirmed: false,
    expectedQuestionCount: source.expectedQuestionCount,
    status: 'draft', revision: 0, createdAt: now, updatedAt: now,
    schemeHash: '', questionsHash: ''
  };
}
