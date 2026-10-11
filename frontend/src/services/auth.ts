import { api, setAuthTokens } from './client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  status: string;
  role: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessTokenExpiresIn: number;
  /** 登录接口一并返回用户信息，省去一次 /auth/me 往返；refresh 无此字段 */
  user: AuthUser;
}

export const authApi = {
  /** 公开认证配置：registration_enabled=false 时隐藏注册入口（公网测试部署仅管理员建号） */
  getConfig: () => api.get<{ registrationEnabled: boolean }>('/auth/config'),

  /** 第一步：校验邮箱并发送注册验证码（未注册邮箱会创建占位账号） */
  requestRegister: (email: string, name: string) =>
    api.post<{ message: string }>('/auth/register/request', { email, name }),

  /** 第二步：独立验码（不消费），供设置密码前确认 */
  verifyRegisterCode: (email: string, code: string) =>
    api.post<{ valid: boolean }>('/auth/register/verify-code', { email, code }),

  /** 第三步：验码并消费，设置密码激活账号 */
  completeRegister: (email: string, code: string, newPassword: string) =>
    api.post<AuthUser>('/auth/register/complete', { email, code, newPassword }),

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
