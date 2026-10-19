import { useEffect, useState } from 'react';
import { ArrowLeftRight, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Image as ImageIcon, Info, Layers3, Save, Scale, TrendingUp } from 'lucide-react';
import { products, questions } from '../demo/data';
import { gsbNetWin, type GSB } from '../core/scoring';
import { getValue, setValue } from '../storage/local';
import './assessment.css';

type Props = { onToast: (message: string) => void };
type ComparisonRecord = { questionId: number; leftProductId: 'self'; rightProductId: string; result: GSB; reason: string; status: 'submitted'; demo: true; updatedAt: string };
type RankingRecord = { questionId: number; ranks: Record<string, number>; reason: string; status: 'submitted'; demo: true; updatedAt: string };
const competitors = products.filter(product => product.id !== 'self');
const DEMO_IMAGE = `${import.meta.env.BASE_URL}assets/serum-demo.png`;

export default function Comparison({ onToast }: Props) {
  const [tab, setTab] = useState<'gsb' | 'ranking'>('gsb');
  const [questionId, setQuestionId] = useState(1);
  const [rightProductId, setRightProductId] = useState('p1');
  const [records, setRecords] = useState<ComparisonRecord[]>([]);
  const [rankings, setRankings] = useState<RankingRecord[]>([]);
  const [result, setResult] = useState<GSB | null>(null);
  const [reason, setReason] = useState('');
  const [ranks, setRanks] = useState<Record<string, number>>({});
  const [rankingReason, setRankingReason] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const question = questions.find(q => q.id === questionId) ?? questions[0];
  const competitor = competitors.find(product => product.id === rightProductId) ?? competitors[0];
  const pairRecords = records.filter(record => record.rightProductId === rightProductId);
  const netWin = gsbNetWin(pairRecords.map(record => record.result));
  const currentSubmitted = tab === 'gsb' ? records.some(record => record.questionId === questionId && record.rightProductId === rightProductId) : rankings.some(record => record.questionId === questionId);
  const visibleQuestions = tab === 'ranking' ? questions.slice(0, 12) : questions;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getValue<ComparisonRecord[]>('comparison-records', []),
      getValue<RankingRecord[]>('ranking-records', [])
    ]).then(([savedRecords, savedRankings]) => { if (!cancelled) { setRecords(savedRecords); setRankings(savedRankings); } })
      .catch(() => { if (!cancelled) { setLoadError(true); onToast('本地比较记录读取失败，请刷新重试。'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const record = records.find(item => item.questionId === questionId && item.rightProductId === rightProductId);
    const ranking = rankings.find(item => item.questionId === questionId);
    setResult(record?.result ?? null);
    setReason(record?.reason ?? '');
    setRanks(ranking?.ranks ?? {});
    setRankingReason(ranking?.reason ?? '');
    setDirty(false);
  }, [questionId, rightProductId, tab, records, rankings]);

  function canLeave() {
    return !dirty || window.confirm('当前判断尚未保存，切换将丢弃本次修改。是否继续？');
  }

  function changeQuestion(id: number) {
    if (id !== questionId && canLeave()) setQuestionId(id);
  }

  function changeTab(next: 'gsb' | 'ranking') {
    if (next === tab || !canLeave()) return;
    if (next === 'ranking' && questionId > 12) setQuestionId(1);
    setTab(next);
  }

  async function saveComparison() {
    if (!result) { onToast('请先选择 G、S 或 B。未比较的题目不会计作持平。'); return; }
    if (loading || saving || loadError) return;
    setSaving(true);
    try {
      const all = await getValue<ComparisonRecord[]>('comparison-records', []);
      const record: ComparisonRecord = { questionId, leftProductId: 'self', rightProductId, result, reason, status: 'submitted', demo: true, updatedAt: new Date().toISOString() };
      const next = [...all.filter(item => !(item.questionId === questionId && item.rightProductId === rightProductId)), record];
      await setValue('comparison-records', next);
      setRecords(next);
      setDirty(false);
      onToast('GSB 演示判断已保存。净胜率仅按已提交记录计算。');
    } catch { onToast('比较结果保存失败，修改仍在当前页面，请重试。'); }
    finally { setSaving(false); }
  }

  async function saveRanking() {
    const values = competitors.map(product => ranks[product.id]);
    if (values.some(value => !Number.isInteger(value) || value < 1 || value > competitors.length)) { onToast('请为三个产品分别选择名次。'); return; }
    const unique = [...new Set(values)].sort((a, b) => a - b);
    if (unique.some((value, index) => value !== index + 1)) { onToast('名次须从 1 开始且连续；允许 1、1、2 这样的并列。'); return; }
    if (loading || saving || loadError) return;
    setSaving(true);
    try {
      const all = await getValue<RankingRecord[]>('ranking-records', []);
      const record: RankingRecord = { questionId, ranks, reason: rankingReason, status: 'submitted', demo: true, updatedAt: new Date().toISOString() };
      const next = [...all.filter(item => item.questionId !== questionId), record];
      await setValue('ranking-records', next);
      setRankings(next);
      setDirty(false);
      onToast('联合排名演示记录已保存，不会自动填入 GSB。');
    } catch { onToast('联合排名保存失败，请重试。'); }
    finally { setSaving(false); }
  }

  const options: { value: GSB; label: string; detail: string }[] = [
    { value: 'G', label: '自家更好', detail: 'Good · 左侧结果更优' },
    { value: 'S', label: '表现持平', detail: 'Same · 无明显差异' },
    { value: 'B', label: '自家更差', detail: 'Bad · 右侧结果更优' }
  ];

  return <div className="assessment-page comparison-page">
    <header className="page-heading assessment-heading"><div><div className="eyebrow">SIDE-BY-SIDE REVIEW</div><h1>对比评审</h1><p className="muted">把同一道题放在一起，用直接比较补充绝对评分。</p></div><span className="badge">演示项目</span></header>
    <div className="comparison-tabs" role="tablist" aria-label="对比方法"><button role="tab" disabled={loading || saving} aria-selected={tab === 'gsb'} className={tab === 'gsb' ? 'active' : ''} onClick={() => changeTab('gsb')}><ArrowLeftRight size={16} />GSB 两两对比<span>50 题 × 3 组</span></button><button role="tab" disabled={loading || saving} aria-selected={tab === 'ranking'} className={tab === 'ranking' ? 'active' : ''} onClick={() => changeTab('ranking')}><Layers3 size={16} />联合排名<span>12 题</span></button></div>
    <div className="assessment-demo-notice"><Info size={16} /><span><strong>模拟比较</strong> · 所有图片来自同一张示范素材，仅通过裁剪或色调展示界面差异，不代表任何产品能力。题目为演示占位，判断单独标记为演示。</span></div>
    <div className="comparison-summary-row">
      <div className="panel comparison-stat"><span><CheckCircle2 size={16} />{tab === 'gsb' ? '已提交的演示比较' : '已提交的联合排名'}</span><strong>{tab === 'gsb' ? records.length : rankings.length}<small> / {tab === 'gsb' ? '150' : '12'}</small></strong><div className="assessment-progress-track"><span style={{ width: `${(tab === 'gsb' ? records.length / 150 : rankings.length / 12) * 100}%` }} /></div></div>
      <div className="panel comparison-stat"><span><TrendingUp size={16} />{tab === 'gsb' ? `自家 vs ${competitor.name} · 净胜率` : '本次联合排名范围'}</span><strong>{tab === 'gsb' ? netWin === null ? '—' : `${netWin > 0 ? '+' : ''}${(netWin * 100).toFixed(1)}%` : '3 个产品'}</strong><small>{tab === 'gsb' ? netWin === null ? '暂无已提交比较' : `基于 ${pairRecords.length} 次实际提交 · 含持平` : '演示取前 12 题；正式抽样待配置'}</small></div>
      <div className="panel comparison-method"><Scale size={21} /><div><strong>{tab === 'gsb' ? '先独立比较，再查看结论' : '三人讨论，形成一份共识'}</strong><p>{tab === 'gsb' ? '本页不展示初评标签与维度分。未比较不计为 S。' : '允许并列；联合排名与直接 GSB 分别记录、分别统计。'}</p></div></div>
    </div>
    <div className="panel comparison-question-brief">
      <div className="comparison-question-toolbar"><div><span className="assessment-question-kicker">QUESTION</span><select className="input" value={questionId} disabled={loading || saving} onChange={event => changeQuestion(Number(event.target.value))}>{visibleQuestions.map(q => <option value={q.id} key={q.id}>{String(q.id).padStart(2, '0')} · {q.title}</option>)}</select></div><div className="comparison-question-actions"><span className="pill">{question.scene}</span><span className="pill">{question.difficulty}</span><button className="btn btn-small" disabled={questionId === 1 || loading || saving} onClick={() => changeQuestion(questionId - 1)} aria-label="上一题"><ChevronLeft size={16} /></button><button className="btn btn-small" disabled={questionId >= visibleQuestions.length || loading || saving} onClick={() => changeQuestion(questionId + 1)} aria-label="下一题"><ChevronRight size={16} /></button></div></div>
      <p>{question.request}</p><div className="comparison-acceptance"><CheckCircle2 size={13} />验收重点：主体符合需求 · 结构与细节合理 · 满足指定场景与文字要求<span>演示占位</span></div>
    </div>

    {tab === 'gsb' ? <>
      <div className="comparison-images">
        <article className="panel comparison-image-card"><header><div className="comparison-product-avatar self">S</div><div><span className="comparison-product-kicker">LEFT · 自家基准</span><h2>自家产品 <span className="pill">模拟</span></h2></div><span className="comparison-image-index">01 / 01</span></header><div className="comparison-product-image"><img src={DEMO_IMAGE} alt="自家侧精华液演示素材，非实测输出" /><span><ImageIcon size={13} />同源原色预览 · 演示</span></div><footer><span>最佳图 · 示范素材</span><span>原始视图</span></footer></article>
        <div className="comparison-vs"><ArrowLeftRight size={18} /></div>
        <article className="panel comparison-image-card"><header><div className={`comparison-product-avatar ${competitor.color}`}>{competitor.letter}</div><div><span className="comparison-product-kicker">RIGHT · 对比产品</span><select className="comparison-product-select" value={rightProductId} disabled={loading || saving} aria-label="选择对比竞品" onChange={event => { if (canLeave()) setRightProductId(event.target.value); }}>{competitors.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></div><span className="comparison-image-index">01 / 01</span></header><div className="comparison-product-image comparison-warm"><img src={DEMO_IMAGE} alt={`${competitor.name} 侧的同源暖色演示，非竞品输出`} /><span><ImageIcon size={13} />同源暖色预览 · 非竞品输出</span></div><footer><span>最佳图 · 示范素材</span><span>暖色预览</span></footer></article>
      </div>
      <section className="panel comparison-decision"><div className="comparison-decision-heading"><div><h2>哪一侧更符合本题需求？</h2><p>综合观察两张结果，选择一个判断，并记录理由。</p></div><span className={`assessment-save-state ${currentSubmitted && !dirty ? 'submitted' : ''}`}>{loading ? '读取中' : dirty ? '未保存' : currentSubmitted ? '已提交' : '待比较'}</span></div>
        <div className="comparison-vote-options">{options.map(option => <button key={option.value} className={`comparison-vote ${result === option.value ? 'selected' : ''}`} aria-pressed={result === option.value} disabled={loading || saving} onClick={() => { setResult(option.value); setDirty(true); }}><span className={`comparison-vote-letter vote-${option.value.toLowerCase()}`}>{option.value}</span><span><strong>{option.label}</strong><small>{option.detail}</small></span>{result === option.value && <Check size={17} />}</button>)}</div>
        <label className="field comparison-reason"><span>判断理由 <small>选填，建议记录可观察的差异</small></span><textarea className="input" disabled={loading || saving || loadError} rows={2} value={reason} onChange={event => { setReason(event.target.value); setDirty(true); }} placeholder="例如：左侧瓶身结构更稳定，右侧光影更自然；综合验收要点选择…" /></label>
        <footer className="comparison-save-footer"><span><Info size={14} />数据保存在当前浏览器；模拟比较不进入真实排名。</span><button className="btn btn-primary" onClick={() => void saveComparison()} disabled={loading || saving || loadError}><Save size={15} />{saving ? '保存中…' : '保存比较'}</button></footer>
      </section>
    </> : <section className="panel comparison-ranking"><div className="comparison-decision-heading"><div><h2>为三个产品确定共识名次</h2><p>三人共同讨论后记录一份排名；图片均为同源演示。</p></div><span className={`assessment-save-state ${currentSubmitted && !dirty ? 'submitted' : ''}`}>{dirty ? '未保存' : currentSubmitted ? '已提交' : '待评审'}</span></div><div className="comparison-ranking-grid">{competitors.map((product, index) => <article className="comparison-ranking-card" key={product.id}><div className={`comparison-ranking-image ranking-variant-${index}`}><img src={DEMO_IMAGE} alt={`${product.name} 同源示范素材，非实测输出`} /><span>同源示范素材</span></div><div className="comparison-ranking-product"><div className={`comparison-product-avatar ${product.color}`}>{product.letter}</div><strong>{product.name}</strong><select className="input" value={ranks[product.id] ?? ''} disabled={loading || saving} aria-label={`${product.name} 的名次`} onChange={event => { setRanks(value => ({ ...value, [product.id]: Number(event.target.value) })); setDirty(true); }}><option value="">选择名次</option><option value="1">第 1 名</option><option value="2">第 2 名</option><option value="3">第 3 名</option></select></div></article>)}</div><label className="field comparison-reason"><span>共识说明 <small>允许并列，名次须从 1 开始且连续</small></span><textarea className="input" disabled={loading || saving || loadError} rows={2} value={rankingReason} onChange={event => { setRankingReason(event.target.value); setDirty(true); }} placeholder="记录共同认可的优势、短板及并列原因…" /></label><footer className="comparison-save-footer"><span><Info size={14} />联合排名单独保存，不补填 GSB。</span><button className="btn btn-primary" onClick={() => void saveRanking()} disabled={loading || saving || loadError}><Save size={15} />{saving ? '保存中…' : '保存联合排名'}</button></footer></section>}
    <div className="comparison-bottom-note"><CheckCircle2 size={14} />统计仅累计你在本机实际提交的演示记录，重复保存同题同产品对不会增加比较次数。<button onClick={() => { const next = visibleQuestions.find(q => q.id > questionId); if (next) changeQuestion(next.id); else onToast('已到本组最后一题。'); }}>继续下一题<ArrowRight size={13} /></button></div>
  </div>;
}
