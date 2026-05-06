const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sshDock", {
  listConnections: () => ipcRenderer.invoke("connections:list"),
  saveConnection: (connection) => ipcRenderer.invoke("connections:save", connection),
  deleteConnection: (id) => ipcRenderer.invoke("connections:delete", id),
  chooseKeyPath: () => ipcRenderer.invoke("dialog:keyPath"),
  connect: (payload) => ipcRenderer.invoke("ssh:connect", payload),
  sendInput: (payload) => ipcRenderer.send("ssh:input", payload),
  resize: (payload) => ipcRenderer.send("ssh:resize", payload),
  disconnect: (sessionId) => ipcRenderer.invoke("ssh:disconnect", sessionId),
  uploadFile: (payload) => ipcRenderer.invoke("ssh:upload", payload),
  openTerminalWindow: (payload) => ipcRenderer.invoke("terminal:open-window", payload),
  terminalSnapshot: (sessionId) => ipcRenderer.invoke("terminal:snapshot", sessionId),
  onData: (callback) => ipcRenderer.on("ssh:data", (_event, payload) => callback(payload)),
  onUploadProgress: (callback) => ipcRenderer.on("ssh:upload-progress", (_event, payload) => callback(payload)),
  onClosed: (callback) => ipcRenderer.on("ssh:closed", (_event, payload) => callback(payload)),
  onError: (callback) => ipcRenderer.on("ssh:error", (_event, payload) => callback(payload)),
  onTerminalWindowClosed: (callback) => ipcRenderer.on("terminal:window-closed", (_event, payload) => callback(payload))
});
