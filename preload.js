const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopSettings", {
  getStartOnLogin: () => ipcRenderer.invoke("startup:get"),
  setStartOnLogin: (enabled) => ipcRenderer.invoke("startup:set", enabled),
});
