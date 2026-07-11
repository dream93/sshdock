"use strict";

const fs = require("fs");
const path = require("path");
const { Arch } = require("electron-builder");

// 只保留应用真正支持的语言（界面仅有 English / 简体中文）。
// Electron 默认打包 55 个 locale 的 .pak（macOS 约 37MB），其余全部删除以缩减包体。
const KEEP = new Set(["en", "en_GB", "zh_CN"]);

function pruneLprojDir(dir) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue;
    const locale = entry.name.slice(0, -".lproj".length);
    if (KEEP.has(locale)) continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

// 删除 node-pty 里与目标平台/架构不匹配的预编译二进制（随 asarUnpack 一起分发）。
// 若不裁剪，arm64 的 mac 包会残留 darwin-x64 的 pty.node / spawn-helper，
// macOS 26 起会因包内含 Intel 专用组件而弹出“即将结束对 Intel 芯片 App 的支持”警告。
function prunePtyPrebuilds(resourcesDir, platform, archName) {
  const prebuildsDir = path.join(
    resourcesDir,
    "app.asar.unpacked/node_modules/node-pty/prebuilds"
  );
  const keep =
    archName === "universal"
      ? new Set([`${platform}-x64`, `${platform}-arm64`])
      : new Set([`${platform}-${archName}`]);
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    fs.rmSync(path.join(prebuildsDir, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

// electron-builder afterPack 钩子：打包完成后、签名/制作安装包之前，
// 裁剪多余语言资源和与目标架构不匹配的 node-pty 预编译二进制。
module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch, packager } = context;
  const isMac = electronPlatformName === "darwin" || electronPlatformName === "mas";

  let resourcesDir;
  let localesRemoved = 0;
  if (isMac) {
    const appName = `${packager.appInfo.productFilename}.app`;
    resourcesDir = path.join(appOutDir, appName, "Contents/Resources");
    localesRemoved = pruneLprojDir(
      path.join(
        appOutDir,
        appName,
        "Contents/Frameworks/Electron Framework.framework/Resources"
      )
    );
    if (localesRemoved) {
      console.log(`  • pruned ${localesRemoved} unused locale directories`);
    }
  } else {
    // Windows / Linux：locale .pak 位于 appOutDir/locales 下的 *.pak 文件
    resourcesDir = path.join(appOutDir, "resources");
    const localesDir = path.join(appOutDir, "locales");
    try {
      for (const file of fs.readdirSync(localesDir)) {
        if (!file.endsWith(".pak")) continue;
        const locale = file.slice(0, -".pak".length);
        if (KEEP.has(locale)) continue;
        fs.rmSync(path.join(localesDir, file), { force: true });
        localesRemoved += 1;
      }
    } catch {}
    if (localesRemoved) console.log(`  • pruned ${localesRemoved} unused locale paks`);
  }

  // node-pty 的 prebuilds 目录按 Node 的平台名组织（darwin-* / win32-*）
  const platform = isMac ? "darwin" : electronPlatformName;
  const prebuildsRemoved = prunePtyPrebuilds(resourcesDir, platform, Arch[arch]);
  if (prebuildsRemoved) {
    console.log(`  • pruned ${prebuildsRemoved} mismatched node-pty prebuilds`);
  }
};
