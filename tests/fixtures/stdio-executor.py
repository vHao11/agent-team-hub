"""只用于协议测试的模拟执行器，不启动模型或外部任务。"""
import json
import os
from pathlib import Path
import sys

state_path, name, mode = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
request = json.loads(sys.stdin.buffer.readline().decode('utf-8'))
method, params = request['method'], request['params']
state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {'runs': {}, 'starts': 0}
if method == 'adapter.describe':
    result = {'protocol': 'agent-team-hub-adapter', 'protocol_version': 1, 'name': name, 'kind': 'executor',
              'version': '1.0.0', 'available': 'TEAMHUB_TOKEN' not in os.environ,
              'capabilities': {'start': True, 'status': True, 'cancel': True, 'recover': True}}
elif method == 'execution.start':
    dispatch = params['dispatch_id']
    if dispatch not in state['runs']:
        state['starts'] += 1
        state['runs'][dispatch] = {'run_id': 'host-' + dispatch, 'status': 'queued', 'input_snapshot': params['input_snapshot']}
        state_path.write_text(json.dumps(state), encoding='utf-8')
        if mode == 'lose-first-response':
            sys.exit(1)
    result = {'run_id': state['runs'][dispatch]['run_id'], 'status': 'queued'}
elif method == 'execution.find':
    run = state['runs'].get(params['dispatch_id'])
    result = {'run_id': run['run_id']} if run else None
elif method in ('execution.status', 'execution.cancel'):
    run = next(value for value in state['runs'].values() if value['run_id'] == params['handle']['run_id'])
    if method == 'execution.status':
        result = {'status': run['status'], 'summary': '模拟执行器状态'}
    else:
        run['cancel_requested'] = True
        state_path.write_text(json.dumps(state), encoding='utf-8')
        result = {'requested': True, 'confirmed': False}
else:
    sys.exit(1)
print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}))
