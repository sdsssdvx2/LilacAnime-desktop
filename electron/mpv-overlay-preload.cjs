const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mpvOverlay', {
  state: () => ipcRenderer.invoke('native-overlay:state'),
  command: command => ipcRenderer.invoke('native-overlay:command', command),
  action: action => ipcRenderer.invoke('native-overlay:action', String(action || '')),
  meta: () => ipcRenderer.invoke('native-overlay:meta'),
  diagnostics: () => ipcRenderer.invoke('native-overlay:diagnostics'),
  onSubtitle: callback => ipcRenderer.on('native-overlay:subtitle', (_event, value) => callback(value)),
  onReport: callback => ipcRenderer.on('native-overlay:report', (_event, value) => callback(value)),
  onReset: callback => ipcRenderer.on('native-overlay:reset', () => callback())
});
