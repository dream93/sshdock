(function (root, factory) {
  const behavior = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = behavior;
  if (root) root.SSHDockTerminalBehavior = behavior;
})(typeof window !== "undefined" ? window : null, function () {
  const COLUMN_SELECTION_MODE = 3;

  function selectionTextWithVisualLineBreaks(term, lineEnding = "\n") {
    const selection = term.getSelectionPosition();
    if (!selection) return "";

    const lines = [];
    for (let row = selection.start.y; row <= selection.end.y; row++) {
      const line = term.buffer.active.getLine(row);
      const startColumn = row === selection.start.y ? selection.start.x : 0;
      const endColumn = row === selection.end.y ? selection.end.x : undefined;
      const text = line?.translateToString(true, startColumn, endColumn) || "";
      lines.push(text.replace(/\u00a0/g, " "));
    }
    return lines.join(lineEnding);
  }

  // xterm 默认会把视觉折行重新拼成逻辑长行；复制时按屏幕行写入剪贴板，保留用户看到的换行。
  function enableVisualLineCopy(term, lineEnding = "\n") {
    term.element?.addEventListener("copy", (event) => {
      if (!term.hasSelection() || !event.clipboardData) return;
      // 列选区本身已按行复制，继续使用 xterm 的原始结果。
      if (term._core?._selectionService?._activeSelectionMode === COLUMN_SELECTION_MODE) return;
      event.clipboardData.setData("text/plain", selectionTextWithVisualLineBreaks(term, lineEnding));
      event.preventDefault();
    });
  }

  function writeFollowingBottom(term, data) {
    const buffer = term.buffer.active;
    const followBottom = buffer.viewportY >= buffer.baseY;

    // 即使坐标已在底部，xterm 内部仍可能残留 userScrolling 状态。写入前调用一次可恢复实时跟随。
    if (followBottom) term.scrollToBottom();
    term.write(data, () => {
      if (!followBottom) return;
      term.scrollToBottom();
      try {
        term._core?.viewport?.syncScrollArea?.(true);
      } catch {}
    });
  }

  return {
    enableVisualLineCopy,
    selectionTextWithVisualLineBreaks,
    writeFollowingBottom
  };
});
