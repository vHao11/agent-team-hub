import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

const [marker, ...args] = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('test-harness 1.0\n'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
await fs.appendFile(marker, 'started\n');
if (process.env.FAKE_HARNESS_CHILD_MARKER) {
  const script = "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'escaped'),3000)";
  spawn(process.execPath, ['-e', script, process.env.FAKE_HARNESS_CHILD_MARKER], { stdio: 'ignore', windowsHide: true });
}
if (process.env.FAKE_HARNESS_DELAY === '1') await new Promise(resolve => setTimeout(resolve, 20000));
if (args.includes('run')) {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  await fs.writeFile(marker + '.config', JSON.stringify({ ...(config.agents?.['teamhub-executor'] || {}),
    skillSources: config.skills || [], configFile: process.env.OPENCODE_CONFIG || null }));
  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: `完成：${input.includes('固定输入')}` } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }) + '\n');
} else if (args.includes('exec')) {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `完成：${input.includes('固定输入')}` } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ is_error: false, result: `完成：${input.includes('固定输入')}` }));
}
