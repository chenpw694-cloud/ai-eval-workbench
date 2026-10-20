import type { Question } from './model.ts';

const rowLineNumbers = new WeakMap<string[][], number[]>();
const referenceAliases = ['ref_images', 'referenceImages', 'images'] as const;
const questionKeys = new Set([
  'id', 'title', 'scene', 'category', 'difficulty',
  'request', 'acceptance', 'referenceNames', 'fields', ...referenceAliases
]);
const mappingKeys = [
  'id', 'title', 'scene', 'category', 'difficulty',
  'request', 'acceptance', 'referenceNames'
] as const;

function fail(line: number, message: string): never {
  throw new Error(`第 ${line} 行：${message}`);
}

function validateHeaders(headers: string[], sourceLine = 1): string[] {
  if (!headers.length) fail(sourceLine, '缺少 CSV 表头。');
  const normalized = headers.map(header => header.trim());
  const seen = new Set<string>();
  normalized.forEach((header, index) => {
    if (!header) fail(sourceLine, `第 ${index + 1} 列的表头为空，请填写字段名称。`);
    if (seen.has(header)) fail(sourceLine, `表头“${header}”重复，请为每一列使用不同名称。`);
    seen.add(header);
  });
  return normalized;
}

/** Strict RFC-style CSV parser. Quoted fields may contain commas and newlines. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const source = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let rowStart = 1;
  let quoteStart = 1;

  function finishRow() {
    row.push(field);
    // Ignore physically empty rows and rows consisting only of whitespace.
    if (row.some(value => value.trim() !== '')) {
      records.push(row);
      lines.push(rowStart);
    }
    row = [];
    field = '';
    closedQuote = false;
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const isNewline = character === '\r' || character === '\n';

    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (isNewline) {
        if (character === '\r' && source[index + 1] === '\n') index += 1;
        field += '\n';
        line += 1;
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote && character !== ',' && !isNewline) {
      fail(line, '闭合引号后只能接逗号或换行，请检查引号和分隔符。');
    }
    if (character === '"') {
      if (field !== '') fail(line, '引号必须从单元格开头开始，单元格内的双引号请写成两个双引号。');
      quoted = true;
      quoteStart = line;
    } else if (character === ',') {
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (isNewline) {
      finishRow();
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      line += 1;
      rowStart = line;
    } else {
      field += character;
    }
  }

  if (quoted) fail(quoteStart, '单元格的双引号没有闭合。');
  if (field !== '' || row.length || closedQuote) finishRow();
  if (!records.length) fail(1, '文件为空，请先添加表头和题目。');

  const headers = validateHeaders(records[0], lines[0]);
  const rows = records.slice(1);
  const dataLines = lines.slice(1);
  rows.forEach((record, index) => {
    if (record.length !== headers.length) {
      fail(dataLines[index], `本行有 ${record.length} 列，表头有 ${headers.length} 列；包含逗号的内容须用双引号包围。`);
    }
  });
  rowLineNumbers.set(rows, dataLines);
  return { headers, rows };
}

function splitList(value: string): string[] {
  return value.split(/[;；\r\n]+/).map(item => item.trim()).filter(Boolean);
}

function requiredString(value: unknown, name: string, line: number): string {
  if (typeof value !== 'string' || !value.trim()) fail(line, `${name}不能为空，且必须是文本。`);
  return value.trim();
}

function optionalString(value: unknown, name: string, line: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(line, `${name}必须是文本。`);
  return value.trim();
}

function stringList(value: unknown, name: string, line: number, required = false): string[] {
  if (value === undefined || value === null) {
    if (required) fail(line, `${name}不能为空，请至少填写一项。`);
    return [];
  }
  const items = typeof value === 'string' ? splitList(value) : value;
  if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
    fail(line, `${name}须为文本数组，或以分号、换行分隔的文本。`);
  }
  const result = items.map(item => item.trim()).filter(Boolean);
  if (required && !result.length) fail(line, `${name}不能为空，请至少填写一项。`);
  return result;
}

function isReferenceSource(value: string): boolean {
  // These are source references, not files already uploaded to the workbench.
  return /^\/\//.test(value) || (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value));
}

function referenceList(value: unknown, name: string, line: number): { names: string[]; hasSource: boolean } {
  if (value === undefined || value === null || value === '') return { names: [], hasSource: false };
  const entries = typeof value === 'string'
    ? (isReferenceSource(value.trim()) ? [value.trim()] : splitList(value))
    : Array.isArray(value) ? value : [value];
  const names: string[] = [];
  let hasSource = false;
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (!text) continue;
      if (isReferenceSource(text)) hasSource = true;
      else {
        const filename = text.split(/[\\/]/).at(-1) || text;
        if (filename !== text) hasSource = true;
        names.push(filename);
      }
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(line, `${name}须为文件名/来源文本、文本数组，或含 name、filename、url 的图片引用对象。`);
    }
    const record = entry as Record<string, unknown>;
    const keys = ['filename', 'fileName', 'name', 'path', 'url', 'src', 'data', 'dataUrl'] as const;
    const present = keys.filter(key => typeof record[key] === 'string' && (record[key] as string).trim());
    if (!present.length) fail(line, `${name}中的图片对象请提供 name、filename 或 url 文本；图片二进制文件仍需单独上传。`);
    // Preserve the complete object in fields, including captions and source metadata.
    hasSource = true;
    if (present.some(key => ['url', 'src', 'data', 'dataUrl'].includes(key) || isReferenceSource((record[key] as string).trim()))) continue;
    const localName = (record[present[0]] as string).trim();
    names.push(localName.split(/[\\/]/).at(-1) || localName);
  }
  return { names, hasSource };
}

function retainReferenceSource(entries: [string, string][], key: string, value: unknown) {
  let fieldName = key;
  let index = 1;
  while (entries.some(([name]) => name === fieldName)) fieldName = `${key}（图片来源 ${index++}）`;
  entries.push([fieldName, typeof value === 'string' ? value : JSON.stringify(value)]);
}

function normalizeQuestion(input: unknown, line: number): Question {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(line, '每道题必须是一个 JSON 对象。');
  const value = input as Record<string, unknown>;
  const rawId = typeof value.id === 'number' && Number.isFinite(value.id) ? String(value.id) : value.id;
  const id = requiredString(rawId, '题号', line);
  const request = requiredString(value.request, '需求描述', line);
  const acceptance = stringList(value.acceptance, '验收要点', line, true);
  const fieldEntries: [string, string][] = [];

  if (value.fields !== undefined) {
    if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) {
      fail(line, '自定义字段 fields 必须是“字段名: 文本值”对象。');
    }
    Object.entries(value.fields as Record<string, unknown>).forEach(([key, item]) => {
      if (!key.trim()) fail(line, '自定义字段名称不能为空。');
      if (typeof item !== 'string') fail(line, `自定义字段“${key}”必须是文本。`);
      fieldEntries.push([key, item]);
    });
  }
  const referenceNames = referenceList(value.referenceNames, '参考图文件名', line);
  if (referenceNames.hasSource) retainReferenceSource(fieldEntries, 'referenceNames', value.referenceNames);
  for (const alias of referenceAliases) {
    if (value[alias] === undefined || value[alias] === null) continue;
    const references = referenceList(value[alias], alias, line);
    referenceNames.names.push(...references.names);
    // Keep the input rather than silently dropping structured image metadata.
    retainReferenceSource(fieldEntries, alias, value[alias]);
  }
  Object.entries(value).forEach(([key, item]) => {
    if (questionKeys.has(key)) return;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      if (!fieldEntries.some(([name]) => name === key)) fieldEntries.push([key, String(item)]);
    } else {
      fail(line, `额外字段“${key}”须为文本、数字或布尔值，复杂内容请先转为文本。`);
    }
  });

  return {
    id,
    title: optionalString(value.title, '题目标题', line) || `题目 ${id}`,
    scene: optionalString(value.scene, '场景', line),
    category: optionalString(value.category, '品类', line),
    difficulty: optionalString(value.difficulty, '难度', line),
    request,
    acceptance,
    referenceNames: [...new Set(referenceNames.names)],
    fields: Object.fromEntries(fieldEntries)
  };
}

function rejectDuplicateIds(questions: Question[], lines: number[]) {
  const seen = new Map<string, number>();
  questions.forEach((question, index) => {
    const previous = seen.get(question.id);
    if (previous !== undefined) fail(lines[index], `题号“${question.id}”重复，首次出现在第 ${previous} 行。整批题目尚未导入。`);
    seen.set(question.id, lines[index]);
  });
}

export function questionsFromRows(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>
): Question[] {
  const normalizedHeaders = validateHeaders(headers);
  const lineNumbers = rowLineNumbers.get(rows) ?? rows.map((_, index) => index + 2);
  const columns = new Map(normalizedHeaders.map((header, index) => [header, index]));
  const selectedColumns = new Set<string>();

  mappingKeys.forEach(key => {
    const source = mapping[key]?.trim();
    if (['id', 'request', 'acceptance'].includes(key) && !source) {
      const labels = { id: '题号', request: '需求描述', acceptance: '验收要点' };
      fail(1, `请先为“${labels[key as keyof typeof labels]}”选择来源列。`);
    }
    if (source && !columns.has(source)) fail(1, `映射列“${source}”不存在，请重新选择。`);
    if (source) selectedColumns.add(source);
  });

  const questions = rows.map((row, index) => {
    const line = lineNumbers[index];
    if (row.length !== normalizedHeaders.length) fail(line, `本行列数与表头不一致，应为 ${normalizedHeaders.length} 列。`);
    const input: Record<string, unknown> = {};
    mappingKeys.forEach(key => {
      const column = mapping[key]?.trim();
      input[key] = column ? row[columns.get(column)!] : undefined;
    });
    input.fields = Object.fromEntries(normalizedHeaders
      .map((header, column) => [header, row[column]] as const)
      .filter(([header]) => !selectedColumns.has(header)));
    return normalizeQuestion(input, line);
  });
  rejectDuplicateIds(questions, lineNumbers);
  return questions;
}

/** Locate the source lines of items in a valid, top-level JSON array. */
function jsonRecordLines(source: string): number[] {
  const result: number[] = [];
  let depth = 0;
  let line = 1;
  let inString = false;
  let escaped = false;
  let expectsItem = false;
  for (const character of source) {
    if (character === '\n') line += 1;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (expectsItem && !/\s/.test(character) && character !== ']' && character !== ',') {
      result.push(line);
      expectsItem = false;
    }
    if (character === '"') inString = true;
    else if (character === '[' || character === '{') {
      depth += 1;
      if (depth === 1 && character === '[') expectsItem = true;
    } else if (character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 1) expectsItem = true;
  }
  return result;
}

export function parseQuestionsJson(text: string): Question[] {
  const source = text.replace(/^\uFEFF/, '');
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const explicitLine = message.match(/line\s+(\d+)/i)?.[1];
    const position = message.match(/position\s+(\d+)/i)?.[1];
    const line = explicitLine ? Number(explicitLine) : position ? source.slice(0, Number(position)).split('\n').length : 1;
    fail(line, 'JSON 格式错误，请检查双引号、逗号和括号是否完整。');
  }
  if (!Array.isArray(input)) fail(1, 'JSON 顶层必须是题目数组，例如 [{"id":"Q-001","request":"需求","acceptance":["验收要点"]}]。');
  const lines = jsonRecordLines(source);
  const questions = input.map((item, index) => normalizeQuestion(item, lines[index] ?? index + 1));
  rejectDuplicateIds(questions, lines);
  return questions;
}
