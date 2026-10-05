import { describe, it, expect } from 'vitest';
import { rtfToText } from '../../src/io/import.js';

describe('RTF \\uN fallbacks', () => {
  it('skips exactly \\ucN fallback units, per group', () => {
    expect(rtfToText("{\\rtf1\\uc0 \\u8217\\'e9 x}")).toBe('’é x');
    expect(rtfToText('{\\rtf1\\uc0 \\u8220 quoted}')).toBe('“quoted');
    expect(rtfToText("{\\rtf1 \\u8220\\'93q}")).toBe('“q');
    expect(rtfToText("{\\rtf1 {\\uc2 \\u8220\\'81\\'40a}\\u8220?b}")).toBe('“a“b');
  });
});
