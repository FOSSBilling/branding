export interface Variant {
  name: string;
  icon: string;
  logo: string;
  square: string;
}

export type AssetType = 'icon' | 'logo' | 'favicon' | 'apple-touch-icon' | 'preview';

export interface Asset {
  path: string;
  variant: string | null;
  type: AssetType;
  format: 'svg' | 'png';
  width?: number;
  height?: number;
  variants?: string[];
}

export interface AssetManifest {
  exportedAt: string;
  files: Asset[];
}
