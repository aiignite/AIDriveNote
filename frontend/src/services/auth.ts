import { api, setAuthTokens } from './client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  status: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessTokenExpiresIn: number;
}

export const authApi = {
  register: (data: { email: string; password: string; name: string }) =>
    api.post<AuthUser>('/auth/register', data),

  login: async (email: string, password: string) => {
    const tokens = await api.post<TokenResponse>('/auth/login', { email, password });
    setAuthTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    return tokens;
  },

  me: () => api.get<AuthUser>('/auth/me'),

  logout: () => {
    setAuthTokens({ accessToken: null });
  },
};
