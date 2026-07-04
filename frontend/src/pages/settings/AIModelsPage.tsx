import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Brain,
  Database,
  Download,
  Filter,
  LayoutGrid,
  List,
  Maximize2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Star,
  Trash2,
} from 'lucide-react';
import { aiApi, type AIModel, type AIModelInput } from '../../services/ai/ai';
import ConfirmDialog from '../../components/ConfirmDialog';
import { ModelForm } from '../../components/ai/ModelForm';

const AIModelsPage: React.FC = () => {
  const [models, setModels] = useState<AIModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showForm, setShowForm] = useState(false);
  const [editingModel, setEditingModel] = useState<AIModel | null>(null);
  const [modelToDelete, setModelToDelete] = useState<AIModel | null>(null);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [settingDefaultModelId, setSettingDefaultModelId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [speedFilter, setSpeedFilter] = useState('');
  const [costFilter, setCostFilter] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      setModels(await aiApi.listModels());
    } catch (error) {
      console.error('Failed to load AI models:', error);
      toast.error('加载 AI 模型失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const providerOptions = useMemo(
    () => Array.from(new Set(models.map((model) => model.provider).filter(Boolean))).sort(),
    [models],
  );

  const filteredModels = useMemo(() => {
    const keyword = deferredSearchTerm.trim().toLowerCase();
    return models.filter((model) => {
      if (providerFilter !== 'all' && model.provider !== providerFilter) return false;
      if (speedFilter && model.speed !== speedFilter) return false;
      if (costFilter && model.cost !== costFilter) return false;
      if (!keyword) return true;
      return [model.name, model.modelId, model.provider, model.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [costFilter, deferredSearchTerm, models, providerFilter, speedFilter]);

  const openCreate = useCallback(() => {
    setEditingModel(null);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((model: AIModel) => {
    setEditingModel(model);
    setShowForm(true);
  }, []);

  const handleSave = useCallback(
    async (data: AIModelInput) => {
      try {
        if (editingModel) {
          await aiApi.updateModel(editingModel.id, data);
          toast.success('AI 模型已更新');
        } else {
          await aiApi.createModel(data);
          toast.success('AI 模型已创建');
        }
        setShowForm(false);
        setEditingModel(null);
        await loadModels();
      } catch (error) {
        console.error('Failed to save AI model:', error);
        toast.error('保存 AI 模型失败');
      }
    },
    [editingModel, loadModels],
  );

  const handleDelete = useCallback((model: AIModel) => {
    setModelToDelete(model);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!modelToDelete) return;
    setDeletingModelId(modelToDelete.id);
    try {
      await aiApi.deleteModel(modelToDelete.id);
      toast.success('AI 模型已删除');
      setModelToDelete(null);
      await loadModels();
    } catch (error) {
      console.error('Failed to delete AI model:', error);
      toast.error('删除 AI 模型失败');
    } finally {
      setDeletingModelId(null);
    }
  }, [loadModels, modelToDelete]);

  const handleSetDefault = useCallback(
    async (model: AIModel) => {
      setSettingDefaultModelId(model.id);
      try {
        await aiApi.updateModel(model.id, { setAsDefault: true });
        toast.success(`已将「${model.name}」设为默认模型`);
        await loadModels();
      } catch (error) {
        console.error('Failed to set default model:', error);
        toast.error('设置默认模型失败');
      } finally {
        setSettingDefaultModelId(null);
      }
    },
    [loadModels],
  );

  const handleTestConnection = useCallback(async (model: AIModel) => {
    setTestingModelId(model.id);
    try {
      const data = await aiApi.testModelConnection(model.id);
      const ok = data.ok ?? data.success;
      if (ok) {
        const latency = data.latencyMs != null ? ` / ${data.latencyMs}ms` : '';
        toast.success(`连接成功：${data.provider || model.provider} / ${data.model || model.modelId}${latency}`);
      } else {
        toast.error(`连接失败：${data.error || data.message || '未返回内容'}`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      toast.error(`连接测试失败：${msg}`);
    } finally {
      setTestingModelId(null);
    }
  }, []);

  const handleExport = useCallback(() => {
    const csv = [
      ['名称', '模型ID', '提供商', '描述', '速度', '成本', '上下文', '文本', '图像'].join(','),
      ...filteredModels.map((m) =>
        [
          m.name,
          m.modelId,
          m.provider,
          m.description || '',
          m.speed || '',
          m.cost || '',
          m.context || '',
          m.supportsText ? 'Y' : 'N',
          m.supportsImage ? 'Y' : 'N',
        ].join(','),
      ),
    ].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-models-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredModels]);

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
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
                  <Brain className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">AI 模型管理</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    管理模型提供商、模型标识与基础能力配置
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
                  onClick={() => void loadModels()}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="刷新"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setIsFullscreen((f) => !f)}
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
              placeholder="搜索模型名称、模型 ID、提供商..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAdvancedSearch((f) => !f)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border ${
                showAdvancedSearch
                  ? 'bg-orange-50 border-orange-200 text-orange-500 dark:bg-orange-950/30 dark:border-orange-800 dark:text-orange-300'
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
                    ? 'bg-white dark:bg-gray-600 shadow-sm text-orange-500'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
                title="网格视图"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`p-2 rounded-md transition-colors ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-gray-600 shadow-sm text-orange-500'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
                title="列表视图"
              >
                <List className="w-4 h-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={openCreate}
              className="flex items-center gap-1.5 px-4 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" /> 新增模型
            </button>
          </div>
        </div>

        {showAdvancedSearch && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <select
                value={providerFilter}
                onChange={(event) => setProviderFilter(event.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-300"
              >
                <option value="all">全部提供商</option>
                {providerOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select
                value={speedFilter}
                onChange={(event) => setSpeedFilter(event.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-300"
              >
                <option value="">全部速度</option>
                <option value="Fast">Fast</option>
                <option value="Medium">Medium</option>
                <option value="Slow">Slow</option>
              </select>
              <select
                value={costFilter}
                onChange={(event) => setCostFilter(event.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-300"
              >
                <option value="">全部成本</option>
                <option value="$">$</option>
                <option value="$$">$$</option>
                <option value="$$$">$$$</option>
              </select>
              <span className="flex items-center px-3 py-2 rounded-lg bg-orange-50 dark:bg-orange-950/30 text-xs font-semibold text-orange-600 dark:text-orange-300">
                {filteredModels.length}/{models.length} 个模型
              </span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-10 text-center text-sm text-gray-500 dark:text-gray-400">
            <Brain className="w-8 h-8 mx-auto mb-3 animate-pulse text-orange-300" />
            正在加载 AI 模型...
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-12 flex flex-col items-center justify-center">
            <Brain className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-3" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">暂无匹配模型</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              调整搜索条件，或直接新建一个 AI 模型。
            </p>
            <button
              type="button"
              onClick={openCreate}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 shadow-sm"
            >
              <Plus className="w-4 h-4" /> 新建模型
            </button>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredModels.map((model) => (
              <article
                key={model.id}
                className="group rounded-2xl border-2 border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 hover:shadow-lg hover:border-orange-300 dark:hover:border-orange-500 transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{model.name}</h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono">{model.modelId}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {model.isDefault ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-950/30 text-xs font-medium text-amber-700 dark:text-amber-300">
                        <Star className="w-3.5 h-3.5" /> 默认
                      </span>
                    ) : null}
                    <span className="px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-xs font-medium text-gray-600 dark:text-gray-300">
                      {model.provider}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 mt-4 min-h-[40px]">
                  {model.description || '暂无模型描述'}
                </p>
                <div className="grid grid-cols-3 gap-3 mt-4 text-xs">
                  <div className="rounded-2xl bg-gray-50 dark:bg-gray-900 p-3">
                    <div className="text-gray-400">速度</div>
                    <div className="text-gray-700 dark:text-gray-200 font-semibold mt-1">
                      {model.speed || '-'}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-gray-50 dark:bg-gray-900 p-3">
                    <div className="text-gray-400">成本</div>
                    <div className="text-gray-700 dark:text-gray-200 font-semibold mt-1">
                      {model.cost || '-'}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-gray-50 dark:bg-gray-900 p-3">
                    <div className="text-gray-400">上下文</div>
                    <div className="text-gray-700 dark:text-gray-200 font-semibold mt-1">
                      {model.context || '-'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-4 text-xs text-gray-500 dark:text-gray-400">
                  <Database className="w-3.5 h-3.5" />
                  <span>
                    {model.supportsText ? '文本' : '无文本'} / {model.supportsImage ? '图像' : '无图像'}
                  </span>
                  {model.isPublic ? <Shield className="w-3.5 h-3.5 ml-auto" /> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => openEdit(model)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-orange-50 dark:hover:bg-orange-950/30"
                  >
                    <Pencil className="w-4 h-4" /> 编辑
                  </button>
                  {!model.isDefault ? (
                    <button
                      type="button"
                      onClick={() => void handleSetDefault(model)}
                      disabled={settingDefaultModelId === model.id}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-amber-200 dark:border-amber-900/40 text-sm text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                    >
                      <Star className="w-4 h-4" />
                      {settingDefaultModelId === model.id ? '设置中...' : '设为默认'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleTestConnection(model)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-emerald-200 dark:border-emerald-900/40 text-sm text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                    disabled={testingModelId === model.id}
                  >
                    <Database className="w-4 h-4" />{' '}
                    {testingModelId === model.id ? '测试中...' : '测试'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(model)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 dark:border-red-900/40 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                  >
                    <Trash2 className="w-4 h-4" /> 删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-medium">模型</th>
                  <th className="px-4 py-3 font-medium">提供商</th>
                  <th className="px-4 py-3 font-medium">描述</th>
                  <th className="px-4 py-3 font-medium">能力</th>
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredModels.map((model) => (
                  <tr
                    key={model.id}
                    className="border-t border-gray-100 dark:border-gray-700 hover:bg-orange-50/30 dark:hover:bg-orange-900/10"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900 dark:text-white">{model.name}</span>
                        {model.isDefault ? (
                          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-700 dark:text-amber-300">
                            <Star className="w-3 h-3" /> 默认
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{model.modelId}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{model.provider}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {model.description || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                      {model.supportsText ? '文本' : '无文本'} / {model.supportsImage ? '图像' : '无图像'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(model)}
                          className="p-2 rounded-lg text-gray-500 hover:text-orange-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                          title="编辑"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {!model.isDefault ? (
                          <button
                            type="button"
                            onClick={() => void handleSetDefault(model)}
                            disabled={settingDefaultModelId === model.id}
                            className="p-2 rounded-lg text-gray-500 hover:text-amber-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                            title="设为默认"
                          >
                            <Star className="w-4 h-4" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void handleTestConnection(model)}
                          className="p-2 rounded-lg text-gray-500 hover:text-emerald-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                          disabled={testingModelId === model.id}
                        >
                          <Database className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(model)}
                          className="p-2 rounded-lg text-gray-500 hover:text-red-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
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
        <ModelForm
          model={editingModel || undefined}
          onSave={handleSave}
          onClose={() => {
            setShowForm(false);
            setEditingModel(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        isOpen={Boolean(modelToDelete)}
        onClose={() => setModelToDelete(null)}
        onConfirm={() => void confirmDelete()}
        title="删除 AI 模型"
        message={`确定删除模型「${modelToDelete?.name || ''}」吗？此操作会将该模型从 AI 管理中移除。`}
        confirmLabel="确认删除"
        cancelLabel="取消"
        loadingLabel="删除中..."
        isLoading={deletingModelId === modelToDelete?.id}
        variant="danger"
      />
    </div>
  );
};

export default AIModelsPage;
