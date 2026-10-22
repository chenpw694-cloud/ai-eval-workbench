import type { Project } from './model.ts';

export type BulkFileHint = { key: string; path: string; name: string };
export type BulkImageRole = 'reference' | 'output';
export type BulkImageMatch = BulkFileHint & {
  questionId: string | null;
  productId: string | null;
  role: BulkImageRole | null;
  reason: string;
};
export type BulkImageDefaults = {
  role?: BulkImageRole;
  productId?: string;
  questionId?: string;
  /** Opt-in: 1.png / 02.jpeg address the first / second question in array order. */
  numericOrder?: boolean;
};

const referenceFolders = new Set(['参考图', '参考图片', '素材', '素材图', '素材图片', 'reference', 'references', 'ref', 'refs']);
const outputFolders = new Set(['生成图', '生成图片', '生成结果', '评测图', '评测图片', 'output', 'outputs', 'generated', 'results']);
const text = (value: string) => value.normalize('NFC').trim();
const token = (value: string) => text(value).toLocaleLowerCase('en-US');
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unique = (values: string[]) => [...new Set(values)];

function questionInPath(id: string, path: string): boolean {
  const normalizedId = text(id);
  if (!normalizedId) return false;
  // Only an explicit letter prefix permits numeric normalization. A plain "1"
  // must not claim every "1.png" in a user's unrelated directory.
  const numericId = /^([a-z]+)[\s_-]*(\d+)$/i.exec(normalizedId);
  if (numericId) {
    const digits = numericId[2].replace(/^0+(?=\d)/, '');
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(numericId[1])}[\\s_-]*0*${digits}(?=$|[^a-z0-9])`, 'i').test(path);
  }
  const parts = path.split('/').filter(Boolean);
  // Short or numeric custom identifiers only match a complete path component.
  if (/^\d+$/.test(normalizedId) || normalizedId.length < 3) {
    return parts.some(part => token(part) === token(normalizedId) || token(part.replace(/\.[^.]+$/, '')) === token(normalizedId));
  }
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(normalizedId)}(?=$|[^a-z0-9])`, 'i').test(path);
}

/**
 * Suggests assignments, without writing data or requiring a folder convention.
 * Conflicting signals remain unassigned for the import preview to resolve.
 * Each source file produces one row; the preview may duplicate it for shared refs.
 */
export function matchBulkImages(project: Project, files: BulkFileHint[], defaults: BulkImageDefaults = {}): BulkImageMatch[] {
  const defaultQuestion = project.questions.some(row => row.id === defaults.questionId) ? defaults.questionId! : null;
  const defaultProduct = project.products.some(row => row.id === defaults.productId) ? defaults.productId! : null;

  return files.map(file => {
    const path = text(file.path || file.name).replace(/\\/g, '/');
    const folders = path.split('/').filter(Boolean).slice(0, -1).map(token);
    const parts = new Set(folders);
    const filenameStem = text(file.name.replace(/\.[^.]+$/, ''));
    const numericIndex = defaults.numericOrder === true && /^0*[1-9]\d*$/.test(filenameStem) ? Number(filenameStem) : null;
    const pathQuestions = unique(project.questions.filter(row => {
      // In numeric-order mode, a bare numeric filename is an ordinal rather than
      // a custom numeric ID. Explicit numeric directory names still identify IDs.
      const searchPath = numericIndex !== null && /^\d+$/.test(row.id) ? path.slice(0, path.lastIndexOf('/') + 1) : path;
      return questionInPath(row.id, searchPath);
    }).map(row => row.id));
    const namedReferences = unique(project.questions.filter(row => row.referenceNames.some(name => text(name) === text(file.name))).map(row => row.id));
    const products = unique(project.products.filter(row => parts.has(token(row.id)) || (text(row.name) !== '' && parts.has(token(row.name)))).map(row => row.id));
    const refFolder = folders.some(folder => referenceFolders.has(folder));
    const outputFolder = folders.some(folder => outputFolders.has(folder));
    const reasons: string[] = [];

    let role: BulkImageRole | null = null;
    if (defaults.numericOrder === true && (defaults.role === 'reference' || defaults.role === 'output')) {
      role = defaults.role;
      reasons.push('使用本批指定用途');
    } else if (refFolder && outputFolder) {
      reasons.push('路径同时包含参考图和生成图目录，请选择用途');
    } else if (refFolder) {
      role = 'reference';
      reasons.push('参考图目录');
    } else if (outputFolder || products.length > 0) {
      role = 'output';
      reasons.push(outputFolder ? '生成图目录' : '产品目录');
    } else if (namedReferences.length > 0) {
      role = 'reference';
      reasons.push('文件名与题目参考图一致');
    } else if (defaults.role === 'reference' || defaults.role === 'output') {
      role = defaults.role;
      reasons.push('使用默认用途');
    } else {
      reasons.push('未识别用途');
    }

    let questionId: string | null = null;
    if (numericIndex !== null) {
      const orderedQuestion = Number.isSafeInteger(numericIndex) ? project.questions[numericIndex - 1] : undefined;
      if (!orderedQuestion) {
        reasons.push(`数字文件名 ${filenameStem} 超出题库范围（共 ${project.questions.length} 题），请手动选择`);
      } else if (pathQuestions.length > 1 || (pathQuestions.length === 1 && pathQuestions[0] !== orderedQuestion.id)
        || (role === 'reference' && namedReferences.length > 0 && !namedReferences.includes(orderedQuestion.id))) {
        reasons.push('数字文件名对应的题目与路径题号或参考图所属题目冲突，请手动选择');
      } else {
        questionId = orderedQuestion.id;
        reasons.push(`数字文件名按题库顺序匹配第 ${numericIndex} 题（${questionId}）`);
      }
    } else if (pathQuestions.length > 1) {
      reasons.push(`路径命中多个题目（${pathQuestions.join('、')}），请手动选择`);
    } else if (pathQuestions.length === 1) {
      if (role === 'reference' && namedReferences.length > 0 && !namedReferences.includes(pathQuestions[0])) {
        reasons.push('路径题号与参考图文件名所属题目冲突，请手动选择');
      } else {
        questionId = pathQuestions[0];
        reasons.push(`路径题号 ${questionId}`);
      }
    } else if (role === 'reference' && namedReferences.length === 1) {
      questionId = namedReferences[0];
      reasons.push(`参考图属于 ${questionId}`);
    } else if (role === 'reference' && namedReferences.length > 1) {
      reasons.push(`同名参考图用于多个题目（${namedReferences.join('、')}），请选择题目，可复制行共享图片`);
    } else if (defaultQuestion) {
      questionId = defaultQuestion;
      reasons.push('使用默认题目');
    } else {
      reasons.push('未识别题目');
    }

    let productId: string | null = null;
    if (role === 'output') {
      if (defaults.numericOrder === true && defaultProduct) {
        productId = defaultProduct;
        reasons.push('使用本批指定产品');
      } else if (products.length === 1) {
        productId = products[0];
        reasons.push(`产品 ${project.products.find(row => row.id === productId)?.name || productId}`);
      } else if (products.length > 1) {
        reasons.push('路径命中多个产品或产品名称重名，请手动选择');
      } else if (defaultProduct) {
        productId = defaultProduct;
        reasons.push('使用默认产品');
      } else {
        reasons.push('未识别产品');
      }
    }

    return { ...file, questionId, productId, role, reason: reasons.join('；') };
  });
}
