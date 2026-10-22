import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  AlertCircle, ArrowDownToLine, ArrowRight, Check, CheckCircle2, ChevronDown,
  Download, FileArchive, FileJson, Files, History, Info, LoaderCircle, LockKeyhole,
  PackageCheck, RefreshCw, ShieldCheck, Upload, Users, X
} from 'lucide-react';
import type { ProjectBundle } from '../core/model.ts';
import { buildHandoff } from '../core/handoff';
import type { StagePackage } from '../core/packages.ts';
import { commitStage, exportStage, inspectStage, listStageReceipts } from '../storage/stages.ts';
import { PageHeading, PanelHeading, Pill } from '../ui';
import './stage-sync.css';

type Props = {
  bundle: ProjectBundle | null;
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  onImported: (projectId: string) => void;
};

type PackageKind = 'assignment' | 'submission' | 'baseline';
type Inspection = Awaited<ReturnType<typeof inspectStage>>;
type ExportResult = Awaited<ReturnType<typeof exportStage>>;
type Receipt = Awaited<ReturnType<typeof listStageReceipts>>[number];
type Decision = 'local' | 'incoming';
type ValueRecord = Record<string, unknown>;

const kindLabels: Record<PackageKind, string> = {
  assignment: '准备分发包',
  submission: '我的初评提交包',
  baseline: '汇总主包'
};

const kindDescriptions: Record<PackageKind, string> = {
  assignment: '只包含已确认的规则、题库、分工与参考图，不含任何评分。三人使用同一项目 ID；分发后冻结评测口径。',
  submission: '仅导出所选成员负责产品的初评数据和相关原图，交给负责人合并。',
  baseline: '包含本机已合并的判断、原图及历史审计，供负责人分发或留存。含原标签和分数，不是盲复评包。'
};

function recordOf(value: unknown): ValueRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ValueRecord : {};
}

function textOf(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value ? value : fallback;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}

function formattedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function saveFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Stage schema v1 is validated by inspectStage before it reaches this view. */
function packageDetails(manifest: StagePackage) {
  const project = manifest.bundle.project;
  const scopedProducts = project.products.filter(product => manifest.productIds.includes(product.id));
  const sender = project.members.find(member => member.id === manifest.senderId);
  return {
    id: manifest.packageId,
    projectId: project.id,
    name: project.name,
    kind: manifest.kind,
    kindLabel: kindLabels[manifest.kind],
    senderId: manifest.senderId,
    senderName: sender?.name || manifest.senderId,
    createdAt: manifest.exportedAt,
    products: scopedProducts.map(product => ({
      id: product.id,
      name: product.name || '未命名产品',
      demo: product.demo
    })),
    productCount: scopedProducts.length,
    demoCount: scopedProducts.filter(product => product.demo).length,
    assetsCount: manifest.bundle.assets.length,
    members: project.members
  };
}

function Counts({ counts }: { counts: unknown }) {
  const value = recordOf(counts);
  const rows = [
    { label: '新增初评记录', key: 'newEvaluations' },
    { label: '重复初评记录', key: 'duplicateEvaluations' },
    { label: '新增原图', key: 'newAssets' },
    { label: '重复原图', key: 'duplicateAssets' },
    { label: '新增产品信息', key: 'newProductInfos' },
    { label: '重复产品信息', key: 'duplicateProductInfos' }
  ];
  return <div className="stage-counts">{rows.map(row => <div key={row.key}>
    <span>{row.label}</span><strong>{typeof value[row.key] === 'number' ? String(value[row.key]) : '0'}</strong>
  </div>)}</div>;
}

function RawDetails({ label, value }: { label: string; value: unknown }) {
  return <details className="stage-raw-details"><summary>{label}<ChevronDown size={13} /></summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

export default function StageSync({ bundle, onRefresh, onToast, onImported }: Props) {
  const project = bundle?.project ?? null;
  const [kind, setKind] = useState<PackageKind>('assignment');
  const [senderId, setSenderId] = useState('');
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [handoffDownloaded, setHandoffDownloaded] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [sourceFiles, setSourceFiles] = useState<{ name: string; size: number }[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [resolverId, setResolverId] = useState('');
  const [reason, setReason] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptError, setReceiptError] = useState('');
  const [busy, setBusy] = useState<'export' | 'inspect' | 'commit' | 'refresh' | 'bundle' | null>(null);
  const [error, setError] = useState('');
  const [committedPackageId, setCommittedPackageId] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  const activeProjectRef = useRef(project?.id ?? '');

  const unresolvedPreview = inspection !== null;
  const pendingDownloads = exported !== null && !handoffDownloaded && downloaded.length < exported.files.length;
  const unsaved = unresolvedPreview || pendingDownloads;
  dirtyRef.current = unsaved || busy !== null;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('formal-dirty', { detail: unsaved || busy !== null }));
  }, [unsaved, busy]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.dispatchEvent(new CustomEvent('formal-dirty', { detail: false }));
    };
  }, []);

  useEffect(() => {
    if (activeProjectRef.current !== (project?.id ?? '')) {
      activeProjectRef.current = project?.id ?? '';
      setExported(null);
      setDownloaded([]); setHandoffDownloaded(false);
      setSenderId('');
      setInspection(null);
      setSourceFiles([]);
      setError('');
      setCommittedPackageId('');
    }
  }, [project?.id]);

  useEffect(() => {
    let active = true;
    setReceipts([]);
    setReceiptError('');
    if (!project?.id) return;
    listStageReceipts(project.id).then(value => { if (active) setReceipts(value); })
      .catch(error => { if (active) setReceiptError(errorMessage(error)); });
    return () => { active = false; };
  }, [project?.id, committedPackageId]);

  const ownerProducts = project?.products.filter(product => product.ownerId === senderId) ?? [];
  const localProject = inspection ? packageDetails(inspection.manifest) : null;
  const memberOptions = project?.id === localProject?.projectId && project?.members.length
    ? project.members
    : localProject?.members ?? [];
  const conflicts = inspection?.plan.conflicts ?? [];
  const blockers = inspection?.plan.blockers ?? [];
  const everyConflictDecided = conflicts.every(conflict => decisions[conflict.id] === 'local' || decisions[conflict.id] === 'incoming');
  const canCommit = !!inspection && !blockers.length && everyConflictDecided && (!conflicts.length || (!!resolverId && !!reason.trim()));

  async function buildPackage() {
    if (!project || !senderId || busy) return;
    if (!project.rulesConfirmed || project.questions.length !== project.expectedQuestionCount) {
      setError('请先确认规则，并将题库补齐至计划题量后再导出阶段包。');
      return;
    }
    if (kind === 'submission' && !ownerProducts.length) {
      setError('所选成员没有负责产品，无法生成“我的初评提交包”。请先在项目配置中完成分工。');
      return;
    }
    if (pendingDownloads && !window.confirm('当前生成的数据包尚未逐项下载。重新生成会替换下载列表，确定继续？')) return;
    setBusy('export');
    setError('');
    try {
      const result = await exportStage(project.id, kind, senderId);
      setExported(result);
      setDownloaded([]); setHandoffDownloaded(false);
      onToast(`已生成${kindLabels[kind]}，可一键下载团队交接 ZIP`);
      try {
        await onRefresh();
      } catch (refreshError) {
        setError(`数据包已经成功生成，下载文件仍可使用；项目状态刷新未完成：${errorMessage(refreshError)}。分发已冻结项目口径，请重新打开项目确认状态。`);
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function downloadTeamZip() {
    if (!exported || busy) return; setBusy('bundle'); setError('');
    try {
      const preview = await (await import('../core/readableWorkbook')).readableWorkbook(exported.manifest.bundle);
      const blob = await buildHandoff(exported.files, preview);
      saveFile(`${project?.name.replace(/[\\/:*?"<>|]/g, '_') || '评测项目'}-${kindLabels[exported.manifest.kind]}-团队交接包.zip`, blob);
      setHandoffDownloaded(true); onToast('团队交接 ZIP 已下载；把这一个文件发给成员即可，接收者无需解压');
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(null); }
  }

  async function readFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || busy) return;
    if (inspection && !window.confirm('当前导入预览尚未确认，重新选择文件会清除裁决选择。确定继续？')) return;
    setBusy('inspect');
    setError('');
    setInspection(null);
    setDecisions({});
    setReason('');
    setResolverId('');
    setSourceFiles(files.map(file => ({ name: file.name, size: file.size })));
    try {
      const result = await inspectStage(files);
      setInspection(result);
      onToast(result.plan.blockers.length ? '已完成检查，存在阻止导入的问题' : '已生成导入预览，尚未写入本地数据');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function confirmImport() {
    if (!inspection || !canCommit || busy) return;
    setBusy('commit');
    setError('');
    try {
      const result = await commitStage(inspection, { decisions, resolverId, reason: reason.trim() });
      const packageId = inspection.manifest.packageId;
      setInspection(null);
      setSourceFiles([]);
      setDecisions({});
      setReason('');
      setCommittedPackageId(packageId);
      onToast(result.duplicate ? '此数据包已导入，本次未重复写入记录' : '数据包已事务导入，原判断与处理记录已保留');
      try {
        await onRefresh();
      } catch (refreshError) {
        setError(`数据包已经成功导入，但列表刷新未完成：${errorMessage(refreshError)}。请重新打开项目查看，勿将此提示误认为写入失败。`);
      }
      onImported(result.projectId);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function refreshReceipts() {
    if (!project || busy) return;
    setBusy('refresh');
    setReceiptError('');
    try {
      const result = await listStageReceipts(project.id);
      setReceipts(result);
      await onRefresh();
    } catch (error) {
      setReceiptError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function discardPreview() {
    if (busy) return;
    if (inspection && !window.confirm('放弃本次导入预览和未保存的裁决选择？本地数据尚未改变。')) return;
    setInspection(null);
    setSourceFiles([]);
    setDecisions({});
    setReason('');
    setError('');
  }

  return <div className="stage-sync-page">
    <PageHeading
      eyebrow="TEAM DATA EXCHANGE"
      title="阶段同步"
      description="通过可校验的数据包传递原图与评测记录，由负责人合并并保留裁决依据。"
      action={<Pill tone="violet">本地评测 · 手动同步</Pill>}
    />

    <div className="stage-sync-intro"><span><Users size={23} /></span><div>
      <strong>各自独立记录，在阶段节点汇合</strong>
      <p>网页不会实时上传数据。发送者下载一个团队交接 ZIP，发给成员；接收者直接选择这个 ZIP，先预览再确认，无需解压或查看 JSON。</p>
    </div><ArrowRight size={21} /></div>

    <div className="stage-flow">
      <div><span>01</span><strong>准备分发</strong><small>相同规则、题库和项目 ID</small></div><ArrowRight size={15} />
      <div><span>02</span><strong>独立初评</strong><small>导出本人负责产品的提交包</small></div><ArrowRight size={15} />
      <div><span>03</span><strong>负责人汇合</strong><small>检查差异、合并并留存收据</small></div>
    </div>

    <div className="stage-scope-note"><Info size={15} /><p>准备分发包不含评分；汇总主包包含已合并判断和审计，不能作为盲复评包。分发或开始评测后，项目题库和规则快照冻结，产品信息仍可更正。</p></div>

    {error && <div className="stage-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}

    <div className="stage-sync-columns">
      <section className="panel stage-export-panel">
        <PanelHeading title="导出阶段包" subtitle={project ? `当前项目：${project.name}` : '打开一个本地项目后即可导出。'} />
        <div className="stage-panel-body">
          {!project ? <div className="stage-empty"><PackageCheck size={30} /><strong>还没有打开项目</strong><p>可以从右侧导入团队的准备分发包，或返回项目列表创建项目。</p></div> : <>
            <label className="stage-field">数据包用途<select disabled={busy !== null} value={kind} onChange={event => setKind(event.target.value as PackageKind)}>
              {(Object.entries(kindLabels) as [PackageKind, string][]).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select><small>{kindDescriptions[kind]}</small></label>
            <label className="stage-field">发送成员<select value={senderId} disabled={busy !== null} onChange={event => setSenderId(event.target.value)}>
              <option value="">请选择发送成员</option>{project.members.map(member => <option key={member.id} value={member.id}>{member.name || '未命名成员'}</option>)}
            </select><small>成员署名用于流转与追溯，不代表身份认证。</small></label>
            <div className="stage-export-scope"><span>产品范围</span><div>
              {(kind === 'submission' ? ownerProducts : project.products).map(product => <span key={product.id}>{product.name || '未命名产品'}{product.demo && <i>模拟</i>}</span>)}
              {kind === 'submission' && !ownerProducts.length && <em>请选择已分配产品的成员</em>}
            </div></div>
            {(!project.rulesConfirmed || project.questions.length !== project.expectedQuestionCount) && <div className="stage-warning"><LockKeyhole size={15} /><p>导出前须确认规则，并补齐计划题量。当前 {project.questions.length} / {project.expectedQuestionCount} 题，规则{project.rulesConfirmed ? '已确认' : '未确认'}。</p></div>}
            <button className="btn btn-primary stage-wide-button" disabled={busy !== null || !senderId || !project.rulesConfirmed || project.questions.length !== project.expectedQuestionCount || (kind === 'submission' && !ownerProducts.length)} onClick={buildPackage}>
              {busy === 'export' ? <LoaderCircle className="spin" size={15} /> : <PackageCheck size={16} />}{busy === 'export' ? '正在校验并生成…' : '生成数据包'}
            </button>
          </>}
        </div>
      </section>

      <section className="panel stage-import-panel">
        <PanelHeading title="导入团队数据包" subtitle="直接选择团队交接 ZIP；也支持之前的 JSON 清单与全部 ZIP 分包。" />
        <div className="stage-panel-body">
          <input ref={input} type="file" multiple accept=".json,.zip,application/json,application/zip" hidden onChange={readFiles} />
          <button className="stage-file-picker" disabled={busy !== null} onClick={() => input.current?.click()}>
            <span>{busy === 'inspect' ? <LoaderCircle className="spin" size={23} /> : <Upload size={23} />}</span>
            <strong>{busy === 'inspect' ? '正在校验清单、记录与原图…' : '选择团队交接 ZIP 或原清单与分包'}</strong>
            <small>新的交接包只选一个 ZIP 即可，无需解压；检查完成前不写入数据</small>
          </button>
          {sourceFiles.length > 0 && <div className="stage-input-files">{sourceFiles.map((file, index) => <div key={`${file.name}-${index}`}><Files size={13} /><span>{file.name}</span><small>{fileSize(file.size)}</small></div>)}</div>}
          <div className="stage-import-principles"><span><CheckCircle2 size={13} />图片按内容哈希校验</span><span><CheckCircle2 size={13} />重复导入不重复计数</span><span><CheckCircle2 size={13} />不按时间戳覆盖分歧</span></div>
          {!inspection && !busy && <p className="stage-import-hint">清单和分包必须来自同一次导出。缺少分包、内容损坏或规则不兼容时，系统会拒绝导入并说明原因。</p>}
        </div>
      </section>
    </div>

    {exported && <section className="panel stage-generated-panel">
      <PanelHeading title="数据包已生成" subtitle="推荐下载一个团队交接 ZIP。包内附可阅读的 Excel 明细，并保留评分历史与原图。" action={<Pill tone={handoffDownloaded || downloaded.length === exported.files.length ? 'green' : 'orange'}>{handoffDownloaded ? '交接 ZIP 已触发下载' : `${downloaded.length} / ${exported.files.length} 项已触发下载`}</Pill>} />
      <div className="stage-handoff-download"><div><strong>{handoffDownloaded ? '团队交接包已触发下载' : '只传一个 ZIP，就能继续评测'}</strong><p>接收者将整个 ZIP 导入工作台；解压后可用 Excel 阅读明细。Excel 阅读副本不用于覆盖正式评分。</p></div><button className="btn btn-primary" disabled={busy !== null} onClick={() => void downloadTeamZip()}><FileArchive size={16}/>{busy === 'bundle' ? '正在打包…' : handoffDownloaded ? '再次下载团队交接 ZIP' : '下载团队交接 ZIP'}</button></div>
      <details className="stage-original-files"><summary>原清单与分包下载（大项目或兼容旧版）</summary>
      <div className="stage-download-files">{exported.files.map(file => <div key={file.name}><span className="stage-file-icon">{file.name.endsWith('.json') ? <FileJson size={18} /> : <FileArchive size={18} />}</span><div><strong>{file.name}</strong><small>{fileSize(file.blob.size)}{file.name.endsWith('.json') ? ' · 项目清单与记录' : ' · 原图分包'}</small></div><button className="btn btn-small" disabled={busy !== null} onClick={() => { saveFile(file.name, file.blob); setDownloaded(previous => previous.includes(file.name) ? previous : [...previous, file.name]); }}>{downloaded.includes(file.name) ? <Check size={13} /> : <Download size={13} />}{downloaded.includes(file.name) ? '再次下载' : '下载'}</button></div>)}</div>
      </details>
      <div className="stage-generated-footer"><span><Info size={13} />“已触发下载”仅表示已请求浏览器下载，请检查设备中实际保存的文件。</span><button className="stage-text-button" disabled={busy !== null} onClick={() => { if (pendingDownloads && !window.confirm('还有文件未触发下载，确认关闭本次下载列表？')) return; setExported(null); setDownloaded([]); setHandoffDownloaded(false); }}>关闭下载列表<X size={13} /></button></div>
    </section>}

    {inspection && localProject && <section className="panel stage-preview-panel">
      <PanelHeading title="导入预览" subtitle="检查范围、重复和分歧；确认后在单个事务内写入，本地已有数据在失败时保持不变。" action={<button className="stage-text-button" disabled={busy !== null} onClick={discardPreview}>放弃预览<X size={13} /></button>} />
      <div className="stage-preview-meta"><div><span>项目</span><strong>{localProject.name}</strong><code>{localProject.projectId}</code><Pill tone={inspection.plan.local ? 'violet' : 'green'}>{inspection.plan.local ? '合并本机同 ID 项目' : '在本机创建项目'}</Pill></div><div><span>数据包类型</span><strong>{localProject.kindLabel}</strong><small>{localProject.senderName}</small></div><div><span>包 ID</span><code>{localProject.id}</code><small>{localProject.createdAt ? formattedDate(localProject.createdAt) : '导出时间以清单为准'}</small></div></div>
      <Counts counts={inspection.plan.counts} />
      {inspection.alreadyImported && <div className="formal-note"><CheckCircle2 size={16}/>此包已导入；再次确认不会重复写入，也无需重复裁决。</div>}
      <div className="stage-preview-scope"><div><span>产品范围</span><p>{localProject.products.length ? localProject.products.map(product => <span key={product.id}>{product.name}{product.demo && <i>模拟</i>}</span>) : `${localProject.productCount || '以清单为准'} 个产品`}</p></div><div><span>来源范围</span><p>{localProject.demoCount} 个模拟产品{localProject.assetsCount ? ` · ${localProject.assetsCount} 项原图引用` : ''} · 模拟与真实数据保持各自标记</p></div></div>

      {blockers.length > 0 && <div className="stage-blockers"><div><AlertCircle size={17} /><strong>存在 {blockers.length} 项阻止导入的问题</strong></div><ul>{blockers.map((blocker, index) => <li key={index}>{typeof blocker === 'string' ? blocker : JSON.stringify(blocker)}</li>)}</ul><p>请修正来源数据，重新导出完整数据包后再检查。本次尚未写入。</p></div>}

      {conflicts.length > 0 ? <div className="stage-conflicts"><div className="stage-subheading"><h3>逐项处理分歧</h3><Pill tone="orange">{Object.keys(decisions).length} / {conflicts.length} 项已选择</Pill></div><p>保留本机或采用导入仅决定本次生效版本，双方原判断与裁决依据仍写入同步收据。</p>
        {conflicts.map(conflict => <article className="stage-conflict" key={conflict.id}><div className="stage-conflict-heading"><span>{conflict.kind}</span><strong>{conflict.label}</strong></div><div className="stage-conflict-options">{([{ value: 'local', label: '保留本机', data: conflict.local }, { value: 'incoming', label: '采用导入', data: conflict.incoming }] as const).map(option => <div className={decisions[conflict.id] === option.value ? 'selected' : ''} key={option.value}><label><input type="radio" name={`conflict-${conflict.id}`} checked={decisions[conflict.id] === option.value} disabled={busy !== null || blockers.length > 0} onChange={() => setDecisions(previous => ({ ...previous, [conflict.id]: option.value }))} /><strong>{option.label}</strong></label><RawDetails label="展开字段详情" value={option.data} /></div>)}</div></article>)}
        <div className="stage-resolution"><label className="stage-field">裁决成员 <span>*</span><select value={resolverId} disabled={busy !== null || blockers.length > 0} onChange={event => setResolverId(event.target.value)}><option value="">请选择负责人或裁决成员</option>{memberOptions.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label className="stage-field">统一处理依据 <span>*</span><textarea rows={3} value={reason} disabled={busy !== null || blockers.length > 0} placeholder="说明本次冲突判断和采用版本的依据，可同时引用各项记录…" onChange={event => setReason(event.target.value)} /></label></div>
      </div> : <div className="stage-no-conflict"><ShieldCheck size={17} /><span>没有需要人工裁决的冲突。重复记录与相同内容原图将自动去重。</span></div>}

      <div className="stage-preview-footer"><span>{blockers.length ? '需先解决阻止导入的问题' : conflicts.length && !canCommit ? '请完成所有分歧选择，并填写裁决成员与依据' : '检查完成，可以确认导入'}</span><button className="btn btn-primary" disabled={!canCommit || busy !== null} onClick={confirmImport}>{busy === 'commit' ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}{busy === 'commit' ? '正在导入…' : '确认导入'}</button></div>
      <RawDetails label="查看原始数据包清单" value={inspection.manifest} />
    </section>}

    {project && <section className="panel stage-receipts-panel"><PanelHeading title="同步收据" subtitle="记录每次导入的来源、统计和冲突处理依据。原始判断保留在对应收据中。" action={<button className="stage-text-button" disabled={busy !== null} onClick={refreshReceipts}><RefreshCw size={13} className={busy === 'refresh' ? 'spin' : ''} />刷新记录</button>} />
      {receiptError && <div className="stage-error" role="alert"><AlertCircle size={15} />{receiptError}</div>}
      {!receipts.length && !receiptError && <div className="stage-receipt-empty"><History size={23} /><p>此项目还没有同步收据。完成第一次团队数据导入后会出现在这里。</p></div>}
      <div className="stage-receipts">{receipts.map(receipt => {
        const item = recordOf(receipt);
        const incomingBundle = recordOf(item.incoming);
        const incomingProject = recordOf(incomingBundle.project);
        const receiptMembers = arrayOf(incomingProject.members);
        const sender = receiptMembers.find(member => recordOf(member).id === item.senderId);
        const resolution = recordOf(item.decisions);
        const receiptConflicts = arrayOf(item.conflicts).map(value => recordOf(value));
        const counts = recordOf(item.counts);
        return <details className="stage-receipt" key={textOf(item.id)}><summary><span className="stage-receipt-symbol"><CheckCircle2 size={17} /></span><span><strong>{kindLabels[textOf(item.kind, '') as PackageKind] ?? '阶段数据包'}</strong><small>{textOf(recordOf(sender).name, textOf(item.senderId))} · {formattedDate(textOf(item.importedAt, ''))}</small></span><span className="stage-receipt-stat">新增 {String(counts.newEvaluations ?? 0)} 条 · 分歧 {String(counts.conflicts ?? 0)} 项</span><ChevronDown size={15} /></summary><div className="stage-receipt-body"><div className="stage-receipt-ids"><span>包 ID <code>{textOf(item.packageId)}</code></span><span>收据 ID <code>{textOf(item.id)}</code></span></div><Counts counts={item.counts} />{receiptConflicts.length > 0 && <><h4>冲突决定与依据</h4><p className="stage-receipt-reason">裁决成员：{textOf(item.resolverId)}<br />{textOf(item.reason, '未填写')}</p><div className="stage-receipt-decisions">{receiptConflicts.map((conflict, index) => <div key={textOf(conflict.id, String(index))}><span>{textOf(conflict.label, textOf(conflict.id))}</span><Pill tone="violet">{resolution[textOf(conflict.id)] === 'incoming' ? '采用导入' : '保留本机'}</Pill></div>)}</div><RawDetails label="展开冲突双方原记录" value={item.conflicts} /></>}<RawDetails label="展开导入时原始数据（仅审计）" value={item.incoming} /><RawDetails label="展开合并前本机记录（仅审计）" value={item.before} /></div></details>;
      })}</div>
    </section>}

    <div className="stage-bottom-note"><LockKeyhole size={13} /><p>原图和评测数据只在浏览器本地保存，阶段包由你主动下载和传递。不要将真实数据包或未授权图片提交到公开代码仓库。</p></div>
  </div>;
}
