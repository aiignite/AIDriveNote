/**
 * Vite 构建配置。
 *
 * 除常规构建外，这里还通过自定义插件在构建结束时生成 Service Worker 的
 * 预缓存清单（dist/sw-manifest.json），让懒加载的页面 chunk 也能被离线缓存。
 * 该能力替代 vite-plugin-pwa 的 precache，保持项目零新增依赖。
 */
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** 构建产物目录（vite root 即 frontend/） */
const DIST_DIR = path.resolve(process.cwd(), 'dist');

/** 构建期清单文件名（仅首屏必需资源，SW 安装时同步预缓存） */
const CRITICAL_MANIFEST = 'sw-manifest.json';
/** 构建期清单文件名（其余全部产物，由页面空闲时触发后台预热） */
const REST_MANIFEST = 'sw-manifest-rest.json';

/** Vite 产物文件名末尾的内容 hash 形态（8 位，可能含 - 与 _） */
const ASSET_HASH_RE = /-[A-Za-z0-9_-]{8}$/;

/** 需要被清理的 KaTeX 冗余字体格式（woff2 已覆盖全部现代浏览器） */
const LEGACY_FONT_RE = /^(KaTeX_.+)\.(woff|ttf)$/;

/**
 * 递归收集目录下所有文件的相对路径。
 * @param dir 当前目录绝对路径
 * @param prefix 当前相对路径前缀
 * @returns 相对路径列表（统一使用正斜杠）
 */
function collectFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectFiles(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 生成 Service Worker 预缓存清单的构建插件。
 *
 * 为什么拆成两份清单：页面全部是懒加载 chunk，若把全部产物都塞进安装期预缓存，
 * 首次访问就要下载 3 MB 以上（编辑器、KaTeX 字体、导出模块、从未访问的页面），
 * 这些字节会与首屏请求争抢带宽，弱网下首屏被拖到几十秒。
 *
 * 因此按「是否首屏必需」切分：
 * - sw-manifest.json：index.html 直接引用的入口 JS/CSS 与图标 —— 安装期同步预缓存，
 *   保证离线时至少能打开应用壳；
 * - sw-manifest-rest.json：其余全部产物 —— 页面空闲后由 SW 串行后台预热，
 *   既不影响首屏，又能在用户真正断网前把懒加载页面补齐。
 *
 * 首屏必需资源从 index.html 解析得出，无需手工维护。
 * 若手动改用 vite-plugin-pwa，可移除本插件。
 * @param base 构建 base 路径（子路径部署时为 /note/）
 * @returns Vite 插件
 */
function swPrecachePlugin(base: string): Plugin {
  return {
    name: 'aidrivenote-sw-precache',
    apply: 'build',
    /**
     * 产物完全落盘后扫描 dist 并写出两份清单。
     * closeBundle 是构建流程的最后一个钩子，此时 index.html 与 public/ 拷贝均已完成。
     */
    closeBundle() {
      if (!fs.existsSync(DIST_DIR)) return;

      const prefix = base.endsWith('/') ? base : `${base}/`;
      const all = collectFiles(DIST_DIR, '').filter(
        (rel) =>
          rel !== 'sw.js' &&
          rel !== CRITICAL_MANIFEST &&
          rel !== REST_MANIFEST,
      );

      // 解析 index.html 的 src / href，得到首屏必需资源
      const html = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf-8');
      const critical = new Set<string>(['index.html']);
      const refRe = /(?:src|href)="([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = refRe.exec(html)) !== null) {
        let ref = match[1].split('?')[0].split('#')[0];
        if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
        if (ref.startsWith(prefix)) ref = ref.slice(prefix.length);
        else if (ref.startsWith('/')) ref = ref.slice(1);
        else if (ref.startsWith('./')) ref = ref.slice(2);
        if (all.includes(ref)) critical.add(ref);
      }

      const toUrls = (rels: string[]): string[] => rels.map((rel) => `${prefix}${rel}`);

      fs.writeFileSync(
        path.join(DIST_DIR, CRITICAL_MANIFEST),
        JSON.stringify(toUrls([...critical]), null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(DIST_DIR, REST_MANIFEST),
        JSON.stringify(toUrls(all.filter((rel) => !critical.has(rel))), null, 2),
        'utf-8',
      );
    },
  };
}

/**
 * 清理 KaTeX 字体的冗余备份格式（woff / ttf）。
 *
 * KaTeX 的每个 @font-face 都声明 woff2 / woff / ttf 三种格式，
 * 且 woff2 排在 src 首位，所有现代浏览器都会选中它，
 * 后两种格式永远不会被请求，属于纯冗余体积（约 640 KB）。
 *
 * 按「逻辑字体族」而非文件名匹配：Vite 会为每种格式生成独立 hash，
 * 同族不同格式的文件名并不相同。仅当同族存在 woff2 时才删除，
 * 因此 KaTeX_Size3-Regular 这种上游未提供 woff2 的字体会被保留。
 *
 * @returns 被删除的文件数
 */
function pruneKatexLegacyFonts(): number {
  const assetsDir = path.join(DIST_DIR, 'assets');
  if (!fs.existsSync(assetsDir)) return 0;

  const files = fs.readdirSync(assetsDir);
  const familiesWithWoff2 = new Set(
    files
      .filter((name) => name.endsWith('.woff2'))
      .map((name) => name.replace(/\.woff2$/, '').replace(ASSET_HASH_RE, '')),
  );

  let removed = 0;
  for (const name of files) {
    const matched = name.match(LEGACY_FONT_RE);
    if (!matched) continue;
    const family = matched[1].replace(ASSET_HASH_RE, '');
    if (!familiesWithWoff2.has(family)) continue; // 无 woff2 可用，保留原格式
    fs.unlinkSync(path.join(assetsDir, name));
    removed += 1;
  }
  return removed;
}

/**
 * 裁剪 KaTeX 冗余字体格式的构建插件。
 * 必须排在清单生成插件之前：先删文件，再扫描产物，
 * 否则已删除的字体仍会被写进预缓存清单，导致 SW 预缓存 404。
 * @returns Vite 插件
 */
function katexFontPrunePlugin(): Plugin {
  return {
    name: 'aidrivenote-katex-font-prune',
    apply: 'build',
    closeBundle() {
      if (!fs.existsSync(DIST_DIR)) return;
      const removed = pruneKatexLegacyFonts();
      if (removed > 0) {
        console.log(`[katex-font-prune] 已移除 ${removed} 个冗余 woff/ttf 字体文件`);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE_PATH || '/';

  return {
    base,
    server: {
      port: 3270,
      host: '0.0.0.0',
      proxy: {
        [base === '/' ? '/api' : `${base.replace(/\/$/, '')}/api`]: {
          target: 'http://localhost:3275',
          changeOrigin: true,
          timeout: 600_000,
        },
      },
    },
    plugins: [react(), katexFontPrunePlugin(), swPrecachePlugin(base)],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
  };
});
