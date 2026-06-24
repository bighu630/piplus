import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('piplusConfig', {
  isDesktop: true,
  platform: process.platform,
});
