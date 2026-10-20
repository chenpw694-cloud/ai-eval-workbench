import { defaultAnchors, isAnchorMode, ratedDimensions } from '../core/ratings';
import '../components/anchor-ratings.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, Download, FileJson, FileSpreadsheet,
  Info, LockKeyhole, Pencil, Plus, Save, Search, ShieldCheck, Trash2, Upload, X
} from 'lucide-react';
import type { Member, Product, ProductRole, Project, Question, Scheme } from '../core/model.ts';
import { parseCsv, parseQuestionsJson, questionsFromRows } from '../core/questions.ts';
import { PageHeading, PanelHeading, Pill } from '../ui';
import './project-setup.css';

type Props = {
  project: Project;
  locked: boolean;
  onSave: (project: Project) => Promise<void>;
  onToast: (message: string) => void;
};

type SetupTab = 'project' | 'questions' | 'rules';
type CsvSource = { headers: string[]; rows: string[][] };
type QuestionEditor = {
  originalId: string | null;
  id: string;
  title: string;
  scene: string;
  category: string;
  difficulty: string;
  request: string;
  acceptanceText: string;
  referenceText: string;
  fields: { name: string; value: string }[];
};

const importFields = [
  { key: 'id', label: '题号', required: true, aliases: ['题号', '题目编号', 'id', 'questionId'] },
  { key: 'title', label: '题目标题', aliases: ['题目标题', '标题', 'title'] },
  { key: 'scene', label: '场景', aliases: ['场景', 'scene'] },
  { key: 'category', label: '品类', aliases: ['品类', 'category'] },
  { key: 'difficulty', label: '难度', aliases: ['难度', 'difficulty'] },
  { key: 'request', label: '需求描述', required: true, aliases: ['需求描述', '需求', '提示词', 'request', 'prompt'] },
  { key: 'acceptance', label: '验收要点', required: true, aliases: ['验收要点', '验收标准', 'acceptance'] },
  { key: 'referenceNames', label: '参考图文件名', aliases: ['参考图文件名', '参考图', 'referenceNames', 'ref_images', 'referenceImages', 'images'] }
];

const roleLabels: Record<ProductRole, string> = {
  self: '自家产品',
  direct: '直接竞品',
  benchmark: '标杆竞品',
  alternative: '替代竞品'
};

function downloadText(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function defaultMapping(headers: string[]): Record<string, string> {
  return Object.fromEntries(importFields.map(field => [
    field.key,
    headers.find(header => field.aliases.some(alias => alias.toLowerCase() === header.toLowerCase().trim())) ?? ''
  ]));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请检查文件内容后重试。';
}

function distribution(questions: Question[], field: 'scene' | 'category' | 'difficulty') {
  const counts = new Map<string, number>();
  questions.forEach(question => {
    const key = question[field] || '未填写';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts.entries()];
}

function createEditor(question?: Question, nextId = 'Q-001'): QuestionEditor {
  return {
    originalId: question?.id ?? null,
    id: question?.id ?? nextId,
    title: question?.title ?? '',
    scene: question?.scene ?? '',
    category: question?.category ?? '',
    difficulty: question?.difficulty ?? '',
    request: question?.request ?? '',
    acceptanceText: question?.acceptance.join('\n') ?? '',
    referenceText: question?.referenceNames.join('\n') ?? '',
    fields: Object.entries(question?.fields ?? {}).map(([name, value]) => ({ name, value }))
  };
}

function Notice({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warning' | 'success' }) {
  return <div className={`setup-notice setup-notice-${tone}`}>
    {tone === 'success' ? <CheckCircle2 size={16} /> : tone === 'warning' ? <AlertCircle size={16} /> : <Info size={16} />}
    <div>{children}</div>
  </div>;
}

export default function ProjectSetup({ project, locked, onSave, onToast }: Props) {
  const [tab, setTab] = useState<SetupTab>('project');
  const [draft, setDraft] = useState<Project>(() => structuredClone(project));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [csvSource, setCsvSource] = useState<CsvSource | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [jsonQuestions, setJsonQuestions] = useState<Question[] | null>(null);
  const [filename, setFilename] = useState('');
  const [importError, setImportError] = useState('');
  const [importMode, setImportMode] = useState<'append' | 'replace'>('append');
  const [readingFile, setReadingFile] = useState(false);
  const [questionSearch, setQuestionSearch] = useState('');
  const [editor, setEditor] = useState<QuestionEditor | null>(null);
  const [editorError, setEditorError] = useState('');
  const [showAllTags, setShowAllTags] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorBaseline = useRef<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    setDraft(structuredClone(project));
    setSaveError('');
  }, [project.id, project.revision, project.updatedAt]);

  useEffect(() => {
    if (locked) setEditor(null);
  }, [locked]);

  useEffect(() => {
    if (!editor) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) setEditor(null);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [editor, saving]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(project);
  const editorDirty = editor !== null && JSON.stringify(editor) !== editorBaseline.current;
  const unsavedChanges = dirty || editorDirty;
  dirtyRef.current = unsavedChanges;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('formal-dirty', { detail: unsavedChanges }));
  }, [unsavedChanges]);

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

  const weightTotal = draft.scheme.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const weightsValid = Math.abs(weightTotal - 100) < .001 && draft.scheme.dimensions.every(
    dimension => Number.isFinite(dimension.weight) && dimension.weight >= 0 && dimension.weight <= 100
  );
  const unresolvedCount = Object.values(draft.scheme.policies).filter(value => value === 'unresolved').length;
  const realProducts = draft.products.filter(product => !product.demo);
  const pendingProducts = realProducts.filter(product => !product.name.trim() || !product.version.trim() || !product.ownerId);
  const questionsWithReferences = draft.questions.filter(question => question.referenceNames.length > 0).length;

  const importPreview = useMemo(() => {
    if (csvSource) {
      try {
        return { questions: questionsFromRows(csvSource.headers, csvSource.rows, mapping), error: '' };
      } catch (error) {
        return { questions: [] as Question[], error: errorText(error) };
      }
    }
    return { questions: jsonQuestions ?? [], error: '' };
  }, [csvSource, mapping, jsonQuestions]);

  const duplicateExistingIds = importMode === 'append'
    ? importPreview.questions.filter(question => draft.questions.some(existing => existing.id === question.id)).map(question => question.id)
    : [];
  const visibleQuestions = draft.questions.filter(question =>
    `${question.id} ${question.title} ${question.request}`.toLowerCase().includes(questionSearch.toLowerCase())
  );

  function updateProject<K extends keyof Project>(key: K, value: Project[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setSaveError('');
  }

  function updateProduct(id: string, changes: Partial<Product>) {
    updateProject('products', draft.products.map(product => product.id === id ? { ...product, ...changes } : product));
  }

  function updateMember(id: string, changes: Partial<Member>) {
    updateProject('members', draft.members.map(member => member.id === id ? { ...member, ...changes } : member));
  }

  function changePolicy<K extends keyof Scheme['policies']>(key: K, value: Scheme['policies'][K]) {
    setDraft(previous => ({
      ...previous,
      rulesConfirmed: false,
      scheme: { ...previous.scheme, policies: { ...previous.scheme.policies, [key]: value } }
    }));
  }

  function validateSnapshot(next: Project): string {
    if (!next.name.trim()) return '请填写项目名称。';
    if (!Number.isInteger(next.expectedQuestionCount) || next.expectedQuestionCount < 1) {
      return '计划题量须为大于 0 的整数。';
    }
    if (next.members.some(member => !member.name.trim())) return '请填写每位成员的姓名，或删除尚未使用的空白成员。';
    const total = next.scheme.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
    if (Math.abs(total - 100) >= .001 || next.scheme.dimensions.some(dimension => !Number.isFinite(dimension.weight) || dimension.weight < 0 || dimension.weight > 100)) {
      return '维度权重须在 0–100% 之间，且合计为 100%。';
    }
    return '';
  }

  async function persist(next: Project, message: string): Promise<boolean> {
    const validation = validateSnapshot(next);
    if (validation) {
      setSaveError(validation);
      onToast(validation);
      return false;
    }
    setSaving(true);
    setSaveError('');
    try {
      await onSave(next);
      setDraft(structuredClone(next));
      onToast(message);
      return true;
    } catch (error) {
      const message = errorText(error);
      setSaveError(message);
      onToast(`保存未完成：${message}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  function addProduct() {
    const product: Product = {
      id: `product_${crypto.randomUUID()}`,
      name: '', version: '', role: 'direct', demo: false, ownerId: '',
      totalCost: null, commercialUse: 'unreviewed', commercialEvidence: ''
    };
    updateProject('products', [...draft.products, product]);
  }

  function removeProduct(product: Product) {
    if (locked) return;
    if (!window.confirm(`从当前配置中删除“${product.name || '未命名产品'}”？保存时仍会检查已有记录引用。`)) return;
    updateProject('products', draft.products.filter(item => item.id !== product.id));
  }

  async function readImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || locked) return;
    setReadingFile(true);
    setImportError('');
    setCsvSource(null);
    setJsonQuestions(null);
    setFilename(file.name);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('题库文件超过 20 MB，请拆分为更小的批次。');
      const text = await file.text();
      if (/\.csv$/i.test(file.name)) {
        const parsed = parseCsv(text);
        setMapping(defaultMapping(parsed.headers));
        setCsvSource(parsed);
      } else if (/\.json$/i.test(file.name)) {
        setJsonQuestions(parseQuestionsJson(text));
      } else {
        throw new Error('请选择 .csv 或 .json 格式的题库文件。');
      }
    } catch (error) {
      setImportError(errorText(error));
    } finally {
      setReadingFile(false);
    }
  }

  async function confirmImport() {
    if (locked || importPreview.error || importError || duplicateExistingIds.length || !importPreview.questions.length) return;
    if (importMode === 'replace' && draft.questions.length && !window.confirm('整体替换会移除当前题库中未包含在新文件的题目。确认使用这批题目？已有记录引用将由保存流程再次检查。')) return;
    const questions = importMode === 'append'
      ? [...draft.questions, ...importPreview.questions]
      : importPreview.questions;
    const success = await persist({ ...draft, questions }, `已保存 ${importPreview.questions.length} 道题，当前共 ${questions.length} 道`);
    if (success) {
      setCsvSource(null);
      setJsonQuestions(null);
      setFilename('');
      setImportError('');
    }
  }

  function openQuestion(question?: Question) {
    if (locked) return;
    let index = draft.questions.length + 1;
    while (draft.questions.some(item => item.id === `Q-${String(index).padStart(3, '0')}`)) index += 1;
    const nextEditor = createEditor(question, `Q-${String(index).padStart(3, '0')}`);
    editorBaseline.current = JSON.stringify(nextEditor);
    setEditor(nextEditor);
    setEditorError('');
  }

  async function saveQuestion() {
    if (!editor || locked) return;
    setEditorError('');
    try {
      const names = editor.fields.map(field => field.name.trim());
      if (names.some(name => !name)) throw new Error('自定义字段名称不能为空。');
      if (new Set(names).size !== names.length) throw new Error('自定义字段名称不能重复。');
      const [question] = parseQuestionsJson(JSON.stringify([{
        id: editor.id, title: editor.title, scene: editor.scene,
        category: editor.category, difficulty: editor.difficulty,
        request: editor.request, acceptance: editor.acceptanceText,
        referenceNames: editor.referenceText,
        fields: Object.fromEntries(editor.fields.map(field => [field.name.trim(), field.value]))
      }]));
      if (draft.questions.some(item => item.id === question.id && item.id !== editor.originalId)) {
        throw new Error(`题号“${question.id}”已经存在，请使用唯一题号。`);
      }
      const questions = editor.originalId
        ? draft.questions.map(item => item.id === editor.originalId ? question : item)
        : [...draft.questions, question];
      const success = await persist({ ...draft, questions }, editor.originalId ? '题目修改已保存' : '新题目已保存');
      if (success) setEditor(null);
    } catch (error) {
      setEditorError(errorText(error));
    }
  }

  async function deleteQuestion(question: Question) {
    if (locked || !window.confirm(`删除题目“${question.id} · ${question.title}”？保存时会检查是否被已有记录引用。`)) return;
    await persist({ ...draft, questions: draft.questions.filter(item => item.id !== question.id) }, '题目已从当前题库删除');
  }

  function downloadTemplate() {
    // Headers are fixed, contain no user data, and include a UTF-8 BOM for Excel.
    downloadText('评测题库-空模板.csv', '\uFEFF题号,题目标题,场景,品类,难度,需求描述,验收要点,参考图文件名\r\n', 'text/csv;charset=utf-8;');
    onToast('已生成仅含中文表头的 CSV 空模板');
  }

  const importDisabled = locked || saving || readingFile;

  return <div className="project-setup">
    <PageHeading
      eyebrow="PROJECT CONFIGURATION"
      title="项目配置"
      description="填写真实产品、导入自己的题库，并确认本次评测使用的规则快照。"
      action={<>
        <button className="btn" disabled={saving || !dirty} onClick={() => { setDraft(structuredClone(project)); setSaveError(''); }}>撤销修改</button>
        <button className="btn btn-primary" disabled={saving || !dirty} onClick={() => persist(draft, '项目配置已保存到本地')}>
          <Save size={15} />{saving ? '保存中…' : '保存配置'}
        </button>
      </>}
    />

    <div className="setup-status-bar">
      <span><FileJson size={15} />{draft.scheme.name} <code>v{draft.scheme.version}</code></span>
      <Pill tone={locked ? 'orange' : dirty ? 'violet' : 'green'}>
        {locked ? '已分发或开始评测 · 配置锁定' : dirty ? '有未保存修改' : '本地项目快照'}
      </Pill>
    </div>

    {locked && <Notice tone="warning">
      <strong>已分发或开始评测，评测口径已锁定。</strong> 可修改项目名称、背景和周期；成员、产品、题目、权重及评分政策保持当前快照。{project.status === 'draft' && <> 尚未分发的项目，允许补填原本空白的产品名称或版本；已填写的身份信息保持锁定。</>}
    </Notice>}

    {saveError && <div className="setup-error" role="alert"><AlertCircle size={16} />{saveError}</div>}

    <nav className="setup-tabs" aria-label="项目配置分类">
      {([
        { id: 'project', label: '项目与分工', count: draft.products.length },
        { id: 'questions', label: '题库管理', count: draft.questions.length },
        { id: 'rules', label: '规则确认', count: undefined }
      ] as const).map(item => <button
        key={item.id}
        className={tab === item.id ? 'active' : ''}
        onClick={() => setTab(item.id)}
        aria-current={tab === item.id ? 'page' : undefined}
      >{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}
    </nav>

    {tab === 'project' && <>
      <section className="panel setup-section">
        <PanelHeading title="项目信息" subtitle="这份信息会随评测记录一起保存和导出。" />
        <div className="setup-form-grid">
          <label className="setup-field setup-wide">项目名称 <span>*</span>
            <input value={draft.name} onChange={event => updateProject('name', event.target.value)} disabled={saving} placeholder="例如：电商文生图竞品评测" />
          </label>
          <label className="setup-field setup-wide">评测背景
            <textarea rows={3} value={draft.background} onChange={event => updateProject('background', event.target.value)} disabled={saving} placeholder="说明业务背景、评测目的和希望支持的产品决策" />
          </label>
          <label className="setup-field">评测周期
            <input value={draft.period} onChange={event => updateProject('period', event.target.value)} disabled={saving} placeholder="例如：3 天，另留 1 天机动" />
          </label>
          <label className="setup-field">计划题量 <span className="setup-optional">正式提交前须全部导入</span>
            <input type="number" min={1} step={1} value={draft.expectedQuestionCount} onChange={event => updateProject('expectedQuestionCount', Number(event.target.value))} disabled={locked || saving} />
            <small>独立试跑 2 题时请设为 2；分发或开始评测后冻结题库和规则，后续完整 50 题评测需另建项目。</small>
          </label>
        </div>
      </section>

      <section className="panel setup-section">
        <PanelHeading
          title="评测成员"
          subtitle="成员 ID 保持稳定，产品负责人通过 ID 关联；分工是本地流程信息，不是登录权限。"
          action={<button className="btn btn-small" disabled={locked || saving} onClick={() => updateProject('members', [...draft.members, { id: `member_${crypto.randomUUID()}`, name: '' }])}><Plus size={14} />添加成员</button>}
        />
        <div className="setup-members">
          {draft.members.map((member, index) => {
            const assigned = draft.products.filter(product => product.ownerId === member.id);
            return <div className="setup-member" key={member.id}>
              <span className="setup-member-avatar">{index + 1}</span>
              <label className="setup-member-name">
                <span>成员姓名</span>
                <input aria-label={`成员 ${index + 1} 姓名`} value={member.name} placeholder="填写真实姓名" disabled={locked || saving} onChange={event => updateMember(member.id, { name: event.target.value })} />
              </label>
              <span className="setup-member-assignment">负责 {assigned.length} 个产品</span>
              <button className="setup-icon-button" aria-label={`删除成员 ${member.name || index + 1}`} disabled={locked || saving || assigned.length > 0} title={assigned.length ? '请先重新分配其负责的产品，再删除成员' : '删除成员'} onClick={() => updateProject('members', draft.members.filter(item => item.id !== member.id))}><Trash2 size={15} /></button>
            </div>;
          })}
          {!draft.members.length && <div className="setup-empty">还没有成员。添加成员后可以分配产品负责人。</div>}
        </div>
      </section>

      <section className="setup-products-section">
        <PanelHeading
          title="被测产品与负责人"
          subtitle="产品名称和版本请按实际填写；模拟产品单独标记，不进入真实产品汇总。"
          action={<button className="btn btn-small" disabled={locked || saving} onClick={addProduct}><Plus size={14} />添加产品</button>}
        />
        <div className="setup-products-grid">
          {draft.products.map((product, index) => <article className={`panel setup-product ${product.demo ? 'is-demo' : ''}`} key={product.id}>
            <div className="setup-product-heading">
              <span className="setup-product-index">{String(index + 1).padStart(2, '0')}</span>
              <strong>{product.name.trim() || '待填写产品名称'}</strong>
              <Pill tone={product.demo ? 'violet' : 'green'}>{product.demo ? '模拟产品' : '真实评测'}</Pill>
              <button className="setup-icon-button" aria-label={`删除产品 ${product.name || index + 1}`} disabled={locked || saving} onClick={() => removeProduct(product)}><Trash2 size={15} /></button>
            </div>
            <div className="setup-form-grid">
              <label className="setup-field">产品名称
                <input value={product.name} placeholder="填写实际产品名称" disabled={saving || (locked && !(project.status === 'draft' && !project.products.find(item => item.id === product.id)?.name.trim()))} onChange={event => updateProduct(product.id, { name: event.target.value })} />
              </label>
              <label className="setup-field">版本 / 会员档位
                <input value={product.version} placeholder="例如：Web 版 / 专业会员" disabled={saving || (locked && !(project.status === 'draft' && !project.products.find(item => item.id === product.id)?.version.trim()))} onChange={event => updateProduct(product.id, { version: event.target.value })} />
              </label>
              <label className="setup-field">竞品角色
                <select value={product.role} disabled={locked || saving} onChange={event => updateProduct(product.id, { role: event.target.value as ProductRole })}>
                  {Object.entries(roleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label className="setup-field">产品负责人
                <select value={product.ownerId} disabled={locked || saving} onChange={event => updateProduct(product.id, { ownerId: event.target.value })}>
                  <option value="">请选择成员</option>
                  {draft.members.map(member => <option value={member.id} key={member.id}>{member.name || '未命名成员'}</option>)}
                </select>
              </label>
            </div>
            <label className="setup-demo-toggle"><input type="checkbox" checked={product.demo} disabled={locked || saving} onChange={event => updateProduct(product.id, { demo: event.target.checked })} /><span>这是模拟产品，用于界面演示</span></label>
            {product.demo && <p className="setup-demo-description">模拟数据可独立试用，不纳入真实排名、可用率及对比结论。</p>}
          </article>)}
          {!draft.products.length && <div className="panel setup-empty setup-wide">还没有被测产品。添加真实产品，或明确标记一个模拟产品试用流程。</div>}
        </div>
      </section>
      {pendingProducts.length > 0 && <Notice tone="warning">有 {pendingProducts.length} 个真实产品尚未填齐名称、版本或负责人。已配置好的产品可先逐题评测；团队分发、质检和最终汇总前须补齐全部产品。尚未使用的产品可在开始评测前删除。</Notice>}
      <div className="setup-footer"><span>保存的是当前浏览器中的项目快照，仓库方案文件不会自动修改。</span><button className="btn btn-primary" disabled={saving || !dirty} onClick={() => persist(draft, '项目信息与产品分工已保存')}><Save size={14} />保存配置</button></div>
    </>}

    {tab === 'questions' && <>
      <div className="setup-question-summary">
        <div><span>当前题库</span><strong>{draft.questions.length}<small> / {draft.expectedQuestionCount} 题</small></strong></div>
        <div><span>场景覆盖</span><strong>{new Set(draft.questions.map(question => question.scene).filter(Boolean)).size}<small>类</small></strong></div>
        <div><span>含参考图文件名</span><strong>{questionsWithReferences}<small>题 · 文件仍待上传</small></strong></div>
      </div>
      <Notice>可先导入少量题目并保存草稿，但计划 {draft.expectedQuestionCount} 题就须导入完整 {draft.expectedQuestionCount} 题后才能分发或开始正式评测。独立试跑 2 题时，请先将计划题量改为 2；分发或开始评测即冻结题库和规则。JSON 支持 ref_images、referenceImages、images 的文件名数组及图片对象；图片链接和元数据保留在“更多题目字段”，实际图片仍在逐题评测页上传。</Notice>

      <section className="panel setup-section setup-import-section">
        <PanelHeading
          title="导入题库"
          subtitle="CSV 可自定义列名并进行映射；JSON 使用标准题目结构。任何一行有误，整批都不会写入。"
          action={<button className="btn btn-small" onClick={downloadTemplate}><Download size={14} />CSV 空模板</button>}
        />
        <div className="setup-upload-body">
          <input type="file" ref={fileInput} accept=".csv,.json,text/csv,application/json" hidden onChange={readImportFile} />
          <button className="setup-upload-button" disabled={importDisabled} onClick={() => fileInput.current?.click()}>
            <span><Upload size={20} /></span>
            <strong>{readingFile ? '正在读取文件…' : filename ? '重新选择题库文件' : '选择 CSV 或 JSON 文件'}</strong>
            <small>{locked ? '已分发或开始评测，题库已锁定' : '在本地解析文件，预览确认后才保存 · 最大 20 MB'}</small>
          </button>

          {filename && <div className="setup-selected-file"><FileSpreadsheet size={15} /><strong>{filename}</strong><button className="setup-icon-button" disabled={saving} aria-label="取消本次导入" onClick={() => { setFilename(''); setCsvSource(null); setJsonQuestions(null); setImportError(''); }}><X size={14} /></button></div>}
          {importError && <div className="setup-error" role="alert"><AlertCircle size={16} />{importError}</div>}

          {csvSource && <div className="setup-mapping">
            <h3>匹配题目字段</h3>
            <p>标记 * 的字段必填；未映射的源列会作为自定义字段保留。</p>
            <div className="setup-mapping-grid">
              {importFields.map(field => <label className="setup-field" key={field.key}>{field.label}{field.required && <span>*</span>}
                <select value={mapping[field.key] ?? ''} disabled={importDisabled} onChange={event => setMapping(previous => ({ ...previous, [field.key]: event.target.value }))}>
                  <option value="">{field.required ? '请选择来源列' : '不映射'}</option>
                  {csvSource.headers.map(header => <option key={header} value={header}>{header}</option>)}
                </select>
              </label>)}
            </div>
          </div>}

          {(csvSource || jsonQuestions) && <>
            {importPreview.error ? <div className="setup-error" role="alert"><AlertCircle size={16} />{importPreview.error}</div> : <>
              <div className="setup-preview-heading"><strong>导入预览 <span>{importPreview.questions.length} 道题</span></strong><span>最多预览前 6 道</span></div>
              <div className="setup-table-scroll"><table className="setup-table"><thead><tr><th>题号 / 标题</th><th>场景 / 品类</th><th>需求描述</th><th>验收与附件</th></tr></thead><tbody>
                {importPreview.questions.slice(0, 6).map(question => <tr key={question.id}><td><code>{question.id}</code><strong>{question.title}</strong></td><td>{question.scene || '未填场景'}<small>{question.category || '未填品类'} · {question.difficulty || '未填难度'}</small></td><td><p>{question.request}</p></td><td>{question.acceptance.length} 项验收<small>{question.referenceNames.length} 个参考文件名 · {Object.keys(question.fields).length} 个自定义字段</small></td></tr>)}
              </tbody></table></div>
              {!importPreview.questions.length && <div className="setup-empty">文件只有表头或空数组，没有可导入的题目。</div>}
              <div className="setup-import-mode"><label><input type="radio" name="import-mode" checked={importMode === 'append'} disabled={importDisabled} onChange={() => setImportMode('append')} />追加到现有题库</label><label><input type="radio" name="import-mode" checked={importMode === 'replace'} disabled={importDisabled} onChange={() => setImportMode('replace')} />整体替换题库</label></div>
              {duplicateExistingIds.length > 0 && <div className="setup-error" role="alert"><AlertCircle size={16} />当前题库已有题号 {duplicateExistingIds.slice(0, 5).join('、')}{duplicateExistingIds.length > 5 ? '…' : ''}。请修改题号，或明确选择整体替换；整批尚未写入。</div>}
              {importMode === 'replace' && draft.questions.length > 0 && <Notice tone="warning">整体替换将使用本文件的全部题目。未包含的旧题目会被移除，已有记录引用不允许被删除。</Notice>}
              <div className="setup-import-footer"><span>验收要点和参考图文件名可用分号或换行分隔。</span><button className="btn btn-primary" disabled={importDisabled || !importPreview.questions.length || duplicateExistingIds.length > 0} onClick={confirmImport}><CheckCircle2 size={15} />确认导入并保存</button></div>
            </>}
          </>}
        </div>
      </section>

      <section className="panel setup-section setup-question-list">
        <PanelHeading
          title="项目题库"
          subtitle="题号保持唯一；题目、需求与验收点随本次项目保存，不混入演示题。"
          action={<div className="setup-heading-actions"><button className="btn btn-small" onClick={() => { downloadText('当前项目题库.json', JSON.stringify(draft.questions, null, 2), 'application/json;charset=utf-8'); onToast(`已生成当前 ${draft.questions.length} 道题的 JSON 文件`); }}><Download size={14} />导出 JSON</button><button className="btn btn-primary btn-small" disabled={locked || saving} onClick={() => openQuestion()}><Plus size={14} />手工新增</button></div>}
        />
        <div className="setup-list-toolbar"><label className="setup-search"><Search size={15} /><input placeholder="搜索题号、标题或需求" value={questionSearch} onChange={event => setQuestionSearch(event.target.value)} /></label><span>{visibleQuestions.length} 道题</span></div>
        <div className="setup-table-scroll"><table className="setup-table"><thead><tr><th>题号 / 标题</th><th>场景</th><th>品类 / 难度</th><th>验收与参考图</th><th>操作</th></tr></thead><tbody>
          {visibleQuestions.map(question => <tr key={question.id}><td><code>{question.id}</code><strong>{question.title}</strong><p>{question.request}</p></td><td>{question.scene || '未填写'}</td><td>{question.category || '未填写'}<small>{question.difficulty || '未填写'}</small></td><td>{question.acceptance.length} 项验收<small>{question.referenceNames.length ? `${question.referenceNames.length} 个文件名 · 待匹配上传` : '无参考图引用'}</small></td><td><div className="setup-row-actions"><button className="setup-icon-button" aria-label={`编辑题目 ${question.id}`} disabled={locked || saving} onClick={() => openQuestion(question)}><Pencil size={14} /></button><button className="setup-icon-button" aria-label={`删除题目 ${question.id}`} disabled={locked || saving} onClick={() => deleteQuestion(question)}><Trash2 size={14} /></button></div></td></tr>)}
        </tbody></table></div>
        {!visibleQuestions.length && <div className="setup-empty"><FileSpreadsheet size={25} /><strong>{draft.questions.length ? '没有匹配的题目' : '题库还是空的'}</strong><span>{draft.questions.length ? '试试其他关键词。' : '导入 CSV / JSON，或手工新增第一道题。'}</span></div>}
      </section>

      {draft.questions.length > 0 && <section className="setup-distributions">
        {([{ key: 'scene', name: '场景分布' }, { key: 'category', name: '品类分布' }, { key: 'difficulty', name: '难度分布' }] as const).map(item => <div className="panel" key={item.key}><h3>{item.name}</h3><div>{distribution(draft.questions, item.key).map(([name, count]) => <span key={name}>{name}<strong>{count}</strong></span>)}</div></div>)}
      </section>}
    </>}

    {tab === 'rules' && <>
      <section className="panel setup-section">
        <PanelHeading title="维度与权重" subtitle={isAnchorMode(draft.scheme) ? '按配置锚点打 1～5 分，再按维度权重汇总；未评分不计为满分。E 保持实际指标计算。' : '每个维度分别按最高问题等级换算为 1–5 分，再按权重汇总；无标签仅在已提交后记为 5 分。'} action={<Pill tone={weightsValid ? 'green' : 'red'}>合计 {weightTotal.toFixed(Number.isInteger(weightTotal) ? 0 : 1)}%</Pill>} />
        <div className="setup-table-scroll"><table className="setup-table setup-weight-table"><thead><tr><th>评测维度</th><th>采集方式</th><th>权重</th></tr></thead><tbody>
          {draft.scheme.dimensions.map((dimension, index) => <tr key={dimension.id}><td><div className="setup-dimension-cell"><span className="setup-dimension-id">{dimension.id}</span><strong>{dimension.name}</strong>{dimension.id === 'F' && <Pill tone="orange">含一票否决</Pill>}</div></td><td>{isAnchorMode(draft.scheme) && dimension.id !== 'E' ? dimension.id === 'D' ? '编辑任务锚点直评分' : dimension.id === 'G' ? '逐题锚点 + 整体体验' : '逐题锚点直评分' : dimension.method}</td><td><label className="setup-weight-control"><input type="number" min={0} max={100} step={1} value={dimension.weight} aria-label={`${dimension.name}权重`} disabled={locked || saving} onChange={event => setDraft(previous => ({ ...previous, rulesConfirmed: false, scheme: { ...previous.scheme, dimensions: previous.scheme.dimensions.map((item, itemIndex) => itemIndex === index ? { ...item, weight: Number(event.target.value) } : item) } }))} /><span>%</span></label></td></tr>)}
        </tbody></table></div>
        {!weightsValid && <div className="setup-inner-notice"><Notice tone="warning">请将所有权重调整到 0–100% 范围，合计恰好为 100%，然后保存。</Notice></div>}
      </section>

      <section className="panel anchor-config"><PanelHeading title="评分方式与锚点" subtitle="选择本项目采用的评分口径；改动后需重新确认规则。开始评测或分发后锁定。"/>
        <label>评分方式<select aria-label="评分方式" disabled={locked || saving} value={draft.scheme.rating?.mode ?? 'tags'} onChange={event => setDraft(previous => ({ ...previous, rulesConfirmed: false, scheme: { ...previous.scheme, rating: { mode: event.target.value as 'tags' | 'anchors', anchors: previous.scheme.rating?.anchors ?? defaultAnchors() } } }))}><option value="tags">标签自动换算（原课程规则）</option><option value="anchors">锚点直评分（扩展口径）</option></select></label>
        <p>{isAnchorMode(draft.scheme) ? 'A/B/C/F/G 逐题按锚点选分并写依据；D 在三个编辑任务中打分；E 仍由实际数据计算。标签保留作诊断与合规检查。以下为建议锚点，可在开始前编辑，不是原课程的标签换算规则。' : '由该维度最严重的问题标签换算得分。若需要逐维度直接选 1–5 分，请切换为锚点直评分。'}</p>
        {isAnchorMode(draft.scheme) && ratedDimensions.map(id => <details key={id}><summary>{id} · {draft.scheme.dimensions.find(row => row.id === id)?.name} · 1–5 分锚点</summary>{(draft.scheme.rating?.anchors?.[id] ?? []).map(anchor => <label key={anchor.score} className="anchor-config-row"><span>{anchor.score} 分</span><textarea rows={2} maxLength={2000} aria-label={`${id}维度${anchor.score}分锚点`} disabled={locked || saving} value={anchor.description} onChange={event => setDraft(previous => ({ ...previous, rulesConfirmed: false, scheme: { ...previous.scheme, rating: { ...previous.scheme.rating!, anchors: { ...previous.scheme.rating!.anchors, [id]: previous.scheme.rating!.anchors![id].map(row => row.score === anchor.score ? { ...row, description: event.target.value } : row) } } } }))}/></label>)}</details>)}
      </section>
      <section className="panel setup-section">
        <PanelHeading title="评分边界政策" subtitle="原规则中没有明确的情形，必须由项目决定；允许暂留缺口，但不会用默认值补出完整总分。" />
        <div className="setup-policies">
          <label className="setup-policy"><span><strong>生成失败且没有输出图片</strong><small>涉及 A / B / C / F 图像维度；G 仍按本次失败过程评分。选择排除时，全无图的产品仍没有效果均分和总分。</small></span><select value={draft.scheme.policies.failedNoOutput} disabled={locked || saving} onChange={event => changePolicy('failedNoOutput', event.target.value as Scheme['policies']['failedNoOutput'])}><option value="unresolved">待确认：保留相关得分缺口</option><option value="score-one">无图的图像维度均记 1 分</option><option value="exclude">从效果均分排除，保留失败与可用率统计</option></select></label>
          <label className="setup-policy"><span><strong>速度或成本排名出现并列</strong><small>密集排名将并列产品记为相同名次，下一名依次递进，例如 1、1、2，对应 5、5、4 分。</small></span><select value={draft.scheme.policies.rankingTies} disabled={locked || saving} onChange={event => changePolicy('rankingTies', event.target.value as Scheme['policies']['rankingTies'])}><option value="unresolved">待确认：并列排名保留缺口</option><option value="dense">采用密集排名</option></select></label>
          <label className="setup-policy"><span><strong>可用张数为零时的单张成本</strong><small>不能除以零。记 1 分仅作用于 E 维度的“成本子分”，不将整个 E 维度直接记为 1 分。</small></span><select value={draft.scheme.policies.zeroUsableCost} disabled={locked || saving} onChange={event => changePolicy('zeroUsableCost', event.target.value as Scheme['policies']['zeroUsableCost'])}><option value="unresolved">待确认：成本子分保留缺口</option><option value="score-one">成本子分记为 1 分</option></select></label>
        </div>
        {unresolvedCount > 0 && <div className="setup-inner-notice"><Notice tone="warning">仍有 {unresolvedCount} 项边界政策未明确。项目可以继续记录与评测；遇到对应情形时，相关指标和总分会显示缺口，须明确政策后再发布完整结论。</Notice></div>}
      </section>

      <section className="panel setup-section">
        <PanelHeading title="问题标签快照" subtitle={`${draft.scheme.tags.length} 个标签 · 标签所属维度、默认等级按本次规则保存。`} />
        <div className="setup-table-scroll"><table className="setup-table"><thead><tr><th>编码</th><th>问题标签</th><th>维度</th><th>默认等级</th></tr></thead><tbody>{draft.scheme.tags.slice(0, showAllTags ? undefined : 8).map(tag => <tr key={tag.code}><td><code>{tag.code}</code></td><td>{tag.name}</td><td>{draft.scheme.dimensions.find(dimension => dimension.id === tag.dimension)?.name ?? tag.dimension}</td><td><Pill tone={tag.severity === 'P0' ? 'red' : tag.severity === 'P1' ? 'orange' : 'violet'}>{tag.severity}</Pill></td></tr>)}</tbody></table></div>
        {draft.scheme.tags.length > 8 && <button className="setup-expand-tags" onClick={() => setShowAllTags(value => !value)}>{showAllTags ? '收起标签' : `展开全部 ${draft.scheme.tags.length} 个标签`}<ChevronDown size={14} className={showAllTags ? 'is-open' : ''} /></button>}
      </section>

      <section className={`panel setup-rule-confirmation ${draft.rulesConfirmed ? 'confirmed' : ''}`}>
        <span className="setup-confirm-icon"><ShieldCheck size={22} /></span>
        <div><h3>确认采用本次规则快照</h3><p>保存后，正式提交使用此项目中的规则快照；修改评分方式、锚点、权重或边界政策会取消确认。此操作不会改写仓库中的 scheme.json。</p><label><input type="checkbox" checked={draft.rulesConfirmed} disabled={locked || saving || !weightsValid} onChange={event => updateProject('rulesConfirmed', event.target.checked)} /><span>我已阅读并确认本项目采用以上规则{unresolvedCount ? '，知晓未明确政策会保留计算缺口' : ''}。</span></label></div>
        <Pill tone={draft.rulesConfirmed ? 'green' : 'orange'}>{draft.rulesConfirmed ? '已勾选确认' : '未确认'}</Pill>
      </section>
      <div className="setup-footer"><span><LockKeyhole size={13} />分发或开始评测后锁定快照，未确认规则不能正式评测。</span><button className="btn btn-primary" disabled={saving || !dirty} onClick={() => persist(draft, '规则快照及确认状态已保存')}><Save size={14} />保存规则快照</button></div>
    </>}

    {editor && <div className="setup-modal-backdrop" onClick={() => { if (!saving) setEditor(null); }}><section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="question-editor-title" onClick={event => event.stopPropagation()}>
      <div className="setup-modal-heading"><div><span>QUESTION EDITOR</span><h2 id="question-editor-title">{editor.originalId ? '编辑题目' : '新增题目'}</h2></div><button className="setup-icon-button" disabled={saving} aria-label="关闭题目编辑" onClick={() => setEditor(null)}><X size={20} /></button></div>
      <div className="setup-form-grid">
        <label className="setup-field">题号 <span>*</span><input autoFocus={!editor.originalId} disabled={saving || !!editor.originalId} value={editor.id} onChange={event => setEditor({ ...editor, id: event.target.value })} />{editor.originalId && <small>题号作为稳定引用，创建后不修改。</small>}</label>
        <label className="setup-field">题目标题<input autoFocus={!!editor.originalId} disabled={saving} value={editor.title} placeholder="选填，留空将按题号生成标题" onChange={event => setEditor({ ...editor, title: event.target.value })} /></label>
        <label className="setup-field">场景<input list="setup-scene-options" disabled={saving} value={editor.scene} placeholder="例如：场景图" onChange={event => setEditor({ ...editor, scene: event.target.value })} /></label>
        <label className="setup-field">品类<input disabled={saving} value={editor.category} placeholder="例如：美妆" onChange={event => setEditor({ ...editor, category: event.target.value })} /></label>
        <label className="setup-field">难度<input list="setup-difficulty-options" disabled={saving} value={editor.difficulty} placeholder="例如：基础" onChange={event => setEditor({ ...editor, difficulty: event.target.value })} /></label>
        <label className="setup-field setup-wide">需求描述 <span>*</span><textarea rows={4} disabled={saving} value={editor.request} placeholder="按真实用户的方式描述需求，评测员将使用这段原文" onChange={event => setEditor({ ...editor, request: event.target.value })} /></label>
        <label className="setup-field setup-wide">验收要点 <span>*</span><textarea rows={3} disabled={saving} value={editor.acceptanceText} placeholder="每行一项，或用分号分隔；至少填写一项" onChange={event => setEditor({ ...editor, acceptanceText: event.target.value })} /></label>
        <label className="setup-field setup-wide">参考图文件名<textarea rows={2} disabled={saving} value={editor.referenceText} placeholder="例如：serum-front.png，每行一个文件名；实际图片稍后上传" onChange={event => setEditor({ ...editor, referenceText: event.target.value })} /></label>
      </div>
      <div className="setup-custom-fields"><div><h3>自定义字段</h3><button className="btn btn-small" disabled={saving} onClick={() => setEditor({ ...editor, fields: [...editor.fields, { name: '', value: '' }] })}><Plus size={13} />添加字段</button></div>{editor.fields.map((field, index) => <div className="setup-custom-field" key={index}><input aria-label={`自定义字段 ${index + 1} 名称`} placeholder="字段名" disabled={saving} value={field.name} onChange={event => setEditor({ ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} /><input aria-label={`自定义字段 ${index + 1} 内容`} placeholder="字段内容" disabled={saving} value={field.value} onChange={event => setEditor({ ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })} /><button className="setup-icon-button" aria-label={`删除自定义字段 ${index + 1}`} disabled={saving} onClick={() => setEditor({ ...editor, fields: editor.fields.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /></button></div>)}</div>
      {(editorError || saveError) && <div className="setup-error" role="alert"><AlertCircle size={16} />{editorError || saveError}</div>}
      <div className="setup-modal-footer"><span>保存将写入当前项目题库。</span><button className="btn" disabled={saving} onClick={() => setEditor(null)}>取消</button><button className="btn btn-primary" disabled={saving} onClick={saveQuestion}><Save size={14} />{saving ? '保存中…' : '保存题目'}</button></div>
      <datalist id="setup-scene-options">{['白底主图', '场景图', '详情图', '营销海报'].map(value => <option value={value} key={value} />)}</datalist>
      <datalist id="setup-difficulty-options">{['基础', '进阶', '困难'].map(value => <option value={value} key={value} />)}</datalist>
    </section></div>}
  </div>;
}
