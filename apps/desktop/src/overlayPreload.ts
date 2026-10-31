import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aetherOverlay', {
  onUpdate: (cb: (payload: unknown) => void) => {
    ipcRenderer.on('overlay:render', (_ev, payload) => cb(payload));
  },
});

