import AnchorRatings from '../components/AnchorRatings';
import ImageInspector from '../components/ImageInspector';
import { isAnchorMode, questionDimensions } from '../core/ratings';
import { resolveReferences } from '../core/references';
import type { DimensionRatings } from '../core/model';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Flag, FolderOpen, Image as ImageIcon, Info, Maximize2, Minimize2, PanelLeft, Save, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import type { Asset, AssetMetadata, Evaluation, MediaCheck, ProjectBundle, TagAssignment } from '../core/model';
import type { Severity } from '../core/scoring';
import { dimensionScore } from '../core/scoring';
import { allowedSeverities, latestEvaluations, validateEvaluation, validateProject } from '../core/assessment';
import { createAsset, getAsset } from '../storage/projects';
import './formal-evaluation.css';

type Props = {
  bundle: ProjectBundle;
  onSave: (record: Evaluation, newAssets: Asset[], referenceChange?: { id: string; expectedHeadId: string | null; assetIds: string[] }) => Promise<void>;
  onToast: (message: string) => void;
  onBulkImport?: () => void;
  focusMode?: boolean;
  onFocusChange?: (value: boolean) => void;
  initialQuestionId?: string;
};

const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const normalizeCode = (code: string) => code.replace(/[^a-z0-9]/gi, '').toUpperCase();
const humanSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

function checkImage(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const picture = new Image();
    picture.onload = () => {
      URL.revokeObjectURL(url);
      if (!picture.naturalWidth || !picture.naturalHeight) reject(new Error(`${file.name} 不是有效图片。`));
      else resolve();
    };
    picture.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name} 无法读取，请重新选择有效的图片。`));
    };
    picture.src = url;
  });
}

export default function FormalEvaluation({ bundle, onSave, onToast, initialQuestionId, onBulkImport, focusMode = false, onFocusChange }: Props) {
  const { project } = bundle;
  const [questionId, setQuestionId] = useState(() => project.questions.find(q => q.id === initialQuestionId)?.id ?? project.questions[0]?.id ?? '');
  const [productId, setProductId] = useState(project.products[0]?.id ?? '');
  const [reviewerId, setReviewerId] = useState('');
  const [search, setSearch] = useState('');
  const [briefExpanded, setBriefExpanded] = useState(() => !latestEvaluations(bundle.evaluations).find(record => record.projectId === project.id && record.questionId === questionId && record.productId === productId)?.mediaIds.length);
  const [contextChecksOpen, setContextChecksOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [focusQuestionsOpen, setFocusQuestionsOpen] = useState(false);
  const [outputs, setOutputs] = useState<Asset[]>([]);
  const [references, setReferences] = useState<Asset[]>([]);
  const [referencePool, setReferencePool] = useState<AssetMetadata[]>([]);
  const [pendingAssets, setPendingAssets] = useState<Asset[]>([]);
  const [activeMediaId, setActiveMediaId] = useState<string | null>(null);
  const [bestMediaId, setBestMediaId] = useState<string | null>(null);
  const [mediaChecks, setMediaChecks] = useState<MediaCheck[]>([]);
  const [selectedTags, setSelectedTags] = useState<TagAssignment[]>([]);
  const [ratings, setRatings] = useState<DimensionRatings>({});
  const [seconds, setSeconds] = useState('');
  const [failed, setFailed] = useState(false);
  const [failureReason, setFailureReason] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'draft' | 'submitted'>('draft');
  const [savedRevision, setSavedRevision] = useState<Evaluation | null>(null);
  const [expanded, setExpanded] = useState<string[]>(isAnchorMode(project.scheme) ? [] : ['A']);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [dialogAsset, setDialogAsset] = useState<Asset | null>(null);
  const outputInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const referenceTarget = useRef<string | null>(null);
  const referenceReplacement = useRef<string | null>(null);
  const referenceHead = useRef<string | null>(null);
  const initialReferenceIds = useRef<string[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);
  const ratingScrollRef = useRef<HTMLDivElement>(null);
  const urls = useRef(new Map<string, string>());
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const readVersion = useRef(0);
  const bundleRef = useRef(bundle);
  bundleRef.current = bundle;

  const question = project.questions.find(q => q.id === questionId);
  const product = project.products.find(p => p.id === productId);
  const latest = useMemo(() => latestEvaluations(bundle.evaluations), [bundle.evaluations]);
  const productRecords = latest.filter(r => r.projectId === project.id && r.productId === productId);
  const completed = productRecords.filter(r => r.status === 'submitted').length;
  const activeImage = outputs.find(image => image.id === activeMediaId);
  const usableCount = mediaChecks.filter(check => check.usable === true).length;
  const uncheckedCount = outputs.filter(image => {
    const check = mediaChecks.find(item => item.mediaId === image.id);
    return check?.usable == null || check?.infringement == null;
  }).length;
  const missingReferences = question?.referenceNames.filter(name => !references.some(asset => asset.name === name)) ?? [];
  const reviewDimensions = project.scheme.dimensions.filter(dimension => ['A', 'B', 'C', 'F', 'G'].includes(dimension.id));
  const blockedReasons = [
    ...(!project.rulesConfirmed ? ['方案规则尚未确认'] : []),
    ...(!product?.ownerId || !project.members.some(member => member.id === product.ownerId) ? ['当前产品尚未分配负责人'] : []),
    ...(missingReferences.length ? [`缺少 ${missingReferences.length} 张必需参考图`] : []),
  ];

  function assetUrl(asset: Asset) {
    let url = urls.current.get(asset.id);
    if (!url) {
      url = URL.createObjectURL(asset.blob);
      urls.current.set(asset.id, url);
    }
    return url;
  }

  function clearUrls() {
    urls.current.forEach(url => URL.revokeObjectURL(url));
    urls.current.clear();
  }

  function edited() {
    dirtyRef.current = true;
    setDirty(true);
    setStatus('draft');
    setErrors([]);
  }

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('formal-dirty', { detail: dirty || busy }));
  }, [dirty, busy]);

  useEffect(() => {
    if (evidenceRef.current) evidenceRef.current.scrollTop = 0;
  }, [briefExpanded]);

  useEffect(() => {
    if (focusMode && focusQuestionsOpen) document.querySelector('.formal-question.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusMode, focusQuestionsOpen]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !pendingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      readVersion.current += 1;
      clearUrls();
      window.dispatchEvent(new CustomEvent('formal-dirty', { detail: false }));
    };
  }, []);

  useEffect(() => {
    const version = ++readVersion.current;
    const current = bundleRef.current;
    const record = latestEvaluations(current.evaluations).find(item => item.projectId === current.project.id && item.questionId === questionId && item.productId === productId) ?? null;
    const selectedProduct = current.project.products.find(item => item.id === productId);
    const referenceMetadata = current.assets.filter(asset => asset.projectId === current.project.id && asset.questionId === questionId && asset.role === 'reference');
    const referenceSelection = resolveReferences(current, questionId);
    referenceHead.current = referenceSelection.head?.id ?? null;
    initialReferenceIds.current = referenceSelection.assets.map(asset => asset.id);
    const ids = [...new Set([...(record?.mediaIds ?? []), ...referenceSelection.assets.map(asset => asset.id)])];
    clearUrls();
    setOutputs([]);
    setReferences([]);
    setReferencePool(referenceMetadata);
    setPendingAssets([]);
    setDialogAsset(null);
    setLoadError('');
    setErrors([]);
    setLoading(true);
    setBriefExpanded(!record?.mediaIds.length);
    setContextChecksOpen(false);
    if (evidenceRef.current) evidenceRef.current.scrollTop = 0;
    if (ratingScrollRef.current) ratingScrollRef.current.scrollTop = 0;
    setReviewerId(record?.reviewerId ?? (current.project.members.some(member => member.id === selectedProduct?.ownerId) ? selectedProduct?.ownerId ?? '' : ''));
    setBestMediaId(record?.bestMediaId ?? null);
    setMediaChecks(record?.mediaChecks.map(check => ({ ...check })) ?? []);
    setSelectedTags(record?.tags.map(tag => ({ ...tag })) ?? []);
    setRatings(structuredClone(record?.ratings ?? {}));
    setSeconds(record?.seconds == null ? '' : String(record.seconds));
    setFailed(record?.failed ?? false);
    setFailureReason(record?.failureReason ?? '');
    setNotes(record?.notes ?? '');
    setStatus(record?.status ?? 'draft');
    setSavedRevision(record);
    dirtyRef.current = false;
    setDirty(false);

    void Promise.all(ids.map(async id => {
      const asset = await getAsset(id);
      if (!asset) throw new Error('部分原图已丢失，无法读取完整记录。请恢复数据备份后再编辑。');
      return asset;
    })).then(assets => {
      if (version !== readVersion.current) return;
      if (referenceSelection.errors.length) throw new Error(referenceSelection.errors.join('；'));
      const byId = new Map(assets.map(asset => [asset.id, asset]));
      const nextOutputs = (record?.mediaIds ?? []).map(id => byId.get(id)!).filter(Boolean);
      setOutputs(nextOutputs);
      setReferences(referenceSelection.assets.map(asset => byId.get(asset.id)!).filter(Boolean));
      setActiveMediaId(record?.bestMediaId ?? nextOutputs[0]?.id ?? null);
      if (!record?.bestMediaId && nextOutputs.length === 1) setBestMediaId(nextOutputs[0].id);
    }).catch(error => {
      if (version !== readVersion.current) return;
      setLoadError(error instanceof Error ? error.message : '本地原图读取失败，请刷新后重试。');
      setActiveMediaId(null);
    }).finally(() => {
      if (version === readVersion.current) setLoading(false);
    });
  }, [project.id, questionId, productId]);

  function navigate(nextQuestionId: string, nextProductId = productId) {
    if (loading || busy || (nextQuestionId === questionId && nextProductId === productId)) return;
    if (dirtyRef.current && !window.confirm('当前修改尚未保存，切换会丢失这些修改。确定放弃修改并切换吗？')) return;
    dirtyRef.current = false;
    setDirty(false);
    setQuestionId(nextQuestionId);
    setProductId(nextProductId);
  }

  function updateCheck(mediaId: string, key: 'usable' | 'infringement', value: boolean | null) {
    setMediaChecks(previous => {
      const existing = previous.find(check => check.mediaId === mediaId) ?? { mediaId, usable: null, infringement: null };
      return [...previous.filter(check => check.mediaId !== mediaId), { ...existing, [key]: value }];
    });
    edited();
  }

  function toggleTag(code: string, severity: Severity) {
    setSelectedTags(previous => previous.some(tag => tag.code === code) ? previous.filter(tag => tag.code !== code) : [...previous, { code, severity }]);
    edited();
  }

  async function upload(files: FileList | null, role: 'reference' | 'output') {
    if (!files?.length || !question || !product || busy || loading) return;
    const selected = Array.from(files);
    const targetName = role === 'reference' ? referenceTarget.current : null;
    const replacedId = role === 'reference' ? referenceReplacement.current : null;
    const resetInput = () => {
      if (outputInput.current) outputInput.current.value = '';
      if (referenceInput.current) referenceInput.current.value = '';
    };
    if (selected.length > 12) {
      onToast('一次最多上传 12 张图片，请分批添加。');
      resetInput();
      return;
    }
    const invalid = selected.find(file => !FILE_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_IMAGE_SIZE);
    if (invalid) {
      onToast(`${invalid.name} 不符合要求：仅支持 PNG、JPEG、WebP、GIF，每张不超过 25 MB。`);
      resetInput();
      return;
    }
    const version = readVersion.current;
    pendingRef.current = true;
    setBusy(true);
    setErrors([]);
    try {
      const uploaded: Asset[] = [];
      for (const original of selected) {
        await checkImage(original);
        const file = targetName && selected.length === 1 ? new File([original], targetName, { type: original.type, lastModified: original.lastModified }) : original;
        uploaded.push(await createAsset(file, { projectId: project.id, questionId, productId: role === 'output' ? productId : null, role }));
      }
      if (version !== readVersion.current) return;
      setPendingAssets(previous => [...previous, ...uploaded]);
      if (role === 'output') {
        setBriefExpanded(false);
        setOutputs(previous => [...previous, ...uploaded]);
        setMediaChecks(previous => [...previous, ...uploaded.map(asset => ({ mediaId: asset.id, usable: null, infringement: null }))]);
        if (!activeMediaId) setActiveMediaId(uploaded[0].id);
        if (outputs.length === 0 && uploaded.length === 1) setBestMediaId(uploaded[0].id);
      } else {
        const replacements = [...new Map(uploaded.map(asset => [asset.name, asset])).values()];
        setReferences(previous => [...previous.filter(asset => asset.id !== replacedId && !replacements.some(item => item.name === asset.name)), ...replacements]);
        setReferencePool(previous => [...previous, ...uploaded.map(({ blob: _blob, ...asset }) => asset)]);
      }
      edited();
      onToast(role === 'reference' ? `已读取 ${uploaded.length} 张参考图，保存后生效。` : `已读取 ${uploaded.length} 张原图，保存后写入本机；请逐张检查。`);
    } catch (error) {
      if (version !== readVersion.current) return;
      const message = error instanceof Error ? error.message : '图片读取失败，请重新选择。';
      setErrors([message]);
      onToast(message);
    } finally {
      pendingRef.current = false;
      if (version === readVersion.current) setBusy(false);
      referenceTarget.current = null;
      referenceReplacement.current = null;
      resetInput();
    }
  }

  function removeOutput(id: string) {
    if (!window.confirm('从本次记录中移除这张图片？请保留本次生成的全部输出。历史修订仍保留原图。')) return;
    const remaining = outputs.filter(asset => asset.id !== id);
    setOutputs(remaining);
    setMediaChecks(previous => previous.filter(check => check.mediaId !== id));
    setPendingAssets(previous => previous.filter(asset => asset.id !== id));
    if (remaining.length === 1) setBestMediaId(remaining[0].id);
    else if (bestMediaId === id) setBestMediaId(null);
    if (activeMediaId === id) setActiveMediaId(remaining[0]?.id ?? null);
    edited();
  }

  function showImage(asset: Asset) {
    setDialogAsset(asset);
    dialogRef.current?.showModal();
  }

  function chooseReference(name: string | null, replaceId: string | null = null) {
    referenceTarget.current = name;
    referenceReplacement.current = replaceId;
    if (referenceInput.current) {
      referenceInput.current.multiple = name === null;
      referenceInput.current.click();
    }
  }

  function removeReference(id: string) {
    setReferences(previous => previous.filter(asset => asset.id !== id));
    edited();
    onToast('已移除本题参考图，保存后生效；已保存的图片可从“已移除参考图”恢复。');
  }

  async function readHistoricalReference(metadata: AssetMetadata, restore: boolean) {
    if (busy || loading || loadError) return;
    const version = readVersion.current;
    setBusy(true);
    try {
      const asset = pendingAssets.find(item => item.id === metadata.id) ?? await getAsset(metadata.id);
      if (version !== readVersion.current) return;
      if (!asset) throw new Error('这张参考图的原始文件无法读取，请重新上传。');
      if (restore) {
        setReferences(previous => [...previous.filter(item => item.name !== asset.name), asset]);
        edited();
        onToast('参考图已恢复，保存后生效；同名位置使用恢复的图片。');
      } else showImage(asset);
    } catch (error) {
      if (version === readVersion.current) onToast(error instanceof Error ? error.message : '参考图读取失败');
    } finally {
      if (version === readVersion.current) setBusy(false);
    }
  }

  async function persist(nextStatus: 'draft' | 'submitted', goNext = false) {
    if (!question || !product || loading || busy || loadError) return;
    if (seconds.trim() !== '' && (!Number.isFinite(Number(seconds)) || Number(seconds) < 0)) {
      setErrors(['生成耗时须为有限、非负的秒数；未填写可以保存为草稿。']);
      return;
    }
    const parent = latestEvaluations(bundleRef.current.evaluations).find(record => record.projectId === project.id && record.questionId === questionId && record.productId === productId) ?? savedRevision;
    const record: Evaluation = {
      id: crypto.randomUUID(), projectId: project.id, questionId, productId, reviewerId,
      revision: (parent?.revision ?? 0) + 1, parentId: parent?.id ?? null,
      status: nextStatus, mediaIds: outputs.map(asset => asset.id), bestMediaId: outputs.length === 1 ? outputs[0].id : bestMediaId,
      mediaChecks: outputs.map(asset => mediaChecks.find(check => check.mediaId === asset.id) ?? { mediaId: asset.id, usable: null, infringement: null }),
      referenceIds: references.map(asset => asset.id),
      ...(isAnchorMode(project.scheme) ? { ratings } : {}),
      tags: selectedTags.map(tag => ({ ...tag })), seconds: seconds.trim() === '' ? null : Number(seconds),
      failed, failureReason, notes, schemeHash: project.schemeHash, questionsHash: project.questionsHash,
      createdAt: new Date().toISOString(),
    };
    if (nextStatus === 'submitted') {
      const validationErrors = validateEvaluation(project, record, [...bundle.assets, ...pendingAssets], { scope: 'task' });
      if (validationErrors.length) {
        setErrors(validationErrors.map(error => {
          const message = record.seconds === null && error === '生成耗时须为大于或等于 0 的有限秒数'
            ? '尚未填写生成耗时：请在“生成记录 → 耗时 / 秒”补填，或先保存草稿并下一题。'
            : error;
          return outputs.reduce((text, asset, index) => text.replaceAll(asset.id, `第 ${index + 1} 张原图（${asset.name}）`), message);
        }));
        onToast('尚未提交，请根据提示补全评测记录。');
        return;
      }
    }
    pendingRef.current = true;
    setBusy(true);
    setErrors([]);
    try {
      const referenceChange = JSON.stringify(initialReferenceIds.current) !== JSON.stringify(record.referenceIds)
        ? { id: crypto.randomUUID(), expectedHeadId: referenceHead.current, assetIds: record.referenceIds! }
        : undefined;
      const retainedAssets = pendingAssets.filter(asset => asset.role === 'output' ? record.mediaIds.includes(asset.id) : record.referenceIds!.includes(asset.id));
      await onSave(record, retainedAssets, referenceChange);
      if (referenceChange) referenceHead.current = referenceChange.id;
      initialReferenceIds.current = [...record.referenceIds!];
      setReferencePool(previous => previous.filter(asset => bundle.assets.some(saved => saved.id === asset.id) || retainedAssets.some(saved => saved.id === asset.id)));
      setSavedRevision(record);
      setPendingAssets([]);
      setStatus(nextStatus);
      dirtyRef.current = false;
      setDirty(false);
      onToast(nextStatus === 'submitted' ? `已提交第 ${record.revision} 版评测。${validateProject(project).length ? '其他产品配置仍待补齐，汇总暂保留缺口。' : ''}` : `草稿已保存（第 ${record.revision} 版），未计入正式结果。`);
      if (goNext) {
        const nextQuestion = project.questions[project.questions.findIndex(item => item.id === questionId) + 1];
        if (nextQuestion) setQuestionId(nextQuestion.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败，修改仍保留在页面，请重试。';
      setErrors([message]);
      onToast(message);
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  if (!project.questions.length || !project.products.length) return <div className="formal-empty panel">
    <ImageIcon size={36} />
    <h1>准备好题库与产品后开始评测</h1>
    <p>{!project.questions.length ? '当前项目尚未导入评测题目。' : ''}{!project.products.length ? '当前项目尚未配置被测产品。' : ''}请前往「方案与题库」完成配置。</p>
    <p>正式项目使用你导入的题目和原图，不会填入演示评测数据。</p>
  </div>;

  if (!question || !product) return <div className="formal-empty panel"><AlertCircle size={30} /><h1>当前题目或产品已被移除</h1><p>请返回任务列表，重新选择评测任务。</p></div>;

  const position = project.questions.findIndex(item => item.id === questionId);
  const filteredQuestions = project.questions.filter(item => `${item.id} ${item.title} ${item.scene} ${item.category}`.toLowerCase().includes(search.toLowerCase()));
  const locked = loading || busy || !!loadError;
  const cleanSubmitted = status === 'submitted' && !dirty;
  const visibleAssets: AssetMetadata[] = [...references, ...outputs];
  const removedReferences = referencePool.filter(asset => !references.some(active => active.id === asset.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

  function referenceCard(asset: Asset) {
    return <div className="formal-reference-card" key={asset.id}>
      <button className="formal-reference" onClick={() => showImage(asset)} aria-label={`查看参考图 ${asset.name}`}><img src={assetUrl(asset)} alt={asset.name} /><span title={asset.name}>{asset.name}</span></button>
      <button className="formal-reference-remove" disabled={locked} onClick={() => removeReference(asset.id)} aria-label={`移除参考图 ${asset.name}`} title="移除参考图"><X size={15} /></button>
      <div className="formal-reference-actions"><button disabled={locked} onClick={() => chooseReference(asset.name, asset.id)} aria-label={`替换参考图 ${asset.name}`}><Upload size={12} />替换</button></div>
    </div>;
  }

  return <div className={`formal-page${focusMode ? ' is-focus-mode' : ''}${focusQuestionsOpen ? ' focus-questions-open' : ''}`}>
    <header className="formal-evaluation-toolbar">
      <div className="formal-toolbar-context"><h1>逐题评测</h1><span title={project.name}>{focusMode ? project.name : `已提交 ${completed} / ${project.questions.length} 题`}</span></div>
      {focusMode && <div className="formal-toolbar-navigation">
        <button className="formal-toolbar-icon" onClick={() => setFocusQuestionsOpen(previous => !previous)} aria-label={focusQuestionsOpen ? '收起题目列表' : '展开题目列表'} title="题目列表" aria-expanded={focusQuestionsOpen} aria-controls="formal-question-navigation"><PanelLeft size={16}/></button>
        <button className="formal-toolbar-icon" disabled={position === 0 || locked} onClick={() => navigate(project.questions[position - 1].id)} aria-label="上一道评测题" title="上一题"><ChevronLeft size={16}/></button>
        <select aria-label="跳转评测题目" value={questionId} disabled={locked} onChange={event => navigate(event.target.value)}>{project.questions.map((item, index) => <option value={item.id} key={item.id}>{index + 1} / {project.questions.length} · {item.id} · {item.title}</option>)}</select>
        <button className="formal-toolbar-icon" disabled={position >= project.questions.length - 1 || locked} onClick={() => navigate(project.questions[position + 1].id)} aria-label="下一道评测题" title="下一题"><ChevronRight size={16}/></button>
      </div>}
      <div className="formal-toolbar-actions">
        {onBulkImport && <button className="btn btn-small formal-bulk-entry" disabled={locked} onClick={onBulkImport} title="批量导入参考图或生成图；离开前请先保存当前草稿"><FolderOpen size={14}/>批量导图</button>}
        <button className="formal-toolbar-icon" aria-label="评测操作说明" title="评测操作说明" aria-expanded={instructionsOpen} aria-controls="formal-evaluation-instructions" onClick={() => setInstructionsOpen(previous => !previous)}><Info size={16}/></button>
        {onFocusChange && <button className={`btn btn-small formal-focus-toggle${focusMode ? ' active' : ''}`} onClick={() => onFocusChange(!focusMode)} aria-pressed={focusMode} title={focusMode ? '退出专注评测（Esc）' : '收起导航，扩大图片与评分区域'}>{focusMode ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}<span>{focusMode ? '退出专注' : '专注评测'}</span></button>}
      </div>
    </header>
    {blockedReasons.length > 0 && <div className="formal-notice warning" role="status"><Info size={16}/><div><strong>可先记录草稿</strong> · {blockedReasons.join('；')}，补齐后才能正式提交。</div></div>}
    {instructionsOpen && <div className="formal-notice formal-instructions" id="formal-evaluation-instructions"><Info size={16}/><div><strong>独立评测</strong> · 对照题目需求，上传本次生成的全部原图，逐张检查并选择最佳图，再按维度评分。保存后可继续编辑，每次修订均保留历史。图片和记录仅保存在本机；跨设备使用阶段同步或备份。{focusMode && ' 专注模式可用顶部切题或展开题目列表，按 Esc 退出。'}</div><button aria-label="收起操作说明" onClick={() => setInstructionsOpen(false)}><X size={14}/></button></div>}

    <div className="formal-layout" aria-busy={loading || busy}>
      <aside className="panel formal-questions" id="formal-question-navigation" aria-label="评测题目导航">
        <div className="formal-question-top"><div className="formal-section-title"><h2>评测题目</h2><span>{project.questions.length}</span></div>
          <div className="formal-progress-label"><span>当前产品已提交</span><strong aria-label={`当前产品已提交 ${completed} / ${project.questions.length} 题`}>{completed}<small> / {project.questions.length}</small></strong></div>
          <div className="formal-progress"><span style={{ width: `${completed / project.questions.length * 100}%` }} /></div>
          <label className="formal-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索题号、场景" aria-label="搜索评测题目" /></label>
        </div>
        <div className="formal-question-list">{filteredQuestions.map(item => {
          const record = productRecords.find(record => record.questionId === item.id);
          return <button className={`formal-question ${item.id === questionId ? 'active' : ''}`} key={item.id} onClick={() => navigate(item.id)} disabled={loading || busy}>
            <span className={`formal-question-number ${record?.status === 'submitted' ? 'complete' : ''}`}>{record?.status === 'submitted' ? <Check size={13} /> : String(project.questions.indexOf(item) + 1).padStart(2, '0')}</span>
            <span className="formal-question-copy"><strong>{item.title}</strong><small>{item.scene} · {item.difficulty}</small></span>
            {record?.status === 'draft' && <i className="formal-draft-dot" title="已存草稿" />}
          </button>;
        })}{!filteredQuestions.length && <p className="formal-muted-empty">没有匹配题目</p>}</div>
        <footer>切换题目、产品前请保存修改</footer>
      </aside>

      <section className="formal-evidence">
        {!briefExpanded && <div className="panel formal-question-context" role="region" aria-label="当前题目摘要">
          <div className="formal-context-heading"><div><span className="formal-context-id" title={question.id}>{question.id}</span><span className="formal-context-scene" title={question.title}>{question.scene || question.title}</span></div><div className="formal-context-actions">
            {question.acceptance.length > 0 && <button aria-expanded={contextChecksOpen} aria-controls="formal-context-checks" onClick={() => setContextChecksOpen(previous => !previous)}>验收要点 <span>{question.acceptance.length}</span><ChevronRight size={12} className={contextChecksOpen ? 'open' : ''} /></button>}
            <button onClick={() => setBriefExpanded(true)} aria-label="展开题目详情与参考图">展开详情<ChevronRight size={13} /></button>
          </div></div>
          <p className="formal-context-request">{question.request || question.title}</p>
          {contextChecksOpen && <ul className="formal-context-checks" id="formal-context-checks" aria-label="当前题目验收要点" tabIndex={0}>{question.acceptance.map((item, index) => <li key={`${index}-${item}`}><CheckCircle2 size={13} /><span>{item}</span></li>)}</ul>}
        </div>}
        <div className="formal-evidence-scroll" ref={evidenceRef} role="region" aria-label="题目与图片" tabIndex={0}>
        <details className="panel formal-brief" open={briefExpanded} hidden={!briefExpanded}>
          <summary className="formal-brief-toggle" onClick={event => { event.preventDefault(); setBriefExpanded(previous => !previous); }}><span><strong>题目与参考图</strong><small>{question.id} · {question.title}</small></span><ChevronRight size={16} /></summary>
          <div className="formal-brief-content">
          <div className="formal-brief-top"><span>QUESTION {String(position + 1).padStart(2, '0')} <small>/ {project.questions.length}</small></span><span className="pill">{question.id}</span></div>
          <h2>{question.title}</h2><div className="formal-meta"><span>{question.scene}</span><span>{question.category}</span><span>{question.difficulty}</span></div>
          <h3>需求描述</h3><p>{question.request || '尚未填写需求描述，请完善题库。'}</p>
          <h3>验收要点</h3><ul className="formal-acceptance">{question.acceptance.map((item, index) => <li key={`${index}-${item}`}><CheckCircle2 size={14} /><span>{item}</span></li>)}</ul>
          {!question.acceptance.length && <p className="formal-help">尚未填写验收要点。</p>}
          {Object.keys(question.fields).length > 0 && <details className="formal-extra"><summary>更多题目字段</summary>{Object.entries(question.fields).map(([key, value]) => <p key={key}><strong>{key}</strong>：{value}</p>)}</details>}
          <div className="formal-reference-heading"><h3>参考图 <small>{question.referenceNames.length ? `${question.referenceNames.length} 张要求` : '未指定'}</small></h3><button className="btn btn-small" disabled={locked} onClick={() => chooseReference(null)}><Upload size={13} />添加参考图</button></div>
          <p className="formal-help">本题各产品共用参考图。鼠标移到图片上，点击右上角 × 可移除；修改后请保存。已保存的原图仍可恢复。</p>
          <input ref={referenceInput} type="file" accept={IMAGE_ACCEPT} multiple={!referenceTarget.current} hidden onChange={event => void upload(event.target.files, 'reference')} />
          <div className="formal-references">{question.referenceNames.map(name => {
            const asset = references.find(item => item.name === name);
            return asset ? referenceCard(asset) : <button className="formal-reference missing" key={name} disabled={locked} onClick={() => chooseReference(name)}><Upload size={18} /><span title={name}>{name}</span><small>待上传 · 点击补充</small></button>;
          })}{references.filter(asset => !question.referenceNames.includes(asset.name)).map(referenceCard)}</div>
          {!question.referenceNames.length && !references.length && <p className="formal-help">本题没有指定参考图，可按需要补充。</p>}
          {removedReferences.length > 0 && <details className="formal-reference-history"><summary>已移除参考图（{removedReferences.length}）</summary><p>这里保留已保存的旧图片；恢复同名图片会替换当前选择，保存后生效。</p>{removedReferences.map(asset => <div className="formal-reference-history-row" key={asset.id}><span title={asset.name}>{asset.name}<small>{humanSize(asset.size)}</small></span><button disabled={locked} onClick={() => void readHistoricalReference(asset, false)} aria-label={`预览已移除参考图 ${asset.name}`}>预览</button><button disabled={locked} onClick={() => void readHistoricalReference(asset, true)} aria-label={`恢复参考图 ${asset.name}`}>恢复</button></div>)}</details>}
          </div>
        </details>

        <div className="panel formal-results">
          <div className="formal-image-heading"><h3><ImageIcon size={16} />生成结果 <small>{outputs.length} 张原图</small></h3><div className="formal-image-actions">{onBulkImport && <button className="btn btn-small formal-bulk-entry" disabled={locked} onClick={onBulkImport} title="批量导入参考图或生成图；离开前请先保存当前草稿"><FolderOpen size={14}/>批量导图</button>}<button className="btn btn-small" disabled={locked} onClick={() => outputInput.current?.click()}><Upload size={14} />上传全部原图</button></div><input ref={outputInput} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={event => void upload(event.target.files, 'output')} /></div>
          <button className={`formal-main-image ${activeImage ? '' : 'empty'}`} onClick={() => activeImage && showImage(activeImage)} disabled={!activeImage} aria-label="放大查看原图">
            {activeImage ? <><img src={assetUrl(activeImage)} alt={activeImage.name} /><span className="formal-source">原始文件 · 未压缩</span><span className="formal-zoom"><Maximize2 size={16} /></span></> : <span><ImageIcon size={36} />{loading ? '正在读取原图…' : '上传本次生成的全部图片'}<small>PNG、JPEG、WebP、GIF · 单张 ≤ 25 MB · 每批 ≤ 12 张</small></span>}
          </button>
          {outputs.length > 0 && <><div className="formal-thumbnails">{outputs.map((asset, index) => <button key={asset.id} className={`formal-thumbnail ${activeMediaId === asset.id ? 'selected' : ''}`} onClick={() => setActiveMediaId(asset.id)}><img src={assetUrl(asset)} alt={`查看第 ${index + 1} 张原图`} /><span>{String(index + 1).padStart(2, '0')}</span>{bestMediaId === asset.id && <i><Check size={12} />最佳</i>}</button>)}</div>
            {activeImage && <div className="formal-image-toolbar"><span title={activeImage.name}>{activeImage.name}<small>{humanSize(activeImage.size)}</small></span><button className={`btn btn-small ${bestMediaId === activeImage.id ? 'formal-best' : ''}`} disabled={locked} onClick={() => { setBestMediaId(activeImage.id); edited(); }}><CheckCircle2 size={13} />{bestMediaId === activeImage.id ? '已选为最佳图' : '设为最佳图'}</button><button className="formal-delete" disabled={locked} onClick={() => removeOutput(activeImage.id)} aria-label="移除当前原图"><Trash2 size={14} /></button></div>}
          </>}
          <div className="formal-file-note"><ShieldCheck size={13} /><span>保留原始图片与文件校验信息；图片仅在当前浏览器读取与保存。</span></div>
        </div>

        {outputs.length > 0 && <div className="panel formal-image-checks"><div className="formal-check-heading"><h3>逐图检查</h3><span>可用 {usableCount} / {outputs.length} 张{uncheckedCount > 0 ? ` · ${uncheckedCount} 张待确认` : ' · 已全部确认'}</span></div><p className="formal-help">每张图片都需人工确认。最佳图若有 A / B / C / F 的 P0、P1 问题，不应标为可用。</p>
          {outputs.map((asset, index) => {
            const check = mediaChecks.find(item => item.mediaId === asset.id);
            return <div className="formal-image-check" key={asset.id}><button className="formal-check-thumb" onClick={() => setActiveMediaId(asset.id)}><img src={assetUrl(asset)} alt={`查看第 ${index + 1} 张图片`} /><span>{String(index + 1).padStart(2, '0')}</span></button><div className="formal-check-options"><label>可用性<select aria-label={`第 ${index + 1} 张图片可用性`} value={check?.usable == null ? '' : check.usable ? 'yes' : 'no'} disabled={locked} onChange={event => updateCheck(asset.id, 'usable', event.target.value === '' ? null : event.target.value === 'yes')}><option value="">待确认</option><option value="yes">可用</option><option value="no">不可用</option></select></label><label>侵权风险<select aria-label={`第 ${index + 1} 张图片侵权风险`} value={check?.infringement == null ? '' : check.infringement ? 'yes' : 'no'} disabled={locked} onChange={event => updateCheck(asset.id, 'infringement', event.target.value === '' ? null : event.target.value === 'yes')}><option value="">待确认</option><option value="no">未发现</option><option value="yes">存在风险</option></select></label></div>{bestMediaId === asset.id && <span className="formal-best-label">最佳图</span>}</div>;
          })}
        </div>}
        <div className="formal-navigation"><button className="btn btn-small" disabled={position === 0 || loading || busy} onClick={() => navigate(project.questions[position - 1].id)}><ChevronLeft size={14} />上一题</button><span>{position + 1} / {project.questions.length}</span><button className="btn btn-small" disabled={position === project.questions.length - 1 || loading || busy} onClick={() => navigate(project.questions[position + 1].id)}>下一题<ChevronRight size={14} /></button></div>
        </div>
      </section>

      <aside className="panel formal-rating">
        <div className="formal-rating-header"><h2>评测记录</h2><span className={`formal-save-state ${cleanSubmitted ? 'submitted' : ''}`}>{loading ? '读取中' : busy ? '处理中' : dirty ? '未保存' : cleanSubmitted ? '已提交' : savedRevision ? '已存草稿' : '待评测'}</span></div>
        <div className="formal-rating-scroll" ref={ratingScrollRef} role="region" aria-label="评分表单" tabIndex={0}><fieldset disabled={locked}>
          <label className="formal-field"><span>被测产品</span><select value={productId} onChange={event => navigate(questionId, event.target.value)}>{project.products.map((item, index) => <option key={item.id} value={item.id}>{item.name.trim() || `待配置产品 ${index + 1}`}{item.version ? ` · ${item.version}` : ''}{item.demo ? '（模拟）' : ''}</option>)}</select></label>
          <label className="formal-field"><span>当前评测员 <small>本地身份</small></span><select value={reviewerId} onChange={event => { setReviewerId(event.target.value); edited(); }}><option value="">请选择评测员</option>{project.members.map(member => <option key={member.id} value={member.id}>{member.name}{product.ownerId === member.id ? ' · 产品负责人' : ''}</option>)}</select></label>
          <p className="formal-help">本地身份用于记录署名；同一产品、同一题目共同维护一条修订历史。</p>
          {isAnchorMode(project.scheme) && <><AnchorRatings scheme={project.scheme} dimensions={failed && !outputs.length ? ['G'] : questionDimensions} values={ratings} disabled={locked} onChange={value => { setRatings(value); edited(); }}/><p className="anchor-readonly">D 在“走查与成本”按编辑任务打分；E 根据可用率、速度和成本计算。A/B/C/F 任一评分 ≤2 时，最佳图不可标为可用。</p></>}
          <div className="formal-tag-title"><h3>{isAnchorMode(project.scheme) ? '问题标签 · 诊断用' : '最佳图问题标签'}</h3><span>已选 {selectedTags.length} 项</span></div><p className="formal-help">按实际问题选标签，无问题可不选；不用逐项填写。图像标签对应最佳图，流程故障记录在 G 维度。</p>
          {reviewDimensions.map(dimension => {
            const definitions = project.scheme.tags.filter(tag => tag.dimension === dimension.id);
            const assignments = selectedTags.filter(tag => definitions.some(definition => definition.code === tag.code));
            const noOutput = failed && outputs.length === 0 && ['A', 'B', 'C', 'F'].includes(dimension.id);
            const score = isAnchorMode(project.scheme) ? null : noOutput ? project.scheme.policies.failedNoOutput === 'score-one' ? 1 : null : cleanSubmitted || assignments.length ? dimensionScore(assignments.map(tag => tag.severity), true) : null;
            const open = expanded.includes(dimension.id);
            return <div className="formal-tag-group" key={dimension.id}><button className="formal-dimension" aria-expanded={open} onClick={() => setExpanded(previous => open ? previous.filter(id => id !== dimension.id) : [...previous, dimension.id])}><span className="formal-dimension-letter">{dimension.id}</span><strong>{dimension.name}</strong>{!isAnchorMode(project.scheme) && <span className="formal-score">{score == null ? '—' : `${score}.0`}<small>{score != null ? cleanSubmitted ? '/ 5' : '预览' : ''}</small></span>}<ChevronRight size={13} className={open ? 'open' : ''} /></button>
              {open && <div className="formal-tag-options">{definitions.map(definition => {
                const selected = selectedTags.find(tag => tag.code === definition.code);
                return <div className={`formal-tag-option ${selected ? 'checked' : ''}`} key={definition.code}><button aria-pressed={!!selected} onClick={() => toggleTag(definition.code, definition.severity)}><span className="formal-checkbox">{selected && <Check size={11} />}</span><span><small>{definition.code}</small>{definition.name}</span></button>{selected ? <select aria-label={`${definition.code} 严重等级`} value={selected.severity} onChange={event => { setSelectedTags(previous => previous.map(tag => tag.code === definition.code ? { ...tag, severity: event.target.value as Severity } : tag)); edited(); }}>{allowedSeverities(definition).map(severity => <option key={severity} value={severity}>{severity}</option>)}</select> : <span className={`formal-severity severity-${definition.severity.toLowerCase()}`}>{definition.severity}</span>}</div>;
              })}{!definitions.length && <p className="formal-help">此维度未配置问题标签。</p>}</div>}
            </div>;
          })}
          <div className="formal-score-note"><Info size={13} /><span>{isAnchorMode(project.scheme) ? '当前为锚点直评分；以下问题标签仅作诊断与风险检查，不换算分数。' : '草稿的空维度显示 —；正式提交后，无问题标签计 5 分。'}F、G 完整维度分还需结合逐图检查与走查记录。{failed && !outputs.length && <> 当前失败无输出：{project.scheme.policies.failedNoOutput === 'score-one' ? 'A / B / C / F 按已确认规则记 1 分。' : project.scheme.policies.failedNoOutput === 'exclude' ? 'A / B / C / F 按规则排除。' : '评分口径尚未确认。'}</>}</span></div>
          {selectedTags.some(tag => ['A03', 'B01'].includes(normalizeCode(tag.code))) && <p className="formal-warning-text">若涉及价格等关键信息错误或商品品类错误，请按规则将相应标签调整为 P0，并在备注中记录具体证据。</p>}
          <div className="formal-metrics-title"><Clock3 size={15} /><h3>生成记录</h3></div>
          <div className="formal-metrics"><label className="formal-field"><span>耗时 / 秒 <small>提交必填</small></span><input type="number" min="0" step="any" value={seconds} placeholder="实际耗时" onChange={event => { setSeconds(event.target.value); edited(); }} /></label><div><span>总张数</span><strong>{outputs.length}</strong></div><div><span>可用张数</span><strong>{outputs.length && mediaChecks.every(check => check.usable != null) ? usableCount : '—'}</strong></div></div>
          <label className="formal-failed"><input type="checkbox" checked={failed} onChange={event => {
            const checked = event.target.checked;
            setFailed(checked);
            if (checked && !selectedTags.some(tag => ['G03', 'G04'].includes(normalizeCode(tag.code)))) {
              const failureTag = project.scheme.tags.find(tag => normalizeCode(tag.code) === 'G04');
              if (failureTag) setSelectedTags(previous => [...previous, { code: failureTag.code, severity: failureTag.severity }]);
              setExpanded(previous => previous.includes('G') ? previous : [...previous, 'G']);
            }
            edited();
          }} /><span>本次生成失败 / 中断</span></label>
          {failed && <label className="formal-field formal-failure-reason"><span>失败原因 <small>提交必填</small></span><textarea rows={2} value={failureReason} placeholder="记录超时、报错或中断情况；G03 / G04 可按实际调整。" onChange={event => { setFailureReason(event.target.value); edited(); }} /></label>}
          <label className="formal-field formal-notes"><span><Flag size={13} />存疑与备注 <small>选填</small></span><textarea rows={3} value={notes} placeholder="记录判断依据，或需要复核的问题…" onChange={event => { setNotes(event.target.value); edited(); }} /></label>
          <div className="formal-record-context"><span>{savedRevision ? `第 ${savedRevision.revision} 版 · ${savedRevision.status === 'submitted' ? '提交' : '草稿'}于 ${new Date(savedRevision.createdAt).toLocaleString('zh-CN')}` : '尚无保存记录'}</span><span>规则 {project.scheme.version} · 原图 {visibleAssets.length} 张</span></div>
        </fieldset>
          {loadError && <div className="formal-errors" role="alert"><AlertCircle size={15} /><div>{loadError}</div></div>}
          {errors.length > 0 && <div className="formal-errors" role="alert"><AlertCircle size={15} /><div><strong>请检查以下内容</strong><ul>{errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul></div></div>}
        </div>
        <footer className={`formal-rating-footer${position < project.questions.length - 1 ? ' has-next' : ''}`}>
          <button className="btn" aria-label="保存草稿" title="保存草稿" disabled={locked} onClick={() => void persist('draft')}><Save size={15} />保存草稿</button>
          <button className="btn btn-primary" disabled={locked} onClick={() => void persist('submitted', true)}>{busy ? '处理中…' : position === project.questions.length - 1 ? '提交评测' : '提交并下一题'}<ArrowRight size={15} /></button>
          {position < project.questions.length - 1 && <button className="btn formal-draft-next" disabled={locked} onClick={() => void persist('draft', true)}>保存草稿并下一题<ChevronRight size={15} /></button>}
          <p>暂时未填齐可保存草稿并继续，补齐后再提交。</p>
        </footer>
      </aside>
    </div>
    <dialog ref={dialogRef} className="formal-image-dialog" onClose={() => setDialogAsset(null)} onClick={event => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}><div className="formal-dialog-top"><span>{dialogAsset?.name}</span><button className="btn btn-small" onClick={() => dialogRef.current?.close()} aria-label="关闭原图"><X size={18} /></button></div>{dialogAsset && <ImageInspector key={dialogAsset.id} src={assetUrl(dialogAsset)} alt={dialogAsset.name} info={`原始图片 · ${humanSize(dialogAsset.size)}`} />}</dialog>
  </div>;
}
