import type { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { RuntimeRegistry } from '../runtime-registry';
import type { PiClient } from '../types';

/**
 * 显式注入的共享依赖：由 client.ts 的模块级单例初始化后传入各子模块。
 * 子模块不得自行创建这些依赖，也不得把 top-level await 移入子模块。
 */
export type ClientDeps = {
  runtimeRegistry: RuntimeRegistry;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  ensureModel: () => Promise<any>;
  /** createPiClient 返回的客户端实例本身，用于替代原方法体内的 `this.xxx()` 调用。 */
  client: PiClient;
};
