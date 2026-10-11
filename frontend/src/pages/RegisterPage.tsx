import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { authApi } from '../services/auth';
import Logo from '../components/Logo';

/** 三步式注册（与 AIIgnitePLM 一致）：填邮箱发码 → 输验证码 → 设置密码激活 */
type RegisterMode = 'email' | 'code' | 'password';

const RESEND_COOLDOWN_SECONDS = 60;

const RegisterPage: React.FC = () => {
  const { register, user, isLoading } = useAuth();
  const [mode, setMode] = useState<RegisterMode>('email');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  /** 重发倒计时；发送成功才启动 */
  const [cooldown, setCooldown] = useState(0);
  /** 后端未开放自助注册时展示引导而非表单（公网测试部署仅管理员建号） */
  const [registrationClosed, setRegistrationClosed] = useState<boolean | null>(null);

  useEffect(() => {
    authApi.getConfig()
      .then(cfg => setRegistrationClosed(!cfg.registrationEnabled))
      .catch(() => setRegistrationClosed(false));
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown(c => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  if (!isLoading && user) {
    return <Navigate to="/" replace />;
  }

  const stepLabel = mode === 'email' ? '第 1/3 步 · 邮箱' : mode === 'code' ? '第 2/3 步 · 验证码' : '第 3/3 步 · 设置密码';

  /** 第一步：校验邮箱未注册后发送验证码 */
  const handleSendCode = async () => {
    setAlreadyRegistered(false);
    setLoading(true);
    try {
      await authApi.requestRegister(email.trim(), name.trim());
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setMode('code');
      toast.success('验证码已发送，请查收邮件');
    } catch (err) {
      const message = err instanceof Error ? err.message : '发送验证码失败';
      // 后端 409：邮箱已注册，给出引导而非仅报错
      if (message.includes('已注册')) setAlreadyRegistered(true);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  /** 第二步：独立验码（不消费），通过后进入设置密码 */
  const handleVerifyCode = async () => {
    setAlreadyRegistered(false);
    setLoading(true);
    try {
      await authApi.verifyRegisterCode(email.trim(), code.trim());
      setMode('password');
    } catch (err) {
      const message = err instanceof Error ? err.message : '验证码校验失败';
      if (message.includes('已注册')) setAlreadyRegistered(true);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  /** 第三步：完成注册并自动登录（由 AuthContext 完成） */
  const handleComplete = async () => {
    setLoading(true);
    try {
      await register(email.trim(), password, code.trim());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'email') void handleSendCode();
    else if (mode === 'code') void handleVerifyCode();
    else void handleComplete();
  };

  const backTo = () => {
    setAlreadyRegistered(false);
    setMode(mode === 'password' ? 'code' : 'email');
  };

  const resendCode = async () => {
    if (cooldown > 0 || loading) return;
    setLoading(true);
    try {
      await authApi.requestRegister(email.trim(), name.trim());
      setCooldown(RESEND_COOLDOWN_SECONDS);
      toast.success('验证码已重新发送');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新发送失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-amber-50 dark:from-gray-900 dark:to-gray-800 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-8 border border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-3 mb-1">
          <Logo size={36} />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">创建账号</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {stepLabel}
          {mode !== 'email' && (
            <button type="button" onClick={backTo} className="ml-2 text-orange-600 hover:underline">
              返回
            </button>
          )}
        </p>

        {registrationClosed ? (
          <div className="mb-6 rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 p-4 text-sm text-amber-800 dark:text-amber-200">
            <p className="mb-3">当前为测试环境，未开放自助注册。测试账号请联系管理员开通。</p>
            <Link to="/login" className="inline-block rounded-lg bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 font-medium">
              去登录
            </Link>
          </div>
        ) : alreadyRegistered ? (
          <div className="mb-6 rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 p-4 text-sm text-amber-800 dark:text-amber-200">
            <p className="mb-3">该邮箱已注册，可直接登录，或找回密码。</p>
            <div className="flex gap-3">
              <Link to="/login" className="rounded-lg bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 font-medium">
                去登录
              </Link>
              <button
                type="button"
                onClick={() => setAlreadyRegistered(false)}
                className="rounded-lg border border-amber-300 dark:border-amber-600 px-4 py-2 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50"
              >
                重新填写
              </button>
            </div>
          </div>
        ) : mode === 'email' ? (
          <>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">姓名</label>
            <input
              required
              maxLength={100}
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full mb-4 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white px-3 py-2"
            />
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">邮箱</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full mb-6 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white px-3 py-2"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-orange-600 hover:bg-orange-700 text-white py-2.5 font-semibold disabled:opacity-50"
            >
              {loading ? '发送中…' : '发送验证码'}
            </button>
          </>
        ) : mode === 'code' ? (
          <>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              验证码已发送至 <span className="font-medium text-gray-700 dark:text-gray-200">{email}</span>，10 分钟内有效。
            </p>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">验证码</label>
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              className="w-full mb-4 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white px-3 py-2 tracking-[0.3em]"
            />
            <div className="flex items-center justify-between mb-6 text-sm">
              <button
                type="button"
                onClick={resendCode}
                disabled={cooldown > 0 || loading}
                className="text-orange-600 hover:underline disabled:text-gray-400 disabled:no-underline"
              >
                {cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送'}
              </button>
            </div>
            <button
              type="submit"
              disabled={loading || !code.trim()}
              className="w-full rounded-lg bg-orange-600 hover:bg-orange-700 text-white py-2.5 font-semibold disabled:opacity-50"
            >
              {loading ? '校验中…' : '下一步'}
            </button>
          </>
        ) : (
          <>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">设置密码</label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="至少 6 位"
              className="w-full mb-6 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white px-3 py-2"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-orange-600 hover:bg-orange-700 text-white py-2.5 font-semibold disabled:opacity-50"
            >
              {loading ? '注册中…' : '完成注册'}
            </button>
          </>
        )}

        <p className="text-sm text-center mt-4 text-gray-500">
          已有账号？ <Link to="/login" className="text-orange-600 hover:underline">登录</Link>
        </p>
      </form>
    </div>
  );
};

export default RegisterPage;
