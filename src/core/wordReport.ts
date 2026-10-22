import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, PageNumber, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { Asset, ProjectBundle, Question } from './model.ts';
import { buildReport } from './report.ts';
import type { ReportBasis } from './report.ts';
import { questionTable } from './officeQuestions.ts';
import { hashBlob } from './packages.ts';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const clean = (value: unknown) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const text = (value: unknown, bold = false) => new TextRun({ text: clean(value), bold, font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Hiragino Sans GB', cs: 'Arial' }, size: 21 });
const p = (value: unknown, options: { heading?: typeof HeadingLevel[keyof typeof HeadingLevel]; pageBreakBefore?: boolean } = {}) => new Paragraph({ children: clean(value).split(/\r?\n/).flatMap((line, i) => [new TextRun({ text: line, ...(i ? { break: 1 } : {}) })]), spacing: { after: 140, line: 330 }, ...options });
const heading = (value: string, pageBreakBefore = false) => p(value, { heading: HeadingLevel.HEADING_1, pageBreakBefore });
const pct = (value: number | null) => value === null ? '待补齐' : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null, digits = 2) => value === null ? '待补齐' : value.toFixed(digits);
const borders = { top: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9E8' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9E8' }, left: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9E8' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9E8' } };
function table(headers: string[], rows: unknown[][], widths: number[], width = 9360) {
  return new Table({ width: { size: width, type: WidthType.DXA }, columnWidths: widths, rows: [headers, ...rows].map((row, index) => new TableRow({ tableHeader: index === 0, cantSplit: true, children: row.map((value, column) => new TableCell({ width: { size: widths[column] ?? 1200, type: WidthType.DXA }, margins: { top: 100, bottom: 100, left: 100, right: 100 }, borders, shading: { fill: index === 0 ? 'EEEAF8' : index % 2 ? 'FFFFFF' : 'F8F7FB' }, children: [new Paragraph({ children: [text(value, index === 0)], spacing: { after: 30, line: 280 } })] })) })) });
}
function document(children: (Paragraph | Table)[], landscape = false): Document {
  return new Document({ creator: 'Eval Studio', title: 'AI 产品评测报告', styles: {
    default: { document: { run: { font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Hiragino Sans GB', cs: 'Arial' }, size: 22, color: '222222' }, paragraph: { spacing: { after: 140, line: 330 } } } },
    paragraphStyles: [
      { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Hiragino Sans GB', cs: 'Arial' }, size: 40, bold: true, color: '000000' }, paragraph: { spacing: { before: 120, after: 220 } } },
      { id: 'Heading1', name: 'heading 1', basedOn: 'Normal', next: 'Normal', run: { font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Hiragino Sans GB', cs: 'Arial' }, size: 28, bold: true, color: '000000' }, paragraph: { keepNext: true, spacing: { before: 280, after: 140 } } }
    ]
  }, sections: [{ properties: { page: { size: { width: landscape ? 16838 : 11906, height: landscape ? 11906 : 16838 }, margin: { top: 1000, bottom: 1000, left: landscape ? 900 : 1273, right: landscape ? 900 : 1273 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Eval Studio   ', size: 18, color: '888888' }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '888888' })] })] }) }, children }] });
}
async function blob(doc: Document): Promise<Blob> { return new Blob([await Packer.toBlob(doc)], { type: MIME }); }
export async function questionsWord(questions: Question[]): Promise<Blob> {
  const data = questionTable(questions);
  // Word's template keeps the standard columns; extra fields remain in Excel/JSON exports.
  const children: (Paragraph | Table)[] = [p('评测题库', { heading: HeadingLevel.TITLE }), p('每行填写一道题，第一行保留列名。题号、需求描述、验收要点为必填；验收要点和参考图文件名可用分号或单元格内换行分隔。参考图请在工作台单独上传或批量关联。'), p('Word 题库保留八个标准字段；需要保留自定义字段时，请使用 Excel 或 JSON 导出。'), table(data.headers.slice(0, 8), data.rows.length ? data.rows.map(row => row.slice(0, 8)) : [Array(8).fill('')], [1100, 1700, 1300, 1000, 900, 4000, 2900, 1900], 14800)];
  return blob(document(children, true));
}
async function imageRun(asset: Asset): Promise<ImageRun> {
  if (asset.size > 12 * 1024 * 1024) throw new Error('原图超过 12 MB，请从原图备份查看');
  let bytes = new Uint8Array(await asset.blob.arrayBuffer()), type: 'png' | 'jpg' | 'gif';
  let width = 0, height = 0;
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(asset.blob); width = bitmap.width; height = bitmap.height;
    if (asset.mime === 'image/webp') {
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
      if (!context) { bitmap.close(); throw new Error('浏览器无法转换此图片'); }
      context.drawImage(bitmap, 0, 0); bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    }
    bitmap.close();
  } else if (asset.mime === 'image/png') { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); width = view.getUint32(16); height = view.getUint32(20); }
  else if (asset.mime === 'image/gif') { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); width = view.getUint16(6, true); height = view.getUint16(8, true); }
  else throw new Error('此环境无法读取图片尺寸');
  if (!width || !height) throw new Error('图片尺寸无效');
  type = asset.mime === 'image/jpeg' ? 'jpg' : asset.mime === 'image/gif' ? 'gif' : 'png';
  const ratio = Math.min(280 / width, 195 / height);
  return new ImageRun({ type, data: bytes, transformation: { width: Math.round(width * ratio), height: Math.round(height * ratio) }, altText: { title: asset.name, description: '固定的评测最佳图', name: asset.name } });
}
export async function reportWord(bundle: ProjectBundle, basis: ReportBasis, loader: (id: string) => Promise<Asset | undefined>, generatedAt = new Date().toISOString()): Promise<Blob> {
  const report = buildReport(bundle, basis, generatedAt), notes = report.notes, project = bundle.project;
  const product = (id: string) => project.products.find(row => row.id === id)?.name ?? id;
  const children: (Paragraph | Table)[] = [
    p(`${project.name}评测报告`, { heading: HeadingLevel.TITLE }),
    p(`报告草稿   ${new Date(generatedAt).toLocaleDateString('zh-CN')}   ${basis === 'original' ? '原始初评' : '裁决口径参考分'}`),
    p(notes?.summary || `当前记录了 ${report.results.reduce((n, row) => n + row.submitted, 0)} 份有效初评和 ${report.quality.gsb.reduce((n, row) => n + row.n, 0)} 次有效 GSB。人工结论尚未填写，以下保留已完成数据与当前缺口。`),
    heading('评测概况'), p(project.background || '评测背景尚未填写'), p(`评测周期：${project.period || '待填写'}。共 ${project.questions.length} 道题，${project.products.length} 个产品，${project.members.length} 位成员。各竞品分别与共同的自家结果比较。`),
    p(`评分采用 1 至 5 分。维度权重：${project.scheme.dimensions.map(row => `${row.id} ${row.name} ${row.weight}%`).join('；')}。未完成项保持为空，模拟数据单独标明。`),
    heading('产品表现'), table(['产品', '总分 / 5', '可用率', '平均耗时 秒', '可用图成本'], report.results.map(row => [product(row.productId) + (project.products.find(item => item.id === row.productId)?.demo ? '（模拟）' : ''), num(row.total), pct(row.usableRate), num(row.meanSeconds, 1), num(row.costPerUsable, 3)]), [2640, 1440, 1440, 1920, 1920]),
    p('总分仅在所需维度齐全时计算。单个维度的已有分数可以作为参考，不代表完整总分。'),
    table(['产品', ...project.scheme.dimensions.map(row => row.id)], report.results.map(row => [product(row.productId), ...project.scheme.dimensions.map(dim => { const value = row.dimensions[dim.id as keyof typeof row.dimensions]; return `${num(value?.value ?? null)}${value?.complete ? '' : ' 待齐'}`; })]), [2640, ...project.scheme.dimensions.map(() => 960)]),
    heading('自家对比结果'), p('以自家产品为基准，G 为自家更好，S 为两者相当，B 为竞品更好。净胜率为胜数减负数后除以有效比较数，平局计入分母。'),
    table(['对比竞品', '有效与应评', '自家胜 平 负', '净胜率', '数据性质'], report.quality.gsb.map(row => [product(row.productId), `${row.n} / ${row.expected}`, `${row.wins} / ${row.ties} / ${row.losses}`, pct(row.net), row.demo ? '含模拟数据' : '真实对象']), [2640, 1560, 2040, 1440, 1680]),
    p(notes?.consistencyExplanation || '尚未填写 GSB 与维度分的关系说明。'),
    heading('优势与改进建议'), p(notes?.productInsights || '各产品的优势与短板尚待人工分析。'), p(notes?.recommendations || '对自家产品的改进建议尚待填写。'),
    heading('功能与授权'), p(notes?.featureComparison || '功能与授权依据尚待补齐。'),
    heading('高频问题'), ...report.highFrequency.map(row => p(`${product(row.productId)}：${row.tags.slice(0, 5).map(tag => `${tag.name} ${tag.count} 题`).join('；') || '有效提交中未记录问题标签'}。`))
  ];
  let imageBytes = 0;
  for (const questionId of notes?.caseQuestionIds ?? []) {
    const question = project.questions.find(row => row.id === questionId), cases = report.comparison?.cases.filter(row => row.questionId === questionId) ?? [];
    children.push(heading(`典型案例 ${question?.title ?? questionId}`, true), p(`题号：${questionId}`), p(question?.request ?? ''), p(`验收要点：${question?.acceptance.join('；') ?? ''}`));
    for (const row of cases) children.push(p(`${product(row.evidence[0].productId)}与${product(row.competitorId)}：${row.choice === 'win' ? 'G 自家更好' : row.choice === 'tie' ? 'S 两者相当' : 'B 竞品更好'}${row.demo ? '（含模拟数据）' : ''}${row.notes.trim() ? `。${row.notes}` : ''}`));
    if (!cases.length) children.push(p('本案例尚无当前有效的 GSB 判断或证据已更新，请在工作台核对。'));
    const evidence = [...new Map(cases.flatMap(row => row.evidence).map(row => [row.productId, row])).values()];
    const cells: TableCell[] = [];
    for (const item of evidence) {
      const metadata = bundle.assets.find(row => row.id === item.bestMediaId);
      const paragraphs = [new Paragraph({ children: [text(product(item.productId), true)], spacing: { after: 100 } })];
      try {
        const asset = await loader(item.bestMediaId);
        if (!metadata || !asset || asset.sha256 !== item.sha256 || await hashBlob(asset.blob) !== item.sha256) throw new Error('原图缺失或校验不符');
        imageBytes += asset.size; if (imageBytes > 60 * 1024 * 1024) throw new Error('报告内图片已超过 60 MB，请从原图备份查看');
        paragraphs.push(new Paragraph({ children: [await imageRun(asset)], spacing: { after: 100 } }));
      } catch (error) { paragraphs.push(p(`图片未嵌入：${error instanceof Error ? error.message : '读取失败'}。`)); }
      paragraphs.push(p(metadata?.name ?? item.bestMediaId));
      cells.push(new TableCell({ width: { size: 4680, type: WidthType.DXA }, margins: { top: 120, bottom: 120, left: 120, right: 120 }, children: paragraphs, borders }));
    }
    if (cells.length) { const rows: TableRow[] = []; for (let i = 0; i < cells.length; i += 2) rows.push(new TableRow({ cantSplit: true, children: [cells[i], cells[i + 1] ?? new TableCell({ children: [p('')] })] })); children.push(new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [4680, 4680], rows })); }
  }
  children.push(heading('质量与数据缺口', true), p(`${report.checks.filter(row => row.passed).length} / ${report.checks.length} 项检查通过。本 Word 为可编辑报告草稿，不代替完整项目备份。`));
  for (const check of report.checks.filter(row => !row.passed)) children.push(p(`${check.title}：${check.id === 'media' ? '本报告仅嵌入所选典型案例图。完整原图、评分与修改历史请另保存团队交接 ZIP；固定版本请在版本归档中留存。' : check.detail}`));
  children.push(heading('局限与备注'), p(notes?.limitations || '尚待补充样本、版本、人员与随机性的影响。'), p(notes?.noteResolution || '当前没有已保存的备注处理说明。'), p(`参与人：${notes?.participants.map(id => project.members.find(member => member.id === id)?.name ?? id).join('、') || '尚未确认'}`));
  return blob(document(children));
}
