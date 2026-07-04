import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Bot,
  Copy,
  Download,
  Filter,
  LayoutGrid,
  List,
  Maximize2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { aiApi, type AIAssistant, type AIAssistantInput } from '../../services/ai/ai';
import ConfirmDialog from '../../components/ConfirmDialog';
import { AssistantForm, getAvatarIcon } from '../../components/ai/AssistantForm';
import AssistantSkillsModal from '../../components/ai/AssistantSkillsModal';

const formatTime = (value?: string) => {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('zh-CN');
};

const AIAssistantsPage: React.FC = () => {
  const [assistants, setAssistants] = useState<AIAssistant[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showForm, setShowForm] = useState(false);
  const [editingAssistant, setEditingAssistant] = useState<AIAssistant | null>(null);
  const [skillsAssistant, setSkillsAssistant] = useState<AIAssistant | null>(null);
  const [assistantToDelete, setAssistantToDelete] = useState<AIAssistant | null>(null);
  const [deletingAssistantId, setDeletingAssistantId] = useState<string | null>(null);
  const [cloningAssistantId, setCloningAssistantId] = useState<string | null>(null);
  const [settingDefaultAssistantId, setSettingDefaultAssistantId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [systemFilter, setSystemFilter] = useState<string>('all');
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const loadAssistants = useCallback(async () => {
    setLoading(true);
    try {
      setAssistants(await aiApi.listAssistants());
    } catch (error) {
      console.error('Failed to load AI assistants:', error);
      toast.error('加载 AI 助手失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAssistants();
  }, [loadAssistants]);

  const categoryOptions = useMemo(
    () =>
      Array.from(
        new Set(
          assistants
            .map((assistant) => assistant.category)
            .filter((category): category is string => Boolean(category)),
        ),
      ).sort(),
    [assistants],
  );

  const filteredAssistants = useMemo(() => {
    const keyword = deferredSearchTerm.trim().toLowerCase();
    return assistants.filter((assistant) => {
      if (categoryFilter !== 'all' && (assistant.category || '未分类') !== categoryFilter) {
        return false;
      }
      if (systemFilter === 'system' && !assistant.isSystem) return false;
      if (systemFilter === 'custom' && assistant.isSystem) return false;
      if (!keyword) return true;
      return [assistant.name, assistant.description, assistant.role, assistant.category, assistant.model]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [assistants, categoryFilter, deferredSearchTerm, systemFilter]);

  const openCreate = useCallback(() => {
    setEditingAssistant(null);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((assistant: AIAssistant) => {
    setEditingAssistant(assistant);
    setShowForm(true);
  }, []);

  const handleSave = useCallback(
    async (data: AIAssistantInput) => {
      try {
        if (editingAssistant) {
          await aiApi.updateAssistant(editingAssistant.id, data);
          toast.success('AI 助手已更新');
        } else {
          await aiApi.createAssistant({
            ...data,
            name: data.name || '',
            systemPrompt: data.systemPrompt || '',
          });
          toast.success('AI 助手已创建');
        }
        setShowForm(false);
        setEditingAssistant(null);
        await loadAssistants();
      } catch (error) {
        console.error('Failed to save AI assistant:', error);
        toast.error('保存 AI 助手失败');
      }
    },
    [editingAssistant, loadAssistants],
  );

  const handleDelete = useCallback((assistant: AIAssistant) => {
    if (assistant.isSystem) {
      toast.error('系统助手不允许删除');
      return;
    }
    setAssistantToDelete(assistant);
  }, []);

  const confirmDeleteAssistant = useCallback(async () => {
    if (!assistantToDelete) return;
    setDeletingAssistantId(assistantToDelete.id);
    try {
      await aiApi.deleteAssistant(assistantToDelete.id);
      toast.success('AI 助手已删除');
      setAssistantToDelete(null);
      await loadAssistants();
    } catch (error) {
      console.error('Failed to delete AI assistant:', error);
      toast.error('删除 AI 助手失败');
    } finally {
      setDeletingAssistantId(null);
    }
  }, [assistantToDelete, loadAssistants]);

  const handleSetDefault = useCallback(
    async (assistant: AIAssistant) => {
      setSettingDefaultAssistantId(assistant.id);
      try {
        await aiApi.updateAssistant(assistant.id, { isDefault: true });
        toast.success(`已将「${assistant.name}」设为默认助手`);
        await loadAssistants();
      } catch (error) {
        console.error('Failed to set default assistant:', error);
        toast.error('设置默认助手失败');
      } finally {
        setSettingDefaultAssistantId(null);
      }
    },
    [loadAssistants],
  );

  const handleCloneAssistant = useCallback(
    async (assistant: AIAssistant) => {
      setCloningAssistantId(assistant.id);
      try {
        await aiApi.cloneAssistant(assistant.id);
        toast.success('AI 助手已克隆');
        await loadAssistants();
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        toast.error(`克隆失败：${msg}`);
      } finally {
        setCloningAssistantId(null);
      }
    },
    [loadAssistants],
  );

  const handleExport = useCallback(() => {
    const csv = [
      ['名称', '角色', '分类', '模型', '温度', '系统助手', '默认'].join(','),
      ...filteredAssistants.map((assistant) =>
        [
          assistant.name,
          assistant.role || '',
          assistant.category || '',
          assistant.model || '',
          String(assistant.temperature ?? ''),
          assistant.isSystem ? 'Y' : 'N',
          assistant.isDefault ? 'Y' : 'N',
        ].join(','),
      ),
    ].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ai-assistants-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [filteredAssistants]);

  return (
    <div
      className={`h-full min-h-0 overflow-auto bg-slate-50 dark:bg-gray-950 p-4 lg:p-6 ${
        isFullscreen ? 'fixed inset-0 z-50' : ''
      }`}
    >
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm">
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                  <Bot className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">AI 助手管理</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    配置助手提示词、绑定模型与技能，控制侧栏 AI 行为
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleExport}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="导出CSV"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  onClick={() => void loadAssistants()}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="刷新"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setIsFullscreen((value) => !value)}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="全屏"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="搜索助手名称、角色、模型..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAdvancedSearch((value) => !value)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border ${
                showAdvancedSearch
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-300'
                  : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              <Filter className="w-4 h-4" /> 高级搜索
            </button>
            <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1 gap-1">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-2 rounded-md transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-white dark:bg-gray-600 shadow-sm text-emerald-600'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`p-2 rounded-md transition-colors ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-gray-600 shadow-sm text-emerald-600'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                <List className="w-4 h-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={openCreate}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" /> 新增助手
            </button>
          </div>
        </div>

        {showAdvancedSearch && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm"
              >
                <option value="all">全部分类</option>
                {categoryOptions.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <select
                value={systemFilter}
                onChange={(event) => setSystemFilter(event.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm"
              >
                <option value="all">全部类型</option>
                <option value="system">系统助手</option>
                <option value="custom">自定义助手</option>
              </select>
              <span className="flex items-center px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                {filteredAssistants.length}/{assistants.length} 个助手
              </span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-10 text-center text-sm text-gray-500">
            <Bot className="w-8 h-8 mx-auto mb-3 animate-pulse text-emerald-300" />
            正在加载 AI 助手...
          </div>
        ) : filteredAssistants.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-12 flex flex-col items-center justify-center">
            <Bot className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-3" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">暂无匹配助手</h2>
            <button
              type="button"
              onClick={openCreate}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700"
            >
              <Plus className="w-4 h-4" /> 新建助手
            </button>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredAssistants.map((assistant) => (
              <article
                key={assistant.id}
                className="group rounded-2xl border-2 border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 hover:shadow-lg hover:border-emerald-300 dark:hover:border-emerald-600 transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-2xl bg-gray-100 dark:bg-gray-700 flex items-center justify-center shrink-0">
                      {getAvatarIcon(assistant.avatar)}
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                        {assistant.name}
                      </h2>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                        {assistant.role || '未设置角色'}
                      </p>
                    </div>
                  </div>
                  {assistant.isDefault ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-950/30 text-xs font-medium text-amber-700 dark:text-amber-300">
                      <Star className="w-3.5 h-3.5" /> 默认
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 mt-4 min-h-[40px]">
                  {assistant.description || '暂无助手说明'}
                </p>
                <div className="flex items-center gap-2 flex-wrap mt-4 text-xs">
                  <span className="px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    {assistant.category || '未分类'}
                  </span>
                  {assistant.isSystem ? (
                    <span className="px-2.5 py-1 rounded-full bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-300">
                      系统助手
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300">
                      自定义
                    </span>
                  )}
                  <span className="text-gray-400">{formatTime(assistant.createdAt)}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
                  <div className="rounded-2xl bg-gray-50 dark:bg-gray-900 p-3">
                    <div className="text-gray-400">模型</div>
                    <div className="text-gray-700 dark:text-gray-200 font-semibold mt-1 truncate">
                      {assistant.model || '-'}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-gray-50 dark:bg-gray-900 p-3">
                    <div className="text-gray-400">温度</div>
                    <div className="text-gray-700 dark:text-gray-200 font-semibold mt-1">
                      {assistant.temperature ?? '-'}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => openEdit(assistant)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-sm"
                  >
                    <Pencil className="w-4 h-4" /> 编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => setSkillsAssistant(assistant)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-orange-200 dark:border-orange-900/40 text-sm text-orange-700 dark:text-orange-300"
                  >
                    <Sparkles className="w-4 h-4" /> 技能
                  </button>
                  {!assistant.isDefault ? (
                    <button
                      type="button"
                      onClick={() => void handleSetDefault(assistant)}
                      disabled={settingDefaultAssistantId === assistant.id}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-amber-200 dark:border-amber-900/40 text-sm text-amber-700"
                    >
                      <Star className="w-4 h-4" />{' '}
                      {settingDefaultAssistantId === assistant.id ? '设置中...' : '设为默认'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleCloneAssistant(assistant)}
                    disabled={cloningAssistantId === assistant.id}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-orange-200 dark:border-orange-900/40 text-sm text-orange-600"
                  >
                    <Copy className="w-4 h-4" />{' '}
                    {cloningAssistantId === assistant.id ? '克隆中...' : '克隆'}
                  </button>
                  {!assistant.isSystem ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(assistant)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 dark:border-red-900/40 text-sm text-red-600"
                    >
                      <Trash2 className="w-4 h-4" /> 删除
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-medium">助手</th>
                  <th className="px-4 py-3 font-medium">角色</th>
                  <th className="px-4 py-3 font-medium">模型</th>
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssistants.map((assistant) => (
                  <tr
                    key={assistant.id}
                    className="border-t border-gray-100 dark:border-gray-700 hover:bg-emerald-50/30 dark:hover:bg-emerald-900/10"
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-gray-900 dark:text-white">{assistant.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {assistant.description || '-'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {assistant.role || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {assistant.model || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => openEdit(assistant)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs"
                        >
                          <Pencil className="w-3.5 h-3.5" /> 编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => setSkillsAssistant(assistant)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs text-orange-700"
                        >
                          <Sparkles className="w-3.5 h-3.5" /> 技能
                        </button>
                        {!assistant.isSystem ? (
                          <button
                            type="button"
                            onClick={() => handleDelete(assistant)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs text-red-600"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> 删除
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm ? (
        <AssistantForm
          assistant={editingAssistant || undefined}
          onSave={handleSave}
          onClose={() => {
            setShowForm(false);
            setEditingAssistant(null);
          }}
        />
      ) : null}

      {skillsAssistant ? (
        <AssistantSkillsModal
          assistant={skillsAssistant}
          onClose={() => setSkillsAssistant(null)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={Boolean(assistantToDelete)}
        onClose={() => setAssistantToDelete(null)}
        onConfirm={() => void confirmDeleteAssistant()}
        title="删除 AI 助手"
        message={`确定删除助手「${assistantToDelete?.name || ''}」吗？`}
        confirmLabel="确认删除"
        cancelLabel="取消"
        loadingLabel="删除中..."
        isLoading={deletingAssistantId === assistantToDelete?.id}
        variant="danger"
      />
    </div>
  );
};

export default AIAssistantsPage;
