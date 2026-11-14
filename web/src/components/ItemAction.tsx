import { useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, LoaderCircle, Plus, Upload, X } from 'lucide-react';
import { api, ApiError, write } from '../api';
import type { Artifact, Bootstrap, ItemDetail, Run } from '../types';
import { Dialog, ErrorBanner, Field } from './ui';

export type ActionName = 'accept' | 'decline' | 'start' | 'cancel' | 'transfer-requests' | 'accept-transfer' | 'progress' | 'deliveries' | 'approve' | 'request_changes' | 'spec' | 'dependencies' | 'bindings' | 'runs' | 'run-event' | 'run-cancel';
const titles: Record<ActionName, string> = { accept: '接收协作事项', decline: '退回协作请求', start: '开始处理', cancel: '取消事项', 'transfer-requests': '发起团队转交', 'accept-transfer': '接收转交', progress: '记录进展', deliveries: '提交交付', approve: '验收通过', request_changes: '要求修改', spec: '更新验收标准', dependencies: '添加依赖事项', bindings: '关联本地待办', runs: '登记外部执行', 'run-event': '回报执行状态', 'run-cancel': '请求取消执行' };
const terminalRuns = ['succeeded', 'failed', 'cancelled'];
export function ItemAction({ action, detail, bootstrap, run, onClose, onSaved, onConflict }: { action: ActionName; detail: ItemDetail; bootstrap: Bootstrap; run?: Run; onClose: () => void; onSaved: (message: string) => void; onConflict: () => void }) {
  const { item } = detail;
  const [summary, setSummary] = useState('');
  const [reason, setReason] = useState('');
  const [assignee, setAssignee] = useState(() => {
    const eligible = bootstrap.users.filter(user => user.team_id === bootstrap.me.team_id && (!detail.pipeline_context || user.id !== item.reviewer_id));
    return eligible.find(user => user.id === detail.pipeline_context?.requested_assignee_id)?.id ||
      eligible.find(user => user.id === bootstrap.me.id)?.id || eligible[0]?.id || '';
  });
  const [target, setTarget] = useState(bootstrap.teams.find(team => team.id !== item.owner_team_id)?.id || '');
  const [blocked, setBlocked] = useState(item.blocked_reason || '');
  const [waiting, setWaiting] = useState(item.waiting_on || '');
  const [nextAction, setNextAction] = useState(item.next_action || '');
  const [acceptance, setAcceptance] = useState(item.acceptance_spec.join('\n'));
  const [description, setDescription] = useState(item.description);
  const [dependency, setDependency] = useState('');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactLabel, setArtifactLabel] = useState('');
  const [artifactUrl, setArtifactUrl] = useState('');
  const [artifactKind, setArtifactKind] = useState(detail.pipeline_context?.required_artifact_kinds[0] || 'document');
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [harness, setHarness] = useState('dsh');
  const [client, setClient] = useState(run?.client_instance_id || '');
  const [workspace, setWorkspace] = useState('');
  const [todo, setTodo] = useState('');
  const [session, setSession] = useState(run?.external_session_id || '');
  const [runState, setRunState] = useState('running');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reasonActions = ['decline', 'cancel', 'transfer-requests', 'request_changes', 'spec'];
  async function upload(file: File) {
    setUploading(true); setError(null);
    try { const form = new FormData(); form.set('file', file); const artifact = await api<Artifact>('/artifacts', { method: 'POST', body: form }); setArtifacts(current => [...current, { ...artifact, kind: artifactKind }]); }
    catch (error) { setError(error); } finally { setUploading(false); }
  }
  function addLink() {
    try {
      const url = new URL(artifactUrl);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('请使用 HTTP 或 HTTPS 链接，或直接上传附件。');
      if (!artifactLabel.trim()) throw new Error('请填写交付物名称。');
      setArtifacts(current => [...current, { label: artifactLabel.trim(), url: url.href, kind: detail.pipeline_context ? artifactKind : 'link' }]); setArtifactLabel(''); setArtifactUrl(''); setError(null);
    } catch (reason) { setError(reason instanceof TypeError ? new Error('请输入有效的交付物链接。') : reason); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null); setBusy(true);
    let path = `/work-items/${item.id}/${action}`;
    const body: Record<string, unknown> = { expected_version: item.version };
    if (detail.pipeline_context && !['run-event', 'run-cancel'].includes(action)) Object.assign(body, {
      pipeline_attempt_id: detail.pipeline_context.attempt_id, pipeline_generation: detail.pipeline_context.generation,
    });
    if (['accept', 'accept-transfer'].includes(action)) body.assignee_id = assignee;
    if (reasonActions.includes(action)) body.reason = reason.trim();
    if (action === 'transfer-requests') body.target_team_id = target;
    if (action === 'progress') Object.assign(body, { summary: summary.trim(), blocked_reason: blocked.trim() || null, waiting_on: waiting.trim() || null, next_action: nextAction.trim() || null });
    if (action === 'deliveries') Object.assign(body, { summary: summary.trim(), spec_revision: item.spec_revision, artifacts: artifacts.map(({ label, url, kind }) => ({ label, url, kind: kind || 'document' })), run_ids: selectedRuns });
    if (action === 'approve' || action === 'request_changes') { path = `/deliveries/${item.current_delivery_id}/reviews`; body.decision = action; body.reason = reason.trim() || undefined; }
    if (action === 'spec') Object.assign(body, { description, acceptance_spec: acceptance.split('\n').map(line => line.trim()).filter(Boolean) });
    if (action === 'dependencies') body.depends_on_id = dependency.trim();
    if (action === 'bindings' || action === 'runs') {
      Object.assign(body, { harness, client_instance_id: client.trim(), workspace_ref: workspace.trim() });
      if (action === 'bindings') { delete body.expected_version; body.local_todo_id = todo.trim() || undefined; body.session_id = session.trim() || undefined; }
      else body.external_session_id = session.trim() || undefined;
    }
    if (action === 'run-event' && run) { path = `/runs/${run.id}/events`; delete body.expected_version; Object.assign(body, { client_instance_id: run.client_instance_id, sequence: run.sequence + 1, status: runState, summary: summary.trim() || undefined, external_session_id: session.trim() || undefined }); }
    if (action === 'run-cancel' && run) { path = `/runs/${run.id}/cancel`; delete body.expected_version; }
    try { await write(path, body); onSaved(action === 'runs' ? '已登记执行记录，请在对应 harness 中启动任务。' : `${titles[action]}成功`); }
    catch (reason) { setError(reason); if (reason instanceof ApiError && reason.status === 409) onConflict(); }
    finally { setBusy(false); }
  }
  return <Dialog title={titles[action]} subtitle={`${item.number} · ${item.title}`} onClose={onClose} wide={['deliveries', 'spec', 'runs', 'bindings'].includes(action)}><form className="modal-form" onSubmit={submit}><ErrorBanner error={error} />
    {['accept', 'accept-transfer'].includes(action) && <><div className="info-note">接收后，你的团队将负责推进该事项。{detail.pipeline_context && '流水线步骤的处理人与验收人必须使用不同账号。'}</div><Field label="指定负责人" required><select value={assignee} onChange={event => setAssignee(event.target.value)}>{bootstrap.users.filter(user => user.team_id === bootstrap.me.team_id && (!detail.pipeline_context || user.id !== item.reviewer_id)).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field></>}
    {action === 'start' && <p className="dialog-copy">将事项标记为处理中。依赖事项需先完成；此操作不启动任何 agent。</p>}
    {action === 'cancel' && <div className="warning-note"><AlertCircle size={17} />取消后事项将结束。取消请求不代表宿主执行已停止，仍需执行端确认。</div>}
    {action === 'transfer-requests' && <><Field label="接收团队" required><select value={target} onChange={event => setTarget(event.target.value)}>{bootstrap.teams.filter(team => team.id !== item.owner_team_id).map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></Field><p className="field-hint">对方接收前，责任仍在当前负责团队。</p></>}
    {['progress', 'deliveries'].includes(action) && <Field label={action === 'progress' ? '进展说明' : '交付说明'} required><textarea rows={3} required value={summary} onChange={event => setSummary(event.target.value)} placeholder={action === 'progress' ? '本次完成了什么，还有哪些问题？' : '本次交付对应哪些验收标准？'} /></Field>}
    {action === 'progress' && <><Field label="阻塞原因" hint="留空表示当前无阻塞。"><input value={blocked} onChange={event => setBlocked(event.target.value)} placeholder="例如：等待对方确认协议版本" /></Field><Field label="等待谁 / 什么"><input value={waiting} onChange={event => setWaiting(event.target.value)} placeholder="例如：清算研发组的字段说明" /></Field><Field label="下一步"><input value={nextAction} onChange={event => setNextAction(event.target.value)} placeholder="明确下一次推进动作" /></Field></>}
    {action === 'deliveries' && <><div className="section-label">交付物 <span className="required">*</span><small>至少一项链接或附件</small></div><div className="artifact-builder">{detail.pipeline_context && <Field label="本次添加的材料类型" required hint={`本步骤要求：${detail.pipeline_context.required_artifact_kinds.join('、')}；每种类型至少添加一份。`}><select value={artifactKind} onChange={event => setArtifactKind(event.target.value)}>{detail.pipeline_context.required_artifact_kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></Field>}<div className="form-grid"><Field label="名称"><input value={artifactLabel} onChange={event => setArtifactLabel(event.target.value)} placeholder="例如：接口变更说明" /></Field><Field label="链接"><input type="url" value={artifactUrl} onChange={event => setArtifactUrl(event.target.value)} placeholder="https://…" /></Field></div><div className="artifact-actions"><button type="button" className="button button-small" onClick={addLink} disabled={!artifactLabel || !artifactUrl}><Plus size={14} />添加链接</button><label className={`button button-small upload-button ${uploading ? 'disabled' : ''}`}><Upload size={14} />{uploading ? '正在上传…' : '上传附件'}<input type="file" disabled={uploading} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} /></label></div>{artifacts.map((artifact, index) => <div className="artifact-row" key={`${artifact.url}-${index}`}><span>{artifact.label}{detail.pipeline_context ? ` · ${artifact.kind}` : ''}</span><small>{artifact.url.startsWith('artifact:') ? '已上传附件' : artifact.url}</small><button type="button" className="icon-button" onClick={() => setArtifacts(current => current.filter((_, i) => i !== index))} aria-label={`移除${artifact.label}`}><X size={15} /></button></div>)}</div>{detail.runs.length > 0 && <fieldset className="checkbox-fieldset"><legend>关联执行记录（可选）</legend>{detail.runs.map(entry => <label className="checkbox-label" key={entry.id}><input type="checkbox" checked={selectedRuns.includes(entry.id)} onChange={event => setSelectedRuns(current => event.target.checked ? [...current, entry.id] : current.filter(id => id !== entry.id))} /><span>{entry.harness} · {entry.id.slice(0, 12)} · {entry.status}</span></label>)}</fieldset>}<div className="info-note">提交后进入待验收，验收标准版本 v{item.spec_revision}。只有验收人通过后，事项才会完成。</div></>}
    {action === 'approve' && <><div className="info-note">请确认最新交付已满足 v{item.spec_revision} 的全部验收标准。</div><ul className="acceptance-list">{item.acceptance_spec.map((line, index) => <li key={index}>{line}</li>)}</ul><Field label="验收说明（可选）"><textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="记录本次验收结论…" /></Field></>}
    {action === 'spec' && <><div className="warning-note"><AlertCircle size={17} />变更将生成新的标准版本。待验收事项会回到处理中，需要重新交付。</div><Field label="背景与目标"><textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></Field><Field label="验收标准" required hint="每行一条。"><textarea rows={4} required value={acceptance} onChange={event => setAcceptance(event.target.value)} /></Field></>}
    {reasonActions.includes(action) && <Field label={action === 'request_changes' ? '需要修改的内容' : '原因说明'} required><textarea rows={3} required value={reason} onChange={event => setReason(event.target.value)} placeholder="写清原因，便于协作方继续推进…" /></Field>}
    {action === 'dependencies' && <Field label="依赖事项 ID" required hint="使用事项详情中的完整 ID，系统会检查循环依赖。"><input required value={dependency} onChange={event => setDependency(event.target.value)} placeholder="wi-…" /></Field>}
    {['bindings', 'runs'].includes(action) && <><div className="warning-note"><AlertCircle size={17} /><span>{action === 'runs' ? '这里只登记外部执行，不会自动调用 DSH 或 Superagent。请在对应宿主中启动，再回报执行状态。' : '填写已经存在的本地待办信息。原生 DSH 桥接尚未连接，此关联不会自动创建本地待办。'}</span></div><div className="form-grid"><Field label="Harness" required><select value={harness} onChange={event => setHarness(event.target.value)}><option value="dsh">DSH / Superagent</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="other">其他 harness</option></select></Field><Field label="客户端实例 ID" required hint="使用执行端配置的稳定实例标识。"><input required value={client} onChange={event => setClient(event.target.value)} placeholder="例如：dsh-lin-desktop" /></Field></div><Field label="工作区引用" required><input required value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="例如：D:\\projects\\trading-api" /></Field>{action === 'bindings' && <Field label="本地待办 ID"><input value={todo} onChange={event => setTodo(event.target.value)} placeholder="对应宿主中的待办标识" /></Field>}<Field label="外部会话 ID（可选）"><input value={session} onChange={event => setSession(event.target.value)} /></Field></>}
    {action === 'run-event' && run && <><div className="info-note">执行成功仅表示本次运行结束。事项仍需提交交付物并通过人工验收。</div><Field label="执行状态" required><select value={runState} onChange={event => setRunState(event.target.value)}><option value="running">运行中</option><option value="waiting_input">等待输入</option><option value="succeeded">执行成功</option><option value="failed">执行失败</option><option value="cancelled">已确认取消</option><option value="unknown">状态未知</option></select></Field><Field label="结果或进展摘要"><textarea rows={3} value={summary} onChange={event => setSummary(event.target.value)} /></Field><Field label="外部会话 ID"><input value={session} onChange={event => setSession(event.target.value)} /></Field><p className="field-hint">客户端 {run.client_instance_id} · 下一事件序号 {run.sequence + 1}</p></>}
    {action === 'run-cancel' && <div className="warning-note"><AlertCircle size={17} />这会记录取消请求，不代表宿主已停止。需要执行端回报确认取消。</div>}
    <footer className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>返回</button><button type="submit" className={`button ${action === 'cancel' ? 'button-danger' : 'button-primary'}`} disabled={busy || uploading || (['accept', 'accept-transfer'].includes(action) && !assignee) || (action === 'deliveries' && artifacts.length === 0) || (action === 'run-event' && !!run && terminalRuns.includes(run.status))}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? '正在保存…' : titles[action]}</button></footer>
  </form></Dialog>;
}
