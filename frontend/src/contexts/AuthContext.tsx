import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, type AuthUser } from '../services/auth';
import {
  isAuthenticated,
  isNetworkError,
  isOffline,
  mayHaveSession,
  readCachedUser,
  setAuthTokens,
  writeCachedUser,
} from '../services/client';
import { bindUser } from '../services/offline/noteCache';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** 匿名登录：创建本次会话的独立账号，数据到期后由服务器清除 */
  guestLogin: () => Promise<void>;
  /** 三步式注册的最后一步：验码消费 + 激活账号，成功后自动登录 */
  register: (email: string, password: string, code: string) => Promise<void>;
  logout: () => void;
  /** 当前是否为匿名账号：UI 据此隐藏访问令牌/录音/本地同步等入口 */
  isGuest: boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 本地快照用于首屏秒开：有快照时立即视为已登录并渲染，/auth/me 改为后台静默校验，
  // 避免跨机房一次往返（约 0.7s）造成的整屏白屏等待。
  const [user, setUser] = useState<AuthUser | null>(() => readCachedUser());
  const [isLoading, setIsLoading] = useState(() => !readCachedUser());
  const nav = useNavigate();

  // 登录态变化时绑定离线缓存归属用户。
  // 切换账号会清空上一个用户的缓存，避免同浏览器串数据。
  useEffect(() => {
    void bindUser(user?.id ?? null);
  }, [user?.id]);

  useEffect(() => {
    /**
     * 静默校验登录态。
     * 关键区别：网络不可达 ≠ 鉴权失败。
     * - 断网时保留本地快照与 token，让离线模式继续渲染（否则断网打开会被直接踢回登录页）；
     * - 只有服务端明确否定鉴权时，才清除 token 与用户快照。
     */
    const init = async () => {
      if (!isAuthenticated() && !mayHaveSession()) {
        setIsLoading(false);
        return;
      }
      try {
        const me = await authApi.me();
        writeCachedUser(me);
        setUser(me);
      } catch (err) {
        if (isNetworkError(err) || isOffline()) {
          // 离线：维持快照登录态
          return;
        }
        // 鉴权失败：setAuthTokens(null) 会同时清除 token 与本地用户快照
        setUser(null);
        setAuthTokens({ accessToken: null });
      } finally {
        setIsLoading(false);
      }
    };
    void init();
  }, []);

  // 恢复联网后补一次静默校验，把「离线推断的登录态」升级为服务端确认的登录态；
  // 校验仍然失败时保持现状，不做登出，避免网络抖动导致误踢。
  useEffect(() => {
    const onOnline = () => {
      if (!isAuthenticated() && !mayHaveSession()) return;
      void authApi.me()
        .then((me) => {
          writeCachedUser(me);
          setUser(me);
        })
        .catch(() => { /* 保持现状 */ });
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      writeCachedUser(null);
      setUser(null);
      nav('/login');
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, [nav]);

  const login = useCallback(async (email: string, password: string) => {
    // 登录响应已携带用户信息，直接落库并写入快照，省去一次 /auth/me 往返
    const { user: loggedInUser } = await authApi.login(email, password);
    writeCachedUser(loggedInUser);
    setUser(loggedInUser);
    nav('/');
  }, [nav]);

  const guestLogin = useCallback(async () => {
    // 与普通登录同构：服务端签发的是标准 JWT，笔记与 AI 接口无需特殊处理
    const { user: guestUser } = await authApi.guestLogin();
    writeCachedUser(guestUser);
    setUser(guestUser);
    nav('/');
  }, [nav]);

  const register = useCallback(async (email: string, password: string, code: string) => {
    // 验证码在前两步已校验，此处完成注册（消费验证码 + 激活账号）后直接登录
    await authApi.completeRegister(email, code, password);
    await login(email, password);
  }, [login]);

  const logout = useCallback(() => {
    // 先通知服务端：匿名账号据此立即清除数据，不必再等 30 分钟宽限期。
    // fire-and-forget，且 notifyLogout 内部已吞掉所有异常，绝不阻塞本地登出。
    void authApi.notifyLogout();
    // authApi.logout 内部调用 setAuthTokens(null)，会一并清除本地用户快照
    // 与离线缓存（IndexedDB），满足「登出时清空本地数据」
    authApi.logout();
    setUser(null);
    nav('/login');
  }, [nav]);

  const value = useMemo(
    () => ({ user, isLoading, login, guestLogin, register, logout, isGuest: user?.isGuest === true }),
    [user, isLoading, login, guestLogin, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
