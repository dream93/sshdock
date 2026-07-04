const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");
const { Client } = require("ssh2");

let pty = null;
function getPty() {
  if (!pty) pty = require("node-pty");
  return pty;
}

// 选择本机默认 shell 及参数
function defaultShell() {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "powershell.exe", args: [] };
  }
  const file = process.env.SHELL || "/bin/bash";
  // 交互式登录 shell，确保加载用户配置（.zshrc/.bash_profile 等）
  return { file, args: ["-l"] };
}

// 判断某个会话是否「有任务在运行」（用于关闭前提示确认）。
// 本地终端：shell 若有前台子进程（如 claude、vim、长命令）即视为有任务；停在提示符时无子进程。
// SSH 会话：shell 在远端，本地无法可靠探测前台进程，退化为「连接中即视为有任务」。
function localShellBusy(pty) {
  const pid = pty?.pid;
  if (!pid) return false;
  // Windows 下无 pgrep，且子进程树探测代价高，暂不阻塞（返回 false）
  if (process.platform === "win32") return false;
  try {
    // pgrep -P <shell pid>：有直接子进程 → 退出码 0；停在提示符无子进程 → 退出码 1（抛错）
    execFileSync("pgrep", ["-P", String(pid)], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function sessionHasActiveTask(sessionId) {
  const session = sessions.get(String(sessionId || ""));
  if (!session) return false;
  if (session.isLocal) return localShellBusy(session.pty);
  // SSH：会话存在于 sessions 即已连接成功，按「连接中」提示确认
  return true;
}

function anySessionHasActiveTask() {
  for (const id of sessions.keys()) {
    if (sessionHasActiveTask(id)) return true;
  }
  return false;
}

// 关闭前的同步确认框：返回 true 表示用户选择「仍然关闭」
function confirmCloseWithTask(parentWindow, message) {
  const result = dialog.showMessageBoxSync(parentWindow, {
    type: "warning",
    buttons: ["仍然关闭", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "SSHDock",
    message,
    detail: "关闭后正在运行的任务会被中断。"
  });
  return result === 0;
}

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

function terminalGroupsPath() {
  return path.join(app.getPath("userData"), "terminal-groups.json");
}

// 读取上次退出时记录的终端标签（仅保存标题与目录，不含会话状态）
function readTerminalGroups() {
  try {
    const raw = fs.readFileSync(terminalGroupsPath(), "utf8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeTerminalGroups(groups) {
  const list = (Array.isArray(groups) ? groups : [])
    .filter((g) => g && g.cwd)
    .map((g) => ({ title: String(g.title || ""), cwd: String(g.cwd || "") }));
  fs.mkdirSync(path.dirname(terminalGroupsPath()), { recursive: true });
  fs.writeFileSync(terminalGroupsPath(), JSON.stringify(list, null, 2), "utf8");
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

  // 关闭主窗口（红灯/Cmd+W）或退出 App（Cmd+Q，退出时各窗口同样收到 close）前：
  // 若任一会话仍有任务在运行，弹同步确认框；用户取消则阻止关闭。
  let allowClose = false;
  mainWindow.on("close", (event) => {
    if (allowClose) return;
    if (!anySessionHasActiveTask()) return;
    if (confirmCloseWithTask(mainWindow, "仍有终端任务在运行，确定关闭吗？")) {
      allowClose = true;
    } else {
      event.preventDefault();
    }
  });

  // Windows 上任务栏闪烁不会自动停止，窗口重新获得焦点时手动停掉。
  mainWindow.on("focus", () => mainWindow.flashFrame(false));

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

function createTerminalWindow(sessionId, title, kind = "ssh") {
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
  // 手动关闭弹出的独立终端窗口时，若该会话仍有任务在运行则确认；
  // 程序化关闭（会话已结束触发 closeTerminalWindows）时会话已从 sessions 移除，不会误拦。
  let allowWindowClose = false;
  terminalWindow.on("close", (event) => {
    if (allowWindowClose) return;
    if (!sessionHasActiveTask(sessionId)) return;
    if (confirmCloseWithTask(terminalWindow, "该终端仍有任务在运行，确定关闭窗口吗？")) {
      allowWindowClose = true;
    } else {
      event.preventDefault();
    }
  });
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
      title: title || "Terminal",
      kind: kind || "ssh"
    }
  });

  return terminalWindow;
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  for (const session of sessions.values()) {
    closeSftp(session);
    if (session.pty) {
      try { session.pty.kill(); } catch {}
    }
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

ipcMain.handle("localterm:create", (_event, payload) => {
  const sessionId = String(payload?.sessionId || "") || crypto.randomUUID();
  if (sessions.has(sessionId)) return { sessionId };

  const ptyLib = getPty();
  const { file, args } = defaultShell();
  const cols = Number(payload?.cols) || 100;
  const rows = Number(payload?.rows) || 30;

  // 新建终端默认在家目录；若指定了有效目录则继承（类 cmd+t）
  let cwd = os.homedir();
  if (payload?.cwd) {
    try { if (fs.statSync(payload.cwd).isDirectory()) cwd = payload.cwd; } catch {}
  }

  const child = ptyLib.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" }
  });

  const title = String(payload?.title || "").trim() || "Local Terminal";
  sessions.set(sessionId, { pty: child, history: "", title, isLocal: true });

  child.onData((data) => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    appendSessionHistory(sessionId, text);
    sendSessionEvent(sessionId, "ssh:data", { sessionId, data: text });
  });

  child.onExit(() => {
    sessions.delete(sessionId);
    sendSessionEvent(sessionId, "ssh:closed", { sessionId });
    closeTerminalWindows(sessionId);
  });

  return { sessionId, title };
});

// 查询某本地终端 shell 进程的当前工作目录（用于新建标签继承目录）
ipcMain.handle("localterm:cwd", async (_event, sessionId) => {
  const session = sessions.get(String(sessionId || ""));
  const pid = session?.pty?.pid;
  if (!pid) return "";
  try {
    if (process.platform === "linux") {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    }
    if (process.platform === "darwin") {
      return await new Promise((resolve) => {
        execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], (error, stdout) => {
          if (error) { resolve(""); return; }
          const line = String(stdout).split("\n").find((l) => l.startsWith("n"));
          resolve(line ? line.slice(1).trim() : "");
        });
      });
    }
  } catch {
    return "";
  }
  return "";
});

// 终端标签（本地终端组）的持久化：退出时记录、下次启动恢复
ipcMain.handle("termgroups:load", () => readTerminalGroups());

ipcMain.handle("termgroups:save", (_event, groups) => {
  writeTerminalGroups(groups);
  return true;
});

ipcMain.handle("terminal:open-window", (_event, payload) => {
  const sessionId = String(payload?.sessionId || "");
  if (!sessionId || !sessions.has(sessionId)) throw new Error("No active SSH session.");
  createTerminalWindow(sessionId, String(payload?.title || "Terminal"), String(payload?.kind || "ssh"));
  return true;
});

// 渲染端在关闭单个会话 / 终端组前查询是否有任务在运行
ipcMain.handle("terminal:has-active-task", (_event, sessionId) => sessionHasActiveTask(sessionId));

// 终端响铃且应用在后台时，让 Dock 图标跳动（macOS）/ 任务栏闪烁（Windows）提醒用户。
ipcMain.on("app:request-attention", () => {
  if (process.platform === "darwin") {
    app.dock?.bounce("informational");
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isFocused()) win.flashFrame(true);
  }
});

// Dock 角标（macOS）/ 任务栏图标计数：显示有多少个终端在等待用户处理。
ipcMain.on("app:set-badge", (_event, count) => {
  const n = Number(count) || 0;
  app.setBadgeCount(Math.max(0, n));
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
  // 按渲染端传入的真实可视尺寸打开远端 shell，避免以固定值打开导致远端按错误列数折行
  // （远端 bash 在第 N 列折行、xterm 按真实宽度渲染 → 长命令/行内编辑光标错位、重影）。
  const initialCols = Number(payload.cols) || 100;
  const initialRows = Number(payload.rows) || 30;
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
        client.shell({ term: "xterm-256color", cols: initialCols, rows: initialRows }, (error, stream) => {
          if (error) {
            client.end();
            if (!settled) reject(error);
            return;
          }

          sessions.set(sessionId, { client, stream, history: "", title: connection.name || connection.host || "Terminal" });
          startStatsPolling(sessionId);

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
            if (closing) { stopStatsPolling(closing); closeSftp(closing); }
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
        if (failing) { stopStatsPolling(failing); closeSftp(failing); }
        sessions.delete(sessionId);
        if (!settled) reject(error);
        else sendSessionEvent(sessionId, "ssh:error", { sessionId, message: error.message });
      })
      .on("close", () => {
        const closing = sessions.get(sessionId);
        if (closing) { stopStatsPolling(closing); closeSftp(closing); }
        sessions.delete(sessionId);
        sendSessionEvent(sessionId, "ssh:closed", { sessionId });
        closeTerminalWindows(sessionId);
      })
      .connect(connectConfig);
  });
});

ipcMain.on("ssh:input", (_event, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session?.pty) session.pty.write(payload.data);
  else if (session?.stream) session.stream.write(payload.data);
});

ipcMain.on("ssh:resize", (_event, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session?.pty) {
    try { session.pty.resize(Math.max(1, payload.cols), Math.max(1, payload.rows)); } catch {}
  } else if (session?.stream) {
    session.stream.setWindow(payload.rows, payload.cols, payload.height || 0, payload.width || 0);
  }
});

ipcMain.handle("ssh:disconnect", (_event, sessionId) => {
  const session = sessions.get(sessionId);
  if (session) {
    stopStatsPolling(session);
    closeSftp(session);
    if (session.pty) {
      try { session.pty.kill(); } catch {}
    }
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

// 一次性读取 Linux /proc 下的 CPU/内存/网络/负载,用分隔标记便于解析
const STATS_CMD =
  "echo @@S; cat /proc/stat; echo @@M; cat /proc/meminfo; echo @@N; cat /proc/net/dev; echo @@L; cat /proc/loadavg";

// 解析 STATS_CMD 的输出为一次采样;非 Linux(无 /proc)返回 null
function parseProcStats(raw) {
  if (!raw) return null;
  const section = { S: [], M: [], N: [], L: [] };
  let current = null;
  for (const line of raw.split("\n")) {
    const mark = line.match(/^@@([SMNL])\s*$/);
    if (mark) { current = mark[1]; continue; }
    if (current) section[current].push(line);
  }

  // CPU:汇总行 "cpu  u n s idle iowait irq softirq steal ..."
  const cpuLine = section.S.find((l) => /^cpu\s/.test(l));
  if (!cpuLine) return null;
  const cpuFields = cpuLine.trim().split(/\s+/).slice(1).map(Number);
  if (cpuFields.length < 5 || cpuFields.some(Number.isNaN)) return null;
  const cpuTotal = cpuFields.reduce((a, b) => a + b, 0);
  const cpuIdle = (cpuFields[3] || 0) + (cpuFields[4] || 0); // idle + iowait

  // 内存:MemTotal / MemAvailable(单位 KB)
  let memTotal = 0;
  let memAvailable = 0;
  for (const l of section.M) {
    const m = l.match(/^(MemTotal|MemAvailable):\s+(\d+)\s*kB/);
    if (m) {
      if (m[1] === "MemTotal") memTotal = Number(m[2]) * 1024;
      else memAvailable = Number(m[2]) * 1024;
    }
  }
  if (!memTotal) return null;

  // 网络:累加非 lo 接口的累计 rx/tx 字节
  let rx = 0;
  let tx = 0;
  for (const l of section.N) {
    const m = l.match(/^\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const iface = m[1].trim();
    if (iface === "lo") continue;
    const cols = m[2].trim().split(/\s+/).map(Number);
    // /proc/net/dev: rx_bytes 是第 1 列, tx_bytes 是第 9 列
    if (cols.length >= 9) {
      rx += cols[0] || 0;
      tx += cols[8] || 0;
    }
  }

  const load1 = Number((section.L[0] || "").trim().split(/\s+/)[0]) || 0;

  return { ts: Date.now(), cpuIdle, cpuTotal, memTotal, memAvailable, rx, tx, load1 };
}

// 由相邻两次采样算出展示指标;首次(无 prev)返回 null
function computeStatsDelta(prev, cur) {
  if (!prev) return null;
  const totalDelta = cur.cpuTotal - prev.cpuTotal;
  const idleDelta = cur.cpuIdle - prev.cpuIdle;
  const cpuPercent = totalDelta > 0
    ? Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100))
    : 0;
  const dt = (cur.ts - prev.ts) / 1000 || 1;
  const rxRate = Math.max(0, (cur.rx - prev.rx) / dt);
  const txRate = Math.max(0, (cur.tx - prev.tx) / dt);
  const memUsed = cur.memTotal - cur.memAvailable;
  const memPercent = cur.memTotal > 0 ? (memUsed / cur.memTotal) * 100 : 0;
  return {
    cpuPercent: Math.round(cpuPercent),
    memUsed,
    memTotal: cur.memTotal,
    memPercent: Math.round(memPercent),
    rxRate,
    txRate,
    load1: cur.load1
  };
}

// 每 2 秒采集一次远程机器状态并推送给渲染层;仅在 SSH 会话上调用
function startStatsPolling(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?.client) return;
  session.statsPrev = null;

  const tick = () => {
    const s = sessions.get(sessionId);
    if (!s?.client) return;
    s.client.exec(STATS_CMD, (err, stream) => {
      if (err) return;
      let out = "";
      stream.on("data", (d) => { out += d.toString("utf8"); });
      stream.stderr.on("data", () => {});
      stream.on("close", () => {
        const live = sessions.get(sessionId);
        if (!live) return;
        const cur = parseProcStats(out);
        if (!cur) {
          // 非 Linux 或读取失败:停止轮询,通知渲染层隐藏
          stopStatsPolling(live);
          sendSessionEvent(sessionId, "ssh:stats", { sessionId, supported: false });
          return;
        }
        const metrics = computeStatsDelta(live.statsPrev, cur);
        live.statsPrev = cur;
        if (metrics) {
          sendSessionEvent(sessionId, "ssh:stats", { sessionId, supported: true, ...metrics });
        }
      });
    });
  };

  session.statsTimer = setInterval(tick, 2000);
  tick(); // 立即取基线
}

function stopStatsPolling(session) {
  if (session?.statsTimer) {
    clearInterval(session.statsTimer);
    session.statsTimer = null;
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

ipcMain.handle("ui:file-menu", (event, payload) => {
  return new Promise((resolve) => {
    const labels = payload?.labels || {};
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    let chosen = null;
    const template = [
      { label: labels.download || "Download to…", click: () => { chosen = "download"; } }
    ];
    if (!payload?.hideDelete) {
      template.push({ type: "separator" });
      template.push({ label: labels.delete || "Delete", click: () => { chosen = "delete"; } });
    }
    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: win,
      callback: () => resolve(chosen)
    });
  });
});

ipcMain.handle("dialog:choose-folder", async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: payload?.title || "Choose folder",
    buttonLabel: payload?.buttonLabel || undefined,
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? "" : result.filePaths[0];
});

ipcMain.handle("ssh:download-to", async (_event, payload) => {
  const sessionId = payload?.sessionId;
  const remotePath = normalizeRemotePath(payload?.remotePath);
  const localFolder = String(payload?.localFolder || "");
  if (!sessionId || !remotePath || !localFolder) throw new Error("Missing session, remote path, or target folder.");

  const session = sessions.get(sessionId);
  if (!session?.client) throw new Error("No active SSH session.");

  const sftp = await getSftp(session);
  const attrs = await sftpStat(sftp, remotePath);
  const displayName = String(payload?.name || path.posix.basename(remotePath) || "download");
  const localPath = path.join(localFolder, displayName);

  if (fs.existsSync(localPath) && !payload?.overwrite) {
    const err = new Error("Target already exists");
    err.code = "EEXIST";
    throw err;
  }

  const downloadId = crypto.randomUUID();
  const totalSize = attrs.isDirectory() ? await computeRemoteSize(sftp, remotePath) : Number(attrs.size || 0);
  const ctx = { sessionId, downloadId, displayName, totalSize, rootLocalPath: localPath, progress: { bytes: 0 } };

  sendSessionEvent(sessionId, "ssh:download-progress", {
    sessionId,
    downloadId,
    fileName: displayName,
    transferred: 0,
    total: totalSize,
    localPath
  });

  if (attrs.isDirectory()) {
    await downloadDirRecursive(sftp, remotePath, localPath, ctx);
  } else {
    await downloadFileSftp(sftp, remotePath, localPath, ctx);
  }

  sendSessionEvent(sessionId, "ssh:download-progress", {
    sessionId,
    downloadId,
    fileName: displayName,
    transferred: totalSize,
    total: totalSize,
    localPath
  });

  return { localPath, size: totalSize, isDirectory: attrs.isDirectory() };
});

ipcMain.on("shell:reveal-item", (_event, p) => {
  if (p) shell.showItemInFolder(p);
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
