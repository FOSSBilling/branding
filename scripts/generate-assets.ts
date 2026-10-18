#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Asset, AssetManifest, Variant } from './types.ts';
import svgoConfig from './svgo.config.ts';
import { createPreview } from './create-preview.ts';

// Use outlined SVG masters; live-text artwork requires fonts and is rejected.
// Remove obsolete generated files after all inputs and destinations are checked.

const help = `Optimise FOSSBilling SVG masters, then generate PNGs, favicons, a preview, and an asset manifest.

Usage: node scripts/generate-assets.ts [options]
  --config PATH   Configuration file (default: export.config.json)
  --output PATH   Override PNG/favicon output directory
  --assets-output PATH  Override optimised SVG output directory
  --help          Show this help

Input and configured output paths are relative to the configuration file.
Both output overrides are relative to the current working directory.
Existing exports are overwritten and obsolete generated files are removed.
`;

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

// ICO directory containing independently rendered RGBA PNG frames.
function ico(frames: { size: number; png: Buffer }[]) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = frames.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...frames.map(frame => frame.png)]);
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'export.config.json' },
    output: { type: 'string' },
    'assets-output': { type: 'string' },
    help: { type: 'boolean', default: false },
  }});
  if (values.help) { console.log(help); return; }
  const configPath = path.resolve(values.config);
  const configDir = path.dirname(configPath);
  const config: {
    iconSizes?: unknown;
    logoWidths?: unknown;
    output?: unknown;
    assetsOutput?: unknown;
    variants?: Record<string, Partial<Record<'icon' | 'logo', unknown>> | null>;
  } = JSON.parse(await readFile(configPath, 'utf8'));
  const iconSizes = sizes(config.iconSizes ?? [128, 256, 512], 'iconSizes');
  const logoWidths = sizes(config.logoWidths ?? [600, 1200], 'logoWidths');
  if (typeof config.output !== 'string' || !config.output) throw new Error('Set output in the configuration.');
  const output = values.output ? path.resolve(values.output) : path.resolve(configDir, config.output);
  if (typeof config.assetsOutput !== 'string' || !config.assetsOutput) {
    throw new Error('Set assetsOutput in the configuration (separate from source masters).');
  }
  const assetsOutput = values['assets-output']
    ? path.resolve(values['assets-output']) : path.resolve(configDir, config.assetsOutput);
  if (!config.variants || typeof config.variants !== 'object' || Array.isArray(config.variants)
      || !Object.keys(config.variants).length) throw new Error('Configure at least one variant.');
  const { default: sharp } = await import('sharp');
  const { optimize } = await import('svgo');
  const variants: Variant[] = [];
  const sources = new Set<string>();
  // Validate and load every input before writing any exports.
  for (const [name, variant] of Object.entries(config.variants)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid variant name: ${name}`);
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
  // Check every destination before writing, including aliases through symlinked folders.
  const { realpath, lstat } = await import('node:fs/promises');
  async function canonical(file: string): Promise<string> {
    try { return await realpath(file); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      // A dangling symlink is not an ordinary missing destination.
      const entry = await lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (entry?.isSymbolicLink()) throw new Error(`Dangling symlink: ${file}`);
      return path.join(await canonical(path.dirname(file)), path.basename(file));
    }
  }
  const sourcePaths = new Set(await Promise.all([...sources].map(canonical)));
  const files: { file: string; data: string | Buffer; asset?: Asset }[] = [];
  async function add(relative: string, data: string | Buffer, type: Asset['type'], variant: string | null, directory = output) {
    const asset: Asset = { path: relative.split(path.sep).join('/'), variant, type, format: path.extname(relative).slice(1) };
    if (asset.format === 'png') {
      const { width, height } = await sharp(data).metadata();
      Object.assign(asset, { width, height });
    }
    files.push({ file: path.join(directory, relative), data, asset });
    return asset;
  }
  async function png(svg: string, width: number) {
    const input = Buffer.from(svg);
    const metadata = await sharp(input).metadata();
    // Render from vectors at >= 2x target resolution, then downsample.
    const density = Math.max(72, Math.ceil(144 * width / metadata.width!));
    return sharp(input, { density }).resize({ width }).ensureAlpha().png().toBuffer();
  }
  for (const variant of variants) {
    const prefix = variant.name;
    for (const type of ['icon', 'logo'] as const) {
      await add(`${prefix}/fossbilling-${type}.svg`, variant[type], type, prefix, assetsOutput);
    }
    for (const size of iconSizes) {
      await add(`${prefix}/png/icon/fossbilling-icon-${size}.png`, await png(variant.square, size), 'icon', prefix);
    }
    for (const width of logoWidths) {
      await add(`${prefix}/png/logo/fossbilling-logo-${width}w.png`, await png(variant.logo, width), 'logo', prefix);
    }
    await add(`${prefix}/favicon/favicon.svg`, variant.square, 'favicon', prefix);
    const frames = [];
    for (const size of [16, 32, 48]) frames.push({ size, png: await png(variant.square, size) });
    const favicon = await add(`${prefix}/favicon/favicon.ico`, ico(frames), 'favicon', prefix);
    favicon.sizes = frames.map(({ size }) => size);
    await add(`${prefix}/favicon/apple-touch-icon.png`, await png(variant.square, 180), 'apple-touch-icon', prefix);
  }
  const preview = await add('preview.png', await createPreview(variants, sharp, png), 'preview', null);
  preview.variants = variants.map(({ name }) => name);
  // Paths describe the published bundle, where assets/ and dist/ are combined.
  const manifest: AssetManifest = { exportedAt: new Date().toISOString(), files: files.flatMap(({ asset }) => asset ? [asset] : []) };
  files.push({ file: path.join(output, 'manifest.json'), data: JSON.stringify(manifest, null, 2) + '\n' });
  const targets = new Set();
  for (const { file } of files) {
    const target = await canonical(file);
    if (sourcePaths.has(target)) throw new Error(`Output would overwrite a source: ${target}`);
    if (targets.has(target)) throw new Error(`Output paths overlap: ${target}`);
    targets.add(target);
  }
  const expected = new Set(files.map(({ file }) => file));
  const obsolete = new Set<string>();
  // Only recognise this exporter's filenames; do not traverse symlinked directories.
  const generated = {
    assets: /^[a-z0-9]+(?:-[a-z0-9]+)*\/fossbilling-(?:icon|logo)\.svg$/,
    dist: /^(?:manifest\.json|preview\.png|[a-z0-9]+(?:-[a-z0-9]+)*\/(?:png\/icon\/fossbilling-icon-\d+\.png|png\/logo\/fossbilling-logo-\d+w\.png|favicon\/(?:favicon\.(?:svg|ico)|apple-touch-icon\.png)))$/,
  };
  for (const [directory, pattern] of [[assetsOutput, generated.assets], [output, generated.dist]] as const) {
    const directories = [directory];
    for (const current of directories) {
      const entries = await readdir(current, { withFileTypes: true })
        .catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; return []; });
      for (const entry of entries) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) { directories.push(file); continue; }
        const relative = path.relative(directory, file).split(path.sep).join('/');
        if (!pattern.test(relative) || expected.has(file)) continue;
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
