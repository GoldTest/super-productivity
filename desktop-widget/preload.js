const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  getConfig: () => ipcRenderer.invoke('widget:get-config'),
  saveConfig: (updates) => ipcRenderer.invoke('widget:save-config', updates),
  autoDetectToken: () => ipcRenderer.invoke('widget:auto-detect-token'),
  togglePin: () => ipcRenderer.invoke('widget:toggle-pin'),
  setOpacity: (val) => ipcRenderer.send('widget:set-opacity', val),
  minimize: () => ipcRenderer.send('widget:minimize'),
  close: () => ipcRenderer.send('widget:close'),
  setCollapsed: (collapsed, targetWidth) => ipcRenderer.invoke('widget:set-collapsed', collapsed, targetWidth),
  updateMiniWidth: (targetWidth) => ipcRenderer.invoke('widget:update-mini-width', targetWidth),
  onCollapsedChanged: (callback) => {
    ipcRenderer.on('widget:collapsed-changed', (_event, val) => callback(val));
  },
  onEdgeSnapped: (callback) => {
    ipcRenderer.on('widget:edge-snapped', (_event, edge) => callback(edge));
  },
});
