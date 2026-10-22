import type { Question } from './model.ts';
import { parseCsv } from './questions.ts';
import { inspectOffice } from './officeContainer.ts';

export type QuestionTable = { name: string; headers: string[]; rows: string[][] };
export const questionHeaders = ['题号', '题目标题', '场景', '品类', '难度', '需求描述', '验收要点', '参考图文件名'];
export function questionTable(questions: Question[]): { headers: string[]; rows: string[][] } {
  const extra = [...new Set(questions.flatMap(question => Object.keys(question.fields)))];
  const headers = [...questionHeaders, ...extra.map(key => questionHeaders.includes(key) ? `自定义字段：${key}` : key)];
  return { headers, rows: questions.map(question => [question.id, question.title, question.scene, question.category, question.difficulty, question.request, question.acceptance.join('\n'), question.referenceNames.join('\n'), ...extra.map(key => question.fields[key] ?? '')]) };
}
export function tableCsv(headers: string[], rows: string[][]): string {
  return '\uFEFF' + [headers, ...rows].map(row => row.map(value => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
function normalizedTable(name: string, input: string[][]): QuestionTable | null {
  const rows = input.filter(row => row.some(cell => cell.trim()));
  if (!rows.length) return null;
  const headerIndex = rows.slice(0, 30).findIndex(row => row.some(cell => /^(题号|id|questionId|题目编号)$/i.test(cell.trim())) && row.some(cell => /^(需求描述|需求|request|prompt|提示词)$/i.test(cell.trim())));
  const start = headerIndex >= 0 ? headerIndex : 0;
  const headers = rows[start];
  while (headers.length && !headers.at(-1)?.trim()) headers.pop();
  const body = rows.slice(start + 1).map((row, index) => {
    if (row.slice(headers.length).some(cell => cell.trim())) throw new Error(`${name} 第 ${start + index + 2} 行有无表头的内容，请补齐列名。`);
    return headers.map((_, column) => row[column] ?? '');
  });
  const parsed = parseCsv(tableCsv(headers, body));
  return { name, ...parsed };
}
function excelText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>;
    if ('formula' in cell || 'sharedFormula' in cell) throw new Error('题库包含公式。请在 Excel 中复制并“粘贴为值”，避免导入过期的公式结果。');
    if (Array.isArray(cell.richText)) return cell.richText.map(part => String(part.text ?? '')).join('');
    if ('text' in cell) return String(cell.text);
  }
  throw new Error('题库包含无法识别的单元格，请将错误值或特殊对象转成文字。');
}
export async function readExcelQuestions(file: Blob): Promise<QuestionTable[]> {
  const bytes = new Uint8Array(await file.arrayBuffer()); inspectOffice(bytes, 'xl/workbook.xml');
  const Excel = (await import('exceljs')).default;
  const workbook = new Excel.Workbook(); await workbook.xlsx.load(bytes as never);
  const tables: QuestionTable[] = [];
  const visible = workbook.worksheets.filter(sheet => sheet.state === 'visible');
  const named = visible.filter(sheet => /^(题库|评测题库)$/.test(sheet.name));
  for (const sheet of named.length ? named : visible) {
    if (sheet.rowCount > 5002 || sheet.columnCount > 100) throw new Error(`${sheet.name} 超过 5000 行或 100 列，请只保留题库后再导入。`);
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, row => rows.push(Array.from({ length: sheet.columnCount }, (_, i) => excelText(row.getCell(i + 1).value))));
    const table = normalizedTable(sheet.name, rows); if (table) tables.push(table);
  }
  if (!tables.length) throw new Error('Excel 没有可读取的工作表，请使用题库模板填写题目。');
  return tables;
}
type XmlNode = Record<string, unknown>;
function descendants(nodes: XmlNode[], tag: string): XmlNode[][] {
  return nodes.flatMap(node => Object.entries(node).flatMap(([name, value]) => Array.isArray(value) ? [...(name === tag ? [value as XmlNode[]] : []), ...descendants(value as XmlNode[], tag)] : []));
}
function wordText(nodes: XmlNode[]): string {
  return nodes.map(node => Object.entries(node).map(([name, value]) => name === '#text' ? String(value) : name === 'w:br' || name === 'w:cr' ? '\n' : name === 'w:tab' ? '\t' : Array.isArray(value) ? wordText(value as XmlNode[]) : '').join('')).join('');
}
export async function readWordQuestions(file: Blob): Promise<QuestionTable[]> {
  const entries = inspectOffice(new Uint8Array(await file.arrayBuffer()), 'word/document.xml', ['word/document.xml']);
  const xml = new TextDecoder().decode(entries['word/document.xml']);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Word 包含不支持的 XML 声明，请另存为普通 .docx 后重试。');
  const { XMLParser, XMLValidator } = await import('fast-xml-parser');
  if (XMLValidator.validate(xml) !== true) throw new Error('Word 文档内容损坏，无法读取题库。');
  const nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: true, trimValues: false, parseTagValue: false }).parse(xml) as XmlNode[];
  const tables = descendants(nodes, 'w:tbl').map((table, index) => {
    const rows = table.filter(node => node['w:tr']).map(node => (node['w:tr'] as XmlNode[]).filter(child => child['w:tc']).map(child => descendants(child['w:tc'] as XmlNode[], 'w:p').map(wordText).join('\n').trim()));
    if (rows.length > 5002 || rows.some(row => row.length > 100)) throw new Error('Word 题目表格过大，请按批次导入。');
    return normalizedTable(`表格 ${index + 1}`, rows);
  }).filter((table): table is QuestionTable => !!table);
  if (!tables.length) throw new Error('Word 中未找到题目表格。请下载 Word 题库模板，每行填写一道题；自由排版的段落暂不能直接导入。');
  return tables;
}
export function preferredQuestionTable(tables: QuestionTable[]): number {
  const named = tables.findIndex(table => /^(题库|评测题库)$/.test(table.name)); if (named >= 0) return named;
  const matching = tables.findIndex(table => table.headers.some(header => /^(需求描述|需求|提示词|request|prompt)$/i.test(header)) && table.headers.some(header => /^(题号|题目编号|id|questionId)$/i.test(header)));
  return matching >= 0 ? matching : 0;
}
