#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { optimize } from 'svgo';
import type { Asset, AssetManifest, Variant } from './types.ts';
import svgoConfig from './svgo.config.ts';
import { createPreview } from './create-preview.ts';

// Use outlined SVG masters; live-text artwork requires fonts and is rejected.
// Remove obsolete generated files after all inputs and destinations are checked.

const help = `Optimise FOSSBilling SVG masters, then generate PNGs, favicons, a preview, and an asset manifest.

Usage: node scripts/generate-assets.ts [options]
  --config PATH   Configuration file (default: export.config.json)
  --help          Show this help

Paths in the configuration file are relative to the configuration file.
SVGs are written to assets/, PNGs and favicons to dist/.
Existing exports are overwritten and obsolete generated files are removed.
`;

// Vector sources render at a higher density, then downsample for crisper PNGs.
const RENDER_DENSITY_FACTOR = 2;
const BASE_DENSITY = 72;
const FAVICON_PNG_SIZE = 180;

const VARIANT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sizes(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.some(n => !Number.isInteger(n) || n < 1 || n > 4096)) {
    throw new Error(`${name} must be an array of integer sizes from 1 to 4096.`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

// Only the outer SVG viewport changes; paths, clips and proportions stay intact.
function squareSvg(svg: string, label: string) {
  const root = svg.match(/<svg\b[^>]*>/);
  const viewBox = root?.[0].match(/\sviewBox\s*=\s*(["'])(.*?)\1/);
  if (!root || !viewBox) throw new Error(`${label} needs a viewBox on its root SVG.`);
  const numbers = viewBox[2].trim().split(/[\s,]+/).map(Number);
  const [x, y, width, height] = numbers;
  if (numbers.length !== 4 || !numbers.every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error(`${label} has an invalid viewBox.`);
  }
  const side = Math.max(width, height);
  const attributes = root[0].replace(/\s(?:width|height|viewBox)\s*=\s*(["']).*?\1/g, '');
  const replacement = attributes.slice(0, -1)
    + ` width="${side}" height="${side}" viewBox="${x - (side - width) / 2} ${y - (side - height) / 2} ${side} ${side}">`;
  return svg.replace(root[0], replacement);
}

async function renderPng(svg: string, width: number) {
  const input = Buffer.from(svg);
  const metadata = await sharp(input).metadata();
  const sourceWidth = metadata.width ?? width;
  const density = Math.max(BASE_DENSITY, Math.ceil(BASE_DENSITY * RENDER_DENSITY_FACTOR * width / sourceWidth));
  return sharp(input, { density }).resize({ width }).ensureAlpha().png().toBuffer();
}

interface ExportConfig {
  iconSizes?: unknown;
  logoWidths?: unknown;
  variants?: Record<string, { icon?: unknown; logo?: unknown } | null>;
}

async function loadVariants(config: ExportConfig, configDir: string): Promise<{ variants: Variant[]; sources: Set<string> }> {
  if (!config.variants || typeof config.variants !== 'object' || Array.isArray(config.variants)
      || !Object.keys(config.variants).length) throw new Error('Configure at least one variant.');
  const variants: Variant[] = [];
  const sources = new Set<string>();
  // Validate and load every input before writing any exports.
  for (const [name, variant] of Object.entries(config.variants)) {
    if (!VARIANT_NAME.test(name)) throw new Error(`Invalid variant name: ${name}`);
    const loaded = { icon: '', logo: '' };
    for (const type of ['icon', 'logo'] as const) {
      if (typeof variant?.[type] !== 'string') throw new Error(`${name}.${type} must be an SVG path.`);
      const file = path.resolve(configDir, variant[type]);
      sources.add(file);
      const svg = await readFile(file, 'utf8');
      if (/<(?:[\w-]+:)?text\b/i.test(svg)) throw new Error(`${file}: use outlined lettering, not live text.`);
      const metadata = await sharp(Buffer.from(svg)).metadata();
      if (metadata.format !== 'svg' || !metadata.width || !metadata.height) throw new Error(`Invalid SVG: ${file}`);
      const optimised = optimize(svg, { ...svgoConfig, path: file }).data;
      const optimisedMetadata = await sharp(Buffer.from(optimised)).metadata();
      if (optimisedMetadata.width !== metadata.width || optimisedMetadata.height !== metadata.height) {
        throw new Error(`Optimisation changed the dimensions of ${file}.`);
      }
      loaded[type] = optimised;
    }
    variants.push({ name, ...loaded, square: squareSvg(loaded.icon, `${name} icon`) });
  }
  return { variants, sources };
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'export.config.json' },
    help: { type: 'boolean', default: false },
  }});
  if (values.help) { console.log(help); return; }
  const configPath = path.resolve(values.config);
  const configDir = path.dirname(configPath);
  const config: ExportConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const iconSizes = sizes(config.iconSizes ?? [128, 256, 512], 'iconSizes');
  const logoWidths = sizes(config.logoWidths ?? [600, 1200], 'logoWidths');
  const output = path.resolve(configDir, 'dist');
  const assetsOutput = path.resolve(configDir, 'assets');
  const { variants, sources } = await loadVariants(config, configDir);
  // Dereference symlinks so a destination linked to a source cannot bypass the guards below.
  async function canonical(file: string): Promise<string> {
    try {
      return await realpath(file);
    } catch {
      const dir = await realpath(path.dirname(file)).catch(() => path.resolve(path.dirname(file)));
      return path.join(dir, path.basename(file));
    }
  }
  const sourcePaths = new Set(await Promise.all([...sources].map(canonical)));
  const files: { file: string; data: string | Buffer }[] = [];
  const assets: Asset[] = [];
  async function add(relative: string, data: string | Buffer, type: Asset['type'], variant: string | null, directory = output) {
    const format = path.extname(relative).slice(1);
    if (format !== 'svg' && format !== 'png') throw new Error(`Unexpected output format: ${relative}`);
    const asset: Asset = { path: relative.split(path.sep).join('/'), variant, type, format };
    if (format === 'png') {
      const { width, height } = await sharp(data).metadata();
      asset.width = width;
      asset.height = height;
    }
    files.push({ file: path.join(directory, relative), data });
    assets.push(asset);
    return asset;
  }
  for (const variant of variants) {
    const prefix = variant.name;
    for (const type of ['icon', 'logo'] as const) {
      await add(`${prefix}/fossbilling-${type}.svg`, variant[type], type, prefix, assetsOutput);
    }
    for (const size of iconSizes) {
      await add(`${prefix}/png/icon/fossbilling-icon-${size}.png`, await renderPng(variant.square, size), 'icon', prefix);
    }
    for (const width of logoWidths) {
      await add(`${prefix}/png/logo/fossbilling-logo-${width}w.png`, await renderPng(variant.logo, width), 'logo', prefix);
    }
    await add(`${prefix}/favicon/favicon.svg`, variant.square, 'favicon', prefix);
    await add(`${prefix}/favicon/apple-touch-icon.png`, await renderPng(variant.square, FAVICON_PNG_SIZE), 'apple-touch-icon', prefix);
  }
  const preview = await add('preview.png', await createPreview(variants, sharp, renderPng), 'preview', null);
  preview.variants = variants.map(({ name }) => name);
  // Paths describe the published bundle, where assets/ and dist/ are combined.
  const manifest: AssetManifest = { exportedAt: new Date().toISOString(), files: assets };
  files.push({ file: path.join(output, 'manifest.json'), data: JSON.stringify(manifest, null, 2) + '\n' });
  const targets = new Set<string>();
  for (const { file } of files) {
    const target = await canonical(file);
    if (sourcePaths.has(target)) throw new Error(`Output would overwrite a source: ${target}`);
    if (targets.has(target)) throw new Error(`Output paths overlap: ${target}`);
    targets.add(target);
  }
  const expected = new Set(files.map(({ file }) => file));
  const obsolete = new Set<string>();
  // Only recognise this exporter's filenames. Legacy ICO favicons are
  // recognised only for removal; they are no longer generated.
  // Scoped to the old variant/favicon path so unrelated files are untouched.
  const legacy = /^[a-z0-9]+(?:-[a-z0-9]+)*\/favicon\/favicon\.ico$/;
  const generated = {
    assets: /^[a-z0-9]+(?:-[a-z0-9]+)*\/fossbilling-(?:icon|logo)\.svg$/,
    dist: /^(?:manifest\.json|preview\.png|[a-z0-9]+(?:-[a-z0-9]+)*\/(?:png\/icon\/fossbilling-icon-\d+\.png|png\/logo\/fossbilling-logo-\d+w\.png|favicon\/(?:favicon\.svg|apple-touch-icon\.png)))$/,
  };
  for (const [directory, pattern] of [[assetsOutput, generated.assets], [output, generated.dist]] as const) {
    const directories = [directory];
    for (const current of directories) {
      const entries = await readdir(current, { withFileTypes: true })
        .catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
      for (const entry of entries) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) { directories.push(file); continue; }
        const relative = path.relative(directory, file).split(path.sep).join('/');
        const recognised = pattern.test(relative) || legacy.test(relative);
        if (!recognised || expected.has(file)) continue;
        if (sourcePaths.has(await canonical(file))) throw new Error(`Output would remove a source: ${file}`);
        obsolete.add(file);
      }
    }
  }
  for (const { file, data } of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  for (const file of obsolete) await rm(file);
  console.log(`Generated ${variants.length * 2} optimised SVGs in ${assetsOutput}`);
  console.log(`Generated ${files.length - variants.length * 2} PNG/favicon/preview/manifest files in ${output}`);
  if (obsolete.size) console.log(`Removed ${obsolete.size} obsolete generated files`);
}

main().catch(error => { console.error(`Asset generation failed: ${error.message}`); process.exitCode = 1; });
