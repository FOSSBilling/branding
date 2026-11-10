import type sharpFactory from 'sharp';
import type { OverlayOptions } from 'sharp';
import type { Variant } from './types.ts';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Use the bundled font for labels; logo lettering still comes from outlined SVGs.
const fontfile = fileURLToPath(new URL('../source/fonts/Manrope/Manrope-VariableFont_wght.ttf', import.meta.url));

const CANVAS_WIDTH = 1200;
const HEADER_HEIGHT = 130;
const ROW_HEIGHT = 250;
const ROW_WIDTH = 1160;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escape = (value: string) => value.replace(/[&<>"']/g, char => ESCAPES[char] ?? char);

interface PreviewRow {
  variant: Variant;
  background: string;
  foreground: string;
  label: string;
}

function previewRows(variants: Variant[]): PreviewRow[] {
  // The dark-background artwork is shown twice: on dark grey and on black.
  return variants.flatMap(variant => {
    if (variant.name === 'dark-background') return [
      { variant, background: '#171C24', foreground: '#FFFFFF', label: 'Dark Background' },
      { variant, background: '#000000', foreground: '#FFFFFF', label: 'Black Background' },
    ];
    return [{ variant, background: '#FFFFFF', foreground: '#171C24',
      label: variant.name === 'light-background' ? 'Light Background' : `${variant.name} / White` }];
  });
}

export async function createPreview(
  variants: Variant[],
  sharp: typeof sharpFactory,
  png: (svg: string, width: number) => Promise<Buffer>,
) {
  await access(fontfile);
  const rows = previewRows(variants);
  const height = HEADER_HEIGHT + rows.length * ROW_HEIGHT;
  const layers: OverlayOptions[] = [];
  async function label(text: string, left: number, top: number, color: string, size = 16) {
    const input = await sharp({ text: {
      text: `<span foreground="${color}">${escape(text)}</span>`,
      font: `Manrope ${size}`, fontfile, rgba: true, dpi: 72,
    }}).png().toBuffer();
    layers.push({ input, left, top });
  }
  async function artwork(svg: string, left: number, top: number, maxWidth: number, maxHeight: number) {
    const { width: w, height: h } = await sharp(Buffer.from(svg)).metadata();
    if (!w || !h) throw new Error('Artwork SVG has no dimensions.');
    const targetWidth = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * w / h)));
    layers.push({ input: await png(svg, targetWidth), left, top });
  }
  await label('FOSSBilling Branding Asset Preview', 32, 25, '#171C24', 26);
  await label('Use the individual files for production.', 32, 68, '#596371', 15);
  for (const [index, row] of rows.entries()) {
    const y = 110 + index * ROW_HEIGHT;
    const input = await sharp({ create: { width: ROW_WIDTH, height: 230, channels: 3, background: row.background } }).png().toBuffer();
    layers.push({ input, left: 20, top: y });
    await label(row.label, 48, y + 17, row.foreground, 18);
    await artwork(row.variant.logo, 48, y + 60, 620, 126);
    await artwork(row.variant.logo, 48, y + 190, 360, 28);
    await label('28px header', 250, y + 196, row.foreground, 13);
    await artwork(row.variant.square, 980, y + 58, 120, 120);
    await label('Icon / 120px', 980, y + 196, row.foreground, 13);
    for (const [size, x] of [[16, 720], [32, 800]]) {
      layers.push({ input: await png(row.variant.square, size), left: x, top: y + 185 - size });
      await label(`${size}px`, x, y + 196, row.foreground, 13);
    }
    await label('Favicons', 720, y + 125, row.foreground, 13);
  }
  return sharp({ create: { width: CANVAS_WIDTH, height, channels: 3, background: '#E8EBEF' } })
    .composite(layers).removeAlpha().png().toBuffer();
}
