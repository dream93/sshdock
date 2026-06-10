// pnpm 的 hoisted 模式复制文件时会丢失 node-pty spawn-helper 的可执行位，
// 导致 macOS 上 pty.spawn 报 "posix_spawnp failed"，安装后统一补回权限。
const fs = require("fs");
const path = require("path");

if (process.platform === "win32") process.exit(0);

const prebuildsDir = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds");
let entries;
try {
  entries = fs.readdirSync(prebuildsDir);
} catch {
  process.exit(0);
}

for (const entry of entries) {
  const helper = path.join(prebuildsDir, entry, "spawn-helper");
  try {
    fs.chmodSync(helper, 0o755);
    console.log(`fix-pty-perms: chmod 755 ${helper}`);
  } catch {}
}
