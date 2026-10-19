import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, ChevronRight, ClipboardCheck, Download, FileJson, Info, Layers3, Search, ShieldCheck, SlidersHorizontal, Users, X } from 'lucide-react';
import * as echarts from 'echarts/core';
import { RadarChart, BarChart } from 'echarts/charts';
import { TooltipComponent, GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { PageHeading, Pill, PanelHeading, ProductAvatar } from '../ui';
import { dimensions, tags, products, scenes } from '../demo/data';
import { getValue, setValue } from '../storage/local';
import './insights.css';

echarts.use([RadarChart, BarChart, TooltipComponent, GridComponent, CanvasRenderer]);
type Props = { onToast: (message: string) => void };
const productList = products.filter(product => product.id !== 'self');
const baseWeights = dimensions.map(dimension => dimension.weight);

function DemoNote({ children }: { children?: React.ReactNode }) {
  return <div className="insight-note"><Info size={15} /><span>{children ?? '当前为界面预览，以下均为模拟数据，不代表任何真实产品的评测结论。'}</span></div>;
}

export function SchemePage({ onToast }: Props) {
  const [tab, setTab] = useState('dimensions');
  const [weights, setWeights] = useState<number[]>(baseWeights);
  const [savedWeights, setSavedWeights] = useState<number[]>(baseWeights);
  const [query, setQuery] = useState('');
  const [dimensionFilter, setDimensionFilter] = useState('all');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [project, setProject] = useState({ name: '电商文生图 · 竞品评测', background: '比较 AI 产品在电商运营出图场景中的效果、效率和使用体验，为产品迭代提供依据。', period: '3 天评测 + 1 天机动', members: '评测员 A、评测员 B、评测员 C' });
  useEffect(() => {
    let active = true;
    Promise.all([getValue<number[]>('insights:scheme:weights', baseWeights), getValue('insights:scheme:project', project)])
      .then(([storedWeights, storedProject]) => { if (active) { if (storedWeights.length === dimensions.length && storedWeights.every(Number.isFinite)) { setWeights(storedWeights); setSavedWeights(storedWeights); } setProject(storedProject); setLoaded(true); } })
      .catch(() => { if (active) { setLoaded(true); onToast('本地配置读取失败，当前显示默认演示方案'); } });
    return () => { active = false; };
  }, []);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const valid = Math.abs(total - 100) < 0.001 && weights.every(weight => Number.isFinite(weight) && weight >= 0 && weight <= 100);
  const changed = weights.some((weight, index) => weight !== savedWeights[index]);
  const visibleTags = tags.filter(tag => (dimensionFilter === 'all' || tag.dimension === dimensionFilter) && `${tag.code} ${tag.name}`.toLowerCase().includes(query.toLowerCase()));
  async function saveWeights() {
    if (!valid) return;
    setSaving(true);
    try { await setValue('insights:scheme:weights', weights); setSavedWeights([...weights]); onToast('维度权重已保存到当前浏览器'); }
    catch { onToast('保存失败，请检查浏览器存储空间后重试'); }
    finally { setSaving(false); }
  }
  async function saveProject() {
    if (!project.name.trim()) { onToast('请填写项目名称'); return; }
    setSaving(true);
    try { await setValue('insights:scheme:project', project); onToast('项目信息已保存到当前浏览器'); }
    catch { onToast('项目信息保存失败，请重试'); }
    finally { setSaving(false); }
  }
  return <div className="insights-page">
    <PageHeading eyebrow="PROJECT SETUP" title="评测方案" description="让评测规则成为可复用、可追溯的项目配置。" action={<Pill tone="violet">v0.1.0 · 演示方案</Pill>} />
    <div className="insight-file"><FileJson size={18} /><div><strong>电商文生图产品评测方案</strong><code>schemes/ecommerce-t2i/scheme.json</code></div><span>7 个维度<span className="insight-dot">·</span>25 个标签</span></div>
    <div className="insight-tabs" role="tablist" aria-label="方案配置分类">{[{ id: 'dimensions', name: '维度与权重' }, { id: 'tags', name: '问题标签' }, { id: 'project', name: '项目信息' }].map(item => <button role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => setTab(item.id)}>{item.name}</button>)}</div>
    {tab === 'dimensions' && <>
      <section className="panel insight-dimensions"><PanelHeading title="维度与权重" subtitle="按业务重要性分配权重，所有维度合计为 100%。" action={<Pill>5 分制</Pill>} />
        <div className="insight-table-wrap"><table className="insight-table"><thead><tr><th>评测维度</th><th>采集方式</th><th>权重分布</th><th className="insight-number">权重</th></tr></thead><tbody>{dimensions.map((dimension, index) => <tr key={dimension.id}><td><span className="insight-dimension-letter">{dimension.id}</span><strong>{dimension.name}</strong>{dimension.id === 'F' && <span className="insight-inline-hint">含一票否决</span>}</td><td className="insight-muted">{dimension.method}</td><td><div className="insight-weight-track"><span style={{ width: `${weights[index]}%` }} /></div></td><td className="insight-number"><label className="insight-weight-input"><input aria-label={`${dimension.name}权重`} type="number" min="0" max="100" step="1" disabled={!loaded} value={weights[index]} onChange={event => setWeights(previous => previous.map((weight, item) => item === index ? Number(event.target.value) : weight))} /><span>%</span></label></td></tr>)}</tbody></table></div>
        <div className="insight-save-bar"><div className={valid ? 'insight-weight-valid' : 'insight-error'}>{valid ? <CheckCircle2 size={16} /> : <Info size={16} />}权重合计 <strong>{total.toFixed(Number.isInteger(total) ? 0 : 1)}%</strong>{valid ? '分配完成' : '请调整至 100%'}</div><div><button className="btn btn-small" onClick={() => setWeights([...baseWeights])}>恢复默认</button><button className="btn btn-primary btn-small" disabled={!valid || saving || !changed} onClick={saveWeights}>{saving ? '保存中…' : '保存权重'}</button></div></div>
      </section><DemoNote>权重修改保存在当前浏览器，不会改写仓库文件；当前仅预览配置交互，不改变演示看板口径。</DemoNote>
    </>}
    {tab === 'tags' && <section className="panel insight-tag-panel"><PanelHeading title="问题标签库" subtitle="按各维度最严重的问题换算分数：无标签 5 分，P3–P0 对应 4–1 分。" /><div className="insight-toolbar"><label className="insight-search"><Search size={16} /><input placeholder="搜索标签名称或编码" value={query} onChange={event => setQuery(event.target.value)} /></label><select className="input" aria-label="按维度筛选标签" value={dimensionFilter} onChange={event => setDimensionFilter(event.target.value)}><option value="all">全部维度</option>{dimensions.map(dimension => <option value={dimension.id} key={dimension.id}>{dimension.id} · {dimension.name}</option>)}</select><span className="insight-muted">{visibleTags.length} 个标签</span></div><div className="insight-table-wrap"><table className="insight-table"><thead><tr><th>标签编码</th><th>问题名称</th><th>所属维度</th><th>默认严重等级</th></tr></thead><tbody>{visibleTags.map(tag => <tr key={tag.code}><td><code>{tag.code}</code></td><td><strong>{tag.name}</strong></td><td className="insight-muted">{dimensions.find(dimension => dimension.id === tag.dimension)?.name}</td><td><span className={`insight-severity severity-${tag.severity}`}>{tag.severity}</span></td></tr>)}</tbody></table>{visibleTags.length === 0 && <div className="insight-empty">没有找到匹配的标签，请调整搜索条件。</div>}</div></section>}
    {tab === 'project' && <section className="panel insight-project-form"><PanelHeading title="项目信息" subtitle="此处编辑本地演示项目，真实的产品名称和会员档位将在正式建项时填写。" /><label className="field">项目名称<input className="input" value={project.name} onChange={event => setProject({ ...project, name: event.target.value })} /></label><label className="field">评测背景<textarea className="input" rows={3} value={project.background} onChange={event => setProject({ ...project, background: event.target.value })} /></label><div className="insight-form-columns"><label className="field">评测周期<input className="input" value={project.period} onChange={event => setProject({ ...project, period: event.target.value })} /></label><label className="field">项目成员<input className="input" value={project.members} onChange={event => setProject({ ...project, members: event.target.value })} /></label></div><div className="insight-form-footer"><span className="insight-muted">独立项目 · 本地存储 · 阶段同步</span><button className="btn btn-primary" disabled={saving || !loaded} onClick={saveProject}>{saving ? '保存中…' : '保存项目信息'}</button></div></section>}
  </div>;
}

type Dispute = { id: string; question: string; product: string; dimension: string; original: string; review: string; originalScore: number; reviewScore: number; reason: string };
const disputes: Dispute[] = [
  { id: 'Q-003', question: '精华液 · 自然光场景展示', product: '竞品 A', dimension: 'C · 画面质量', original: 'C-01 真实感不足 · P3', review: 'C-01 真实感不足 · P1', originalScore: 4, reviewScore: 2, reason: '对玻璃材质和接触阴影的严重程度判断不同，单题维度分相差 2 分。' },
  { id: 'Q-018', question: '不粘锅 · 营销海报', product: '竞品 B', dimension: 'A · 电商场景适配', original: 'A-03 文字信息错误 · P1', review: 'A-03 文字信息错误 · P0', originalScore: 2, reviewScore: 1, reason: '价格数字错误应按特殊规则判为 P0，原评与复评对 P0 判定不一致。' },
  { id: 'Q-031', question: '蓝牙耳机 · 白底商品展示', product: '竞品 C', dimension: 'B · 指令理解与遵循', original: '无问题标签', review: 'B-03 元素遗漏 / 多余 · P2', originalScore: 5, reviewScore: 3, reason: '评审员对需求中的配件是否必须出镜存在分歧，单题维度分相差 2 分。' }
];
type Decision = { choice: 'original' | 'review'; note: string; savedAt: string };

export function QualityPage({ onToast }: Props) {
  const [filter, setFilter] = useState('all');
  const [active, setActive] = useState<Dispute | null>(null);
  const [choice, setChoice] = useState<'original' | 'review'>('review');
  const [note, setNote] = useState('');
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { let mounted = true; getValue<Record<string, Decision>>('insights:quality:decisions', {}).then(value => { if (mounted) { setDecisions(value); setLoaded(true); } }).catch(() => { if (mounted) { setLoaded(true); onToast('裁决记录读取失败，当前显示默认演示状态'); } }); return () => { mounted = false; }; }, []);
  useEffect(() => { if (!active) return; const listener = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) setActive(null); }; document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener); }, [active, saving]);
  function openDispute(dispute: Dispute) { setActive(dispute); setChoice(decisions[dispute.id]?.choice ?? 'review'); setNote(decisions[dispute.id]?.note ?? ''); }
  async function saveDecision() {
    if (!active || !note.trim()) return;
    setSaving(true);
    const next = { ...decisions, [active.id]: { choice, note: note.trim(), savedAt: new Date().toISOString() } };
    try { await setValue('insights:quality:decisions', next); setDecisions(next); setActive(null); onToast('演示裁决已保存，原评和复评记录仍然保留'); }
    catch { onToast('裁决保存失败，请重试'); }
    finally { setSaving(false); }
  }
  const resolved = Object.keys(decisions).filter(id => disputes.some(dispute => dispute.id === id)).length;
  const visible = disputes.filter(dispute => filter === 'all' || (filter === 'pending' ? !decisions[dispute.id] : !!decisions[dispute.id]));
  return <div className="insights-page">
    <PageHeading eyebrow="QUALITY CONTROL" title="质量控制" description="统一评判尺度，让每一个结论都经得起复核。" action={<Pill tone="violet">演示项目</Pill>} />
    <div className="insight-quality-cards"><div className="panel insight-quality-card"><span className="insight-card-icon"><Users size={20} /></span><div><span className="insight-kicker">开工前校准</span><h3>5 <small>题 × 3 产品</small></h3><p>三人独立判断，共 45 份校准记录</p></div><Pill tone="green">流程示例</Pill></div><div className="panel insight-quality-card"><span className="insight-card-icon"><ClipboardCheck size={20} /></span><div><span className="insight-kicker">交叉复评</span><h3>30 <small>题</small></h3><p>每产品随机抽取 10 题，覆盖 20%</p></div><Pill>演示数据</Pill></div><div className="panel insight-quality-card"><span className="insight-card-icon warm"><ShieldCheck size={20} /></span><div><span className="insight-kicker">分歧处理</span><h3>{disputes.length - resolved} <small>项待处理</small></h3><p>3 项样例分歧 · {resolved} 项已本地裁决</p></div><Pill tone={resolved === 3 ? 'green' : 'orange'}>{resolved === 3 ? '已完成' : '待裁决'}</Pill></div></div>
    <section className="panel insight-consistency"><div><span className="insight-kicker">独立判断一致率 · 示例</span><strong>90.0<span>%</span></strong><p>27 / 30 题判定一致，裁决不改变原始一致率。</p></div><div className="insight-consistency-products">{productList.map((product, index) => <div key={product.id}><ProductAvatar letter={product.letter} color={product.color} small /><span>{product.name}</span><div className="insight-mini-track"><span style={{ width: `${[90, 90, 90][index]}%` }} /></div><strong>9 / 10</strong></div>)}</div></section>
    <section className="panel insight-disputes"><PanelHeading title="分歧与裁决" subtitle="保留初评、复评和裁决三份记录，汇总使用最终裁决版本。" action={<span className="insight-muted">仅演示操作</span>} /><div className="insight-filter-row">{[{ id: 'all', name: '全部分歧', count: 3 }, { id: 'pending', name: '待处理', count: 3 - resolved }, { id: 'resolved', name: '已裁决', count: resolved }].map(item => <button className={filter === item.id ? 'active' : ''} key={item.id} onClick={() => setFilter(item.id)}>{item.name}<span>{item.count}</span></button>)}</div><div className="insight-table-wrap"><table className="insight-table"><thead><tr><th>题目</th><th>产品 / 维度</th><th>初评</th><th>复评</th><th>状态</th><th /></tr></thead><tbody>{visible.map(dispute => <tr key={dispute.id}><td><code>{dispute.id}</code><span className="insight-cell-sub">{dispute.question}</span></td><td>{dispute.product}<span className="insight-cell-sub">{dispute.dimension}</span></td><td><strong>{dispute.originalScore}</strong><span className="insight-score-unit"> / 5</span></td><td><strong>{dispute.reviewScore}</strong><span className="insight-score-unit"> / 5</span></td><td><Pill tone={decisions[dispute.id] ? 'green' : 'orange'}>{decisions[dispute.id] ? '已裁决' : '待处理'}</Pill></td><td><button disabled={!loaded} className="insight-table-link" onClick={() => openDispute(dispute)}>查看差异<ChevronRight size={14} /></button></td></tr>)}</tbody></table>{visible.length === 0 && <div className="insight-empty"><CheckCircle2 size={24} /><strong>{filter === 'pending' ? '样例分歧已全部处理' : '还没有此类记录'}</strong><span>可切换筛选查看其他分歧。</span></div>}</div></section>
    <DemoNote>一致性规则：任一维度相差 ≥ 2 分，或 P0 / P1 标签判定不同，记为不一致；任一产品超过 3 / 10 题不一致，须复查该产品全部 50 题。</DemoNote>
    {active && <div className="insight-modal-backdrop" onClick={() => { if (!saving) setActive(null); }}><section className="insight-modal" role="dialog" aria-modal="true" aria-labelledby="dispute-title" onClick={event => event.stopPropagation()}><div className="insight-modal-heading"><div><span className="insight-kicker">DEMONSTRATION · {active.id}</span><h2 id="dispute-title">分歧裁决</h2></div><button className="insight-close" aria-label="关闭裁决弹窗" onClick={() => setActive(null)} disabled={saving}><X size={20} /></button></div><p className="insight-modal-description">{active.question}<span> · {active.product}</span></p><div className="insight-dispute-reason"><Info size={16} />{active.reason}</div><div className="insight-judgment-grid">{([{ value: 'original', label: '保留初评', tag: active.original, score: active.originalScore }, { value: 'review', label: '采用复评', tag: active.review, score: active.reviewScore }] as const).map(item => <label key={item.value} className={`insight-judgment ${choice === item.value ? 'selected' : ''}`}><span><input type="radio" name="decision" value={item.value} checked={choice === item.value} onChange={() => setChoice(item.value)} />{item.label}</span><strong>{item.score}<small> / 5 分</small></strong><p>{item.tag}</p></label>)}</div><label className="field">裁决依据 <span className="insight-required">*</span><textarea autoFocus className="input" rows={3} placeholder="说明最终判定依据，原始记录会继续保留…" value={note} onChange={event => setNote(event.target.value)} /></label><DemoNote>此操作仅保存演示裁决，不构成真实评测结论。</DemoNote><div className="insight-modal-actions"><button className="btn" onClick={() => setActive(null)} disabled={saving}>取消</button><button className="btn btn-primary" onClick={saveDecision} disabled={saving || !note.trim()}><Check size={16} />{saving ? '保存中…' : '确认裁决'}</button></div></section></div>}
  </div>;
}

const seriesColors = ['#6574d9', '#dc9c52', '#57a79a'];
const allScores = [[4.1, 4.0, 4.2, 3.6, 3.8, 4.8, 4.0], [4.3, 4.2, 4.5, 4.1, 3.6, 4.9, 4.3], [3.7, 3.9, 3.8, 3.4, 4.2, 4.7, 3.8]];
const sceneShifts = [[0, 0, 0, 0, 0, 0, 0], [.2, .1, .1, 0, .1, 0, 0], [0, -.1, .2, .1, 0, 0, .1], [-.2, -.2, -.1, 0, -.1, 0, 0], [-.3, -.1, -.2, -.1, 0, -.1, -.1]];
const frequentTags = ['C-01 真实感不足', 'A-03 文字信息错误', 'A-06 抠图感 / 悬浮感', 'B-03 元素遗漏 / 多余', 'C-03 清晰度不足'];

function Chart({ option, className = '' }: { option: echarts.EChartsCoreOption; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    chart.setOption(option);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [option]);
  return <div className={`insight-chart ${className}`} ref={element} role="img" aria-label="三款竞品演示统计图" />;
}

export function DashboardPage({ onToast }: Props) {
  const [scene, setScene] = useState('全部场景');
  const sceneIndex = scene === '全部场景' ? 0 : scenes.indexOf(scene) + 1;
  const scores = useMemo(() => allScores.map((row, productIndex) => row.map((score, index) => Math.min(5, Math.max(1, Number((score + sceneShifts[sceneIndex][index] + (sceneIndex > 0 ? (productIndex - 1) * .06 : 0)).toFixed(2)))))), [sceneIndex]);
  const totals = scores.map(row => row.reduce((sum, score, index) => sum + score * dimensions[index].weight / 100, 0));
  const bestIndex = totals.indexOf(Math.max(...totals));
  const tagValues = useMemo(() => productList.map((_, index) => [18 - index * 3, 14 + index * 2, 12 - index, 10 + index, 8 + index * 2].map(value => sceneIndex === 0 ? value : Math.max(1, Math.round(value * [.3, .26, .22, .34][sceneIndex - 1])))), [sceneIndex]);
  const radarOption = useMemo<echarts.EChartsCoreOption>(() => ({ color: seriesColors, tooltip: { trigger: 'item', textStyle: { fontFamily: 'inherit', fontSize: 12 } }, radar: { center: ['50%', '49%'], radius: '68%', splitNumber: 5, indicator: dimensions.map(dimension => ({ name: dimension.name, max: 5 })), axisName: { color: '#7c8196', fontSize: 11 }, splitLine: { lineStyle: { color: '#e9eaf2' } }, splitArea: { areaStyle: { color: ['#fff', '#fafafd'] } }, axisLine: { lineStyle: { color: '#e9eaf2' } } }, series: [{ type: 'radar', symbol: 'circle', symbolSize: 5, lineStyle: { width: 2 }, data: productList.map((product, index) => ({ name: product.name, value: scores[index], areaStyle: { opacity: .045 } })) }] }), [scores]);
  const barOption = useMemo<echarts.EChartsCoreOption>(() => ({ color: seriesColors, grid: { left: 180, right: 30, top: 8, bottom: 20 }, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { type: 'dashed', color: '#f0f0f5' } }, axisLabel: { color: '#9296a7', fontSize: 10 } }, yAxis: { type: 'category', inverse: true, data: frequentTags, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#656b7e', fontSize: 11, margin: 18 } }, series: productList.map((product, index) => ({ name: product.name, type: 'bar', data: tagValues[index], barWidth: 7, barGap: '35%', itemStyle: { borderRadius: [0, 3, 3, 0] } })) }), [tagValues]);
  function exportCsv() {
    const rows: (string | number)[][] = [['数据来源', '演示统计，非真实产品评测结果'], ['筛选场景', scene], ['维度', '权重', ...productList.map(product => product.name)], ...dimensions.map((dimension, index) => [dimension.name, `${dimension.weight}%`, ...scores.map(row => row[index])]), ['加权总分（5分制）', '', ...totals.map(total => total.toFixed(3))], [], ['高频标签', ...productList.map(product => product.name)], ...frequentTags.map((name, index) => [name, ...tagValues.map(row => row[index])])];
    const content = '\ufeff' + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `演示统计-${scene}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); onToast('已生成当前筛选下的演示统计 CSV');
  }
  return <div className="insights-page">
    <PageHeading eyebrow="RESULTS & INSIGHTS" title="汇总看板" description="从整体表现到具体问题，找到产品差异与改进机会。" action={<button className="btn" onClick={exportCsv}><Download size={16} />导出数据</button>} />
    <div className="insight-dashboard-filters"><div className="insight-scene-buttons"><SlidersHorizontal size={16} />{['全部场景', ...scenes].map(item => <button key={item} className={scene === item ? 'active' : ''} onClick={() => setScene(item)}>{item}</button>)}</div><Pill tone="violet">演示统计</Pill></div>
    <div className="insight-dashboard-metrics"><div className="panel"><span>评测样本 · {scene}</span><strong>{sceneIndex === 0 ? 150 : [36, 39, 39, 36][sceneIndex - 1]}<small>份</small></strong><p>3 款竞品 · 共用同一套评测集</p></div><div className="panel"><span>平均综合得分</span><strong>{(totals.reduce((sum, value) => sum + value, 0) / 3 * 20).toFixed(1)}<small>/ 100</small></strong><p>按预置的 7 个维度加权计算</p></div><div className="panel"><span>当前领先产品</span><strong className="insight-leading"><ProductAvatar letter={productList[bestIndex].letter} color={productList[bestIndex].color} small />{productList[bestIndex].name}</strong><p>综合得分 {(totals[bestIndex] * 20).toFixed(1)} · 示例结果</p></div></div>
    <div className="insight-dashboard-main"><section className="panel insight-radar-panel"><PanelHeading title="能力对比" subtitle={`${scene} · 七个维度，满分 5 分`} /><Chart option={radarOption} /><div className="insight-chart-legend">{productList.map((product, index) => <span key={product.id}><i style={{ background: seriesColors[index] }} />{product.name}</span>)}</div></section><section className="panel insight-score-panel"><PanelHeading title="维度得分" subtitle={`${scene} · 与左侧雷达图使用同一组数据`} /><table className="insight-table insight-score-table"><thead><tr><th>评测维度</th>{productList.map((product, index) => <th key={product.id}><span className="insight-product-dot" style={{ background: seriesColors[index] }} />{product.name}</th>)}</tr></thead><tbody>{dimensions.map((dimension, index) => <tr key={dimension.id}><td>{dimension.name}<span>{dimension.weight}%</span></td>{scores.map((row, productIndex) => <td key={productIndex} className={row[index] === Math.max(...scores.map(values => values[index])) ? 'insight-best-score' : ''}>{row[index].toFixed(2)}</td>)}</tr>)}<tr className="insight-total-row"><td>加权总分<span>5 分制</span></td>{totals.map((total, index) => <td key={index}>{total.toFixed(2)}</td>)}</tr></tbody></table></section></div>
    <section className="panel insight-tags-chart-panel"><PanelHeading title="高频问题标签" subtitle={`${scene} · 各产品出现次数最多的共同问题（模拟次数）`} action={<div className="insight-chart-legend">{productList.map((product, index) => <span key={product.id}><i style={{ background: seriesColors[index] }} />{product.name}</span>)}</div>} /><Chart option={barOption} className="insight-bar-chart" /></section>
    <DemoNote>本页固定演示数据用于预览分析交互；自家产品为独立模拟对象，未混入上述 3 款竞品统计。当前看板不读取真实评测记录，也不反映配置页的本地权重修改。</DemoNote>
  </div>;
}
