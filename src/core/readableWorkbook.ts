import type { Workbook, Worksheet, CellValue } from 'exceljs';
import type { ProjectBundle, Question } from './model.ts';
import { latestEvaluations, validateEvaluation } from './assessment.ts';
import { buildReport } from './report.ts';
import type { ReportBasis } from './report.ts';
import { latestQuality } from './quality.ts';
import { recordDimensionScore } from './ratings.ts';
import { questionTable } from './officeQuestions.ts';

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
type Value = string | number | boolean | null;
const safeText = (value: Value): CellValue => {
  if (typeof value === 'string' && value.length > 32767) throw new Error('有文字超过 Excel 单元格的 32767 字限制，请缩短对应备注或使用 Word 报告。');
  return value === '' ? null : value;
};
function sheet(workbook: Workbook, name: string, headers: string[], rows: Value[][], widths: number[], intro?: string): Worksheet {
  const ws = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: intro ? 4 : 1, showGridLines: false }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  if (intro) {
    ws.mergeCells(1, 1, 1, headers.length); ws.getCell(1, 1).value = name; ws.getRow(1).height = 30;
    ws.getCell(1, 1).font = { name: '微软雅黑', size: 18, bold: true, color: { argb: 'FF332F49' } };
    ws.mergeCells(2, 1, 2, headers.length); ws.getCell(2, 1).value = intro; ws.getRow(2).height = 40;
    ws.getCell(2, 1).alignment = { wrapText: true, vertical: 'middle' };
    ws.getCell(2, 1).font = { name: '微软雅黑', size: 10, color: { argb: 'FF6F6A7E' } };
  }
  const headerRow = intro ? 4 : 1;
  ws.getRow(headerRow).values = headers;
  rows.forEach(row => ws.addRow(row.map(safeText)));
  ws.columns.forEach((column, index) => { column.width = widths[index] ?? 18; });
  ws.eachRow((row, index) => {
    if (intro && index < headerRow) return;
    const lines = Math.max(1, ...headers.map((_, column) => String(row.getCell(column + 1).value ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil([...line].reduce((count, char) => count + (/[^\x00-\x7F]/.test(char) ? 2 : 1), 0) / Math.max(8, (widths[column] ?? 18) - 2))), 0)));
    row.height = index === headerRow ? 30 : Math.min(360, Math.max(32, lines * 16 + 10));
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: '微软雅黑', size: 11, color: { argb: index === headerRow ? 'FFFFFFFF' : 'FF332F49' }, bold: index === headerRow };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index === headerRow ? 'FF6654C7' : (index - headerRow) % 2 ? 'FFF5F3FB' : 'FFFFFFFF' } };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE6E2F0' } } };
    });
  });
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + rows.length, column: headers.length } };
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
  return ws;
}
async function workbook() { const Excel = (await import('exceljs')).default; const wb = new Excel.Workbook(); wb.creator = 'Eval Studio'; wb.calcProperties.fullCalcOnLoad = true; return wb; }
async function bytes(wb: Workbook): Promise<Blob> { return new Blob([new Uint8Array(await wb.xlsx.writeBuffer())], { type: MIME }); }
export async function questionsWorkbook(questions: Question[]): Promise<Blob> {
  const wb = await workbook(), table = questionTable(questions);
  sheet(wb, '题库', table.headers, table.rows, [16, 24, 16, 14, 12, 60, 48, 28]);
  return bytes(wb);
}
export async function readableWorkbook(bundle: ProjectBundle, basis: ReportBasis = 'original', generatedAt = new Date().toISOString()): Promise<Blob> {
  const wb = await workbook(), report = buildReport(bundle, basis, generatedAt), p = bundle.project;
  const product = (id: string) => p.products.find(row => row.id === id)?.name ?? id;
  const member = (id: string) => p.members.find(row => row.id === id)?.name ?? id;
  const summary = sheet(wb, '结果汇总', ['产品', '版本或档位', '负责人', '性质', '已提交', '应评', '总分', '可用率', '平均耗时 秒', '可用图成本', '状态'], report.results.map(row => {
    const item = p.products.find(item => item.id === row.productId)!;
    return [item.name, item.version, member(item.ownerId), item.demo ? '模拟' : '真实', row.submitted, row.expected, row.total, row.usableRate, row.meanSeconds, row.costPerUsable, row.total === null ? '数据未齐' : ({eligible:'可参与推荐', vetoed:'一票否决',pending:'待检查',simulated:'模拟'})[row.eligibility]];
  }), [24, 24, 18, 12, 12, 12, 14, 14, 18, 18, 20], `${p.name}；${generatedAt}；${basis === 'original' ? '原始初评' : '裁决口径参考分'}。本表是评分结果快照，总分采用 1–5 分；修改 Excel 不会自动回写工作台。完整数据交接请导入整个 ZIP。`);
  summary.getColumn(7).numFmt = '0.00'; summary.getColumn(8).numFmt = '0.0%'; summary.getColumn(9).numFmt = '0.0'; summary.getColumn(10).numFmt = '0.000';
  const dims = sheet(wb, '维度得分', ['产品', '维度', '权重', '得分', '已计入样本', '应计入样本', '是否完整'], report.results.flatMap(row => p.scheme.dimensions.map(dim => { const score = row.dimensions[dim.id as keyof typeof row.dimensions]; return [product(row.productId), `${dim.id} ${dim.name}`, dim.weight / 100, score?.value ?? null, score?.n ?? 0, score?.expected ?? 0, score?.complete ? '是' : '否']; })), [24, 34, 12, 12, 18, 18, 14]);
  dims.getColumn(3).numFmt = '0.0%'; dims.getColumn(4).numFmt = '0.00';
  const source = basis === 'adjudicated-reference' ? (await import('./quality.ts')).finalQualityBundle(bundle) : bundle;
  const heads = latestEvaluations(source.evaluations);
  sheet(wb, '逐题评分', ['题号', '题目', '产品', '版本', '评测员', '记录状态', 'A 分', 'B 分', 'C 分', 'F 分', 'G 分', '耗时 秒', '生成失败', '总张数', '可用张数', '最佳图文件名', '问题标签', '备注', '记录 ID'], heads.map(row => {
    const valid = row.status === 'submitted' && !validateEvaluation(p, row, bundle.assets).length;
    return [row.questionId, p.questions.find(q => q.id === row.questionId)?.title ?? '', product(row.productId), p.products.find(item => item.id === row.productId)?.version ?? '', member(row.reviewerId), valid ? '已提交' : row.status === 'draft' ? '草稿，不计入汇总' : '提交无效，需检查', ...['A','B','C','F','G'].map(dim => valid ? recordDimensionScore(p.scheme, row, dim) : row.ratings?.[dim]?.score ?? null), row.seconds, row.failed ? '是' : '否', row.mediaIds.length, row.mediaChecks.filter(check => check.usable === true).length, bundle.assets.find(asset => asset.id === row.bestMediaId)?.name ?? '', row.tags.map(tag => `${tag.code} ${p.scheme.tags.find(def => def.code === tag.code)?.name ?? ''} ${tag.severity}`).join('\n'), row.notes, row.id];
  }), [18, 28, 24, 20, 18, 26, 10, 10, 10, 10, 10, 14, 14, 12, 14, 28, 42, 48, 28]);
  const judgments = latestQuality(bundle.quality?.judgments ?? [], row => row.taskId), cases = new Set(report.comparison?.cases.map(row => row.taskId));
  sheet(wb, 'GSB对比', ['题号', '自家产品', '对比竞品', '评测员', '判断', '状态', '判断依据', '自家最佳图', '竞品最佳图', '任务 ID'], (bundle.quality?.tasks ?? []).filter(task => task.kind === 'gsb').map(task => {
    const judgment = judgments.find(row => row.taskId === task.id);
    return [task.questionId, product(task.evidence[0]?.productId), product(task.evidence[1]?.productId), member(task.reviewerId), !judgment ? '' : judgment.unable ? '无法判断' : ({win:'G 自家更好', tie:'S 两者相当', loss:'B 竞品更好'})[judgment.choice!] ?? '', !judgment ? '待判断' : judgment.unable ? '不计入分母' : bundle.quality?.space ? '独立判断，待合入' : cases.has(task.id) ? '有效判断' : '证据已更新，待核对', judgment?.notes ?? '', bundle.assets.find(asset => asset.id === task.evidence[0]?.bestMediaId)?.name ?? '', bundle.assets.find(asset => asset.id === task.evidence[1]?.bestMediaId)?.name ?? '', task.id];
  }), [18, 24, 24, 18, 22, 28, 48, 28, 28, 28]);
  sheet(wb, '高频问题', ['产品', '问题编码', '问题名称', '题数'], report.highFrequency.flatMap(row => row.tags.map(tag => [product(row.productId), tag.code, tag.name, tag.count])), [24, 16, 40, 12]);
  sheet(wb, '交付检查', ['检查项', '状态', '说明'], report.checks.map(check => [check.title, check.passed ? '通过' : '待处理', check.detail]), [36, 16, 100]);
  const questions = questionTable(p.questions); sheet(wb, '题库', questions.headers, questions.rows, [18, 26, 16, 14, 12, 60, 48, 28]);
  return bytes(wb);
}
