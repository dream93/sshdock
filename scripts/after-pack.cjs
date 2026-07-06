"use strict";

const fs = require("fs");
const path = require("path");

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

// electron-builder afterPack 钩子：打包完成后、签名/制作安装包之前裁剪多余语言资源。
module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const candidates = [];

  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    const appName = `${packager.appInfo.productFilename}.app`;
    candidates.push(
      path.join(
        appOutDir,
        appName,
        "Contents/Frameworks/Electron Framework.framework/Resources"
      )
    );
  } else {
    // Windows / Linux：locale .pak 位于 resources/locales 下的 *.pak 文件
    const localesDir = path.join(appOutDir, "locales");
    let removed = 0;
    try {
      for (const file of fs.readdirSync(localesDir)) {
        if (!file.endsWith(".pak")) continue;
        const locale = file.slice(0, -".pak".length);
        if (KEEP.has(locale)) continue;
        fs.rmSync(path.join(localesDir, file), { force: true });
        removed += 1;
      }
    } catch {}
    if (removed) console.log(`  • pruned ${removed} unused locale paks`);
    return;
  }

  let removed = 0;
  for (const dir of candidates) removed += pruneLprojDir(dir);
  if (removed) console.log(`  • pruned ${removed} unused locale directories`);
};
