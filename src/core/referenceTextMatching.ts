import type { Project, Question } from './model.ts';
import type { BulkFileHint, BulkImageMatch } from './bulkImageMatching.ts';

export type ReferenceLabels = Record<string, string>;
export type ReferenceTextMatch = BulkImageMatch & { referenceName: string };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US').trim();
const basename = (value: string) => value.replace(/\\/g, '/').split('/').at(-1) ?? value;
const stem = (value: string) => basename(value).replace(/\.[^.]+$/, '');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseReferenceLabels(source: string): ReferenceLabels {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('商品对应表不是有效 JSON，请使用“文件名: 商品名称”的格式。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('商品对应表应为对象，例如 {"1.png":"精华液"}。');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 5000) throw new Error('商品对应表须包含 1～5000 个文件名。');
  for (const [key, label] of entries) {
    if (!key.trim() || typeof label !== 'string' || !label.trim() || label.length > 300) throw new Error(`“${key}”的商品名称须为 1～300 字的文字。`);
  }
  return Object.fromEntries(entries.map(([key, label]) => [key.trim().replace(/\\/g, '/'), (label as string).trim()]));
}

function includesTerm(haystack: string, term: string) {
  if (/\p{Script=Han}/u.test(term)) {
    haystack = haystack.replace(/\s+/g, '');
    term = term.replace(/\s+/g, '');
  }
  // Prevent "cream" matching "icecream", and R01 matching R010.
  return new RegExp(`${/^[a-z0-9]/i.test(term) ? '(?:^|[^a-z0-9])' : ''}${escape(term)}${/[a-z0-9]$/i.test(term) ? '(?=$|[^a-z0-9])' : ''}`, 'iu').test(haystack);
}
function productTerms(file: BulkFileHint, labels: ReferenceLabels): string[] {
  const label = labels[file.path.replace(/\\/g, '/')] ?? labels[file.name];
  const name = stem(file.name).replace(/^(?:r(?:ef)?[\s_-]*)?\d+[\s_-]+/i, '');
  return [...new Set((label !== undefined ? label.split(/[、,，;；|\n]/) : [name]).map(normalize)
    .filter(term => term.length >= 2 && !/^\d+$/.test(term) && !/^(?:r(?:ef)?|q)[\s_-]*\d+$/i.test(term)
      && !/^(?:img|image|photo|图片|参考图|素材图|素材)[\s_-]*\d*$/i.test(term)))];
}
function slot(question: Question, file: BulkFileHint): string {
  const names = question.referenceNames.filter(name => normalize(basename(name)) === normalize(file.name));
  return names.length === 1 ? names[0] : question.referenceNames.length === 1 ? question.referenceNames[0] : question.referenceNames.length ? '' : file.name;
}

/** Text/metadata matching only: never infers the content of an unlabeled numeric image. */
export function matchReferenceText(project: Project, files: BulkFileHint[], labels: ReferenceLabels = {}): ReferenceTextMatch[] {
  type Candidate = { file: BulkFileHint; question: Question; rank: number; reason: string; referenceName: string };
  const accepted: Candidate[] = [];
  const problems = new Map<string, string[]>();
  const prepared = files.map(file => ({ file, terms: productTerms(file, labels) }));
  for (const question of project.questions) {
    const content = normalize([question.title, question.request, ...Object.values(question.fields)].join('\n'));
    const candidates: Candidate[] = [];
    for (const { file, terms } of prepared) {
      const exact = question.referenceNames.some(name => normalize(basename(name)) === normalize(file.name));
      const code = normalize(stem(file.name));
      const explicit = includesTerm(content, normalize(file.name)) || (/^(?:r(?:ef)?)[\s_-]*\d+$/i.test(code) && includesTerm(content, code));
      const term = terms.filter(term => includesTerm(content, term)).sort((a, b) => b.length - a.length)[0];
      if (exact || explicit || term) candidates.push({ file, question, rank: exact ? 3 : explicit ? 2 : 1,
        referenceName: slot(question, file), reason: exact ? '题目指定了此参考图文件名' : explicit ? '题目包含此文件名或参考图编号' : `题目包含商品名称“${term}”` });
    }
    if (!candidates.length) continue;
    const rank = Math.max(...candidates.map(candidate => candidate.rank));
    const strongest = candidates.filter(candidate => candidate.rank === rank);
    // Two files claiming the same reference position must be reviewed rather than guessed.
    for (const candidate of strongest) {
      const competing = strongest.filter(other => other !== candidate && (!candidate.referenceName || other.referenceName === candidate.referenceName || rank < 3));
      if (competing.length) {
        problems.set(candidate.file.key, [...problems.get(candidate.file.key) ?? [], `${question.id} 同时匹配多张参考图，请手动确认使用哪张`]);
      } else accepted.push(candidate);
    }
  }
  return files.flatMap(file => {
    const matches = accepted.filter(candidate => candidate.file.key === file.key);
    const result: ReferenceTextMatch[] = matches.map(candidate => ({ ...file, role: 'reference', productId: null, questionId: candidate.question.id,
      referenceName: candidate.referenceName, reason: `${candidate.reason}${matches.length > 1 ? `；同一张图共用于 ${matches.length} 道题` : ''}` }));
    const conflicts = problems.get(file.key);
    if (conflicts?.length || !result.length) result.push({ ...file, role: 'reference', productId: null, questionId: null, referenceName: '',
      reason: conflicts?.join('；') ?? (productTerms(file, labels).length ? '未在题目中找到相同商品名称，请补充别名或手动选择题目' : '数字文件名无法判断商品，请先填写商品名称或导入商品对应表') });
    return result;
  });
}
