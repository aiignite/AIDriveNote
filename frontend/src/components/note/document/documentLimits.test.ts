import { describe, expect, it } from 'vitest';
import { clamp, decodeText, formatBytes } from './documentLimits';

describe('documentLimits', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('clamps numbers', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });

  it('decodes UTF-8 with BOM', () => {
    const payload = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('中文')]);
    expect(decodeText(payload)).toBe('中文');
  });

  it('decodes GB18030 HTML', () => {
    const head = new TextEncoder().encode(
      '<html><head><meta charset="gb18030"></head><body>',
    );
    const tail = new TextEncoder().encode('</body></html>');
    // GBK/GB18030 下 "验收" 的字节
    const gbk = new Uint8Array([0xd1, 0xe9, 0xca, 0xd5]);
    const payload = new Uint8Array([...head, ...gbk, ...tail]);
    expect(decodeText(payload)).toContain('验收');
  });
});
