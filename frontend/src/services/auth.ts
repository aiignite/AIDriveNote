import { api, setAuthTokens } from './client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  status: string;
  role: string;
  /** 匿名登录账号：数据到期会被服务器清除，UI 据此隐藏令牌/录音/同步等入口 */
  isGuest?: boolean;
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
  /** 公开认证配置：registration_enabled=false 时隐藏注册入口；guest_login_enabled 同理 */
  getConfig: () => api.get<{ registrationEnabled: boolean; guestLoginEnabled: boolean }>('/auth/config'),

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

  /**
   * 匿名登录：为本次会话创建独立账号并签发标准 JWT。
   *
   * 与普通登录同构——笔记与 AI 接口无需任何特殊处理即可使用。
   * 该账号的数据在超过 30 分钟无请求后由服务器物理清除。
   */
  guestLogin: async () => {
    const tokens = await api.post<TokenResponse>('/auth/guest');
    setAuthTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    return tokens;
  },

  me: () => api.get<AuthUser>('/auth/me'),

  /**
   * 通知服务端「主动登出」。
   *
   * 匿名账号据此**立即**清除其数据，而不必再等 30 分钟宽限期到期。
   * 调用失败（网络问题、401）一律静默忽略——登出必须永远成功。
   */
  notifyLogout: async () => {
    try {
      await api.post<{ ok: boolean; purged: boolean }>('/auth/guest/logout');
    } catch {
      /* 服务端不可达时忽略：本地 token 清理已由 logout 完成 */
    }
  },

  logout: () => {
    setAuthTokens({ accessToken: null });
  },
};
