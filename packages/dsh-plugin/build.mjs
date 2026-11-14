import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const lib = new URL('./lib/', import.meta.url);
await rm(lib, { recursive: true, force: true });
await mkdir(lib, { recursive: true });
await cp(fileURLToPath(new URL('../client/src/', import.meta.url)), fileURLToPath(new URL('./lib/client/', import.meta.url)), { recursive: true });
await cp(fileURLToPath(new URL('./src/', import.meta.url)), fileURLToPath(lib), { recursive: true });
