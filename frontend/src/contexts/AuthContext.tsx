import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/auth';
import { isAuthenticated, setAuthTokens } from '../services/client';

interface AuthContextValue {
  user: { id: string; email: string; name: string; status: string } | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthContextValue['user']>(null);
  const [isLoading, setIsLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    const init = async () => {
      if (!isAuthenticated()) {
        setIsLoading(false);
        return;
      }
      try {
        setUser(await authApi.me());
      } catch {
        setAuthTokens({ accessToken: null });
      } finally {
        setIsLoading(false);
      }
    };
    void init();
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      nav('/login');
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, [nav]);

  const login = useCallback(async (email: string, password: string) => {
    await authApi.login(email, password);
    setUser(await authApi.me());
    nav('/');
  }, [nav]);

  const register = useCallback(async (email: string, password: string, name: string) => {
    await authApi.register({ email, password, name });
    await login(email, password);
  }, [login]);

  const logout = useCallback(() => {
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
