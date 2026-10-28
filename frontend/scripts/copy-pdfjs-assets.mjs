/**
 * 把 pdf.js 的 cmaps / 标准字体 / worker 复制到 public/pdfjs。
 * 这些资源体积大且版本随 pdfjs-dist 固定，构建期复制可避免运行时依赖 CDN。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/pdfjs-dist');
const target = resolve(root, 'public/pdfjs');

if (!existsSync(source)) {
  console.warn('[pdfjs] 未找到 pdfjs-dist，跳过资源复制');
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const dir of ['cmaps', 'standard_fonts']) {
  const from = resolve(source, dir);
  if (existsSync(from)) cpSync(from, resolve(target, dir), { recursive: true });
}

const worker = resolve(source, 'legacy/build/pdf.worker.min.mjs');
if (existsSync(worker)) {
  cpSync(worker, resolve(target, 'pdf.worker.min.mjs'));
} else {
  const fallback = resolve(source, 'build/pdf.worker.min.mjs');
  if (existsSync(fallback)) cpSync(fallback, resolve(target, 'pdf.worker.min.mjs'));
}

console.log('[pdfjs] 资源已复制到 public/pdfjs');
