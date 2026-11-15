window.__ModuleLoader__.load({ id: 'dsh-team-hub-web', factory: (require) => {
  const React = require('react');
  const h = React.createElement;
  const panelId = 'team-hub-web';

  const styles = {
    container: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: '#f8fafc' },
    frame: { display: 'block', flex: '1 1 auto', width: '100%', minHeight: 0, border: 0, background: '#fff' },
    notice: { margin: 0, padding: '10px 16px', color: '#854d0e', background: '#fef9c3', fontSize: 13, lineHeight: 1.5 },
    state: { display: 'flex', flex: '1 1 auto', alignItems: 'center', justifyContent: 'center', padding: 24, color: '#334155', textAlign: 'center', fontSize: 14 },
    title: { margin: '0 0 8px', fontSize: 17, color: '#0f172a' },
    description: { maxWidth: 480, margin: '0 0 16px', lineHeight: 1.6 },
    button: { padding: '8px 16px', border: 0, borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer' },
  };

  function loopback(host) {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
  }

  function Panel() {
    const [revision, setRevision] = React.useState(0);
    const [state, setState] = React.useState({ loading: true });
    React.useEffect(() => {
      const controller = new AbortController();
      setState({ loading: true });
      fetch('/team-hub-web/status', { credentials: 'same-origin', signal: controller.signal })
        .then(response => {
          if (!response.ok) throw new Error('status request failed');
          return response.json();
        })
        .then(result => {
          if (!controller.signal.aborted) setState(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ available: false, reason: 'status_failed' });
        });
      return () => controller.abort();
    }, [revision]);

    if (state.loading) return h('div', { style: styles.state, role: 'status' }, '正在连接 Agent Team Hub…');
    if (!state.available) {
      const message = state.reason === 'invalid_url'
        ? 'Hub 页面地址无效，请检查插件的 serverUrl 和 webUrl 配置。'
        : state.reason === 'status_failed'
          ? '无法读取 DSH 插件状态，请确认插件已加载并刷新 DSH。'
          : '无法连接 Hub 服务，请先启动服务并检查插件的 serverUrl 配置。';
      return h('div', { style: styles.state }, h('div', null,
        h('h2', { style: styles.title }, '暂时无法打开工作空间'),
        h('p', { style: styles.description }, message),
        h('button', { type: 'button', style: styles.button, onClick: () => setRevision(value => value + 1) }, '重新连接'),
      ));
    }

    let target;
    try {
      target = new URL(state.url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.origin === window.location.origin) throw new Error('invalid target');
    } catch {
      return h('div', { style: styles.state }, 'Hub 页面地址无效，请检查插件配置。');
    }
    const remoteLoopback = !loopback(window.location.hostname) && loopback(target.hostname);
    const mixedContent = window.location.protocol === 'https:' && target.protocol === 'http:' && !loopback(target.hostname);
    const notice = remoteLoopback
      ? '当前页面地址指向本机；如果你正在远程访问 DSH，请将插件 webUrl 设置为此设备可以访问的 Hub 地址。'
      : mixedContent ? 'HTTPS 页面可能阻止嵌入 HTTP 的 Hub，请将插件 webUrl 设置为 HTTPS 地址。' : '';
    return h('div', { style: styles.container },
      notice ? h('p', { style: styles.notice, role: 'status' }, notice) : null,
      h('iframe', {
        title: 'Agent Team Hub 工作空间', src: target.href, style: styles.frame,
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox',
        referrerPolicy: 'no-referrer',
      }),
    );
  }

  function Icon({ size = 18 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
    h('path', { d: 'M3 9h18M9 9v11M6 6.5h.01M8 6.5h.01' }));
  }

  function apply(ctx) {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, Panel));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: panelId, order: 25, label: () => '团队协作台' }, Icon));
  }
  return { inject: ['slots'], apply };
} });
