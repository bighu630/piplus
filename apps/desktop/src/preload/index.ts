import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('piplusConfig', {
  isDesktop: true,
  platform: process.platform,
  theme: {
    setPreference: (preference: 'light' | 'dark' | 'system') => {
      ipcRenderer.send('theme:set-preference', preference);
    },
  },
});
