import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { api, ApiError, getToken, setToken } from './api';
import { useApi } from './hooks';
import type { Bootstrap, Identity, Page, WorkflowVersion } from './types';
import { Layout } from './components/Layout';
import { Ledger } from './components/Ledger';
import { CreateItem } from './components/CreateItem';
import { ItemDetail } from './components/ItemDetail';
import { Capabilities, TeamToolsets } from './components/Capabilities';
import { Connections } from './components/Connections';
import { Loading } from './components/ui';
import { Workflows } from './components/Workflows';
import { Pipelines } from './components/Pipelines';
import './workflows.css';

function initialPage(): Page { const value = window.location.hash.slice(1); return ['ledger', 'mine', 'inbox', 'capabilities', 'toolsets', 'connections', 'workflows', 'pipelines'].includes(value) ? value as Page : 'ledger'; }
export default function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [token, setSession] = useState(getToken);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [probing, setProbing] = useState(!getToken());
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState('');
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [initialVersion, setInitialVersion] = useState<WorkflowVersion | null>(null);
  const bootstrap = useApi<Bootstrap>(token ? '/bootstrap' : null, token);
  const notify = useCallback((message: string) => setToast(message), []);
  const closeDetail = useCallback(() => setSelectedId(null), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  const changed = useCallback(() => setRevision(current => current + 1), []);
  const login = useCallback((credential: string) => { setToken(credential); setSession(credential); setSelectedId(null); setCreating(false); setRevision(current => current + 1); setConnectionError(null); }, []);
  const checkConnection = useCallback(() => { api('/health').then(() => { setConnected(true); setConnectionError(null); }).catch(reason => { setConnected(false); setConnectionError(reason); }); bootstrap.refresh(); }, [bootstrap.refresh]);
  useEffect(() => {
    let active = true;
    api<{ identities: Identity[] }>('/demo').then(result => {
      if (!active) return;
      setIdentities(result.identities);
      if (!getToken() && result.identities.length) login(result.identities[0].token);
    }).catch(reason => { if (active && !(reason instanceof ApiError && reason.status === 404)) setConnectionError(reason); }).finally(() => { if (active) setProbing(false); });
    checkConnection();
    return () => { active = false; };
  }, [login, checkConnection]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const listener = () => setPage(initialPage()); window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []);
  function navigate(next: Page) { setPage(next); window.history.replaceState(null, '', `#${next}`); }
  const auth = bootstrap.loading ? null : bootstrap.data;
  return <Layout page={auth || probing || bootstrap.loading ? page : 'connections'} navigate={navigate} bootstrap={auth} connected={connected}><>
    {probing || bootstrap.loading ? <div className="app-loading"><Loading label="正在连接工作空间…" /></div> : page === 'connections' || !auth ? <Connections bootstrap={auth} identities={identities} connected={connected} authError={bootstrap.error || connectionError} loading={bootstrap.loading} onLogin={login} onLogout={() => { login(''); navigate('connections'); notify('已退出当前身份。'); }} onRefresh={checkConnection} onWorkspaceChanged={() => { api<Bootstrap>('/bootstrap').then(bootstrap.setData).catch(setConnectionError); }} notify={notify} /> : <div key={auth.me.id}>{['ledger', 'mine', 'inbox'].includes(page) && <Ledger page={page} bootstrap={auth} revision={revision} onSelect={setSelectedId} onCreate={() => setCreating(true)} />}{page === 'capabilities' && <Capabilities bootstrap={auth} notify={notify} />}{page === 'toolsets' && <TeamToolsets bootstrap={auth} notify={notify} />}{page === 'workflows' && <Workflows bootstrap={auth} notify={notify} onCreatePipeline={version => { setInitialVersion(version); navigate('pipelines'); }} />}{page === 'pipelines' && <Pipelines bootstrap={auth} notify={notify} revision={revision} onOpenItem={setSelectedId} initialVersion={initialVersion} clearInitialVersion={() => setInitialVersion(null)} />}</div>}
    {creating && auth && <CreateItem bootstrap={auth} onClose={closeCreate} onCreated={item => { setCreating(false); setSelectedId(item.id); changed(); notify('事项已发起，等待对方团队接收。'); }} />}
    {selectedId && auth && <ItemDetail id={selectedId} bootstrap={auth} onClose={closeDetail} onChanged={changed} notify={notify} onSelect={setSelectedId} />}
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button className="icon-button" onClick={() => setToast('')} aria-label="关闭提示"><X size={16} /></button></div>}
  </></Layout>;
}
