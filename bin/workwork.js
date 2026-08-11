#!/usr/bin/env node
// Thin launcher: Node runs the TypeScript sources directly (type stripping,
// Node >= 22.18), so there is no build step to keep in sync.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, '..', 'src', 'index.ts'));
