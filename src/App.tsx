import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, BookOpen, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, CloudOff, Columns2, Download, ExternalLink, FileCheck2, FileJson2, FolderSync, GitBranch, Image as ImageIcon, Info, Layers3, LayoutDashboard, ListTodo, LoaderCircle, MoreHorizontal, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Upload, Users, X, ChartNoAxesCombined } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FileText } from 'lucide-react';
import type { Page, EvaluationRecord } from './demo/data';
import { categories, products, questions, scenes } from './demo/data';
import { downloadJson, exportPreview, getValue, importPreview, setValue } from './storage/local';
import { PageHeading, PanelHeading, Pill, ProductAvatar, TextLink } from './ui';
import Evaluation from './pages/Evaluation';
import Comparison from './pages/Comparison';
const DashboardPage = lazy(() => import('./pages/Insights').then(m => ({ default: m.DashboardPage })));
const QualityPage = lazy(() => import('./pages/Insights').then(m => ({ default: m.QualityPage })));
const SchemePage = lazy(() => import('./pages/Insights').then(m => ({ default: m.SchemePage })));
const ReportDemo = lazy(() => import('./pages/ReportDemo'));

const navigation: { id: Page; label: string; icon: LucideIcon; count?: string }[] = [
  { id: 'overview', label: '项目总览', icon: LayoutDashboard },
  { id: 'scheme', label: '方案与题库', icon: SlidersHorizontal },
  { id: 'tasks', label: '我的任务', icon: ListTodo, count: '8' },
  { id: 'quality', label: '质量控制', icon: ShieldCheck, count: '3' },
  { id: 'compare', label: '对比评审', icon: Columns2 },
  { id: 'dashboard', label: '结果看板', icon: ChartNoAxesCombined },
  { id: 'report', label: '报告与检查', icon: FileText },
  { id: 'sync', label: '数据同步', icon: FolderSync }
];
const asset = `${import.meta.env.BASE_URL}assets/serum-demo.png`;
const FormalWorkspace = lazy(() => import('./pages/FormalWorkspace'));

export default function App() {
  const [formal, setFormal] = useState(() => location.hash.startsWith('#/projects'));
  const dirty = useRef(false);
  const previous = useRef(location.hash);
  useEffect(() => {
    const changed = () => {
      const next = location.hash.startsWith('#/projects');
      if (!next && previous.current.startsWith('#/projects') && dirty.current) {
        if (!window.confirm('正式项目有未保存的修改，离开会丢失这些修改。是否继续？')) {
          location.hash = previous.current;
          return;
        }
        dirty.current = false;
      }
      previous.current = location.hash;
      setFormal(next);
    };
    const edited = (event: Event) => { dirty.current = Boolean((event as CustomEvent).detail); };
    window.addEventListener('hashchange', changed);
    window.addEventListener('formal-dirty', edited);
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('formal-dirty', edited); };
  }, []);
  return formal
    ? <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin" size={24}/>正在打开正式项目…</div>}><FormalWorkspace onDemo={() => { location.hash = '/overview'; }}/></Suspense>
    : <DemoApp/>;
}

function DemoApp() {
  const [page, setPage] = useState<Page>(() => navigation.some(n => n.id === location.hash.slice(2).split('?')[0]) ? location.hash.slice(2).split('?')[0] as Page : 'overview');
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<'about' | 'flow' | 'notifications' | null>(null);
  const [taskView, setTaskView] = useState<'list' | 'evaluation'>('list');
  const [initialQuestion, setInitialQuestion] = useState(1);
  const [search, setSearch] = useState('');
  const [taskSearch, setTaskSearch] = useState('');
  const [identity, setIdentity] = useState('评测员 A');
  const [identityMenu, setIdentityMenu] = useState(false);
  const [records, setRecords] = useState<EvaluationRecord[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = (message: string) => { setToast(message); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(''), 4200); };
  const refresh = () => getValue<EvaluationRecord[]>('evaluation-records', []).then(setRecords).catch(() => notify('无法读取本机数据，请检查浏览器存储设置'));
  useEffect(() => { refresh(); const listener = () => { const key = location.hash.slice(2).split('?')[0]; if (navigation.some(n => n.id === key)) setPage(key as Page); }; window.addEventListener('hashchange', listener); return () => { window.removeEventListener('hashchange', listener); clearTimeout(timer.current); }; }, []);
  const navigate = (next: Page, evaluate = false, id = 1) => { setPage(next); location.hash = `/${next}`; setTaskView(evaluate ? 'evaluation' : 'list'); setInitialQuestion(id); window.scrollTo({ top: 0 }); };
  const exportData = async () => { try { const packet = await exportPreview(); downloadJson('eval-studio-demo-backup.json', packet); await setValue('last-backup', new Date().toISOString()); notify(`已导出 ${packet.entries.length} 项本机演示记录`); } catch { notify('备份失败，请检查浏览器可用存储空间'); } };

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('overview')} aria-label="Eval Studio 首页"><span className="brand-mark"><Layers3 size={23} strokeWidth={2.1}/></span><span><strong>Eval Studio<span className="brand-dot">.</span></strong><small>AI 产品评测工作台</small></span></button>
      <button className="workspace-switch" onClick={() => { location.hash = '/projects'; }}><span className="workspace-initial">E</span><span><strong>电商文生图评测</strong><small>个人工作空间</small></span><ChevronDown size={14}/></button>
      <div className="nav-caption">工作空间</div>
      <nav aria-label="项目导航">{navigation.map(({ id, label, icon: Icon, count }) => <button key={id} aria-label={label} title={label} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)}><Icon size={18}/><span>{label}</span>{count && <span className="nav-count">{count}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><button className="sidebar-note" onClick={() => setModal('about')}><span className="note-icon"><GitBranch size={17}/></span><strong>方法可复用，判断有依据</strong><p>从这次评测，开始积累你的方案库。</p><span>了解工作台 <ArrowUpRight size={13}/></span></button><button className="sidebar-help" onClick={() => setModal('about')}><CircleHelp size={17}/>使用说明<span>↗</span></button><div className="sidebar-user"><span className="person-avatar">A</span><span><strong>{identity}</strong><small>评测负责人</small></span><button className="icon-button" aria-label="项目设置" onClick={() => navigate('scheme')}><Settings2 size={17}/></button></div></div>
    </aside>

    <div className="workspace-main"><header className="topbar"><div className="breadcrumb"><span>工作空间</span><ChevronRight size={14}/><strong>{navigation.find(n => n.id === page)?.label}</strong></div><div className="topbar-right"><form className="global-search" onSubmit={e => { e.preventDefault(); setTaskSearch(search); navigate('tasks'); }}><Search size={15}/><input aria-label="搜索评测题目" placeholder="搜索题目、场景…" value={search} onChange={e => setSearch(e.target.value)}/><kbd>↵</kbd></form><span className="local-indicator"><span/>本地模式</span><button className="icon-button notification-button" aria-label="查看通知" onClick={() => setModal('notifications')}><Bell size={18}/><i/></button><div className="identity-wrap"><button className="identity-trigger" onClick={() => setIdentityMenu(!identityMenu)}><span className="person-avatar small">{identity.slice(-1)}</span><ChevronDown size={13}/></button>{identityMenu && <div className="dropdown identity-dropdown"><div className="dropdown-label">本地评测身份 · 非账号登录</div>{['评测员 A','评测员 B','评测员 C'].map(name => <button key={name} onClick={() => { setIdentity(name); setIdentityMenu(false); notify(`已切换显示身份为 ${name}，已有数据保持原归属`); }}>{name}{identity === name && <Check size={14}/>}</button>)}</div>}</div></div></header>
      <main className={`main-content ${page === 'tasks' && taskView === 'evaluation' ? 'main-assessment' : ''}`}>
        <div className="preview-ribbon"><span><span className="preview-dot"/>演示项目</span><p>所有产品、图片与统计均为界面演示；你保存的操作仅保留在当前浏览器。</p><button onClick={() => { location.hash = '/projects'; }}>进入正式项目 <ArrowRight size={13}/></button><button onClick={() => setModal('about')}>预览说明 <ArrowUpRight size={12}/></button></div>
        <Suspense fallback={<div className="empty-state"><LoaderCircle size={22} className="spin"/>正在打开页面…</div>}>
        {page === 'overview' && <Overview navigate={navigate} records={records} onExport={exportData} onFlow={() => setModal('flow')}/>}
        {page === 'scheme' && <SchemePage onToast={notify}/>}
        {page === 'tasks' && (taskView === 'evaluation' ? <><button className="back-link" onClick={() => setTaskView('list')}><ChevronLeft size={15}/>返回任务列表</button><Evaluation key={initialQuestion} initialQuestionId={initialQuestion} onToast={notify} onSaved={refresh}/></> : <Tasks search={taskSearch} onSearch={setTaskSearch} records={records} onEvaluate={id => navigate('tasks', true, id)} onToast={notify}/>)}
        {page === 'quality' && <QualityPage onToast={notify}/>}
        {page === 'compare' && <Comparison onToast={notify}/>}
        {page === 'dashboard' && <DashboardPage onToast={notify}/>}
        {page === 'report' && <ReportDemo onToast={notify}/>}
        {page === 'sync' && <SyncPage onToast={notify} onExport={exportData} onImport={refresh}/>}
        </Suspense><footer className="workspace-footer"><span>Eval Studio <span className="footer-sep">/</span> 让评测过程可追溯</span><span><GitBranch size={12}/> v0.1 · 界面预览</span></footer>
      </main>
    </div>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18}/><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={14}/></button></div>}
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className="modal" role="dialog" aria-modal="true" aria-label={modal === 'flow' ? '完整评测流程' : modal === 'about' ? '界面预览说明' : '通知'} onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭弹窗" onClick={() => setModal(null)}><X size={20}/></button><span className="eyebrow">EVAL STUDIO</span><h2>{modal === 'flow' ? '从规则到结论，完成一次评测' : modal === 'about' ? '先体验工作台的操作方式' : '项目通知'}</h2>{modal === 'flow' ? <><p className="muted">准备分发后，在三个节点集中同步；出现缺图或分歧时可追加修订包。</p>{['准备：配置方案、题库与分工','同步一：校准后冻结规则','正式评测：保存首次全部出图与判断','同步二：合并初评，分发独立复评包','先完成独立复评，再做 GSB 与联合讨论','同步三：合并裁决，形成最终归档'].map((s, i) => <div className="flow-modal-row" key={s}><span>{i + 1}</span>{s}</div>)}</> : modal === 'about' ? <><p>这是一版可交互的界面预览，用来确认布局、信息层级和评测操作。</p><div className="about-capabilities"><CheckCircle2 size={18}/><p>可切换页面、打标签、上传图片、保存草稿、提交 GSB、调整方案，以及导入导出演示备份。</p></div><p className="muted">本区题库和统计均为演示数据。点击顶部“进入正式项目”，可配置真实题库、采集原图并计算七维度评分。正式项目已支持阶段同步、独立复评、联合排名与报告草稿；GitHub 部署后续实现。</p><button className="btn btn-primary" onClick={() => { setModal(null); navigate('tasks', true); }}>体验逐题评测 <ArrowRight size={15}/></button></> : <><div className="notification-item"><span className="notification-dot"/><div><strong>还有 8 道题等待竞品 A 初评</strong><p>示例任务 · 正式评测阶段</p></div></div><div className="notification-item"><span className="notification-dot orange"/><div><strong>3 条存疑记录等待讨论</strong><p>示例提醒 · 请在质量控制中查看</p></div></div><button className="btn" onClick={() => { setModal(null); navigate('quality'); }}>前往质量控制 <ArrowRight size={14}/></button></>}</section></div>}
  </div>;
}

function Overview({ navigate, records, onExport, onFlow }: { navigate: (page: Page, evaluate?: boolean, id?: number) => void; records: EvaluationRecord[]; onExport: () => void; onFlow: () => void }) {
  return <>
    <PageHeading eyebrow="PROJECT OVERVIEW" title="电商文生图竞品评测" description="同一套题目、统一评测标准，记录产品差异与改进方向。" action={<><button className="btn" onClick={onExport}><Download size={15}/>导出数据</button><button className="btn btn-primary" onClick={() => navigate('tasks', true)}><span>继续评测</span><ArrowRight size={15}/></button></>}/>
    <div className="project-meta"><Pill tone="violet">正式评测中</Pill><span><Users size={14}/>3 名评测员</span><span><Layers3 size={14}/>4 个产品</span><span><FileCheck2 size={14}/>50 道共用题目</span><span><GitBranch size={14}/>方案 v0.1</span><span className="meta-local"><CloudOff size={14}/>{records.length ? `本机已保存 ${records.length} 条记录` : '本地独立评测'}</span></div>
    <div className="metric-grid">
      <Metric label="正式评测完成度" value="84" unit="%" icon={FileCheck2} caption="126 / 150 个竞品任务" badge="进行中" progress={84}/>
      <Metric label="平均出图可用率" value="73.0" unit="%" icon={ImageIcon} caption="3 个竞品 · 示例统计" note="无 P0 / P1 问题"/>
      <Metric label="待交叉复评" value="30" unit="题" icon={ShieldCheck} caption="每产品随机抽取 10 题" note="初评同步后开始"/>
      <Metric label="存疑待讨论" value="3" unit="条" icon={Info} caption="保留判断依据，统一尺度" badge="待处理" warning/>
    </div>
    <section className="panel process-panel"><PanelHeading title="评测进程" action={<TextLink onClick={onFlow}>查看完整流程</TextLink>}/><div className="process-steps">{[{ title: '方案准备', sub: '题库、维度与分工', state: 'done' }, { title: '校准对齐', sub: '5 题 · 统一判断尺度', state: 'done' }, { title: '正式评测', sub: '逐题记录与标签评分', state: 'current' }, { title: '交叉复评', sub: '独立判断与分歧处理', state: 'waiting' }, { title: '汇总输出', sub: '比较分析与结论归档', state: 'waiting' }].map((step, i) => <div className={`process-step ${step.state}`} key={step.title}><div className="step-track"><span>{step.state === 'done' ? <Check size={14}/> : `0${i + 1}`}</span><i/></div><strong>{step.title}{step.state === 'current' && <small>当前阶段</small>}</strong><p>{step.sub}</p></div>)}</div><div className="process-next"><span><span className="purple-dot"/>下一步</span><p>完成剩余 24 个竞品任务，再导出初评包进入交叉复评。</p><button onClick={() => navigate('sync')}>前往数据同步 <ArrowRight size={14}/></button></div></section>
    <div className="overview-columns"><section className="panel product-panel"><PanelHeading title="被测产品" subtitle="各产品使用同一套 50 题，模拟自家单独标记" action={<TextLink onClick={() => navigate('scheme')}>管理产品</TextLink>}/><div className="table-wrap"><table className="table product-table"><thead><tr><th>产品</th><th>负责人</th><th>评测进度</th><th>可用率</th><th>状态</th></tr></thead><tbody>{products.map((product, i) => <tr key={product.id}><td><div className="product-cell"><ProductAvatar letter={product.letter} color={product.color}/><span><strong>{product.name}</strong><small>{product.role}</small></span></div></td><td>{product.demo ? <span className="muted">演示素材</span> : <div className="assignee"><span className={`mini-person person-${i}`}>{String.fromCharCode(64 + i)}</span>评测员 {String.fromCharCode(64 + i)}</div>}</td><td><div className="table-progress"><span><strong>{product.done}</strong> / {product.total}</span><div className="progress-track"><i style={{ width: `${product.done / product.total * 100}%` }}/></div></div></td><td><strong className="number-value">{product.usable}<small>%</small></strong></td><td><Pill tone={product.demo ? 'neutral' : product.done > 40 ? 'violet' : 'orange'}>{product.demo ? '模拟数据' : '进行中'}</Pill></td></tr>)}</tbody></table></div><div className="panel-footnote"><Info size={13}/>演示自家数据不计入 150 个真实竞品任务。</div></section>
    <section className="panel next-tasks-panel"><PanelHeading title="我的待办" action={<span className="count-label">评测员 A</span>}/><button className="todo-item" onClick={() => navigate('tasks', true, 43)}><span className="todo-icon violet"><ListTodo size={18}/></span><div><strong>完成竞品 A 初评</strong><p>剩余 8 道题 · 正式评测</p></div><ChevronRight size={15}/></button><button className="todo-item" onClick={() => navigate('quality')}><span className="todo-icon orange"><Info size={18}/></span><div><strong>处理存疑记录</strong><p>3 条记录等待统一判断</p></div><ChevronRight size={15}/></button><button className="todo-item" onClick={() => navigate('tasks')}><span className="todo-icon green"><SlidersHorizontal size={18}/></span><div><strong>补充编辑走查</strong><p>换背景 · 改颜色 · 扩图</p></div><ChevronRight size={15}/></button><div className="todo-bottom"><Clock3 size={14}/><span>以上为演示任务进度</span></div></section></div>
    <div className="overview-bottom"><section className="panel sample-panel"><PanelHeading title="最近评测样本" subtitle="点击样本，进入逐题评测" action={<TextLink onClick={() => navigate('tasks')}>全部题目</TextLink>}/><div className="sample-grid">{[{ id: 1, label: '精华液 · 自然光场景', scene: '场景图', cls: 'sample-warm', status: '2 个问题标签' }, { id: 9, label: '精华液 · 白底主图', scene: '白底主图', cls: 'sample-clean', status: '待复核' }].map(sample => <button className="sample-card" key={sample.id} onClick={() => navigate('tasks', true, sample.id)}><div className={`sample-image ${sample.cls}`}><img src={asset} alt="琥珀色精华液瓶，AI 生成演示素材"/><span>#{String(sample.id).padStart(2, '0')}</span><small>演示素材</small></div><div className="sample-info"><strong>{sample.label}</strong><span>{sample.scene}<i/>{sample.status}</span><ArrowUpRight size={15}/></div></button>)}</div></section><section className="panel method-panel"><div className="method-top"><span className="method-icon"><BookOpen size={19}/></span><Pill>方案摘要</Pill></div><h2>用问题标签，统一评测标准</h2><p>25 个标签覆盖 7 个一级维度，按每个维度的最高严重等级换算分数。</p><div className="score-scale">{[['P0','1'],['P1','2'],['P2','3'],['P3','4'],['无标签','5']].map(([label, value]) => <div key={label}><span className={`severity-label severity-${label}`}>{label}</span><strong>{value}<small>分</small></strong></div>)}</div><button className="method-link" onClick={() => navigate('scheme')}>查看维度与评分规则 <ArrowUpRight size={15}/></button></section></div>
  </>;
}

function Metric({ label, value, unit, icon: Icon, caption, badge, note, progress, warning }: { label: string; value: string; unit: string; icon: LucideIcon; caption: string; badge?: string; note?: string; progress?: number; warning?: boolean }) {
  return <div className="metric-card"><div className="metric-title"><span>{label}</span><Icon size={17}/></div><div className="metric-value">{value}<small>{unit}</small>{badge && <Pill tone={warning ? 'orange' : 'violet'}>{badge}</Pill>}</div><div className="metric-caption">{caption}</div>{progress !== undefined ? <div className="progress-track metric-progress"><i style={{ width: `${progress}%` }}/></div> : <div className="metric-note">{note || (warning ? '前往质量控制集中讨论' : '')}</div>}</div>;
}

function Tasks({ search, onSearch, records, onEvaluate, onToast }: { search: string; onSearch: (s: string) => void; records: EvaluationRecord[]; onEvaluate: (id: number) => void; onToast: (s: string) => void }) {
  const [scene, setScene] = useState('全部场景');
  const [status, setStatus] = useState('全部状态');
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('正式评测');
  const [selected, setSelected] = useState<number[]>([]);
  const filtered = questions.filter(q => (!search || `${q.title}${q.request}${q.category}${q.id}`.includes(search)) && (scene === '全部场景' || q.scene === scene) && (status === '全部状态' || q.status === status));
  useEffect(() => { setPage(1); }, [search, scene, status]);
  const current = filtered.slice((page - 1) * 10, page * 10);
  return <><PageHeading eyebrow="MY TASKS" title="我的评测任务" description="按题查看需求与验收要点，记录首次生成结果和判断依据。" action={<button className="btn btn-primary" onClick={() => onEvaluate(43)}>开始评测 <ArrowRight size={15}/></button>}/><div className="tabs task-tabs">{['正式评测','编辑走查','功能检查'].map(item => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item}{item === '正式评测' && <span>50</span>}</button>)}</div>{tab === '正式评测' ? <section className="panel"><div className="task-toolbar"><div className="search-input"><Search size={16}/><input aria-label="筛选题目" placeholder="搜索题号、需求或品类" value={search} onChange={e => onSearch(e.target.value)}/></div><select className="input" aria-label="筛选场景" value={scene} onChange={e => setScene(e.target.value)}>{['全部场景',...scenes].map(s => <option key={s}>{s}</option>)}</select><select className="input" aria-label="筛选状态" value={status} onChange={e => setStatus(e.target.value)}>{['全部状态','已完成','进行中','待评测'].map(s => <option key={s}>{s}</option>)}</select><span className="toolbar-spacer"/><button className="btn btn-small" onClick={() => { downloadJson('demo-task-list.json', { dataSource: 'demo', questions: selected.length ? questions.filter(q => selected.includes(q.id)) : filtered }); onToast('已导出演示任务列表'); }}><Download size={14}/>导出{selected.length ? ` ${selected.length} 题` : ''}</button></div><div className="task-product-banner"><ProductAvatar letter="A" color="blue" small/><strong>竞品 A</strong><span>直接竞品</span><span className="banner-divider"/><span>评测员 A · 42 / 50 题（演示）</span><Pill tone="violet">本机保存 {records.length} 条</Pill></div><div className="table-wrap"><table className="table tasks-table"><thead><tr><th><input type="checkbox" aria-label="选择当前页所有题目" checked={current.length > 0 && current.every(q => selected.includes(q.id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected,...current.map(q => q.id)])] : selected.filter(id => !current.some(q => q.id === id)))}/></th><th>题号</th><th>评测需求</th><th>场景</th><th>品类</th><th>难度</th><th>状态</th><th/></tr></thead><tbody>{current.map(q => { const local = records.find(r => r.productId === 'p1' && r.questionId === q.id); return <tr key={q.id}><td><input type="checkbox" aria-label={`选择题目${q.id}`} checked={selected.includes(q.id)} onChange={e => setSelected(e.target.checked ? [...selected,q.id] : selected.filter(id => id !== q.id))}/></td><td className="question-number">#{String(q.id).padStart(2,'0')}</td><td><button className="question-title" onClick={() => onEvaluate(q.id)}>{q.title}</button><small className="task-description">{q.request}</small></td><td><Pill>{q.scene}</Pill></td><td>{q.category}</td><td><span className={`difficulty difficulty-${q.difficulty}`}>{q.difficulty}</span></td><td><span className={`status-dot ${local ? 'saved' : q.status === '已完成' ? 'complete' : q.status === '进行中' ? 'current' : ''}`}/>{local ? local.status === 'submitted' ? '本机已提交' : '本机草稿' : q.status}</td><td><button className="table-action" onClick={() => onEvaluate(q.id)} aria-label={`评测题目${q.id}`}><ArrowUpRight size={16}/></button></td></tr>; })}</tbody></table>{!current.length && <div className="empty-state"><Search size={26}/><strong>没有符合条件的题目</strong><p>试试其他关键词或场景。</p></div>}</div><div className="pagination"><span>共 {filtered.length} 道题 · 演示占位题库</span><div><button className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16}/></button><span>{page} / {Math.max(1,Math.ceil(filtered.length / 10))}</span><button className="icon-button" aria-label="下一页" disabled={page >= Math.ceil(filtered.length / 10)} onClick={() => setPage(page + 1)}><ChevronRight size={16}/></button></div></div></section> : <Walkthrough mode={tab} onToast={onToast}/>}</>;
}

function Walkthrough({ mode, onToast }: { mode: string; onToast: (s: string) => void }) {
  const labels = mode === '编辑走查' ? ['换背景：将白底商品图换为厨房场景','改颜色：将商品背景改为浅绿色','扩图：将 1:1 图片扩展为 9:16'] : ['支持商品图上传 / 参考图','支持电商模板','支持局部重绘与扩图','支持批量生成','商用授权条款明确'];
  const [values, setValues] = useState<Record<string, boolean>>({});
  useEffect(() => { getValue<Record<string, boolean>>(`walkthrough:${mode}`, {}).then(setValues).catch(() => onToast('读取本机记录失败')); }, [mode]);
  return <section className="panel walkthrough-panel"><PanelHeading title={mode === '编辑走查' ? '固定编辑任务' : '产品功能检查'} subtitle="竞品 A · 演示记录，可保存本机勾选状态"/><div className="notice-inline"><Info size={16}/>本轮用于查看功能元素。操作步数、标签与授权原文将在正式版补齐。</div>{labels.map((label, i) => <label key={label} className="walkthrough-row"><span className="walkthrough-index">0{i + 1}</span><span><strong>{label}</strong><small>在被测产品中完成后记录结果</small></span><input type="checkbox" checked={values[label] ?? false} onChange={e => setValues({ ...values, [label]: e.target.checked })}/><span>{values[label] ? '已确认' : '待检查'}</span></label>)}<button className="btn btn-primary" onClick={async () => { try { await setValue(`walkthrough:${mode}`, values); onToast('检查状态已保存到当前浏览器'); } catch { onToast('保存失败，请检查浏览器存储'); } }}><Check size={15}/>保存检查状态</button></section>;
}

function SyncPage({ onToast, onExport, onImport }: { onToast: (s: string) => void; onExport: () => Promise<void>; onImport: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [lastBackup, setLastBackup] = useState('尚未备份');
  const [incoming, setIncoming] = useState<unknown>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { getValue<string>('last-backup', '').then(v => v && setLastBackup(new Date(v).toLocaleString('zh-CN'))); }, []);
  const read = async (file?: File) => { if (!file) return; if (file.size > 30 * 1024 * 1024) { onToast('预览版单个备份限制 30 MB'); return; } try { const packet = JSON.parse(await file.text()); if (packet.format !== 'eval-studio-preview' || packet.version !== 1 || packet.dataSource !== 'demo' || !Array.isArray(packet.entries)) throw new Error(); setIncoming(packet); setCount(packet.entries.length); } catch { onToast('文件不是有效的界面演示备份'); } };
  return <><PageHeading eyebrow="DATA & SYNC" title="数据同步" description="本地独立完成评测，在关键节点合并数据；随时导出备份。" action={<Pill tone="orange">当前为界面演示备份</Pill>}/><div className="sync-explainer"><span className="sync-symbol"><FolderSync size={25}/></span><div><h2>三次同步，把独立判断连接起来</h2><p>每个人保留自己的记录，负责人汇总后分发下一阶段数据包。</p></div><CloudOff size={30}/></div><div className="sync-stage-grid">{[{ n:'01', title:'校准后同步', sub:'冻结规则与判断锚点', rows:['独立校准判断','标签参考案例','正式规则快照'], status:'阶段包后续实现' },{ n:'02', title:'初评完成后同步', sub:'合并结果，分发复评', rows:['初评与全部原图','定向独立复评包','联合比较素材'], status:'阶段包后续实现' },{ n:'03', title:'复评与对比后同步', sub:'处理分歧，汇总归档', rows:['独立复评与裁决','GSB 与联合排名','最终结果与证据'], status:'阶段包后续实现' }].map(stage => <section className="panel sync-stage" key={stage.n}><span className="sync-stage-number">{stage.n}</span><h2>{stage.title}</h2><p>{stage.sub}</p><ul>{stage.rows.map(row => <li key={row}><Check size={14}/>{row}</li>)}</ul><Pill>{stage.status}</Pill></section>)}</div><div className="backup-grid"><section className="panel backup-panel"><PanelHeading title="本机演示备份" subtitle="此处可实际导出并恢复本轮界面操作记录"/><div className="backup-status"><span><FileJson2 size={25}/></span><div><strong>JSON 数据备份</strong><p>包含草稿、上传图片与已保存的演示判断</p></div><Pill tone="green">本机保存</Pill></div><div className="backup-meta"><Clock3 size={14}/>上次备份：{lastBackup}</div><button className="btn btn-primary" onClick={async () => { await onExport(); const v = await getValue('last-backup', ''); if (v) setLastBackup(new Date(v).toLocaleString('zh-CN')); }}><Download size={15}/>导出演示备份</button><p className="backup-caveat">正式项目已提供清单与 ZIP 分包、版本校验和冲突合并，请从“进入正式项目”使用。</p></section><section className="panel backup-panel"><PanelHeading title="恢复演示备份" subtitle="选择由本界面导出的 JSON 文件"/><input ref={input} type="file" accept="application/json,.json" hidden onChange={e => { read(e.target.files?.[0]); e.target.value = ''; }}/><button className="upload-zone" onClick={() => input.current?.click()}><span><Upload size={23}/></span><strong>选择备份文件</strong><p>JSON 文件 · 最大 30 MB</p></button>{!!incoming && <div className="import-preview"><span><FileCheck2 size={16}/>检测到 {count} 项演示数据</span><p>相同键的本机记录将被此备份替换。请先导出当前备份。</p><div><button className="btn" onClick={() => setIncoming(null)}>取消</button><button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { const imported = await importPreview(incoming); setIncoming(null); onImport(); onToast(`已恢复 ${imported} 项演示数据`); } catch (error) { onToast(error instanceof Error ? error.message : '恢复失败'); } finally { setBusy(false); } }}>{busy && <LoaderCircle size={14} className="spin"/>}确认恢复</button></div></div>}</section></div></>;
}
