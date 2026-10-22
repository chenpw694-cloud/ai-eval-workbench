import type { Project } from './model.ts';

const filled = (value: string) => value.trim().length > 0;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};

export function productInfoCorrectionErrors(previous: Project, next: Project): string[] {
  const memberIds = new Set(next.members.map(member => member.id));
  return next.products.flatMap((product, index) => {
    const original = previous.products.find(item => item.id === product.id);
    if (!original) return [];
    const errors: string[] = [];
    for (const [key, label] of [['name', '名称'], ['version', '版本或档位']] as const) {
      if (typeof product[key] !== 'string' || (product[key] !== original[key] && !filled(product[key]))) errors.push(`第 ${index + 1} 个产品的${label}不可清空，请填写后再保存。`);
    }
    if (!['self', 'direct', 'benchmark', 'alternative'].includes(product.role)) errors.push(`第 ${index + 1} 个产品请选择有效的竞品角色。`);
    if (product.ownerId !== original.ownerId && !memberIds.has(product.ownerId)) errors.push(`第 ${index + 1} 个产品请选择项目中的负责人。`);
    return errors;
  });
}

/** Existing IDs, real/demo scope, questions and rules freeze; descriptive corrections create a new project snapshot. */
export function frozenConfigurationMatches(previous: Project, next: Project): boolean {
  if (previous.status === 'active' && next.status !== 'active') return false;
  if (next.members.some(member => typeof member.name !== 'string' || !filled(member.name))) return false;
  if (productInfoCorrectionErrors(previous, next).length) return false;
  const protectedFields = (project: Project) => ({
    members: project.members.map(({ name: _name, ...member }) => member),
    products: project.products.map(({ name: _name, version: _version, role: _role, ownerId: _owner, totalCost: _cost, commercialUse: _use, commercialEvidence: _evidence, ...product }) => product),
    questions: project.questions,
    scheme: project.scheme,
    rulesConfirmed: project.rulesConfirmed,
    expectedQuestionCount: project.expectedQuestionCount
  });
  return canonical(protectedFields(previous)) === canonical(protectedFields(next));
}
