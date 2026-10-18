import type { TestContext } from 'node:test';
import type { AssetManifest } from '../scripts/types.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/generate-assets.ts', import.meta.url));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24" viewBox="0 0 32 24"><path fill="#0785bc" d="M0 0h32v24H0z"/></svg>';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branding-export-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'master.svg'), svg);
  const config: { assetsOutput: string; output: string; iconSizes: number[]; logoWidths: number[]; variants: Record<string, { icon: string; logo: string }> } = {
    assetsOutput: 'assets', output: 'dist', iconSizes: [128, 256], logoWidths: [600],
    variants: {
      'light-background': { icon: 'master.svg', logo: 'master.svg' },
      'dark-background': { icon: 'master.svg', logo: 'master.svg' },
    },
  };
  return {
    root, config,
    async generate(...args: string[]) {
      const configPath = path.join(root, 'export.config.json');
      await writeFile(configPath, JSON.stringify(config));
      return exec(process.execPath, [script, '--config', configPath, ...args]);
    },
  };
}

test('catalogs all published assets with a UTC timestamp and accurate raster dimensions', async t => {
  const { root, generate } = await fixture(t);
  const started = Date.now();
  await generate();
  const manifest: AssetManifest = JSON.parse(await readFile(path.join(root, 'dist/manifest.json'), 'utf8'));
  assert.match(manifest.exportedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(manifest.exportedAt) >= started && Date.parse(manifest.exportedAt) <= Date.now());
  const paths = [];
  for (const directory of ['assets', 'dist']) {
    const entries = await readdir(path.join(root, directory), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === 'manifest.json') continue;
      const file = path.join(entry.parentPath, entry.name);
      const relative = path.relative(path.join(root, directory), file).split(path.sep).join('/');
      paths.push(relative);
      const asset = manifest.files.find(asset => asset.path === relative);
      assert.ok(asset, `Missing manifest entry for ${relative}`);
      if (asset.type === 'preview') {
        assert.equal(asset.variant, null);
        assert.deepEqual(asset.variants, ['light-background', 'dark-background']);
      } else {
        assert.ok(asset.variant !== null && ['light-background', 'dark-background'].includes(asset.variant));
      }
      assert.ok(['icon', 'logo', 'favicon', 'apple-touch-icon', 'preview'].includes(asset.type));
      assert.equal(asset.format, path.extname(file).slice(1));
      const data = await readFile(file);
      if (asset.format === 'png') {
        assert.equal(asset.width, data.readUInt32BE(16));
        assert.equal(asset.height, data.readUInt32BE(20));
      } else if (asset.format === 'ico') {
        const sizes = Array.from({ length: data.readUInt16LE(4) }, (_, i) => data.readUInt8(6 + i * 16) || 256);
        assert.deepEqual(asset.sizes, sizes);
      }
    }
  }
  assert.deepEqual(manifest.files.map(asset => asset.path).sort(), paths.sort());
});

test('removes obsolete sizes and variants and refreshes the manifest while retaining unrelated files', async t => {
  const { root, config, generate } = await fixture(t);
  await generate();
  await writeFile(path.join(root, 'dist', 'manifest.json'), '{}');
  await writeFile(path.join(root, 'dist', 'notes.txt'), 'keep');
  config.iconSizes = [128];
  delete config.variants['dark-background'];
  await generate();
  for (const relative of [
    'dist/light-background/png/icon/fossbilling-icon-256.png',
    'dist/dark-background/png/icon/fossbilling-icon-128.png',
    'dist/dark-background/png/logo/fossbilling-logo-600w.png',
    'dist/dark-background/favicon/favicon.svg', 'dist/dark-background/favicon/favicon.ico',
    'dist/dark-background/favicon/apple-touch-icon.png',
    'assets/dark-background/fossbilling-icon.svg', 'assets/dark-background/fossbilling-logo.svg',
  ]) await assert.rejects(access(path.join(root, relative)), { code: 'ENOENT' });
  await access(path.join(root, 'dist/light-background/png/icon/fossbilling-icon-128.png'));
  assert.equal(await readFile(path.join(root, 'dist/notes.txt'), 'utf8'), 'keep');
  const manifest: AssetManifest = JSON.parse(await readFile(path.join(root, 'dist/manifest.json'), 'utf8'));
  assert.ok(manifest.exportedAt);
  assert.ok(manifest.files.every(asset => asset.type === 'preview' || asset.variant === 'light-background'));
  assert.ok(!manifest.files.some(asset => asset.path.endsWith('fossbilling-icon-256.png')));
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
  const untouched = ['fossbilling-logo.svg', 'apple-touch-icon.png'].map(name => path.join(external, name));
  for (const file of untouched) await writeFile(file, 'keep');
  await mkdir(path.join(root, 'assets'));
  await symlink(external, path.join(root, 'assets/old-background'), 'dir');
  await mkdir(path.join(root, 'dist/old-background'), { recursive: true });
  await symlink(external, path.join(root, 'dist/old-background/favicon'), 'dir');
  await generate();
  for (const file of untouched) assert.equal(await readFile(file, 'utf8'), 'keep');
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


test('creates an opaque preview and refreshes it when variants are removed', async t => {
  const { root, config, generate } = await fixture(t);
  await generate();
  const file = path.join(root, 'dist/preview.png');
  const original = await readFile(file);
  const image = await sharp(original).raw().toBuffer({ resolveWithObject: true });
  assert.equal(image.info.width, 1200);
  assert.equal(image.info.height, 880);
  assert.equal(image.info.channels, 3);
  const pixel = (x: number, y: number) => [...image.data.subarray((y * image.info.width + x) * 3, (y * image.info.width + x) * 3 + 3)];
  assert.deepEqual(pixel(25, 115), [255, 255, 255]);
  assert.deepEqual(pixel(25, 365), [23, 28, 36]);
  assert.deepEqual(pixel(25, 615), [0, 0, 0]);
  // Blue fixture artwork appears in the full-logo, standalone and favicon positions.
  for (const [x, y] of [[50, 175], [1000, 210], [725, 285], [810, 280]]) {
    assert.deepEqual(pixel(x, y), [7, 133, 188]);
  }
  delete config.variants['dark-background'];
  await generate();
  const updated = await readFile(file);
  assert.notDeepEqual(updated, original);
  assert.equal((await sharp(updated).metadata()).height, 380);
  const manifest: AssetManifest = JSON.parse(await readFile(path.join(root, 'dist/manifest.json'), 'utf8'));
  const entry = manifest.files.find(asset => asset.type === 'preview');
  assert.ok(entry);
  assert.equal(entry.path, 'preview.png');
  assert.equal(entry.variant, null);
  assert.deepEqual(entry.variants, ['light-background']);
  assert.equal(entry.width, 1200);
  assert.equal(entry.height, 380);
});
