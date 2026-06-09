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
let sidebarMode = "connections"; // 'connections' | 'terminals'
let activeGroupId = "";
const terminalGroups = new Map(); // groupId -> { id, title, lastSessionId }
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
    localTerminal: "Local terminal",
    localTerminalTitle: "Local terminal {index}",
    localTerminalFailed: "Failed to open local terminal: {message}",
    connectionsTab: "Connections",
    terminalsTab: "Terminals",
    newTerminal: "New terminal",
    noTerminals: "No terminals",
    createTerminalToStart: "Create one to start.",
    shellCount: "{count} shells",
    newTabSameDir: "New tab (same directory)",
    closeGroup: "Close",
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
    downloadDone: "{fileName} downloaded.",
    downloadFailed: "Download failed: {message}",
    menuDownloadFile: "Download to…",
    menuDownloadDir: "Download folder to…",
    menuDelete: "Delete",
    chooseFolderTitle: "Choose folder for {name}",
    chooseFolderBtn: "Save here",
    overwriteConfirm: "{name} already exists in the chosen folder. Overwrite?",
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
    localTerminal: "本地终端",
    localTerminalTitle: "本地终端 {index}",
    localTerminalFailed: "打开本地终端失败：{message}",
    connectionsTab: "链接",
    terminalsTab: "终端",
    newTerminal: "新建终端",
    noTerminals: "暂无终端",
    createTerminalToStart: "新建一个终端开始使用。",
    shellCount: "{count} 个终端",
    newTabSameDir: "新建标签（同目录）",
    closeGroup: "关闭",
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
    downloadDone: "{fileName} 下载完成。",
    downloadFailed: "下载失败：{message}",
    menuDownloadFile: "下载到…",
    menuDownloadDir: "下载文件夹到…",
    menuDelete: "删除",
    chooseFolderTitle: "选择保存 {name} 的目录",
    chooseFolderBtn: "保存到这里",
    overwriteConfirm: "目标目录已存在 {name}，是否覆盖？",
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
  renderSidebar();
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
    scrollback: 10000,
    fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    theme: terminalTheme()
  };
}

// 让选区起点与系统终端一致：xterm 默认按「最近字符边界」吸附——鼠标按在字符右半边时，
// 起点会跳到下一个字符，导致复制内容比所选少了第一个字符。这里把鼠标「按下」这一次的取列
// 改为 floor（按下落在哪个字符，就从哪个字符开始选），拖动终点仍沿用 xterm 原有语义。
// 仅修改 mousedown 那一次的 getCoords，通过比对事件对象来精确命中，不影响拖动与点击。
function useCellSelectionAnchor(term, container) {
  try {
    const core = term._core;
    const mouseSvc = core?._mouseService;
    if (!mouseSvc || mouseSvc.__cellAnchorPatched) return;
    const origGetCoords = mouseSvc.getCoords.bind(mouseSvc);
    let downEvent = null;
    container.addEventListener("mousedown", (e) => { downEvent = e; }, true);
    mouseSvc.getCoords = function (event, el, cols, rows, isSelection) {
      const res = origGetCoords(event, el, cols, rows, isSelection);
      if (res && isSelection && event === downEvent) {
        const rect = el.getBoundingClientRect();
        const padLeft = parseInt(getComputedStyle(el).paddingLeft) || 0;
        const cellW = core._renderService?.dimensions?.css?.cell?.width;
        if (cellW > 0) {
          const cell = Math.floor((event.clientX - rect.left - padLeft) / cellW);
          res[0] = Math.min(Math.max(cell + 1, 1), cols + 1); // 1 基；SelectionService 后续会 -1
        }
      }
      return res;
    };
    mouseSvc.__cellAnchorPatched = true;
  } catch {}
}

function createTerminalIn(container) {
  const instance = new TerminalCtor(terminalOptions());
  const fitAddon = new FitAddonCtor();
  instance.loadAddon(fitAddon);
  instance.open(container);
  useCellSelectionAnchor(instance, container);
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
  activeGroupId = "";
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
  renderSidebar();
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

function createTerminalSession(sessionId, connection, kind = "ssh", groupId = "") {
  const pane = createTerminalPane();
  const session = {
    id: sessionId,
    kind,
    groupId,
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

// 当前活动会话所属的栏目（本地组或 SSH 连接）内的兄弟会话
function siblingSessions(session) {
  if (!session) return [];
  if (session.kind === "local") {
    return [...terminalSessions.values()].filter((s) => s.kind === "local" && s.groupId === session.groupId);
  }
  return [...terminalSessions.values()].filter((s) => s.kind !== "local" && s.connectionId === session.connectionId);
}

function renderSessionTabs() {
  const tabs = $("sessionTabs");
  tabs.innerHTML = "";

  const active = terminalSessions.get(activeSessionId);
  const isLocalGroup = active?.kind === "local";
  const siblings = siblingSessions(active);

  // 仅在栏目内有多个会话时显示横排标签；本地组始终显示以暴露「+」新建按钮
  if (!active || (siblings.length <= 1 && !isLocalGroup)) {
    tabs.classList.add("hidden");
    return;
  }
  tabs.classList.remove("hidden");

  siblings.forEach((session, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `session-tab ${session.id === activeSessionId ? "active" : ""}`;
    tab.textContent = isLocalGroup ? String(index + 1) : session.title;
    tab.addEventListener("click", () => selectTerminalSession(session.id));
    tabs.appendChild(tab);
  });

  if (isLocalGroup) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "session-tab session-tab-add";
    add.textContent = "+";
    add.title = t("newTabSameDir");
    add.addEventListener("click", () => newSessionInGroup(active.groupId));
    tabs.appendChild(add);
  }
}

function updateTerminalActions() {
  const session = terminalSessions.get(activeSessionId);
  const isLocal = session?.kind === "local";
  $("toolbarDisconnect").classList.toggle("hidden", !session);
  $("popOutTerminal").classList.toggle("hidden", !session);
  // 本地终端没有 SFTP，隐藏文件面板
  $("toggleFilePanel").classList.toggle("hidden", !session || isLocal);
  if (session) $("popOutTerminal").textContent = t(session.detached ? "showPopOut" : "popOut");
  if (!session || isLocal) closeFilePanel();
  else if (filePanelOpen) openFilePanel();
}

function selectTerminalSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    showIdleTerminal();
    return;
  }

  activeSessionId = session.id;
  let group = null;
  if (session.kind === "local") {
    activeGroupId = session.groupId;
    activeSessionConnectionId = "";
    group = terminalGroups.get(session.groupId);
    if (group) group.lastSessionId = session.id;
  } else {
    activeSessionConnectionId = session.connectionId;
    activeGroupId = "";
  }
  terminal = session.terminal;
  idlePaneElement?.classList.add("hidden");

  for (const item of terminalSessions.values()) {
    item.pane.classList.toggle("hidden", item.id !== sessionId);
  }

  // 本地终端的顶部标题显示组名（= 第一个窗口所在目录最后一节）
  $("terminalTitle").textContent = group?.title || session.title;
  setStatus(session.statusKey, session.statusValues);
  setTerminalFocus(true);
  renderSessionTabs();
  renderSidebar();
  requestAnimationFrame(fitAndResize);
}

function removeTerminalSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  const groupId = session.groupId;
  const groupSiblings = siblingSessions(session).filter((s) => s.id !== sessionId);
  terminalSessions.delete(sessionId);
  sessionRemotePath.delete(sessionId);
  uploadProgress.clear();
  downloadProgress.clear();
  session.terminal.dispose();
  session.pane.remove();

  // 本地组内会话全部关闭后，移除该组栏目；否则若关闭的是「第一个窗口」，改用现存会话作为命名基准
  if (session.kind === "local" && groupId) {
    const group = terminalGroups.get(groupId);
    if (groupSiblings.length === 0) {
      terminalGroups.delete(groupId);
      persistTerminalGroups();
    } else if (group && group.firstSessionId === sessionId) {
      group.firstSessionId = groupSiblings[0].id;
      updateGroupTitleFromCwd(groupId);
    }
  }

  if (activeSessionId !== sessionId) {
    renderSessionTabs();
    renderSidebar();
    return;
  }

  // 优先切到同栏目的下一个会话，其次任意会话，否则回到空闲
  const nextSession = groupSiblings[0] || terminalSessions.values().next().value;
  if (nextSession) selectTerminalSession(nextSession.id);
  else showIdleTerminal();
}

// 顶部分段控件：当前模式显示为「新建X」，另一模式显示为切换入口
function updateSidebarSegmented() {
  const connActive = sidebarMode === "connections";
  $("segConnections").textContent = connActive ? t("newConnection") : t("connectionsTab");
  $("segTerminals").textContent = connActive ? t("terminalsTab") : t("newTerminal");
  $("segConnections").classList.toggle("active", connActive);
  $("segTerminals").classList.toggle("active", !connActive);
}

function setSidebarMode(mode) {
  if (sidebarMode === mode) return;
  sidebarMode = mode;
  renderSidebar();
}

function renderSidebar() {
  updateSidebarSegmented();
  if (sidebarMode === "terminals") renderTerminalGroups();
  else renderList();
}

function renderTerminalGroups() {
  const list = $("connectionList");
  list.innerHTML = "";

  if (terminalGroups.size === 0) {
    const empty = document.createElement("div");
    empty.className = "connection-item";
    empty.innerHTML = `<strong>${escapeHtml(t("noTerminals"))}</strong><span>${escapeHtml(t("createTerminalToStart"))}</span>`;
    list.appendChild(empty);
    return;
  }

  for (const group of terminalGroups.values()) {
    const count = [...terminalSessions.values()].filter((s) => s.kind === "local" && s.groupId === group.id).length;
    const item = document.createElement("div");
    item.className = "connection-row";

    const button = document.createElement("button");
    button.className = `connection-item ${group.id === activeGroupId ? "active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = group.title;
    // 休眠标签（尚未拉起终端）显示记录的目录路径，已激活的显示终端数量
    button.querySelector("span").textContent = count > 0 ? t("shellCount", { count }) : (group.cwd || t("shellCount", { count }));
    button.addEventListener("click", () => {
      const g = terminalGroups.get(group.id);
      const target = (g?.lastSessionId && terminalSessions.has(g.lastSessionId))
        ? g.lastSessionId
        : [...terminalSessions.values()].find((s) => s.kind === "local" && s.groupId === group.id)?.id;
      if (target) selectTerminalSession(target);
      else activateGroup(group.id);
    });
    item.appendChild(button);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "connection-close";
    close.title = t("closeGroup");
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTerminalGroup(group.id);
    });
    item.appendChild(close);

    list.appendChild(item);
  }
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
  renderSidebar();
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
  renderSidebar();
}

function hideConnectionMenu() {
  if (!activeConnectionMenuId) return;
  activeConnectionMenuId = "";
  renderSidebar();
}

function loadConnection(connection) {
  showConnectionEditor();
  setConnectionError();
  fillConnectionForm(connection);
  setTerminalFocus(false);
  renderSidebar();
}

async function refreshConnections() {
  connections = await api.listConnections();
  renderSidebar();
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
      renderSidebar();
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

let localTerminalCounter = 0;

// 启动一个本地终端会话（可指定继承目录 cwd）
async function startLocalSession(session, { cwd = "" } = {}) {
  try {
    await api.createLocalTerminal({
      sessionId: session.id,
      title: session.title,
      cwd,
      cols: session.terminal.cols,
      rows: session.terminal.rows
    });
    session.connected = true;
    session.statusKey = "connected";
    session.statusValues = {};
    if (activeSessionId === session.id) setStatus("connected");
    renderSessionTabs();
    renderSidebar();
    fitAndResize();
  } catch (error) {
    const message = error.message || String(error);
    session.statusKey = "error";
    session.statusValues = {};
    session.terminal.writeln(`\r\n${t("localTerminalFailed", { message })}`);
    if (activeSessionId === session.id) setStatus("error");
  }
}

// 顶部「新建终端」：在侧栏新增一个终端组（栏目），默认家目录
async function createTerminalGroup() {
  localTerminalCounter += 1;
  const groupId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const title = t("localTerminalTitle", { index: localTerminalCounter });
  terminalGroups.set(groupId, { id: groupId, title, firstSessionId: sessionId, lastSessionId: "" });

  const session = createTerminalSession(sessionId, { name: title }, "local", groupId);
  sidebarMode = "terminals";
  selectTerminalSession(sessionId);
  await startLocalSession(session);
  updateGroupTitleFromCwd(groupId);
}

// 取路径最后一节作为终端名
function lastPathSegment(p) {
  const norm = String(p || "").replace(/[\\/]+$/, "");
  if (!norm) return "/";
  return norm.split(/[\\/]/).pop() || "/";
}

// 组名以「第一个窗口」当前所在目录的最后一节为准（随 cd 实时更新；Windows 取不到 cwd 时保留占位名）
// 同时缓存完整 cwd，用于退出时记录标签、下次启动恢复到对应目录
async function updateGroupTitleFromCwd(groupId) {
  const group = terminalGroups.get(groupId);
  if (!group) return;
  const first = (group.firstSessionId && terminalSessions.get(group.firstSessionId))
    || [...terminalSessions.values()].find((s) => s.kind === "local" && s.groupId === groupId);
  if (!first) return;

  let cwd = "";
  try { cwd = (await api.localTerminalCwd(first.id)) || ""; } catch {}
  if (!cwd) return;

  let changed = false;
  if (cwd !== group.cwd) {
    group.cwd = cwd;
    changed = true;
  }

  const name = lastPathSegment(cwd);
  if (name && name !== group.title) {
    group.title = name;
    first.title = name;
    if (activeSessionId === first.id || terminalSessions.get(activeSessionId)?.groupId === groupId) {
      $("terminalTitle").textContent = name;
    }
    changed = true;
  }

  if (changed) {
    renderSidebar();
    persistTerminalGroups();
  }
}

// 将当前所有终端标签（标题 + 目录）写入磁盘，供下次启动恢复
function persistTerminalGroups() {
  const data = [...terminalGroups.values()].map((g) => ({ title: g.title, cwd: g.cwd || "" }));
  api.saveTerminalGroups(data).catch(() => {});
}

// 启动时恢复上次退出记录的终端标签：以「休眠」态展示，点击后才在对应目录拉起本地终端
async function restoreTerminalGroups() {
  let saved = [];
  try { saved = await api.loadTerminalGroups(); } catch {}
  if (!Array.isArray(saved)) return;

  for (const item of saved) {
    if (!item?.cwd) continue;
    const groupId = crypto.randomUUID();
    terminalGroups.set(groupId, {
      id: groupId,
      title: item.title || lastPathSegment(item.cwd),
      cwd: item.cwd,
      firstSessionId: "",
      lastSessionId: "",
      restored: true
    });
  }

  if (terminalGroups.size > 0) {
    sidebarMode = "terminals";
    renderSidebar();
  }
}

// 激活一个休眠标签：在记录的目录（若已不存在则由主进程回退家目录）拉起本地终端
async function activateGroup(groupId) {
  const group = terminalGroups.get(groupId);
  if (!group) return;

  const sessionId = crypto.randomUUID();
  const session = createTerminalSession(sessionId, { name: group.title }, "local", groupId);
  group.firstSessionId = sessionId;
  group.restored = false;
  sidebarMode = "terminals";
  selectTerminalSession(sessionId);
  await startLocalSession(session, { cwd: group.cwd });
  updateGroupTitleFromCwd(groupId);
}

// 组内「+」：新建标签并继承当前终端目录（类 cmd+t）
async function newSessionInGroup(groupId) {
  const group = terminalGroups.get(groupId);
  if (!group) return;

  let cwd = "";
  const current = terminalSessions.get(activeSessionId);
  if (current?.kind === "local" && current.groupId === groupId) {
    try { cwd = (await api.localTerminalCwd(current.id)) || ""; } catch {}
  }

  const sessionId = crypto.randomUUID();
  const session = createTerminalSession(sessionId, { name: group.title }, "local", groupId);
  selectTerminalSession(sessionId);
  await startLocalSession(session, { cwd });
}

// 关闭整个终端组（断开组内全部会话）
async function closeTerminalGroup(groupId) {
  const ids = [...terminalSessions.values()]
    .filter((s) => s.kind === "local" && s.groupId === groupId)
    .map((s) => s.id);
  for (const id of ids) {
    await api.disconnect(id);
    removeTerminalSession(id);
  }
  terminalGroups.delete(groupId);
  renderSidebar();
  persistTerminalGroups();
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

// 强制重新测量字符单元格尺寸。
// 非活动会话的面板用 display:none 隐藏，xterm 在隐藏态会把单元格量成 0 并缓存
// （hasValidSize=false）。切回可见后若不主动重测，fit() 会因 cell.width===0 直接返回，
// 沿用陈旧/0 尺寸 → 宽高都不对；要等下一次输入触发内部 refresh 才恢复（即「打字就正常」）。
// measure() 一旦量到新尺寸便会触发 onCharSizeChange → 渲染层重算并重绘，宽高随即纠正。
function remeasure(term) {
  try {
    term._core?._charSizeService?.measure?.();
  } catch {}
}

function fitAndResize() {
  const session = terminalSessions.get(activeSessionId);
  if (session) {
    remeasure(session.terminal);
    session.fitAddon.fit();
    const { cols, rows } = session.terminal;
    // 仅在行列变化时同步 PTY，避免 ResizeObserver 高频触发导致的 IPC 抖动
    if (Number.isFinite(cols) && Number.isFinite(rows) && (session.lastCols !== cols || session.lastRows !== rows)) {
      session.lastCols = cols;
      session.lastRows = rows;
      api.resize({ sessionId: activeSessionId, cols, rows });
    }
    return;
  }
  remeasure(idleTerminal);
  idleFitAddon.fit();
}

function fileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function canUploadToActiveSession() {
  const session = terminalSessions.get(activeSessionId);
  return Boolean(session && session.kind !== "local");
}

async function uploadDroppedFiles(files, remoteDir = "") {
  const session = terminalSessions.get(activeSessionId);
  if (session && session.kind === "local") return; // 本地终端不支持 SFTP 上传
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

$("connect").addEventListener("click", () => connect());
$("disconnect").addEventListener("click", disconnect);
$("toolbarDisconnect").addEventListener("click", disconnect);
$("popOutTerminal").addEventListener("click", openTerminalWindow);
$("segConnections").addEventListener("click", () => {
  if (sidebarMode === "connections") clearForm(); // 已在链接模式 → 新建连接
  else setSidebarMode("connections");
});
$("segTerminals").addEventListener("click", () => {
  if (sidebarMode === "terminals") createTerminalGroup(); // 已在终端模式 → 新建终端
  else setSidebarMode("terminals");
});
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
// 容器真实尺寸变化时自动重排：覆盖窗口缩放之外的所有情形——
// 侧栏/标签显隐改变可视宽高、首帧字体与单元格测量尚未就绪等。
// 仅靠一次 rAF 的 fit 会在测量未就绪时算出错误 cols/rows 且无后续事件纠正，
// 表现为「宽度溢出」与「高度固定无法滚动」。
const terminalResizeObserver = new ResizeObserver(() => fitAndResize());
terminalResizeObserver.observe($("terminal"));
// 字体加载完成后单元格尺寸会变化，补一次重排纠正首帧偏差
document.fonts?.ready?.then(fitAndResize);
// 窗口从后台/遮挡恢复到前台时，xterm 在不可见期间量得的单元格尺寸为 0，需重测重排。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestAnimationFrame(fitAndResize);
});
window.addEventListener("focus", () => requestAnimationFrame(fitAndResize));
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
      const action = await api.showFileMenu({
        labels: {
          download: t(entry.isDirectory ? "menuDownloadDir" : "menuDownloadFile"),
          delete: t("menuDelete")
        }
      });
      if (action === "download") {
        await handleDownloadEntry(entry, remotePath);
      } else if (action === "delete") {
        if (!window.confirm(t("confirmDelete", { name: entry.name }))) return;
        try {
          await api.removeRemote({ sessionId: activeSessionId, remotePath });
          await refreshFilePanel();
        } catch (error) {
          setFilePanelStatus("deleteFailed", { message: error.message });
        }
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

async function handleDownloadEntry(entry, remotePath) {
  if (!activeSessionId) return;
  const folder = await api.chooseDownloadFolder({
    title: t("chooseFolderTitle", { name: entry.name }),
    buttonLabel: t("chooseFolderBtn")
  });
  if (!folder) return;
  setFilePanelStatus("preparingDownload", { fileName: entry.name });
  try {
    const result = await api.downloadRemoteTo({
      sessionId: activeSessionId,
      remotePath,
      name: entry.name,
      localFolder: folder
    });
    setFilePanelStatus("downloadDone", { fileName: entry.name });
    api.revealInFolder(result.localPath);
  } catch (error) {
    if (error?.code === "EEXIST" || /already exists/i.test(error?.message || "")) {
      if (window.confirm(t("overwriteConfirm", { name: entry.name }))) {
        try {
          const result = await api.downloadRemoteTo({
            sessionId: activeSessionId,
            remotePath,
            name: entry.name,
            localFolder: folder,
            overwrite: true
          });
          setFilePanelStatus("downloadDone", { fileName: entry.name });
          api.revealInFolder(result.localPath);
          return;
        } catch (retryError) {
          setFilePanelStatus("downloadFailed", { message: retryError.message });
          return;
        }
      }
      setFilePanelStatus("");
      return;
    }
    setFilePanelStatus("downloadFailed", { message: error.message });
  }
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
  event.dataTransfer.dropEffect = canUploadToActiveSession() ? "copy" : "none";
  if (canUploadToActiveSession()) $("terminal").closest(".terminal-panel").classList.add("drag-over");
});

$("terminal").addEventListener("dragleave", () => {
  $("terminal").closest(".terminal-panel").classList.remove("drag-over");
});

$("terminal").addEventListener("drop", async (event) => {
  event.preventDefault();
  $("terminal").closest(".terminal-panel").classList.remove("drag-over");
  await uploadDroppedFiles(event.dataTransfer.files, sessionRemotePath.get(activeSessionId) || "");
});

// 写入终端数据并保持「跟随底部」：
// PTY 大批量输出时，xterm 的吸底与 DOM 滚动区同步存在竞态，偶发停在顶部且无法滚到底；
// 写入前记录是否在底部，待本次数据渲染完成后再补一次 scrollToBottom 纠正。
// 若用户已向上滚动阅读历史，则保留其阅读位置，不强制拽到底部。
function writeFollowingBottom(term, data) {
  const buffer = term.buffer.active;
  const atBottom = buffer.viewportY >= buffer.baseY;
  term.write(data, () => {
    if (atBottom) term.scrollToBottom();
  });
}

api.onData(({ sessionId, data }) => {
  const session = terminalSessions.get(sessionId);
  if (session) writeFollowingBottom(session.terminal, data);
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

// 启动时恢复上次退出记录的终端标签
restoreTerminalGroups().catch(() => {});

// 定时刷新各终端组名（跟随第一个窗口的当前目录），并据此持久化标签
setInterval(() => {
  for (const groupId of terminalGroups.keys()) updateGroupTitleFromCwd(groupId);
}, 2000);

// 关闭窗口前补记一次当前标签，尽量减少轮询间隔造成的目录滞后
window.addEventListener("beforeunload", () => {
  if (terminalGroups.size > 0) persistTerminalGroups();
});
