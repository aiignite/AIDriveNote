/**
 * unlockStore – 加密文档 / 加密文件夹「解锁票据」的内存存储。
 *
 * 设计取舍：
 * - 票据由服务端签发，内含本次派生出的内容密钥，用于在会话内免密码读写加密正文；
 * - 仅保存在内存（不落 localStorage / IndexedDB / SW 缓存），因此刷新页面即回到锁定态，
 *   避免同一台设备的其他人打开页面就能读到解密内容；
 * - 登出或鉴权失效时由 client.ts 调用 clearAllUnlock 清空。
 */

/** 保护范围：笔记自身加密 / 加密文件夹 */
export type LockScope = 'note' | 'folder';

/** 内存票据表，key 形如 `note:<id>` / `folder:<id>` */
const store = new Map<string, string>();

/**
 * 生成票据存储键。
 * @param scope 保护范围
 * @param id 对象 ID
 * @returns 形如 `note:<id>` 的键
 */
function keyOf(scope: LockScope, id: string): string {
  return `${scope}:${id}`;
}

/**
 * 写入解锁票据。
 * @param scope 保护范围
 * @param id 对象 ID
 * @param token 服务端返回的票据；为空时视为不写入（保持原有票据不变）
 */
export function setUnlockToken(scope: LockScope, id: string, token: string | null | undefined): void {
  if (token) store.set(keyOf(scope, id), token);
}

/**
 * 读取解锁票据。
 * @param scope 保护范围
 * @param id 对象 ID
 * @returns 票据字符串；不存在返回 null
 */
export function getUnlockToken(scope: LockScope, id: string): string | null {
  return store.get(keyOf(scope, id)) ?? null;
}

/**
 * 删除单个对象的解锁票据（取消加密 / 修改密码后需作废旧票据）。
 * @param scope 保护范围
 * @param id 对象 ID
 */
export function clearUnlockToken(scope: LockScope, id: string): void {
  store.delete(keyOf(scope, id));
}

/** 清空全部票据（登出 / 鉴权失效时调用）。 */
export function clearAllUnlock(): void {
  store.clear();
}

/**
 * 构造请求头：有票据则附带 `X-Note-Unlock`。
 * @param token 解锁票据
 * @returns 请求头对象；无票据时返回空对象
 */
export function buildUnlockHeader(token?: string | null): Record<string, string> {
  return token ? { 'X-Note-Unlock': token } : {};
}
