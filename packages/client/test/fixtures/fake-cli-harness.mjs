import { promises as fs } from 'node:fs';

const [marker, ...args] = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('test-harness 1.0\n'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
await fs.appendFile(marker, 'started\n');
if (process.env.FAKE_HARNESS_DELAY === '1') await new Promise(resolve => setTimeout(resolve, 20000));
if (args.includes('exec')) {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `完成：${input.includes('固定输入')}` } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ is_error: false, result: `完成：${input.includes('固定输入')}` }));
}
