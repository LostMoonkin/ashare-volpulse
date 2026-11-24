import type { BootstrapState, SecretStatus } from './types';

/** 主进程与渲染进程共享 IPC 通道定义 */
export const IPC_CHANNELS = {
  APP_GET_BOOTSTRAP_STATE: 'app:get-bootstrap-state',
  SECRET_GET_STATUS: 'secret:get-status',
} as const;

/** 通过 contextBridge 暴露给渲染进程的严格类型化只读 API */
export interface PreloadApi {
  getBootstrapState(): Promise<BootstrapState>;
  getSecretStatus(): Promise<SecretStatus>;
}
