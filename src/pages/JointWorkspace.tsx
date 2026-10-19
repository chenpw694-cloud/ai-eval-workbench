import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Columns2, LockKeyhole, Users } from 'lucide-react';
import type { Asset, ProjectBundle } from '../core/model';
import type { QualityState } from '../core/quality';
import { emptyQuality } from '../core/quality';
import { createJointPlan, jointPolicy, jointSummary, latestRankings } from '../core/joint';
import type { JointRanking } from '../core/joint';
import { digest, getAsset } from '../storage/projects';
import { PageHeading, PanelHeading, Pill } from '../ui';
import { useDirty } from './QualityWorkspace';
import './report-workspace.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : '保存失败';
type Props = { bundle: ProjectBundle; onSave: (state: QualityState) => Promise<void>; onToast: (message: string) => void; loader?: (id: string) => Promise<Asset | undefined> };
export default function JointWorkspace({ bundle, onSave, onToast, loader = getAsset }: Props) {
  const joint = bundle.quality?.joint, policy = jointPolicy(bundle.project.scheme), stats = jointSummary(bundle);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [questionId, setQuestionId] = useState(joint?.plan.questionIds[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const taskId = joint?.plan.questionIds.includes(questionId) ? questionId : joint?.plan.questionIds[0];
  useDirty(!joint && (selected.length > 0 || !!reason) || busy);
  const products = bundle.project.products.filter(p => !p.demo);
  return <>
    <PageHeading eyebrow="JOINT COMPARISON" title="同一题，看见产品差距" description="共同挑选样本、并排讨论最佳图，再以两两净胜率验证评分结论。模拟对象不进入联合排名。"/>
    <div className="report-process"><span><Columns2 size={17}/>固定场景样本</span><ArrowRight size={15}/><span><Users size={17}/>共同讨论排名</span><ArrowRight size={15}/><span><Check size={17}/>形成对比证据</span></div>
    {!joint ? <>
      <section className="panel report-panel"><PanelHeading title="共同挑选评审样本" subtitle={`每个场景 ${policy.perScene} 题，共 ${policy.scenes.length * policy.perScene} 题；兼顾品类和难度，固定后不能替换。`}/>
        <div className="report-scene-grid">{policy.scenes.map(scene => {
          const questions = bundle.project.questions.filter(q => q.scene === scene), target = Math.min(policy.perScene, questions.length), count = selected.filter(id => questions.some(q => q.id === id)).length;
          return <section className="report-scene" key={scene}><header><strong>{scene}</strong><Pill tone={count === target && target > 0 ? 'green' : 'neutral'}>{count}/{target}</Pill></header>{questions.map(q => <label key={q.id}><input type="checkbox" checked={selected.includes(q.id)} disabled={busy || !selected.includes(q.id) && count >= target} onChange={event => setSelected(event.target.checked ? [...selected, q.id] : selected.filter(id => id !== q.id))}/><span><b>{q.id} · {q.title}</b><small>{q.category} · {q.difficulty}</small></span></label>)}{!questions.length && <p>题库尚无这个场景，当前只能试跑。</p>}</section>;
        })}</div>
        <label className="field">共同选题依据<textarea className="input" value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="说明如何覆盖不同品类、难度及有代表性的差异。"/></label>
        <button className="btn btn-primary" disabled={busy || !selected.length || !reason.trim()} onClick={async () => { setBusy(true); try { const next = createJointPlan(bundle, selected, reason, crypto.randomUUID(), new Date().toISOString()); await onSave({ ...bundle.quality ?? emptyQuality(), joint: next }); setSelected([]); setReason(''); setQuestionId(next.plan.questionIds[0]); onToast('样本与最佳图已固定，可以开始共同排名'); } catch(error) { onToast(errorText(error)); } finally { setBusy(false); } }}><LockKeyhole size={15}/>固定样本并开始</button>
      </section>
      <div className="report-note"><AlertCircle size={16}/>需先完成全部真实产品的有效初评。题量不足或场景不足时明确标记为试跑，不能作为正式联合评审完成。</div>
    </> : <>
      <div className="report-summary-row"><div><Pill tone={joint.plan.trial ? 'orange' : 'green'}>{joint.plan.trial ? '试跑样本' : '正式样本已固定'}</Pill><strong>{stats.completed}<small>/ {stats.expected} 题有效排名</small></strong><span>{stats.unable} 题无法判断</span></div><p>{joint.plan.selectionReason}</p></div>
      {stats.stale && <div className="quality-error" role="alert">部分初评已生成新修订。此处仍使用固定的历史最佳图，报告将提示证据过期，不会自动替换图片。</div>}
      <div className="report-question-strip">{joint.plan.questionIds.map(id => { const rank = latestRankings(joint.rankings).find(row => row.questionId === id); return <button className={`btn btn-small ${taskId === id ? 'btn-primary' : ''}`} key={id} onClick={() => { if (editing && !window.confirm('排名修改尚未保存，切换会丢失输入，是否继续？')) return; setEditing(false); setQuestionId(id); }}>{id}{rank ? rank.unable ? ' · 存疑' : ' ✓' : ''}</button>; })}</div>
      {taskId && <RankingEditor key={`${taskId}:${joint.rankings.length}`} bundle={bundle} questionId={taskId} loader={loader} onChanged={setEditing} onSave={onSave} onToast={onToast}/>}
      <section className="panel report-panel"><PanelHeading title="联合排名净胜率" subtitle="以左侧产品为基准；平局进入分母，无法判断排除。下表独立于自家对竞品 GSB。"/><div className="table-wrap"><table className="table"><thead><tr><th>产品对比</th><th>胜 / 平 / 负</th><th>有效 / 应评</th><th>净胜率</th></tr></thead><tbody>{stats.pairs.map(pair => <tr key={`${pair.left}:${pair.right}`}><td>{products.find(p => p.id === pair.left)?.name} / {products.find(p => p.id === pair.right)?.name}</td><td>{pair.wins} / {pair.ties} / {pair.losses}</td><td>{pair.n} / {stats.expected}</td><td><strong>{pair.net === null ? '—' : `${(pair.net * 100).toFixed(1)}%`}</strong></td></tr>)}</tbody></table></div></section>
    </>}
  </>;
}
function RankingEditor({ bundle, questionId, loader, onSave, onToast, onChanged }: Omit<Props, 'loader'> & { questionId: string; loader: NonNullable<Props['loader']>; onChanged: (changed: boolean) => void }) {
  const state = bundle.quality!, joint = state.joint!;
  const current = latestRankings(joint.rankings).find(row => row.questionId === questionId);
  const question = bundle.project.questions.find(q => q.id === questionId)!;
  const [ranks, setRanks] = useState<Record<string, string>>(Object.fromEntries(joint.plan.productIds.map(id => [id, current?.ranks.find(r => r.productId === id)?.rank.toString() ?? ''])));
  const [participants, setParticipants] = useState(current?.participants ?? []);
  const [reason, setReason] = useState(current?.reason ?? '');
  const [unable, setUnable] = useState(current?.unable ?? false);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [images, setImages] = useState<Record<string, string>>({}), [imageError, setImageError] = useState('');
  useDirty(dirty || busy);
  useEffect(() => { onChanged(dirty); }, [dirty]);
  useEffect(() => {
    let active = true; const urls: string[] = [];
    Promise.all(joint.plan.evidence.filter(e => e.questionId === questionId).map(async e => {
      const asset = await loader(e.bestMediaId);
      if (!asset || asset.sha256 !== e.sha256 || await digest(await asset.blob.arrayBuffer()) !== e.sha256) throw new Error('固定最佳图缺失或与基线不符，不能排名');
      const url = URL.createObjectURL(asset.blob); urls.push(url); return [e.productId, url];
    })).then(rows => { if (active) setImages(Object.fromEntries(rows)); }).catch(error => { if (active) setImageError(errorText(error)); });
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [questionId, loader]);
  return <section className="panel report-panel"><PanelHeading title={`${questionId} · ${question.title}`} subtitle={`${question.scene} · ${question.category} · ${question.difficulty}`}/><p className="report-request">{question.request}</p><ul className="report-acceptance">{question.acceptance.map((text, i) => <li key={i}>{text}</li>)}</ul>
    <fieldset disabled={busy} className="report-fieldset"><div className="report-best-grid">{joint.plan.productIds.map(id => { const product = bundle.project.products.find(p => p.id === id)!; return <div className="report-best" key={id}><header><strong>{product.name}</strong><span>{product.version}</span></header><div className="report-best-image">{images[id] ? <a href={images[id]} target="_blank" rel="noreferrer"><img src={images[id]} alt={`${product.name}的固定最佳图`}/></a> : <span>正在读取固定最佳图…</span>}</div><label className="field">{product.name}名次<select className="input" value={ranks[id]} disabled={unable} onChange={event => { setRanks({ ...ranks, [id]: event.target.value }); setDirty(true); }}><option value="">请选择名次</option>{joint.plan.productIds.map((_, index) => <option key={index} value={index + 1}>第 {index + 1} 名</option>)}</select></label></div>; })}</div>
    {imageError && <p className="quality-error" role="alert">{imageError}</p>}
    <p className="muted">相同效果可选择相同名次，至少一个第一名。此页提交前不展示原始维度分；评测员仍可能已见初评，不能宣称盲评。</p>
    <label className="quality-check"><input type="checkbox" checked={unable} onChange={event => { setUnable(event.target.checked); setDirty(true); }}/>本题无法形成有效共同排名（需说明原因，不计入净胜率分母）</label>
    <div className="quality-checks">{bundle.project.members.map(member => <label key={member.id}><input type="checkbox" checked={participants.includes(member.id)} onChange={event => { setParticipants(event.target.checked ? [...participants, member.id] : participants.filter(id => id !== member.id)); setDirty(true); }}/>{member.name}已参与</label>)}</div>
    <label className="field">共同判断依据<textarea className="input" value={reason} onChange={event => { setReason(event.target.value); setDirty(true); }} placeholder="记录排序依据、并列原因或无法判断的原因。"/></label>
    <div className="report-save-row"><span>{current ? `已有 ${joint.rankings.filter(r => r.questionId === questionId).length} 个修订，修改会追加记录` : '提交后保留固定证据、参与人和判断依据'}</span><button className="btn btn-primary" disabled={!dirty || !reason.trim() || participants.length !== bundle.project.members.length || !unable && (!!imageError || Object.keys(images).length !== joint.plan.productIds.length || joint.plan.productIds.some(id => !ranks[id]))} onClick={async () => {
      setBusy(true);
      try {
        const ranking: JointRanking = { id: crypto.randomUUID(), parentId: current?.id ?? null, questionId, participants, ranks: unable ? [] : joint.plan.productIds.map(id => ({ productId: id, rank: Number(ranks[id]) })), unable, reason: reason.trim(), createdAt: new Date().toISOString() };
        await onSave({ ...state, joint: { plan: joint.plan, rankings: [...joint.rankings, ranking] } }); setDirty(false); onChanged(false); onToast('共同排名已保存，原修订保留');
      } catch(error) { onToast(errorText(error)); } finally { setBusy(false); }
    }}><Check size={15}/>{busy ? '正在保存…' : '保存共同排名'}</button></div></fieldset>
  </section>;
}
