import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, Sparkles, X } from 'lucide-react';
import { aiApi, type AISkill, type AISkillInput } from '../../services/ai/ai';

interface SkillFormProps {
  skill?: AISkill;
  onSave: (data: AISkillInput) => void;
  onClose: () => void;
}

const INPUT =
  'w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

export const SkillForm: React.FC<SkillFormProps> = ({ skill, onSave, onClose }) => {
  const isEditing = !!skill;
  const [toolOptions, setToolOptions] = useState<Array<{ name: string; label: string }>>([]);
  const [loadingTools, setLoadingTools] = useState(true);
  const [keywordsText, setKeywordsText] = useState(skill?.keywords.join('、') ?? '');
  const [formData, setFormData] = useState({
    code: skill?.code ?? '',
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    promptTemplate: skill?.promptTemplate ?? '',
    toolNames: skill?.toolNames ?? [],
    priority: skill?.priority ?? 50,
    isEnabled: skill?.isEnabled ?? true,
  });

  useEffect(() => {
    void (async () => {
      setLoadingTools(true);
      try {
        const registry = await aiApi.toolsRegistry();
        const noteTools = registry.categories?.note ?? [];
        setToolOptions(noteTools);
      } finally {
        setLoadingTools(false);
      }
    })();
  }, []);

  const dialogTitle = isEditing ? '编辑技能' : '新增技能';

  const parsedKeywords = useMemo(
    () =>
      keywordsText
        .split(/[,，、\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    [keywordsText],
  );

  const toggleTool = (toolName: string) => {
    setFormData((prev) => ({
      ...prev,
      toolNames: prev.toolNames.includes(toolName)
        ? prev.toolNames.filter((name) => name !== toolName)
        : [...prev.toolNames, toolName],
    }));
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSave({
      code: formData.code.trim(),
      name: formData.name.trim(),
      description: formData.description.trim() || undefined,
      promptTemplate: formData.promptTemplate,
      toolNames: formData.toolNames,
      keywords: parsedKeywords,
      priority: formData.priority,
      isEnabled: formData.isEnabled,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5 dark:border-slate-700">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-red-500 text-white">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-xl font-semibold text-slate-900 dark:text-white">{dialogTitle}</h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                配置触发关键词、提示词模板与关联工具，聊天时自动激活。
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 p-2 dark:border-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  技能代码
                </label>
                <input
                  type="text"
                  value={formData.code}
                  onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value }))}
                  className={INPUT}
                  placeholder="note_custom_action"
                  required
                  disabled={isEditing}
                  pattern="[a-z][a-z0-9_]*"
                  title="小写字母开头，仅含字母、数字、下划线"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  展示名称
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                  className={INPUT}
                  placeholder="例如：读取并总结"
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                描述
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                className={INPUT}
                placeholder="简要说明技能用途"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                触发关键词
              </label>
              <input
                type="text"
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
                className={INPUT}
                placeholder="总结、概括、摘要（逗号或顿号分隔）"
              />
              {parsedKeywords.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {parsedKeywords.map((kw) => (
                    <span
                      key={kw}
                      className="rounded-md bg-orange-50 px-2 py-0.5 text-xs text-orange-700 dark:bg-orange-950/30 dark:text-orange-300"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                提示词模板
              </label>
              <textarea
                value={formData.promptTemplate}
                onChange={(e) => setFormData((prev) => ({ ...prev, promptTemplate: e.target.value }))}
                className={`${INPUT} min-h-[120px] resize-y font-mono text-xs`}
                rows={5}
                placeholder="用户触发该技能时注入的系统提示..."
                required
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                关联工具
              </label>
              {loadingTools ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  加载工具列表...
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {toolOptions.map((tool) => {
                    const selected = formData.toolNames.includes(tool.name);
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        onClick={() => toggleTool(tool.name)}
                        className={`rounded-xl border px-3 py-2 text-xs font-medium transition ${
                          selected
                            ? 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-300'
                            : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {tool.label || tool.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  优先级 ({formData.priority})
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={formData.priority}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, priority: Number(e.target.value) }))
                  }
                  className="w-full accent-orange-600"
                />
              </div>
              <label className="flex items-center gap-2 self-end rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-700">
                <input
                  type="checkbox"
                  checked={formData.isEnabled}
                  onChange={(e) => setFormData((prev) => ({ ...prev, isEnabled: e.target.checked }))}
                />
                <span className="text-sm text-slate-700 dark:text-slate-300">启用技能</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-4 dark:border-slate-700">
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-slate-200 px-4 py-2 text-sm dark:border-slate-700"
            >
              取消
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-2xl bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
            >
              <Save className="h-4 w-4" />
              {isEditing ? '保存修改' : '创建技能'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SkillForm;
