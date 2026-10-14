import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Use the bundled font for labels; logo lettering still comes from outlined SVGs.
const fontfile = fileURLToPath(new URL('../source/fonts/Manrope/Manrope-VariableFont_wght.ttf', import.meta.url));
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

export async function createPreview(variants, sharp, png) {
  await access(fontfile);
  const rows = variants.flatMap(variant => {
    if (variant.name === 'dark-background') return [
      { variant, background: '#171C24', foreground: '#FFFFFF', label: 'Dark Background' },
      { variant, background: '#000000', foreground: '#FFFFFF', label: 'Black Background' },
    ];
    return [{ variant, background: '#FFFFFF', foreground: '#171C24',
      label: variant.name === 'light-background' ? 'Light Background' : `${variant.name} / White` }];
  });
  const width = 1200;
  const height = 130 + rows.length * 250;
  const layers = [];
  async function label(text, left, top, color, size = 16) {
    const input = await sharp({ text: {
      text: `<span foreground="${color}">${escape(text)}</span>`,
      font: `Manrope ${size}`, fontfile, rgba: true, dpi: 72,
    }}).png().toBuffer();
    layers.push({ input, left, top });
  }
  async function artwork(svg, left, top, maxWidth, maxHeight) {
    const { width: w, height: h } = await sharp(Buffer.from(svg)).metadata();
    const targetWidth = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * w / h)));
    layers.push({ input: await png(svg, targetWidth), left, top });
  }
  await label('FOSSBilling Branding Asset Preview', 32, 25, '#171C24', 26);
  await label('Use the individual files for production.', 32, 68, '#596371', 15);
  for (const [index, row] of rows.entries()) {
    const y = 110 + index * 250;
    const input = await sharp({ create: { width: 1160, height: 230, channels: 3, background: row.background } }).png().toBuffer();
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
  return sharp({ create: { width, height, channels: 3, background: '#E8EBEF' } })
    .composite(layers).removeAlpha().png().toBuffer();
}
