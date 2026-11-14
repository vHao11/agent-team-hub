import { HubError } from './client/index.mjs';

/** 将看板的明确操作交给 Hub；Hub 继续负责身份、版本和验收校验。 */
export function createBoardActions(client, sync) {
  const checkSnapshot = snapshot => {
    if (!snapshot || snapshot.superseded || snapshot.externalRef !== `${client.base}:${snapshot.itemId}`
        || !snapshot.pipelineId || !snapshot.attemptId || !Number.isSafeInteger(snapshot.itemVersion)
        || !Number.isSafeInteger(snapshot.generation)) {
      throw new HubError('INVALID_BOARD_SNAPSHOT', '看板关联快照无效。', { status: 409 });
    }
  };
  return {
    apiVersion: 1,
    async inspect(snapshot) {
      checkSnapshot(snapshot);
      const detail = await client.getItem(snapshot.itemId);
      if (detail.item.version !== snapshot.itemVersion || !detail.pipeline_context?.current
          || detail.pipeline_context.attempt_id !== snapshot.attemptId || detail.pipeline_context.generation !== snapshot.generation) {
        throw new HubError('STALE_BOARD_SNAPSHOT', '事项已经变化，请等待看板同步后再操作。', { status: 409 });
      }
      return { item: detail.item, pipeline_context: detail.pipeline_context, allowed_actions: detail.allowed_actions,
        deliveries: detail.deliveries };
    },
    async execute(snapshot, input) {
      checkSnapshot(snapshot);
      if (!input || typeof input.operation_id !== 'string' || input.operation_id.length < 4 || input.operation_id.length > 200) {
        throw new HubError('INVALID_OPERATION', '缺少有效的操作 ID。', { status: 400 });
      }
      const common = { operation_id: input.operation_id, expected_version: snapshot.itemVersion,
        pipeline_attempt_id: snapshot.attemptId, pipeline_generation: snapshot.generation };
      let result;
      switch (input.action) {
        case 'accept':
        case 'start':
          result = await client.command(snapshot.itemId, input.action, common); break;
        case 'decline':
          result = await client.command(snapshot.itemId, 'decline', { ...common, reason: input.reason }); break;
        case 'progress':
          result = await client.command(snapshot.itemId, 'progress', { ...common, summary: input.summary }); break;
        case 'submit':
          if (!Number.isSafeInteger(snapshot.specRevision)) throw new HubError('STALE_BOARD_SNAPSHOT', '请先同步最新的交付要求。', { status: 409 });
          result = await client.submitDelivery(snapshot.itemId, { ...common, spec_revision: snapshot.specRevision,
            summary: input.summary, artifacts: input.artifacts }); break;
        case 'approve':
        case 'request_changes':
          if (!snapshot.currentDeliveryId) throw new HubError('STALE_BOARD_SNAPSHOT', '请先同步当前交付。', { status: 409 });
          result = await client.reviewDelivery(snapshot.currentDeliveryId, { ...common, decision: input.action, reason: input.reason || '' }); break;
        default:
          throw new HubError('UNKNOWN_ACTION', '不支持此看板操作。', { status: 400 });
      }
      // 业务写入已成功时，同步失败只能提示，不能把操作伪装成失败后自动重试。
      const synchronization = await sync.syncAll().then(results => results.every(value => value.synced) ? 'synced' : 'pending', () => 'pending');
      return { result, synchronization };
    },
  };
}
