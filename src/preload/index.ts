import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type PreloadApi } from '../shared/ipc';

const api: PreloadApi = {
  getBootstrapState: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_BOOTSTRAP_STATE),
  getSecretStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SECRET_GET_STATUS),
};

contextBridge.exposeInMainWorld('api', api);
