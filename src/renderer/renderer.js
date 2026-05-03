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
let connections = [];
let activeConnectionId = "";
let activeSessionId = "";
const uploadProgress = new Map();

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
    dropFilesToUpload: "Drop files to upload"
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
    dropFilesToUpload: "拖放文件以上传"
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
  const status = $("status");
  status.dataset.statusKey = key;
  status.dataset.statusValues = JSON.stringify(values);
  status.textContent = t(key, values);
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

  if (!activeConnectionId) $("formTitle").textContent = t("connection");
  if (!activeSessionId) $("terminalTitle").textContent = t("terminal");
  renderList();
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
  if (terminal) terminal.options.theme = terminalTheme();
}

applyTheme(themeMode);
applyLanguage(languageMode);

terminal = new TerminalCtor({
  cursorBlink: true,
  convertEol: true,
  fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  theme: terminalTheme()
});
const fitAddon = new FitAddonCtor();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById("terminal"));
fitAddon.fit();
terminal.writeln(t("ready"));

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
    const button = document.createElement("button");
    button.className = `connection-item ${connection.id === activeConnectionId ? "active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(connection.name)}</strong><span>${escapeHtml(connection.username)}@${escapeHtml(connection.host)}:${connection.port}</span>`;
    button.addEventListener("click", () => loadConnection(connection));
    button.addEventListener("dblclick", async () => {
      loadConnection(connection);
      await connect();
    });
    list.appendChild(button);
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

function loadConnection(connection) {
  if (activeSessionId && connection.id === activeConnectionId) {
    $("settingsButton").classList.remove("active");
    setTerminalFocus(true);
    renderList();
    return;
  }

  showConnectionEditor();
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
  const saved = await api.saveConnection(formConnection());
  await refreshConnections();
  loadConnection(saved);
  setStatus("saved");
}

async function connect() {
  if (activeSessionId) await disconnect();
  if (!$("connectionForm").reportValidity()) return;

  const connection = formConnection();
  setStatus("connecting");
  terminal.clear();
  terminal.writeln(t("connectingTo", { target: `${connection.username}@${connection.host}:${connection.port}` }));

  try {
    const result = await api.connect({
      connection,
      password: $("password").value,
      passphrase: $("passphrase").value
    });
    activeSessionId = result.sessionId;
    $("terminalTitle").textContent = connection.name || connection.host;
    setTerminalFocus(true);
    fitAndResize();
    try {
      const saved = await api.saveConnection(connection);
      connections = await api.listConnections();
      fillConnectionForm(saved);
      renderList();
      setStatus("connectedSaved");
    } catch (saveError) {
      setStatus("connectedSaveFailed");
      terminal.writeln(`\r\n${saveError.message}`);
    }
    fitAndResize();
  } catch (error) {
    setStatus("connectionFailed");
    setTerminalFocus(false);
    terminal.writeln(`\r\n${t("connectionFailedDetail", { message: error.message })}`);
  }
}

async function disconnect() {
  if (!activeSessionId) return;
  const sessionId = activeSessionId;
  activeSessionId = "";
  await api.disconnect(sessionId);
  setStatus("disconnected");
  setTerminalFocus(false);
}

function setTerminalFocus(isFocused) {
  $("workspace").classList.toggle("terminal-focused", isFocused);
  $("toolbarDisconnect").classList.toggle("hidden", !isFocused);
  if (isFocused) $("settingsButton").classList.remove("active");
  requestAnimationFrame(fitAndResize);
}

function fitAndResize() {
  fitAddon.fit();
  if (activeSessionId) {
    api.resize({
      sessionId: activeSessionId,
      cols: terminal.cols,
      rows: terminal.rows
    });
  }
}

function fileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function uploadDroppedFiles(files) {
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
        localPath: file.path
      });
      setStatus("uploaded", { fileName: result.fileName });
      terminal.writeln(`\r\n${t("uploadedDetail", { fileName: result.fileName, remotePath: result.remotePath, size: fileSizeLabel(result.size) })}`);
    } catch (error) {
      setStatus("uploadFailed");
      terminal.writeln(`\r\n${t("uploadFailedDetail", { message: error.message })}`);
    }
  }
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
  connections = await api.deleteConnection(id);
  clearForm();
  await refreshConnections();
  setStatus("deleted");
});

for (const radio of document.querySelectorAll('input[name="authType"]')) {
  radio.addEventListener("change", updateAuthUI);
}

terminal.onData((data) => {
  if (activeSessionId) api.sendInput({ sessionId: activeSessionId, data });
});

window.addEventListener("resize", fitAndResize);
systemThemeQuery.addEventListener("change", () => {
  if (themeMode === "system") applyTheme("system");
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
  await uploadDroppedFiles(event.dataTransfer.files);
});

api.onData(({ sessionId, data }) => {
  if (sessionId === activeSessionId) terminal.write(data);
});

api.onUploadProgress(({ sessionId, uploadId, fileName, transferred, total }) => {
  if (sessionId !== activeSessionId || !total) return;
  const percent = Math.floor((transferred / total) * 100);
  if (uploadProgress.get(uploadId) === percent) return;
  uploadProgress.set(uploadId, percent);
  setStatus("uploadingPercent", { fileName, percent });
});

api.onClosed(({ sessionId }) => {
  if (sessionId === activeSessionId) {
    activeSessionId = "";
    setStatus("closed");
    setTerminalFocus(false);
    terminal.writeln(`\r\n${t("sessionClosed")}`);
  }
});

api.onError(({ sessionId, message }) => {
  if (sessionId === activeSessionId) {
    setStatus("error");
    terminal.writeln(`\r\n${message}`);
  }
});

refreshConnections().catch((error) => {
  $("status").textContent = error.message;
});
