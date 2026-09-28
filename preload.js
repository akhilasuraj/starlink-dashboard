const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  getStatus: () => ipcRenderer.invoke("collector:status"),
  getHistory: (range) => ipcRenderer.invoke("collector:history", range),
  getLogs: () => ipcRenderer.invoke("collector:logs"),
  clearLogs: () => ipcRenderer.invoke("collector:clear-logs"),
});

contextBridge.exposeInMainWorld("desktopSettings", {
  getStartOnLogin: () => ipcRenderer.invoke("startup:get"),
  setStartOnLogin: (enabled) => ipcRenderer.invoke("startup:set", enabled),
});

contextBridge.exposeInMainWorld("desktopUpdates", {
  getState: () => ipcRenderer.invoke("updates:get"),
  check: () => ipcRenderer.invoke("updates:check"),
  download: () => ipcRenderer.invoke("updates:download"),
  install: () => ipcRenderer.invoke("updates:install"),
});
