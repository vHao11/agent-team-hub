"""跨语言看板适配器示例：将 Hub 关联保存在用户指定的本机 JSON 文件。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import uuid


def main():
    if len(sys.argv) != 3:
        raise ValueError('需要状态文件和适配器名称')
    target, name = Path(sys.argv[1]).resolve(), sys.argv[2]
    request = json.loads(sys.stdin.buffer.readline(2 * 1024 * 1024 + 1).decode('utf-8'))
    if request.get('jsonrpc') != '2.0' or not isinstance(request.get('id'), str):
        raise ValueError('无效请求')
    method, args = request.get('method'), request.get('params', {})
    if method == 'adapter.describe':
        result = {'protocol': 'agent-team-hub-adapter', 'protocol_version': 1, 'name': name,
                  'kind': 'board', 'version': '1.0.0', 'available': True,
                  'capabilities': {'item_link': True, 'pipeline_sync': True, 'detach_pipeline': True}}
    else:
        if not target.parent.is_dir():
            raise ValueError('状态目录不存在')
        lock = target.with_name(target.name + '.lock')
        # 锁冲突时拒绝操作；不猜测已有锁是否过期。
        with lock.open('x', encoding='utf-8') as stream:
            stream.write(str(os.getpid()))
        try:
            if target.exists():
                state = json.loads(target.read_text(encoding='utf-8'))
                if state.get('schema_version') != 1 or not isinstance(state.get('cards'), list):
                    raise ValueError('无效的看板数据')
            else:
                state = {'schema_version': 1, 'cards': []}
            if method == 'board.upsert':
                external = args.get('external_ref')
                item = args.get('item') or {}
                snapshot = args.get('snapshot')
                preferred = args.get('preferred_local_todo_id')
                if not isinstance(external, str) or not external or not isinstance(item.get('id'), str):
                    raise ValueError('缺少稳定外部键或事项 ID')
                matches = [card for card in state['cards'] if card.get('hub', {}).get('externalRef') == external]
                if len(matches) > 1:
                    raise ValueError('外部键重复')
                card = matches[0] if matches else None
                if preferred:
                    selected = next((c for c in state['cards'] if c.get('id') == preferred), None)
                    if not selected or (card and card['id'] != selected['id']) or (selected.get('hub') and selected['hub'].get('externalRef') != external):
                        raise ValueError('指定卡片不存在或已绑定其他事项')
                    card = selected
                created = card is None
                if created:
                    card = {'id': 'local-' + uuid.uuid4().hex, 'title': item.get('title', ''), 'notes': ''}
                    state['cards'].append(card)
                previous = card.get('hub') or {}
                if snapshot:
                    if snapshot.get('externalRef') != external or snapshot.get('itemId') != item['id']:
                        raise ValueError('快照身份不匹配')
                    if previous and any(snapshot.get(k, 0) < previous.get(k, 0) for k in ('generation', 'pipelineVersion', 'itemVersion')):
                        raise ValueError('快照版本过旧')
                    card['hub'] = snapshot
                else:
                    card['hub'] = {'externalRef': external, 'itemId': item['id'], 'title': item.get('title', ''),
                                   'status': item.get('status'), 'itemVersion': item.get('version')}
                result = {'local_todo_id': card['id'], 'created': created}
            elif method == 'board.detach_pipeline':
                pipeline, prefix = args.get('pipeline_id'), str(args.get('hub_base', '')) + ':'
                if not pipeline or prefix == ':':
                    raise ValueError('缺少流程或 Hub 地址')
                detached = 0
                for card in state['cards']:
                    hub = card.get('hub') or {}
                    if hub.get('pipelineId') == pipeline and str(hub.get('externalRef', '')).startswith(prefix):
                        del card['hub']
                        detached += 1
                result = {'detached': detached}
            else:
                raise ValueError('不支持的方法')
            temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
            try:
                with temporary.open('x', encoding='utf-8', newline='\n') as stream:
                    json.dump(state, stream, ensure_ascii=False, indent=2)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
            finally:
                if temporary.exists():
                    temporary.unlink()
        finally:
            lock.unlink()
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # 不在 stdout 或错误结果中输出本机路径与内容。
        sys.exit(1)
