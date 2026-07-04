import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, Sparkles, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { aiApi, type AIAssistant, type AISkill, type SkillBindingItem } from '../../services/ai/ai';

interface AssistantSkillsModalProps {
  assistant: AIAssistant;
  onClose: () => void;
}

const AssistantSkillsModal: React.FC<AssistantSkillsModalProps> = ({ assistant, onClose }) => {
  const [skills, setSkills] = useState<AISkill[]>([]);
  const [bindings, setBindings] = useState<SkillBindingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [skillList, bindingList] = await Promise.all([
        aiApi.listSkills(),
        aiApi.getAssistantSkills(assistant.id),
      ]);
      setSkills(skillList);
      setBindings(bindingList);
    } catch {
      toast.error('加载技能失败');
    } finally {
      setLoading(false);
    }
  }, [assistant.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isSkillEnabled = (skillId: string) => {
    const binding = bindings.find((item) => item.skillId === skillId);
    return binding ? binding.isEnabled : false;
  };

  const toggleSkill = (skillId: string) => {
    const existing = bindings.find((item) => item.skillId === skillId);
    if (existing) {
      setBindings((prev) =>
        prev.map((item) =>
          item.skillId === skillId ? { ...item, isEnabled: !item.isEnabled } : item,
        ),
      );
      return;
    }
    const skill = skills.find((item) => item.id === skillId);
    setBindings((prev) => [
      ...prev,
      {
        skillId,
        skillName: skill?.name,
        weight: skill?.priority ?? 50,
        isEnabled: true,
      },
    ]);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await aiApi.saveAssistantSkills(
        assistant.id,
        bindings.map((item) => ({
          skillId: item.skillId,
          weight: item.weight,
          isEnabled: item.isEnabled,
        })),
      );
      toast.success('技能绑定已保存');
      onClose();
    } catch {
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5 dark:border-slate-700">
          <div>
            <h3 className="text-xl font-semibold text-slate-900 dark:text-white">
              技能绑定 · {assistant.name}
            </h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              勾选技能后，聊天时会根据关键词自动激活对应提示与工具。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 p-2 text-slate-500 dark:border-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              加载技能...
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={isSkillEnabled(skill.id)}
                    onChange={() => toggleSkill(skill.id)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-slate-900 dark:text-white">{skill.name}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {skill.keywords.join('、')} · 优先级 {skill.priority}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
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
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || loading}
            className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? '保存中...' : '保存技能绑定'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssistantSkillsModal;
