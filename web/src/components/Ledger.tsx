import { useEffect, useState } from 'react';
import { ArrowRight, Clock3, Plus, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useApi, useDebounced } from '../hooks';
import type { Bootstrap, ItemList, Page, View, WorkItem } from '../types';
import { Avatar, date, EmptyState, ErrorBanner, Loading, PageHeader, priorityLabels, StatusBadge, statusLabels } from './ui';

const tabs: { view: View; name: string }[] = [{ view: 'all', name: '全部事项' }, { view: 'mine', name: '我负责的' }, { view: 'requested', name: '我发起的' }, { view: 'review', name: '待我验收' }];
export function Ledger({ page, bootstrap, revision, onSelect, onCreate }: { page: Page; bootstrap: Bootstrap; revision: number; onSelect: (id: string) => void; onCreate: () => void }) {
  const [view, setView] = useState<View>(page === 'mine' ? 'mine' : page === 'inbox' ? 'inbox' : 'all');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [team, setTeam] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(query);
  useEffect(() => { setView(page === 'mine' ? 'mine' : page === 'inbox' ? 'inbox' : 'all'); setOffset(0); }, [page]);
  useEffect(() => setOffset(0), [q, status, team, view]);
  const params = new URLSearchParams({ view, limit: '20', offset: String(offset), ...(q ? { q } : {}), ...(status ? { status } : {}), ...(team ? { team_id: team } : {}) });
  const { data, loading, error, refresh } = useApi<ItemList>(`/work-items?${params}`, revision);
  const summary = useApi<ItemList>('/work-items?view=all&limit=200&offset=0', revision);
  const items = summary.data?.items || [];
  const title = page === 'mine' ? '我的工作' : page === 'inbox' ? '团队收件箱' : '跨组台账';
  const subtitle = page === 'mine' ? '把握手头的事项，推进每一次交付。' : page === 'inbox' ? '查看发给团队的协作请求，明确责任与下一步。' : '让责任、进展和交付清楚可见。';
  const teamName = (id: string) => bootstrap.teams.find(entry => entry.id === id)?.name || id;
  const userName = (id: string | null) => bootstrap.users.find(entry => entry.id === id)?.name || '待分配';
  function renderItem(item: WorkItem) {
    const overdue = item.due_at && new Date(item.due_at).getTime() < Date.now() && !['done', 'cancelled'].includes(item.status);
    return <tr key={item.id} onClick={() => onSelect(item.id)}>
      <td className="item-title-cell"><button className="item-title" onClick={event => { event.stopPropagation(); onSelect(item.id); }}>{item.title}</button><div className="item-meta"><span>{item.number}</span>{item.priority !== 'normal' && <span className={`priority priority-${item.priority}`}>{priorityLabels[item.priority]}</span>}{item.blocked_reason && <span className="blocked-inline"><ShieldAlert size={12} />存在阻塞</span>}</div></td>
      <td><StatusBadge status={item.status} /></td>
      <td><span className="team-cell">{teamName(item.owner_team_id)}</span>{item.pending_target_team_id && <span className="pending-team"><ArrowRight size={11} />{teamName(item.pending_target_team_id)}待接收</span>}</td>
      <td><span className="assignee">{item.assignee_id ? <Avatar name={userName(item.assignee_id)} small /> : <span className="avatar avatar-small avatar-unassigned">—</span>}{userName(item.assignee_id)}</span></td>
      <td><span className={overdue ? 'overdue' : 'date-text'}>{overdue && <Clock3 size={12} />}{date(item.due_at)}</span></td>
      <td className="muted date-text">{date(item.updated_at, true)}</td>
    </tr>;
  }
  return <div className="page ledger-page"><PageHeader title={title} subtitle={subtitle} action={<button className="button button-primary" onClick={onCreate}><Plus size={18} />发起事项</button>} />
    <section className="stats-strip" aria-label="工作空间概览"><div><span>全部事项</span><strong>{summary.loading ? '—' : summary.data?.total ?? '—'}</strong></div><div><span>处理中</span><strong>{summary.data ? items.filter(item => item.status === 'active').length : '—'}</strong></div><div><span>待验收</span><strong>{summary.data ? items.filter(item => item.status === 'review').length : '—'}</strong></div><div><span>存在阻塞</span><strong className={items.some(item => item.blocked_reason) ? 'stat-warning' : ''}>{summary.data ? items.filter(item => item.blocked_reason && !['done', 'cancelled'].includes(item.status)).length : '—'}</strong></div></section>
    {summary.data && summary.data.total > summary.data.items.length && <p className="field-hint">状态概览基于最近 {summary.data.items.length} 条事项。</p>}
    {page !== 'inbox' && <div className="tabs" role="tablist" aria-label="事项视图">{tabs.map(tab => <button key={tab.view} role="tab" aria-selected={view === tab.view} className={view === tab.view ? 'tab-active' : ''} onClick={() => setView(tab.view)}>{tab.name}</button>)}</div>}
    {page === 'inbox' && <div className="inbox-explainer"><InboxIcon /><span>接单前，事项仍由发起团队负责。接收后，责任转入你的团队。</span></div>}
    <div className="table-toolbar"><label className="search-input"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事项编号、标题…" aria-label="搜索事项" /></label><select aria-label="筛选事项状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="筛选负责团队" value={team} onChange={event => setTeam(event.target.value)}><option value="">全部团队</option>{bootstrap.teams.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select><button className="button refresh-button" onClick={() => { refresh(); summary.refresh(); }} aria-label="刷新事项"><RefreshCw size={16} className={loading ? 'spin' : ''} /><span>刷新</span></button></div>
    <ErrorBanner error={error} onRetry={refresh} />
    <div className="ledger-table-wrap">{loading ? <Loading label="正在读取协作台账…" /> : data?.items.length ? <table className="ledger-table"><thead><tr><th>事项</th><th>状态</th><th>负责团队</th><th>负责人</th><th>约定交付</th><th>最近更新</th></tr></thead><tbody>{data.items.map(renderItem)}</tbody></table> : !error && <EmptyState title={query || status || team ? '没有找到匹配事项' : page === 'inbox' ? '团队收件箱已清空' : '当前没有事项'} text={query || status || team ? '调整搜索关键词或筛选条件后再试。' : page === 'inbox' ? '新的协作请求会出现在这里。' : '发起一个协作事项，写清目标、责任团队和验收标准。'} action={query || status || team ? <button className="button" onClick={() => { setQuery(''); setStatus(''); setTeam(''); }}>清除筛选</button> : <button className="button" onClick={onCreate}><Plus size={16} />发起事项</button>} />}</div>
    {data && !loading && <footer className="table-footer"><span>{data.total ? `显示 ${offset + 1}–${Math.min(offset + data.items.length, data.total)} 项，共 ${data.total} 项` : '共 0 项'}</span>{data.total > 20 && <div className="pagination"><button className="button button-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><button className="button button-small" disabled={offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>下一页</button></div>}<span className="table-hint">点击事项查看进展与交付</span></footer>}
  </div>;
}
function InboxIcon() { return <ArrowRight size={16} />; }
