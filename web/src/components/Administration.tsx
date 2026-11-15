import { useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Clipboard, LoaderCircle, Plus, Users } from 'lucide-react';
import { copyText, write } from '../api';
import type { Bootstrap, Team, User } from '../types';
import { ErrorBanner, Field } from './ui';

export function Administration({ bootstrap, onChanged, notify }: { bootstrap: Bootstrap; onChanged: () => void; notify: (message: string) => void }) {
  const [teamName, setTeamName] = useState('');
  const [name, setName] = useState('');
  const [team, setTeam] = useState(bootstrap.teams[0]?.id || '');
  const [role, setRole] = useState('member');
  const [pending, setPending] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ user: User; token: string } | null>(null);
  async function createTeam(event: FormEvent) {
    event.preventDefault(); setPending('team'); setError(null);
    try { const value = await write<Team>('/teams', { name: teamName.trim() }); setTeamName(''); setTeam(value.id); onChanged(); notify(`已创建团队「${value.name}」。`); }
    catch (reason) { setError(reason); } finally { setPending(''); }
  }
  async function createUser(event: FormEvent) {
    event.preventDefault(); setPending('user'); setError(null);
    try { const value = await write<{ user: User; token: string }>('/users', { name: name.trim(), team_id: team, role }); setName(''); setCreated(value); onChanged(); }
    catch (reason) { setError(reason); } finally { setPending(''); }
  }
  return <section className="settings-section"><div className="settings-section-heading"><Users size={20} /><div><h2>团队与成员</h2><p>管理员可创建团队、添加成员，并分配服务访问令牌。</p></div><span className="subtle-badge">管理员</span></div><ErrorBanner error={error} /><div className="admin-team-summary">{bootstrap.teams.map(entry => <span key={entry.id}>{entry.name}<small>{bootstrap.users.filter(user => user.team_id === entry.id).length} 人</small></span>)}</div><form onSubmit={createTeam} className="admin-team-form"><Field label="创建团队"><div className="token-input-row"><input value={teamName} onChange={event => setTeamName(event.target.value)} required maxLength={120} placeholder="例如：清算研发组" /><button className="button" disabled={!!pending || !teamName.trim()}>{pending === 'team' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}创建团队</button></div></Field></form><form onSubmit={createUser} className="admin-member-form"><div className="section-label">添加成员</div><div className="admin-member-fields"><Field label="姓名" required><input value={name} required maxLength={120} onChange={event => setName(event.target.value)} placeholder="成员姓名" /></Field><Field label="所属团队" required><select value={team} required onChange={event => setTeam(event.target.value)}>{bootstrap.teams.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field><Field label="权限角色" required><select value={role} onChange={event => setRole(event.target.value)}><option value="member">团队成员</option><option value="lead">团队负责人</option><option value="admin">管理员</option></select></Field></div><button className="button button-primary button-small" disabled={!!pending || !name.trim() || !!created}>{pending === 'user' ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}添加成员并生成令牌</button></form>{created && <div className="new-member-token"><strong>{created.user.name} 的访问令牌</strong><p>此处仅展示本次创建结果。请保存并通过可信方式交给该成员；关闭后，网页不再展示。</p><div className="endpoint-row"><code>{created.token}</code><button className="icon-button" aria-label="复制新成员访问令牌" onClick={() => void copyText(created.token).then(ok => notify(ok ? '访问令牌已复制。' : '复制未完成，请手动选中保存。'))}><Clipboard size={16} /></button></div><button className="button button-small" onClick={() => setCreated(null)}><Check size={14} />我已保存，关闭展示</button></div>}<details className="members-directory"><summary>查看 {bootstrap.users.length} 名现有成员</summary><div>{bootstrap.users.map(user => <div key={user.id}><strong>{user.name}</strong><span>{bootstrap.teams.find(entry => entry.id === user.team_id)?.name}</span><small>{user.role === 'admin' ? '管理员' : user.role === 'lead' ? '团队负责人' : '团队成员'}</small></div>)}</div></details></section>;
}
