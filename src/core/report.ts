import { isAnchorMode, recordDimensionScore } from './ratings.ts';
import type { RatingValidationOptions } from './ratings.ts';
import type { DimensionId, ProjectBundle } from './model.ts';
import { latestEvaluations, summarizeProject, validateEvaluation, validateProject } from './assessment.ts';
import { judgmentDisagreement, finalQualityBundle, latestQuality, qualitySummary, validateQuality } from './quality.ts';
import { jointSummary, latestRankings } from './joint.ts';
import { latestReportNotes } from './report-notes.ts';

export type ReportBasis = 'original' | 'adjudicated-reference';
/** Frozen archives bind both validation policy and text; ordinary exports use the current version. */
export type ReportVersion = 'report-v1' | 'report-v2';
export type ReportCheck = { id: string; title: string; passed: boolean; detail: string };
const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null, digits = 2) => value === null ? '—' : value.toFixed(digits);
export function buildReport(bundle: ProjectBundle, basis: ReportBasis, generatedAt: string, demo = false, options: RatingValidationOptions = {}) {
  const state = bundle.quality;
  const notes = latestReportNotes(state?.reportNotes);
  const source = basis === 'adjudicated-reference' ? finalQualityBundle(bundle) : bundle;
  const results = summarizeProject(source, options);
  const real = bundle.project.products.filter(p => !p.demo);
  const quality = qualitySummary(bundle, options), joint = jointSummary(bundle);
  const heads = latestEvaluations(bundle.evaluations);
  const originalHeads = heads.filter(row => row.status === 'submitted' && row.notes.trim());
  const checks: ReportCheck[] = [];
  const add = (id: string, title: string, passed: boolean, detail: string) => checks.push({ id, title, passed, detail });
  const projectErrors = validateProject(bundle.project);
  add('project', '项目与规则', !projectErrors.length, projectErrors.join('；') || `规则 ${bundle.project.scheme.version} · ${bundle.project.questions.length} 道共用题`);
  for (const product of real) {
    const result = results.find(r => r.productId === product.id)!;
    add(`product-${product.id}`, `${product.name} 的初评与产品级信息`, result.total !== null && result.submitted === result.expected && product.commercialUse !== 'unreviewed' && !!product.commercialEvidence.trim(), result.total === null || result.missing.length ? `${result.submitted}/${result.expected} 题；${result.missing.slice(0, 4).join('；')}` : `${result.submitted}/${result.expected} 题；七维度、走查、费用与授权依据齐全${result.vetoReasons.length ? '；已标注否决，不进入推荐排名' : ''}`);
  }
  const tasks = state?.tasks ?? [], judgments = latestQuality(state?.judgments ?? [], r => r.taskId);
  const calib = tasks.filter(t => t.kind === 'calibration');
  const validJudgment = (taskId: string) => judgments.some(r => r.taskId === taskId && !r.unable);
  const anchors = new Set((state?.decisions ?? []).flatMap(d => {
    const task = calib.find(t => t.id === d.taskId);
    return task && judgments.some(j => j.id === d.judgmentId && !j.unable) ? [`${task.questionId}:${task.evidence[0]?.productId}`] : [];
  }));
  const calibrationComplete = !!state?.batches.some(batch => batch.kind === 'calibration' && !batch.trial && batch.sampled.length === 5 && batch.sampled.every(questionId => real.every(product => anchors.has(`${questionId}:${product.id}`) && bundle.project.members.every(member => {
    const assigned = calib.filter(t => t.batchId === batch.id && t.questionId === questionId && t.evidence[0]?.productId === product.id && t.reviewerId === member.id);
    return assigned.length === 1 && validJudgment(assigned[0].id);
  }))));
  add('calibration', '共同校准与判断锚点', calibrationComplete, `${calib.filter(t => validJudgment(t.id)).length}/${calib.length} 份有效校准；${anchors.size} 个题目×产品锚点，正式要求 ${real.length * 5}`);
  const reviewsComplete = real.every(product => quality.reviews.some(r => r.kind === 'review' && r.productId === product.id && !r.trial && r.expected === 10 && r.completed === 10));
  add('reviews', '交叉复评与分歧裁决', reviewsComplete && !quality.unresolved.length, `${quality.reviews.filter(r => r.kind === 'review').reduce((s, r) => s + r.completed, 0)} 份有效复评；${quality.unresolved.length} 项分歧待裁决`);
  const decisions = latestQuality(state?.decisions ?? [], row => row.taskId);
  const missingFinals = tasks.filter(task => ['review','recheck'].includes(task.kind)).filter(task => {
    const judgment = judgments.find(row => row.taskId === task.id), original = bundle.evaluations.find(row => row.id === task.evidence[0]?.baselineId);
    if (!judgment || judgment.unable || !original || !judgmentDisagreement(original, judgment, bundle, options)) return false;
    const decision = decisions.find(row => row.taskId === task.id && row.judgmentId === judgment.id);
    return !decision || !state?.finals?.some(ref => ref.baselineId === original.id && ref.decisionId === decision.id);
  });
  add('final-references', '分歧裁决已关联最终引用', !missingFinals.length, `${missingFinals.length} 项分歧尚未引用对应最新独立判断的裁决；仅有讨论记录不足以完成检查`);
  const triggered = quality.reviews.filter(r => r.trigger);
  add('recheck', '触发后的全量复查', triggered.every(row => quality.reviews.some(r => r.kind === 'recheck' && r.productId === row.productId && state?.batches.find(b => b.id === r.batchId)?.sourceBatchId === row.batchId && r.completed === bundle.project.questions.length && r.expected === bundle.project.questions.length)) && !quality.unresolved.some(t => t.kind === 'recheck'), triggered.length ? `${triggered.length} 个产品触发全量复查，必须完成全部有效判断与分歧处理` : '没有正式 4/10 不一致触发项');
  const staleTasks = tasks.filter(t => ['review','recheck','gsb'].includes(t.kind) && t.evidence.some(e => heads.find(r => r.productId === e.productId && r.questionId === t.questionId)?.id !== e.baselineId));
  add('baseline', '质检证据仍对应当前初评', !staleTasks.length && !joint.stale, `${staleTasks.length} 份质检、${joint.stale ? '部分联合样本' : '0 份联合样本'}的初评引用已更新；历史判断不会自动迁移`);
  add('joint', '联合排名与场景配额', !!state?.joint && !state.joint.plan.trial && joint.completed === joint.expected && joint.expected > 0 && !joint.stale, `${joint.completed}/${joint.expected} 题有效排名；${joint.unable} 题无法判断${state?.joint?.plan.trial ? '；当前为试跑样本' : ''}`);
  const self = bundle.project.products.filter(p => p.role === 'self');
  const expectedGSB = self.length === 1 ? bundle.project.products.filter(p => p.id !== self[0].id).length * bundle.project.questions.length : 0;
  const gsbComplete = self.length === 1 && quality.gsb.length === bundle.project.products.length - 1 && quality.gsb.every(r => r.expected === bundle.project.questions.length && r.n === r.expected);
  add('gsb', '当前范围内的逐题 GSB', self.length === 0 || gsbComplete, self.length === 0 ? '未配置自家产品；本报告范围为真实竞品，未完成原四产品 GSB 方案' : `${quality.gsb.reduce((s,r) => s + r.n, 0)}/${expectedGSB} 个有效比较；模拟比较单列`);
  const unacknowledged = originalHeads.filter(r => !notes?.acknowledgedNoteIds.includes(r.id));
  add('notes', '初评备注已审阅', unacknowledged.length === 0 && (!originalHeads.length || !!notes?.noteResolution.trim()), `${originalHeads.length} 条带备注的最新初评，${unacknowledged.length} 条待确认；新修订需重新确认`);
  const authored = !!notes && ['summary','productInsights','recommendations','consistencyExplanation','featureComparison','limitations'].every(key => !!notes[key as keyof typeof notes]?.toString().trim()) && bundle.project.members.every(m => notes.participants.includes(m.id));
  add('conclusions', '人工结论与功能检查', authored, '填写结论、场景优势与短板、产品启示、联合与维度得分的差异解释、功能检查、局限，并确认全体参与人');
  const caseIds = notes?.caseQuestionIds ?? [];
  const ranks = latestRankings(state?.joint?.rankings ?? []);
  add('cases', '典型案例', caseIds.length >= 3 && caseIds.length <= 5 && caseIds.every(id => ranks.some(row => row.questionId === id && !row.unable)), `${caseIds.length} 组案例；正式报告从已完成联合排名中选择 3–5 组`);
  const structural = validateQuality(state, bundle, options);
  add('structure', '修订与引用完整性', !structural.length, structural.join('；') || '联合排名、独立判断及报告草稿修订链未发现分叉');
  add('media', '原图备份', false, '本报告不包含原图字节；请另导出并保存“汇总主包”的清单与全部 ZIP。导出主包时逐图校验 SHA-256，本页不将元数据视为原图备份成功。');
  const valid = latestEvaluations(source.evaluations).filter(r => r.status === 'submitted' && r.schemeHash === source.project.schemeHash && r.questionsHash === source.project.questionsHash && !validateEvaluation(source.project, r, source.assets, options).length);
  const groups = (field: 'scene' | 'category' | 'difficulty') => [...new Set(bundle.project.questions.map(q => q[field]))].map(value => ({ value, products: real.map(product => {
    const expected = bundle.project.questions.filter(q => q[field] === value).length;
    const rows = valid.filter(r => r.productId === product.id && bundle.project.questions.find(q => q.id === r.questionId)?.[field] === value);
    const dimensions = Object.fromEntries(['A','B','C','F'].map(dim => {
      const scores = rows.flatMap(r => r.failed && !r.mediaIds.length ? bundle.project.scheme.policies.failedNoOutput === 'score-one' ? [1] : [] : [recordDimensionScore(bundle.project.scheme, r, dim, options)!]);
      return [dim, { value: scores.length ? scores.reduce((a,b) => a+b,0)/scores.length : null, n: scores.length }];
    }));
    return { productId: product.id, expected, submitted: rows.length, dimensions };
  }) }));
  const highFrequency = real.map(product => ({ productId: product.id, tags: bundle.project.scheme.tags.map(tag => ({ code: tag.code, name: tag.name, count: valid.filter(r => r.productId === product.id && r.tags.some(t => t.code === tag.code)).length })).filter(tag => tag.count).sort((a,b) => b.count-a.count || a.code.localeCompare(b.code)) }));
  const recommendation = results.filter(r => real.some(p => p.id === r.productId) && r.eligibility === 'eligible' && r.total !== null).sort((a,b) => b.total! - a.total!);
  const rankingDiscrepancies = joint.pairs.filter(pair => {
    const a = results.find(r => r.productId === pair.left), b = results.find(r => r.productId === pair.right);
    return a?.total !== null && a?.total !== undefined && b?.total !== null && b?.total !== undefined && pair.net !== null && (a.total - b.total) * pair.net < 0;
  });
  return {
    format: 'eval-studio-report-draft', schemaVersion: 1, status: 'draft' as const, demo,
    generatedAt, basis, scope: '真实竞品报告草稿；模拟自家与 GSB 单列；不将项目标为已归档',
    project: bundle.project, notes: notes ?? null, results, recommendation, checks,
    ...(isAnchorMode(bundle.project.scheme) ? { anchorScores: valid.map(({id,questionId,productId,ratings}) => ({id,questionId,productId,ratings})) } : {}),
    joint: { ...joint, plan: state?.joint?.plan ?? null, rankings: ranks },
    quality: { ...quality, unresolved: quality.unresolved.map(t => t.id) },
    groups: { scenes: groups('scene'), categories: groups('category'), difficulties: groups('difficulty') },
    highFrequency, rankingDiscrepancies,
    references: { evaluationIds: heads.map(r => r.id), judgmentIds: judgments.map(r => r.id), decisionIds: state?.finals?.map(r => r.decisionId) ?? [], reportNotesId: notes?.id ?? null, assets: bundle.assets.map(({id,sha256,name,questionId,productId}) => ({id,sha256,name,questionId,productId})) }
  };
}
export type Report = ReturnType<typeof buildReport>;
const cell = (value: unknown) => String(value ?? '—').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
export function reportMarkdown(report: Report, reportVersion: ReportVersion = 'report-v2'): string {
  const product = (id: string) => report.project.products.find(p => p.id === id)?.name ?? id;
  const notes = report.notes;
  const lines = [`# ${report.project.name} · ${report.demo ? '界面演示报告' : '报告草稿'}`, '', '> 草稿，不代表项目已完成归档。缺失数据保留为空；原图需另存汇总主包。', '', `生成时间：${report.generatedAt}`, `统计口径：${report.basis === 'original' ? '原始初评' : '裁决口径参考分'}`, `规则：${report.project.schemeHash}`, `题库：${report.project.questionsHash}`, '', '## 结论与建议', '', notes?.summary || '待填写', '', '### 产品优势与短板', '', notes?.productInsights || '待填写', '', '### 对自家产品的启示', '', notes?.recommendations || '待填写', '', '## 综合对比', '', `| 产品 | 数据性质 | A | B | C | D | E | F | G | 总分 /${isAnchorMode(report.project.scheme) ? '5' : '100'} | 可用率 | 平均秒 | 可用图成本 | 推荐状态 |`, '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const anchorMethod = reportVersion === 'report-v1'
    ? '锚点直评分（扩展口径）：A/B/C/F/G 按配置锚点选 1–5 分并填写依据；D 为三个编辑任务的锚点分均值；E 仍由可用率/速度/成本计算；G 为逐题锚点分与整体走查各占一半。问题标签用于诊断与合规检查，不再换算分数。'
    : '锚点直评分（扩展口径）：A/B/C/F/G 按配置锚点选 1–5 分，评分依据选填；D 为三个编辑任务的锚点分均值；E 仍由可用率/速度/成本计算；G 为逐题锚点分与整体走查各占一半。问题标签用于诊断与合规检查，不再换算分数。';
  const methods = ['## 评测方法', '', `项目背景：${report.project.background || '待填写'}`, `评测周期：${report.project.period || '待填写'}`, `评测集：${report.project.questions.length} 题；${report.project.members.length} 名成员；${report.project.products.filter(p=>!p.demo).length} 个真实对比对象。`, `维度权重：${report.project.scheme.dimensions.map(d=>`${d.id} ${d.name} ${d.weight}%`).join('；')}`, isAnchorMode(report.project.scheme) ? anchorMethod : '图像维度按该维度最严重标签换算 1–5 分；D 为固定编辑走查，E 为可用率/速度/成本，G 为逐题体验标签与整体走查各占一半。', '共同校准、独立复评、一致率及全量复查状态见下方检查；分组结果仅代表实际有效样本，不进行缺失值填补。', ''];
  lines.splice(lines.indexOf('## 综合对比'), 0, ...methods);
  for (const row of report.results) lines.push(`| ${cell(product(row.productId))} | ${report.project.products.find(p=>p.id===row.productId)?.demo ? '模拟' : '真实对象'} | ${(['A','B','C','D','E','F','G'] as DimensionId[]).map(id=>`${num(row.dimensions[id].value)} (${row.dimensions[id].n}/${row.dimensions[id].expected})`).join(' | ')} | ${num(row.total === null ? null : row.total*(isAnchorMode(report.project.scheme)?1:20),isAnchorMode(report.project.scheme)?2:1)} | ${pct(row.usableRate)} | ${num(row.meanSeconds,1)} | ${num(row.costPerUsable,3)} | ${cell(row.eligibility)}${row.vetoReasons.length ? '：'+cell(row.vetoReasons.join('；')) : ''} |`);
  lines.push('', '维度值后的括号为已计入数量 / 应计数量；未齐全的维度仅作参考。完整总分需七维数据齐全。分组只列可按题汇总的 A/B/C/F，不把产品级 D/E/G 冒充为场景总分。', '', '## 分场景表现', '', '| 场景 | 产品 | 提交 | A | B | C | F |', '|---|---|---|---|---|---|---|');
  for (const group of report.groups.scenes) for (const row of group.products) lines.push(`| ${cell(group.value)} | ${cell(product(row.productId))} | ${row.submitted}/${row.expected} | ${['A','B','C','F'].map(dim=>`${num(row.dimensions[dim].value)} (${row.dimensions[dim].n}/${row.expected})`).join(' | ')} |`);
  lines.push('', '## 联合对比评审', '', `${report.joint.completed}/${report.joint.expected} 题有效排名${report.joint.plan?.trial ? '（试跑）' : ''}；${report.joint.unable} 题无法判断。`, '', '| 产品甲 / 产品乙 | 甲胜 | 平 | 甲负 | 有效题 | 甲净胜率 |', '|---|---|---|---|---|---|');
  for (const pair of report.joint.pairs) lines.push(`| ${cell(product(pair.left))} / ${cell(product(pair.right))} | ${pair.wins} | ${pair.ties} | ${pair.losses} | ${pair.n} | ${pct(pair.net)} |`);
  lines.push('', '净胜率 = (胜 − 负) / 有效题数；平局计入分母，无法判断排除。', '', '### 联合结论与维度得分的差异解释', '', notes?.consistencyExplanation || '待填写', '', `检测到 ${report.rankingDiscrepancies.length} 对产品的联合领先方向与完整总分方向相反；仍需人工分析，不自动替代结论。`, '', '## 高频问题', '');
  for (const row of report.highFrequency) lines.push(`- ${product(row.productId)}：${row.tags.slice(0,8).map(t=>`${t.code} ${t.name}（${t.count}题）`).join('；') || '有效提交中无问题标签'}`);
  lines.push('', '## 独立复评一致率', '', '| 产品 | 批次 | 有效 / 应评 | 不一致 | 原始一致率 |', '|---|---|---|---|---|');
  for (const row of report.quality.reviews) lines.push(`| ${cell(product(row.productId))} | ${cell(row.kind)}${row.trial?' · 试跑':''} | ${row.completed}/${row.expected} | ${row.different} | ${pct(row.rate)} |`);
  lines.push('', '## 自家对竞品 GSB', '', '| 对比竞品 | 有效 / 应评 | 自家胜 / 平 / 负 | 自家净胜率 | 数据性质 |', '|---|---|---|---|---|');
  for (const row of report.quality.gsb) lines.push(`| ${cell(product(row.productId))} | ${row.n}/${row.expected} | ${row.wins}/${row.ties}/${row.losses} | ${pct(row.net)} | ${row.demo?'含模拟数据':'真实对象'} |`);
  lines.push('', '## 功能与授权检查', '', notes?.featureComparison || '待填写', '', '## 典型案例与证据引用', '');
  for (const id of notes?.caseQuestionIds ?? []) {
    const question = report.project.questions.find(q=>q.id===id);
    lines.push(`### ${id} · ${question?.title ?? ''}`, '', question?.request ?? '', '');
    const ranking = report.joint.rankings.find(row=>row.questionId===id);
    for (const evidence of report.joint.plan?.evidence.filter(e=>e.questionId===id) ?? []) lines.push(`- ${product(evidence.productId)}：名次 ${ranking?.ranks.find(r=>r.productId===evidence.productId)?.rank ?? '—'}；原图 ${evidence.bestMediaId}；SHA-256 ${evidence.sha256}`);
    lines.push('', ranking?.reason || '尚无共同判断', '');
  }
  lines.push('## 局限与备注处理', '', notes?.limitations || '待填写', '', notes?.noteResolution || '尚无备注处理说明', '', '## 交付前检查', '', ...report.checks.map(check=>`- [${check.passed?'x':' '}] ${check.title}：${check.detail}`), '', '参与人：'+(notes?.participants.map(id=>report.project.members.find(m=>m.id===id)?.name ?? id).join('、') || '尚未确认'), '', '本文件及 JSON 明细不包含原图，不能作为可恢复项目备份。请同时保存汇总主包、清单和全部 ZIP。');
  if (isAnchorMode(report.project.scheme)) lines.push('', '## 锚点评分与依据', '', ...((report.anchorScores ?? []).flatMap(row => Object.entries(row.ratings ?? {}).map(([id,r]) => `- ${row.questionId} / ${product(row.productId)} / ${id}：${r.score} 分${reportVersion === 'report-v1' || r.reason.trim() ? `；${r.reason}` : ''}`))));
  return lines.join('\n');
}
