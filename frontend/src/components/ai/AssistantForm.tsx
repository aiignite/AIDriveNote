import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Brain,
  Briefcase,
  Cpu,
  FileEdit,
  GraduationCap,
  Lightbulb,
  Loader2,
  MessageSquare,
  PenTool,
  Rocket,
  Save,
  Sparkles,
  Star,
  X,
  Zap,
} from 'lucide-react';
import { aiApi, type AIAssistant, type AIAssistantInput, type AIModel } from '../../services/ai/ai';

interface AssistantFormProps {
  assistant?: AIAssistant;
  onSave: (data: AIAssistantInput) => void;
  onClose: () => void;
}

interface ModelOption {
  name: string;
  modelId: string;
  provider: string;
  displayName: string;
}

const AVATAR_OPTIONS = [
  { id: 'sparkles', icon: <Sparkles className="h-5 w-5" />, label: '魔法' },
  { id: 'file-edit', icon: <FileEdit className="h-5 w-5" />, label: '编辑' },
  { id: 'rocket', icon: <Rocket className="h-5 w-5" />, label: '火箭' },
  { id: 'brain', icon: <Brain className="h-5 w-5" />, label: '大脑' },
  { id: 'school', icon: <GraduationCap className="h-5 w-5" />, label: '教育' },
  { id: 'briefcase', icon: <Briefcase className="h-5 w-5" />, label: '商务' },
  { id: 'lightbulb', icon: <Lightbulb className="h-5 w-5" />, label: '创意' },
  { id: 'pen-tool', icon: <PenTool className="h-5 w-5" />, label: '写作' },
  { id: 'message', icon: <MessageSquare className="h-5 w-5" />, label: '对话' },
  { id: 'zap', icon: <Zap className="h-5 w-5" />, label: '高效' },
  { id: 'bot', icon: <Bot className="h-5 w-5" />, label: '机器人' },
  { id: '📝', icon: <span className="text-lg">📝</span>, label: '笔记' },
];

const CATEGORIES = ['General', 'Writing', 'System', 'Product', 'Business'];

const INPUT =
  'w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

const resolveModelName = (modelRef: string | null | undefined, options: ModelOption[]) => {
  if (!modelRef) return '';
  const exact = options.find((option) => option.name === modelRef || option.modelId === modelRef);
  if (exact) return exact.name;
  const partial = options.find(
    (option) => modelRef.includes(option.modelId) || option.name.includes(modelRef),
  );
  return partial?.name || modelRef;
};

export const getAvatarIcon = (avatarId?: string | null) => {
  const option = AVATAR_OPTIONS.find((item) => item.id === avatarId);
  return option ? option.icon : <Bot className="h-5 w-5" />;
};

export const AssistantForm: React.FC<AssistantFormProps> = ({ assistant, onSave, onClose }) => {
  const isSystem = assistant?.isSystem ?? false;
  const isEditing = !!assistant;
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [defaultModelName, setDefaultModelName] = useState('');
  const [formData, setFormData] = useState({
    name: assistant?.name || '',
    description: assistant?.description || '',
    role: assistant?.role || '',
    avatar: assistant?.avatar || 'sparkles',
    category: assistant?.category || 'General',
    systemPrompt: assistant?.systemPrompt || '',
    model: assistant?.model || '',
    temperature: assistant?.temperature ?? 0.7,
    maxTokens: assistant?.maxTokens ?? 16384,
    isDefault: assistant?.isDefault ?? false,
  });

  useEffect(() => {
    const loadModels = async () => {
      try {
        setLoadingModels(true);
        const [modelList, settings] = await Promise.all([
          aiApi.listModels(),
          aiApi.getSettings(),
        ]);
        const options = modelList
          .map((model: AIModel) => ({
            name: model.name,
            modelId: model.modelId,
            provider: model.provider,
            displayName: `${model.name} · ${model.provider}/${model.modelId}`,
          }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        setModels(options);
        setDefaultModelName(settings.defaultModelName || '');
        setFormData((prev) => {
          const resolved = resolveModelName(prev.model || assistant?.model, options);
          const fallback =
            resolveModelName(settings.defaultModelName, options) || options[0]?.name || '';
          return {
            ...prev,
            model: resolved || fallback,
          };
        });
      } catch {
        /* ignore */
      } finally {
        setLoadingModels(false);
      }
    };
    void loadModels();
  }, [assistant?.model]);

  const dialogTitle = useMemo(
    () => (isEditing ? (isSystem ? '编辑系统助手' : '编辑助手') : '创建新助手'),
    [isEditing, isSystem],
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="mx-auto flex h-full max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950"
      >
        <div className="flex items-start justify-between border-b border-slate-200 bg-white/90 px-6 py-5 dark:border-slate-800 dark:bg-slate-900/90">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-2xl font-semibold text-slate-900 dark:text-white">{dialogTitle}</h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                配置助手身份、系统提示词与绑定的 AI 模型。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isSystem && (
          <div className="mx-6 mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <p className="text-sm text-amber-700 dark:text-amber-300">
              这是系统内置助手。修改模型或提示词可能影响笔记 AI 功能，请谨慎操作。
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  助手名称 *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(event) => setFormData((prev) => ({ ...prev, name: event.target.value }))}
                  className={INPUT}
                  required
                  disabled={isSystem}
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  角色 *
                </label>
                <input
                  type="text"
                  value={formData.role}
                  onChange={(event) => setFormData((prev) => ({ ...prev, role: event.target.value }))}
                  className={INPUT}
                  required
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  分类 *
                </label>
                <select
                  value={formData.category}
                  onChange={(event) => setFormData((prev) => ({ ...prev, category: event.target.value }))}
                  className={INPUT}
                >
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                头像
              </label>
              <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/50">
                {AVATAR_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.label}
                    onClick={() => setFormData((prev) => ({ ...prev, avatar: item.id }))}
                    className={`rounded-xl p-2 transition ${
                      formData.avatar === item.id
                        ? 'bg-emerald-600 text-white shadow-md'
                        : 'bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300'
                    }`}
                  >
                    {item.icon}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                描述
              </label>
              <textarea
                value={formData.description}
                onChange={(event) => setFormData((prev) => ({ ...prev, description: event.target.value }))}
                className={`${INPUT} min-h-[80px] resize-y`}
                rows={2}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                系统提示词 *
              </label>
              <textarea
                value={formData.systemPrompt}
                onChange={(event) => setFormData((prev) => ({ ...prev, systemPrompt: event.target.value }))}
                className={`${INPUT} min-h-[180px] resize-y font-mono`}
                rows={8}
                required
              />
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900/80">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Cpu className="h-4 w-4 text-emerald-500" />
                模型配置
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                    AI 模型 *
                  </label>
                  {loadingModels ? (
                    <div className={`${INPUT} flex items-center gap-2 text-slate-500`}>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      加载模型列表...
                    </div>
                  ) : models.length === 0 ? (
                    <div className={`${INPUT} text-slate-500`}>
                      暂无可用模型，请先到
                      <a href="/settings/ai/models" className="mx-1 text-emerald-600 underline">
                        模型管理
                      </a>
                      添加。
                    </div>
                  ) : (
                    <select
                      value={formData.model}
                      onChange={(event) => setFormData((prev) => ({ ...prev, model: event.target.value }))}
                      className={INPUT}
                      required
                    >
                      <option value="">选择模型...</option>
                      {models.map((option) => (
                        <option key={option.name} value={option.name}>
                          {option.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                  {defaultModelName && (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      系统默认模型：{defaultModelName}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                    温度：{formData.temperature}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={formData.temperature}
                    onChange={(event) =>
                      setFormData((prev) => ({ ...prev, temperature: parseFloat(event.target.value) }))
                    }
                    className="w-full accent-emerald-600"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                    最大 Token
                  </label>
                  <select
                    value={formData.maxTokens}
                    onChange={(event) =>
                      setFormData((prev) => ({ ...prev, maxTokens: parseInt(event.target.value, 10) }))
                    }
                    className={INPUT}
                  >
                    <option value="4096">4,096</option>
                    <option value="8192">8,192</option>
                    <option value="16384">16,384</option>
                    <option value="32768">32,768</option>
                    <option value="65536">65,536</option>
                  </select>
                </div>
              </div>
              <label className="mt-4 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.isDefault}
                  onChange={(event) => setFormData((prev) => ({ ...prev, isDefault: event.target.checked }))}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="flex items-center gap-1 text-sm text-slate-700 dark:text-slate-300">
                  <Star className="h-4 w-4 text-amber-500" />
                  设为默认助手
                </span>
              </label>
            </div>
          </div>
        </form>

        <div className="border-t border-slate-200 bg-white/90 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/90">
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 px-5 py-3 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200"
            >
              取消
            </button>
            <button
              type="submit"
              onClick={handleSubmit}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              <Save className="h-4 w-4" />
              {isEditing ? '保存修改' : '创建助手'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
