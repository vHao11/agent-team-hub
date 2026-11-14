/**
 * Wiring template, not a built-in DSH/Superagent implementation.
 * Call from your extension after adapting its documented public API to these ports.
 * Do not pass guessed ctx.todoBoard/ctx.superagent properties.
 */
export function registerKnownHost(registry, { boardPort, executionPort, version }) {
  const cleanup = [];
  if (boardPort) cleanup.push(registry.registerBoard('my-dsh-board', {
    async probe() {
      const available = typeof boardPort.upsertByExternalRef === 'function';
      return { available, version, reason: available ? undefined : 'Host has no stable card upsert API.' };
    },
    async ensureLinkedCard({ external_ref, item, workspace_ref }) {
      // Your port must persist external_ref and return a real stable card ID.
      return boardPort.upsertByExternalRef({ external_ref, title: item.title, shared_item_id: item.id, workspace_ref });
    },
  }));
  if (executionPort) cleanup.push(registry.registerExecutor('my-superagent', {
    async probe() {
      const available = ['startOnce', 'query'].every(key => typeof executionPort[key] === 'function');
      return { available, version, canCancel: typeof executionPort.cancel === 'function',
        canRecover: typeof executionPort.findDispatch === 'function', reason: available ? undefined : 'Host execution API is unavailable.' };
    },
    async start(input) {
      // startOnce must map dispatch_id to an existing session when retried inside the host.
      // Respect pinned capability_releases; reject unsupported kinds before execution.
      // Execute input_snapshot/spec_revision/assignment_generation from this registered run.
      // Do not replace them by fetching a potentially newer live work item.
      return executionPort.startOnce(input);
    },
    async getStatus(handle) { return executionPort.query(handle); },
    ...(typeof executionPort.cancel === 'function' ? { cancel: handle => executionPort.cancel(handle) } : {}),
    ...(typeof executionPort.findDispatch === 'function' ? { findByDispatchId: id => executionPort.findDispatch(id) } : {}),
  }));
  return () => cleanup.reverse().forEach(unregister => unregister());
}
