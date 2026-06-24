import type { PiplusRuntimeConfig } from '../lib/runtime-config';

declare global {
  interface Window {
    piplusConfig?: PiplusRuntimeConfig;
  }
}

export {};
