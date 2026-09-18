import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

type PersistentStateOptions<T> = {
  /** localStorage 原始字符串 → 状态值；缺省时原始值不可用，回落到 initial。 */
  parse?: (raw: string) => T;
  /** 状态值 → localStorage 字符串；缺省 String(value)。 */
  serialize?: (value: T) => string;
};

// 用 window.localStorage 而非裸 localStorage：与 auth-session / notification 的 safeStorage 一致，
// 不依赖运行时是否把 localStorage 挂到 globalThis（测试 / 非浏览器环境可能没有）。
function readStored(key: string): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage.getItem(key);
}

function writeStored(key: string, value: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(key, value);
}

/**
 * localStorage 持久化的 state：lazy 读取 + try/catch 容错 + 值变化时写回。
 * 用于替换 App 中大量手写的「初始化读 + effect 写」样板。
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  options?: PersistentStateOptions<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const resolveInitial = () => (typeof initial === 'function' ? (initial as () => T)() : initial);

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = readStored(key);
      // 空字符串视为「未存储」：与旧代码的 `if (saved)` / `saved ? ... : default` 惯用法一致
      if (raw && options?.parse) return options.parse(raw);
      return resolveInitial();
    } catch {
      return resolveInitial();
    }
  });

  // serialize 每次渲染可能是新函数引用：用 ref 持有，避免无谓重复写。
  const serializeRef = useRef(options?.serialize);
  serializeRef.current = options?.serialize;

  useEffect(() => {
    try {
      writeStored(key, (serializeRef.current ?? String)(value));
    } catch {
      // localStorage 不可用（隐私模式 / 禁用）时静默忽略
    }
  }, [key, value]);

  return [value, setValue];
}
