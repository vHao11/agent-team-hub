#!/usr/bin/env node
/** Materialize a reviewable release payload; does not publish or execute package code. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRelativeFile } from '../packages/client/src/installer.mjs';

const [folder, output] = process.argv.slice(2);
if (!folder || !output) throw new Error('Usage: node examples/build-release.mjs PACKAGE_DIRECTORY OUTPUT_JSON');
const root = path.resolve(folder), files = {};
async function readTree(relative = '') {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Package symlinks are unsupported: ${name}`);
    if (entry.isDirectory()) await readTree(name);
    else if (entry.isFile()) { validateRelativeFile(name); files[name] = await fs.readFile(path.join(root, name), 'utf8'); }
  }
}
await readTree();
const manifest = JSON.parse(files['manifest.json']);
if (!manifest.version || !manifest.kind || !manifest.entry) throw new Error('manifest.json requires version, kind and entry.');
if (!files[manifest.entry]) throw new Error('The declared entry file is missing.');
const payload = { operation_id: randomUUID(), version: manifest.version, manifest, files };
await fs.writeFile(path.resolve(output), JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ output: path.resolve(output), version: manifest.version, files: Object.keys(files).length }) + '\n');
