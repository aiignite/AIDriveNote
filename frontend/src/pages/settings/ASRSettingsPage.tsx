/**
 * ASRSettingsPage — 语音转写（ASR）服务设置
 *
 * 由会议版 ASRSettingsPage 去会议化移植，字段对齐 AsrSettingsOut：
 * 运行模式 / 远程 URL / API Key / 超时 / 失败降级 / 模型 / 语言 / 设备 / 计算精度，
 * 并提供远程连通性测试（admin）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Check, Radio, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  noteAsrApi,
  type AsrMode,
  type AsrSettings,
  type AsrSettingsUpdate,
} from '../../services/note/asrSettings';

/** 表单兜底默认值（GET 失败时使用） */
const DEFAULT_SETTINGS: AsrSettings = {
  mode: 'local',
  remoteUrl: null,
  remoteApiKey: null,
  remoteTimeoutSeconds: 3600,
  fallbackToLocal: false,
  model: 'medium',
  language: 'zh',
  device: 'cpu',
  computeType: 'int8',
};

/**
 * 从 unknown 错误对象中提取可读消息。
 * @param err 异常
 * @param fallback 兜底文案
 * @returns 可读消息
 */
function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

/**
 * 语音转写设置页组件。
 * @returns 设置表单
 */
const ASRSettingsPage: React.FC = () => {
  /** 已保存的生效设置 */
  const [savedSettings, setSavedSettings] = useState<AsrSettings | null>(null);
  /** 表单草稿 */
  const [draft, setDraft] = useState<AsrSettingsUpdate>({});
  /** 加载中 */
  const [loading, setLoading] = useState(false);
  /** 保存中 */
  const [saving, setSaving] = useState(false);
  /** 测试中 */
  const [testing, setTesting] = useState(false);
  /** 保存成功提示 */
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    noteAsrApi
      .getAsrSettings()
      .then((data) => {
        if (cancelled) return;
        setSavedSettings(data);
        // API Key 读取时为掩码，清空避免误提交掩码值
        setDraft({ ...data, remoteApiKey: '' });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        toast.error(err.message || '加载语音转写设置失败');
        setSavedSettings(DEFAULT_SETTINGS);
        setDraft({ ...DEFAULT_SETTINGS, remoteApiKey: '' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  /** 当前生效状态文案 */
  const effectiveStatus = useMemo(() => {
    const settings = savedSettings ?? DEFAULT_SETTINGS;
    if (settings.mode === 'remote') {
      const url = settings.remoteUrl || '未配置';
      const fallback = settings.fallbackToLocal ? '，失败降级本机' : '';
      return `当前生效：远程模式 ${url}${fallback}`;
    }
    return `当前生效：本机模式（model=${settings.model}, device=${settings.device}, computeType=${settings.computeType}）`;
  }, [savedSettings]);

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-500';

  /**
   * 更新单个表单字段。
   * @param key 字段名
   * @param value 字段值
   * @returns void
   */
  const updateField = <K extends keyof AsrSettingsUpdate>(key: K, value: AsrSettingsUpdate[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  /** 保存设置 */
  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      // 掩码 / 空串时不下发 remoteApiKey，避免覆盖既有 Key
      const payload: AsrSettingsUpdate = { ...draft };
      if (!payload.remoteApiKey || payload.remoteApiKey === '********') delete payload.remoteApiKey;
      const data = await noteAsrApi.updateAsrSettings(payload);
      setSavedSettings(data);
      setDraft({ ...data, remoteApiKey: '' });
      setSaveSuccess(true);
      toast.success('语音转写设置已保存');
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  /** 测试远程连接 */
  const handleTestRemote = async () => {
    setTesting(true);
    try {
      const result = await noteAsrApi.testRemote();
      const suffix = typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : '';
      if (result.ok) toast.success(`${result.message || '远程 ASR 服务可用'}${suffix}`);
      else toast.error(`${result.message || '远程 ASR 服务不可用'}${suffix}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '测试远程连接失败'));
    } finally {
      setTesting(false);
    }
  };

  const currentMode: AsrMode = (draft.mode ?? DEFAULT_SETTINGS.mode);

  return (
    <form
      autoComplete="off"
      onSubmit={(e) => e.preventDefault()}
      className="p-6 space-y-6 max-w-3xl"
    >
      <h1 className="text-lg font-bold text-gray-900 dark:text-white border-b border-gray-100 dark:border-gray-700 pb-4">
        语音转写设置
      </h1>

      {/* 生效状态 */}
      <div className="flex items-start gap-2 text-sm text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-lg p-3">
        <Radio size={18} className="mt-0.5 shrink-0" />
        <span>{effectiveStatus}</span>
      </div>

      {/* 运行模式 */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block">运行模式</label>
        <div className="flex gap-6">
          {(['local', 'remote'] as AsrMode[]).map(mode => (
            <label key={mode} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="asr-mode"
                value={mode}
                checked={currentMode === mode}
                onChange={() => updateField('mode', mode)}
                disabled={loading}
                className="text-orange-600 focus:ring-orange-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">{mode === 'local' ? '本机模式' : '远程模式'}</span>
            </label>
          ))}
        </div>
      </div>

      {/* 本机模式字段 */}
      {currentMode === 'local' && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5 col-span-2 sm:col-span-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">模型</label>
            <input
              type="text"
              value={draft.model ?? DEFAULT_SETTINGS.model}
              onChange={e => updateField('model', e.target.value)}
              placeholder="例如：medium"
              disabled={loading}
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5 col-span-2 sm:col-span-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">语言</label>
            <input
              type="text"
              value={draft.language ?? DEFAULT_SETTINGS.language}
              onChange={e => updateField('language', e.target.value)}
              placeholder="例如：zh"
              disabled={loading}
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5 col-span-2 sm:col-span-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">设备</label>
            <select
              value={draft.device ?? DEFAULT_SETTINGS.device}
              onChange={e => updateField('device', e.target.value)}
              disabled={loading}
              className={inputCls}
            >
              <option value="cpu">cpu</option>
              <option value="cuda">cuda</option>
            </select>
          </div>
          <div className="space-y-1.5 col-span-2 sm:col-span-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">计算精度</label>
            <select
              value={draft.computeType ?? DEFAULT_SETTINGS.computeType}
              onChange={e => updateField('computeType', e.target.value)}
              disabled={loading}
              className={inputCls}
            >
              <option value="int8">int8</option>
              <option value="float16">float16</option>
              <option value="float32">float32</option>
            </select>
          </div>
        </div>
      )}

      {/* 远程模式字段 */}
      {currentMode === 'remote' && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">远程服务地址</label>
            <input
              type="text"
              autoComplete="off"
              value={draft.remoteUrl ?? ''}
              onChange={e => updateField('remoteUrl', e.target.value || null)}
              placeholder="例如：http://10.0.0.10:8000"
              disabled={loading}
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">API Key</label>
            <input
              type="text"
              autoComplete="off"
              value={draft.remoteApiKey ?? ''}
              onChange={e => updateField('remoteApiKey', e.target.value)}
              placeholder={savedSettings?.remoteApiKey ? '留空表示不修改现有 Key' : '与远程 ASR 网关的 API Key 保持一致'}
              disabled={loading}
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">超时时间（秒）</label>
            <input
              type="number"
              min={1}
              value={draft.remoteTimeoutSeconds ?? DEFAULT_SETTINGS.remoteTimeoutSeconds}
              onChange={e => updateField('remoteTimeoutSeconds', Number(e.target.value))}
              disabled={loading}
              className={inputCls}
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.fallbackToLocal ?? DEFAULT_SETTINGS.fallbackToLocal}
              onChange={e => updateField('fallbackToLocal', e.target.checked)}
              disabled={loading}
              className="w-4 h-4 text-orange-600 rounded focus:ring-orange-500 border-gray-300"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">远程服务不可用时降级到本机模式</span>
          </label>
        </div>
      )}

      {/* 操作区 */}
      <div className="pt-4 flex justify-end gap-3 items-center border-t border-gray-100 dark:border-gray-700">
        {saveSuccess && (
          <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
            <Check size={16} /> 已保存
          </span>
        )}
        <span className="text-[11px] text-gray-400 flex items-center gap-1 mr-auto">
          <ShieldAlert size={12} /> 连通性测试需管理员权限
        </span>
        <button
          type="button"
          onClick={handleTestRemote}
          disabled={currentMode === 'local' || loading || testing}
          className="px-4 py-2 text-sm font-medium text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 rounded-lg disabled:opacity-50 flex items-center gap-2"
        >
          {testing && <Loader2 size={14} className="animate-spin" />}
          测试远程连接
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={loading || saving}
          className="px-4 py-2 text-sm font-medium bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          保存
        </button>
      </div>
    </form>
  );
};

export default ASRSettingsPage;