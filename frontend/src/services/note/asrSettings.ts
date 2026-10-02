/**
 * asrSettings.ts — 笔记语音转写（ASR）设置与常用词库服务 API
 *
 * 统一前缀 `${API_BASE}/api/v1`，后端返回 snake_case，client.ts 的 api.* 自动
 * 转 camelCase，因此接口定义统一使用 camelCase。
 *
 * 后端契约（/note-asr）：
 *   GET    /note-asr/settings                    AsrSettingsOut
 *   PUT    /note-asr/settings                    AsrSettingsOut
 *   POST   /note-asr/settings/test-remote        { ok, message, latencyMs? }
 *   GET    /note-asr/common-terms?keyword=        { items, total }
 *   POST   /note-asr/common-terms                CommonTermOut
 *   PATCH  /note-asr/common-terms/{id}           CommonTermOut
 *   DELETE /note-asr/common-terms/{id}           { ok }
 */
import { api, buildQuery } from '../client';

/** ASR 运行模式：本机 or 远程 */
export type AsrMode = 'local' | 'remote';

/** ASR 设置（AsrSettingsOut） */
export interface AsrSettings {
  /** 运行模式 */
  mode: AsrMode;
  /** 远程 ASR 网关地址 */
  remoteUrl: string | null;
  /** 远程 API Key（读取时为掩码 "********"） */
  remoteApiKey: string | null;
  /** 远程请求超时（秒） */
  remoteTimeoutSeconds: number;
  /** 本机 faster-whisper 模型名称 */
  model: string;
  /** 识别语言 */
  language: string;
  /** 计算设备：cpu / cuda */
  device: string;
  /** 计算精度：int8 / float16 等 */
  computeType: string;
  /** 远程不可用时是否降级到本机 */
  fallbackToLocal: boolean;
  /** 最后更新时间 */
  updatedAt?: string | null;
  /** 最后更新人 */
  updatedBy?: string | null;
}

/** ASR 设置更新请求（字段全部可选） */
export type AsrSettingsUpdate = Partial<
  Pick<
    AsrSettings,
    | 'mode'
    | 'remoteUrl'
    | 'remoteApiKey'
    | 'remoteTimeoutSeconds'
    | 'model'
    | 'language'
    | 'device'
    | 'computeType'
    | 'fallbackToLocal'
  >
>;

/** 远程连通性测试结果 */
export interface AsrTestResult {
  /** 是否可用 */
  ok: boolean;
  /** 结果提示 */
  message: string;
  /** 延迟（毫秒） */
  latencyMs?: number;
}

/** 常用词（CommonTermOut） */
export interface CommonTerm {
  /** 词条 id */
  id: string;
  /** 词条本体 */
  term: string;
  /** 同音 / 易错写法 */
  alias: string | null;
  /** 备注 */
  remark: string | null;
  /** 是否启用 */
  isEnabled: boolean;
  /** 使用次数 */
  usageCount: number;
  /** 创建时间 */
  createdAt: string;
  /** 创建人 */
  createdBy: string | null;
}

/** 常用词列表响应 */
export interface CommonTermListResponse {
  /** 词条列表 */
  items: CommonTerm[];
  /** 总数 */
  total: number;
}

/** 新建 / 更新常用词的载荷 */
export interface CommonTermInput {
  /** 词条本体 */
  term?: string;
  /** 同音 / 易错写法 */
  alias?: string | null;
  /** 备注 */
  remark?: string | null;
  /** 是否启用 */
  isEnabled?: boolean;
}

/** 笔记 ASR 设置与常用词库 API */
export const noteAsrApi = {
  /**
   * 读取当前生效的 ASR 设置。
   * @returns ASR 设置
   */
  getAsrSettings: (): Promise<AsrSettings> => api.get<AsrSettings>('/note-asr/settings'),

  /**
   * 保存 ASR 设置。
   * @param data 待更新字段
   * @returns 更新后的设置
   */
  updateAsrSettings: (data: AsrSettingsUpdate): Promise<AsrSettings> =>
    api.put<AsrSettings>('/note-asr/settings', data),

  /**
   * 测试远程 ASR 服务连通性（需 admin）。
   * @returns 测试结果
   */
  testRemote: (): Promise<AsrTestResult> =>
    api.post<AsrTestResult>('/note-asr/settings/test-remote', {}),

  /**
   * 查询常用词。
   * @param keyword 关键词过滤
   * @returns 词条列表与总数
   */
  listCommonTerms: (keyword?: string): Promise<CommonTermListResponse> =>
    api.get<CommonTermListResponse>(`/note-asr/common-terms${buildQuery({ keyword })}`),

  /**
   * 新建常用词。
   * @param data 词条数据
   * @returns 新建的词条
   */
  createCommonTerm: (data: CommonTermInput): Promise<CommonTerm> =>
    api.post<CommonTerm>('/note-asr/common-terms', data),

  /**
   * 更新常用词。
   * @param id 词条 id
   * @param data 待更新字段
   * @returns 更新后的词条
   */
  updateCommonTerm: (id: string, data: CommonTermInput): Promise<CommonTerm> =>
    api.patch<CommonTerm>(`/note-asr/common-terms/${id}`, data),

  /**
   * 删除常用词。
   * @param id 词条 id
   * @returns { ok }
   */
  deleteCommonTerm: (id: string): Promise<{ ok: boolean }> =>
    api.delete<{ ok: boolean }>(`/note-asr/common-terms/${id}`),
};

export default noteAsrApi;