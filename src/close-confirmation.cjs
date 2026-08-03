const TASK_INTERRUPTION_WARNING = "关闭后正在运行的任务会被中断。";
const UNTITLED_TERMINAL = "未命名终端";

function normalizeWindowTitle(title) {
  return String(title ?? "")
    .replace(/\s+/g, " ")
    .trim() || UNTITLED_TERMINAL;
}

function formatActiveTaskDetail(titles = []) {
  const titleCounts = new Map();
  for (const title of titles) {
    const normalized = normalizeWindowTitle(title);
    titleCounts.set(normalized, (titleCounts.get(normalized) || 0) + 1);
  }

  if (titleCounts.size === 0) return TASK_INTERRUPTION_WARNING;

  const windowList = [...titleCounts.entries()].map(([title, count]) =>
    `• ${title}${count > 1 ? `（${count} 个）` : ""}`
  );

  return [
    "仍在运行的窗口：",
    ...windowList,
    "",
    TASK_INTERRUPTION_WARNING
  ].join("\n");
}

module.exports = {
  formatActiveTaskDetail,
  normalizeWindowTitle
};
