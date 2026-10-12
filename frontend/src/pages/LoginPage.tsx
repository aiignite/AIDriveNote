import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { authApi } from '../services/auth';
import Logo from '../components/Logo';

const LoginPage: React.FC = () => {
  const { login, guestLogin, user, isLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  /** 后端未开放自助注册时隐藏「注册」入口（公网测试部署仅管理员建号） */
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  /** 后端未开放匿名登录时隐藏「匿名使用」入口 */
  const [guestEnabled, setGuestEnabled] = useState(true);

  useEffect(() => {
    authApi.getConfig()
      .then(cfg => {
        setRegistrationEnabled(Boolean(cfg.registrationEnabled));
        setGuestEnabled(Boolean(cfg.guestLoginEnabled));
      })
      .catch(() => { /* 查询失败按默认展示，后端仍会拦截 */ });
  }, []);

  if (!isLoading && user) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setGuestLoading(true);
    try {
      await guestLogin();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '匿名登录失败');
    } finally {
      setGuestLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-amber-50 dark:from-gray-900 dark:to-gray-800 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-8 border border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-3 mb-1">
          <Logo size={36} />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AIDriveNote</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">登录你的 AI 笔记</p>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">邮箱</label>
        <input
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full mb-4 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white px-3 py-2"
        />
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">密码</label>
        <input
          type="password"
          required
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full mb-6 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white px-3 py-2"
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-orange-600 hover:bg-orange-700 text-white py-2.5 font-semibold disabled:opacity-50"
        >
          {loading ? '登录中…' : '登录'}
        </button>
        {registrationEnabled && (
          <p className="text-sm text-center mt-4 text-gray-500">
            没有账号？ <Link to="/register" className="text-orange-600 hover:underline">注册</Link>
          </p>
        )}
        {guestEnabled && (
          <>
            <div className="flex items-center gap-3 my-5">
              <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
              <span className="text-xs text-gray-400 dark:text-gray-500">或</span>
              <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            </div>
            <button
              type="button"
              onClick={() => void handleGuestLogin()}
              disabled={guestLoading || loading}
              className="w-full rounded-lg border border-orange-300 dark:border-orange-800 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/40 py-2.5 font-semibold disabled:opacity-50 transition-colors"
            >
              {guestLoading ? '进入中…' : '匿名使用'}
            </button>
            <p className="text-xs text-center mt-3 text-gray-400 dark:text-gray-500 leading-relaxed">
              无需注册即可使用全部笔记功能。<br />
              AI 助手需登录后使用；数据仅临时保存在服务器，30 分钟无操作后自动清除。
            </p>
          </>
        )}
      </form>
    </div>
  );
};

export default LoginPage;
