// All geometry is in CSS pixels at 96 DPI (1in = 96px, 1pt = 4/3 px).
export const PX_PER_IN = 96;
export const PX_PER_CM = 96 / 2.54;
export const PX_PER_PT = 96 / 72;
export const TWIPS_PER_PX = 15; // 1440 twips per inch / 96 px per inch

export const PAGE_SIZES = {
  letter: { label: 'Letter', detail: '8.5" × 11"', width: 816, height: 1056 },
  legal: { label: 'Legal', detail: '8.5" × 14"', width: 816, height: 1344 },
  a4: { label: 'A4', detail: '21 cm × 29.7 cm', width: 793.7, height: 1122.5 },
  a5: { label: 'A5', detail: '14.8 cm × 21 cm', width: 559.4, height: 793.7 },
  executive: { label: 'Executive', detail: '7.25" × 10.5"', width: 696, height: 1008 },
};

export const MARGIN_PRESETS = {
  normal: { label: 'Normal', margins: { top: 96, bottom: 96, left: 96, right: 96 } },
  narrow: { label: 'Narrow', margins: { top: 48, bottom: 48, left: 48, right: 48 } },
  moderate: { label: 'Moderate', margins: { top: 96, bottom: 96, left: 72, right: 72 } },
  wide: { label: 'Wide', margins: { top: 96, bottom: 96, left: 192, right: 192 } },
  mirrored: { label: 'Office 2003', margins: { top: 96, bottom: 96, left: 120, right: 120 } },
};

export const PAGE_GAP = 20;

export function pageGeometry(settings) {
  const size = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.letter;
  const landscape = settings.orientation === 'landscape';
  const width = landscape ? size.height : size.width;
  const height = landscape ? size.width : size.height;
  const m = settings.margins;
  return {
    width,
    height,
    margins: { ...m },
    contentWidth: Math.max(48, width - m.left - m.right),
    contentHeight: Math.max(48, height - m.top - m.bottom),
    gap: PAGE_GAP,
  };
}

/** Use inches for US-ish locales and centimetres everywhere else, like Word. */
export const usesInches = () => /^en-(US|LR|MM)|^my\b/i.test(navigator.language || 'en-US');

export const formatLength = (px) =>
  usesInches() ? `${+(px / PX_PER_IN).toFixed(2)}"` : `${+(px / PX_PER_CM).toFixed(2)} cm`;
