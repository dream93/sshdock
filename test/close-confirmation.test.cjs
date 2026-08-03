const assert = require("node:assert/strict");
const test = require("node:test");
const {
  formatActiveTaskDetail,
  normalizeWindowTitle
} = require("../src/close-confirmation.cjs");

test("关闭提示列出仍有任务的窗口名称", () => {
  assert.equal(
    formatActiveTaskDetail(["本地项目", "生产服务器"]),
    [
      "仍在运行的窗口：",
      "• 本地项目",
      "• 生产服务器",
      "",
      "关闭后正在运行的任务会被中断。"
    ].join("\n")
  );
});

test("关闭提示清理窗口名称并合并同名窗口", () => {
  assert.equal(normalizeWindowTitle("  项目\n终端  "), "项目 终端");
  assert.equal(
    formatActiveTaskDetail(["项目\n终端", "项目 终端", "", null]),
    [
      "仍在运行的窗口：",
      "• 项目 终端（2 个）",
      "• 未命名终端（2 个）",
      "",
      "关闭后正在运行的任务会被中断。"
    ].join("\n")
  );
});

test("没有窗口名称时保留原有中断警告", () => {
  assert.equal(formatActiveTaskDetail(), "关闭后正在运行的任务会被中断。");
});
