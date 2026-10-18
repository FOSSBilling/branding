import type { Config } from 'svgo';

// Explicit allowlist: remove editor/document overhead without rounding coordinates,
// rewriting paths/transforms, renaming IDs or altering clipping and viewBox data.
// Keep this conservative; visually verify any future plugin changes.
export default {
  multipass: false,
  plugins: [
    'removeDoctype',
    'removeXMLProcInst',
    'removeComments',
    'removeMetadata',
    'removeEditorsNSData',
    'cleanupAttrs',
    'convertStyleToAttrs',
    'convertColors',
    'removeUnusedNS',
    'sortAttrs',
  ],
  js2svg: { pretty: false, finalNewline: true },
} satisfies Config;
