const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("ssh2");

let mainWindow;
const sessions = new Map();
const terminalWindows = new Map();
const MAX_SESSION_HISTORY = 200000;

function posixJoin(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function configPath() {
  return path.join(app.getPath("userData"), "connections.json");
}

function readConnections() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return JSON.parse(raw).map(decryptConnectionSecrets);
  } catch {
    return [];
  }
}

function writeConnections(connections) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(connections.map(encryptConnectionSecrets), null, 2), "utf8");
}

function encryptSecret(value) {
  const text = String(value || "");
  if (!text) return { value: "", encoding: "" };
  if (safeStorage.isEncryptionAvailable()) {
    return {
      value: safeStorage.encryptString(text).toString("base64"),
      encoding: "safeStorage"
    };
  }
  return { value: text, encoding: "plain" };
}

function decryptSecret(value, encoding) {
  const text = String(value || "");
  if (!text) return "";
  if (encoding === "safeStorage") {
    try {
      return safeStorage.decryptString(Buffer.from(text, "base64"));
    } catch {
      return "";
    }
  }
  return text;
}

function encryptConnectionSecrets(connection) {
  const password = encryptSecret(connection.password);
  const passphrase = encryptSecret(connection.passphrase);
  return {
    ...connection,
    password: password.value,
    passwordEncoding: password.encoding,
    passphrase: passphrase.value,
    passphraseEncoding: passphrase.encoding
  };
}

function decryptConnectionSecrets(connection) {
  return {
    ...connection,
    password: decryptSecret(connection.password, connection.passwordEncoding),
    passphrase: decryptSecret(connection.passphrase, connection.passphraseEncoding)
  };
}

function sanitizeConnection(input) {
  return {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || "").trim(),
    host: String(input.host || "").trim(),
    port: Number(input.port || 22),
    username: String(input.username || "").trim(),
    authType: input.authType === "key" ? "key" : "password",
    keyPath: String(input.keyPath || "").trim(),
    password: String(input.password || ""),
    passphrase: String(input.passphrase || "")
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    title: "SSHDock",
    backgroundColor: "#11151c",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function sessionWindows(sessionId) {
  let windows = terminalWindows.get(sessionId);
  if (!windows) {
    windows = new Set();
    terminalWindows.set(sessionId, windows);
  }
  return windows;
}

function sendSessionEvent(sessionId, channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }

  const windows = terminalWindows.get(sessionId);
  if (!windows) return;

  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function appendSessionHistory(sessionId, text) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.history = `${session.history || ""}${text}`;
  if (session.history.length > MAX_SESSION_HISTORY) {
    session.history = session.history.slice(session.history.length - MAX_SESSION_HISTORY);
  }
}

function closeTerminalWindows(sessionId) {
  const windows = terminalWindows.get(sessionId);
  if (!windows) return;

  for (const window of windows) {
    if (!window.isDestroyed()) window.close();
  }
  terminalWindows.delete(sessionId);
}

function createTerminalWindow(sessionId, title) {
  const existing = Array.from(terminalWindows.get(sessionId) || []).find((window) => !window.isDestroyed());
  if (existing) {
    existing.focus();
    return existing;
  }

  const terminalWindow = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 560,
    minHeight: 360,
    title: title ? `${title} - SSHDock` : "SSHDock Terminal",
    backgroundColor: "#070a0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  sessionWindows(sessionId).add(terminalWindow);
  terminalWindow.on("closed", () => {
    const windows = terminalWindows.get(sessionId);
    if (windows) {
      windows.delete(terminalWindow);
      if (windows.size === 0) terminalWindows.delete(sessionId);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:window-closed", { sessionId });
    }
  });

  terminalWindow.loadFile(path.join(__dirname, "renderer", "terminal-window.html"), {
    query: {
      sessionId,
      title: title || "Terminal"
    }
  });

  return terminalWindow;
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  for (const session of sessions.values()) {
    session.stream?.end();
    session.client?.end();
  }
  terminalWindows.clear();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("connections:list", () => readConnections());

ipcMain.handle("connections:save", (_event, input) => {
  const connection = sanitizeConnection(input);
  if (!connection.name || !connection.host || !connection.username) {
    throw new Error("Name, host, and username are required.");
  }

  const connections = readConnections();
  const index = connections.findIndex((item) => item.id === connection.id);
  if (index >= 0) connections[index] = connection;
  else connections.push(connection);
  writeConnections(connections);
  return connection;
});

ipcMain.handle("connections:delete", (_event, id) => {
  const connections = readConnections().filter((item) => item.id !== id);
  writeConnections(connections);
  return connections;
});

ipcMain.handle("dialog:keyPath", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose SSH private key",
    properties: ["openFile", "showHiddenFiles"]
  });
  return result.canceled ? "" : result.filePaths[0];
});

ipcMain.handle("terminal:open-window", (_event, payload) => {
  const sessionId = String(payload?.sessionId || "");
  if (!sessionId || !sessions.has(sessionId)) throw new Error("No active SSH session.");
  createTerminalWindow(sessionId, String(payload?.title || "Terminal"));
  return true;
});

ipcMain.handle("terminal:snapshot", (_event, sessionId) => {
  const session = sessions.get(String(sessionId || ""));
  if (!session) return { history: "" };
  return {
    history: session.history || "",
    title: session.title || "Terminal"
  };
});

ipcMain.handle("ssh:connect", async (_event, payload) => {
  const connection = sanitizeConnection(payload.connection || {});
  const sessionId = payload.sessionId || crypto.randomUUID();
  const client = new Client();

  const connectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    keepaliveInterval: 15000,
    readyTimeout: 20000
  };

  if (connection.authType === "key") {
    if (!connection.keyPath) throw new Error("Private key path is required.");
    connectConfig.privateKey = fs.readFileSync(connection.keyPath, "utf8");
    const passphrase = payload.passphrase || connection.passphrase;
    if (passphrase) connectConfig.passphrase = passphrase;
  } else {
    connectConfig.password = payload.password || connection.password || "";
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    client
      .on("ready", () => {
        client.shell({ term: "xterm-256color", cols: 100, rows: 30 }, (error, stream) => {
          if (error) {
            client.end();
            if (!settled) reject(error);
            return;
          }

          sessions.set(sessionId, { client, stream, history: "", title: connection.name || connection.host || "Terminal" });

          stream.on("data", (data) => {
            const text = data.toString("utf8");
            appendSessionHistory(sessionId, text);
            sendSessionEvent(sessionId, "ssh:data", { sessionId, data: text });
          });

          stream.stderr.on("data", (data) => {
            const text = data.toString("utf8");
            appendSessionHistory(sessionId, text);
            sendSessionEvent(sessionId, "ssh:data", { sessionId, data: text });
          });

          stream.on("close", () => {
            sessions.delete(sessionId);
            sendSessionEvent(sessionId, "ssh:closed", { sessionId });
            closeTerminalWindows(sessionId);
            client.end();
          });

          settled = true;
          resolve({ sessionId });
        });
      })
      .on("error", (error) => {
        sessions.delete(sessionId);
        if (!settled) reject(error);
        else sendSessionEvent(sessionId, "ssh:error", { sessionId, message: error.message });
      })
      .on("close", () => {
        sessions.delete(sessionId);
        sendSessionEvent(sessionId, "ssh:closed", { sessionId });
        closeTerminalWindows(sessionId);
      })
      .connect(connectConfig);
  });
});

ipcMain.on("ssh:input", (_event, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session?.stream) session.stream.write(payload.data);
});

ipcMain.on("ssh:resize", (_event, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session?.stream) {
    session.stream.setWindow(payload.rows, payload.cols, payload.height || 0, payload.width || 0);
  }
});

ipcMain.handle("ssh:disconnect", (_event, sessionId) => {
  const session = sessions.get(sessionId);
  if (session) {
    session.stream?.end();
    session.client?.end();
    sessions.delete(sessionId);
    closeTerminalWindows(sessionId);
  }
  return true;
});

ipcMain.handle("ssh:upload", async (_event, payload) => {
  const session = sessions.get(payload.sessionId);
  if (!session?.client) throw new Error("No active SSH session.");

  const localPath = String(payload.localPath || "");
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) throw new Error("Only single files are supported for drag upload.");

  const fileName = path.basename(localPath);
  const uploadId = crypto.randomUUID();

  const sftp = await new Promise((resolve, reject) => {
    session.client.sftp((error, sftpClient) => {
      if (error) reject(error);
      else resolve(sftpClient);
    });
  });

  const remoteRoot = await new Promise((resolve) => {
    sftp.realpath(".", (error, absolutePath) => {
      resolve(error ? "." : absolutePath);
    });
  });
  const remotePath = posixJoin(remoteRoot, fileName);

  sendSessionEvent(payload.sessionId, "ssh:upload-progress", {
    sessionId: payload.sessionId,
    uploadId,
    fileName,
    transferred: 0,
    total: stat.size,
    remotePath
  });

  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      step: (transferred, _chunk, total) => {
        sendSessionEvent(payload.sessionId, "ssh:upload-progress", {
          sessionId: payload.sessionId,
          uploadId,
          fileName,
          transferred,
          total,
          remotePath
        });
      }
    }, (error) => {
      sftp.end();
      if (error) reject(error);
      else resolve();
    });
  });

  return { uploadId, fileName, remotePath, size: stat.size };
});
