#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import svgoConfig from './svgo.config.mjs';

// Use outlined SVG masters; live-text artwork requires fonts and is rejected.
// Exports overwrite matching filenames but do not remove obsolete files.

const help = `Optimise FOSSBilling SVG masters, then generate PNGs and favicons.

Usage: node scripts/generate-assets.mjs [options]
  --config PATH   Configuration file (default: export.config.json)
  --output PATH   Override PNG/favicon output directory
  --assets-output PATH  Override optimised SVG output directory
  --help          Show this help

Input and configured output paths are relative to the configuration file.
Both output overrides are relative to the current working directory.
Existing exports with matching names are overwritten; other files are untouched.
`;

function sizes(value, name) {
  if (!Array.isArray(value) || value.some(n => !Number.isInteger(n) || n < 1 || n > 4096)) {
    throw new Error(`${name} must be an array of integer sizes from 1 to 4096.`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

// Only the outer SVG viewport changes; paths, clips and proportions stay intact.
function squareSvg(svg, label) {
  const root = svg.match(/<svg\b[^>]*>/);
  const viewBox = root?.[0].match(/\sviewBox\s*=\s*(["'])(.*?)\1/);
  if (!viewBox) throw new Error(`${label} needs a viewBox on its root SVG.`);
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
function ico(frames) {
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
  const config = JSON.parse(await readFile(configPath, 'utf8'));
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
  const variants = [];
  const sources = new Set();
  // Validate and load every input before writing any exports.
  for (const [name, variant] of Object.entries(config.variants)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid variant name: ${name}`);
    const loaded = {};
    for (const type of ['icon', 'logo']) {
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
    loaded.square = squareSvg(loaded.icon, `${name} icon`);
    variants.push({ name, ...loaded });
  }
  // Check every destination before writing, including aliases through symlinked folders.
  const { realpath, lstat } = await import('node:fs/promises');
  async function canonical(file) {
    try { return await realpath(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink is not an ordinary missing destination.
      const entry = await lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (entry?.isSymbolicLink()) throw new Error(`Dangling symlink: ${file}`);
      return path.join(await canonical(path.dirname(file)), path.basename(file));
    }
  }
  const sourcePaths = new Set(await Promise.all([...sources].map(canonical)));
  const targets = new Set();
  const planned = [];
  for (const { name } of variants) {
    for (const type of ['icon', 'logo']) planned.push([assetsOutput, `${name}/fossbilling-${type}.svg`]);
    for (const size of iconSizes) planned.push([output, `${name}/png/icon/fossbilling-icon-${size}.png`]);
    for (const width of logoWidths) planned.push([output, `${name}/png/logo/fossbilling-logo-${width}w.png`]);
    for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) planned.push([output, `${name}/favicon/${file}`]);
  }
  planned.push([output, 'manifest.json']);
  for (const [directory, relative] of planned) {
    const target = await canonical(path.join(directory, relative));
    if (sourcePaths.has(target)) throw new Error(`Output would overwrite a source: ${target}`);
    if (targets.has(target)) throw new Error(`Output paths overlap: ${target}`);
    targets.add(target);
  }
  const files = [];
  async function save(relative, data, scope = 'dist') {
    const target = path.join(scope === 'assets' ? assetsOutput : output, relative);
    if (sources.has(target)) throw new Error(`Output would overwrite a source: ${target}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    files.push({ root: scope, path: relative.split(path.sep).join('/'), sha256: createHash('sha256').update(data).digest('hex') });
  }
  async function png(svg, width) {
    const input = Buffer.from(svg);
    const metadata = await sharp(input).metadata();
    // Render from vectors at >= 2x target resolution, then downsample.
    const density = Math.max(72, Math.ceil(144 * width / metadata.width));
    return sharp(input, { density }).resize({ width }).ensureAlpha().png().toBuffer();
  }
  for (const variant of variants) {
    const prefix = variant.name;
    for (const type of ['icon', 'logo']) {
      await save(`${prefix}/fossbilling-${type}.svg`, variant[type], 'assets');
    }
    for (const size of iconSizes) {
      await save(`${prefix}/png/icon/fossbilling-icon-${size}.png`, await png(variant.square, size));
    }
    for (const width of logoWidths) {
      await save(`${prefix}/png/logo/fossbilling-logo-${width}w.png`, await png(variant.logo, width));
    }
    await save(`${prefix}/favicon/favicon.svg`, variant.square);
    const frames = [];
    for (const size of [16, 32, 48]) frames.push({ size, png: await png(variant.square, size) });
    await save(`${prefix}/favicon/favicon.ico`, ico(frames));
    await save(`${prefix}/favicon/apple-touch-icon.png`, await png(variant.square, 180));
  }
  await save('manifest.json', JSON.stringify({ files: [...files] }, null, 2) + '\n');
  console.log(`Generated ${variants.length * 2} optimised SVGs in ${assetsOutput}`);
  console.log(`Generated ${files.length - variants.length * 2} PNG/favicon/manifest files in ${output}`);
}

main().catch(error => { console.error(`Asset generation failed: ${error.message}`); process.exitCode = 1; });
