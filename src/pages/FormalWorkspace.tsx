import AnchorRatings from '../components/AnchorRatings';
import { isAnchorMode } from '../core/ratings';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Download, FileCheck2, Columns2, FolderOpen, FolderSync, Image, Layers3, LayoutDashboard, ListTodo, LoaderCircle, Plus, RotateCcw, Settings2, ShieldCheck, Trash2, Upload, X, ChartNoAxesCombined, SlidersHorizontal, Database, AlertCircle } from 'lucide-react';
import type { Evaluation, Experience, Project, ProjectBundle, TagAssignment, Walkthrough } from '../core/model';
import { latestEvaluations, summarizeProject, validateProject, validateWalkthrough, allowedSeverities } from '../core/assessment';
import { createProject, exportProject, getProjectBundle, listProjects, restoreProject, saveEvaluation, saveProject, saveWalkthroughs } from '../storage/projects';
import { listTrashedProjects, restartProject, restoreTrashedProject, trashProject, type TrashedProject } from '../storage/projectLifecycle';
import ProjectLifecycleDialog, { type ProjectAction } from '../components/ProjectLifecycleDialog';
import { downloadJson } from '../storage/local';
import { PageHeading, PanelHeading, Pill } from '../ui';
import ProjectSetup from './ProjectSetup';
import FormalEvaluation from './FormalEvaluation';
import BulkImages from './BulkImages';
import StageSync from './StageSync';
import QualityWorkspace, { IndependentPortal } from './QualityWorkspace';
import { finalQualityBundle } from '../core/quality';
import { saveQuality } from '../storage/quality';
import JointWorkspace from './JointWorkspace';
import ReportWorkspace from './ReportWorkspace';
import ArchiveWorkspace from './ArchiveWorkspace';
import './formal-workspace.css';

type Section = 'overview' | 'setup' | 'images' | 'evaluation' | 'walkthrough' | 'results' | 'backup' | 'sync' | 'quality' | 'gsb' | 'joint' | 'report' | 'archive' | 'independent' | 'trash';
const sections = [
  { id: 'overview', label: '项目总览', icon: LayoutDashboard },
  { id: 'setup', label: '项目与题库', icon: Settings2 },
  { id: 'images', label: '批量导图', icon: Image },
  { id: 'evaluation', label: '逐题评测', icon: ListTodo },
  { id: 'walkthrough', label: '走查与成本', icon: SlidersHorizontal },
  { id: 'results', label: '实际得分', icon: ChartNoAxesCombined },
  { id: 'gsb', label: '自家对比 GSB', icon: Columns2 },
  { id: 'quality', label: '质量控制', icon: ShieldCheck },
  { id: 'report', label: '报告与检查', icon: FileCheck2 },
  { id: 'archive', label: '版本归档', icon: Database },
  { id: 'sync', label: '阶段同步', icon: FolderSync },
  { id: 'backup', label: '项目备份', icon: Database }
] as const;

function currentRoute(): { id: string | null; section: Section } {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return {
    id: parts[0] === 'projects' && parts[1] && !['import', 'independent', 'archives', 'trash'].includes(parts[1]) ? parts[1] : null,
    section: parts[1] === 'trash' ? 'trash' : parts[1] === 'archives' ? 'archive' : parts[1] === 'independent' ? 'independent' : parts[1] === 'import' ? 'sync' : (parts[2] === 'joint' || sections.some(item => item.id === parts[2])) ? parts[2] as Section : 'overview'
  };
}

export default function FormalWorkspace({ onDemo }: { onDemo: () => void }) {
  const [route, setRoute] = useState(currentRoute);
  const [projects, setProjects] = useState<Project[]>([]);
  const [trashedProjects, setTrashedProjects] = useState<TrashedProject[]>([]);
  const [projectAction, setProjectAction] = useState<ProjectAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [restoringProjectId, setRestoringProjectId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [missingProject, setMissingProject] = useState(false);
  const [readWarning, setReadWarning] = useState('');
  const [toast, setToast] = useState('');
  const [newName, setNewName] = useState('电商文生图竞品评测');
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [evaluationFocus, setEvaluationFocus] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  const lastRoute = useRef(location.hash);

  function notify(message: string) {
    setToast(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 6500);
  }
  async function refresh() {
    const target = currentRoute().id;
    try {
      const [all, trashed] = await Promise.all([listProjects(), listTrashedProjects()]);
      const selected = target && all.some(item => item.id === target) ? await getProjectBundle(target) : null;
      setProjects(all);
      setTrashedProjects(trashed);
      if (currentRoute().id === target) { setBundle(selected); setMissingProject(!!target && !selected); setReadWarning(''); }
    } catch {
      if (currentRoute().id === target) setReadWarning('数据已写入，但列表刷新失败。请返回项目列表重新打开，避免根据旧列表继续操作。');
    }
  }
  function canLeave() {
    if (!dirty.current) return true;
    if (!window.confirm('当前评测有未保存的修改。离开会丢失修改，是否继续？')) return false;
    dirty.current = false;
    window.dispatchEvent(new CustomEvent('formal-dirty', { detail: false }));
    return true;
  }
  function go(id: string | null, section: Section = 'overview') {
    if (!canLeave()) return;
    location.hash = id ? `/projects/${id}/${section}` : section === 'trash' ? '/projects/trash' : section === 'archive' ? '/projects/archives' : section === 'sync' ? '/projects/import' : section === 'independent' ? '/projects/independent' : '/projects';
    window.scrollTo({ top: 0 });
  }

  useEffect(() => {
    const listener = () => {
      if (!location.hash.startsWith('#/projects')) return;
      if (dirty.current && !window.confirm('离开会丢失当前未保存的评测修改，是否继续？')) {
        location.hash = lastRoute.current;
        return;
      }
      dirty.current = false;
      lastRoute.current = location.hash;
      setRoute(currentRoute());
    };
    const editListener = (event: Event) => { dirty.current = Boolean((event as CustomEvent).detail); };
    window.addEventListener('hashchange', listener);
    window.addEventListener('formal-dirty', editListener);
    return () => {
      window.removeEventListener('hashchange', listener);
      window.removeEventListener('formal-dirty', editListener);
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setMissingProject(false); setBundle(null);
    Promise.all([listProjects(), listTrashedProjects()])
      .then(async ([all, trashed]) => {
        if (!active) return;
        setProjects(all); setTrashedProjects(trashed); setReadWarning('');
        if (route.id && !all.some(item => item.id === route.id)) {
          setMissingProject(true);
          return;
        }
        const selected = route.id ? await getProjectBundle(route.id) : null;
        if (active) setBundle(selected);
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '读取项目失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [route.id, route.section === 'trash']);

  useEffect(() => {
    setEvaluationFocus(false);
  }, [route.id, route.section]);

  useEffect(() => {
    if (route.section !== 'evaluation' || !evaluationFocus) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) setEvaluationFocus(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [route.section, evaluationFocus]);

  function openProjectAction(type: ProjectAction['type'], target: Project) {
    setActionError('');
    setProjectAction({type, project: target});
  }

  async function confirmProjectAction(options: {name: string; keepQuestions: boolean}) {
    if (!projectAction || actionBusy) return;
    setActionBusy(true); setActionError('');
    try {
      let next: Project | null = null;
      if (projectAction.type === 'restart') next = await restartProject(projectAction.project.id, options);
      else await trashProject(projectAction.project.id);
      dirty.current = false;
      window.dispatchEvent(new CustomEvent('formal-dirty', {detail: false}));
      setProjectAction(null);
      go(next?.id ?? null, next ? 'setup' : 'overview');
      await refresh();
      notify(next ? `已创建新草稿${options.keepQuestions ? '，题库可继续编辑' : '，请重新导入题库'}；原项目已保留。` : '项目已移入回收站，评分与素材仍保留，可随时恢复。');
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : '操作失败，原项目保持不变'); }
    finally { setActionBusy(false); }
  }

  async function restoreFromTrash(id: string) {
    if (restoringProjectId) return;
    setRestoringProjectId(id);
    try {
      await restoreTrashedProject(id);
      await refresh();
      notify('项目已恢复，原有评分、素材和配置状态保持不变。');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '恢复失败，请重试'); }
    finally { setRestoringProjectId(null); }
  }

  async function create() {
    if (!newName.trim()) { notify('请填写项目名称'); return; }
    setCreating(true);
    try {
      const project = await createProject(newName);
      setCreateOpen(false);
      go(project.id, 'setup');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '创建失败'); }
    finally { setCreating(false); }
  }

  async function restore(file?: File) {
    if (!file) return;
    setRestoring(true);
    try {
      if (file.size > 110 * 1024 * 1024) throw new Error('当前单项目 JSON 备份最大 110 MB；阶段 ZIP 分包将在下一步提供');
      const project = await restoreProject(JSON.parse(await file.text()));
      await refresh();
      go(project.id);
      notify('正式项目与原图已通过完整性检查并恢复');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '恢复失败，当前数据保持不变'); }
    finally { setRestoring(false); if (restoreInput.current) restoreInput.current.value = ''; }
  }

  async function updateProject(project: Project) {
    await saveProject(project);
    await refresh();
  }

  const project = bundle?.project;
  const selectedTrashed = trashedProjects.find(item => item.project.id === route.id);
  const locked = project?.status === 'active' || Boolean(bundle?.evaluations.some(record => record.status === 'submitted'));
  const formalCount = projects.length;

  return <div className={`app-shell formal-workspace${route.section === 'evaluation' && bundle && !loading && !error && !selectedTrashed ? ` formal-evaluation-workspace${evaluationFocus ? ' formal-focus-workspace' : ''}` : ''}`}>
    <aside className="sidebar">
      <button className="brand" onClick={() => go(null)} aria-label="正式项目列表">
        <span className="brand-mark"><Layers3 size={23}/></span>
        <span><strong>Eval Studio<span className="brand-dot">.</span></strong><small>AI 产品评测工作台</small></span>
      </button>
      <button className="workspace-switch" onClick={() => go(null)}>
        <span className="workspace-initial"><FolderOpen size={16}/></span>
        <span><strong>{project?.name || '正式项目'}</strong><small>{project ? '本机独立采集' : `${formalCount} 个本机项目`}</small></span><ChevronDown size={14}/>
      </button>
      <div className="nav-caption">正式项目</div>
      <nav aria-label="正式项目导航">
        {sections.map(({ id, label, icon: Icon }) => <button key={id} aria-label={label} title={label}
          className={`nav-item ${route.id && route.section === id ? 'active' : ''}`}
          disabled={!['sync','archive'].includes(id) && (!route.id || !bundle)} onClick={() => go(route.id, id)}><Icon size={18}/><span>{label}</span></button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="formal-local-card"><ShieldCheck size={20}/><strong>真实数据单独保存</strong><p>原图保留在本机；模拟项目使用另一套数据区。</p></div>
        <button className="sidebar-help" onClick={() => { if (canLeave()) onDemo(); }}><ArrowLeft size={15}/><span className="formal-demo-label">返回演示工作台</span></button>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="topbar">
        <div className="breadcrumb"><button className="formal-breadcrumb-link" onClick={() => go(null)}>我的项目</button>{project && <><span>/</span><strong>{project.name}</strong></>}</div>
        <div className="formal-header-status"><span className="formal-status-dot"/>本机保存<Pill tone="green">正式数据区</Pill></div>
      </header>
      <main className="main-content formal-main">
        {readWarning && <div className="formal-note" role="alert"><AlertCircle size={16}/>{readWarning}</div>}
        {selectedTrashed ? <section className="panel formal-empty"><Trash2 size={36}/><h2>这个项目已移入回收站</h2><p>“{selectedTrashed.project.name}”的评分、素材和历史记录仍保留。恢复项目后可继续查看和评测。</p><div className="formal-entry-actions"><button className="btn btn-primary" disabled={!!restoringProjectId} onClick={() => void restoreFromTrash(selectedTrashed.project.id)}><RotateCcw size={15}/>{restoringProjectId ? '恢复中…' : '恢复这个项目'}</button><button className="btn" onClick={() => go(null, 'trash')}>查看回收站</button><button className="btn" onClick={() => go(null)}>返回我的项目</button></div></section>
          : missingProject ? <section className="panel formal-empty"><FolderOpen size={36}/><h2>当前浏览器没有这个项目</h2><p>项目保存在创建它的浏览器中，分享网址不会同步项目数据。你可以先查看界面演示，或导入收到的项目包继续评测。</p><div className="formal-entry-actions"><button className="btn btn-primary" onClick={onDemo}>查看界面演示<ArrowRight size={15}/></button><button className="btn" onClick={() => go(null)}>返回我的项目</button><button className="btn" onClick={() => go(null, 'sync')}><Upload size={15}/>导入项目包</button></div></section>
          : error ? <section className="panel formal-empty"><AlertCircle size={28}/><h2>暂时无法打开项目</h2><p>{error}</p><div className="formal-entry-actions"><button className="btn" onClick={() => go(null)}>返回项目列表</button><button className="btn" onClick={onDemo}>查看界面演示</button></div></section>
          : loading ? <div className="empty-state"><LoaderCircle size={26} className="spin"/>正在读取本机项目…</div>
          : route.section === 'trash' ? <>
            <PageHeading eyebrow="PROJECT RECYCLE BIN" title="项目回收站" description="移入回收站的项目保留全部评分、素材和历史记录，可恢复到我的项目。" action={<button className="btn" onClick={() => go(null)}><ArrowLeft size={15}/>返回我的项目</button>}/>
            <div className="formal-note"><ShieldCheck size={16}/>这里只管理当前浏览器中的项目。回收站不会释放图片存储空间，也不会删除其他评测员的副本。</div>
            {trashedProjects.length ? <div className="formal-trash-list">{trashedProjects.map(item => <article className="panel formal-trash-card" key={item.project.id}>
              <span className="formal-project-icon"><FolderOpen size={22}/></span><div><h2>{item.project.name}</h2><p>{item.project.questions.length} 道题 · 移入于 {new Date(item.trashedAt).toLocaleString('zh-CN')}</p><small>恢复后保留原来的配置锁定；需要重新导入题库，可恢复后选择“重新开始”。</small></div>
              <button className="btn" disabled={!!restoringProjectId} onClick={() => void restoreFromTrash(item.project.id)}><RotateCcw size={15}/>{restoringProjectId === item.project.id ? '恢复中…' : '恢复项目'}</button>
            </article>)}</div> : <section className="panel formal-empty"><Trash2 size={36}/><h2>回收站是空的</h2><p>移入回收站的项目会显示在这里，可以随时恢复。</p><button className="btn" onClick={() => go(null)}>返回我的项目</button></section>}
          </>
          : route.section === 'archive' ? <ArchiveWorkspace key={route.id ?? 'all'} bundle={bundle} onToast={notify}/>
          : route.section === 'independent' ? <IndependentPortal onToast={notify}/>
          : route.section === 'sync' ? <StageSync bundle={bundle} onRefresh={refresh} onToast={notify} onImported={id => {
            dirty.current = false;
            window.dispatchEvent(new CustomEvent('formal-dirty', { detail: false }));
            go(id, 'sync');
            void refresh();
          }}/>
          : !project || !bundle ? <>
            <PageHeading eyebrow="YOUR PROJECTS" title="开始一次真正的评测" description="创建独立项目，导入你的题目和素材，所有指标从实际记录计算。"
              action={<><button className="btn" onClick={() => go(null, 'trash')}><Trash2 size={15}/>回收站{trashedProjects.length ? `（${trashedProjects.length}）` : ''}</button><button className="btn" onClick={() => go(null, 'independent')}><ShieldCheck size={15}/>独立评审空间</button><button className="btn" onClick={() => go(null, 'sync')}><FolderSync size={15}/>导入阶段包</button><button className="btn" disabled={restoring} onClick={() => restoreInput.current?.click()}><Upload size={15}/>{restoring ? '检查备份中…' : '恢复 JSON 备份'}</button><button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={16}/>新建正式项目</button></>}/>
            <div className="formal-note"><InfoIcon/>三位评测员使用同一个准备包，各自保存后导出初评包，由负责人在“阶段同步”检查并合并。<button className="formal-breadcrumb-link" onClick={onDemo}>先看界面演示 →</button></div>
            {!projects.length ? <section className="panel formal-empty"><FolderOpen size={40}/><h2>还没有正式项目</h2><p>演示题和模拟分数不会复制进来。创建后先补齐产品信息，再导入真实题库。</p><button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={15}/>创建第一个项目</button></section>
              : <div className="formal-project-grid">{projects.map(item => <article className="panel formal-project-card" key={item.id}>
                <button className="formal-project-open" onClick={() => go(item.id)} aria-label={`打开项目 ${item.name}`}>
                <span className="formal-project-icon"><FolderOpen size={22}/></span><Pill tone={item.status === 'active' ? 'green' : 'neutral'}>{item.status === 'active' ? '评测中' : '配置草稿'}</Pill>
                <h2>{item.name}</h2><p>{item.background || '项目背景待填写'}</p>
                <div><span>{item.products.filter(product => !product.demo).length} 个真实产品</span><span>{item.questions.length} 道题</span></div>
                <footer>本机更新 {new Date(item.updatedAt).toLocaleString('zh-CN')}<ArrowRight size={15}/></footer>
                </button>
                <div className="formal-project-actions"><button className="btn btn-small" onClick={() => openProjectAction('restart', item)} aria-label={`重新开始项目 ${item.name}`}><RotateCcw size={14}/>重新开始</button><button className="btn btn-small formal-trash-button" onClick={() => openProjectAction('trash', item)} aria-label={`移入回收站 ${item.name}`}><Trash2 size={14}/>移入回收站</button></div>
              </article>)}</div>}
          </>
          : <>
            <div className="formal-context"><span><span className="formal-status-dot"/>{locked ? '规则已冻结 · 提交修订保留历史' : '配置草稿 · 可先用少量题演练'}</span><span>{project.questions.length} / {project.expectedQuestionCount} 道题 · 项目修订 {project.revision}</span></div>
            {route.section === 'overview' && <FormalOverview bundle={bundle} onGo={section => go(project.id, section)} onStart={async () => {
              const errors = validateProject(project);
              if (errors.length) { notify(errors.slice(0, 4).join('；')); go(project.id, 'setup'); return; }
              try { if (project.status !== 'active') await updateProject({ ...project, status: 'active' }); go(project.id, 'evaluation'); }
              catch (reason) { notify(reason instanceof Error ? reason.message : '无法开始评测'); }
            }}/> }
            {route.section === 'setup' && <ProjectSetup key={project.id} project={project} locked={locked} onSave={updateProject} onToast={notify} onRestart={() => openProjectAction('restart', project)} onTrash={() => openProjectAction('trash', project)}/>}
            {route.section === 'images' && <BulkImages key={project.id} bundle={bundle} onRefresh={refresh} onToast={notify} onEvaluate={() => go(project.id, 'evaluation')}/>}
            {route.section === 'evaluation' && <FormalEvaluation key={project.id} bundle={bundle} focusMode={evaluationFocus} onFocusChange={setEvaluationFocus} onToast={notify} onBulkImport={() => go(project.id, 'images')} onSave={async (record, assets, referenceChange) => {
              await saveEvaluation(project.id, record, assets, referenceChange);
              await refresh();
            }}/>}
            {route.section === 'walkthrough' && <FormalWalkthrough bundle={bundle} onToast={notify} onSave={async (nextProject, walkthroughs, experiences) => {
              await saveProject(nextProject);
              await saveWalkthroughs(project.id, walkthroughs, experiences);
              await refresh();
            }}/>}
            {route.section === 'quality' && <QualityWorkspace key="quality" bundle={bundle} onRefresh={refresh} onToast={notify}/>}
            {route.section === 'gsb' && <QualityWorkspace key="gsb" gsbOnly bundle={bundle} onRefresh={refresh} onToast={notify}/>}
            {route.section === 'joint' && <JointWorkspace key={project.id} bundle={bundle} onToast={notify} onSave={async state => { await saveQuality(bundle, state); await refresh(); }}/>}
            {route.section === 'report' && <ReportWorkspace key={project.id} bundle={bundle} onToast={notify} onSave={async state => { await saveQuality(bundle, state); await refresh(); }}/>}
            {route.section === 'results' && <FormalResults bundle={bundle}/>}
            {route.section === 'backup' && <FormalBackupPage bundle={bundle} onToast={notify} onRestore={() => restoreInput.current?.click()} restoring={restoring}/>}
          </>}
        <footer className="workspace-footer"><span>Eval Studio / 单机采集与评分</span><span>IndexedDB · 独立正式项目</span></footer>
      </main>
    </div>
    <input ref={restoreInput} type="file" accept="application/json,.json" hidden onChange={event => void restore(event.target.files?.[0])}/>
    {projectAction && <ProjectLifecycleDialog key={`${projectAction.type}:${projectAction.project.id}`} action={projectAction} busy={actionBusy} error={actionError} hasUnsavedChanges={dirty.current} onClose={() => { if (!actionBusy) setProjectAction(null); }} onConfirm={options => void confirmProjectAction(options)}/>}
    {toast && <div className="toast" role="status"><InfoIcon/><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={15}/></button></div>}
    {createOpen && <div className="modal-backdrop" onClick={() => { if (!creating) setCreateOpen(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="formal-create-title" onClick={event => event.stopPropagation()}>
      <button className="modal-close icon-button" aria-label="关闭新建项目" disabled={creating} onClick={() => setCreateOpen(false)}><X size={18}/></button>
      <div className="eyebrow">NEW PROJECT</div><h2 id="formal-create-title">新建正式评测项目</h2><p>创建空题库，预置本次七维度和 25 个标签。产品名称、档位与题目由你补充。</p>
      <label className="field formal-create-field">项目名称<input className="input" autoFocus value={newName} maxLength={100} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !creating) void create(); }}/></label>
      <div className="formal-modal-actions"><button className="btn" onClick={() => setCreateOpen(false)} disabled={creating}>取消</button><button className="btn btn-primary" onClick={() => void create()} disabled={creating || !newName.trim()}>{creating ? '正在创建…' : '创建并配置'}<ArrowRight size={15}/></button></div>
    </section></div>}
  </div>;
}

function InfoIcon() { return <AlertCircle size={16}/>; }

function FormalOverview({ bundle, onGo, onStart }: { bundle: ProjectBundle; onGo: (section: Section) => void; onStart: () => void }) {
  const { project } = bundle;
  const results = summarizeProject(bundle);
  const realProducts = project.products.filter(product => !product.demo);
  const realResults = results.filter(result => realProducts.some(product => product.id === result.productId));
  const submitted = realResults.reduce((total, result) => total + result.submitted, 0);
  const expected = realProducts.length * Math.max(project.expectedQuestionCount, project.questions.length);
  const generated = realResults.reduce((total, result) => total + result.generated, 0);
  const usable = realResults.reduce((total, result) => total + result.usable, 0);
  const valid = validateProject(project);
  return <>
    <PageHeading eyebrow="PROJECT OVERVIEW" title={project.name} description={project.background || '补齐项目与题库后，开始记录真实评测。'}
      action={<><button className="btn" onClick={() => onGo('setup')}><Settings2 size={15}/>配置项目</button><button className="btn btn-primary" onClick={onStart}>{submitted ? '继续评测' : '检查配置并开始'}<ArrowRight size={15}/></button></>}/>
    <div className="metric-grid formal-metrics">
      <div className="metric-card"><div className="metric-title">已提交题目<FileCheck2 size={17}/></div><div className="metric-value">{submitted}<small>/ {expected}</small></div><p className="metric-caption">只统计真实产品的有效最新提交</p></div>
      <div className="metric-card"><div className="metric-title">正式题库<ListTodo size={17}/></div><div className="metric-value">{project.questions.length}<small>题</small></div><p className="metric-caption">计划 {project.expectedQuestionCount} 题 · 试跑请单独设定计划题量</p></div>
      <div className="metric-card"><div className="metric-title">已记录原图<Image size={17}/></div><div className="metric-value">{generated}<small>张</small></div><p className="metric-caption">可用 {usable} 张 · {generated ? (usable / generated * 100).toFixed(1) + '%' : '尚无可用率'}</p></div>
      <div className="metric-card"><div className="metric-title">规则状态<ShieldCheck size={17}/></div><div className="formal-rule-state">{project.rulesConfirmed ? '已确认' : '待确认'}</div><p className="metric-caption">{(project.status === 'active' || bundle.evaluations.some(item => item.status === 'submitted')) ? '项目已开始或分发，规则与题库已冻结' : '首个正式提交后冻结规则与题库'}</p></div>
    </div>
    {valid.length > 0 && <section className="panel formal-readiness"><PanelHeading title="开始前需要补齐" subtitle="允许先保存草稿，正式提交前会再次检查。"/><ul>{valid.map((message, index) => <li key={`${index}-${message}`}><AlertCircle size={14}/>{message}</li>)}</ul><button className="btn btn-small" onClick={() => onGo('setup')}>去配置项目<ArrowRight size={14}/></button></section>}
    <section className="panel"><PanelHeading title="被测产品与实际进度" subtitle="缺失数据保留为空，不以演示值或满分补齐。"/>
      <div className="table-wrap"><table className="table formal-data-table"><thead><tr><th>产品 / 版本</th><th>负责人</th><th>已提交</th><th>图片可用率</th><th>总分 / 100</th><th>结论状态</th></tr></thead><tbody>{project.products.map(product => {
        const result = results.find(item => item.productId === product.id);
        return <tr key={product.id}><td><strong>{product.name || '产品名称待填写'}</strong><small>{product.version || '版本或档位待填写'}{product.demo ? ' · 模拟对象' : ''}</small></td><td>{project.members.find(member => member.id === product.ownerId)?.name || '未分配'}</td><td>{result?.submitted ?? 0} / {result?.expected ?? project.expectedQuestionCount}</td><td>{result?.usableRate == null ? '—' : `${(result.usableRate * 100).toFixed(1)}%`}</td><td>{result?.total == null ? '待补齐' : (result.total * (isAnchorMode(project.scheme) ? 1 : 20)).toFixed(isAnchorMode(project.scheme) ? 2 : 1)}</td><td><Eligibility state={result?.eligibility ?? 'pending'}/></td></tr>;
      })}</tbody></table></div>
    </section>
    <div className="formal-note"><InfoIcon/>当前分工：每人负责一个竞品的初评，再与同一套自家结果逐题做 GSB。自家素材统一准备并复用，无需进行竞品之间的联合排名。</div>
    <div className="formal-next-grid">
      <button className="panel formal-next-action" onClick={() => onGo('evaluation')}><ListTodo size={22}/><strong>逐题采集</strong><p>需求、原图、可用性、问题标签</p><ArrowRight size={16}/></button>
      <button className="panel formal-next-action" onClick={() => onGo('walkthrough')}><SlidersHorizontal size={22}/><strong>补齐产品级信息</strong><p>编辑走查、成本与商用授权</p><ArrowRight size={16}/></button>
      <button className="panel formal-next-action" onClick={() => onGo('gsb')}><Columns2 size={22}/><strong>自家对比 GSB</strong><p>汇合初评后，每人比较自己负责的竞品</p><ArrowRight size={16}/></button>
    </div>
  </>;
}

function Eligibility({ state }: { state: string }) {
  const labels: Record<string, string> = { eligible: '可参与推荐', vetoed: '一票否决', pending: '检查未完成', simulated: '模拟对象' };
  return <Pill tone={state === 'eligible' ? 'green' : state === 'vetoed' ? 'red' : state === 'simulated' ? 'neutral' : 'orange'}>{labels[state] || state}</Pill>;
}

function FormalResults({ bundle }: { bundle: ProjectBundle }) {
  const [useFinal, setUseFinal] = useState(false);
  const results = summarizeProject(useFinal ? finalQualityBundle(bundle) : bundle);
  const { project } = bundle;
  const rank = results.filter(result => result.eligibility === 'eligible' && result.total != null).sort((a, b) => b.total! - a.total!);
  return <>
    <PageHeading eyebrow="ACTUAL RESULTS" title="实际得分与数据缺口" description="每一分来自当前项目的有效提交，模拟对象与否决对象不进入推荐排名。"
      action={<button className="btn" onClick={() => downloadJson(`${project.name}-score-details.json`, { projectId: project.id, schemeHash: project.schemeHash, basis: useFinal ? 'adjudicated-reference' : 'original', finalReferences: bundle.quality?.finals ?? [], results, generatedAt: new Date().toISOString() })}><Download size={15}/>导出得分明细</button>}/>
    {!!bundle.quality?.finals?.length && <label className="quality-check"><input type="checkbox" checked={useFinal} onChange={event => setUseFinal(event.target.checked)}/>查看裁决口径参考分（保留原始初评；不代表完整质量归档已完成）</label>}
    <div className="formal-note"><InfoIcon/>完整总分需要七个维度数据齐全。尚未完成的维度可显示参考均分与样本数，但不会生成完整总分。</div>
    <section className="panel formal-score-panel"><PanelHeading title="七维度计算结果" subtitle={isAnchorMode(project.scheme) ? '锚点直评分：A/B/C/F 为逐题均分；D 为编辑任务均分；E 为量化指标；G 为逐题锚点与整体体验各一半。' : 'D 来自编辑走查，E 来自可用率 / 速度 / 成本，G 为标签分与整体体验分各占一半。'}/>
      <div className="table-wrap"><table className="table formal-data-table formal-score-table"><thead><tr><th>维度 / 权重</th>{project.products.map(product => <th key={product.id}>{product.name || '未命名产品'}{product.demo && <small>模拟</small>}</th>)}</tr></thead><tbody>{project.scheme.dimensions.map(dimension => <tr key={dimension.id}><td><strong>{dimension.id} · {dimension.name}</strong><small>{dimension.weight}%</small></td>{results.map(result => {
        const metric = result.dimensions[dimension.id as keyof typeof result.dimensions];
        return <td key={result.productId}><strong className={metric?.complete ? 'formal-complete-score' : 'formal-partial-score'}>{metric?.value == null ? '—' : metric.value.toFixed(2)}</strong><small>{metric?.n ?? 0} / {metric?.expected ?? 0}{metric?.complete ? ' · 齐全' : ' · 待补齐'}</small></td>;
      })}</tr>)}<tr className="formal-total-row"><td><strong>加权总分</strong><small>{isAnchorMode(project.scheme) ? '5 分制' : '百分制'}</small></td>{results.map(result => <td key={result.productId}><strong>{result.total == null ? '—' : (result.total * (isAnchorMode(project.scheme) ? 1 : 20)).toFixed(isAnchorMode(project.scheme) ? 2 : 1)}</strong><small>{result.total == null ? '七维数据尚未齐全' : isAnchorMode(project.scheme) ? '按权重汇总 / 5' : '原始 5 分制 × 20'}</small></td>)}</tr></tbody></table></div>
    </section>
    <section className="panel formal-ranking"><PanelHeading title="可推荐产品排名" subtitle="仅包含非模拟、未被否决、检查完成且具有完整总分的产品。"/>
      {rank.length ? rank.map((result, index) => <div key={result.productId} className="formal-rank-row"><span>{index + 1}</span><strong>{project.products.find(product => product.id === result.productId)?.name}</strong><b>{(result.total! * 20).toFixed(1)}</b></div>) : <div className="formal-inline-empty">当前没有同时满足推荐条件与完整总分的产品。</div>}
    </section>
    <div className="formal-result-cards">{results.map(result => <section className="panel formal-result-card" key={result.productId}>
      <div className="formal-result-title"><h2>{project.products.find(product => product.id === result.productId)?.name || '未命名产品'}</h2><Eligibility state={result.eligibility}/></div>
      <dl><div><dt>可用率</dt><dd>{result.usableRate == null ? '—' : (result.usableRate * 100).toFixed(1) + '%'}</dd></div><div><dt>平均耗时</dt><dd>{result.meanSeconds == null ? '—' : result.meanSeconds.toFixed(1) + ' 秒'}</dd></div><div><dt>单张可用图成本</dt><dd>{result.costPerUsable == null ? '—' : result.costPerUsable.toFixed(3)}</dd></div><div><dt>F-01 图片比例</dt><dd>{result.infringementRate == null ? '待逐图检查' : (result.infringementRate * 100).toFixed(1) + '%'}</dd></div></dl>
      {result.vetoReasons.length > 0 && <ul className="formal-veto-reasons">{result.vetoReasons.map(reason => <li key={reason}><AlertCircle size={13}/>{reason}</li>)}</ul>}
      <details className="formal-missing" open={result.missing.length > 0}><summary>数据与计算说明（{result.missing.length}）</summary><ul>{result.missing.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul></details>
    </section>)}</div>
  </>;
}

const walkthroughTasks = [
  { id: 'background' as const, name: '换背景', request: '将统一白底商品图换成指定场景背景' },
  { id: 'color' as const, name: '改颜色', request: '将商品或背景改为指定颜色' },
  { id: 'expand' as const, name: '扩图', request: '将 1:1 图片扩展为 9:16' }
];

function FormalWalkthrough({ bundle, onSave, onToast }: { bundle: ProjectBundle; onSave: (project: Project, tasks: Walkthrough[], experiences: Experience[]) => Promise<void>; onToast: (message: string) => void }) {
  const { project } = bundle;
  const [productId, setProductId] = useState(project.products[0]?.id || '');
  const [tasks, setTasks] = useState<Walkthrough[]>([]);
  const [score, setScore] = useState('');
  const [experienceNotes, setExperienceNotes] = useState('');
  const [cost, setCost] = useState('');
  const [license, setLicense] = useState<'unreviewed' | 'allowed' | 'unclear' | 'forbidden'>('unreviewed');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<{ target: string; message: string }[]>([]);
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});
  const product = project.products.find(item => item.id === productId);
  const editTags = project.scheme.tags.filter(tag => tag.dimension === 'D');

  useEffect(() => {
    const current = project.products.find(item => item.id === productId);
    setTasks(walkthroughTasks.map(task => bundle.walkthroughs.find(item => item.productId === productId && item.task === task.id) || { id: crypto.randomUUID(), projectId: project.id, productId, task: task.id, status: 'draft', completed: false, steps: null, tags: [], notes: '' }));
    const experience = bundle.experiences.find(item => item.productId === productId);
    setScore(experience?.score == null ? '' : String(experience.score));
    setExperienceNotes(experience?.notes || '');
    setCost(current?.totalCost == null ? '' : String(current.totalCost));
    setLicense(current?.commercialUse || 'unreviewed');
    setEvidence(current?.commercialEvidence || '');
    setDirty(false);
    setIssues([]);
  }, [productId, project.updatedAt]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('formal-dirty', { detail: dirty }));
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.dispatchEvent(new CustomEvent('formal-dirty', { detail: false })); };
  }, [dirty]);

  function update(index: number, patch: Partial<Walkthrough>) { setTasks(previous => previous.map((task, i) => i === index ? { ...task, ...patch, status: 'draft' } : task)); setDirty(true); setIssues(previous => previous.filter(issue => issue.target !== tasks[index]?.id)); }
  function focusIssue(target: string) {
    const element = fieldRefs.current[target];
    element?.focus({ preventScroll: true }); element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function save(submit: boolean) {
    if (!product) return;
    const amount = cost.trim() ? Number(cost) : null;
    const nextIssues: typeof issues = [];
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) nextIssues.push({ target: 'cost', message: '总费用必须是非负数，未知请留空' });
    if (license !== 'unreviewed' && !evidence.trim()) nextIssues.push({ target: 'evidence', message: '请填写商用授权判断的条款或来源依据' });
    for (const [index, task] of tasks.entries()) {
      if (submit) {
        nextIssues.push(...validateWalkthrough(project, task).map(message => ({ target: task.id, message: `${walkthroughTasks[index].name}：${message}` })));
        if (!task.completed && !task.notes.trim()) nextIssues.push({ target: task.id, message: `${walkthroughTasks[index].name}：未完成目标，请说明原因` });
      } else if (task.steps !== null && (!Number.isSafeInteger(task.steps) || task.steps < 0)) nextIssues.push({ target: task.id, message: `${walkthroughTasks[index].name}：操作步数须为非负整数；未记录可留空` });
    }
    if (submit) {
      if (!score || !Number.isInteger(Number(score)) || Number(score) < 1 || Number(score) > 5) nextIssues.push({ target: 'score', message: '请给出整体体验分（1–5）' });
    }
    setIssues(nextIssues);
    if (nextIssues.length) { focusIssue(nextIssues[0].target); onToast('尚未保存，请检查页面标出的内容；点击提示可定位'); return; }
    setSaving(true);
    try {
      const nextProject = { ...project, products: project.products.map(item => item.id === productId ? { ...item, totalCost: amount, commercialUse: license, commercialEvidence: evidence } : item) };
      await onSave(nextProject, tasks.map(task => ({ ...task, status: submit ? 'submitted' : 'draft' })), [{ productId, score: score ? Number(score) : null, notes: experienceNotes }]);
      setDirty(false);
      onToast(submit ? '走查已提交，D / E / G 维度会读取实际记录' : '产品信息和走查草稿已保存');
    } catch (reason) { onToast(reason instanceof Error ? reason.message : '保存失败，修改仍保留在当前页面'); }
    finally { setSaving(false); }
  }

  return <>
    <PageHeading eyebrow="PRODUCT WALKTHROUGH" title="编辑走查、成本与授权" description="记录产品级信息，补齐 D / E / G 维度和推荐资格。"/>
    <label className="formal-product-select">被测产品<select className="input" value={productId} disabled={saving} onChange={event => { if (dirty && !window.confirm('切换会丢失未保存的走查修改，是否继续？')) return; setProductId(event.target.value); }}>{project.products.map(item => <option key={item.id} value={item.id}>{item.name || '未命名产品'}{item.demo ? '（模拟）' : ''}</option>)}</select></label>
    <fieldset disabled={saving} className="formal-fieldset">
      <section className="panel formal-walk-panel"><PanelHeading title="三个固定编辑任务" subtitle="请使用同一套底图完成任务。操作步数选填，不参与 D 维度分数计算；未记录可留空，不会视为 0 步。"/>
        {tasks.map((task, index) => <div className={`formal-walk-task${issues.some(issue => issue.target === task.id) ? ' has-error' : ''}`} key={task.id} ref={element => { fieldRefs.current[task.id] = element; }} tabIndex={-1}>
          <div className="formal-walk-title"><span>0{index + 1}</span><div><h3>{walkthroughTasks[index].name}</h3><p>{walkthroughTasks[index].request}</p></div><Pill tone={task.status === 'submitted' ? 'green' : 'neutral'}>{task.status === 'submitted' ? '已提交' : '草稿'}</Pill></div>
          <div className="formal-walk-inputs"><label className="field">操作步数（选填）<input className="input" aria-label={`${walkthroughTasks[index].name}操作步数（选填）`} aria-invalid={task.steps !== null && (!Number.isSafeInteger(task.steps) || task.steps < 0)} type="number" min="0" step="1" placeholder="未记录可留空" value={task.steps ?? ''} onChange={event => update(index, { steps: event.target.value === '' ? null : Number(event.target.value) })}/></label><label className="formal-walk-completion"><input type="checkbox" checked={task.completed} onChange={event => update(index, { completed: event.target.checked })}/>已完成目标</label></div>
          {issues.filter(issue => issue.target === task.id).map((issue, i) => <p className="formal-walk-field-error" key={i}><AlertCircle size={14}/>{issue.message}</p>)}
          {isAnchorMode(project.scheme) && <AnchorRatings scheme={project.scheme} dimensions={['D']} values={task.ratings ?? {}} onChange={ratings => update(index, { ratings })}/>}
          <div className="formal-walk-tags">{editTags.map(tag => {
            const selected = task.tags.find(item => item.code === tag.code);
            return <div key={tag.code}><label><input type="checkbox" checked={!!selected} onChange={event => update(index, { tags: event.target.checked ? [...task.tags, { code: tag.code, severity: tag.severity }] : task.tags.filter(item => item.code !== tag.code) })}/>{tag.code} · {tag.name}</label>{selected && <select className="input" aria-label={`${walkthroughTasks[index].name}${tag.name}严重等级`} value={selected.severity} onChange={event => update(index, { tags: task.tags.map(item => item.code === tag.code ? { ...item, severity: event.target.value as TagAssignment['severity'] } : item) })}>{allowedSeverities(tag).map(level => <option key={level}>{level}</option>)}</select>}</div>;
          })}</div>
          <label className="field">操作依据或问题说明（未完成时必填）<textarea className="input" rows={2} value={task.notes} onChange={event => update(index, { notes: event.target.value })} placeholder="记录执行过程和修改结果；未完成时说明原因。"/></label>
        </div>)}
      </section>
      <div className="formal-walk-bottom">
        <section className="panel formal-form-panel"><PanelHeading title="整体产品体验" subtitle={isAnchorMode(project.scheme) ? '与逐题 G 锚点分各占 G 维度的 50%。' : '与逐题 G 标签分各占 G 维度的 50%。'}/>
          <label className="field">整体体验分<select className="input" ref={element => { fieldRefs.current.score = element; }} aria-invalid={issues.some(issue => issue.target === 'score')} value={score} onChange={event => { setScore(event.target.value); setDirty(true); setIssues(previous => previous.filter(issue => issue.target !== 'score')); }}><option value="">尚未打分</option><option value="5">5 · 操作顺畅，无需摸索</option><option value="4">4 · 少量不便，不影响完成</option><option value="3">3 · 需要摸索，或步骤偏多</option><option value="2">2 · 操作困难，勉强完成</option><option value="1">1 · 无法完成任务</option></select></label>
          <label className="field">体验依据（选填）<textarea className="input" rows={3} value={experienceNotes} onChange={event => { setExperienceNotes(event.target.value); setDirty(true); }}/></label>
          <label className="field">评测期间总花费（统一币种）<input className="input" ref={element => { fieldRefs.current.cost = element; }} aria-invalid={issues.some(issue => issue.target === 'cost')} type="number" min="0" step="0.01" placeholder="未知留空；免费请明确填 0" value={cost} onChange={event => { setCost(event.target.value); setDirty(true); setIssues(previous => previous.filter(issue => issue.target !== 'cost')); }}/></label>
        </section>
        <section className="panel formal-form-panel"><PanelHeading title="商用授权检查" subtitle="未检查不等于已允许；明确不允许或条款不明确会触发一票否决。"/>
          <label className="field">检查结果<select className="input" value={license} onChange={event => { setLicense(event.target.value as typeof license); setDirty(true); }}><option value="unreviewed">尚未检查</option><option value="allowed">已查证：明确允许商用</option><option value="unclear">已检查：未明确允许商用</option><option value="forbidden">已查证：禁止商用</option></select></label>
          <label className="field">条款、来源与核查说明<textarea className="input" ref={element => { fieldRefs.current.evidence = element; }} aria-invalid={issues.some(issue => issue.target === 'evidence')} rows={6} placeholder="粘贴相关条款摘要、来源链接和核查日期。" value={evidence} onChange={event => { setEvidence(event.target.value); setDirty(true); setIssues(previous => previous.filter(issue => issue.target !== 'evidence')); }}/></label>
        </section>
      </div>
      {issues.length > 0 && <section className="formal-walk-errors" role="alert" aria-label="走查提交检查"><strong><AlertCircle size={17}/>还有 {issues.length} 项需要检查</strong><p>点击下方提示，可定位到对应任务或字段。操作步数可以留空。</p><ul>{issues.map((issue, index) => <li key={index}><button type="button" onClick={() => focusIssue(issue.target)}>{issue.message}<ArrowRight size={13}/></button></li>)}</ul></section>}
      <div className="formal-save-actions"><span>{dirty ? '有未保存修改' : '当前信息已载入'}</span><button className="btn" onClick={() => void save(false)}><Check size={15}/>保存草稿</button><button className="btn btn-primary" onClick={() => void save(true)}><CheckCircle2 size={15}/>提交走查与检查</button></div>
    </fieldset>
  </>;
}

function FormalBackupPage({ bundle, onToast, onRestore, restoring }: { bundle: ProjectBundle; onToast: (message: string) => void; onRestore: () => void; restoring: boolean }) {
  const [busy, setBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState('');
  const totalBytes = bundle.assets.reduce((total, item) => total + item.size, 0);
  return <>
    <PageHeading eyebrow="PROJECT BACKUP" title="保存并恢复真实项目" description="备份包括项目快照、评测修订和原始图片；恢复前检查引用与图片摘要。"/>
    <div className="formal-note"><InfoIcon/>这里保留小项目的 JSON 恢复。大项目分包备份与多人合并请进入“阶段同步”；JSON 仅恢复到本机不存在的项目。</div>
    <div className="backup-grid"><section className="panel formal-backup-panel"><Database size={30}/><h2>导出完整正式备份</h2><p>{bundle.project.questions.length} 道题 · {bundle.evaluations.length} 份修订 · {bundle.assets.length} 个图片引用</p><p>原图合计 {(totalBytes / 1024 / 1024).toFixed(2)} MB；相同图片内容在备份中去重。</p><button className="btn btn-primary" disabled={busy} onClick={async () => {
      setBusy(true);
      try { const backup = await exportProject(bundle.project.id); downloadJson(`${bundle.project.name}-formal-backup.json`, backup); setLastBackup(new Date().toLocaleString('zh-CN')); onToast('已导出包含原图与修订记录的正式备份'); }
      catch (reason) { onToast(reason instanceof Error ? reason.message : '备份失败'); }
      finally { setBusy(false); }
    }}>{busy ? <LoaderCircle size={15} className="spin"/> : <Download size={15}/>}导出正式备份</button>{lastBackup && <small>本页上次导出：{lastBackup}</small>}<div className="formal-backup-limit">当前 JSON 备份支持 75 MB 内的原图项目，适用于小批量闭环验收。大量原图请使用“阶段同步”导出 ZIP 分包。</div></section>
      <section className="panel formal-backup-panel"><Upload size={30}/><h2>恢复到这台设备</h2><p>选择另一设备导出的正式备份。演示备份和不兼容版本会被拒绝。</p><ul><li>校验规则与题库快照</li><li>校验每张图片的 SHA-256 和引用</li><li>全部通过后统一写入，失败不留半份数据</li></ul><button className="btn" disabled={restoring} onClick={onRestore}><Upload size={15}/>{restoring ? '正在核查…' : '选择正式备份'}</button></section></div>
  </>;
}
