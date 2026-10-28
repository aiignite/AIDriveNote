import React, { useCallback, useEffect, useState } from 'react';
import { Plug, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApp } from '../../contexts/AppContext';
import {
  mcpApi,
  type McpAuditItem,
  type McpServerInfo,
  type McpToolInfo,
} from '../../services/mcp';

const POLICY_LABEL: Record<McpToolInfo['approvalPolicy'], string> = {
  auto: '自动（聊天中可调用）',
  ask: '需确认（仅手动执行）',
  deny: '禁止',
};

const McpSettingsPage: React.FC = () => {
  const { theme } = useApp();
  const isDark = theme === 'dark';
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [audit, setAudit] = useState<McpAuditItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [serverList, auditList] = await Promise.all([mcpApi.list(), mcpApi.audit(30)]);
      setServers(serverList);
      setAudit(auditList);
    } catch {
      toast.error('加载 MCP 配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    if (!name.trim()) {
      toast.error('请填写名称');
      return;
    }
    if (transport === 'http' && !url.trim()) {
      toast.error('请填写服务器地址');
      return;
    }
    if (transport === 'stdio' && !command.trim()) {
      toast.error('请填写 stdio 命令');
      return;
    }
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        headers = JSON.parse(headersText) as Record<string, string>;
      } catch {
        toast.error('请求头必须是合法 JSON');
        return;
      }
    }
    try {
      const server = await mcpApi.create({
        name: name.trim(),
        url: transport === 'http' ? url.trim() : '',
        transport,
        command: transport === 'stdio' ? command.trim() : undefined,
        args: transport === 'stdio'
          ? argsText.split('\n').map(item => item.trim()).filter(Boolean)
          : undefined,
        headers,
      });
      setName('');
      setUrl('');
      setCommand('');
      setArgsText('');
      setHeadersText('');
      toast.success('服务器已添加，正在发现工具…');
      setBusyId(server.id);
      try {
        const tools = await mcpApi.discover(server.id);
        toast.success(`发现 ${tools.length} 个工具`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '工具发现失败');
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleDiscover = async (server: McpServerInfo) => {
    setBusyId(server.id);
    try {
      const tools = await mcpApi.discover(server.id);
      toast.success(`发现 ${tools.length} 个工具`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '工具发现失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleServer = async (server: McpServerInfo) => {
    try {
      await mcpApi.update(server.id, { isEnabled: !server.isEnabled });
      await load();
    } catch {
      toast.error('更新失败');
    }
  };

  const handleDelete = async (server: McpServerInfo) => {
    try {
      await mcpApi.remove(server.id);
      toast.success('已删除');
      await load();
    } catch {
      toast.error('删除失败');
    }
  };

  const handleToggleTool = async (tool: McpToolInfo) => {
    try {
      await mcpApi.updateTool(tool.id, { isEnabled: !tool.isEnabled });
      await load();
    } catch {
      toast.error('更新失败');
    }
  };

  const handlePolicy = async (tool: McpToolInfo, approvalPolicy: McpToolInfo['approvalPolicy']) => {
    try {
      await mcpApi.updateTool(tool.id, { approvalPolicy });
      await load();
    } catch {
      toast.error('更新失败');
    }
  };

  const inputClass = `w-full rounded-lg border px-3 py-2 text-sm outline-none ${
    isDark
      ? 'bg-gray-900 border-gray-700 text-gray-100 placeholder-gray-600 focus:border-orange-500'
      : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-orange-400'
  }`;
  const cardClass = `rounded-2xl border p-4 ${isDark ? 'bg-gray-900 border-gray-800' : 'bg-white border-gray-200'}`;

  return (
    <div className={`h-full overflow-y-auto p-6 ${isDark ? 'text-gray-100' : 'text-gray-800'}`}>
      <div className="max-w-4xl mx-auto space-y-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <Plug size={20} className="text-orange-500" /> MCP 工具
          </h1>
          <p className={`mt-1 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            连接外部 MCP 服务器，把它们的工具交给 AI 使用。默认只允许公网地址；内网地址需在服务端开启
            MCP_ALLOW_PRIVATE_HOSTS。
          </p>
        </header>

        <section className={cardClass}>
          <h2 className="mb-3 text-sm font-semibold">添加服务器</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="名称，如「本地文件助手」" className={inputClass} />
            <select
              value={transport}
              onChange={e => setTransport(e.target.value as 'http' | 'stdio')}
              className={inputClass}
            >
              <option value="http">HTTP / SSE（远程）</option>
              <option value="stdio">stdio（本机命令）</option>
            </select>
            {transport === 'http' ? (
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp" className={`${inputClass} sm:col-span-2`} />
            ) : (
              <>
                <input value={command} onChange={e => setCommand(e.target.value)} placeholder="命令，如 python / npx / uvx" className={inputClass} />
                <input value={argsText} onChange={e => setArgsText(e.target.value)} placeholder="参数（每行一个）" className={inputClass} />
              </>
            )}
          </div>
          <textarea
            value={headersText}
            onChange={e => setHeadersText(e.target.value)}
            placeholder='可选：请求头 JSON，如 {"Authorization": "Bearer xxx"}'
            rows={2}
            className={`mt-3 ${inputClass} font-mono text-xs`}
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={loading || busyId !== null}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          >
            <Plus size={13} /> 添加并发现工具
          </button>
        </section>

        <section className="space-y-3">
          {servers.length === 0 && (
            <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>还没有配置 MCP 服务器。</p>
          )}
          {servers.map(server => (
            <div key={server.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold">{server.name}</h3>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                      server.isEnabled
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                    }`}>
                      {server.isEnabled ? '已启用' : '已停用'}
                    </span>
                  </div>
                  <p className={`mt-0.5 truncate text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {server.transport === 'stdio'
                      ? `stdio: ${server.command || ''} ${(server.args || []).join(' ')}`
                      : server.url}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" onClick={() => void handleToggleServer(server)} className="rounded-lg border px-2 py-1 text-[11px] hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                    {server.isEnabled ? '停用' : '启用'}
                  </button>
                  <button type="button" onClick={() => void handleDiscover(server)} disabled={busyId === server.id} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800">
                    <RefreshCw size={11} className={busyId === server.id ? 'animate-spin' : ''} /> 发现
                  </button>
                  <button type="button" onClick={() => void handleDelete(server)} className="rounded-lg p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {server.tools.length === 0 ? (
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>尚未发现工具，点「发现」拉取列表。</p>
                ) : server.tools.map(tool => (
                  <div key={tool.id} className={`rounded-xl border p-2.5 ${isDark ? 'border-gray-800 bg-gray-950/40' : 'border-gray-100 bg-gray-50/60'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex min-w-0 items-center gap-2 text-xs font-medium">
                        <input type="checkbox" checked={tool.isEnabled} onChange={() => void handleToggleTool(tool)} className="accent-orange-600" />
                        <span className="truncate">{tool.name}</span>
                      </label>
                      <select
                        value={tool.approvalPolicy}
                        onChange={e => void handlePolicy(tool, e.target.value as McpToolInfo['approvalPolicy'])}
                        className={`rounded-lg border px-2 py-1 text-[11px] ${isDark ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}
                      >
                        {Object.entries(POLICY_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </div>
                    {tool.description && (
                      <p className={`mt-1 line-clamp-2 text-[11px] ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>{tool.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className={cardClass}>
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <ShieldAlert size={15} className="text-orange-500" /> 调用审计
          </h2>
          {audit.length === 0 ? (
            <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>暂无调用记录。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className={isDark ? 'text-gray-500' : 'text-gray-400'}>
                  <tr>
                    <th className="py-1 pr-3 font-medium">时间</th>
                    <th className="py-1 pr-3 font-medium">工具</th>
                    <th className="py-1 pr-3 font-medium">状态</th>
                    <th className="py-1 font-medium">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map(item => (
                    <tr key={item.id} className={isDark ? 'text-gray-300' : 'text-gray-700'}>
                      <td className="py-1 pr-3">{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '-'}</td>
                      <td className="py-1 pr-3">{item.toolName}</td>
                      <td className={`py-1 pr-3 ${item.status === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{item.status}</td>
                      <td className="py-1">{item.durationMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default McpSettingsPage;
