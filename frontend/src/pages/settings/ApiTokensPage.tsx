/**
 * 访问令牌设置页。
 *
 * 用于签发 / 查看 / 撤销个人访问令牌（PAT），供 Claude Desktop、Cursor、
 * Trae 等外部 Agent 通过 MCP 把文档写入当前笔记。
 * 明文令牌只在创建后展示一次，页面会同时给出可直接复制的 MCP 配置片段。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { apiTokenApi, type ApiToken } from '../../services/apiTokens';

/** 有效期选项：label 为展示文案，value 为天数（0 表示长期有效） */
const EXPIRES_OPTIONS = [
  { label: '长期有效', value: 0 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
  { label: '365 天', value: 365 },
];

/**
 * 格式化时间为 YYYY-MM-DD HH:mm。
 * @param value ISO 时间字符串
 * @returns 格式化结果；空值或非法值返回 '—'
 */
function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const ApiTokensPage: React.FC = () => {
  const { theme } = useApp();
  const isDark = theme === 'dark';

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(0);
  /** 刚创建的明文令牌，仅用于展示一次 */
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  /** 记录刚复制成功的目标，用于按钮反馈 */
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  /**
   * 拉取令牌列表。
   */
  const loadTokens = useCallback(async () => {
    setLoading(true);
    try {
      setTokens(await apiTokenApi.list());
    } catch {
      toast.error('加载访问令牌失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  /**
   * 复制文本到剪贴板，并在按钮上给出短暂反馈。
   * @param text 待复制内容
   * @param key 反馈标识
   */
  const copyText = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1500);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败，请手动选择文本复制');
    }
  }, []);

  /**
   * 签发新令牌。
   */
  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('请先填写令牌名称');
      return;
    }
    setCreating(true);
    try {
      const created = await apiTokenApi.create({
        name: trimmed,
        expiresInDays: expiresInDays > 0 ? expiresInDays : undefined,
      });
      setCreatedToken(created.token);
      setName('');
      setExpiresInDays(0);
      toast.success('令牌已生成，请立即复制保存');
      await loadTokens();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成令牌失败');
    } finally {
      setCreating(false);
    }
  };

  /**
   * 撤销令牌（二次确认，避免误点）。
   * @param token 目标令牌
   */
  const handleRevoke = async (token: ApiToken) => {
    if (!window.confirm(`确定撤销令牌「${token.name}」？撤销后使用该令牌的 Agent 将立即失效。`)) {
      return;
    }
    try {
      await apiTokenApi.revoke(token.id);
      toast.success('令牌已撤销');
      await loadTokens();
    } catch {
      toast.error('撤销失败');
    }
  };

  /** 后端 API 根地址（绝对地址），用于生成 MCP 配置片段 */
  const baseUrl = useMemo(() => {
    const apiBase = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';
    if (apiBase.startsWith('http')) return apiBase;
    return `${window.location.origin}${apiBase}`;
  }, []);

  /** 可直接粘贴到客户端 MCP 配置文件的 JSON 片段 */
  const mcpConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            aidrivenote: {
              command: 'uvx',
              args: [
                '--from',
                'git+https://github.com/aiignite/AIDriveNote.git@main#subdirectory=mcp-server',
                'aidrivenote-mcp',
              ],
              env: {
                AIDRIVENOTE_BASE_URL: baseUrl,
                AIDRIVENOTE_API_TOKEN: createdToken ?? 'adn_粘贴上面生成的令牌',
              },
            },
          },
        },
        null,
        2,
      ),
    [baseUrl, createdToken],
  );

  const card = 'bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm';
  const muted = isDark ? 'text-gray-400' : 'text-gray-500';
  const inputClass = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500/40 ${
    isDark ? 'bg-gray-900 border-gray-700 text-gray-100' : 'bg-white border-gray-200 text-gray-900'
  }`;

  return (
    <div className="h-full min-h-0 overflow-auto bg-slate-50 dark:bg-gray-950 p-4 lg:p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        {/* 标题与说明 */}
        <div className={card}>
          <div className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
                <KeyRound className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">访问令牌</h2>
                <p className={`text-sm ${muted}`}>
                  让 Claude Desktop / Cursor / Trae 等 Agent 通过 MCP 把找到的文档写入你的笔记
                </p>
              </div>
            </div>
            <p className={`mt-4 text-sm ${muted}`}>
              令牌相当于账号的长期通行证，请像密码一样保管：只粘贴到本机 MCP 配置中，
              不要提交到公开仓库。若怀疑泄露，立即在本页撤销。
            </p>
          </div>
        </div>

        {/* 新建令牌 */}
        <div className={card}>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">新建令牌</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label className={`block text-xs mb-1 ${muted}`}>名称</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：Claude Desktop"
                  className={inputClass}
                />
              </div>
              <div className="sm:w-40">
                <label className={`block text-xs mb-1 ${muted}`}>有效期</label>
                <select
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                  className={inputClass}
                >
                  {EXPIRES_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {creating ? '生成中...' : '生成令牌'}
              </button>
            </div>
          </div>
        </div>

        {/* 明文令牌：仅创建后展示一次 */}
        {createdToken && (
          <div
            className={`rounded-2xl border p-5 ${
              isDark ? 'border-amber-900/60 bg-amber-950/40' : 'border-amber-200 bg-amber-50'
            }`}
          >
            <div className={`flex items-start gap-2 text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>此令牌仅显示一次，关闭后无法再次查看。请立即复制并保存到 MCP 配置中。</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <code
                className={`flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs font-mono ${
                  isDark ? 'bg-gray-900 text-amber-200' : 'bg-white text-amber-800'
                }`}
              >
                {createdToken}
              </code>
              <button
                type="button"
                onClick={() => void copyText(createdToken, 'plain')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  isDark ? 'bg-amber-900/60 text-amber-100 hover:bg-amber-900' : 'bg-amber-600 text-white hover:bg-amber-700'
                }`}
              >
                {copiedKey === 'plain' ? <Check size={12} /> : <Copy size={12} />}
                复制
              </button>
              <button
                type="button"
                onClick={() => setCreatedToken(null)}
                className={`rounded-lg px-3 py-2 text-xs font-medium ${
                  isDark ? 'text-amber-300 hover:bg-amber-900/40' : 'text-amber-700 hover:bg-amber-100'
                }`}
              >
                我已保存
              </button>
            </div>
          </div>
        )}

        {/* 令牌列表 */}
        <div className={card}>
          <div className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">已签发令牌</h3>
              <button
                type="button"
                onClick={() => void loadTokens()}
                className={`flex items-center gap-1 text-xs ${muted} hover:text-orange-600`}
              >
                <RefreshCw size={12} />
                刷新
              </button>
            </div>

            {loading ? (
              <div className={`flex items-center gap-2 text-sm ${muted}`}>
                <Loader2 size={14} className="animate-spin" />
                加载中...
              </div>
            ) : tokens.length === 0 ? (
              <p className={`text-sm ${muted}`}>暂无令牌，按上方步骤生成一个即可开始使用 MCP。</p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {tokens.map((token) => (
                  <li key={token.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {token.name}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            token.isRevoked
                              ? isDark
                                ? 'bg-gray-700 text-gray-300'
                                : 'bg-gray-100 text-gray-500'
                              : isDark
                                ? 'bg-emerald-900/50 text-emerald-300'
                                : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {token.isRevoked ? '已撤销' : '生效中'}
                        </span>
                      </div>
                      <div className={`mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs ${muted}`}>
                        <span className="font-mono">{token.tokenPrefix}...</span>
                        <span>创建 {formatTime(token.createdAt)}</span>
                        <span>最近使用 {formatTime(token.lastUsedAt)}</span>
                        <span>过期 {token.expiresAt ? formatTime(token.expiresAt) : '永久'}</span>
                      </div>
                    </div>
                    {!token.isRevoked && (
                      <button
                        type="button"
                        onClick={() => void handleRevoke(token)}
                        title="撤销令牌"
                        className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 transition-colors"
                      >
                        <Trash2 size={12} />
                        撤销
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* MCP 配置片段 */}
        <div className={card}>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">MCP 配置片段</h3>
            <p className={`text-xs mb-3 ${muted}`}>
              复制到客户端的 MCP 配置文件中：Claude Desktop 为
              <code className="mx-1 rounded bg-gray-100 dark:bg-gray-700 px-1">~/Library/Application Support/Claude/claude_desktop_config.json</code>，
              Cursor 为项目内 <code className="mx-1 rounded bg-gray-100 dark:bg-gray-700 px-1">.cursor/mcp.json</code>。
              修改后需重启客户端。
            </p>
            <div className="relative">
              <pre
                className={`overflow-x-auto rounded-xl p-3 text-xs leading-relaxed ${
                  isDark ? 'bg-gray-900 text-gray-200' : 'bg-slate-900 text-slate-100'
                }`}
              >
                <code>{mcpConfig}</code>
              </pre>
              <button
                type="button"
                onClick={() => void copyText(mcpConfig, 'mcp')}
                className="absolute right-2 top-2 flex items-center gap-1.5 rounded-lg bg-orange-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-orange-700 transition-colors"
              >
                {copiedKey === 'mcp' ? <Check size={12} /> : <Copy size={12} />}
                复制
              </button>
            </div>
            <p className={`mt-3 text-xs ${muted}`}>
              完整安装说明（含 pipx / uv 本地安装、私有仓库与验证方式）见仓库内
              <code className="mx-1 rounded bg-gray-100 dark:bg-gray-700 px-1">mcp-server/README.md</code>。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApiTokensPage;