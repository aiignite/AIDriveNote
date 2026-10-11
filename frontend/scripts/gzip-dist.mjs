/**
 * 构建期预压缩：为 dist 内的文本资源生成同名 .gz（gzip -9 级别）。
 *
 * 配合 nginx `gzip_static on` 使用：命中时直接回源预压缩文件，
 * 相比运行时 level 6 动态压缩，压缩率更高且不消耗服务器 CPU。
 * 跨机房高延迟链路下，响应体更小意味着更少的传输时间。
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 需要预压缩的文本类扩展名 */
const TEXT_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.svg', '.txt', '.xml', '.webmanifest']);
/** 小于该字节数的文件不值得预压缩（与 nginx gzip_min_length 对齐） */
const MIN_BYTES = 1024;

/** 递归收集目录下的所有文件路径 */
function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
let count = 0;
let saved = 0;

for (const file of walk(distDir)) {
  if (!TEXT_EXTENSIONS.has(file.slice(file.lastIndexOf('.')))) continue;
  if (file.endsWith('.gz')) continue;
  const raw = readFileSync(file);
  if (raw.length < MIN_BYTES) continue;
  const gz = gzipSync(raw, { level: 9 });
  if (gz.length >= raw.length) continue;
  writeFileSync(`${file}.gz`, gz);
  count += 1;
  saved += raw.length - gz.length;
}

console.log(`[gzip-dist] 预压缩 ${count} 个文件，共减少 ${(saved / 1024 / 1024).toFixed(2)} MB`);
