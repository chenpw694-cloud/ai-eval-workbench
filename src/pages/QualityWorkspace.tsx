import AnchorRatings from '../components/AnchorRatings';
import type { DimensionRatings } from '../core/model';
import { isAnchorMode, imageRatingDimensions } from '../core/ratings';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, Download, Eye, FileCheck2, FlaskConical, LoaderCircle, ShieldCheck, Upload } from 'lucide-react';
import type { Asset, ProjectBundle, TagAssignment } from '../core/model';
import { createQualityBatch, judgmentDisagreement, emptyQuality, latestQuality, qualitySummary } from '../core/quality';
import type { QualityBatch, QualityDecision, QualityJudgment, QualityKind, QualityState, QualityTask } from '../core/quality';
import { allowedSeverities } from '../core/assessment';
import { exportIndependent, importIndependent, importJudgments, listReviewSpaces, saveQuality, saveReviewSpace, spaceAsset } from '../storage/quality';
import type { ReviewSpace } from '../storage/quality';
import { getAsset } from '../storage/projects';
import { PageHeading, PanelHeading, Pill } from '../ui';
import './quality-workspace.css';

const labels: Record<QualityKind, string> = { calibration: '独立校准', review: '交叉复评', recheck: '全量复查', gsb: '自家 vs 竞品 GSB' };
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const dirtySources = new Set<symbol>();
export function useDirty(dirty: boolean) {
  const source = useRef(Symbol()).current;
  useEffect(() => {
    if (dirty) dirtySources.add(source); else dirtySources.delete(source);
    window.dispatchEvent(new CustomEvent('formal-dirty', { detail: dirtySources.size > 0 }));
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => { window.removeEventListener('beforeunload', guard); dirtySources.delete(source); window.dispatchEvent(new CustomEvent('formal-dirty', { detail: dirtySources.size > 0 })); };
  }, [dirty]);
}
type FilesResult = Awaited<ReturnType<typeof exportIndependent>>;
function Downloads({ files }: { files: FilesResult['files'] }) {
  return <section className="panel quality-panel"><PanelHeading title="下载清单和全部原图分包" subtitle="这些文件属于同一次导出，请一起传递。"/>{files.map(file => <div className="quality-file" key={file.name}><code>{file.name}</code><span>{(file.blob.size / 1024).toFixed(1)} KB</span><button className="btn btn-small" onClick={() => { const url = URL.createObjectURL(file.blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }}><Download size={14}/>下载文件</button></div>)}</section>;
}
function TagEditor({ bundle, tags, onChange }: { bundle: ProjectBundle; tags: TagAssignment[]; onChange: (tags: TagAssignment[]) => void }) {
  return <div className="quality-tag-grid">{bundle.project.scheme.tags.filter(tag => ['A', 'B', 'C', 'F'].includes(tag.dimension)).map(def => {
    const current = tags.find(tag => tag.code === def.code);
    return <div className={current ? 'selected' : ''} key={def.code}><label><input type="checkbox" checked={!!current} onChange={event => onChange(event.target.checked ? [...tags, { code: def.code, severity: def.severity }] : tags.filter(tag => tag.code !== def.code))}/><code>{def.code}</code>{def.name}</label>{current && <select className="input" aria-label={`${def.code}复评严重等级`} value={current.severity} onChange={event => onChange(tags.map(tag => tag.code === def.code ? { ...tag, severity: event.target.value as TagAssignment['severity'] } : tag))}>{allowedSeverities(def).map(level => <option key={level}>{level}</option>)}</select>}</div>;
  })}</div>;
}
function Evidence({ bundle, task, loader }: { bundle: ProjectBundle; task: QualityTask; loader: (id: string) => Promise<Asset | undefined> }) {
  const [images, setImages] = useState<{ id: string; url: string; best: boolean; caption: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; const urls: string[] = [];
    setImages([]); setError('');
    const references = bundle.assets.filter(asset => asset.questionId === task.questionId && asset.role === 'reference').map(asset => ({ id: asset.id, best: false, caption: '参考图' }));
    const outputs = task.evidence.flatMap(evidence => evidence.mediaIds.map(id => ({ id, best: id === evidence.bestMediaId, caption: bundle.project.products.find(row => row.id === evidence.productId)?.name ?? '产品' })));
    Promise.all([...references, ...outputs].map(async item => {
      const asset = await loader(item.id); if (!asset) throw new Error('原图缺失，不能独立判断');
      const url = URL.createObjectURL(asset.blob); urls.push(url); return { ...item, url };
    })).then(rows => { if (active) setImages(rows); }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [task.id, loader]);
  const question = bundle.project.questions.find(row => row.id === task.questionId);
  return <section className="panel quality-panel"><PanelHeading title={question?.title || task.questionId} subtitle={`${task.questionId} · ${question?.scene ?? ''} · ${question?.difficulty ?? ''}`}/><p>{question?.request}</p><ul>{question?.acceptance.map((text, index) => <li key={index}>{text}</li>)}</ul>{error && <p role="alert" className="quality-error">{error}</p>}<div className="quality-evidence">{images.map(image => <figure key={image.id}><a href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt={`${image.caption}${image.best ? '最佳图' : '原始输出'}`}/></a><figcaption>{image.caption} {image.best ? '· 固定最佳图' : ''}</figcaption></figure>)}</div>{!task.evidence.every(row => row.bestMediaId) && <p className="quality-error">此任务含零输出或缺少最佳图。不能按无标签记满分；请提交“无法判断”并说明原因。</p>}<small>{task.kind === 'gsb' ? '点击图片查看原图。直接比较同题固定最佳图，记录自家胜、平或负。' : '点击图片查看原图。仅对固定最佳图填写 A / B / C / F，G 的操作体验不在本轮图像复评范围。'}</small></section>;
}

export default function QualityWorkspace({ bundle, onRefresh, onToast }: { bundle: ProjectBundle; onRefresh: () => Promise<void>; onToast: (text: string) => void }) {
  const state = bundle.quality ?? emptyQuality();
  const stats = qualitySummary(bundle);
  const [kind, setKind] = useState<QualityKind>('calibration');
  const [seed, setSeed] = useState('ecommerce-round-1');
  const [confirmed, setConfirmed] = useState(false);
  const [batchId, setBatchId] = useState(state.batches[0]?.id ?? '');
  const [reviewerId, setReviewerId] = useState(bundle.project.members[0]?.id ?? '');
  const [files, setFiles] = useState<FilesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [taskId, setTaskId] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const editPending = useRef(false);
  useDirty(busy);
  const batch = state.batches.find(row => row.id === batchId);
  const judgments = latestQuality(state.judgments, row => row.taskId);
  const visibleTasks = state.tasks.filter(task => task.batchId === batchId);
  const allReturned = visibleTasks.length > 0 && visibleTasks.every(task => judgments.some(row => row.taskId === task.id));
  const task = visibleTasks.find(task => task.id === taskId);
  async function run(action: () => Promise<void>) { setBusy(true); try { await action(); } catch (error) { onToast(message(error)); } finally { setBusy(false); } }
  return <>
    <PageHeading eyebrow="QUALITY & INDEPENDENT JUDGMENT" title="校准、复评与 GSB" description="固定证据与样本，独立判断后揭示差异；原判断、裁决与最终引用分别保存。"/>
    <div className="formal-note"><ShieldCheck size={18}/>独立包会实际移除原标签、分数、可用性、备注、成本和审计。接收者需使用未导入完整项目的浏览器配置；本地工具无法验证记忆或防止主动查阅旧文件。</div>
    <div className="metric-grid formal-metrics"><div className="metric-card"><div className="metric-title">独立判断<FileCheck2 size={17}/></div><div className="metric-value">{stats.completed}<small>/ {stats.expected}</small></div><p>含校准、复评、复查与 GSB，互不混算</p></div><div className="metric-card"><div className="metric-title">尚待裁决</div><div className="metric-value">{stats.unresolved.length}</div><p>裁决不改变原始一致率</p></div><div className="metric-card"><div className="metric-title">触发全量复查</div><div className="metric-value">{stats.reviews.filter(row => row.trigger).length}</div><p>正式 10 题完成后，至少 4 题不一致</p></div></div>
    <section className="panel quality-panel"><PanelHeading title="建立固定任务批次" subtitle="小项目按实际题量试跑并明确标识；不能重抽样来改变结果。"/><fieldset disabled={busy} className="quality-form"><label className="field">任务类型<select className="input" value={kind} onChange={event => setKind(event.target.value as QualityKind)}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="field">抽样种子<input className="input" value={seed} onChange={event => setSeed(event.target.value)}/></label><label className="quality-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>确认 A/B/C/F；任一维度相差 ≥2 分，或 P0/P1 编码及实际等级集合不同即不一致。</label><button className="btn btn-primary" disabled={!confirmed} onClick={() => void run(async () => { const source = kind === 'recheck' ? stats.reviews.find(row => row.trigger)?.batchId ?? null : null; const next = createQualityBatch(bundle, kind, seed, uuid, now(), source); await saveQuality(bundle, next); setBatchId(next.batches.at(-1)!.id); await onRefresh(); onToast('固定批次已建立，抽样种子和基线修订已保存'); })}><FlaskConical size={16}/>建立任务批次</button></fieldset><p className="muted">校准先准备共同 5 题的原图和最佳图草稿；交叉复评在初评完成后固定每产品 10 题。GSB 需要一个自家产品与各竞品均有有效提交。</p></section>
    <div className="quality-columns"><section className="panel quality-panel"><PanelHeading title="分发独立任务" subtitle="每位成员领取自己的任务，不携带其他人的判断。"/><fieldset disabled={busy} className="quality-form"><label className="field">固定批次<select className="input" value={batchId} onChange={event => { if(dirtySources.size && !window.confirm('裁决输入尚未保存，切换会丢失输入，是否继续？')) return; setBatchId(event.target.value); setTaskId(''); }}><option value="">请选择批次</option>{state.batches.map(row => <option key={row.id} value={row.id}>{labels[row.kind]} · {row.trial ? '试跑' : '正式样本'} · {row.seed}</option>)}</select></label><label className="field">领取成员<select className="input" value={reviewerId} onChange={event => setReviewerId(event.target.value)}>{bundle.project.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><button className="btn" disabled={!batchId} onClick={() => void run(async () => { setFiles(await exportIndependent(bundle, batchId, reviewerId)); onToast('已生成不含原评分的独立任务包'); })}><Download size={15}/>生成独立任务包</button></fieldset>{batch && <p className="muted">抽样 {batch.sampled.length} 题 · 基线绑定 {visibleTasks.length} 份任务 · {batch.trial ? '试跑样本不触发正式 3/10 阈值' : '正式样本'}。种子：{batch.seed}</p>}<a className="btn" href="#/projects/independent">打开独立评审空间<ArrowDownToLine size={15}/></a></section>
    <section className="panel quality-panel"><PanelHeading title="收回独立判断" subtitle="核对项目、任务、基线与修订，重复记录不增加计数。"/><input ref={input} type="file" multiple accept=".json,.zip" hidden onChange={event => { const selected = [...event.target.files ?? []]; if (selected.length) void run(async () => { const result = await importJudgments(bundle, selected); await onRefresh(); onToast(`已合入 ${result.added} 份新独立修订；原判断不被覆盖`); }); event.target.value = ''; }}/><button className="upload-zone" disabled={busy} onClick={() => input.current?.click()}><Upload size={25}/><strong>选择返回清单和全部 ZIP</strong><span>原任务、抽样或证据被修改时拒绝合入</span></button></section></div>
    {files && <Downloads files={files.files}/>}
    <section className="panel quality-panel"><PanelHeading title="交叉复评一致率" subtitle="仅比较原始独立判断与固定初评基线；未完成样本只显示已成对部分，不宣称完整一致率。"/><div className="table-wrap"><table className="table"><thead><tr><th>产品 / 批次</th><th>完成</th><th>不一致</th><th>一致率</th><th>已见 / 校准重叠</th><th>后续处理</th></tr></thead><tbody>{stats.reviews.map(row => <tr key={`${row.batchId}:${row.productId}`}><td>{bundle.project.products.find(product => product.id === row.productId)?.name}<small>{labels[row.kind]}{row.trial ? ' · 试跑' : ''}</small></td><td>{row.completed}/{row.expected}</td><td>{row.different}</td><td>{row.rate === null ? '—' : `${(row.rate * 100).toFixed(0)}%${row.completed < row.expected ? '（已成对）' : ''}`}</td><td>{row.exposed}</td><td>{row.trigger ? '必须全量复查' : row.completed < row.expected ? '等待独立判断' : '逐项处理分歧'}</td></tr>)}</tbody></table></div></section>
    <section className="panel quality-panel"><PanelHeading title="GSB 净胜率" subtitle="以左侧自家产品为基准；平局进入分母。模拟自家比较单列，不进入真实竞品排名。"/><div className="table-wrap"><table className="table"><thead><tr><th>对比竞品</th><th>完成</th><th>胜 / 平 / 负</th><th>净胜率</th><th>数据性质</th></tr></thead><tbody>{stats.gsb.map(row => <tr key={row.productId}><td>{bundle.project.products.find(product => product.id === row.productId)?.name}</td><td>{row.n}/{row.expected}</td><td>{row.wins}/{row.ties}/{row.losses}</td><td>{row.net === null ? '—' : `${(row.net * 100).toFixed(1)}%`}</td><td>{row.demo ? '含模拟数据' : '真实对象'} · 已见 {row.exposed}</td></tr>)}</tbody></table></div></section>
    <section className="panel quality-panel"><PanelHeading title="提交后揭示与讨论" subtitle="当前批次全部独立判断返回后才揭示，不能用裁决回填原始一致率。"/>{!allReturned ? <p className="quality-empty"><Eye size={20}/>当前批次尚未收齐独立判断，原评分与差异保持隐藏。</p> : <><div className="table-wrap"><table className="table"><thead><tr><th>任务</th><th>成员</th><th>判断</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleTasks.map(item => { const judgment = judgments.find(row => row.taskId === item.id)!; const original = bundle.evaluations.find(row => row.id === item.evidence[0].baselineId); const different = original && item.kind !== 'gsb' && !judgment.unable && judgmentDisagreement(original, judgment, bundle); return <tr key={item.id}><td>{item.questionId} · {bundle.project.products.find(row => row.id === item.evidence[0].productId)?.name}</td><td>{bundle.project.members.find(row => row.id === item.reviewerId)?.name}</td><td>{judgment.unable ? '无法判断' : item.kind === 'gsb' ? judgment.choice : (isAnchorMode(bundle.project.scheme) ? Object.entries(judgment.ratings ?? {}).map(([id,r]) => `${id} ${r.score}分`).join(' · ') : judgment.tags.map(tag => `${tag.code}/${tag.severity}`).join('、')) || '无问题标签'}</td><td>{different ? '存在分歧' : '已返回'}{item.previouslySeen || judgment.exposed ? ' · 有已见记录' : ''}</td><td>{item.kind !== 'gsb' && <button className="btn btn-small" onClick={() => { if(!dirtySources.size || window.confirm('裁决输入尚未保存，切换会丢失输入，是否继续？')) setTaskId(item.id); }}>查看与裁决</button>}</td></tr>; })}</tbody></table></div>{task && <DecisionPanel key={task.id} bundle={bundle} task={task} judgment={judgments.find(row => row.taskId === task.id)!} onSave={async next => { setBusy(true); try { await saveQuality(bundle, next); await onRefresh(); onToast('裁决与最终引用已保存，原判断和一致率保留'); return true; } catch(error) { onToast(message(error)); return false; } finally { setBusy(false); } }}/>}</>}</section>
    <div className="formal-note">若校准后需修改规则，请创建新项目并重新确认；本版不静默迁移旧评分。完成质检后，可在“联合排名”固定同题最佳图，再到“报告与检查”整理结论。</div>
  </>;
}

function DecisionPanel({ bundle, task, judgment, onSave }: { bundle: ProjectBundle; task: QualityTask; judgment: QualityJudgment; onSave: (next: QualityState) => Promise<boolean> }) {
  const [tags, setTags] = useState(judgment.tags);
  const [ratings, setRatings] = useState<DimensionRatings>(structuredClone(judgment.ratings ?? {}));
  const [reason, setReason] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [usable, setUsable] = useState(false);
  const [busy, setBusy] = useState(false);
  const original = bundle.evaluations.find(row => row.id === task.evidence[0].baselineId);
  const [changed, setChanged] = useState(false);
  useDirty(changed || !!reason || participants.length > 0 || busy);
  return <div className="quality-decision"><Evidence bundle={bundle} task={task} loader={getAsset}/><p>初评标签：{original?.tags.map(tag => `${tag.code}/${tag.severity}`).join('、') || '无标签'}；独立判断：{judgment.tags.map(tag => `${tag.code}/${tag.severity}`).join('、') || '无标签'}。</p><fieldset disabled={busy}><h3>{task.kind === 'calibration' ? '保存校准锚点' : '保存裁决并更新最终引用'}</h3>{isAnchorMode(bundle.project.scheme) && <><p className="anchor-readonly">初评锚点：{Object.entries(original?.ratings ?? {}).filter(([id]) => imageRatingDimensions.includes(id)).map(([id,r]) => `${id} ${r.score}分（${r.reason}）`).join('；')}<br/>独立锚点：{Object.entries(judgment.ratings ?? {}).map(([id,r]) => `${id} ${r.score}分（${r.reason}）`).join('；')}</p><AnchorRatings scheme={bundle.project.scheme} dimensions={imageRatingDimensions} values={ratings} onChange={value => { setRatings(value); setChanged(true); }}/></>}<TagEditor bundle={bundle} tags={tags} onChange={value => { setTags(value); setChanged(true); }}/><label className="quality-check"><input type="checkbox" checked={usable} onChange={event => { setUsable(event.target.checked); setChanged(true); }}/>裁决后最佳图可用（P0/P1 问题不能勾选）</label><div className="quality-checks">{bundle.project.members.map(member => <label key={member.id}><input type="checkbox" checked={participants.includes(member.id)} onChange={event => setParticipants(event.target.checked ? [...participants, member.id] : participants.filter(id => id !== member.id))}/>{member.name}</label>)}</div><label className="field">裁决依据<textarea className="input" value={reason} onChange={event => setReason(event.target.value)} placeholder="记录参与讨论的人、判断依据及最终采用口径"/></label><button className="btn btn-primary" disabled={!participants.length || !reason.trim() || judgment.unable} onClick={async () => {
    const state = structuredClone(bundle.quality!); const previous = latestQuality(state.decisions, row => row.taskId).find(row => row.taskId === task.id);
    const decision: QualityDecision = { id: uuid(), taskId: task.id, judgmentId: judgment.id, parentId: previous?.id ?? null, participants, tags, ...(isAnchorMode(bundle.project.scheme) ? { ratings } : {}), usable, reason, createdAt: now() };
    state.decisions.push(decision);
    if (task.kind !== 'calibration') state.finals = [...state.finals?.filter(row => row.baselineId !== task.evidence[0].baselineId) ?? [], { baselineId: task.evidence[0].baselineId, decisionId: decision.id }];
    setBusy(true); try { const saved = await onSave(state); if (saved) { setReason(''); setParticipants([]); setChanged(false); } } finally { setBusy(false); }
  }}><CheckCircle2 size={15}/>保存独立裁决</button></fieldset></div>;
}

export function IndependentPortal({ onToast }: { onToast: (text: string) => void }) {
  const [spaces, setSpaces] = useState<ReviewSpace[]>([]);
  const [selected, setSelected] = useState('');
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<FilesResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const editPending = useRef(false);
  const space = spaces.find(row => row.id === selected);
  const task = space?.bundle.quality?.tasks.find(row => row.id === taskId) ?? space?.bundle.quality?.tasks[0];
  useDirty(busy);
  useEffect(() => { listReviewSpaces().then(setSpaces).catch(error => onToast(message(error))); }, []);
  useEffect(() => { const listener = (event: Event) => { editPending.current = !!(event as CustomEvent).detail; }; window.addEventListener('formal-dirty', listener); return () => window.removeEventListener('formal-dirty', listener); }, []);
  function switchAllowed() { if (editPending.current && !window.confirm('当前独立判断尚未保存，切换会丢失输入，是否继续？')) return false; editPending.current = false; return true; }
  async function run(action: () => Promise<void>) { setBusy(true); try { await action(); } catch (error) { onToast(message(error)); } finally { setBusy(false); } }
  return <><PageHeading eyebrow="INDEPENDENT REVIEW SPACE" title="独立评审空间" description="只接收定向任务包，固定领取人；不加载完整项目，不显示原分或他人的判断。"/><div className="formal-note"><ShieldCheck size={18}/>使用没有导入原项目的浏览器配置。系统仅能检查当前站点的数据，无法检测别的来源、旧文件或已经看过的内容。</div><section className="panel quality-panel"><input ref={input} type="file" multiple accept=".json,.zip" hidden onChange={event => { const selected = [...event.target.files ?? []]; if (selected.length) void run(async () => { const row = await importIndependent(selected); setSpaces(await listReviewSpaces()); setSelected(row.id); setTaskId(''); setFiles(null); onToast('独立任务已校验并保存；重复导入保留已有判断'); }); event.target.value = ''; }}/><button className="btn btn-primary" disabled={busy} onClick={() => { if (switchAllowed()) input.current?.click(); }}><Upload size={16}/>导入独立任务包</button><label className="field">当前独立空间<select className="input" value={selected} onChange={event => { if (!switchAllowed()) return; setSelected(event.target.value); setTaskId(''); setFiles(null); }}><option value="">请选择已领取任务</option>{spaces.map(row => <option key={row.id} value={row.id}>{labels[row.bundle.quality!.batches[0].kind]} · {row.bundle.project.members.find(member => member.id === row.bundle.quality!.space!.reviewerId)?.name} · {row.bundle.quality!.tasks.length} 任务</option>)}</select></label></section>{space && <><section className="panel quality-panel"><label className="field">评审任务<select className="input" value={task?.id ?? ''} onChange={event => { if (switchAllowed()) setTaskId(event.target.value); }}>{space.bundle.quality!.tasks.map(row => <option key={row.id} value={row.id}>{row.questionId} · {space.bundle.project.products.find(product => product.id === row.evidence[0].productId)?.name} · {latestQuality(space.bundle.quality!.judgments, row => row.taskId).some(judgment => judgment.taskId === row.id) ? '已提交' : '待判断'}</option>)}</select></label><button className="btn" disabled={busy} onClick={() => void run(async () => { if (editPending.current) throw new Error('请先提交当前独立判断，再导出返回包'); const metadata = space.bundle.quality!.space!; setFiles(await exportIndependent(space.bundle, metadata.batchId, metadata.reviewerId, true, id => spaceAsset(space, id))); onToast('返回包已生成，请下载并交给负责人'); })}><Download size={15}/>导出我的独立判断</button></section>{task && <IndependentEditor key={`${space.id}:${task.id}`} space={space} task={task} onSaved={next => { setSpaces(previous => previous.map(row => row.id === next.id ? next : row)); }}/>}</>}{files && <Downloads files={files.files}/>}</>;
}

function IndependentEditor({ space, task, onSaved }: { space: ReviewSpace; task: QualityTask; onSaved: (space: ReviewSpace) => void }) {
  const state = space.bundle.quality!;
  const existing = latestQuality(state.judgments, row => row.taskId).find(row => row.taskId === task.id);
  const [tags, setTags] = useState(existing?.tags ?? []);
  const [ratings, setRatings] = useState<DimensionRatings>(structuredClone(existing?.ratings ?? {}));
  const [choice, setChoice] = useState<QualityJudgment['choice']>(existing?.choice ?? null);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [unable, setUnable] = useState(existing?.unable ?? false);
  const [exposed, setExposed] = useState(existing?.exposed ?? task.previouslySeen);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loader = useRef((id: string) => spaceAsset(space, id)).current;
  useDirty(dirty || busy);
  const editable = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setDirty(true); };
  return <><Evidence bundle={space.bundle} task={task} loader={loader}/><section className="panel quality-panel"><PanelHeading title="独立判断" subtitle={`固定领取人：${space.bundle.project.members.find(row => row.id === task.reviewerId)?.name} · ${existing ? `已保存第 ${existing.revision} 版，修改会新增后继` : '尚未提交'} · ${task.demo ? '含模拟数据' : '真实对象'}`}/><fieldset disabled={busy}>{task.kind === 'gsb' ? <><p>左侧：{space.bundle.project.products.find(row => row.id === task.evidence[0].productId)?.name}（自家）；右侧：{space.bundle.project.products.find(row => row.id === task.evidence[1].productId)?.name}。</p><div className="quality-gsb">{([['win', '自家更好'], ['tie', '两者相当'], ['loss', '竞品更好']] as const).map(([id, label]) => <label key={id}><input type="radio" name="gsb-choice" checked={choice === id} onChange={() => editable(setChoice)(id)}/>{label}</label>)}</div></> : <>{isAnchorMode(space.bundle.project.scheme) && !unable && <AnchorRatings scheme={space.bundle.project.scheme} dimensions={imageRatingDimensions} values={ratings} onChange={editable(setRatings)}/>}<TagEditor bundle={space.bundle} tags={tags} onChange={editable(setTags)}/></>}<label className="quality-check"><input type="checkbox" checked={unable} onChange={event => editable(setUnable)(event.target.checked)}/>证据不足，无法判断（不计入一致率或 GSB 分母）</label><label className="quality-check"><input type="checkbox" checked={exposed} onChange={event => editable(setExposed)(event.target.checked)}/>此前看过相关初评、校准或讨论结果</label><label className="field">判断依据与存疑（无法判断时必填，其余选填）<textarea className="input" value={notes} onChange={event => editable(setNotes)(event.target.value)} placeholder="记录判断依据；无法判断时必须说明原因"/></label>{error && <p className="quality-error" role="alert">{error}</p>}<button className="btn btn-primary" onClick={async () => {
    setError('');
    if (!unable && task.evidence.some(row => !row.bestMediaId)) { setError('缺少最佳图，请记录无法判断'); return; }
    if (task.kind === 'gsb' && !choice && !unable) { setError('请选择自家胜、平或负'); return; }
    const row: QualityJudgment = { id: uuid(), taskId: task.id, reviewerId: task.reviewerId, parentId: existing?.id ?? null, revision: (existing?.revision ?? 0) + 1, tags, ...(task.kind !== 'gsb' && isAnchorMode(space.bundle.project.scheme) ? { ratings } : {}), choice, notes, unable, exposed: exposed || task.previouslySeen, createdAt: now() };
    setBusy(true); try { const next = await saveReviewSpace(space, { ...state, judgments: [...state.judgments, row] }); onSaved(next); setDirty(false); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }}>{busy ? <LoaderCircle size={15} className="spin"/> : <FileCheck2 size={15}/>}提交独立判断</button></fieldset></section></>;
}
