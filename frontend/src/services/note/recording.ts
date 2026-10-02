/**
 * recording.ts — 笔记音频录音 / 语音转写服务 API
 *
 * 统一前缀 `${API_BASE}/api/v1`，后端返回 snake_case，client.ts 的 api.* 会自动
 * 转为 camelCase；multipart 上传走 fetchWithAuth（保持鉴权与 401 刷新），
 * 手动对返回体做 keysToCamel 转换。
 *
 * 后端契约（/note-recordings）：
 *   POST   /note-recordings                    multipart，file + 可选 note_id
 *   GET    /note-recordings?note_id=<uuid>      { items, total }
 *   GET    /note-recordings/{id}                RecordingDetailOut（含 transcripts）
 *   GET    /note-recordings/{id}/transcript     { status, progressPct, errorMessage, segments }
 *   POST   /note-recordings/{id}/retranscribe
 *   POST   /note-recordings/{id}/refine
 *   DELETE /note-recordings/{id}                { ok }
 */
import { api, API_BASE, buildQuery, fetchWithAuth } from '../client';
import { keysToCamel } from '../../utils/caseConverter';

/** 录音状态机取值 */
export type NoteRecordingStatus = 'Uploaded' | 'Transcribing' | 'Transcribed' | 'Failed';

/** 录音记录（RecordingOut） */
export interface NoteRecording {
  /** 录音 id */
  id: string;
  /** 关联笔记 id */
  noteId: string | null;
  /** 上传用户 id */
  userId: string | null;
  /** 原始文件名 */
  fileName: string;
  /** 文件字节数 */
  fileSize: number;
  /** 音频时长（秒），未知时为 null */
  durationSeconds: number | null;
  /** MIME 类型 */
  mimeType: string | null;
  /** 处理状态 */
  status: NoteRecordingStatus;
  /** 转写进度百分比 0-100 */
  progressPct: number;
  /** 识别语言 */
  language: string | null;
  /** 模型规格 */
  modelSize: string | null;
  /** 失败原因 */
  errorMessage: string | null;
  /** 后端算好的可直接播放地址（形如 /api/v1/note-recordings/{id}/audio?s=<sig>） */
  audioUrl: string | null;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/** 转写分段（TranscriptSegmentOut） */
export interface TranscriptSegment {
  /** 分段 id */
  id: string;
  /** 分段序号，用于排序 */
  segmentIndex: number;
  /** 起始时间（秒） */
  startTime: number;
  /** 结束时间（秒） */
  endTime: number;
  /** 说话人标签 */
  speakerLabel: string | null;
  /** 分段文本 */
  text: string;
  /** 置信度 0-1 */
  confidence: number | null;
  /** 语言 */
  language: string | null;
  /** 章节 id */
  chapterId: number | null;
  /** 章节标题 */
  chapterTitle: string | null;
  /** 关键词 */
  keywords: string[] | null;
}

/** 录音详情（RecordingDetailOut = RecordingOut + transcripts） */
export interface NoteRecordingDetail extends NoteRecording {
  /** 已生成的转写分段 */
  transcripts: TranscriptSegment[];
}

/** 转写查询结果（GET /{id}/transcript） */
export interface TranscriptResult {
  /** 处理状态 */
  status: NoteRecordingStatus;
  /** 进度百分比 */
  progressPct: number;
  /** 失败原因 */
  errorMessage: string | null;
  /** 转写分段 */
  segments: TranscriptSegment[];
}

/** 录音列表响应 */
export interface RecordingListResponse {
  /** 记录列表 */
  items: NoteRecording[];
  /** 总数 */
  total: number;
}

/**
 * 解析 fetchWithAuth 返回的 JSON，并对非 2xx 抛出可读错误。
 * @param res fetch 响应
 * @returns camelCase 化的响应体
 */
async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail: unknown = text;
    try {
      detail = JSON.parse(text)?.detail ?? text;
    } catch {
      /* 非 JSON 错误体时直接用原文 */
    }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  if (!text) return undefined as T;
  return keysToCamel<T>(JSON.parse(text));
}

/** 浏览器内置 ASR（Web Speech API）分段（未落库前，随上传提交） */
export interface BrowserTranscriptSegment {
  /** 分段文本 */
  text: string;
  /** 起始时间（秒，近似值） */
  start_time: number;
  /** 结束时间（秒，近似值） */
  end_time: number;
}

/** 笔记录音 / 转写服务 API */
export const noteRecordingApi = {
  /**
   * 上传音频（multipart）。
   *
   * 若附带 ``transcripts``（浏览器内置 ASR 结果），后端将直接落库并标记
   * Transcribed，跳过服务端 Whisper 流水线；否则走服务端转写。
   *
   * @param file 音频 Blob 或 File
   * @param noteId 可选关联笔记 id
   * @param transcripts 可选浏览器 ASR 分段（随上传提交）
   * @param durationSeconds 可选音频时长（秒），浏览器录音时由客户端上报
   * @param language 识别语言，默认 zh-CN
   * @returns 新建的录音记录
   */
  uploadRecording: async (
    file: File | Blob,
    noteId?: string,
    transcripts?: BrowserTranscriptSegment[],
    durationSeconds?: number,
    language = 'zh-CN',
  ): Promise<NoteRecording> => {
    const form = new FormData();
    const fileName = file instanceof File ? file.name : `recording-${Date.now()}.webm`;
    form.append('file', file, fileName);
    if (noteId) form.append('note_id', noteId);
    if (transcripts && transcripts.length > 0) {
      form.append(
        'transcripts',
        JSON.stringify(transcripts.map(({ text, start_time, end_time }) => ({ text, start_time, end_time }))),
      );
      form.append('duration_seconds', String(durationSeconds ?? 0));
      form.append('language', language);
    }
    const res = await fetchWithAuth('/note-recordings', { method: 'POST', body: form });
    return parseJsonResponse<NoteRecording>(res);
  },

  /**
   * 列出录音记录。
   * @param noteId 可选按笔记过滤
   * @returns 记录列表与总数
   */
  listRecordings: (noteId?: string): Promise<RecordingListResponse> =>
    api.get<RecordingListResponse>(`/note-recordings${buildQuery({ note_id: noteId })}`),

  /**
   * 获取录音详情（含已生成的分段）。
   * @param id 录音 id
   * @returns 录音详情
   */
  getRecording: (id: string): Promise<NoteRecordingDetail> =>
    api.get<NoteRecordingDetail>(`/note-recordings/${id}`),

  /**
   * 获取转写结果（状态 + 分段）。
   * @param id 录音 id
   * @returns 转写结果
   */
  getTranscript: (id: string): Promise<TranscriptResult> =>
    api.get<TranscriptResult>(`/note-recordings/${id}/transcript`),

  /**
   * 重新触发语音转写。
   * @param id 录音 id
   * @returns 更新后的录音记录
   */
  retranscribe: (id: string): Promise<NoteRecording> =>
    api.post<NoteRecording>(`/note-recordings/${id}/retranscribe`, {}),

  /**
   * 调用大模型对转写文本进行整理 / 润色。
   * @param id 录音 id
   * @returns 更新后的录音记录
   */
  refine: (id: string): Promise<NoteRecording> =>
    api.post<NoteRecording>(`/note-recordings/${id}/refine`, {}),

  /**
   * 删除录音。
   * @param id 录音 id
   * @returns { ok }
   */
  deleteRecording: (id: string): Promise<{ ok: boolean }> =>
    api.delete<{ ok: boolean }>(`/note-recordings/${id}`),

  /**
   * 兜底音频地址：当 RecordingOut.audioUrl 缺失时使用。
   * @param id 录音 id
   * @returns 后端音频播放地址
   */
  buildAudioUrl: (id: string): string => `${API_BASE}/note-recordings/${id}/audio`,
};

/**
 * 解析可直接用于 <audio src> / 音频块的最终地址。
 *
 * 后端返回的 audioUrl 为根相对路径（`/api/v1/...`），在子路径部署模式下
 * 会指向站点根目录而非应用前缀，因此这里统一替换为 API_BASE 前缀。
 *
 * @param audioUrl 后端返回的 audioUrl（可能为空）
 * @param id 录音 id，用于缺失时兜底
 * @returns 可直接播放的绝对/带前缀地址
 */
export function resolveAudioUrl(audioUrl: string | null | undefined, id: string): string {
  const raw = audioUrl || `${API_BASE}/note-recordings/${id}/audio`;
  if (raw.startsWith('/api/v1/')) {
    const base = API_BASE.replace(/\/+$/, '');
    return `${base}${raw.slice('/api/v1'.length)}`;
  }
  return raw;
}

export default noteRecordingApi;