import { isAnchorMode } from '../core/ratings';
import { useEffect, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, ClipboardCheck, FileSpreadsheet, FileText, PencilLine, ShieldCheck } from 'lucide-react';
import { getAsset } from '../storage/projects';
import type { Asset, ProjectBundle } from '../core/model';
import type { QualityState } from '../core/quality';
import { emptyQuality } from '../core/quality';
import { buildReport, reportMarkdown } from '../core/report';
import type { ReportBasis } from '../core/report';
import { emptyReportNotes, latestReportNotes } from '../core/report-notes';
import { latestEvaluations } from '../core/assessment';
import { PageHeading, PanelHeading, Pill } from '../ui';
import { downloadJson } from '../storage/local';
import { useDirty } from './QualityWorkspace';
import './report-workspace.css';

export default function ReportWorkspace({ bundle, onSave, onToast, demo = false, loader = getAsset }: { bundle: ProjectBundle; onSave: (state: QualityState) => Promise<void>; onToast: (message: string) => void; demo?: boolean; loader?: (id: string) => Promise<Asset | undefined> }) {
  const saved = latestReportNotes(bundle.quality?.reportNotes);
  const [draft, setDraft] = useState(saved ?? emptyReportNotes());
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'preview' | 'write' | 'checks'>('preview');
  const [basis, setBasis] = useState<ReportBasis>('original');
  useEffect(() => { setDraft(saved ?? emptyReportNotes()); setDirty(false); }, [saved?.id, bundle.project.id]);
  useDirty(dirty || busy);
  const report = buildReport(bundle, basis, new Date().toISOString(), demo);
  const caseIds = [...new Set([...(report.comparison?.cases.map(row => row.questionId) ?? []), ...draft.caseQuestionIds])];
  const passed = report.checks.filter(c => c.passed).length;
  const productName = (id: string) => bundle.project.products.find(p => p.id === id)?.name ?? id;
  const noteRows = latestEvaluations(bundle.evaluations).filter(row => row.status === 'submitted' && row.notes.trim());
  const change = (patch: Partial<typeof draft>) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const textFields = [
    ['summary', '核心结论', '各竞品相对自家的优势、差距和适用条件。'],
    ['productInsights', '各产品的优势与短板', '结合维度分、场景表现与问题标签说明，避免只罗列分数。'],
    ['recommendations', '对自家产品的启示', '哪些能力值得借鉴，哪些问题应优先避免？'],
    ['consistencyExplanation', 'GSB 与维度分是否一致', '结合自家 vs 各竞品的胜平负，解释与维度评分一致或不同的原因。'],
    ['featureComparison', '功能与授权检查', '记录参考图、模板、编辑、批量、比例、水印、分辨率、价格及商用授权来源。'],
    ['limitations', '局限与反思', '说明产品版本、题库覆盖、人员绑定、已见信息、生成随机性及缺失数据。']
  ] as const;
  async function save() {
    setBusy(true);
    try {
      await onSave({ ...bundle.quality ?? emptyQuality(), reportNotes: [...bundle.quality?.reportNotes ?? [], { ...draft, id: crypto.randomUUID(), parentId: saved?.id ?? null, createdAt: new Date().toISOString() }] });
      setDirty(false); onToast('报告结论已保存为新修订');
    } catch(error) { onToast(error instanceof Error ? error.message : '保存失败'); } finally { setBusy(false); }
  }
  async function exportReport(format: 'md' | 'json' | 'word' | 'xlsx') {
    if (dirty || busy) return;
    const name = `${demo ? '界面演示-' : ''}${bundle.project.name.replace(/[\\/:*?"<>|]/g, '_')}-报告草稿`;
    setBusy(true);
    try {
      if (format === 'json') downloadJson(`${name}.json`, report);
      else {
        const file = format === 'word' ? await (await import('../core/wordReport')).reportWord(bundle, basis, loader, report.generatedAt)
          : format === 'xlsx' ? await (await import('../core/readableWorkbook')).readableWorkbook(bundle, basis, report.generatedAt)
          : new Blob([reportMarkdown(report)], {type:'text/markdown;charset=utf-8'});
        const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url;
        a.download = `${name}.${format === 'word' ? 'docx' : format}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      onToast(`${format === 'word' ? 'Word 报告' : format === 'xlsx' ? 'Excel 明细' : '报告草稿'}已导出；完整项目与原图请另保存团队交接包`);
    } catch (error) { onToast(error instanceof Error ? error.message : '导出失败，请重试'); } finally { setBusy(false); }
  }

  return <>
    <PageHeading eyebrow="INSIGHTS & DELIVERABLES" title="把评测证据，整理成结论" description="分别汇集各竞品相对自家的评分、GSB 与质量记录，不要求竞品之间联合排名。" action={<div className="report-export-actions"><button className="btn" disabled={dirty || busy} onClick={() => void exportReport('xlsx')}><FileSpreadsheet size={15}/>Excel 明细</button><button className="btn btn-primary" disabled={dirty || busy} onClick={() => void exportReport('word')}><FileText size={15}/>{busy ? '正在生成…' : 'Word 报告'}</button><details className="report-extra-formats"><summary>其他格式</summary><button className="btn btn-small" disabled={dirty || busy} onClick={() => void exportReport('md')}>Markdown</button><button className="btn btn-small" disabled={dirty || busy} onClick={() => void exportReport('json')}>JSON 明细</button></details></div>}/>
    <div className="report-export-guide"><strong>交作业用 Word，核对数据用 Excel</strong><span>Word 包含结论、评分表、GSB 与典型案例图；Excel 包含评分明细和可再次导入的题库。跨电脑继续评测，请使用“阶段同步”的团队交接 ZIP。</span></div>
    <div className="report-status-banner"><span className="report-status-icon"><ClipboardCheck size={24}/></span><div><strong>{demo ? '界面演示 · 草稿' : '报告草稿 · 待人工审阅'}</strong><p>{passed}/{report.checks.length} 项检查通过。原图需另存主包，本页不会把项目标为已归档。</p></div><button className="btn btn-small" onClick={() => setTab('checks')}>查看缺口<AlertCircle size={14}/></button></div>
    <div className="report-toolbar"><div className="report-tabs" role="tablist" aria-label="报告工作区"><button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}><FileText size={15}/>报告预览</button><button role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}><PencilLine size={15}/>撰写结论{dirty && ' · 未保存'}</button><button role="tab" aria-selected={tab === 'checks'} onClick={() => setTab('checks')}><ShieldCheck size={15}/>交付前检查</button></div><label>统计口径<select className="input" aria-label="报告统计口径" value={basis} onChange={event => setBasis(event.target.value as ReportBasis)}><option value="original">原始初评</option><option value="adjudicated-reference">裁决口径参考分</option></select></label></div>
    {tab === 'preview' && <>
      {dirty && <div className="report-note"><AlertCircle size={16}/>这里显示最近保存的结论。请在“撰写结论”保存后再导出。</div>}
      <section className="panel report-panel report-paper"><div className="report-paper-meta"><span>EVAL STUDIO / EVALUATION REPORT</span><Pill tone="orange">{demo ? '界面演示' : '草稿'}</Pill></div><h2>{bundle.project.name}</h2><p className="report-paper-context">{bundle.project.period || '评测周期待填写'} · {bundle.project.questions.length} 道共用题 · {bundle.project.products.filter(p=>!p.demo).length} 个对比产品</p><div className="report-conclusion"><span>核心结论</span><p>{saved?.summary || '先完成评测和共同讨论，再用证据写下推荐结论。系统不会代填产品优劣。'}</p></div>
        <PanelHeading title="综合表现" subtitle={`${basis === 'original' ? '原始初评' : '裁决口径参考分'} · ${isAnchorMode(bundle.project.scheme) ? '总分采用 5 分制' : '总分换算为百分制'}，缺项保持为空。`}/><div className="table-wrap"><table className="table"><thead><tr><th>产品</th><th>总分 /{isAnchorMode(bundle.project.scheme) ? '5' : '100'}</th><th>可用率</th><th>平均耗时</th><th>可用图成本</th><th>状态</th></tr></thead><tbody>{report.results.map(row => <tr key={row.productId}><td><strong>{productName(row.productId)}</strong></td><td>{row.total === null ? '—' : (row.total * (isAnchorMode(bundle.project.scheme) ? 1 : 20)).toFixed(isAnchorMode(bundle.project.scheme) ? 2 : 1)}</td><td>{row.usableRate === null ? '—' : `${(row.usableRate * 100).toFixed(1)}%`}</td><td>{row.meanSeconds === null ? '—' : `${row.meanSeconds.toFixed(1)}s`}</td><td>{row.costPerUsable === null ? '—' : row.costPerUsable.toFixed(3)}</td><td><Pill tone={row.eligibility === 'eligible' && row.total !== null ? 'green' : 'orange'}>{row.eligibility === 'eligible' && row.total === null ? '评分未齐' : ({eligible:'可参与推荐',vetoed:'一票否决',pending:'待检查',simulated:'模拟'})[row.eligibility]}</Pill></td></tr>)}</tbody></table></div>
        <div className="report-insight-grid"><section><h3>产品优势与短板</h3><p>{saved?.productInsights || '待补充基于维度和场景的解释。'}</p></section><section><h3>对自家产品的启示</h3><p>{saved?.recommendations || '待补充可借鉴能力与优先改进方向。'}</p></section></div>
        <PanelHeading title="自家 vs 各竞品 · GSB" subtitle="各组分别统计；净胜率以自家为基准，平局进入分母。无需竞品之间联合排名。"/><div className="report-pair-grid">{report.quality.gsb.map(pair => <div key={pair.productId}><span>{report.comparison?.selfProductId ? productName(report.comparison.selfProductId) : '自家'} / {productName(pair.productId)}{pair.demo ? ' · 含模拟数据' : ''}</span><strong>{pair.net === null ? '—' : `${pair.net > 0 ? '+' : ''}${(pair.net * 100).toFixed(1)}%`}</strong><small>{pair.wins} 胜 · {pair.ties} 平 · {pair.losses} 负 · {pair.n}/{pair.expected} 题</small></div>)}{!report.quality.gsb.length && <p className="muted">请在“自家对比 GSB”建立任务并收回判断。</p>}</div>
        <p className="report-narrative">{saved?.consistencyExplanation || '待说明各组 GSB 结果与维度分的关系。'}</p>
        <div className="report-insight-grid"><section><h3>高频问题</h3>{report.highFrequency.map(row => <p key={row.productId}><b>{productName(row.productId)}</b><br/>{row.tags.slice(0,3).map(t => `${t.name} ${t.count}题`).join('；') || '有效提交未标记问题'}</p>)}</section><section><h3>局限与反思</h3><p>{saved?.limitations || '待补充样本覆盖、人员尺度、已见信息与随机性的影响。'}</p></section></div>
        <footer className="report-paper-footer"><span>{saved ? `结论修订 ${bundle.quality?.reportNotes?.length ?? 0} · ${new Date(saved.createdAt).toLocaleDateString('zh-CN')}` : '尚无已保存的人工结论'}</span><span>完整维度、分组、复评与案例引用见导出明细</span></footer>
      </section>
    </>}
    {tab === 'write' && <section className="panel report-panel"><PanelHeading title="用证据写清楚判断" subtitle="输入可分次保存为草稿，修改追加修订；预览和导出使用最近保存的版本。"/><fieldset disabled={busy} className="report-fieldset"><div className="report-editor-grid">{textFields.map(([key,label,placeholder]) => <label className="field" key={key}>{label}<textarea className="input" value={draft[key]} onChange={event => change({ [key]: event.target.value })} placeholder={placeholder}/></label>)}</div>
      <h3>典型案例 · 从已完成 GSB 的题目中选 3–5 组</h3><div className="report-case-options">{caseIds.map(id => <label key={id}><input type="checkbox" checked={draft.caseQuestionIds.includes(id)} onChange={event => change({caseQuestionIds: event.target.checked ? [...draft.caseQuestionIds,id] : draft.caseQuestionIds.filter(q=>q!==id)})}/>{id} · {bundle.project.questions.find(q=>q.id===id)?.title}{!report.comparison?.cases.some(row => row.questionId === id) && '（尚无当前有效 GSB，请补齐或取消选择）'}</label>)}{!caseIds.length && <p className="muted">收回 GSB 判断后，可直接选择典型案例，无需先做联合排名。</p>}</div>
      <h3>带备注的初评记录</h3><p className="muted">确认已阅读并说明处理结果；新修订不会自动继承已确认状态。</p><div className="report-case-options">{noteRows.map(row => <label key={row.id}><input type="checkbox" checked={draft.acknowledgedNoteIds.includes(row.id)} onChange={event => change({acknowledgedNoteIds:event.target.checked?[...draft.acknowledgedNoteIds,row.id]:draft.acknowledgedNoteIds.filter(id=>id!==row.id)})}/><span>{row.questionId} · {productName(row.productId)}<small>{row.notes}</small></span></label>)}{!noteRows.length && <p className="muted">当前有效修订没有备注。</p>}</div>
      <label className="field">备注审阅与处理说明<textarea className="input" value={draft.noteResolution} onChange={event=>change({noteResolution:event.target.value})} placeholder="记录存疑如何解决，或为什么保留为局限。"/></label><div className="quality-checks">{bundle.project.members.map(member=><label key={member.id}><input type="checkbox" checked={draft.participants.includes(member.id)} onChange={event=>change({participants:event.target.checked?[...draft.participants,member.id]:draft.participants.filter(id=>id!==member.id)})}/>{member.name}确认结论</label>)}</div>
      <div className="report-save-row"><span>{dirty ? '有未保存修改' : '修改会保留为新的草稿版本'}</span><button className="btn btn-primary" disabled={!dirty} onClick={()=>void save()}><Check size={15}/>{busy?'正在保存…':'保存报告结论'}</button></div></fieldset></section>}
    {tab === 'checks' && <section className="panel report-panel"><PanelHeading title="交付前逐项检查" subtitle="允许导出有缺口的草稿，检查结果同时写入报告。不提供绕过检查的“已完成”标记。"/>{report.checks.map(check=><div className={`report-check ${check.passed?'passed':''}`} key={check.id}>{check.passed?<CheckCircle2 size={19}/>:<AlertCircle size={19}/>}<div><strong>{check.title}</strong><p>{check.detail}</p></div><Pill tone={check.passed?'green':'orange'}>{check.passed?'通过':'待处理'}</Pill></div>)}</section>}
  </>;
}
