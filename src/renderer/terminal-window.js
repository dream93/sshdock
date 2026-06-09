const api = window.sshDock;
const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: light)");
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId") || "";
const initialTitle = params.get("title") || "Terminal";

function resolvedTheme() {
  const mode = localStorage.getItem("sshdock.theme") || "system";
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

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  terminal.options.theme = terminalTheme();
}

const terminal = new TerminalCtor({
  cursorBlink: true,
  convertEol: true,
  scrollback: 10000,
  fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  theme: terminalTheme()
});
const fitAddon = new FitAddonCtor();

terminal.loadAddon(fitAddon);
terminal.open(document.getElementById("terminal"));
document.getElementById("terminalTitle").textContent = initialTitle;
document.title = `${initialTitle} - SSHDock`;

let lastCols = 0;
let lastRows = 0;
function fitAndResize() {
  fitAddon.fit();
  // 仅在行列变化时同步 PTY，避免 ResizeObserver 高频触发导致的 IPC 抖动
  if (sessionId && (terminal.cols !== lastCols || terminal.rows !== lastRows)) {
    lastCols = terminal.cols;
    lastRows = terminal.rows;
    api.resize({ sessionId, cols: terminal.cols, rows: terminal.rows });
  }
}

terminal.onData((data) => {
  if (sessionId) api.sendInput({ sessionId, data });
});

// 写入并保持「跟随底部」：大批量输出时避免视口停在顶部而无法滚到底；
// 若用户已向上滚动阅读历史，则保留其阅读位置。
function writeFollowingBottom(data) {
  const buffer = terminal.buffer.active;
  const atBottom = buffer.viewportY >= buffer.baseY;
  terminal.write(data, () => {
    if (atBottom) terminal.scrollToBottom();
  });
}

api.onData((payload) => {
  if (payload.sessionId === sessionId) writeFollowingBottom(payload.data);
});

api.onClosed((payload) => {
  if (payload.sessionId !== sessionId) return;
  document.getElementById("status").textContent = "Closed";
  terminal.writeln("\r\nSession closed.");
});

api.onError((payload) => {
  if (payload.sessionId !== sessionId) return;
  document.getElementById("status").textContent = "Error";
  terminal.writeln(`\r\n${payload.message}`);
});

window.addEventListener("resize", fitAndResize);
// 容器真实尺寸变化时自动重排：覆盖首帧字体与单元格测量未就绪、窗口尺寸由系统二次调整等情形，
// 避免 cols/rows 与可视区不一致导致的「宽度溢出」「高度固定无法滚动」。
new ResizeObserver(() => fitAndResize()).observe(document.getElementById("terminal"));
document.fonts?.ready?.then(fitAndResize);
systemThemeQuery.addEventListener("change", applyTheme);

api.terminalSnapshot(sessionId).then((snapshot) => {
  if (snapshot.title) {
    document.getElementById("terminalTitle").textContent = snapshot.title;
    document.title = `${snapshot.title} - SSHDock`;
  }
  if (snapshot.history) terminal.write(snapshot.history);
  fitAndResize();
}).catch(() => {
  fitAndResize();
});
