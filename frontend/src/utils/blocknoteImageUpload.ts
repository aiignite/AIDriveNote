/** BlockNote 图片上传：将文件转为 base64 data URL 内嵌存储（与 Draw.io 内嵌策略一致） */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function uploadImageAsDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('仅支持图片文件');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('图片大小不能超过 5MB');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('读取图片失败'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}
