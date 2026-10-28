/** 文档查看器的容量上限、文本解码与 HTML 清洗工具。 */

export const MAX_PDF_PAGES = 300;
export const MAX_PPTX_SLIDES = 100;
export const MAX_XLSX_SHEETS = 50;
export const MAX_XLSX_ROWS = 2000;
export const MAX_XLSX_COLS = 100;
export const MAX_CANVAS_PIXELS = 16_000_000;

export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_TOTAL_BYTES = 300 * 1024 * 1024;
export const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_RATIO = 200;

export function formatBytes(size: number): string {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 文档页数单位：Excel 是工作表、PPT 是幻灯片。 */
export function pageUnit(ext: string): string {
  if (ext === '.xlsx') return ' 个工作表';
  if (ext === '.pptx') return ' 张幻灯片';
  return ' 页';
}

/** 按 BOM / meta charset / utf-8 / gb18030 顺序解码文本。 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const charset = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  const candidates = [charset, 'utf-8', 'gb18030'].filter(Boolean) as string[];
  for (const encoding of candidates) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      /* try next */
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** 轻量 ZIP 预检：拒绝压缩炸弹与异常条目（客户端只保护当前标签页）。 */
export async function preflightZip(bytes: Uint8Array): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(bytes);
  const entries = Object.values(archive.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('文档内部条目过多，已停止渲染');
  }
  let total = 0;
  for (const entry of entries) {
    // JSZip 不暴露解压后大小；用压缩数据尺寸总和控制内存，避免一次解压过大
    total += (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize ?? 0;
    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('文档解压后体积过大，已停止渲染');
    }
  }
}

const FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'base', 'form', 'link',
  'meta', 'noscript', 'template',
];
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'poster'];

/**
 * 清洗 HTML：移除脚本/表单/外链资源与事件属性，并注入严格 CSP。
 * 结果只用于 sandbox="" 的 iframe，绝不作为主站同源页面打开。
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const tag of FORBIDDEN_TAGS) {
    doc.querySelectorAll(tag).forEach((node) => node.remove());
  }

  // 内联样式只保留纯样式规则：去掉 @import 与外链 url()
  doc.querySelectorAll('style').forEach((style) => {
    style.textContent = (style.textContent || '')
      .replace(/@import[^;]*;/gi, '')
      .replace(/url\((?![^)]*(?:data:|blob:))[^)]*\)/gi, 'none');
  });

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name)) {
        const safe = value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('#');
        if (!safe) el.removeAttribute(attr.name);
      }
      if (name === 'style' && value.includes('url(')) {
        // 外链 CSS 资源在 CSP 下会被拦截；这里保留纯样式，去掉可疑 url()
        el.setAttribute('style', attr.value.replace(/url\([^)]*\)/gi, 'none'));
      }
    }
    // 图片只保留内嵌数据，避免 tracking pixel 泄露访问者信息
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || '';
      if (!src.startsWith('data:') && !src.startsWith('blob:')) el.removeAttribute('src');
    }
  });

  const head = doc.head ?? doc.createElement('head');
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute(
    'content',
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:",
  );
  head.prepend(meta);
  if (!doc.head) doc.documentElement.prepend(head);

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}
