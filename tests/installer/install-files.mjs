// Writes the files the website publishes for the installers (install.sh,
// install.ps1, the compose files, the keel command, SHA256SUMS) into a folder,
// without building the whole website. Used by the installer tests in CI.
//
//   KEEL_FILES_URL=http://127.0.0.1:8765 KEEL_RELEASE_VERSION=0.0.1-test \
//     node tests/installer/install-files.mjs <out-dir>
//
// Needs Node 22.18 or newer (it loads website/.vitepress/site.ts directly).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] || 'install-files');
const { writeInstallFiles } = await import(new URL('../../website/.vitepress/site.ts', import.meta.url).href);
await fs.mkdir(out, { recursive: true });
await writeInstallFiles(root, out);
console.log(`install files written to ${out}`);
