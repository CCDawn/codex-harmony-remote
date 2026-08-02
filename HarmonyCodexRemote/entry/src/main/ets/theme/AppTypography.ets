export const DEFAULT_FONT_SCALE_MODE: string = 'standard';
export const FONT_SCALE_STORAGE_KEY: string = 'codexRemoteFontScaleMode';

export function normalizeFontScaleMode(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'small' || normalized === 'large' || normalized === 'extra_large') {
    return normalized;
  }
  return DEFAULT_FONT_SCALE_MODE;
}

export function fontScaleLabel(value: string): string {
  const normalized = normalizeFontScaleMode(value);
  if (normalized === 'small') {
    return '小';
  }
  if (normalized === 'large') {
    return '大';
  }
  if (normalized === 'extra_large') {
    return '特大';
  }
  return '标准';
}

export function fontScalePercent(value: string): number {
  const normalized = normalizeFontScaleMode(value);
  if (normalized === 'small') {
    return 90;
  }
  if (normalized === 'large') {
    return 115;
  }
  if (normalized === 'extra_large') {
    return 130;
  }
  return 100;
}

export function scaleFontSize(size: number, value: string): number {
  return Math.round(size * fontScalePercent(value)) / 100;
}
