import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Flag, Image as ImageIcon, Info, Maximize2, Save, Search, Upload, X } from 'lucide-react';
import { dimensions, products, questions, tags, type EvaluationRecord } from '../demo/data';
import { dimensionScore } from '../core/scoring';
import { getValue, setValues } from '../storage/local';
import './assessment.css';

type Props = { onToast: (message: string) => void; onSaved?: () => void; initialQuestionId?: number };
type EvidenceImage = { id: string; name: string; dataUrl: string; demo?: boolean; variant?: number };
type StoredEvaluation = EvaluationRecord & { demo: true; imagesKey: string; rawInputs?: { seconds: string; total: string; usable: string } };
const DEMO_IMAGE = `${import.meta.env.BASE_URL}assets/serum-demo.png`;
const demoImages: EvidenceImage[] = Array.from({ length: 4 }, (_, i) => ({ id: `demo-${i}`, name: `同源演示视图 ${i + 1}`, dataUrl: DEMO_IMAGE, demo: true, variant: i }));
const reviewDimensions = dimensions.filter(d => ['A', 'B', 'C', 'F', 'G'].includes(d.id));
const imageKey = (productId: string, questionId: number) => `evaluation-images:${productId}:${questionId}`;

export default function Evaluation({ onToast, onSaved, initialQuestionId = 1 }: Props) {
  const [productId, setProductId] = useState('p1');
  const [questionId, setQuestionId] = useState(() => questions.find(q => q.id === initialQuestionId)?.id ?? 1);
  const [search, setSearch] = useState('');
  const [records, setRecords] = useState<StoredEvaluation[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [images, setImages] = useState<EvidenceImage[]>(demoImages);
  const [bestImage, setBestImage] = useState(1);
  const [seconds, setSeconds] = useState('');
  const [total, setTotal] = useState('4');
  const [usable, setUsable] = useState('');
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'draft' | 'submitted'>('draft');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [expanded, setExpanded] = useState<string[]>(['A']);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const question = questions.find(q => q.id === questionId) ?? questions[0];
  const product = products.find(p => p.id === productId) ?? products[1];
  const activeImage = images[bestImage - 1];
  const completed = records.filter(r => r.productId === productId && r.status === 'submitted').length;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    Promise.all([
      getValue<StoredEvaluation[]>('evaluation-records', []),
      getValue<EvidenceImage[]>(imageKey(productId, questionId), demoImages)
    ]).then(([allRecords, savedImages]) => {
      if (cancelled) return;
      const record = allRecords.find(r => r.productId === productId && r.questionId === questionId);
      setRecords(allRecords);
      setImages(savedImages);
      setBestImage(Math.min(Math.max(record?.bestImage ?? 1, 1), Math.max(savedImages.length, 1)));
      setSelectedTags(record?.selectedTags ?? []);
      setSeconds(record?.rawInputs?.seconds ?? (record ? String(record.seconds) : ''));
      setTotal(record?.rawInputs?.total ?? (record ? String(record.total) : String(savedImages.length)));
      setUsable(record?.rawInputs?.usable ?? (record ? String(record.usable) : ''));
      setFailed(record?.failed ?? false);
      setNotes(record?.notes ?? '');
      setStatus(record?.status ?? 'draft');
      setSavedAt(record?.updatedAt ?? '');
      setDirty(false);
    }).catch(() => {
      if (!cancelled) {
        setLoadError(true);
        onToast('本地数据读取失败，请刷新重试。当前记录不会被覆盖。');
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [productId, questionId]);

  function edited() {
    setDirty(true);
    setStatus('draft');
  }

  async function persist(nextStatus: 'draft' | 'submitted', announce = true): Promise<boolean> {
    if (loading || saving || loadError) return false;
    const duration = Number(seconds);
    const count = Number(total);
    const available = Number(usable);
    if (nextStatus === 'submitted') {
      if (seconds.trim() === '' || !Number.isFinite(duration) || duration < 0) {
        onToast('请填写有效的生成耗时，须为大于或等于 0 的秒数。');
        return false;
      }
      if (total.trim() === '' || usable.trim() === '' || !Number.isSafeInteger(count) || !Number.isSafeInteger(available) || count < 0 || available < 0 || available > count) {
        onToast('请检查图片张数：总张数和可用张数须为整数，且 0 ≤ 可用张数 ≤ 总张数。');
        return false;
      }
      if (!failed && (!images.length || count === 0)) {
        onToast('非失败任务需上传图片，并填写大于 0 的总张数。');
        return false;
      }
    }
    setSaving(true);
    try {
      const allRecords = await getValue<StoredEvaluation[]>('evaluation-records', []);
      const record: StoredEvaluation = {
        questionId, productId, selectedTags, bestImage, notes,
        seconds: Number.isFinite(duration) ? duration : 0,
        total: Number.isFinite(count) ? count : 0,
        usable: Number.isFinite(available) ? available : 0,
        failed, status: nextStatus, updatedAt: new Date().toISOString(),
        demo: true, imagesKey: imageKey(productId, questionId), rawInputs: { seconds, total, usable }
      };
      const next = [...allRecords.filter(r => !(r.questionId === questionId && r.productId === productId)), record];
      await setValues([[imageKey(productId, questionId), images], ['evaluation-records', next]]);
      setRecords(next);
      setStatus(nextStatus);
      setSavedAt(record.updatedAt);
      setDirty(false);
      onSaved?.();
      if (announce) onToast(nextStatus === 'submitted' ? '演示评测已提交，数据保存在当前浏览器。' : '草稿已保存到当前浏览器。');
      return true;
    } catch {
      onToast('保存失败，修改仍保留在当前页面。请检查浏览器存储后重试。');
      return false;
    } finally { setSaving(false); }
  }

  async function navigate(nextQuestion: number, nextProduct = productId) {
    if (loading || saving || (nextQuestion === questionId && nextProduct === productId)) return;
    if (dirty && !(await persist('draft', false))) return;
    setQuestionId(nextQuestion);
    setProductId(nextProduct);
  }

  async function submitAndNext() {
    if (await persist('submitted')) {
      if (questionId < questions.length) setQuestionId(questionId + 1);
    }
  }

  async function uploadImages(files: FileList | null) {
    if (!files?.length) return;
    const validFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (validFiles.length !== files.length) { onToast('请仅选择图片文件。'); return; }
    setSaving(true);
    try {
      const uploaded = await Promise.all(validFiles.map(file => new Promise<EvidenceImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read failed'));
        reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name, dataUrl: String(reader.result) });
        reader.readAsDataURL(file);
      })));
      const next = [...images.filter(image => !image.demo), ...uploaded];
      setImages(next);
      setBestImage(1);
      setTotal(String(next.length));
      edited();
      onToast(`已读取 ${uploaded.length} 张原图；保存草稿后写入本机，图片不会外传。`);
    } catch { onToast('图片未能保存，请检查本地存储空间后重试。'); }
    finally { setSaving(false); if (uploadRef.current) uploadRef.current.value = ''; }
  }

  const filteredQuestions = questions.filter(q => `${q.id} ${q.title} ${q.scene} ${q.category}`.includes(search));
  const acceptance = questionId === 1
    ? ['瓶身轮廓、颜色与参考商品一致', '浅米色台面，自然柔光，商品是视觉主体', '无多余文字、结构畸变和明显悬浮感']
    : ['按照需求呈现商品主体与指定场景', '检查商品结构、文字及画面细节', '本题为演示占位，正式验收要点需由题库导入'];

  return <div className="assessment-page">
    <header className="page-heading assessment-heading">
      <div><div className="eyebrow">EVALUATION WORKSPACE</div><h1>逐题评测</h1><p className="muted">对照需求与验收要点，记录每一次判断的依据。</p></div>
      <div className="assessment-heading-actions"><span className="assessment-local-dot" />仅保存在本机<span className="badge">演示项目</span></div>
    </header>
    <div className="assessment-demo-notice"><Info size={16} /><span><strong>演示数据</strong> · 50 道题均为占位示例；商品图是同一素材的 4 个预览视图，所有记录均标记为演示，不进入真实评测结论。</span></div>
    <div className="assessment-layout" aria-busy={loading || saving}>
      <aside className="panel assessment-question-panel">
        <div className="assessment-question-top"><div className="section-heading"><h2>评测题目</h2><span>{questions.length}</span></div>
          <div className="assessment-progress-summary"><span>本机已提交</span><strong>{completed}<small> / 50</small></strong></div>
          <div className="assessment-progress-track"><span style={{ width: `${completed * 2}%` }} /></div>
          <label className="assessment-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索题号、场景" aria-label="搜索题目" /></label>
        </div>
        <div className="assessment-question-list">{filteredQuestions.map(q => {
          const record = records.find(r => r.questionId === q.id && r.productId === productId);
          return <button key={q.id} className={`assessment-question ${q.id === questionId ? 'active' : ''}`} onClick={() => void navigate(q.id)} disabled={loading || saving}>
            <span className={`assessment-question-number ${record?.status === 'submitted' ? 'complete' : ''}`}>{record?.status === 'submitted' ? <Check size={13} /> : String(q.id).padStart(2, '0')}</span>
            <span className="assessment-question-copy"><strong>{q.title}</strong><small>{q.scene} · {q.difficulty}</small></span>
            {record?.status === 'draft' && <span className="assessment-draft-dot" title="已保存草稿" />}
          </button>;
        })}{!filteredQuestions.length && <p className="assessment-empty">没有匹配的题目</p>}</div>
        <div className="assessment-question-bottom"><span className="assessment-tiny-dot" />空白题不会自动计为完成</div>
      </aside>

      <section className="assessment-evidence-column">
        <div className="panel assessment-brief">
          <div className="assessment-brief-top"><span className="assessment-question-kicker">QUESTION {String(questionId).padStart(2, '0')} <span>/ 50</span></span><span className="pill">演示占位</span></div>
          <h2>{question.title}</h2>
          <div className="assessment-meta"><span>{question.scene}</span><span>{question.category}</span><span>{question.difficulty}</span></div>
          <div className="assessment-request-label">需求描述</div><p className="assessment-request">{question.request}</p>
          <div className="assessment-request-label">验收要点</div>
          <ul className="assessment-acceptance">{acceptance.map(item => <li key={item}><CheckCircle2 size={14} /><span>{item}</span></li>)}</ul>
        </div>
        <div className="panel assessment-image-panel">
          <div className="assessment-image-heading"><h3><ImageIcon size={16} />生成结果 <span>{images.length} 个{images.some(image => image.demo) ? '视图' : '文件'}</span></h3><button className="btn btn-small" onClick={() => uploadRef.current?.click()} disabled={loading || saving}><Upload size={14} />上传原图</button><input ref={uploadRef} type="file" accept="image/*" multiple hidden onChange={event => void uploadImages(event.target.files)} /></div>
          <button className="assessment-main-image" onClick={() => activeImage && dialogRef.current?.showModal()} aria-label="放大查看当前图片" disabled={!activeImage}>
            {activeImage ? <img className={`assessment-image-variant-${activeImage.variant ?? 0}`} src={activeImage.dataUrl} alt={activeImage.demo ? '精华液商品场景演示素材，非产品实测输出' : activeImage.name} /> : <span className="assessment-no-image"><ImageIcon size={34} />暂无原图</span>}
            <span className="assessment-image-source">{activeImage?.demo ? '示范素材 · 非实测输出' : '本机原图 · 未外传'}</span>
            <span className="assessment-zoom"><Maximize2 size={16} /></span>
          </button>
          <div className="assessment-thumbnails">{images.map((image, index) => <button key={image.id} className={`assessment-thumbnail ${bestImage === index + 1 ? 'selected' : ''}`} onClick={() => { setBestImage(index + 1); edited(); }} title={image.name} disabled={loading || saving}>
            <img className={`assessment-image-variant-${image.variant ?? 0}`} src={image.dataUrl} alt={`选择第 ${index + 1} 个${image.demo ? '演示视图' : '图片'}`} /><span>{String(index + 1).padStart(2, '0')}</span>{bestImage === index + 1 && <i><Check size={12} /></i>}
          </button>)}</div>
          <div className="assessment-image-caption"><span><CheckCircle2 size={13} />当前最佳{activeImage?.demo ? '视图' : '图'}：{String(bestImage).padStart(2, '0')}</span><span>点击缩略图选择，点击大图放大</span></div>
        </div>
        <div className="assessment-navigation"><button className="btn btn-small" disabled={questionId === 1 || loading || saving} onClick={() => void navigate(questionId - 1)}><ChevronLeft size={14} />上一题</button><span>{questionId} / {questions.length} · 切题时自动保存修改为草稿</span><button className="btn btn-small" disabled={questionId === questions.length || loading || saving} onClick={() => void navigate(questionId + 1)}>下一题<ChevronRight size={14} /></button></div>
      </section>

      <aside className="panel assessment-rating-panel">
        <div className="assessment-rating-header"><h2>评测记录</h2><span className={`assessment-save-state ${status === 'submitted' && !dirty ? 'submitted' : ''}`}>{loading ? '读取中' : dirty ? '未保存' : status === 'submitted' ? '已提交' : savedAt ? '已存草稿' : '待评测'}</span></div>
        <div className="assessment-rating-scroll"><fieldset className="assessment-fields" disabled={loading || saving || loadError}>
          <label className="field assessment-product-field"><span>被测产品</span><select className="input" value={productId} disabled={loading || saving} onChange={event => void navigate(questionId, event.target.value)}>{products.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select></label>
          <div className="assessment-tag-heading"><h3>最佳图问题标签</h3><span>已选 {selectedTags.length} 项</span></div>
          <p className="assessment-help">只标记观察到的问题，同一问题优先记录根因。</p>
          {reviewDimensions.map(dimension => {
            const dimensionTags = tags.filter(tag => tag.dimension === dimension.id);
            const selected = dimensionTags.filter(tag => selectedTags.includes(tag.code));
            const submitted = status === 'submitted' && !dirty;
            const noImageOutput = total.trim() !== '' && Number(total) === 0;
            const score = noImageOutput && (['A', 'B', 'C', 'F'].includes(dimension.id) || !selected.length) ? null : submitted || selected.length ? dimensionScore(selected.map(tag => tag.severity), true) : null;
            const isExpanded = expanded.includes(dimension.id);
            return <div className="assessment-tag-group" key={dimension.id}>
              <button className="assessment-dimension-header" aria-expanded={isExpanded} onClick={() => setExpanded(value => isExpanded ? value.filter(id => id !== dimension.id) : [...value, dimension.id])}>
                <span className="assessment-dimension-letter">{dimension.id}</span><strong>{dimension.name}</strong><span className="assessment-dimension-score">{score === null ? '—' : `${score}.0`}<small>{score !== null && !submitted ? '预览' : ' / 5'}</small></span><ChevronRight size={13} className={isExpanded ? 'assessment-chevron-open' : ''} />
              </button>
              {isExpanded && <div className="assessment-tag-options">{dimensionTags.map(tag => {
                const checked = selectedTags.includes(tag.code);
                return <button key={tag.code} className={`assessment-tag-option ${checked ? 'checked' : ''}`} aria-pressed={checked} onClick={() => { setSelectedTags(value => checked ? value.filter(code => code !== tag.code) : [...value, tag.code]); edited(); }} disabled={loading || saving}><span className="assessment-checkbox">{checked && <Check size={11} />}</span><span className="assessment-tag-name">{tag.name}</span><span className={`assessment-severity severity-${tag.severity.toLowerCase()}`}>{tag.severity}</span></button>;
              })}</div>}
            </div>;
          })}
          <p className="assessment-score-hint"><Info size={13} /><span>未提交时空白维度不计分。标签得分仅为预览；G 维度还需结合走查。</span></p>
          <div className="assessment-metrics-heading"><Clock3 size={15} /><h3>生成记录</h3></div>
          <div className="assessment-numeric-fields"><label className="field"><span>耗时 / 秒</span><input className="input" type="number" min="0" placeholder="待填写" value={seconds} onChange={event => { setSeconds(event.target.value); edited(); }} /></label><label className="field"><span>总张数</span><input className="input" type="number" min="0" step="1" value={total} onChange={event => { setTotal(event.target.value); edited(); }} /></label><label className="field"><span>可用张数</span><input className="input" type="number" min="0" step="1" placeholder="待填写" value={usable} onChange={event => { setUsable(event.target.value); edited(); }} /></label></div>
          <label className="assessment-failed"><input type="checkbox" checked={failed} onChange={event => { setFailed(event.target.checked); edited(); }} /><span>本次生成失败 / 中断</span></label>
          <label className="field assessment-notes"><span><Flag size={14} />存疑与备注 <small>选填</small></span><textarea className="input" rows={3} placeholder="记录判断依据，或需要复核的问题…" value={notes} onChange={event => { setNotes(event.target.value); edited(); }} /></label>
          {loadError && <p className="assessment-error"><AlertCircle size={14} />本地数据读取失败，暂不可保存。</p>}
          <div className="assessment-record-context">{product.name} · 题目 {String(questionId).padStart(2, '0')} · 演示记录{savedAt && <span><Clock3 size={11} />{new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 保存</span>}</div>
        </fieldset></div>
        <footer className="assessment-rating-footer"><button className="btn" disabled={loading || saving || loadError} onClick={() => void persist('draft')}><Save size={15} />保存草稿</button><button className="btn btn-primary" disabled={loading || saving || loadError} onClick={() => void submitAndNext()}>{saving ? '保存中…' : questionId === questions.length ? '提交评测' : '提交并下一题'}<ArrowRight size={15} /></button></footer>
      </aside>
    </div>
    <dialog ref={dialogRef} className="assessment-image-dialog" onClick={event => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}><div className="assessment-dialog-top"><span>{activeImage?.name}</span><button className="btn btn-small" onClick={() => dialogRef.current?.close()} aria-label="关闭大图"><X size={18} /></button></div>{activeImage && <img src={activeImage.dataUrl} alt={activeImage.name} />}<p>{activeImage?.demo ? '同一示范素材的原始视图，不代表任何被测产品的真实输出。' : '查看本地保存的原始图片。'}</p></dialog>
  </div>;
}
