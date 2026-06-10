const api = window.sshDock;
const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: light)");
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId") || "";
const initialTitle = params.get("title") || "Terminal";
const sessionKind = params.get("kind") || "ssh";

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

// 修复中文输入法的全角标点（，。！？等）被发成半角英文标点的问题。
// 根因：macOS 中文输入法把全角标点当作「按下标点键 → 在 input 事件里插入」处理，按一下中文逗号
// 只触发一次 keydown（key=","、keyCode=188，无 input/composition 事件），而 xterm 的 keydown
// 会先把半角 ASCII 发出去并 preventDefault，反而阻断了输入法的全角转换。
// 做法：对可被输入法转换的标点/符号键放行 keydown，改由监听 textarea 的 input 事件转发最终插入的
// 字符（中文模式得全角、英文模式得半角，均正确）；汉字走 composition 通道由 xterm 自身处理。
(function enableImePunctuation() {
  let pending = false;
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    pending = false;
    if (event.key && event.key.length === 1 && !event.ctrlKey && !event.altKey &&
        !event.metaKey && event.key !== " " && !/[a-zA-Z0-9]/.test(event.key)) {
      pending = true;
      return false;
    }
    return true;
  });
  const textarea = terminal.textarea;
  if (!textarea) return;
  textarea.addEventListener("input", (event) => {
    if (!pending) return;
    pending = false;
    if (event.isComposing) return;
    if (typeof event.data === "string" && event.data) {
      terminal.input(event.data, true);
    }
    textarea.value = "";
  });
})();
document.getElementById("terminalTitle").textContent = initialTitle;
document.title = `${initialTitle} - SSHDock`;

// 让选区起点与系统终端一致：xterm 默认按「最近字符边界」吸附，鼠标按在字符右半边时起点会跳到
// 下一个字符，导致复制少了第一个字符。这里把鼠标「按下」这一次的取列改为 floor（按下落在哪个
// 字符就从哪个字符开始选），拖动终点仍沿用 xterm 原有语义。
(function useCellSelectionAnchor() {
  try {
    const core = terminal._core;
    const mouseSvc = core?._mouseService;
    if (!mouseSvc) return;
    const container = document.getElementById("terminal");
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
          res[0] = Math.min(Math.max(cell + 1, 1), cols + 1);
        }
      }
      return res;
    };
  } catch {}
})();

// 强制重新测量字符单元格尺寸：窗口处于后台/被遮挡时 xterm 会把单元格量成 0 并缓存，
// 此时 fit() 因 cell.width===0 直接返回，恢复前台后沿用陈旧尺寸导致宽高都不对，
// 要等下一次输入触发内部 refresh 才恢复。measure() 量到新尺寸会触发重算重绘，宽高即纠正。
function remeasure() {
  try {
    terminal._core?._charSizeService?.measure?.();
  } catch {}
}

let lastCols = 0;
let lastRows = 0;
function fitAndResize() {
  remeasure();
  fitAddon.fit();
  // 仅在行列变化时同步 PTY，避免 ResizeObserver 高频触发导致的 IPC 抖动
  if (sessionId && Number.isFinite(terminal.cols) && Number.isFinite(terminal.rows) &&
      (terminal.cols !== lastCols || terminal.rows !== lastRows)) {
    lastCols = terminal.cols;
    lastRows = terminal.rows;
    api.resize({ sessionId, cols: terminal.cols, rows: terminal.rows });
  }
}

terminal.onData((data) => {
  if (sessionId) api.sendInput({ sessionId, data });
});

// 拖入文件/文件夹时把路径作为文本插入（像普通终端那样）；独立窗口无 SFTP，始终插入路径
function escapePosixPath(p) {
  return p.replace(/([\s'"\\$`&|;<>()*?!#~\[\]{}])/g, "\\$1");
}
function escapeWinPath(p) {
  return /[\s&()[\]{}^=;!'+,`~]/.test(p) ? `"${p}"` : p;
}
const terminalEl = document.getElementById("terminal");
terminalEl.addEventListener("dragover", (event) => {
  if (!sessionId || !event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
terminalEl.addEventListener("drop", (event) => {
  if (!sessionId || !event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  const paths = Array.from(event.dataTransfer.files).map((file) => file.path).filter(Boolean);
  if (!paths.length) return;
  // SSH 目标几乎都是 POSIX；本地终端按宿主平台决定转义方式
  const posix = sessionKind !== "local" || api.platform !== "win32";
  const escape = posix ? escapePosixPath : escapeWinPath;
  api.sendInput({ sessionId, data: paths.map(escape).join(" ") + " " });
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
// 窗口从后台/遮挡恢复前台时重测重排
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestAnimationFrame(fitAndResize);
});
window.addEventListener("focus", () => requestAnimationFrame(fitAndResize));
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
