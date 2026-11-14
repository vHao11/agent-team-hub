import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, FilePlus2, GitBranch, Plus, RefreshCw } from 'lucide-react';
import { write } from '../api';
import { useApi } from '../hooks';
import type { Bootstrap, PipelineStepView, PipelineView, WorkflowTemplate, WorkflowVersion } from '../types';
import { Dialog, EmptyState, ErrorBanner, Field, Loading, PageHeader } from './ui';

const pipelineLabels: Record<string, string> = { draft: '草稿', active: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const stepLabels: Record<string, string> = { waiting: '未开始', awaiting_accept: '待接单', declined: '已拒收', accepted: '已接单', working: '处理中', awaiting_review: '待验收', completed: '已完成', cancelled: '已取消' };

export function Pipelines({ bootstrap, notify, onOpenItem, initialVersion, clearInitialVersion, revision }: { bootstrap: Bootstrap; notify: (message: string) => void; onOpenItem: (id: string) => void; initialVersion: WorkflowVersion | null; clearInitialVersion: () => void; revision: number }) {
  const { data, error, loading, refresh } = useApi<{ items: PipelineView[] }>('/pipelines', revision);
  const templates = useApi<{ items: WorkflowTemplate[] }>('/workflow-templates');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { if (initialVersion) setCreating(true); }, [initialVersion]);
  const closeCreate = () => { setCreating(false); clearInitialVersion(); };
  return <div className="page">
    <PageHeader title="流水线任务" subtitle="查看跨组步骤、当前责任与验收进度。" action={<button className="button button-primary" onClick={() => setCreating(true)}><Plus size={17} />创建流水线</button>} />
    <ErrorBanner error={error || templates.error} onRetry={() => { refresh(); templates.refresh(); }} />
    {loading ? <Loading label="正在读取流水线…" /> : data?.items.length ? <div className="workflow-list">{data.items.map(view => <article className="workflow-card pipeline-card" key={view.pipeline.id}>
      <div className="workflow-card-header"><div><h2>{view.pipeline.title}</h2><p>{view.pipeline.description || '未填写目标说明'}</p><small>{view.template_version.definition.name} · v{view.template_version.version} · {bootstrap.projects.find(project => project.id === view.pipeline.project_id)?.name || view.pipeline.project_id}</small></div><span className="subtle-badge">{pipelineLabels[view.pipeline.status]}</span></div>
      <div className="workflow-preview">{view.steps.map((step, index) => <span key={step.id}>{index > 0 && <b>→</b>}<span className={step.state === 'completed' ? 'pipeline-step-done' : ''}>{step.definition.name}<small> {stepLabels[step.state] || step.state}</small></span></span>)}</div>
      {view.pipeline.blocked_reason && <div className="warning-note">{view.pipeline.blocked_reason}</div>}
      <div className="workflow-actions"><button className="button button-small" onClick={() => setSelected(view.pipeline.id)}>查看详情</button></div>
    </article>)}</div> : !error && <EmptyState title="还没有流水线任务" text="选择已发布的模板，为每个角色绑定团队和验收人。" action={<button className="button" onClick={() => setCreating(true)}><FilePlus2 size={16} />创建流水线</button>} />}
    <button className="text-button workflow-refresh" onClick={() => { refresh(); templates.refresh(); }}><RefreshCw size={14} />刷新流水线</button>
    {creating && <CreatePipeline bootstrap={bootstrap} templates={templates.data?.items || []} initialVersion={initialVersion} loading={templates.loading} onClose={closeCreate} onCreated={view => { closeCreate(); refresh(); setSelected(view.pipeline.id); notify('流水线草稿已创建，请核对后启动。'); }} />}
    {selected && <PipelineDetail key={selected} id={selected} bootstrap={bootstrap} onClose={() => setSelected(null)} onOpenItem={id => { setSelected(null); onOpenItem(id); }} onChanged={refresh} notify={notify} />}
  </div>;
}

function CreatePipeline({ bootstrap, templates, initialVersion, loading, onClose, onCreated }: { bootstrap: Bootstrap; templates: WorkflowTemplate[]; initialVersion: WorkflowVersion | null; loading: boolean; onClose: () => void; onCreated: (value: PipelineView) => void }) {
  const versions = templates.flatMap(template => template.versions);
  const [versionId, setVersionId] = useState(initialVersion?.id || versions[0]?.id || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState(bootstrap.projects[0]?.id || '');
  const [priority, setPriority] = useState('normal');
  const [due, setDue] = useState('');
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const version = versions.find(entry => entry.id === versionId);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const chosenAssignees = Object.fromEntries(Object.entries(assignees).filter(([, value]) => value));
      onCreated(await write<PipelineView>('/pipelines', { title: title.trim(), description: description.trim(), project_id: project,
        template_version_id: versionId, role_bindings: bindings, assignees: chosenAssignees, priority,
        due_at: due ? new Date(`${due}T18:00:00`).toISOString() : null }));
    } catch (reason) { setError(reason); } finally { setBusy(false); }
  }
  return <Dialog title="创建流水线任务" subtitle="绑定模板版本、承接团队和验收人；创建后需要明确启动。" onClose={onClose} wide><form className="modal-form" onSubmit={submit}>
    <ErrorBanner error={error} />
    {loading ? <Loading label="正在读取模板…" /> : !versions.length ? <div className="info-note">尚无已发布模板。请先到“流水线模板”创建并发布。</div> : <>
      <Field label="任务名称" required><input required value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：接口版本兼容改造" /></Field>
      <div className="form-grid"><Field label="模板版本" required><select value={versionId} required onChange={event => { setVersionId(event.target.value); setBindings({}); setAssignees({}); }}>{versions.map(entry => <option key={entry.id} value={entry.id}>{entry.definition.name} · v{entry.version}</option>)}</select></Field><Field label="协作项目" required><select value={project} required onChange={event => setProject(event.target.value)}>{bootstrap.projects.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field></div>
      <Field label="目标与背景"><textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></Field>
      <div className="form-grid"><Field label="优先级"><select value={priority} onChange={event => setPriority(event.target.value)}><option value="normal">普通</option><option value="high">较高</option><option value="urgent">紧急</option></select></Field><Field label="约定交付日期"><input type="date" value={due} onChange={event => setDue(event.target.value)} /></Field></div>
      <div className="section-title workflow-section-title"><h3>绑定流程角色</h3></div><p className="field-hint">接收团队确认接单前，责任仍在发起团队。</p>
      <div className="form-grid">{version?.definition.roles.map(role => <Field key={role.key} label={`${role.label}（${role.kind === 'team' ? '团队' : '验收人'}）`} required><select required value={bindings[role.key] || ''} onChange={event => { setBindings(current => ({ ...current, [role.key]: event.target.value })); setAssignees({}); }}><option value="">请选择</option>{role.kind === 'team' ? bootstrap.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>) : bootstrap.users.map(user => <option key={user.id} value={user.id}>{user.name} · {bootstrap.teams.find(team => team.id === user.team_id)?.name}</option>)}</select></Field>)}</div>
      <div className="section-title workflow-section-title"><h3>步骤预览与可选处理人</h3></div>
      {version?.definition.steps.map((step, index) => <div className="pipeline-create-step" key={step.key}><div><strong>{index + 1}. {step.name}</strong><small>材料：{step.required_artifact_kinds.join('、')} · 验收：{step.acceptance_spec.join('；')}</small></div><Field label={`${step.name}处理人（可选）`}><select value={assignees[step.key] || ''} onChange={event => setAssignees(current => ({ ...current, [step.key]: event.target.value }))}><option value="">接单时指定</option>{bootstrap.users.filter(user => user.team_id === bindings[step.team_role] && user.id !== bindings[step.reviewer_role]).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field></div>)}
    </>}
    <footer className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button className="button button-primary" disabled={busy || !version || !project}>{busy ? '正在创建…' : '创建流水线'}</button></footer>
  </form></Dialog>;
}

function PipelineDetail({ id, bootstrap, onClose, onOpenItem, onChanged, notify }: { id: string; bootstrap: Bootstrap; onClose: () => void; onOpenItem: (id: string) => void; onChanged: () => void; notify: (message: string) => void }) {
  const { data, error, loading, refresh, setData } = useApi<PipelineView>(`/pipelines/${id}`);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [reassign, setReassign] = useState<PipelineStepView | null>(null);
  const labels: Record<string, string> = { start: '启动流水线', pause: '暂停', resume: '恢复', cancel: '取消流水线' };
  async function control(action: string) {
    if (!data) return;
    setBusy(action); setActionError(null);
    try { const result = await write<PipelineView>(`/pipelines/${id}/${action}`, { expected_version: data.pipeline.version }); setData(result); onChanged(); notify(`${labels[action]}成功。`); }
    catch (reason) { setActionError(reason); refresh(); } finally { setBusy(''); }
  }
  const teamName = (teamId: string) => bootstrap.teams.find(team => team.id === teamId)?.name || teamId;
  const userName = (userId: string) => bootstrap.users.find(user => user.id === userId)?.name || userId;
  return <>{!reassign && <Dialog title={data?.pipeline.title || '流水线详情'} subtitle={data ? `${data.template_version.definition.name} · v${data.template_version.version}` : undefined} onClose={onClose} wide><div className="modal-content">
    <ErrorBanner error={error || actionError} onRetry={refresh} />{loading ? <Loading /> : data && <>
      <div className="pipeline-summary"><span className="subtle-badge">{pipelineLabels[data.pipeline.status]}</span><span>流程版本 {data.pipeline.version}</span><span>{bootstrap.projects.find(project => project.id === data.pipeline.project_id)?.name}</span></div>
      {data.pipeline.description && <p className="pre-line pipeline-description">{data.pipeline.description}</p>}
      {data.pipeline.blocked_reason && <div className="warning-note">{data.pipeline.blocked_reason}</div>}
      <div className="workflow-actions pipeline-controls">{data.allowed_actions.map(action => <button key={action} className={`button button-small ${action === 'start' ? 'button-primary' : ''} ${action === 'cancel' ? 'danger-text' : ''}`} disabled={!!busy} onClick={() => void control(action)}>{labels[action]}</button>)}<button className="button button-small" onClick={refresh}><RefreshCw size={14} />刷新</button></div>
      <div className="pipeline-steps">{data.steps.map((step, index) => <article className={`pipeline-step ${step.state === 'completed' ? 'pipeline-step-complete' : ''}`} key={step.id}>
        <div className="pipeline-step-index">{index + 1}</div><div className="pipeline-step-body"><div className="pipeline-step-heading"><strong>{step.definition.name}</strong><span className="subtle-badge">{stepLabels[step.state] || step.state}</span></div><p>承接团队：{teamName(step.item?.pending_target_team_id || step.item?.owner_team_id || step.target_team_id)} · 验收人：{userName(step.reviewer_id)}{step.attempt && ` · 第 ${step.attempt.ordinal} 轮`}</p><p>必需材料：{step.definition.required_artifact_kinds.join('、')}</p>
        {step.item && <div className="workflow-actions"><button className="text-button" onClick={() => onOpenItem(step.item!.id)}>{step.item.number} · 打开事项 <ArrowRight size={14} /></button>{step.state === 'declined' && data.allowed_actions.includes('cancel') && <button className="text-button" onClick={() => setReassign(step)}>重新指派团队</button>}</div>}
        {step.attempt?.input_snapshot.upstream_deliveries.map(source => <button className="text-button" key={source.delivery_id} onClick={() => onOpenItem(source.work_item_id)}>查看上一步交付：{source.summary}</button>)}
        </div></article>)}</div>
      <div className="info-note pipeline-footnote"><GitBranch size={16} />执行成功不会自动验收；每一步由指定账号核对当前交付。</div>
    </>}</div></Dialog>}{reassign && data && <ReassignStep pipeline={data} step={reassign} bootstrap={bootstrap} onClose={() => setReassign(null)} onSaved={value => { setReassign(null); setData(value); onChanged(); notify('已向新团队发起接单请求。'); }} />}</>;
}

function ReassignStep({ pipeline, step, bootstrap, onClose, onSaved }: { pipeline: PipelineView; step: PipelineStepView; bootstrap: Bootstrap; onClose: () => void; onSaved: (value: PipelineView) => void }) {
  const [team, setTeam] = useState(bootstrap.teams.find(entry => entry.id !== step.target_team_id)?.id || '');
  const [reason, setReason] = useState(''); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(null); try { onSaved(await write<PipelineView>(`/pipelines/${pipeline.pipeline.id}/steps/${step.step_key}/reassign`, { expected_version: pipeline.pipeline.version, target_team_id: team, reason: reason.trim() })); } catch (cause) { setError(cause); } finally { setBusy(false); } }
  return <Dialog title="重新指派团队" subtitle={step.definition.name} onClose={onClose}><form className="modal-form" onSubmit={submit}><ErrorBanner error={error} /><Field label="接收团队" required><select required value={team} onChange={event => setTeam(event.target.value)}>{bootstrap.teams.map(entry => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></Field><Field label="调整原因" required><textarea required rows={3} value={reason} onChange={event => setReason(event.target.value)} /></Field><footer className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy}>发起接单请求</button></footer></form></Dialog>;
}
