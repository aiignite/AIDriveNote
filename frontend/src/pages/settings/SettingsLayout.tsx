import React, { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ArrowLeft, Bot, Brain, Save, Settings, Sparkles, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { aiApi, type AIModel } from '../../services/ai/ai';

const aiNavItems = [
  { to: '/settings/models', label: '模型', icon: Brain, accent: 'orange' as const },
  { to: '/settings/assistants', label: '助手', icon: Bot, accent: 'orange' as const },
  { to: '/settings/skills', label: '技能', icon: Sparkles, accent: 'orange' as const },
];

const adminNavItems = [
  { to: '/settings/users', label: '用户管理', icon: Users, accent: 'indigo' as const },
];

const navLinkClass = (
  isActive: boolean,
  isDark: boolean,
  accent: 'orange' | 'indigo',
) => {
  if (isActive) {
    if (accent === 'indigo') {
      return isDark
        ? 'bg-indigo-950/60 text-indigo-300'
        : 'bg-indigo-50 text-indigo-700';
    }
    return isDark ? 'bg-orange-950/60 text-orange-300' : 'bg-orange-50 text-orange-700';
  }
  return isDark
    ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900';
};

const SettingsLayout: React.FC = () => {
  const { theme } = useApp();
  const { user } = useAuth();
  const location = useLocation();
  const isDark = theme === 'dark';
  const [models, setModels] = useState<AIModel[]>([]);
  const [defaultModelName, setDefaultModelName] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [saving, setSaving] = useState(false);

  const showPreferences = !location.pathname.includes('/settings/users');

  const navItems = useMemo(
    () => [...aiNavItems, ...(user?.role === 'admin' ? adminNavItems : [])],
    [user?.role],
  );

  useEffect(() => {
    void (async () => {
      try {
        const [settings, modelList] = await Promise.all([
          aiApi.getSettings(),
          aiApi.listModels(),
        ]);
        setModels(modelList);
        setDefaultModelName(settings.defaultModelName ?? '');
        setSidebarWidth(settings.sidebarWidth ?? 400);
      } catch {
        toast.error('加载 AI 偏好失败');
      }
    })();
  }, []);

  const handleSavePreferences = async () => {
    setSaving(true);
    try {
      await aiApi.updateSettings({
        defaultModelName: defaultModelName || null,
        sidebarWidth,
      });
      toast.success('偏好已保存');
    } catch {
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`h-full min-h-[calc(100vh-3.5rem)] flex ${isDark ? 'bg-gray-950' : 'bg-slate-50'}`}>
      <aside
        className={`w-56 shrink-0 flex flex-col border-r ${
          isDark ? 'border-gray-800 bg-gray-900' : 'border-gray-200 bg-white'
        }`}
      >
        <div className={`p-4 border-b ${isDark ? 'border-gray-800' : 'border-gray-100'}`}>
          <div className="flex items-center gap-2 mb-1">
            <Link
              to="/"
              className={`p-1.5 rounded-lg transition-colors ${
                isDark ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200' : 'text-gray-500 hover:bg-gray-100'
              }`}
              title="返回笔记"
            >
              <ArrowLeft size={16} />
            </Link>
            <Settings size={18} className="text-orange-500" />
            <h1 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>设置</h1>
          </div>
          <p className={`text-xs pl-8 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            AI 配置与用户管理
          </p>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(({ to, label, icon: Icon, accent }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${navLinkClass(isActive, isDark, accent)}`
              }
            >
              <Icon size={16} className="shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {showPreferences && (
          <div
            className={`p-4 border-t space-y-3 ${isDark ? 'border-gray-800' : 'border-gray-100'}`}
          >
            <p className={`text-xs font-medium ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              AI 偏好
            </p>
            <div>
              <label className={`block text-xs mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                默认模型
              </label>
              <select
                value={defaultModelName}
                onChange={(e) => setDefaultModelName(e.target.value)}
                className={`w-full rounded-lg border px-2 py-1.5 text-xs ${
                  isDark ? 'bg-gray-800 border-gray-700 text-gray-200' : 'bg-white border-gray-200'
                }`}
              >
                <option value="">跟随助手</option>
                {models.map((m) => (
                  <option key={m.id} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={`block text-xs mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                侧栏宽度
              </label>
              <input
                type="number"
                min={320}
                max={600}
                value={sidebarWidth}
                onChange={(e) => setSidebarWidth(Number(e.target.value))}
                className={`w-full rounded-lg border px-2 py-1.5 text-xs ${
                  isDark ? 'bg-gray-800 border-gray-700 text-gray-200' : 'bg-white border-gray-200'
                }`}
              />
            </div>
            <button
              type="button"
              onClick={() => void handleSavePreferences()}
              disabled={saving}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 hover:bg-orange-700 transition-colors"
            >
              <Save size={12} />
              {saving ? '保存中...' : '保存偏好'}
            </button>
          </div>
        )}
      </aside>

      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
};

export default SettingsLayout;
