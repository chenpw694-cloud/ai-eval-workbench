import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Copy, FolderOpen, Image as ImageIcon, LoaderCircle, Search, Upload, X } from 'lucide-react';
import type { Asset, ProjectBundle } from '../core/model';
import { matchBulkImages } from '../core/bulkImageMatching';
import { matchReferenceText, parseReferenceLabels } from '../core/referenceTextMatching';
import type { ReferenceLabels } from '../core/referenceTextMatching';
import { planBulkImageImport } from '../core/bulkImageImport';
import type { BulkImageImportPlan, BulkImageImportSummary } from '../core/bulkImageImport';
import { createAsset, getProjectBundle } from '../storage/projects';
import { importBulkImages } from '../storage/bulkImages';
import ImageInspector from '../components/ImageInspector';
import { downloadJson } from '../storage/local';
import { PageHeading } from '../ui';
import './bulk-images.css';

type Row = { id: string; key: string; path: string; name: string; questionId: string; role: '' | 'reference' | 'output'; productId: string; referenceName: string; include: boolean; reason: string };
type Prepared = { expected: ProjectBundle; assets: Asset[]; plan: BulkImageImportPlan };
type Props = { bundle: ProjectBundle; onRefresh: () => Promise<void>; onToast: (message: string) => void; onEvaluate: () => void };
const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const supportedTypes = new Set(Object.values(mimeTypes));
const order = new Intl.Collator('zh-CN', { numeric: true });
const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
const referenceCount = (summary: BulkImageImportSummary) => summary.importedReferences + summary.reusedReferences;
function fileMime(file: File) { return supportedTypes.has(file.type) ? file.type : file.type === 'image/jpg' ? 'image/jpeg' : !file.type ? mimeTypes[file.name.split('.').pop()?.toLowerCase() ?? ''] : undefined; }
async function readableImage(file: File) {
  if (typeof createImageBitmap === 'function') { const bitmap = await createImageBitmap(file); bitmap.close(); return; }
  await new Promise<void>((resolve, reject) => {
    const url = URL.createObjectURL(file); const image = new window.Image();
    image.onload = () => { URL.revokeObjectURL(url); image.naturalWidth && image.naturalHeight ? resolve() : reject(new Error('图片尺寸无效')); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法解码')); };
    image.src = url;
  });
}
function Thumbnail({ file, onClick }: { file: File; onClick: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <button className="bulk-thumbnail" onClick={onClick} aria-label={`预览 ${file.name}`}>{url && <img src={url} alt="" loading="lazy" />}<ImageIcon size={14}/></button>;
}

export default function BulkImages({ bundle, onRefresh, onToast, onEvaluate }: Props) {
  const { project } = bundle;
  const [role, setRole] = useState<'reference' | 'output'>('reference');
  const [productId, setProductId] = useState(project.products.length === 1 ? project.products[0].id : '');
  const [matchingMode, setMatchingMode] = useState<'text' | 'number' | 'path'>('text');
  const numericOrder = matchingMode === 'number';
  const [referenceLabels, setReferenceLabels] = useState<ReferenceLabels>({});
  const [labelsDirty, setLabelsDirty] = useState(false);
  const [labelError, setLabelError] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [replaceReferences, setReplaceReferences] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<'checking' | 'saving' | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [success, setSuccess] = useState<BulkImageImportSummary | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<{ key: string; file: File; url: string } | null>(null);
  const files = useRef(new Map<string, File>());
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const previewUrl = useRef('');
  const mounted = useRef(true);
  const pending = useRef(false);
  const tableScroll = useRef<HTMLDivElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const mappingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mounted.current = true;
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
    const leaving = (event: BeforeUnloadEvent) => { if (pending.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leaving);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', leaving); URL.revokeObjectURL(previewUrl.current); window.dispatchEvent(new CustomEvent('formal-dirty', { detail: false })); };
  }, []);
  useEffect(() => {
    pending.current = !!busy || rows.length > 0;
    window.dispatchEvent(new CustomEvent('formal-dirty', { detail: pending.current }));
  }, [rows.length, busy]);
  useEffect(() => { setPage(0); }, [filter, search]);
  useEffect(() => {
    if (errors.length) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (prepared) reviewRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [errors, prepared]);

  function referenceName(questionId: string, original: string) {
    const names = project.questions.find(question => question.id === questionId)?.referenceNames ?? [];
    return names.includes(original) ? original : names.length === 1 ? names[0] : names.length ? '' : original;
  }
  function issue(row: Row): string {
    if (!row.role) return '请选择图片用途';
    if (!project.questions.some(question => question.id === row.questionId)) return '请关联题目';
    if (row.role === 'output' && !project.products.some(product => product.id === row.productId)) return '请选择对应产品';
    if (row.role === 'reference' && !row.referenceName.trim()) return '请选择本题要求的参考图位置';
    return '';
  }
  function invalidate() { setPrepared(null); setErrors([]); setSuccess(null); }
  function edit(id: string, changes: Partial<Row>) {
    invalidate();
    setRows(current => current.map(row => row.id !== id ? row : { ...row, ...changes }));
  }
  function addFiles(selected: FileList | null) {
    if (!selected || busy) return;
    invalidate();
    const selectedFiles = [...selected];
    const accepted = selectedFiles.filter(file => fileMime(file));
    const ignoredCount = selectedFiles.length - accepted.length;
    setIgnored(value => value + ignoredCount);
    const hints = accepted.map(file => {
      const key = crypto.randomUUID(); files.current.set(key, file);
      return { key, path: file.webkitRelativePath || file.name, name: file.name };
    }).sort((left, right) => order.compare(left.path, right.path));
    const matches = role === 'reference' && matchingMode === 'text' ? matchReferenceText(project, hints, referenceLabels) : matchBulkImages(project, hints, { role, ...(productId ? { productId } : {}), numericOrder });
    setRows(current => [...current, ...matches.map((match): Row => ({ ...match, id: crypto.randomUUID(), questionId: match.questionId ?? '', role: match.role ?? '', productId: match.productId ?? '', referenceName: 'referenceName' in match ? match.referenceName as string : referenceName(match.questionId ?? '', match.name), include: true }))]);
    if (folderInput.current) folderInput.current.value = '';
    if (fileInput.current) fileInput.current.value = '';
    if (!accepted.length) setErrors(['未找到支持的图片。请选择含 PNG、JPEG、WebP 或 GIF 的文件夹，也可直接多选图片。']);
  }
  function rematchReferences(labels = referenceLabels) {
    invalidate();
    setRows(current => {
      const hints = [...new Map(current.filter(row => row.role === 'reference').map(row => [row.key, { key: row.key, path: row.path, name: row.name }])).values()];
      const matches = matchReferenceText(project, hints, labels);
      return [...current.filter(row => row.role !== 'reference'), ...matches.map((match): Row => ({ ...match, id: crypto.randomUUID(), questionId: match.questionId ?? '', role: 'reference', productId: '', include: current.find(row => row.role === 'reference' && row.key === match.key && row.questionId === match.questionId)?.include ?? current.some(row => row.role === 'reference' && row.key === match.key && row.include) }))];
    });
    setLabelsDirty(false); setMatchingMode('text'); setFilter('all'); setSearch(''); setPage(0);
  }
  async function readLabels(file: File | undefined) {
    if (!file || busy) return;
    invalidate(); setLabelError('');
    try {
      if (file.size > 1024 * 1024) throw new Error('商品对应表请控制在 1 MB 以内。');
      const labels = { ...referenceLabels, ...parseReferenceLabels(await file.text()) };
      setReferenceLabels(labels); rematchReferences(labels);
      onToast('商品对应表已读取，已按题目中的商品名称重新匹配，请核对结果。');
    } catch (reason) { const message = reason instanceof Error ? reason.message : '商品对应表读取失败'; setLabelError(message); setErrors([message]); }
    finally { if (labelInput.current) labelInput.current.value = ''; }
  }
  function showPreview(row: Row) {
    const file = files.current.get(row.key); if (!file) return;
    URL.revokeObjectURL(previewUrl.current); previewUrl.current = URL.createObjectURL(file);
    setPreview({ key: row.id, file, url: previewUrl.current }); dialog.current?.showModal();
  }
  const included = rows.filter(row => row.include);
  const unresolved = included.filter(row => issue(row));
  const filtered = useMemo(() => rows.filter(row => (filter === 'pending' ? row.include && !!issue(row) : filter === 'included' ? row.include : filter === 'skipped' ? !row.include : true) && `${row.path} ${row.questionId} ${row.reason}`.toLowerCase().includes(search.toLowerCase())), [rows, filter, search, project]);
  const pages = Math.max(1, Math.ceil(filtered.length / 40));
  const currentPage = Math.min(page, pages - 1);
  const shown = filtered.slice(currentPage * 40, (currentPage + 1) * 40);
  const folderDisabled = !!busy || !project.questions.length || (role === 'output' && !productId);
  const referenceFiles = [...new Map(rows.filter(row => row.role === 'reference').map(row => [row.key, row])).values()];
  const fileCount = new Set(included.map(row => row.key)).size;
  const questionCount = new Set(included.map(row => row.questionId).filter(Boolean)).size;
  const problems = errors.length ? errors : prepared?.plan.blockers ?? [];
  const ready = !!prepared && !prepared.plan.blockers.length && !labelsDirty;

  async function check() {
    if (busy || !included.length) return;
    setErrors([]); setPrepared(null); setSuccess(null);
    if (labelsDirty) { setErrors(['商品名称已修改，请先点击“根据商品名自动匹配”，再检查图片。']); return; }
    if (unresolved.length) { setErrors([`有 ${unresolved.length} 条对应关系尚未填好，请调整下表，或点击“跳过未匹配图片”。`, ...unresolved.slice(0, 5).map(row => `${row.path}：${issue(row)}`)]); setFilter('pending'); return; }
    setBusy('checking'); setProgress({ done: 0, total: included.length });
    const assets: Asset[] = []; const problems: string[] = [];
    const checked = new Map<string, Asset>();
    try {
      const expected = await getProjectBundle(project.id);
      await onRefresh();
      if (expected.project.questionsHash !== project.questionsHash || expected.project.schemeHash !== project.schemeHash) {
        throw new Error('题库或评分方案已更新，请核对列表中的图片关联后重新校验。');
      }
      for (let index = 0; index < included.length; index++) {
        if (!mounted.current) return;
        const row = included[index]; const file = files.current.get(row.key)!;
        try {
          let source = checked.get(row.key);
          if (!source) {
            const mime = fileMime(file);
            const normalized = file.type === mime ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified });
            source = await createAsset(normalized, { projectId: project.id, questionId: row.questionId, role: row.role as 'reference' | 'output', productId: row.role === 'reference' ? null : row.productId });
            await readableImage(normalized);
            checked.set(row.key, source);
          }
          assets.push({ ...source, id: crypto.randomUUID(), questionId: row.questionId, role: row.role as 'reference' | 'output', productId: row.role === 'reference' ? null : row.productId, name: row.role === 'reference' ? row.referenceName.trim() : file.name });
        } catch (reason) { problems.push(`${row.path}：${reason instanceof Error ? reason.message : '图片读取失败'}`); }
        if (mounted.current) setProgress({ done: index + 1, total: included.length });
      }
      if (!mounted.current) return;
      if (problems.length) { setErrors([`有 ${problems.length} 条对应关系检查失败，尚未写入任何图片。可取消勾选这些图片后重试。`, ...problems.slice(0, 12)]); return; }
      const plan = planBulkImageImport(expected, assets, { replaceReferences });
      setPrepared({ expected, assets, plan });
      if (!plan.blockers.length) onToast('图片与对应关系已检查，请核对导入预览后确认。');
    } catch (reason) { if (mounted.current) setErrors([reason instanceof Error ? reason.message : '校验失败，未导入图片']); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function save() {
    if (!prepared || busy || prepared.plan.blockers.length) return;
    setBusy('saving'); setErrors([]);
    try {
      const summary = await importBulkImages(prepared.expected, prepared.assets, { replaceReferences });
      if (!mounted.current) return;
      setSuccess(summary); setRows([]); setPrepared(null); files.current.clear(); setIgnored(0); setPage(0); setFilter('all'); setSearch('');
      onToast(summary.importedOutputs ? `已导入 ${referenceCount(summary)} 处参考图关联、${summary.importedOutputs} 张生成图；生成图已放入对应评测草稿。` : referenceCount(summary) ? `已关联 ${referenceCount(summary)} 处参考图关联，跳过 ${summary.skippedDuplicates} 条重复关联。` : `已跳过 ${summary.skippedDuplicates} 张重复图片。`);
      await onRefresh();
    } catch (reason) {
      if (mounted.current) {
        setErrors([reason instanceof Error ? reason.message : '导入失败，未写入任何图片']); setPrepared(null);
        await onRefresh();
      }
    } finally { if (mounted.current) setBusy(null); }
  }

  return <div className="bulk-page">
    <PageHeading eyebrow="BATCH IMAGE IMPORT" title="批量导图" description="选图片 → 自动匹配题目 → 确认导入。一张参考图可以共用到多道题。" action={<button className="btn" disabled={!!busy} onClick={onEvaluate}>去逐题评测<ArrowRight size={15}/></button>}/>
    {!project.questions.length && <div className="bulk-notice warning"><AlertCircle size={17}/>请先在“项目与题库”导入题目，再批量关联图片。</div>}
    <section className="panel bulk-source">
      <div className="bulk-step-heading"><span>01</span><div><h2>选择图片文件夹</h2><p>支持 1、2、3… 数字命名，也可按题号识别，不用逐张改名。</p></div></div>
      <fieldset disabled={!!busy} className="bulk-settings">
        <label><span>这批图片的用途</span><select aria-label="这批图片的用途" value={role} onChange={event => { const next = event.target.value as typeof role; setRole(next); setMatchingMode(next === 'reference' ? 'text' : 'number'); }}><option value="reference">素材图 / 参考图</option><option value="output">产品生成的评测图</option></select></label>
        <label><span>对应方式</span><select aria-label="对应方式" value={matchingMode} onChange={event => setMatchingMode(event.target.value as typeof matchingMode)}>{role === 'reference' && <option value="text">按题目中的商品名称自动匹配（可一图多题）</option>}<option value="number">按数字文件名：1 → 第1题</option><option value="path">按题号、文件名或目录识别</option></select></label>
        {role === 'output' && <label><span>被测产品</span><select aria-label="被测产品" value={productId} onChange={event => setProductId(event.target.value)}><option value="">请选择产品</option>{project.products.map((product, index) => <option key={product.id} value={product.id}>{product.name || `待配置产品 ${index + 1}`}{product.version ? ` · ${product.version}` : ''}</option>)}</select></label>}
      </fieldset>
      <div className="bulk-source-actions"><button className="btn btn-primary" disabled={folderDisabled} onClick={() => folderInput.current?.click()}><FolderOpen size={16}/>选择文件夹</button><button className="btn" disabled={folderDisabled} onClick={() => fileInput.current?.click()}><Upload size={15}/>多选图片</button><span>PNG、JPEG、WebP、GIF · 单张 ≤ 25 MB · 原图仅保存在本机</span></div>
      <input ref={folderInput} type="file" multiple hidden onChange={event => addFiles(event.target.files)}/><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => addFiles(event.target.files)}/>
      <p className="bulk-source-help">{matchingMode === 'text' ? '自动查找题目指定的参考图、文件名和商品名称，一张图可匹配所有相关题目。只有数字文件名时，先补充一次商品名称或导入商品对应表。' : numericOrder ? '数字按当前题库顺序对应：1 对应第1题，54 对应第54题；用途和产品采用上方的选择。' : '优先从目录识别题号、用途和产品，无法识别时采用上方默认设置。'}上方设置用于下一次加入的文件；列表中每张图片仍可调整。</p>
      <p className="bulk-source-help">图片数量不必等于题目数量。自动检查仅检查文件与对应关系，图片质量留到逐题评测时评分。</p>
      {role === 'output' && !productId && <p className="bulk-inline-warning">先选择这个文件夹属于哪个产品，再选择图片。</p>}
      {role === 'output' && productId && rows.some(row => row.role === 'output') && <button className="bulk-text-button" disabled={!!busy} onClick={() => { invalidate(); setRows(current => current.map(row => row.role === 'output' ? { ...row, productId } : row)); }}>将此产品应用到列表中的所有生成图</button>}
    </section>
    {referenceFiles.length > 0 && <section className="panel bulk-labels">
      <div className="bulk-step-heading"><span><ImageIcon size={16}/></span><div><h2>让图片与商品名称对应</h2><p>例如 1.png → 精华液，系统会找到所有提到“精华液”的题目。多个叫法用顿号分开。</p></div></div>
      <div className="bulk-label-actions"><button className="btn btn-small" disabled={!!busy} onClick={() => labelInput.current?.click()}>导入商品对应表</button><button className="btn btn-small" disabled={!!busy || !Object.values(referenceLabels).some(value => value.trim())} onClick={() => downloadJson('参考图商品对应表.json', Object.fromEntries(Object.entries(referenceLabels).filter(([, value]) => value.trim())))}>导出商品对应表</button><button className="btn btn-primary" disabled={!!busy} onClick={() => rematchReferences()}>根据商品名自动匹配</button></div>
      <input ref={labelInput} type="file" accept=".json,application/json" hidden onChange={event => void readLabels(event.target.files?.[0])}/>
      <div className="bulk-label-list">{referenceFiles.map(row => <div className="bulk-label-row" key={row.key}><Thumbnail file={files.current.get(row.key)!} onClick={() => showPreview(row)}/><span title={row.path}>{row.name}</span><input type="text" aria-label={`商品名称 ${row.path}`} placeholder="商品名称，如：精华液" disabled={!!busy} value={referenceLabels[row.path] ?? referenceLabels[row.name] ?? ''} onChange={event => { invalidate(); setReferenceLabels(current => ({ ...current, [row.path]: event.target.value })); setLabelsDirty(true); }}/><small>{rows.filter(item => item.key === row.key && item.questionId).length} 道题</small></div>)}</div>
      {labelsDirty && <p className="bulk-inline-warning">商品名称已修改，点击“根据商品名自动匹配”更新对应关系。</p>}
      {labelError && <p className="bulk-inline-warning" role="alert">{labelError}</p>}
      <p className="bulk-source-help">商品名称只用于文字匹配，不改图片名称、尺寸或题库。不识别图片内容；如果是纯数字文件名，需要先提供商品名称。</p>
    </section>}
    {success && <section className="panel bulk-success" role="status"><CheckCircle2 size={24}/><div><h2>批量导图已完成</h2><p>参考图已关联 {referenceCount(success)} 处 · 生成图 {success.importedOutputs} 张 · 跳过重复图片 {success.skippedDuplicates} 张</p><p>{success.importedOutputs ? '生成图保存为草稿，请继续逐题检查可用性、选择最佳图并评分。' : '可以继续加入另一个文件夹，或进入逐题评测查看。'}</p></div><button className="btn btn-primary" onClick={onEvaluate}>开始评测<ArrowRight size={15}/></button></section>}
    {rows.length > 0 && <section className="panel bulk-mapping" ref={mappingRef}>
      <div className="bulk-step-heading"><span>02</span><div><h2>核对自动匹配结果</h2><p>{fileCount} 张图片 → {questionCount} 道题 · {included.length} 条对应关系 · {unresolved.length} 条待处理{ignored ? ` · 已忽略 ${ignored} 个不支持的文件` : ''}</p></div><button className="bulk-text-button" disabled={!!busy} onClick={() => { invalidate(); setRows([]); files.current.clear(); setIgnored(0); setLabelsDirty(false); }}>清空列表</button></div>
      <div className="bulk-list-tools"><label className="bulk-search"><Search size={14}/><input value={search} disabled={!!busy} placeholder="搜索文件名、题号" aria-label="搜索批量导图列表" onChange={event => setSearch(event.target.value)}/></label><select aria-label="筛选批量导图列表" disabled={!!busy} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部图片</option><option value="pending">待关联</option><option value="included">勾选导入</option><option value="skipped">已跳过</option></select>{unresolved.length > 0 && <button className="btn btn-small" disabled={!!busy} onClick={() => { invalidate(); setRows(current => current.map(row => issue(row) ? { ...row, include: false } : row)); setFilter('all'); }}>跳过未匹配图片</button>}</div>
      <div className="bulk-table-scroll" ref={tableScroll}><table className="bulk-table"><thead><tr><th><input type="checkbox" disabled={!!busy} aria-label="全选图片" checked={rows.length > 0 && rows.every(row => row.include)} onChange={event => { invalidate(); setRows(current => current.map(row => ({ ...row, include: event.target.checked }))); }}/></th><th>图片 / 原始文件</th><th>用途</th><th>对应题目</th><th>产品 / 参考图位置</th><th/></tr></thead><tbody>{shown.map(row => {
        const file = files.current.get(row.key)!; const question = project.questions.find(question => question.id === row.questionId); const message = issue(row);
        return <tr key={row.id} className={!row.include ? 'skipped' : message ? 'pending' : ''}><td><input type="checkbox" aria-label={`导入 ${row.path}`} disabled={!!busy} checked={row.include} onChange={event => edit(row.id, { include: event.target.checked })}/></td><td><div className="bulk-file"><Thumbnail file={file} onClick={() => showPreview(row)}/><div><strong title={row.path}>{row.name}</strong><small title={row.path}>{row.path}</small><small>{fileSize(file.size)} · {row.include ? message || '已关联' : '已跳过'}</small><p className="bulk-match-reason" title={row.reason}>{row.reason}</p></div></div></td><td><select aria-label={`用途 ${row.path}`} disabled={!!busy} value={row.role} onChange={event => edit(row.id, { role: event.target.value as Row['role'], productId: row.productId || productId, referenceName: referenceName(row.questionId, row.name) })}><option value="">待选择</option><option value="reference">参考素材</option><option value="output">生成评测图</option></select></td><td><select aria-label={`题目 ${row.path}`} disabled={!!busy} value={row.questionId} onChange={event => edit(row.id, { questionId: event.target.value, referenceName: referenceName(event.target.value, row.name) })}><option value="">请选择题目</option>{project.questions.map((question, index) => <option key={question.id} value={question.id}>{index + 1}. {question.id} · {question.title}</option>)}</select><p title={question?.request || row.reason}>{question?.request || row.reason}</p></td><td>{row.role === 'output' ? <select aria-label={`产品 ${row.path}`} disabled={!!busy} value={row.productId} onChange={event => edit(row.id, { productId: event.target.value })}><option value="">请选择产品</option>{project.products.map((product, index) => <option key={product.id} value={product.id}>{product.name || `待配置产品 ${index + 1}`}</option>)}</select> : row.role === 'reference' ? <><select aria-label={`参考图位置 ${row.path}`} disabled={!!busy || !row.questionId} value={row.referenceName} onChange={event => edit(row.id, { referenceName: event.target.value })}><option value="">请选择本题要求的参考图位置</option>{[...new Set([...(question?.referenceNames ?? []), row.name])].map(name => <option key={name} value={name}>{name}{!question?.referenceNames.includes(name) ? '（额外参考图）' : ''}</option>)}</select><small className="bulk-slot-help">按此位置关联，原图内容保持完整</small></> : '—'}</td><td><button className="bulk-copy" disabled={!!busy} title="将这张图关联到另一题" aria-label={`复制关联 ${row.path}`} onClick={() => { invalidate(); setRows(current => [...current, { ...row, id: crypto.randomUUID(), questionId: '', referenceName: '', reason: '同一图片可用于多题，请选择另一题。', include: true }]); }}><Copy size={14}/></button></td></tr>;
      })}</tbody></table></div>
      <div className="bulk-pagination"><span>{filtered.length} 条对应关系 · 第 {currentPage + 1} / {pages} 页</span><button className="btn btn-small" disabled={!!busy || currentPage === 0} onClick={() => { setPage(currentPage - 1); if (tableScroll.current) tableScroll.current.scrollTop = 0; }}>上一页</button><button className="btn btn-small" disabled={!!busy || currentPage >= pages - 1} onClick={() => { setPage(currentPage + 1); if (tableScroll.current) tableScroll.current.scrollTop = 0; }}>下一页</button></div>
      <label className="bulk-replace"><input type="checkbox" checked={replaceReferences} disabled={!!busy} onChange={event => { invalidate(); setReplaceReferences(event.target.checked); }}/><span>允许替换当前同名参考图<small>仅更新本题当前参考图，旧图和历史评分仍保留。相同图片会自动跳过。</small></span></label>
    </section>}
    {errors.length > 0 && <div ref={errorRef} className="bulk-notice warning" role="alert"><AlertCircle size={18}/><ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div>}
    {prepared && <section ref={reviewRef} className="panel bulk-confirm"><div className="bulk-step-heading"><span>03</span><div><h2>导入预览</h2><p>核对后确认，所有图片将统一写入本机项目。</p></div></div><div className="bulk-summary"><div><strong>{referenceCount(prepared.plan.summary)}</strong><span>参考图关联（处）</span></div><div><strong>{prepared.plan.summary.importedOutputs}</strong><span>生成图</span></div><div><strong>{prepared.plan.summary.affectedQuestions}</strong><span>更新题目</span></div><div><strong>{prepared.plan.summary.skippedDuplicates}</strong><span>重复跳过</span></div></div>
      {prepared.plan.summary.affectedTasks > 0 && !!bundle.quality?.tasks.length && <p className="bulk-inline-warning">本项目已有 {bundle.quality.tasks.length} 个固定质检任务。新增草稿不会改写旧复评或 GSB，相关任务可能需要重新安排。</p>}
      {prepared.plan.warnings.map((warning, index) => <p className="bulk-inline-warning" key={index}>{warning}</p>)}
      {prepared.plan.blockers.length > 0 && <div className="bulk-notice warning" role="alert"><AlertCircle size={17}/><ul>{prepared.plan.blockers.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
      <p className="bulk-confirm-help">生成图只进入草稿，图片可用性、侵权检查和评分由评测员确认。</p>
    </section>}
    {rows.length > 0 && <div className={`panel bulk-footer${ready ? ' ready' : ''}`}>
      <div className="bulk-footer-status" role="status" aria-live="polite">
        {busy ? <><LoaderCircle size={17} className="spin"/><span>{busy === 'checking' ? `正在自动检查 ${progress.done} / ${included.length} 条对应关系` : '正在导入图片…'}<small>无需逐题审核，请等待完成。</small></span></>
          : problems.length ? <><AlertCircle size={18}/><span>暂时不能导入<small>{problems[0]}</small></span><button className="bulk-text-button" onClick={() => (errorRef.current ?? reviewRef.current)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>查看原因</button></>
          : labelsDirty ? <><AlertCircle size={18}/><span>请先更新匹配结果<small>商品名称已修改，请点击“根据商品名自动匹配”。</small></span></>
          : unresolved.length ? <><AlertCircle size={18}/><span>还有 {unresolved.length} 条对应关系待处理<small>补充商品名称自动匹配，或手动选题；无需凑齐每题一张图。</small></span><button className="bulk-text-button" onClick={() => { setFilter('pending'); setSearch(''); mappingRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>查看待处理</button></>
          : ready ? <><CheckCircle2 size={18}/><span>检查完成，可以导入<small>{fileCount} 张图片 → {questionCount} 道题。请核对上方预览，再点“确认导入”。</small></span></>
          : <><CheckCircle2 size={18}/><span>{included.length ? '对应关系已填好' : '尚未勾选图片'}<small>{included.length ? '点击“自动检查”，系统检查文件与对应关系，不需要打分。' : '请勾选要导入的图片。'}</small></span></>}
      </div>
      <button className="btn" disabled={!!busy || !included.length || labelsDirty} onClick={() => void check()}><CheckCircle2 size={15}/>{busy === 'checking' ? '检查中…' : '自动检查'}</button>
      <button className="btn btn-primary" disabled={!!busy || !ready} onClick={() => void save()}><Upload size={15}/>确认导入</button>
    </div>}

    <dialog ref={dialog} className="formal-image-dialog" onClose={() => { setPreview(null); URL.revokeObjectURL(previewUrl.current); previewUrl.current = ''; }} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}><div className="formal-dialog-top"><span>{preview?.file.name}</span><button className="btn btn-small" aria-label="关闭原图" onClick={() => dialog.current?.close()}><X size={18}/></button></div>{preview && <ImageInspector key={preview.key} src={preview.url} alt={preview.file.name} info={`待导入原图 · ${fileSize(preview.file.size)}`}/>}</dialog>
  </div>;
}
