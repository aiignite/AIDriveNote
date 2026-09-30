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

/**
 * 生成 Service Worker 预缓存清单的构建插件。
 *
 * 为什么需要它：页面全部是懒加载 chunk，首屏只加载入口文件。
 * 若只依赖运行时缓存，用户从未访问过的页面在离线时必然白屏。
 * 因此必须在构建期扫描产物、把全部文件名（含 hash）写成清单交给 SW 预缓存。
 * 若手动改用 vite-plugin-pwa，可移除本插件。
 * @param base 构建 base 路径（子路径部署时为 /note/）
 * @returns Vite 插件
 */
function swPrecachePlugin(base: string): Plugin {
  return {
    name: 'aidrivenote-sw-precache',
    apply: 'build',
    /**
     * 产物完全落盘后扫描 dist 并写出清单。
     * closeBundle 是构建流程的最后一个钩子，此时 index.html 与 public/ 拷贝均已完成。
     */
    closeBundle() {
      if (!fs.existsSync(DIST_DIR)) return;

      /**
       * 递归收集目录下所有文件的相对路径。
       * @param dir 当前目录绝对路径
       * @param prefix 当前相对路径前缀
       * @returns 相对路径列表（统一使用正斜杠）
       */
      const collect = (dir: string, prefix: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            out.push(...collect(path.join(dir, entry.name), rel));
          } else {
            out.push(rel);
          }
        }
        return out;
      };

      const prefix = base.endsWith('/') ? base : `${base}/`;
      const urls = collect(DIST_DIR, '')
        // SW 自身与清单文件不应被预缓存（前者由浏览器管理，后者必须每次走网络）
        .filter((rel) => rel !== 'sw.js' && rel !== 'sw-manifest.json')
        .map((rel) => `${prefix}${rel}`);

      fs.writeFileSync(
        path.join(DIST_DIR, 'sw-manifest.json'),
        JSON.stringify(urls, null, 2),
        'utf-8',
      );
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
    plugins: [react(), swPrecachePlugin(base)],
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
