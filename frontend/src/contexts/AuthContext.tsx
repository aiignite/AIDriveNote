import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/auth';
import {
  isAuthenticated,
  mayHaveSession,
  readCachedUser,
  setAuthTokens,
  writeCachedUser,
} from '../services/client';

interface AuthContextValue {
  user: { id: string; email: string; name: string; status: string; role: string } | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 本地快照用于首屏秒开：有快照时立即视为已登录并渲染，/auth/me 改为后台静默校验，
  // 避免跨机房一次往返（约 0.7s）造成的整屏白屏等待。
  const [user, setUser] = useState<AuthContextValue['user']>(() => readCachedUser());
  const [isLoading, setIsLoading] = useState(() => !readCachedUser());
  const nav = useNavigate();

  useEffect(() => {
    const init = async () => {
      if (!isAuthenticated() && !mayHaveSession()) {
        setIsLoading(false);
        return;
      }
      try {
        const me = await authApi.me();
        writeCachedUser(me);
        setUser(me);
      } catch {
        // 校验失败：setAuthTokens(null) 会同时清除 token 与本地用户快照
        setUser(null);
        setAuthTokens({ accessToken: null });
      } finally {
        setIsLoading(false);
      }
    };
    void init();
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

  const register = useCallback(async (email: string, password: string, name: string) => {
    await authApi.register({ email, password, name });
    await login(email, password);
  }, [login]);

  const logout = useCallback(() => {
    // authApi.logout 内部调用 setAuthTokens(null)，会一并清除本地用户快照
    authApi.logout();
    setUser(null);
    nav('/login');
  }, [nav]);

  const value = useMemo(
    () => ({ user, isLoading, login, register, logout }),
    [user, isLoading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
