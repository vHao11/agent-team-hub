import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { write } from '../api';
import type { Bootstrap, WorkItem } from '../types';
import { Dialog, ErrorBanner, Field } from './ui';

export function CreateItem({ bootstrap, onClose, onCreated }: { bootstrap: Bootstrap; onClose: () => void; onCreated: (item: WorkItem) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState(bootstrap.teams.find(team => team.id !== bootstrap.me.team_id)?.id || bootstrap.me.team_id);
  const [project, setProject] = useState(bootstrap.projects[0]?.id || '');
  const [reviewer, setReviewer] = useState(bootstrap.me.id);
  const [priority, setPriority] = useState('normal');
  const [due, setDue] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null); setBusy(true);
    try {
      const item = await write<WorkItem>('/work-items', { title: title.trim(), description: description.trim(), target_team_id: target, project_id: project, reviewer_id: reviewer, priority, due_at: due ? new Date(`${due}T18:00:00`).toISOString() : null, acceptance_spec: acceptance.split('\n').map(value => value.trim()).filter(Boolean) });
      onCreated(item);
    } catch (reason) { setError(reason); } finally { setBusy(false); }
  }
  return <Dialog title="发起协作事项" subtitle="先约定目标与验收标准，再开始协作。" onClose={onClose} wide><form onSubmit={submit} className="modal-form"><ErrorBanner error={error} /><Field label="事项标题" required><input required maxLength={200} placeholder="例如：清算回报字段兼容改造" value={title} onChange={event => setTitle(event.target.value)} autoFocus /></Field><Field label="背景与目标"><textarea rows={3} placeholder="描述协作背景、期望结果与必要上下文…" value={description} onChange={event => setDescription(event.target.value)} /></Field><div className="form-grid"><Field label="协作项目" required><select value={project} required onChange={event => setProject(event.target.value)}>{bootstrap.projects.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field><Field label="接收团队" required><select value={target} required onChange={event => setTarget(event.target.value)}>{bootstrap.teams.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field><Field label="验收人" required><select value={reviewer} required onChange={event => setReviewer(event.target.value)}>{bootstrap.users.map(value => <option key={value.id} value={value.id}>{value.name} · {bootstrap.teams.find(team => team.id === value.team_id)?.name}</option>)}</select></Field><Field label="约定交付日期"><input type="date" value={due} onChange={event => setDue(event.target.value)} /></Field><Field label="优先级"><select value={priority} onChange={event => setPriority(event.target.value)}><option value="normal">普通</option><option value="high">较高</option><option value="urgent">紧急</option></select></Field></div><Field label="验收标准" required hint="每行一条。后续交付和验收将对应这一版本的标准。"><textarea required rows={3} placeholder={'接口字段与最新协议一致\n通过双方确认的联调用例'} value={acceptance} onChange={event => setAcceptance(event.target.value)} /></Field><div className="info-note"><ArrowRight size={16} />对方接单前，事项由你的团队负责。</div><footer className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button className="button button-primary" disabled={busy || !title.trim() || !acceptance.trim()}>{busy && <LoaderCircle className="spin" size={16} />}{busy ? '正在发起…' : '发起事项'}</button></footer></form></Dialog>;
}
