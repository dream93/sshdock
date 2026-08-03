const api = window.sshDock;
const $ = (id) => document.getElementById(id);
const languageMode = localStorage.getItem("sshdock.language") || "system";
const language = languageMode === "zh-CN" || (languageMode === "system" && navigator.language.toLowerCase().startsWith("zh"))
  ? "zh-CN"
  : "en";
const labels = language === "zh-CN"
  ? { back: "后退", forward: "前进", reload: "刷新", stop: "停止加载", external: "用系统默认浏览器打开", currentUrl: "当前网址" }
  : { back: "Back", forward: "Forward", reload: "Reload", stop: "Stop loading", external: "Open in system browser", currentUrl: "Current URL" };
let loading = false;

document.documentElement.lang = language;

function setButtonLabel(id, label) {
  const button = $(id);
  button.title = label;
  button.setAttribute("aria-label", label);
}

setButtonLabel("browserBack", labels.back);
setButtonLabel("browserForward", labels.forward);
setButtonLabel("browserReload", labels.reload);
setButtonLabel("browserOpenExternal", labels.external);
$("browserUrl").setAttribute("aria-label", labels.currentUrl);

$("browserBack").addEventListener("click", () => api.browserAction("back"));
$("browserForward").addEventListener("click", () => api.browserAction("forward"));
$("browserReload").addEventListener("click", () => api.browserAction(loading ? "stop" : "reload"));
$("browserOpenExternal").addEventListener("click", () => {
  api.openCurrentBrowserExternal().catch((error) => console.error("默认浏览器打开链接失败：", error));
});
$("browserUrl").addEventListener("focus", (event) => event.target.select());

api.onBrowserState((state) => {
  loading = Boolean(state.loading);
  $("browserBack").disabled = !state.canGoBack;
  $("browserForward").disabled = !state.canGoForward;
  $("browserReload").textContent = loading ? "×" : "↻";
  setButtonLabel("browserReload", loading ? labels.stop : labels.reload);
  $("browserTitle").textContent = state.error || state.title || "SSHDock Browser";
  $("browserUrl").value = state.url || "";
});
