const api = window.sshDock;
const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: light)");
const THEME_STORAGE_KEY = "sshdock.theme";
const $ = (id) => document.getElementById(id);

let themeMode = localStorage.getItem(THEME_STORAGE_KEY) || "system";
let terminal;

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
terminal.writeln("SSHDock ready.");

let connections = [];
let activeConnectionId = "";
let activeSessionId = "";
const uploadProgress = new Map();

function currentAuthType() {
  return document.querySelector('input[name="authType"]:checked').value;
}

function setStatus(text) {
  $("status").textContent = text;
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
    keyPath: $("keyPath").value.trim()
  };
}

function renderList() {
  const list = $("connectionList");
  list.innerHTML = "";

  if (connections.length === 0) {
    const empty = document.createElement("div");
    empty.className = "connection-item";
    empty.innerHTML = "<strong>No saved hosts</strong><span>Create one to start.</span>";
    list.appendChild(empty);
    return;
  }

  for (const connection of connections) {
    const button = document.createElement("button");
    button.className = `connection-item ${connection.id === activeConnectionId ? "active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(connection.name)}</strong><span>${escapeHtml(connection.username)}@${escapeHtml(connection.host)}:${connection.port}</span>`;
    button.addEventListener("click", () => loadConnection(connection));
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

function clearForm() {
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
  $("formTitle").textContent = "New connection";
  updateAuthUI();
  renderList();
}

function loadConnection(connection) {
  $("connectionId").value = connection.id;
  $("name").value = connection.name;
  $("host").value = connection.host;
  $("port").value = connection.port;
  $("username").value = connection.username;
  $("keyPath").value = connection.keyPath || "";
  $("password").value = "";
  $("passphrase").value = "";
  document.querySelector(`input[name="authType"][value="${connection.authType}"]`).checked = true;
  activeConnectionId = connection.id;
  $("formTitle").textContent = connection.name;
  updateAuthUI();
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
  setStatus("Saved");
}

async function connect() {
  if (activeSessionId) await disconnect();

  const connection = formConnection();
  setStatus("Connecting");
  terminal.clear();
  terminal.writeln(`Connecting to ${connection.username}@${connection.host}:${connection.port}...`);

  try {
    const result = await api.connect({
      connection,
      password: $("password").value,
      passphrase: $("passphrase").value
    });
    activeSessionId = result.sessionId;
    $("terminalTitle").textContent = connection.name || connection.host;
    setStatus("Connected");
    fitAndResize();
  } catch (error) {
    setStatus("Connection failed");
    terminal.writeln(`\r\nConnection failed: ${error.message}`);
  }
}

async function disconnect() {
  if (!activeSessionId) return;
  const sessionId = activeSessionId;
  activeSessionId = "";
  await api.disconnect(sessionId);
  setStatus("Disconnected");
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
    setStatus("Connect before uploading");
    terminal.writeln("\r\nConnect to a host before dropping files.");
    return;
  }

  const fileList = Array.from(files).filter((file) => file.path);
  if (fileList.length === 0) return;

  for (const file of fileList) {
    setStatus(`Uploading ${file.name}`);
    terminal.writeln(`\r\nUploading ${file.name}...`);
    try {
      const result = await api.uploadFile({
        sessionId: activeSessionId,
        localPath: file.path
      });
      setStatus(`Uploaded ${result.fileName}`);
      terminal.writeln(`\r\nUploaded ${result.fileName} -> ${result.remotePath} (${fileSizeLabel(result.size)})`);
    } catch (error) {
      setStatus("Upload failed");
      terminal.writeln(`\r\nUpload failed: ${error.message}`);
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
$("newConnection").addEventListener("click", clearForm);
$("themeMode").addEventListener("change", (event) => applyTheme(event.target.value));
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
  setStatus("Deleted");
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
  setStatus(`Uploading ${fileName} ${percent}%`);
});

api.onClosed(({ sessionId }) => {
  if (sessionId === activeSessionId) {
    activeSessionId = "";
    setStatus("Closed");
    terminal.writeln("\r\nSession closed.");
  }
});

api.onError(({ sessionId, message }) => {
  if (sessionId === activeSessionId) {
    setStatus("Error");
    terminal.writeln(`\r\n${message}`);
  }
});

refreshConnections().catch((error) => setStatus(error.message));
