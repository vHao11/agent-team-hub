import { Boxes, CheckSquare, ChevronDown, CircleHelp, GitBranch, Inbox, Layers3, ListTree, Menu, Settings2, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Bootstrap, Page } from '../types';
import { Avatar } from './ui';

const navigation = [
  { id: 'mine', title: '我的工作', icon: CheckSquare },
  { id: 'inbox', title: '团队收件箱', icon: Inbox },
  { id: 'ledger', title: '跨组台账', icon: Layers3 },
  { id: 'pipelines', title: '流水线任务', icon: GitBranch },
  { id: 'workflows', title: '流水线模板', icon: ListTree },
  { id: 'capabilities', title: '共享工具库', icon: Boxes },
  { id: 'toolsets', title: '团队工具集', icon: Wrench },
] as const;
export const pageTitles: Record<Page, string> = { mine: '我的工作', inbox: '团队收件箱', ledger: '跨组台账', pipelines: '流水线任务', workflows: '流水线模板', capabilities: '共享工具库', toolsets: '团队工具集', connections: '连接设置' };

export function Layout({ page, navigate, bootstrap, connected, children }: { page: Page; navigate: (page: Page) => void; bootstrap: Bootstrap | null; connected: boolean; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const go = (next: Page) => { navigate(next); setMobileOpen(false); };
  return <div className="app-shell">
    {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} aria-label="主导航">
      <a className="brand" href="#ledger" onClick={event => { event.preventDefault(); go('ledger'); }}><span className="brand-mark">TH<span /></span><span><strong>Team Hub</strong><small>研发协作空间</small></span></a>
      <button className="sidebar-close icon-button" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X size={20} /></button>
      <div className="nav-caption">工作空间</div>
      <nav>{navigation.map(({ id, title, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'nav-active' : ''}`} onClick={() => go(id)} aria-current={page === id ? 'page' : undefined}><Icon size={19} strokeWidth={1.65} />{title}{page === id && <span className="nav-indicator" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><CircleHelp size={16} /><span>协作有记录，交付有依据。</span></div><button className={`nav-item ${page === 'connections' ? 'nav-active' : ''}`} onClick={() => go('connections')}><Settings2 size={19} strokeWidth={1.65} />连接设置</button></div>
      <button className="identity-card" onClick={() => go('connections')} aria-label="管理当前身份"><Avatar name={bootstrap?.me.name || '访客'} /><span className="identity-info"><strong>{bootstrap?.me.name || '尚未登录'}</strong><small>{bootstrap?.teams.find(team => team.id === bootstrap.me.team_id)?.name || '连接工作空间'}</small></span><ChevronDown size={15} /></button>
      {bootstrap?.demo_mode && <div className="demo-sidebar-label"><span />演示环境 · 可切换身份</div>}
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={21} /></button><span>工作空间</span><span className="breadcrumb-slash">/</span><strong>{pageTitles[page]}</strong></div><span className={`service-indicator ${connected ? '' : 'service-offline'}`}><i />{connected ? '服务已连接' : '服务未连接'}</span></header><main id="main-content">{children}</main></div>
  </div>;
}
