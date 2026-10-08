/**
 * BlockNote 图片上传：压缩后上传为服务端资产，返回可写入正文的 URL。
 *
 * 背景：早期实现用 `FileReader.readAsDataURL` 把图片以 Base64 直接内嵌进笔记
 * JSONB。单图上限 5MB，十几张图就能让一条笔记膨胀到数十 MB，拖慢列表接口、
 * 检索、备份与同步。现改为「客户端压缩 → 上传 → 正文只存 URL」。
 *
 * 离线兜底：网络不可达时退回旧的 data URL 方案，保证离线编辑不丢图；
 * 用户下次联网保存时可由迁移脚本统一资产化。
 */

import { fetchWithAuth, isNetworkError, NetworkError } from '../services/client';

/** 服务端硬上限，与后端 MAX_IMAGE_BYTES 保持一致 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 客户端更严格的目标体积：超出则先压缩，尽量少传大图 */
const TARGET_MAX_BYTES = 1.5 * 1024 * 1024;
/** 压缩后的最长边（px）；1600 足够覆盖笔记场景的清晰度需求 */
const MAX_EDGE = 1600;
/** JPEG 压缩质量 */
const JPEG_QUALITY = 0.82;

export type ImageUploadResult = {
  /** 可写入正文的引用：离线时是 data URL，在线时是服务端 URL */
  url: string;
  /** 是否为离线兜底的 Base64（UI 可据此提示「待同步」） */
  pending: boolean;
};

/** 读文件为 data URL（离线兜底路径使用） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('读取图片失败'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 浏览器端压缩：长边缩放到 MAX_EDGE 内，并按质量迭代逼近目标体积。
 * 任何一步失败都返回原文件（压缩是优化，不该成为失败原因）。
 */
async function compressImage(file: File): Promise<File> {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    let quality = JPEG_QUALITY;
    let blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    while (blob.size > TARGET_MAX_BYTES && quality > 0.4) {
      quality -= 0.15;
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    // 压不动（小图本就小于目标）就用压缩结果；压过头则保留原图
    if (blob.size >= file.size && file.size < TARGET_MAX_BYTES) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {
      type: 'image/jpeg',
    });
  } catch {
    return file;
  }
}

/**
 * 上传图片资产。
 *
 * @param file 原始图片文件
 * @returns `{ url, pending }`；`pending=true` 表示走了离线 Base64 兜底
 * @throws 鉴权/业务失败时抛错（由调用方 toast）；网络不可达时自动降级不抛错
 */
export async function uploadNoteImage(file: File): Promise<ImageUploadResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error('仅支持图片文件');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('图片大小不能超过 5MB');
  }

  const payload = await compressImage(file);
  const form = new FormData();
  form.append('file', payload, payload.name || file.name);

  try {
    const res = await fetchWithAuth('/notes/assets', { method: 'POST', body: form });
    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try {
        detail = JSON.parse(text)?.detail ?? text;
      } catch { /* ignore */ }
      throw new Error(typeof detail === 'string' ? detail : '图片上传失败');
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error('图片上传失败：未返回地址');
    return { url: data.url, pending: false };
  } catch (err) {
    // 仅「网络不可达」才降级；401 / 业务错误必须暴露给用户
    if (!isNetworkError(err) && !(err instanceof NetworkError)) throw err;
    return { url: await readAsDataUrl(file), pending: true };
  }
}

/** 兼容旧调用点的薄封装：只要 URL，丢弃 pending 标记 */
export async function uploadImageAsDataUrl(file: File): Promise<string> {
  return (await uploadNoteImage(file)).url;
}