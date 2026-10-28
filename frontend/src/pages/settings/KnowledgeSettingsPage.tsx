import React, { useEffect, useState } from 'react';
import { AlertTriangle, Brain, Loader2, Save, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { knowledgeApi, type KnowledgeSettings } from '../../services/knowledge';

const KnowledgeSettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<KnowledgeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void knowledgeApi.getSettings()
      .then(setSettings)
      .catch(() => toast.error('加载知识设置失败'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await knowledgeApi.updateSettings({
        distillEnabled: settings.distillEnabled,
        allowExternal: settings.allowExternal,
        dailyLimit: settings.dailyLimit,
      });
      setSettings(next);
      toast.success('知识设置已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-gray-500">
        <Loader2 size={18} className="mr-2 animate-spin" /> 加载中…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">知识入库与蒸馏</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          控制外部文档如何解析、蒸馏为知识卡，以及是否允许调用商用模型。
        </p>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-orange-500" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">模型与开关</h2>
        </div>

        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={settings.distillEnabled}
            onChange={(event) => setSettings({ ...settings, distillEnabled: event.target.checked })}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="block text-sm text-gray-800 dark:text-gray-200">启用自动蒸馏</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              解析完成后自动生成待审核知识卡；关闭后只入库、不调用模型。
            </span>
          </span>
        </label>

        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={settings.allowExternal}
            onChange={(event) => setSettings({ ...settings, allowExternal: event.target.checked })}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="block text-sm text-gray-800 dark:text-gray-200">允许商用模型处理内容</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              开启后按「商用模型优先」蒸馏；未开启时只使用本地模型，失败则规则兜底。
            </span>
          </span>
        </label>

        <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            本地知识库规则要求「内容不外发」。开启商用模型前请确认你接受将文档正文发送给对应服务商；
            邮件/手机号会在出站前脱敏。
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400">蒸馏模型</label>
            <p className="mt-1 text-sm text-gray-800 dark:text-gray-200">
              {settings.configured ? settings.model : '未配置（使用用户默认模型 / 本地 Ollama）'}
            </p>
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400">每日蒸馏上限</label>
            <input
              type="number"
              min={0}
              value={settings.dailyLimit}
              onChange={(event) =>
                setSettings({ ...settings, dailyLimit: Number(event.target.value) || 0 })
              }
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-orange-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
            <p className="mt-1 text-[11px] text-gray-400">0 表示不限制。</p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-emerald-500" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">今日用量</h2>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Usage label="今日蒸馏" value={`${settings.usedToday}${settings.dailyLimit > 0 ? ` / ${settings.dailyLimit}` : ''}`} />
          <Usage label="今日 Tokens" value={settings.tokensToday.toLocaleString()} />
          <Usage label="累计 Tokens" value={settings.tokensTotal.toLocaleString()} />
          <Usage label="商用模型" value={settings.allowExternal ? '已允许' : '未允许'} />
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-sm text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          保存设置
        </button>
      </div>
    </div>
  );
};

const Usage: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-950">
    <p className="text-[11px] text-gray-500 dark:text-gray-400">{label}</p>
    <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{value}</p>
  </div>
);

export default KnowledgeSettingsPage;
