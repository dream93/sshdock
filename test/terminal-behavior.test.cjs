const assert = require("node:assert/strict");
const test = require("node:test");
const {
  enableVisualLineCopy,
  selectionTextWithVisualLineBreaks,
  writeFollowingBottom
} = require("../src/renderer/terminal-behavior.js");

function createSelectionTerminal(lines, start, end) {
  return {
    buffer: {
      active: {
        getLine(row) {
          const value = lines[row];
          if (value === undefined) return undefined;
          return {
            translateToString(trimRight, startColumn = 0, endColumn = value.length) {
              const text = value.slice(startColumn, endColumn);
              return trimRight ? text.replace(/\s+$/g, "") : text;
            }
          };
        }
      }
    },
    getSelectionPosition() {
      return { start, end };
    }
  };
}

test("复制跨越视觉折行时保留每一行", () => {
  const terminal = createSelectionTerminal(
    ["abcde", "fghij", "klmno"],
    { x: 1, y: 0 },
    { x: 2, y: 2 }
  );

  assert.equal(selectionTextWithVisualLineBreaks(terminal), "bcde\nfghij\nkl");
});

test("复制使用指定换行符并替换不换行空格", () => {
  const terminal = createSelectionTerminal(
    ["a\u00a0b", "cd"],
    { x: 0, y: 0 },
    { x: 2, y: 1 }
  );

  assert.equal(selectionTextWithVisualLineBreaks(terminal, "\r\n"), "a b\r\ncd");
});

test("复制事件覆盖 xterm 合并折行后的默认文本", () => {
  let copyHandler;
  let copied = "";
  let prevented = false;
  const terminal = createSelectionTerminal(
    ["first", "second"],
    { x: 0, y: 0 },
    { x: 6, y: 1 }
  );
  terminal.element = {
    addEventListener(type, handler) {
      if (type === "copy") copyHandler = handler;
    }
  };
  terminal.hasSelection = () => true;
  terminal._core = { _selectionService: { _activeSelectionMode: 0 } };

  enableVisualLineCopy(terminal);
  copyHandler({
    clipboardData: { setData: (_type, value) => { copied = value; } },
    preventDefault: () => { prevented = true; }
  });

  assert.equal(copied, "first\nsecond");
  assert.equal(prevented, true);
});

test("列选区继续使用 xterm 的原始复制结果", () => {
  let copyHandler;
  let copied = false;
  const terminal = createSelectionTerminal(["abc"], { x: 0, y: 0 }, { x: 2, y: 0 });
  terminal.element = { addEventListener: (_type, handler) => { copyHandler = handler; } };
  terminal.hasSelection = () => true;
  terminal._core = { _selectionService: { _activeSelectionMode: 3 } };

  enableVisualLineCopy(terminal);
  copyHandler({
    clipboardData: { setData: () => { copied = true; } },
    preventDefault: () => {}
  });

  assert.equal(copied, false);
});

test("底部写入前恢复跟随并在写入后同步滚动区", () => {
  const calls = [];
  let written;
  const terminal = {
    buffer: { active: { viewportY: 8, baseY: 8 } },
    scrollToBottom: () => calls.push("scroll"),
    write: (_data, callback) => {
      calls.push("write");
      written = callback;
    },
    _core: { viewport: { syncScrollArea: (immediate) => calls.push(`sync:${immediate}`) } }
  };

  writeFollowingBottom(terminal, "output");
  assert.deepEqual(calls, ["scroll", "write"]);
  written();
  assert.deepEqual(calls, ["scroll", "write", "scroll", "sync:true"]);
});

test("用户查看历史时输出不改变滚动位置", () => {
  let written;
  let scrollCount = 0;
  const terminal = {
    buffer: { active: { viewportY: 3, baseY: 8 } },
    scrollToBottom: () => { scrollCount++; },
    write: (_data, callback) => { written = callback; }
  };

  writeFollowingBottom(terminal, "output");
  written();
  assert.equal(scrollCount, 0);
});
