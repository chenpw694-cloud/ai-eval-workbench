import { useEffect, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle, RotateCcw, Trash2, X } from 'lucide-react';
import type { Project } from '../core/model';

export type ProjectAction = { type: 'restart' | 'trash'; project: Project };

export default function ProjectLifecycleDialog({ action, busy, error, hasUnsavedChanges, onClose, onConfirm }: {
  action: ProjectAction;
  busy: boolean;
  error: string;
  hasUnsavedChanges: boolean;
  onClose: () => void;
  onConfirm: (options: { name: string; keepQuestions: boolean }) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(`${action.project.name} · 重新开始`);
  const [keepQuestions, setKeepQuestions] = useState(false);
  const restarting = action.type === 'restart';
  useEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="modal formal-lifecycle-dialog" aria-labelledby="project-action-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!busy && event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onClose();
    }}>
    <button className="modal-close icon-button" aria-label="关闭项目操作" disabled={busy} onClick={onClose}><X size={18}/></button>
    <div className="formal-lifecycle-body">
    <span className={`formal-lifecycle-icon ${restarting ? '' : 'is-trash'}`}>{restarting ? <RotateCcw size={22}/> : <Trash2 size={22}/>}</span>
    <div className="eyebrow">{restarting ? 'START AGAIN' : 'PROJECT RECYCLE BIN'}</div>
    <h2 id="project-action-title">{restarting ? '重新开始这次评测' : '移入回收站'}</h2>
    <p className="formal-lifecycle-source">当前项目：<strong>{action.project.name}</strong></p>
    {restarting ? <>
      <p>按已保存的成员、产品和评分规则创建新草稿，可重新导入题库。原项目、已上传素材与评分记录完整保留。</p>
      <label className="field formal-create-field">新项目名称<input className="input" autoFocus value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)}/></label>
      <fieldset className="formal-restart-options" disabled={busy}>
        <legend>新草稿的题库</legend>
        <label className={!keepQuestions ? 'selected' : ''}><input type="radio" name="restart-questions" checked={!keepQuestions} onChange={() => setKeepQuestions(false)}/><span><strong>清空题库，重新导入</strong><small>保留计划 {action.project.expectedQuestionCount} 题，重新选择 CSV / JSON 文件。</small></span></label>
        <label className={keepQuestions ? 'selected' : ''}><input type="radio" name="restart-questions" checked={keepQuestions} onChange={() => setKeepQuestions(true)}/><span><strong>保留现有 {action.project.questions.length} 道题目</strong><small>题目仍可编辑或替换；参考图文件需重新上传。</small></span></label>
      </fieldset>
      <div className="formal-lifecycle-note">新草稿从 0 条评测记录开始，费用和商用核验需重新填写；评分规则需重新确认。团队使用时，请重新分发新项目准备包。</div>
    </> : <>
      <p>项目会从“我的项目”移到回收站，评分记录、图片和历史版本全部保留，随时可以恢复。</p>
      <div className="formal-lifecycle-note">这只影响当前浏览器中的项目，不会删除其他评测员电脑上的副本。恢复后仍保留原来的配置锁定；要重新导入题库，请使用“重新开始”。</div>
    </>}
    {hasUnsavedChanges && <p className="formal-lifecycle-unsaved">当前页面有未保存编辑，继续后将离开此页；这些编辑不会带入新草稿或回收站。</p>}
    {error && <p className="formal-lifecycle-error" role="alert">{error}</p>}
    </div>
    <div className="formal-modal-actions">
      <button className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button className={`btn ${restarting ? 'btn-primary' : 'formal-trash-confirm'}`} disabled={busy || (restarting && !name.trim())} onClick={() => onConfirm({name: name.trim(), keepQuestions})}>
        {busy ? <LoaderCircle size={15} className="spin"/> : restarting ? <ArrowRight size={15}/> : <Trash2 size={15}/>}
        {busy ? '处理中…' : restarting ? '创建新草稿' : '确认移入回收站'}
      </button>
    </div>
  </dialog>;
}
