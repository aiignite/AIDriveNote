import React, { useMemo, useState } from 'react';
import {
  Brain,
  Database,
  DollarSign,
  FileText,
  Gauge,
  Globe,
  Image,
  KeyRound,
  Lock,
  Save,
  Settings,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import type { AIModel, AIModelInput } from '../../services/ai/ai';

interface ModelFormProps {
  model?: AIModel;
  onSave: (data: AIModelInput) => void;
  onClose: () => void;
}

const PROVIDER_OPTIONS = [
  {
    value: 'OPENAI',
    label: 'OpenAI GPT',
    description: '适合通用对话、函数调用和生态兼容。',
    endpoint: '',
    authHint: '需要 API Key',
    endpointHint: '使用兼容网关时再填写自定义地址。',
  },
  {
    value: 'ANTHROPIC',
    label: 'Anthropic Claude',
    description: '适合高质量推理、文档分析与复杂工具调用。',
    endpoint: '',
    authHint: '需要 API Key',
    endpointHint: '建议优先使用默认官方地址。',
  },
  {
    value: 'MINIMAX',
    label: 'MiniMax',
    description: '适合中文业务场景与多模型协同接入。',
    endpoint: 'https://api.minimax.chat/v1',
    authHint: '需要 API Key',
    endpointHint: '默认补全官方地址，可按企业网关覆盖。',
  },
  {
    value: 'OLLAMA',
    label: 'Ollama 本地',
    description: '适合本地部署与隐私优先场景。',
    endpoint: 'http://localhost:11434',
    authHint: '通常无需 API Key',
    endpointHint: '本地运行时建议保持默认地址。',
  },
  {
    value: 'LMSTUDIO',
    label: 'LM Studio 本地',
    description: '适合桌面模型调试和快速体验。',
    endpoint: 'http://localhost:1234',
    authHint: '通常无需 API Key',
    endpointHint: '默认端口 1234，可按本机设置覆盖。',
  },
];

const SELECT_STYLES =
  'w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
const FIELD_WRAPPER = 'space-y-2';
const SECTION_CARD =
  'rounded-3xl border border-slate-200/80 bg-white/95 p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900/80';

const ToggleCard: React.FC<{
  checked: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onToggle: () => void;
}> = ({ checked, title, description, icon, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition ${
      checked
        ? 'border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-100'
        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
    }`}
  >
    <div className="flex items-center gap-3">
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
          checked
            ? 'bg-white text-orange-500 dark:bg-slate-900 dark:text-orange-300'
            : 'bg-white text-slate-500 dark:bg-slate-900 dark:text-slate-300'
        }`}
      >
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">{description}</span>
      </span>
    </div>
    <span
      className={`relative h-6 w-11 rounded-full transition ${
        checked ? 'bg-orange-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${
          checked ? 'left-6' : 'left-1'
        }`}
      />
    </span>
  </button>
);

export const ModelForm: React.FC<ModelFormProps> = ({ model, onSave, onClose }) => {
  const hasExistingKey = model?.hasApiKey || false;
  const [apiKeyChanged, setApiKeyChanged] = useState(false);
  const [formData, setFormData] = useState({
    name: model?.name || '',
    modelId: model?.modelId || '',
    provider: model?.provider || 'OLLAMA',
    endpoint: model?.endpoint || '',
    apiKey: '',
    popularity: model?.popularity || 50,
    isPublic: model?.isPublic ?? true,
    supportsText: model?.supportsText ?? true,
    supportsImage: model?.supportsImage ?? false,
    description: model?.description || '',
    speed: model?.speed || 'Fast',
    cost: model?.cost || '$',
    context: model?.context || '128K',
    setAsDefault: model?.isDefault ?? false,
  });

  const providerConfig = useMemo(
    () => PROVIDER_OPTIONS.find((item) => item.value === formData.provider) || PROVIDER_OPTIONS[3],
    [formData.provider],
  );
  const dialogTitle = model ? '编辑 AI 模型' : '新增 AI 模型';

  const updateForm = (patch: Partial<typeof formData>) => {
    setFormData((current) => ({ ...current, ...patch }));
  };

  const handleProviderChange = (provider: string) => {
    const nextProvider = PROVIDER_OPTIONS.find((item) => item.value === provider);
    updateForm({
      provider,
      endpoint: nextProvider?.endpoint ?? '',
    });
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const submitData: AIModelInput = { ...formData };
    if (!apiKeyChanged) {
      delete submitData.apiKey;
    }
    onSave(submitData);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 p-4 backdrop-blur-sm animate-in fade-in duration-200 md:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle}
        className="mx-auto flex h-full max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-slate-50 shadow-2xl animate-in zoom-in-95 duration-200 dark:border-slate-700 dark:bg-slate-950"
      >
        <div className="border-b border-slate-200 bg-white/90 px-6 py-5 dark:border-slate-800 dark:bg-slate-900/90">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-lg shadow-orange-500/20">
                <Brain className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-2xl font-semibold text-slate-900 dark:text-white">{dialogTitle}</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  先定义模型身份，再补充连接方式、能力和对外展示策略。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="关闭模型表单"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.7fr)_20rem]">
            <div className="min-h-0 overflow-y-auto px-6 py-6">
              <div className="grid gap-5 xl:grid-cols-2">
                <section className={`${SECTION_CARD} xl:col-span-2`}>
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    <Sparkles className="h-4 w-4 text-orange-500" />
                    模型标识
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className={FIELD_WRAPPER}>
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">展示名称</label>
                      <input
                        type="text"
                        value={formData.name}
                        onChange={(event) => updateForm({ name: event.target.value })}
                        className={SELECT_STYLES}
                        placeholder="例如：Ollama/qwen2.5"
                        required
                      />
                    </div>
                    <div className={FIELD_WRAPPER}>
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">模型 ID</label>
                      <input
                        type="text"
                        value={formData.modelId}
                        onChange={(event) => updateForm({ modelId: event.target.value })}
                        className={SELECT_STYLES}
                        placeholder="例如：qwen2.5"
                        required
                      />
                    </div>
                    <div className={FIELD_WRAPPER}>
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">提供商</label>
                      <select
                        value={formData.provider}
                        onChange={(event) => handleProviderChange(event.target.value)}
                        className={SELECT_STYLES}
                      >
                        {PROVIDER_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="rounded-2xl border border-orange-100 bg-orange-50/80 p-4 dark:border-orange-900/40 dark:bg-orange-950/20">
                      <p className="text-sm font-semibold text-orange-900 dark:text-orange-100">{providerConfig.label}</p>
                      <p className="mt-1 text-xs leading-5 text-orange-600 dark:text-orange-300">
                        {providerConfig.description}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-medium text-orange-600 dark:text-orange-200">
                        <span className="rounded-full bg-white px-2.5 py-1 dark:bg-slate-900">
                          {providerConfig.authHint}
                        </span>
                        <span className="rounded-full bg-white px-2.5 py-1 dark:bg-slate-900">
                          {providerConfig.endpointHint}
                        </span>
                      </div>
                    </div>
                  </div>
                </section>

                <section className={SECTION_CARD}>
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    <Settings className="h-4 w-4 text-orange-500" />
                    连接配置
                  </div>
                  <div className="space-y-4">
                    <div className={FIELD_WRAPPER}>
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">自定义 Endpoint</label>
                      <input
                        type="url"
                        value={formData.endpoint}
                        onChange={(event) => updateForm({ endpoint: event.target.value })}
                        className={SELECT_STYLES}
                        placeholder={providerConfig.endpoint || 'https://api.example.com/v1'}
                      />
                    </div>
                    <div className={FIELD_WRAPPER}>
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">API Key</label>
                      <div className="relative">
                        <input
                          type="password"
                          value={formData.apiKey}
                          onChange={(event) => {
                            updateForm({ apiKey: event.target.value });
                            setApiKeyChanged(true);
                          }}
                          className={`${SELECT_STYLES} pr-11`}
                          placeholder={hasExistingKey ? '已配置密钥，留空保持不变' : 'sk-... / bearer token'}
                        />
                        <Lock className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      </div>
                    </div>
                  </div>
                </section>

                <section className={SECTION_CARD}>
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    <Brain className="h-4 w-4 text-orange-500" />
                    能力与可见性
                  </div>
                  <div className="grid gap-3">
                    <ToggleCard
                      checked={formData.supportsText}
                      title="文本能力"
                      description="启用普通对话、总结与工具调用。"
                      icon={<FileText className="h-4 w-4" />}
                      onToggle={() => updateForm({ supportsText: !formData.supportsText })}
                    />
                    <ToggleCard
                      checked={formData.supportsImage}
                      title="图像能力"
                      description="启用图片理解、图像问答与视觉分析。"
                      icon={<Image className="h-4 w-4" />}
                      onToggle={() => updateForm({ supportsImage: !formData.supportsImage })}
                    />
                    <ToggleCard
                      checked={formData.isPublic}
                      title="公开模型"
                      description="开启后对全部用户可见；关闭则保留为内部配置。"
                      icon={<Globe className="h-4 w-4" />}
                      onToggle={() => updateForm({ isPublic: !formData.isPublic })}
                    />
                    <ToggleCard
                      checked={formData.setAsDefault}
                      title="设为默认模型"
                      description="作为你的全局默认模型，优先于助手配置使用。"
                      icon={<Star className="h-4 w-4" />}
                      onToggle={() => updateForm({ setAsDefault: !formData.setAsDefault })}
                    />
                  </div>
                </section>

                <section className={`${SECTION_CARD} xl:col-span-2`}>
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    <Gauge className="h-4 w-4 text-orange-500" />
                    使用画像
                  </div>
                  <div className="grid gap-4 lg:grid-cols-3">
                    <div className={FIELD_WRAPPER}>
                      <label className="flex items-center gap-1 text-sm font-medium text-slate-700 dark:text-slate-300">
                        <Gauge className="h-4 w-4" />
                        响应速度
                      </label>
                      <select
                        value={formData.speed}
                        onChange={(event) => updateForm({ speed: event.target.value })}
                        className={SELECT_STYLES}
                      >
                        <option value="Ultra Fast">Ultra Fast</option>
                        <option value="Fast">Fast</option>
                        <option value="Moderate">Moderate</option>
                        <option value="Slow">Slow</option>
                      </select>
                    </div>
                    <div className={FIELD_WRAPPER}>
                      <label className="flex items-center gap-1 text-sm font-medium text-slate-700 dark:text-slate-300">
                        <DollarSign className="h-4 w-4" />
                        成本等级
                      </label>
                      <select
                        value={formData.cost}
                        onChange={(event) => updateForm({ cost: event.target.value })}
                        className={SELECT_STYLES}
                      >
                        <option value="Free">Free</option>
                        <option value="$">$</option>
                        <option value="$$">$$</option>
                        <option value="$$$">$$$</option>
                      </select>
                    </div>
                    <div className={FIELD_WRAPPER}>
                      <label className="flex items-center gap-1 text-sm font-medium text-slate-700 dark:text-slate-300">
                        <Database className="h-4 w-4" />
                        上下文窗口
                      </label>
                      <select
                        value={formData.context}
                        onChange={(event) => updateForm({ context: event.target.value })}
                        className={SELECT_STYLES}
                      >
                        <option value="4K">4K</option>
                        <option value="8K">8K</option>
                        <option value="16K">16K</option>
                        <option value="32K">32K</option>
                        <option value="128K">128K</option>
                        <option value="200K">200K</option>
                        <option value="1M">1M</option>
                        <option value="2M">2M</option>
                      </select>
                    </div>
                  </div>
                </section>

                <section className={`${SECTION_CARD} xl:col-span-2`}>
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    <FileText className="h-4 w-4 text-orange-500" />
                    描述与排序
                  </div>
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <div className={FIELD_WRAPPER}>
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">模型描述</label>
                      <textarea
                        value={formData.description}
                        onChange={(event) => updateForm({ description: event.target.value })}
                        className={`${SELECT_STYLES} min-h-[132px] resize-y`}
                        rows={5}
                        placeholder="建议说明典型场景、输入限制、擅长任务和注意事项。"
                      />
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/80">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                        <KeyRound className="h-4 w-4 text-orange-500" />
                        推荐权重
                      </div>
                      <div className="mt-6 rounded-2xl bg-white p-4 dark:bg-slate-900">
                        <div className="flex items-center justify-between text-sm font-semibold text-slate-800 dark:text-slate-100">
                          <span>当前值</span>
                          <span>{formData.popularity}</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={formData.popularity}
                          onChange={(event) =>
                            updateForm({ popularity: parseInt(event.target.value, 10) })
                          }
                          className="mt-4 h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-orange-500 dark:bg-slate-700"
                        />
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>

            <aside className="border-t border-slate-200 bg-white/80 px-6 py-6 dark:border-slate-800 dark:bg-slate-900/80 lg:border-l lg:border-t-0">
              <div className="space-y-5">
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">配置建议</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    新增后做一次连接测试，可快速确认接入质量。
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/80">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    当前选择
                  </div>
                  <div className="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-200">
                    <div>
                      <div className="text-xs text-slate-400">提供商</div>
                      <div className="mt-1 font-semibold">{providerConfig.label}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">连接方式</div>
                      <div className="mt-1">{formData.endpoint || '使用默认官方地址'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-400">能力组合</div>
                      <div className="mt-1">
                        {formData.supportsText ? '文本' : '无文本'} /{' '}
                        {formData.supportsImage ? '图像' : '无图像'} /{' '}
                        {formData.isPublic ? '公开' : '内部'} /{' '}
                        {formData.setAsDefault ? '默认' : '非默认'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </aside>
          </div>

          <div className="border-t border-slate-200 bg-white/90 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/90">
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
                取消
              </button>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-600"
              >
                <Save className="h-4 w-4" />
                {model ? '保存修改' : '创建模型'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
