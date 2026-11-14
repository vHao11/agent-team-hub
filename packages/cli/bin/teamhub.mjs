#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HubClient, HubError, operationId, segment } from '../lib/client/index.mjs';
import { installRelease, runInstalled } from '../lib/client/installer.mjs';
import { installHarnessSkill, validateInstallTarget } from '../lib/client/harnesses.mjs';
import { clientInstanceId, defaultStateDir, listOutbox, queueOperation, replayOutbox } from '../lib/client/state.mjs';

const ARTIFACT_TYPES = Object.freeze({
  '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
  '.json': 'application/json', '.csv': 'text/csv',
  '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain',
});

const HELP = `Agent Team Hub CLI 0.1.0 (Node 22+)
Environment: TEAMHUB_URL, TEAMHUB_TOKEN, TEAMHUB_STATE_DIR
Every command prints JSON. Do not place tokens in command history.

teamhub whoami
teamhub items list [--view inbox|mine|requested|review|all] [--status active] [--q TEXT]
teamhub items get ID
teamhub items create --data @request.json
teamhub items accept|decline|start|cancel|transfer|accept-transfer|progress|spec|depend ID --version N --data @command.json
teamhub items submit ID --version N --data @delivery.json
teamhub reviews approve|changes DELIVERY_ID --version N [--data @review.json]
teamhub artifacts upload PATH
teamhub bind ITEM_ID --data @binding.json
teamhub runs register ITEM_ID --version N --data @run.json
teamhub runs get RUN_ID
teamhub runs report RUN_ID --data @event.json
teamhub runs cancel RUN_ID
teamhub tools list [--q TEXT] [--kind skill]
teamhub tools show CAPABILITY_ID [--version VERSION]
teamhub tools publish --data @capability.json
teamhub tools release CAPABILITY_ID --data @release.json
teamhub tools install CAPABILITY_ID --version VERSION --directory PATH
teamhub tools install CAPABILITY_ID --version VERSION --harness claude-code|codex|opencode --workspace PATH
teamhub tools run PATH [--timeout MILLISECONDS] -- SCRIPT_ARGS
teamhub toolsets get TEAM_ID
teamhub toolsets set TEAM_ID --version N --data @toolset.json
teamhub events [--after N]
teamhub outbox list|replay

Writes accept --operation-id UUID; reuse it on retry. --data accepts inline JSON or @file.
To queue a progress update explicitly: add --queue --actor-id USER_ID (identity must be known).
Queued updates keep the original version and never start execution. Conflicts remain queued.
Tool installation copies pinned embedded text files only; it never runs install hooks.
--harness installs Skills into the selected host's project discovery directory.
The workspace must already exist; other releases are never overwritten.
`;

function parse(values) {
  const positional = [], options = {}, tail = [];
  for (let index = 0; index < values.length; index++) {
    const token = values[index];
    if (token === '--') { tail.push(...values.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const key = token.slice(2); if (['help', 'queue'].includes(key)) options[key] = true;
    else { const value = values[++index]; if (value === undefined || value.startsWith('--')) throw new HubError('ARGUMENT_REQUIRED', `--${key} needs a value.`); options[key] = value; }
  }
  return { positional, options, tail };
}
function need(value, name) { if (value === undefined || value === '') throw new HubError('ARGUMENT_REQUIRED', `${name} is required.`); return value; }
function numeric(value, label) { const n = Number(need(value, label)); if (!Number.isInteger(n) || n < 0) throw new HubError('INVALID_ARGUMENT', `${label} must be a nonnegative integer.`); return n; }
async function main() {
  const { positional: p, options: o, tail } = parse(process.argv.slice(2));
  if (o.help || !p.length || p[0] === 'help') { process.stdout.write(HELP); return; }
  const client = new HubClient({ url: o.url || process.env.TEAMHUB_URL, token: process.env.TEAMHUB_TOKEN });
  const stateDir = o['state-dir'] || defaultStateDir();
  let data = {};
  if (o.data) data = JSON.parse((o.data.startsWith('@') ? await readFile(o.data.slice(1), 'utf8') : o.data).replace(/^\uFEFF/, ''));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new HubError('INVALID_DATA', '--data must be a JSON object.');
  const write = () => ({ ...data, operation_id: o['operation-id'] || data.operation_id || operationId() });
  const versioned = () => ({ ...write(), expected_version: numeric(o.version ?? data.expected_version, '--version') });
  const instance = async () => o.instance || data.client_instance_id || await clientInstanceId(stateDir);
  let result;
  const [group, action, id] = p;
  if (group === 'whoami') result = await client.bootstrap();
  else if (group === 'events') result = await client.events(numeric(o.after || 0, '--after'));
  else if (group === 'outbox') {
    if (action === 'list') result = await listOutbox(stateDir);
    else if (action === 'replay') result = await replayOutbox(client, stateDir);
    else throw new HubError('UNKNOWN_COMMAND', 'Use outbox list or outbox replay.');
  } else if (group === 'items') {
    if (action === 'list') result = await client.listItems({ view: o.view, status: o.status, q: o.q, team_id: o.team, limit: o.limit, offset: o.offset });
    else if (action === 'get') result = await client.getItem(need(id, 'item id'));
    else if (action === 'create') result = await client.createItem(write());
    else if (action === 'submit') result = await client.submitDelivery(need(id, 'item id'), versioned());
    else {
      const aliases = { transfer: 'transfer-requests', depend: 'dependencies' }; const command = aliases[action] || action;
      const body = versioned();
      if (o.queue) {
        if (command !== 'progress') throw new HubError('QUEUE_UNSUPPORTED', 'Only progress updates can be queued. Shared claims and starts need online confirmation.');
        result = await queueOperation({ base: client.base, actorId: need(o['actor-id'], '--actor-id'), method: 'POST', apiPath: `/work-items/${segment(need(id, 'item id'))}/progress`, body }, stateDir);
      } else result = await client.command(need(id, 'item id'), command, body);
    }
  } else if (group === 'artifacts' && action === 'upload') {
    const file = path.resolve(need(id, 'file path'));
    if ((await stat(file)).size > 20 * 1024 * 1024) throw new HubError('ARTIFACT_TOO_LARGE', 'Attachments must be at most 20 MiB.');
    const type = ARTIFACT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    result = await client.uploadArtifact(new Blob([await readFile(file)], { type }), path.basename(file));
  } else if (group === 'reviews') result = await client.reviewDelivery(need(id, 'delivery id'), { ...versioned(), decision: action === 'approve' ? 'approve' : action === 'changes' ? 'request_changes' : need(undefined, 'approve or changes') });
  else if (group === 'bind') result = await client.bindItem(need(action, 'item id'), { ...write(), client_instance_id: await instance() });
  else if (group === 'runs') {
    if (action === 'get') result = await client.getRun(need(id, 'run id'));
    else if (action === 'register') result = await client.createRun(need(id, 'item id'), { ...versioned(), client_instance_id: await instance() });
    else if (action === 'report') result = await client.reportRun(need(id, 'run id'), { ...write(), client_instance_id: await instance() });
    else if (action === 'cancel') result = await client.cancelRun(need(id, 'run id'), write());
    else throw new HubError('UNKNOWN_COMMAND', 'Unknown run command.');
  } else if (group === 'tools') {
    if (action === 'list') result = await client.listCapabilities({ q: o.q, kind: o.kind });
    else if (action === 'show') result = o.version ? await client.getRelease(need(id, 'capability id'), o.version) : await client.getCapability(need(id, 'capability id'));
    else if (action === 'publish') result = await client.createCapability(write());
    else if (action === 'release') result = await client.publishRelease(need(id, 'capability id'), write());
    else if (action === 'install') {
      const target = validateInstallTarget(o);
      const capabilityId = need(id, 'capability id');
      const release = await client.getRelease(capabilityId, need(o.version, '--version'));
      result = target === 'harness'
        ? await installHarnessSkill(await client.getCapability(capabilityId), release, o)
        : await installRelease(release, o.directory);
    } else if (action === 'run') result = await runInstalled(path.resolve(need(id, 'installed package directory')), tail, { timeout: numeric(o.timeout || 120000, '--timeout') });
    else throw new HubError('UNKNOWN_COMMAND', 'Unknown tools command.');
  } else if (group === 'toolsets') {
    if (action === 'get') result = await client.getToolset(need(id, 'team id'));
    else if (action === 'set') result = await client.setToolset(need(id, 'team id'), versioned());
    else throw new HubError('UNKNOWN_COMMAND', 'Use toolsets get or set.');
  } else throw new HubError('UNKNOWN_COMMAND', 'Unknown command. Run teamhub --help.');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result?.status === 'failed' || result?.status === 'timed_out') process.exitCode = 1;
}
main().catch(error => {
  process.stderr.write(JSON.stringify(error.toJSON?.() ?? { error: { code: 'CLI_ERROR', message: error.message } }, null, 2) + '\n');
  process.exitCode = 1;
});
