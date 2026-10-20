import type { Project } from './model.ts';

const filled = (value: string) => value.trim().length > 0;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};

/**
 * Submitted work freezes its measurement scope. Before distribution, completing
 * a previously blank product label is safe: IDs, ownership and scored rules do
 * not change. Once active (distributed or in quality review), labels freeze too
 * because team packages compare the complete product identity.
 */
export function frozenConfigurationMatches(previous: Project, next: Project): boolean {
  if (previous.status === 'active' && next.status !== 'active') return false;
  const protectedFields = (project: Project, allowCompletion: boolean) => ({
    members: project.members,
    products: project.products.map(({ totalCost, commercialUse, commercialEvidence, ...product }) => {
      if (!allowCompletion) return product;
      const original = previous.products.find(item => item.id === product.id);
      if (!original) return product;
      return {
        ...product,
        name: !filled(original.name) && filled(product.name) ? original.name : product.name,
        version: !filled(original.version) && filled(product.version) ? original.version : product.version
      };
    }),
    questions: project.questions,
    scheme: project.scheme,
    rulesConfirmed: project.rulesConfirmed,
    expectedQuestionCount: project.expectedQuestionCount
  });
  return canonical(protectedFields(previous, false)) === canonical(protectedFields(next, previous.status === 'draft'));
}
