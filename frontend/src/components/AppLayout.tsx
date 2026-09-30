import React, { Suspense, lazy, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Bot, LogOut, Moon, Settings, Sun } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';
import { aiApi } from '../services/ai/ai';
import Logo from './Logo';
import OfflineBanner from './OfflineBanner';

const AISidebar = lazy(() => import('../components/ai/AISidebar'));

const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme, openAI, aiOpen, sidebarWidth, setSidebarWidth } = useApp();
  const isDark = theme === 'dark';

  useEffect(() => {
    void aiApi.getSettings().then(s => {
      if (s.sidebarWidth) setSidebarWidth(s.sidebarWidth);
    }).catch(() => {});
  }, [setSidebarWidth]);

  // 空闲时预取设置页 chunk：设置页是高频入口，提前把代码拉进本地缓存，
  // 点击「设置」时可直接渲染，省去一次跨机房往返（约 0.7s）。
  // 慢速网络（2g/3g/saveData）跳过，避免抢占首屏接口带宽。
  useEffect(() => {
    const isSlowNetwork = () => {
      const nav = navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean };
      };
      if (nav.connection?.saveData) return true;
      const et = nav.connection?.effectiveType;
      return et === '2g' || et === '3g' || et === 'slow-2g';
    };
    if (isSlowNetwork()) return;
    const prefetch = () => {
      void import('../pages/settings/SettingsLayout');
      void import('../pages/settings/AIModelsPage');
      void import('../pages/settings/SyncSettingsPage');
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(prefetch, 800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        openAI();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [openAI]);

  const aiPadding = aiOpen ? sidebarWidth : 0;

  return (
    <div className={`min-h-screen flex flex-col ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      <header className={`h-14 shrink-0 flex items-center justify-between px-4 border-b ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <Logo size={30} />
          <span className={`font-bold text-base tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
            AIDriveNote
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => openAI()} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`} title="AI 助手 (⌘J)">
            <Bot size={18} className="text-orange-500" />
          </button>
          <Link to="/settings" className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`} title="设置">
            <Settings size={18} className={isDark ? 'text-gray-300' : 'text-gray-600'} />
          </Link>
          <button type="button" onClick={toggleTheme} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}>
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <span className={`text-sm hidden sm:inline ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>{user?.name}</span>
          <button type="button" onClick={logout} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`} title="退出">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <OfflineBanner />
      <div className="flex flex-1 min-h-0" style={{ paddingRight: aiPadding }}>
        <main className="flex-1 min-w-0 min-h-0 flex flex-col">{children}</main>
        <Suspense fallback={null}>
          <AISidebar />
        </Suspense>
      </div>
    </div>
  );
};

export default AppLayout;
