export interface Variant {
  name: string;
  icon: string;
  logo: string;
  square: string;
}

export interface Asset {
  path: string;
  variant: string | null;
  type: 'icon' | 'logo' | 'favicon' | 'apple-touch-icon' | 'preview';
  format: string;
  width?: number;
  height?: number;
  sizes?: number[];
  variants?: string[];
}

export interface AssetManifest {
  exportedAt: string;
  files: Asset[];
}
