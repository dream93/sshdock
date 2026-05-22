const { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { Client } = require("ssh2");

let mainWindow;
const sessions = new Map();
const terminalWindows = new Map();
const dragTempDirs = new Set();
const MAX_SESSION_HISTORY = 200000;
let cachedDragIcon;

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
    closeSftp(session);
    session.stream?.end();
    session.client?.end();
  }
  terminalWindows.clear();
  cleanupDragTempDirs();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  cleanupDragTempDirs();
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
            const closing = sessions.get(sessionId);
            if (closing) closeSftp(closing);
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
        const failing = sessions.get(sessionId);
        if (failing) closeSftp(failing);
        sessions.delete(sessionId);
        if (!settled) reject(error);
        else sendSessionEvent(sessionId, "ssh:error", { sessionId, message: error.message });
      })
      .on("close", () => {
        const closing = sessions.get(sessionId);
        if (closing) closeSftp(closing);
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
    closeSftp(session);
    session.stream?.end();
    session.client?.end();
    sessions.delete(sessionId);
    closeTerminalWindows(sessionId);
  }
  return true;
});

function closeSftp(session) {
  if (session?.sftp) {
    try { session.sftp.end(); } catch {}
    session.sftp = null;
  }
}

async function getSftp(session) {
  if (session.sftp) return session.sftp;
  const sftp = await new Promise((resolve, reject) => {
    session.client.sftp((error, client) => {
      if (error) reject(error);
      else resolve(client);
    });
  });
  const clear = () => { if (session.sftp === sftp) session.sftp = null; };
  sftp.on("end", clear);
  sftp.on("close", clear);
  session.sftp = sftp;
  return sftp;
}

function sftpRealpath(sftp, p) {
  return new Promise((resolve) => {
    sftp.realpath(p, (error, abs) => resolve(error ? p : abs));
  });
}

function sftpStat(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (error, attrs) => error ? reject(error) : resolve(attrs));
  });
}

function sftpReaddir(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.readdir(p, (error, list) => error ? reject(error) : resolve(list));
  });
}

function sftpMkdir(sftp, p) {
  return new Promise((resolve) => {
    sftp.mkdir(p, () => resolve());
  });
}

function normalizeRemotePath(target) {
  if (!target) return ".";
  let trimmed = String(target).replace(/\/+$/g, "");
  if (!trimmed) return "/";
  return trimmed;
}

function parentPosix(target) {
  if (!target || target === "/") return "/";
  const trimmed = target.replace(/\/+$/g, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function computeLocalSize(localPath) {
  const stat = fs.statSync(localPath);
  if (stat.isFile()) return stat.size;
  if (stat.isDirectory()) {
    let total = 0;
    for (const item of fs.readdirSync(localPath, { withFileTypes: true })) {
      try {
        total += computeLocalSize(path.join(localPath, item.name));
      } catch {}
    }
    return total;
  }
  return 0;
}

async function computeRemoteSize(sftp, remotePath) {
  const attrs = await sftpStat(sftp, remotePath);
  if (attrs.isDirectory()) {
    const entries = await sftpReaddir(sftp, remotePath);
    let total = 0;
    for (const entry of entries) {
      if (entry.attrs.isDirectory()) {
        total += await computeRemoteSize(sftp, posixJoin(remotePath, entry.filename));
      } else if (entry.attrs.isFile()) {
        total += entry.attrs.size;
      }
    }
    return total;
  }
  return attrs.size;
}

async function uploadFileSftp(sftp, localPath, remotePath, ctx) {
  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      step: (transferred) => {
        sendSessionEvent(ctx.sessionId, "ssh:upload-progress", {
          sessionId: ctx.sessionId,
          uploadId: ctx.uploadId,
          fileName: ctx.displayName,
          transferred: ctx.progress.bytes + transferred,
          total: ctx.totalSize,
          remotePath: ctx.rootRemotePath
        });
      }
    }, (error) => error ? reject(error) : resolve());
  });
  ctx.progress.bytes += fs.statSync(localPath).size;
}

async function uploadDirRecursive(sftp, localDir, remoteDir, ctx) {
  await sftpMkdir(sftp, remoteDir);
  for (const item of fs.readdirSync(localDir, { withFileTypes: true })) {
    const childLocal = path.join(localDir, item.name);
    const childRemote = posixJoin(remoteDir, item.name);
    if (item.isDirectory()) {
      await uploadDirRecursive(sftp, childLocal, childRemote, ctx);
    } else if (item.isFile()) {
      await uploadFileSftp(sftp, childLocal, childRemote, ctx);
    }
  }
}

async function downloadFileSftp(sftp, remotePath, localPath, ctx) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  await new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, {
      step: (transferred) => {
        sendSessionEvent(ctx.sessionId, "ssh:download-progress", {
          sessionId: ctx.sessionId,
          downloadId: ctx.downloadId,
          fileName: ctx.displayName,
          transferred: ctx.progress.bytes + transferred,
          total: ctx.totalSize,
          localPath: ctx.rootLocalPath
        });
      }
    }, (error) => error ? reject(error) : resolve());
  });
  try { ctx.progress.bytes += fs.statSync(localPath).size; } catch {}
}

async function downloadDirRecursive(sftp, remoteDir, localDir, ctx) {
  fs.mkdirSync(localDir, { recursive: true });
  const entries = await sftpReaddir(sftp, remoteDir);
  for (const entry of entries) {
    const childRemote = posixJoin(remoteDir, entry.filename);
    const childLocal = path.join(localDir, entry.filename);
    if (entry.attrs.isDirectory()) {
      await downloadDirRecursive(sftp, childRemote, childLocal, ctx);
    } else if (entry.attrs.isFile()) {
      await downloadFileSftp(sftp, childRemote, childLocal, ctx);
    }
  }
}

function getDragIcon() {
  if (cachedDragIcon && !cachedDragIcon.isEmpty()) return cachedDragIcon;
  const candidates = [
    path.join(__dirname, "renderer", "assets", "icon.png"),
    path.join(__dirname, "..", "build", "icon.png")
  ];
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        cachedDragIcon = image.resize({ width: 32, height: 32 });
        return cachedDragIcon;
      }
    } catch {}
  }
  cachedDragIcon = nativeImage.createFromBuffer(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAH0lEQVR42mNk+M9AAGAcVTiqcFThqMJRhaMKRxUONwAAfQEBkGtbVPYAAAAASUVORK5CYII=",
      "base64"
    )
  );
  return cachedDragIcon;
}

function cleanupDragTempDirs() {
  for (const dir of dragTempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  dragTempDirs.clear();
}

ipcMain.handle("ssh:listdir", async (_event, payload) => {
  const session = sessions.get(payload?.sessionId);
  if (!session?.client) throw new Error("No active SSH session.");
  const sftp = await getSftp(session);

  let target = normalizeRemotePath(payload?.remotePath);
  target = await sftpRealpath(sftp, target);

  const entries = await sftpReaddir(sftp, target);
  const list = entries.map((entry) => ({
    name: entry.filename,
    isDirectory: entry.attrs.isDirectory(),
    isSymbolicLink: entry.attrs.isSymbolicLink(),
    size: Number(entry.attrs.size || 0),
    mtime: Number(entry.attrs.mtime || 0) * 1000
  }));
  list.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return { path: target, parent: parentPosix(target), entries: list };
});

ipcMain.handle("ssh:home", async (_event, payload) => {
  const session = sessions.get(payload?.sessionId);
  if (!session?.client) throw new Error("No active SSH session.");
  const sftp = await getSftp(session);
  return await sftpRealpath(sftp, ".");
});

ipcMain.handle("ssh:upload", async (_event, payload) => {
  const session = sessions.get(payload.sessionId);
  if (!session?.client) throw new Error("No active SSH session.");

  const localPath = String(payload.localPath || "");
  const stat = fs.statSync(localPath);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error("Only files and folders are supported.");
  }

  const sftp = await getSftp(session);
  const displayName = path.basename(localPath);
  const remoteDir = payload.remoteDir
    ? await sftpRealpath(sftp, normalizeRemotePath(payload.remoteDir))
    : await sftpRealpath(sftp, ".");
  const rootRemotePath = posixJoin(remoteDir, displayName);
  const uploadId = crypto.randomUUID();
  const totalSize = computeLocalSize(localPath);
  const ctx = {
    sessionId: payload.sessionId,
    uploadId,
    displayName,
    totalSize,
    rootRemotePath,
    progress: { bytes: 0 }
  };

  sendSessionEvent(payload.sessionId, "ssh:upload-progress", {
    sessionId: payload.sessionId,
    uploadId,
    fileName: displayName,
    transferred: 0,
    total: totalSize,
    remotePath: rootRemotePath
  });

  if (stat.isDirectory()) {
    await uploadDirRecursive(sftp, localPath, rootRemotePath, ctx);
  } else {
    await uploadFileSftp(sftp, localPath, rootRemotePath, ctx);
  }

  sendSessionEvent(payload.sessionId, "ssh:upload-progress", {
    sessionId: payload.sessionId,
    uploadId,
    fileName: displayName,
    transferred: totalSize,
    total: totalSize,
    remotePath: rootRemotePath
  });

  return {
    uploadId,
    fileName: displayName,
    remotePath: rootRemotePath,
    size: totalSize,
    isDirectory: stat.isDirectory()
  };
});

ipcMain.handle("ssh:start-drag", async (event, payload) => {
  const session = sessions.get(payload?.sessionId);
  if (!session?.client) throw new Error("No active SSH session.");
  const sftp = await getSftp(session);
  const remotePath = normalizeRemotePath(payload.remotePath);
  const attrs = await sftpStat(sftp, remotePath);
  const displayName = String(payload.name || path.posix.basename(remotePath) || "download");

  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "sshdock-drag-"));
  dragTempDirs.add(tempBase);
  const rootLocalPath = path.join(tempBase, displayName);
  const downloadId = crypto.randomUUID();
  const totalSize = attrs.isDirectory() ? await computeRemoteSize(sftp, remotePath) : Number(attrs.size || 0);
  const ctx = {
    sessionId: payload.sessionId,
    downloadId,
    displayName,
    totalSize,
    rootLocalPath,
    progress: { bytes: 0 }
  };

  sendSessionEvent(payload.sessionId, "ssh:download-progress", {
    sessionId: payload.sessionId,
    downloadId,
    fileName: displayName,
    transferred: 0,
    total: totalSize,
    localPath: rootLocalPath
  });

  try {
    if (attrs.isDirectory()) {
      await downloadDirRecursive(sftp, remotePath, rootLocalPath, ctx);
    } else {
      await downloadFileSftp(sftp, remotePath, rootLocalPath, ctx);
    }
  } catch (error) {
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch {}
    dragTempDirs.delete(tempBase);
    throw error;
  }

  sendSessionEvent(payload.sessionId, "ssh:download-progress", {
    sessionId: payload.sessionId,
    downloadId,
    fileName: displayName,
    transferred: totalSize,
    total: totalSize,
    localPath: rootLocalPath
  });

  event.sender.startDrag({ file: rootLocalPath, icon: getDragIcon() });
  return { downloadId, localPath: rootLocalPath, size: totalSize, isDirectory: attrs.isDirectory() };
});

ipcMain.handle("ssh:mkdir", async (_event, payload) => {
  const session = sessions.get(payload?.sessionId);
  if (!session?.client) throw new Error("No active SSH session.");
  const sftp = await getSftp(session);
  const parent = await sftpRealpath(sftp, normalizeRemotePath(payload.remoteDir));
  const target = posixJoin(parent, String(payload.name || "").trim());
  await new Promise((resolve, reject) => {
    sftp.mkdir(target, (error) => error ? reject(error) : resolve());
  });
  return target;
});

ipcMain.handle("ssh:rm", async (_event, payload) => {
  const session = sessions.get(payload?.sessionId);
  if (!session?.client) throw new Error("No active SSH session.");
  const sftp = await getSftp(session);
  const target = normalizeRemotePath(payload.remotePath);
  const attrs = await sftpStat(sftp, target);
  if (attrs.isDirectory()) {
    await removeRemoteDir(sftp, target);
  } else {
    await new Promise((resolve, reject) => {
      sftp.unlink(target, (error) => error ? reject(error) : resolve());
    });
  }
  return true;
});

async function removeRemoteDir(sftp, target) {
  const entries = await sftpReaddir(sftp, target);
  for (const entry of entries) {
    const child = posixJoin(target, entry.filename);
    if (entry.attrs.isDirectory()) await removeRemoteDir(sftp, child);
    else await new Promise((resolve, reject) => {
      sftp.unlink(child, (error) => error ? reject(error) : resolve());
    });
  }
  await new Promise((resolve, reject) => {
    sftp.rmdir(target, (error) => error ? reject(error) : resolve());
  });
}
