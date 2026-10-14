import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/generate-assets.mjs', import.meta.url));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24" viewBox="0 0 32 24"><path fill="#0785bc" d="M0 0h32v24H0z"/></svg>';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branding-export-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'master.svg'), svg);
  const config = {
    assetsOutput: 'assets', output: 'dist', iconSizes: [128, 256], logoWidths: [600],
    variants: {
      'light-background': { icon: 'master.svg', logo: 'master.svg' },
      'dark-background': { icon: 'master.svg', logo: 'master.svg' },
    },
  };
  return {
    root, config,
    async generate(...args) {
      const configPath = path.join(root, 'export.config.json');
      await writeFile(configPath, JSON.stringify(config));
      return exec(process.execPath, [script, '--config', configPath, ...args]);
    },
  };
}

test('removes obsolete sizes, variants and the old manifest while retaining unrelated files', async t => {
  const { root, config, generate } = await fixture(t);
  await generate();
  await writeFile(path.join(root, 'dist', 'manifest.json'), '{}');
  await writeFile(path.join(root, 'dist', 'notes.txt'), 'keep');
  config.iconSizes = [128];
  delete config.variants['dark-background'];
  await generate();
  for (const relative of [
    'dist/manifest.json', 'dist/light-background/png/icon/fossbilling-icon-256.png',
    'dist/dark-background/png/icon/fossbilling-icon-128.png',
    'dist/dark-background/png/logo/fossbilling-logo-600w.png',
    'dist/dark-background/favicon/favicon.svg', 'dist/dark-background/favicon/favicon.ico',
    'dist/dark-background/favicon/apple-touch-icon.png',
    'assets/dark-background/fossbilling-icon.svg', 'assets/dark-background/fossbilling-logo.svg',
  ]) await assert.rejects(access(path.join(root, relative)), { code: 'ENOENT' });
  await access(path.join(root, 'dist/light-background/png/icon/fossbilling-icon-128.png'));
  assert.equal(await readFile(path.join(root, 'dist/notes.txt'), 'utf8'), 'keep');
});

test('invalid inputs leave existing exports intact', async t => {
  const { root, config, generate } = await fixture(t);
  await generate();
  const exported = path.join(root, 'assets/light-background/fossbilling-logo.svg');
  const before = await readFile(exported);
  config.iconSizes = [];
  config.variants['dark-background'].logo = 'missing.svg';
  await assert.rejects(generate(), /ENOENT/);
  assert.deepEqual(await readFile(exported), before);
  await access(path.join(root, 'dist/light-background/png/icon/fossbilling-icon-128.png'));
});

test('rejects overwriting a source through a symlink before writing or cleaning', async t => {
  const { root, generate } = await fixture(t);
  await generate();
  const destination = path.join(root, 'assets/light-background/fossbilling-icon.svg');
  await rm(destination);
  await symlink(path.join(root, 'master.svg'), destination);
  await writeFile(path.join(root, 'dist/manifest.json'), '{}');
  await assert.rejects(generate(), /Output would overwrite a source/);
  assert.equal(await readFile(path.join(root, 'master.svg'), 'utf8'), svg);
  await access(path.join(root, 'dist/manifest.json'));
});

test('cleanup does not follow symlinked directories', async t => {
  const { root, generate } = await fixture(t);
  const external = path.join(root, 'external');
  await mkdir(external);
  const untouched = path.join(external, 'fossbilling-logo.svg');
  await writeFile(untouched, 'keep');
  await mkdir(path.join(root, 'assets'));
  await symlink(external, path.join(root, 'assets/old-background'));
  await generate();
  assert.equal(await readFile(untouched, 'utf8'), 'keep');
});

test('supports a combined SVG and raster output directory', async t => {
  const { root, config, generate } = await fixture(t);
  config.assetsOutput = 'dist';
  await generate();
  await access(path.join(root, 'dist/light-background/fossbilling-logo.svg'));
  await access(path.join(root, 'dist/light-background/png/icon/fossbilling-icon-128.png'));
  delete config.variants['dark-background'];
  await generate();
  await assert.rejects(access(path.join(root, 'dist/dark-background/fossbilling-logo.svg')), { code: 'ENOENT' });
});
