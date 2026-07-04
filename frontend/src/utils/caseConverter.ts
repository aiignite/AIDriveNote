/**
 * Utility to convert between snake_case (API) and camelCase (frontend).
 *
 * The backend returns snake_case JSON, but the frontend types
 * use camelCase. This module bridges the gap automatically.
 */

/** Convert a snake_case string to camelCase */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert a camelCase string to snake_case */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Internal set to debounce dev warnings (one per unique key) */
const _snakeCaseWarned = new Set<string>();

/** Recursively convert all object keys from snake_case to camelCase */
export function keysToCamel<T>(obj: any): T {
  if (Array.isArray(obj)) {
    return obj.map((item) => keysToCamel(item)) as T;
  }
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = toCamelCase(key);
      // Dev-only: warn if API still returns snake_case fields (expected behavior, logged once per key)
      if (import.meta.env.DEV && key !== camelKey) {
        if (!_snakeCaseWarned.has(key)) {
          _snakeCaseWarned.add(key);
          console.warn(
            `[caseConverter] snake_case key "${key}" → "${camelKey}". ` +
            `Frontend code must use camelCase field names.`
          );
        }
      }
      result[camelKey] = keysToCamel(value);
    }
    return result as T;
  }
  return obj;
}

/** Recursively convert all object keys from camelCase to snake_case */
export function keysToSnake(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map((item) => keysToSnake(item));
  }
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      // 跳过 undefined 值，让后端使用默认值
      if (value !== undefined) {
        result[toSnakeCase(key)] = keysToSnake(value);
      }
    }
    return result;
  }
  return obj;
}
