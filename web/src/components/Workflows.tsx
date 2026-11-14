import { useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, Copy, FilePlus2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, write } from '../api';
import { useApi } from '../hooks';
import type { Bootstrap, WorkflowDefinition, WorkflowRole, WorkflowStepDefinition, WorkflowTemplate, WorkflowVersion } from '../types';
import { Dialog, EmptyState, ErrorBanner, Field, Loading, PageHeader } from './ui';

const blankDefinition = (): WorkflowDefinition => ({
  roles: [{ key: 'owner_team', label: '承接团队', kind: 'team' }, { key: 'reviewer', label: '验收人', kind: 'reviewer' }],
  steps: [{ key: 'step_1', name: '处理事项', description: '', team_role: 'owner_team', reviewer_role: 'reviewer',
    acceptance_spec: ['交付满足约定'], required_artifact_kinds: ['document'], capabilities: null }],
});

export function Workflows({ bootstrap, notify, onCreatePipeline }: { bootstrap: Bootstrap; notify: (message: string) => void; onCreatePipeline: (version: WorkflowVersion) => void }) {
  const { data, error, loading, refresh } = useApi<{ items: WorkflowTemplate[] }>('/workflow-templates');
  const [editing, setEditing] = useState<WorkflowTemplate | 'new' | null>(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [validation, setValidation] = useState<{ id: string; errors: string[] } | null>(null);
  const canManage = (item: WorkflowTemplate) => bootstrap.me.role === 'admin' || (bootstrap.me.role === 'lead' && item.owner_team_id === bootstrap.me.team_id);
  async function action(template: WorkflowTemplate, actionName: 'validate' | 'publish' | 'clone') {
    setBusy(template.id); setActionError(null); setValidation(null);
    try {
      if (actionName === 'validate') {
        const result = await api<{ valid: boolean; errors: string[] }>(`/workflow-templates/${template.id}/validate`, { method: 'POST' });
        setValidation({ id: template.id, errors: result.errors });
        if (result.valid) notify('模板校验通过，可以发布。');
      } else {
        await write(`/workflow-templates/${template.id}/${actionName}`, actionName === 'publish' ? { expected_revision: template.draft_revision } : {});
        refresh(); notify(actionName === 'publish' ? '模板版本已发布。' : '已从最新版本复制草稿。');
      }
    } catch (reason) { setActionError(reason); } finally { setBusy(''); }
  }
  return <div className="page">
    <PageHeader title="流水线模板" subtitle="配置工作步骤、依赖关系、跨组角色和验收要求。发布后，新任务固定使用选定版本。" action={['lead', 'admin'].includes(bootstrap.me.role) ? <button className="button button-primary" onClick={() => setEditing('new')}><Plus size={17} />新建模板</button> : undefined} />
    <div className="info-note workflow-intro">没有前置步骤的工作可以并行开始；所有前置步骤验收通过后，后续步骤才会激活。</div>
    <ErrorBanner error={error || actionError} onRetry={refresh} />
    {loading ? <Loading label="正在读取模板…" /> : data?.items.length ? <div className="workflow-list">{data.items.map(template => <article className="workflow-card" key={template.id}>
      <div className="workflow-card-header"><div><h2>{template.name}</h2><p>{template.description || '未填写说明'}</p><small>{bootstrap.teams.find(team => team.id === template.owner_team_id)?.name || template.owner_team_id} · {template.versions.length} 个发布版本{template.draft ? ` · 草稿修订 ${template.draft_revision}` : ''}</small></div><span className="subtle-badge">{template.draft ? '草稿' : '已发布'}</span></div>
      {template.draft && <div className="workflow-preview">{template.draft.steps.map(step => <span key={step.key}>{step.name || '未命名步骤'}</span>)}</div>}
      {validation?.id === template.id && (validation.errors.length ? <div className="warning-note">{validation.errors.join('；')}</div> : <div className="info-note"><CheckCircle2 size={16} />草稿校验通过。</div>)}
      <div className="workflow-actions">{canManage(template) && template.draft && <><button className="button button-small" disabled={!!busy} onClick={() => setEditing(template)}>编辑草稿</button><button className="button button-small" disabled={!!busy} onClick={() => void action(template, 'validate')}>校验</button><button className="button button-primary button-small" disabled={!!busy} onClick={() => void action(template, 'publish')}>发布版本</button></>}{canManage(template) && !template.draft && template.versions.length > 0 && <button className="button button-small" disabled={!!busy} onClick={() => void action(template, 'clone')}><Copy size={14} />复制为新草稿</button>}</div>
      {template.versions.length > 0 && <details className="workflow-versions"><summary>已发布版本</summary>{template.versions.map(version => <div className="workflow-version" key={version.id}><div><strong>v{version.version} · {version.definition.name}</strong><small>{version.definition.steps.map(step => step.name).join(' · ')}</small></div><button className="text-button" onClick={() => onCreatePipeline(version)}>按此创建流水线</button></div>)}</details>}
    </article>)}</div> : !error && <EmptyState title="还没有流水线模板" text="先创建步骤和角色，校验并发布后就可以创建流水线任务。" action={['lead', 'admin'].includes(bootstrap.me.role) ? <button className="button" onClick={() => setEditing('new')}><FilePlus2 size={16} />新建模板</button> : undefined} />}
    <button className="text-button workflow-refresh" onClick={refresh}><RefreshCw size={14} />刷新模板</button>
    {editing && <WorkflowEditor key={editing === 'new' ? 'new' : editing.id} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); notify('模板草稿已保存，请校验后发布。'); }} />}
  </div>;
}

function WorkflowEditor({ template, onClose, onSaved }: { template: WorkflowTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [definition, setDefinition] = useState<WorkflowDefinition>(() => template?.draft ? structuredClone(template.draft) : blankDefinition());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const patchRole = (key: string, patch: Partial<WorkflowRole>) => setDefinition(current => ({ ...current, roles: current.roles.map(role => role.key === key ? { ...role, ...patch } : role) }));
  const patchStep = (key: string, patch: Partial<WorkflowStepDefinition>) => setDefinition(current => ({ ...current, steps: current.steps.map(step => step.key === key ? { ...step, ...patch } : step) }));
  function addRole(kind: WorkflowRole['kind']) {
    setDefinition(current => ({ ...current, roles: [...current.roles, { key: `${kind}_${crypto.randomUUID().slice(0, 8)}`, label: kind === 'team' ? '新团队角色' : '新验收角色', kind }] }));
  }
  function addStep() {
    setDefinition(current => ({ ...current, steps: [...current.steps, { key: `step_${crypto.randomUUID().slice(0, 8)}`, name: '', description: '',
      team_role: current.roles.find(role => role.kind === 'team')?.key || '', reviewer_role: current.roles.find(role => role.kind === 'reviewer')?.key || '',
      acceptance_spec: [''], required_artifact_kinds: ['document'], capabilities: null }] }));
  }
  function moveStep(index: number, direction: number) {
    setDefinition(current => { const steps = [...current.steps]; const next = index + direction; if (next < 0 || next >= steps.length) return current; [steps[index], steps[next]] = [steps[next], steps[index]]; return { ...current, steps }; });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const normalized = { ...definition, steps: definition.steps.map(step => ({ ...step,
        acceptance_spec: step.acceptance_spec.map(value => value.trim()).filter(Boolean),
        required_artifact_kinds: step.required_artifact_kinds.map(value => value.trim()).filter(Boolean) })) };
      const body = { name: name.trim(), description: description.trim(), definition: normalized };
      if (template) await write(`/workflow-templates/${template.id}`, { ...body, expected_revision: template.draft_revision }, 'PUT');
      else await write('/workflow-templates', body);
      onSaved();
    } catch (reason) { setError(reason); } finally { setBusy(false); }
  }
  return <Dialog title={template ? '编辑模板草稿' : '新建流水线模板'} subtitle="每个工作步骤都由指定验收人确认。" onClose={onClose} wide><form className="modal-form" onSubmit={save}>
    <ErrorBanner error={error} /><Field label="模板名称" required><input required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="例如：跨组接口改造" /></Field>
    <Field label="模板说明"><textarea rows={2} value={description} onChange={event => setDescription(event.target.value)} /></Field>
    <div className="section-title"><h3>流程角色</h3><div className="workflow-actions"><button type="button" className="button button-small" onClick={() => addRole('team')}>添加团队角色</button><button type="button" className="button button-small" onClick={() => addRole('reviewer')}>添加验收角色</button></div></div>
    <p className="field-hint">创建具体流水线时，再把角色绑定到团队或成员。</p>
    {definition.roles.map(role => <div className="workflow-role" key={role.key}><span className="subtle-badge">{role.kind === 'team' ? '团队' : '验收人'}</span><input aria-label={`${role.kind === 'team' ? '团队' : '验收'}角色名称`} required value={role.label} onChange={event => patchRole(role.key, { label: event.target.value })} /><button type="button" className="icon-button" aria-label={`删除角色${role.label}`} onClick={() => setDefinition(current => ({ ...current, roles: current.roles.filter(entry => entry.key !== role.key) }))}><Trash2 size={15} /></button></div>)}
    <div className="section-title workflow-section-title"><h3>工作步骤</h3><button type="button" className="button button-small" onClick={addStep}><Plus size={14} />添加步骤</button></div>
    {definition.steps.map((step, index) => <section className="workflow-step-editor" key={step.key}><div className="section-title"><strong>步骤 {index + 1}</strong><div className="workflow-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveStep(index, -1)}>上移</button><button type="button" className="text-button" disabled={index === definition.steps.length - 1} onClick={() => moveStep(index, 1)}>下移</button><button type="button" className="text-button danger-text" disabled={definition.steps.length === 1} onClick={() => setDefinition(current => ({ ...current, steps: current.steps.filter(entry => entry.key !== step.key).map(entry => entry.depends_on ? { ...entry, depends_on: entry.depends_on.filter(key => key !== step.key) } : entry) }))}>删除</button></div></div>
      <Field label="步骤名称" required><input required value={step.name} onChange={event => patchStep(step.key, { name: event.target.value })} /></Field>
      <fieldset><legend>前置步骤</legend><p className="field-hint">未选择时可与其他无前置步骤的工作并行；依赖的步骤全部通过后激活。</p>{definition.steps.filter(candidate => candidate.key !== step.key).map(candidate => {
        const parents = step.depends_on ?? (index ? [definition.steps[index - 1].key] : []);
        return <label key={candidate.key} style={{ display: 'block' }}><input type="checkbox" checked={parents.includes(candidate.key)} onChange={event => patchStep(step.key, { depends_on: event.target.checked ? [...parents, candidate.key] : parents.filter(key => key !== candidate.key) })} /> {candidate.name || candidate.key}</label>;
      })}</fieldset>
      <div className="form-grid"><Field label="承接团队角色" required><select required value={step.team_role} onChange={event => patchStep(step.key, { team_role: event.target.value })}><option value="">请选择</option>{definition.roles.filter(role => role.kind === 'team').map(role => <option value={role.key} key={role.key}>{role.label}</option>)}</select></Field><Field label="验收角色" required><select required value={step.reviewer_role} onChange={event => patchStep(step.key, { reviewer_role: event.target.value })}><option value="">请选择</option>{definition.roles.filter(role => role.kind === 'reviewer').map(role => <option value={role.key} key={role.key}>{role.label}</option>)}</select></Field></div>
      <Field label="步骤说明"><textarea rows={2} value={step.description} onChange={event => patchStep(step.key, { description: event.target.value })} /></Field>
      <Field label="验收标准" required hint="每行一条。"><textarea required rows={2} value={step.acceptance_spec.join('\n')} onChange={event => patchStep(step.key, { acceptance_spec: event.target.value.split('\n') })} /></Field>
      <Field label="必需材料类型" required hint="每行一种，例如 document、report。"><textarea required rows={2} value={step.required_artifact_kinds.join('\n')} onChange={event => patchStep(step.key, { required_artifact_kinds: event.target.value.split('\n') })} /></Field>
    </section>)}
    <footer className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button className="button button-primary" disabled={busy}>{busy ? '正在保存…' : '保存草稿'}</button></footer>
  </form></Dialog>;
}
