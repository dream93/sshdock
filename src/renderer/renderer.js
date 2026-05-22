const api = window.sshDock;
const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: light)");
const THEME_STORAGE_KEY = "sshdock.theme";
const LANGUAGE_STORAGE_KEY = "sshdock.language";
const $ = (id) => document.getElementById(id);

let themeMode = localStorage.getItem(THEME_STORAGE_KEY) || "system";
let languageMode = localStorage.getItem(LANGUAGE_STORAGE_KEY) || "system";
let terminal;
let idleTerminal;
let idleFitAddon;
let idlePaneElement;
let connections = [];
let activeConnectionId = "";
let activeSessionId = "";
let activeSessionConnectionId = "";
let activeConnectionMenuId = "";
const terminalSessions = new Map();
const uploadProgress = new Map();
const downloadProgress = new Map();
const sessionRemotePath = new Map();
let filePanelOpen = false;
let filePanelLoading = false;

const messages = {
  en: {
    brandSubtitle: "Visual SSH client",
    newConnection: "New connection",
    settings: "Settings",
    settingsSubtitle: "Customize SSHDock preferences.",
    theme: "Theme",
    themeSystem: "System",
    themeDark: "Dark",
    themeLight: "Light",
    language: "Language",
    languageSystem: "System",
    languageEnglish: "English",
    languageChinese: "Simplified Chinese",
    connection: "Connection",
    passwordNote: "Passwords are saved locally for future connections.",
    delete: "Delete",
    name: "Name",
    namePlaceholder: "Production",
    host: "Host",
    hostPlaceholder: "192.168.1.20",
    port: "Port",
    username: "Username",
    usernamePlaceholder: "root",
    password: "Password",
    privateKey: "Private key",
    keyPathPlaceholder: "~/.ssh/id_rsa",
    browse: "Browse",
    passwordPlaceholder: "Required to connect",
    keyPassphrase: "Key passphrase",
    optionalPlaceholder: "Optional",
    save: "Save",
    connect: "Connect",
    disconnect: "Disconnect",
    terminal: "Terminal",
    idle: "Idle",
    ready: "SSHDock ready.",
    noSavedHosts: "No saved hosts",
    createOneToStart: "Create one to start.",
    newConnectionTitle: "New connection",
    saved: "Saved",
    connectedSaved: "Connected and saved",
    connectedSaveFailed: "Connected, but save failed",
    connecting: "Connecting",
    connectingTo: "Connecting to {target}...",
    connected: "Connected",
    connectionFailed: "Connection failed",
    connectionFailedDetail: "Connection failed: {message}",
    disconnected: "Disconnected",
    connectBeforeUploading: "Connect before uploading",
    connectBeforeDropping: "Connect to a host before dropping files.",
    newLink: "New link",
    editConnection: "Edit connection",
    popOut: "Pop out",
    showPopOut: "Show window",
    uploading: "Uploading {fileName}",
    uploadingPercent: "Uploading {fileName} {percent}%",
    uploaded: "Uploaded {fileName}",
    uploadedDetail: "Uploaded {fileName} -> {remotePath} ({size})",
    uploadFailed: "Upload failed",
    uploadFailedDetail: "Upload failed: {message}",
    deleted: "Deleted",
    closed: "Closed",
    sessionClosed: "Session closed.",
    error: "Error",
    dropFilesToUpload: "Drop files to upload",
    files: "Files",
    home: "Home",
    parentDir: "Up",
    refresh: "Refresh",
    newFolder: "New folder",
    newFolderPrompt: "Folder name",
    fileListEmpty: "Empty",
    fileListError: "Failed to list: {message}",
    preparingDownload: "Preparing {fileName}...",
    downloading: "Downloading {fileName} {percent}%",
    downloadReady: "Drag {fileName} to your file manager",
    downloadFailed: "Download failed: {message}",
    confirmDelete: "Delete {name}?",
    deleteFailed: "Delete failed: {message}",
    mkdirFailed: "Create folder failed: {message}"
  },
  "zh-CN": {
    brandSubtitle: "可视化 SSH 客户端",
    newConnection: "新建连接",
    settings: "设置",
    settingsSubtitle: "自定义 SSHDock 偏好设置。",
    theme: "主题",
    themeSystem: "跟随系统",
    themeDark: "深色",
    themeLight: "浅色",
    language: "语言",
    languageSystem: "跟随系统",
    languageEnglish: "English",
    languageChinese: "简体中文",
    connection: "连接",
    passwordNote: "密码会保存到本机，用于后续连接。",
    delete: "删除",
    name: "名称",
    namePlaceholder: "生产环境",
    host: "主机",
    hostPlaceholder: "192.168.1.20",
    port: "端口",
    username: "用户名",
    usernamePlaceholder: "root",
    password: "密码",
    privateKey: "私钥",
    keyPathPlaceholder: "~/.ssh/id_rsa",
    browse: "浏览",
    passwordPlaceholder: "连接时需要",
    keyPassphrase: "私钥口令",
    optionalPlaceholder: "可选",
    save: "保存",
    connect: "连接",
    disconnect: "断开",
    terminal: "终端",
    idle: "空闲",
    ready: "SSHDock 已就绪。",
    noSavedHosts: "暂无已保存主机",
    createOneToStart: "新建一个连接开始使用。",
    newConnectionTitle: "新建连接",
    saved: "已保存",
    connectedSaved: "已连接并保存",
    connectedSaveFailed: "已连接，但保存失败",
    connecting: "正在连接",
    connectingTo: "正在连接到 {target}...",
    connected: "已连接",
    connectionFailed: "连接失败",
    connectionFailedDetail: "连接失败：{message}",
    disconnected: "已断开",
    connectBeforeUploading: "请先连接再上传",
    connectBeforeDropping: "请先连接主机，再拖放文件。",
    newLink: "新建链接",
    editConnection: "编辑连接",
    popOut: "弹出窗口",
    showPopOut: "显示窗口",
    uploading: "正在上传 {fileName}",
    uploadingPercent: "正在上传 {fileName} {percent}%",
    uploaded: "已上传 {fileName}",
    uploadedDetail: "已上传 {fileName} -> {remotePath} ({size})",
    uploadFailed: "上传失败",
    uploadFailedDetail: "上传失败：{message}",
    deleted: "已删除",
    closed: "已关闭",
    sessionClosed: "会话已关闭。",
    error: "错误",
    dropFilesToUpload: "拖放文件以上传",
    files: "文件",
    home: "家目录",
    parentDir: "上一级",
    refresh: "刷新",
    newFolder: "新建文件夹",
    newFolderPrompt: "文件夹名称",
    fileListEmpty: "空目录",
    fileListError: "列出失败：{message}",
    preparingDownload: "正在准备 {fileName}...",
    downloading: "下载 {fileName} {percent}%",
    downloadReady: "可以将 {fileName} 拖到本地",
    downloadFailed: "下载失败：{message}",
    confirmDelete: "确认删除 {name}？",
    deleteFailed: "删除失败：{message}",
    mkdirFailed: "新建文件夹失败：{message}"
  }
};

function resolvedLanguage(mode = languageMode) {
  if (mode === "en" || mode === "zh-CN") return mode;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function t(key, values = {}) {
  const template = messages[resolvedLanguage()][key] || messages.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_match, name) => values[name] ?? "");
}

function setStatus(key, values = {}) {
  const session = terminalSessions.get(activeSessionId);
  if (session) {
    session.statusKey = key;
    session.statusValues = values;
  }
  const status = $("status");
  status.dataset.statusKey = key;
  status.dataset.statusValues = JSON.stringify(values);
  status.textContent = t(key, values);
}

function setConnectionError(message = "") {
  const alert = $("connectionError");
  alert.textContent = message;
  alert.classList.toggle("hidden", !message);
}

function applyLanguage(mode) {
  languageMode = mode === "en" || mode === "zh-CN" ? mode : "system";
  localStorage.setItem(LANGUAGE_STORAGE_KEY, languageMode);
  document.documentElement.lang = resolvedLanguage();
  if ($("languageMode")) $("languageMode").value = languageMode;

  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }

  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }

  for (const element of document.querySelectorAll("[data-i18n-title]")) {
    element.title = t(element.dataset.i18nTitle);
  }

  if (!activeConnectionId) $("formTitle").textContent = t("connection");
  if (!activeSessionId) $("terminalTitle").textContent = t("terminal");
  renderList();
  updateTerminalActions();
  document.documentElement.style.setProperty("--drop-label", `"${t("dropFilesToUpload")}"`);

  const status = $("status");
  if (status?.dataset.statusKey) {
    const values = status.dataset.statusValues ? JSON.parse(status.dataset.statusValues) : {};
    setStatus(status.dataset.statusKey, values);
  }
}

function resolvedTheme(mode = themeMode) {
  if (mode === "light" || mode === "dark") return mode;
  return systemThemeQuery.matches ? "light" : "dark";
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-fg").trim(),
    cursor: styles.getPropertyValue("--accent").trim()
  };
}

function applyTheme(mode) {
  themeMode = mode === "light" || mode === "dark" ? mode : "system";
  localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  document.documentElement.dataset.theme = resolvedTheme(themeMode);
  if ($("themeMode")) $("themeMode").value = themeMode;
  if (idleTerminal) idleTerminal.options.theme = terminalTheme();
  for (const session of terminalSessions.values()) {
    session.terminal.options.theme = terminalTheme();
  }
}

applyTheme(themeMode);
applyLanguage(languageMode);

function terminalOptions() {
  return {
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    theme: terminalTheme()
  };
}

function createTerminalIn(container) {
  const instance = new TerminalCtor(terminalOptions());
  const fitAddon = new FitAddonCtor();
  instance.loadAddon(fitAddon);
  instance.open(container);
  return { terminal: instance, fitAddon };
}

function createTerminalPane(className = "terminal-instance") {
  const pane = document.createElement("div");
  pane.className = className;
  $("terminal").appendChild(pane);
  return { pane, ...createTerminalIn(pane) };
}

function showIdleTerminal() {
  activeSessionId = "";
  activeSessionConnectionId = "";
  terminal = idleTerminal;
  $("terminalTitle").textContent = t("terminal");
  setStatus("idle");
  idlePaneElement?.classList.remove("hidden");
  for (const session of terminalSessions.values()) {
    session.pane.classList.add("hidden");
  }
  renderSessionTabs();
  $("workspace").classList.remove("terminal-focused");
  updateTerminalActions();
  renderList();
  requestAnimationFrame(fitAndResize);
}

const idlePane = createTerminalPane();
idleTerminal = idlePane.terminal;
idleFitAddon = idlePane.fitAddon;
idlePaneElement = idlePane.pane;
terminal = idleTerminal;
idleFitAddon.fit();
idleTerminal.writeln(t("ready"));

function currentAuthType() {
  return document.querySelector('input[name="authType"]:checked').value;
}

function formConnection() {
  const name = $("name").value.trim();
  return {
    id: $("connectionId").value || undefined,
    name,
    host: $("host").value.trim(),
    port: Number($("port").value || 22),
    username: $("username").value.trim(),
    authType: currentAuthType(),
    keyPath: $("keyPath").value.trim(),
    password: $("password").value,
    passphrase: $("passphrase").value
  };
}

function createTerminalSession(sessionId, connection) {
  const pane = createTerminalPane();
  const session = {
    id: sessionId,
    connectionId: connection.id || "",
    connected: false,
    title: connection.name || connection.host,
    statusKey: "connecting",
    statusValues: {},
    detached: false,
    pane: pane.pane,
    terminal: pane.terminal,
    fitAddon: pane.fitAddon
  };

  session.terminal.onData((data) => {
    api.sendInput({ sessionId, data });
  });

  terminalSessions.set(sessionId, session);
  return session;
}

function renderSessionTabs() {
  const tabs = $("sessionTabs");
  tabs.innerHTML = "";
  tabs.classList.toggle("hidden", terminalSessions.size === 0);

  for (const session of terminalSessions.values()) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `session-tab ${session.id === activeSessionId ? "active" : ""}`;
    tab.textContent = session.title;
    tab.addEventListener("click", () => selectTerminalSession(session.id));
    tabs.appendChild(tab);
  }
}

function updateTerminalActions() {
  const session = terminalSessions.get(activeSessionId);
  $("toolbarDisconnect").classList.toggle("hidden", !session);
  $("popOutTerminal").classList.toggle("hidden", !session);
  $("toggleFilePanel").classList.toggle("hidden", !session);
  if (session) $("popOutTerminal").textContent = t(session.detached ? "showPopOut" : "popOut");
  if (!session) closeFilePanel();
  else if (filePanelOpen) openFilePanel();
}

function selectTerminalSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    showIdleTerminal();
    return;
  }

  activeSessionId = session.id;
  activeSessionConnectionId = session.connectionId;
  terminal = session.terminal;
  idlePaneElement?.classList.add("hidden");

  for (const item of terminalSessions.values()) {
    item.pane.classList.toggle("hidden", item.id !== sessionId);
  }

  $("terminalTitle").textContent = session.title;
  setStatus(session.statusKey, session.statusValues);
  setTerminalFocus(true);
  renderSessionTabs();
  renderList();
  requestAnimationFrame(fitAndResize);
}

function removeTerminalSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  terminalSessions.delete(sessionId);
  sessionRemotePath.delete(sessionId);
  uploadProgress.clear();
  downloadProgress.clear();
  session.terminal.dispose();
  session.pane.remove();

  if (activeSessionId !== sessionId) {
    renderSessionTabs();
    return;
  }

  const nextSession = terminalSessions.values().next().value;
  if (nextSession) selectTerminalSession(nextSession.id);
  else showIdleTerminal();
}

function renderList() {
  const list = $("connectionList");
  list.innerHTML = "";

  if (connections.length === 0) {
    const empty = document.createElement("div");
    empty.className = "connection-item";
    empty.innerHTML = `<strong>${escapeHtml(t("noSavedHosts"))}</strong><span>${escapeHtml(t("createOneToStart"))}</span>`;
    list.appendChild(empty);
    return;
  }

  for (const connection of connections) {
    const item = document.createElement("div");
    item.className = "connection-row";

    const button = document.createElement("button");
    const classes = ["connection-item"];
    if (connection.id === activeSessionConnectionId) classes.push("active");
    else if (connection.id === activeConnectionId) classes.push("editing");
    button.className = classes.join(" ");
    button.innerHTML = `<strong>${escapeHtml(connection.name)}</strong><span>${escapeHtml(connection.username)}@${escapeHtml(connection.host)}:${connection.port}</span>`;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (event.button !== 0) return;
      if (event.detail < 2) {
        if (isActiveSessionConnection(connection.id)) {
          showConnectionMenu(connection.id);
          return;
        }
        hideConnectionMenu();
        loadConnection(connection);
        return;
      }

      hideConnectionMenu();
      if (isActiveSessionConnection(connection.id)) {
        const existingSession = firstSessionForConnection(connection.id);
        if (existingSession) selectTerminalSession(existingSession.id);
        setStatus("connected");
        return;
      }

      loadConnection(connection);
      await connect();
    });
    item.appendChild(button);

    if (activeConnectionMenuId === connection.id) {
      const menu = document.createElement("div");
      menu.className = "connection-menu";
      menu.addEventListener("click", (event) => event.stopPropagation());

      const newLink = document.createElement("button");
      newLink.type = "button";
      newLink.textContent = t("newLink");
      newLink.addEventListener("click", async () => {
        hideConnectionMenu();
        loadConnection(connection);
        await connect(connection);
      });

      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = t("editConnection");
      edit.addEventListener("click", () => {
        hideConnectionMenu();
        loadConnection(connection);
      });

      menu.appendChild(newLink);
      menu.appendChild(edit);
      item.appendChild(menu);
    }

    list.appendChild(item);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function updateAuthUI() {
  const authType = currentAuthType();
  $("keyPathRow").classList.toggle("hidden", authType !== "key");
  $("passphraseRow").classList.toggle("hidden", authType !== "key");
  $("passwordRow").classList.toggle("hidden", authType === "key");
}

function showConnectionEditor() {
  $("connectionEditor").classList.remove("hidden");
  $("connectionSettings").classList.add("hidden");
  $("settingsButton").classList.remove("active");
}

function showSettings() {
  setTerminalFocus(false);
  $("connectionEditor").classList.add("hidden");
  $("connectionSettings").classList.remove("hidden");
  $("settingsButton").classList.add("active");
  requestAnimationFrame(fitAndResize);
}

function clearForm() {
  showConnectionEditor();
  setConnectionError();
  $("connectionId").value = "";
  $("name").value = "";
  $("host").value = "";
  $("port").value = "22";
  $("username").value = "";
  $("keyPath").value = "";
  $("password").value = "";
  $("passphrase").value = "";
  document.querySelector('input[name="authType"][value="password"]').checked = true;
  activeConnectionId = "";
  $("formTitle").textContent = t("newConnectionTitle");
  setTerminalFocus(false);
  updateAuthUI();
  renderList();
}

function fillConnectionForm(connection) {
  $("connectionId").value = connection.id;
  $("name").value = connection.name;
  $("host").value = connection.host;
  $("port").value = connection.port;
  $("username").value = connection.username;
  $("keyPath").value = connection.keyPath || "";
  $("password").value = connection.password || "";
  $("passphrase").value = connection.passphrase || "";
  document.querySelector(`input[name="authType"][value="${connection.authType}"]`).checked = true;
  activeConnectionId = connection.id;
  $("formTitle").textContent = connection.name;
  updateAuthUI();
}

function isActiveSessionConnection(connectionId) {
  return Boolean(connectionId && Array.from(terminalSessions.values()).some((session) => session.connected && session.connectionId === connectionId));
}

function firstSessionForConnection(connectionId) {
  return Array.from(terminalSessions.values()).find((session) => session.connected && session.connectionId === connectionId);
}

function showConnectionMenu(connectionId) {
  activeConnectionMenuId = connectionId;
  renderList();
}

function hideConnectionMenu() {
  if (!activeConnectionMenuId) return;
  activeConnectionMenuId = "";
  renderList();
}

function loadConnection(connection) {
  showConnectionEditor();
  setConnectionError();
  fillConnectionForm(connection);
  setTerminalFocus(false);
  renderList();
}

async function refreshConnections() {
  connections = await api.listConnections();
  renderList();
  if (connections.length > 0 && !activeConnectionId) loadConnection(connections[0]);
}

async function saveConnection() {
  setConnectionError();
  const saved = await api.saveConnection(formConnection());
  await refreshConnections();
  loadConnection(saved);
  setStatus("saved");
}

async function connect(connectionOverride) {
  if (!connectionOverride && !$("connectionForm").reportValidity()) return;

  setConnectionError();
  const connection = connectionOverride || formConnection();
  const sessionId = crypto.randomUUID();
  const session = createTerminalSession(sessionId, connection);
  selectTerminalSession(sessionId);
  session.terminal.writeln(t("connectingTo", { target: `${connection.username}@${connection.host}:${connection.port}` }));

  try {
    await api.connect({
      sessionId,
      connection,
      password: $("password").value,
      passphrase: $("passphrase").value
    });
    session.connected = true;
    try {
      const saved = await api.saveConnection(connection);
      connections = await api.listConnections();
      fillConnectionForm(saved);
      session.connectionId = saved.id;
      activeSessionConnectionId = saved.id;
      renderList();
      setStatus("connectedSaved");
    } catch (saveError) {
      setStatus("connectedSaveFailed");
      terminal.writeln(`\r\n${saveError.message}`);
    }
    fitAndResize();
  } catch (error) {
    const message = error.message || String(error);
    const detail = t("connectionFailedDetail", { message });
    setStatus("connectionFailed");
    setConnectionError(detail);
    session.terminal.writeln(`\r\n${detail}`);
  }
}

async function disconnect() {
  if (!activeSessionId) return;
  const sessionId = activeSessionId;
  await api.disconnect(sessionId);
  removeTerminalSession(sessionId);
}

async function openTerminalWindow() {
  const session = terminalSessions.get(activeSessionId);
  if (!session) return;

  await api.openTerminalWindow({
    sessionId: session.id,
    title: session.title
  });
  session.detached = true;
  updateTerminalActions();
}

function setTerminalFocus(isFocused) {
  $("workspace").classList.toggle("terminal-focused", isFocused);
  updateTerminalActions();
  if (isFocused) $("settingsButton").classList.remove("active");
  requestAnimationFrame(fitAndResize);
}

function fitAndResize() {
  const session = terminalSessions.get(activeSessionId);
  if (session) {
    session.fitAddon.fit();
    api.resize({
      sessionId: activeSessionId,
      cols: session.terminal.cols,
      rows: session.terminal.rows
    });
    return;
  }
  idleFitAddon.fit();
}

function fileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function uploadDroppedFiles(files, remoteDir = "") {
  if (!activeSessionId) {
    setStatus("connectBeforeUploading");
    terminal.writeln(`\r\n${t("connectBeforeDropping")}`);
    return;
  }

  const fileList = Array.from(files).filter((file) => file.path);
  if (fileList.length === 0) return;

  for (const file of fileList) {
    setStatus("uploading", { fileName: file.name });
    terminal.writeln(`\r\n${t("uploading", { fileName: file.name })}...`);
    try {
      const result = await api.uploadFile({
        sessionId: activeSessionId,
        localPath: file.path,
        remoteDir
      });
      setStatus("uploaded", { fileName: result.fileName });
      terminal.writeln(`\r\n${t("uploadedDetail", { fileName: result.fileName, remotePath: result.remotePath, size: fileSizeLabel(result.size) })}`);
    } catch (error) {
      setStatus("uploadFailed");
      terminal.writeln(`\r\n${t("uploadFailedDetail", { message: error.message })}`);
    }
  }

  if (filePanelOpen) await refreshFilePanel();
}

$("connectionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveConnection();
  } catch (error) {
    setStatus(error.message);
  }
});

$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", disconnect);
$("toolbarDisconnect").addEventListener("click", disconnect);
$("popOutTerminal").addEventListener("click", openTerminalWindow);
$("newConnection").addEventListener("click", clearForm);
$("settingsButton").addEventListener("click", showSettings);
$("themeMode").addEventListener("change", (event) => applyTheme(event.target.value));
$("languageMode").addEventListener("change", (event) => applyLanguage(event.target.value));
$("chooseKey").addEventListener("click", async () => {
  const keyPath = await api.chooseKeyPath();
  if (keyPath) $("keyPath").value = keyPath;
});

$("deleteConnection").addEventListener("click", async () => {
  const id = $("connectionId").value;
  if (!id) return;
  setConnectionError();
  connections = await api.deleteConnection(id);
  clearForm();
  await refreshConnections();
  setStatus("deleted");
});

for (const radio of document.querySelectorAll('input[name="authType"]')) {
  radio.addEventListener("change", updateAuthUI);
}

window.addEventListener("resize", fitAndResize);
document.addEventListener("click", hideConnectionMenu);
systemThemeQuery.addEventListener("change", () => {
  if (themeMode === "system") applyTheme("system");
});

function setFilePanelStatus(key, values = {}) {
  const el = $("filePanelStatus");
  el.dataset.statusKey = key;
  el.dataset.statusValues = JSON.stringify(values);
  el.textContent = key ? t(key, values) : "";
}

function renderFileList(state) {
  const list = $("filePanelList");
  list.innerHTML = "";

  if (!state.entries || state.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "file-panel-empty";
    empty.textContent = t("fileListEmpty");
    list.appendChild(empty);
    return;
  }

  for (const entry of state.entries) {
    if (entry.name === "." || entry.name === "..") continue;
    const row = document.createElement("div");
    row.className = `file-row ${entry.isDirectory ? "dir" : "file"}`;
    row.draggable = true;
    const remotePath = joinRemote(state.path, entry.name);
    row.dataset.path = remotePath;
    row.dataset.name = entry.name;
    row.dataset.dir = entry.isDirectory ? "1" : "";

    row.innerHTML = `
      <span class="file-icon">${entry.isDirectory ? "📁" : "📄"}</span>
      <span class="file-name"></span>
      <span class="file-meta"></span>
    `;
    row.querySelector(".file-name").textContent = entry.name;
    row.querySelector(".file-meta").textContent = entry.isDirectory ? "" : fileSizeLabel(entry.size);

    row.addEventListener("dblclick", () => {
      if (entry.isDirectory) loadRemotePath(remotePath);
    });

    row.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      if (!activeSessionId) return;
      if (!window.confirm(t("confirmDelete", { name: entry.name }))) return;
      try {
        await api.removeRemote({ sessionId: activeSessionId, remotePath });
        await refreshFilePanel();
      } catch (error) {
        setFilePanelStatus("deleteFailed", { message: error.message });
      }
    });

    row.addEventListener("dragstart", async (event) => {
      if (!activeSessionId) return;
      event.preventDefault();
      row.classList.add("dragging");
      setFilePanelStatus("preparingDownload", { fileName: entry.name });
      try {
        await api.startRemoteDrag({
          sessionId: activeSessionId,
          remotePath,
          name: entry.name
        });
        setFilePanelStatus("downloadReady", { fileName: entry.name });
      } catch (error) {
        setFilePanelStatus("downloadFailed", { message: error.message });
      } finally {
        row.classList.remove("dragging");
      }
    });

    list.appendChild(row);
  }
}

function joinRemote(base, name) {
  if (!base || base === "/") return `/${name}`;
  return `${base.replace(/\/$/, "")}/${name}`;
}

async function loadRemotePath(remotePath) {
  if (!activeSessionId || filePanelLoading) return;
  filePanelLoading = true;
  try {
    const state = await api.listRemoteDir({
      sessionId: activeSessionId,
      remotePath: remotePath || sessionRemotePath.get(activeSessionId) || ""
    });
    sessionRemotePath.set(activeSessionId, state.path);
    $("filePanelPath").value = state.path;
    renderFileList(state);
    setFilePanelStatus("");
  } catch (error) {
    setFilePanelStatus("fileListError", { message: error.message });
  } finally {
    filePanelLoading = false;
  }
}

async function refreshFilePanel() {
  if (!activeSessionId) return;
  const current = sessionRemotePath.get(activeSessionId) || "";
  await loadRemotePath(current);
}

function openFilePanel() {
  if (!activeSessionId) return;
  filePanelOpen = true;
  $("filePanel").classList.remove("hidden");
  document.querySelector(".terminal-area").classList.add("with-files");
  $("toggleFilePanel").classList.add("active");
  loadRemotePath(sessionRemotePath.get(activeSessionId) || "");
  requestAnimationFrame(fitAndResize);
}

function closeFilePanel() {
  filePanelOpen = false;
  $("filePanel").classList.add("hidden");
  document.querySelector(".terminal-area").classList.remove("with-files");
  $("toggleFilePanel").classList.remove("active");
  requestAnimationFrame(fitAndResize);
}

function toggleFilePanel() {
  if (filePanelOpen) closeFilePanel();
  else openFilePanel();
}

$("toggleFilePanel").addEventListener("click", toggleFilePanel);
$("filePanelRefresh").addEventListener("click", refreshFilePanel);
$("filePanelHome").addEventListener("click", async () => {
  if (!activeSessionId) return;
  try {
    const home = await api.remoteHome(activeSessionId);
    await loadRemotePath(home);
  } catch (error) {
    setFilePanelStatus("fileListError", { message: error.message });
  }
});
$("filePanelUp").addEventListener("click", async () => {
  const current = sessionRemotePath.get(activeSessionId) || "/";
  if (current === "/" || current === "") return;
  const parent = current.replace(/\/+$/g, "").split("/").slice(0, -1).join("/") || "/";
  await loadRemotePath(parent);
});
$("filePanelPath").addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  await loadRemotePath($("filePanelPath").value.trim());
});
$("filePanelMkdir").addEventListener("click", async () => {
  if (!activeSessionId) return;
  const name = window.prompt(t("newFolderPrompt"));
  if (!name) return;
  try {
    await api.makeRemoteDir({
      sessionId: activeSessionId,
      remoteDir: sessionRemotePath.get(activeSessionId) || "",
      name: name.trim()
    });
    await refreshFilePanel();
  } catch (error) {
    setFilePanelStatus("mkdirFailed", { message: error.message });
  }
});

const fileListEl = $("filePanelList");
fileListEl.addEventListener("dragover", (event) => {
  if (!activeSessionId) return;
  if (event.dataTransfer.types.includes("Files")) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    fileListEl.classList.add("drop-target");
  }
});
fileListEl.addEventListener("dragleave", (event) => {
  if (event.target === fileListEl) fileListEl.classList.remove("drop-target");
});
fileListEl.addEventListener("drop", async (event) => {
  event.preventDefault();
  fileListEl.classList.remove("drop-target");
  await uploadDroppedFiles(event.dataTransfer.files, sessionRemotePath.get(activeSessionId) || "");
});

$("terminal").addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = activeSessionId ? "copy" : "none";
  $("terminal").closest(".terminal-panel").classList.add("drag-over");
});

$("terminal").addEventListener("dragleave", () => {
  $("terminal").closest(".terminal-panel").classList.remove("drag-over");
});

$("terminal").addEventListener("drop", async (event) => {
  event.preventDefault();
  $("terminal").closest(".terminal-panel").classList.remove("drag-over");
  await uploadDroppedFiles(event.dataTransfer.files, sessionRemotePath.get(activeSessionId) || "");
});

api.onData(({ sessionId, data }) => {
  const session = terminalSessions.get(sessionId);
  if (session) session.terminal.write(data);
});

api.onUploadProgress(({ sessionId, uploadId, fileName, transferred, total }) => {
  const session = terminalSessions.get(sessionId);
  if (!session || !total) return;
  const percent = Math.floor((transferred / total) * 100);
  if (uploadProgress.get(uploadId) === percent) return;
  uploadProgress.set(uploadId, percent);
  session.statusKey = "uploadingPercent";
  session.statusValues = { fileName, percent };
  if (sessionId === activeSessionId) setStatus("uploadingPercent", { fileName, percent });
});

api.onDownloadProgress(({ sessionId, downloadId, fileName, transferred, total }) => {
  if (sessionId !== activeSessionId || !total) return;
  const percent = Math.floor((transferred / total) * 100);
  if (downloadProgress.get(downloadId) === percent) return;
  downloadProgress.set(downloadId, percent);
  setFilePanelStatus("downloading", { fileName, percent });
});

api.onClosed(({ sessionId }) => {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  session.terminal.writeln(`\r\n${t("sessionClosed")}`);
  removeTerminalSession(sessionId);
});

api.onError(({ sessionId, message }) => {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  session.statusKey = "error";
  session.statusValues = {};
  session.terminal.writeln(`\r\n${message}`);
  if (sessionId === activeSessionId) setStatus("error");
});

api.onTerminalWindowClosed(({ sessionId }) => {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  session.detached = false;
  if (sessionId === activeSessionId) updateTerminalActions();
});

refreshConnections().catch((error) => {
  $("status").textContent = error.message;
});
