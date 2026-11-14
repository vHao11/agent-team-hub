import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const lib = new URL('./lib/client/', import.meta.url);
await mkdir(lib, { recursive: true });
await cp(fileURLToPath(new URL('../client/src/', import.meta.url)), fileURLToPath(lib), { recursive: true });
