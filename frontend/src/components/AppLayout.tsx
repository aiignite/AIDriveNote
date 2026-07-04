import React, { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { Bot, LogOut, Moon, Settings, Sun } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useApp } from '../contexts/AppContext';
import Logo from './Logo';

const AISidebar = lazy(() => import('../components/ai/AISidebar'));

const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme, openAI, aiOpen } = useApp();
  const isDark = theme === 'dark';

  return (
    <div className={`min-h-screen ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      <header className={`h-14 flex items-center justify-between px-4 border-b ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <Logo size={30} />
          <span className={`font-bold text-base tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
            AIDriveNote
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <button type="button" onClick={openAI} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`} title="AI 助手">
            <Bot size={18} className="text-orange-500" />
          </button>
          <Link to="/settings/ai" className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`} title="AI 设置">
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
      <div className={`flex min-h-[calc(100vh-3.5rem)] ${aiOpen ? 'pr-0 md:pr-96' : ''}`}>
        <main className="flex-1 min-w-0 min-h-0 flex flex-col">{children}</main>
        <Suspense fallback={null}>
          <AISidebar />
        </Suspense>
      </div>
    </div>
  );
};

export default AppLayout;
