import { stdin, stdout } from 'node:process';

const mode = process.argv[2];
let source = '';
for await (const chunk of stdin) source += chunk;
const request = JSON.parse(source);
if (mode === 'timeout') { setTimeout(() => {}, 5000); }
else if (mode === 'bad-json') stdout.write('not-json\n');
else {
  const description = { protocol: 'agent-team-hub-adapter', protocol_version: mode === 'bad-version' ? 2 : 1,
    name: 'test-board', kind: 'board', version: '1.0.0', available: !process.env.TEAMHUB_TOKEN,
    capabilities: { item_link: true, pipeline_sync: true, detach_pipeline: false } };
  stdout.write(JSON.stringify({ jsonrpc: '2.0', id: mode === 'wrong-id' ? 'other' : request.id, result: description }) + '\n');
}
