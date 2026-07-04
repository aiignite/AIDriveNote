import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/Logo';

const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

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
        <p className="text-sm text-center mt-4 text-gray-500">
          没有账号？ <Link to="/register" className="text-orange-600 hover:underline">注册</Link>
        </p>
      </form>
    </div>
  );
};

export default LoginPage;
