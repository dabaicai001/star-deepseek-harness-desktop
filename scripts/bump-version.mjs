#!/usr/bin/env node
/**
 * bump-version.mjs — 一键同步 StarHub 全部版本号位置。
 *
 * 用法:
 *   npm run version -- patch|minor|major   # 按语义化版本递增
 *   npm run version -- 0.43.0              # 直接指定新版本
 *   npm run version -- patch --dry-run     # 只打印将修改的文件,不落盘
 *
 * 覆盖 AGENTS.md 6.5 节要求的七处版本号:
 *   1. package.json
 *   2. src-tauri/Cargo.toml
 *   3. src-tauri/Cargo.lock (starhub 包)
 *   4. src-tauri/tauri.conf.json
 *   5. CHANGELOG.md ([未发布] 已完成条目移入新版本区块)
 *   6. AGENTS.md (第 2 节「当前版本」+ 末尾「最后更新」)
 *   7. README.md (version badge + 「当前版本」区)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

const SECTION_EMOJI = {
  新增: "✨",
  变更: "🔧",
  修复: "🐛",
  性能: "⚡",
  文档: "📝",
  测试: "✅",
  移除: "🗑️",
  安全: "🔒",
};

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/** 读取文件并探测行尾格式,返回 { text, eol }。 */
function readText(rel) {
  const raw = readFileSync(join(ROOT, rel), "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { text: raw.replace(/\r\n/g, "\n"), eol };
}

function writeText(rel, content, eol, dryRun, changes) {
  changes.push(rel);
  if (!dryRun) writeFileSync(join(ROOT, rel), content.replace(/\n/g, eol), "utf8");
}

function nextVersion(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) fail(`无法解析当前版本号: ${current}`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else if (kind === "patch") {
    patch += 1;
  } else {
    fail(`未知的递增类型: ${kind} (支持 patch|minor|major|x.y.z)`);
  }
  return `${major}.${minor}.${patch}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 CHANGELOG 某版本区块提取条目摘要(第一行)。 */
function firstSummary(content, version) {
  const start = content.indexOf(`## [${version}] - `);
  if (start === -1) return "";
  const line = content
    .slice(start)
    .split("\n")
    .find((item) => item.startsWith("- "));
  return line ? line.slice(2).trim() : "";
}

/** 从 CHANGELOG 某版本区块生成 README「当前版本」区的带 emoji 摘要行。 */
function readmeEntries(content, version) {
  const start = content.indexOf(`## [${version}] - `);
  if (start === -1) return [];
  const end = content.indexOf("\n---\n", start);
  const body = content.slice(start, end === -1 ? undefined : end);

  const lines = [];
  let emoji = "🔧";
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const section = /^### (.+)$/.exec(line);
    if (section) {
      emoji = SECTION_EMOJI[section[1].trim()] ?? "🔧";
      continue;
    }
    if (line.startsWith("- ")) lines.push(`- ${emoji} ${line.slice(2)}`);
  }
  return lines;
}

/** 把 CHANGELOG [未发布] 中已完成条目移入新版本区块。 */
function releaseChangelog(content, version, dryRun, changes, eol) {
  const unreleasedHeader = "## [未发布]";
  const start = content.indexOf(unreleasedHeader);
  if (start === -1) fail("CHANGELOG.md 缺少 `## [未发布]` 区块");

  const sectionStart = start + unreleasedHeader.length;
  const dividerIndex = content.indexOf("\n---\n", sectionStart);
  if (dividerIndex === -1) fail("CHANGELOG.md [未发布] 区块后缺少 `---` 分隔线");

  const unreleasedBody = content.slice(sectionStart, dividerIndex);
  const plannedIndex = unreleasedBody.search(/^### 计划中/m);
  const doneBody = (plannedIndex === -1 ? unreleasedBody : unreleasedBody.slice(0, plannedIndex)).trim();
  const plannedBody = plannedIndex === -1 ? "" : unreleasedBody.slice(plannedIndex).trim();

  if (!doneBody) {
    fail("CHANGELOG.md [未发布] 下没有已完成条目,请先补写本次改动再升版");
  }

  const newUnreleased = plannedBody ? `${unreleasedHeader}\n\n${plannedBody}\n` : `${unreleasedHeader}\n`;
  const versionSection = `## [${version}] - ${TODAY}\n\n${doneBody}\n`;
  const next =
    content.slice(0, start) +
    newUnreleased +
    "\n---\n\n" +
    versionSection +
    content.slice(dividerIndex + "\n---\n".length);

  writeText("CHANGELOG.md", next, eol, dryRun, changes);
  return next;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1) {
    fail("用法: npm run version -- patch|minor|major|x.y.z [--dry-run]");
  }

  const pkgFile = readText("package.json");
  const pkg = JSON.parse(pkgFile.text);
  const oldVersion = pkg.version;
  const newVersion = /^\d+\.\d+\.\d+$/.test(positional[0])
    ? positional[0]
    : nextVersion(oldVersion, positional[0]);
  if (newVersion === oldVersion) fail(`新版本与当前版本相同: ${oldVersion}`);

  console.log(`🚀 版本递增: v${oldVersion} → v${newVersion}${dryRun ? " (dry-run)" : ""}\n`);
  const changes = [];

  // 1. package.json
  pkg.version = newVersion;
  writeText("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "\n", dryRun, changes);

  // 2. src-tauri/Cargo.toml (首个 version 字段即 [package] 版本)
  const cargoToml = readText("src-tauri/Cargo.toml");
  const tomlNext = cargoToml.text.replace(/^version = "[^"]*"/m, `version = "${newVersion}"`);
  if (tomlNext === cargoToml.text) fail("Cargo.toml 未找到 version 字段");
  writeText("src-tauri/Cargo.toml", tomlNext, cargoToml.eol, dryRun, changes);

  // 3. src-tauri/Cargo.lock (starhub 包)
  const cargoLock = readText("src-tauri/Cargo.lock");
  const lockPattern = new RegExp(`(name = "starhub"\\nversion = ")${escapeRegExp(oldVersion)}(")`);
  const lockNext = cargoLock.text.replace(lockPattern, `$1${newVersion}$2`);
  if (lockNext === cargoLock.text) fail(`Cargo.lock 未找到 starhub v${oldVersion} 条目`);
  writeText("src-tauri/Cargo.lock", lockNext, cargoLock.eol, dryRun, changes);

  // 4. src-tauri/tauri.conf.json
  const tauriFile = readText("src-tauri/tauri.conf.json");
  const tauriConf = JSON.parse(tauriFile.text);
  tauriConf.version = newVersion;
  writeText("src-tauri/tauri.conf.json", `${JSON.stringify(tauriConf, null, 2)}\n`, "\n", dryRun, changes);

  // 5. CHANGELOG.md
  const changelog = readText("CHANGELOG.md");
  const changelogNext = releaseChangelog(changelog.text, newVersion, dryRun, changes, changelog.eol);

  // 6. AGENTS.md
  const agents = readText("AGENTS.md");
  const summary = firstSummary(changelogNext, newVersion);
  let agentsNext = agents.text.replace(
    /^\| 当前版本 \| v[^\n]*\|$/m,
    `| 当前版本 | v${newVersion}(${summary}) |`
  );
  agentsNext = agentsNext.replace(/^\*最后更新: [^\n]*\*$/m, `*最后更新: ${TODAY} (v${newVersion})*`);
  if (agentsNext === agents.text) fail("AGENTS.md 未找到「当前版本」或「最后更新」行");
  writeText("AGENTS.md", agentsNext, agents.eol, dryRun, changes);

  // 7. README.md
  const readme = readText("README.md");
  let readmeNext = readme.text.replace(/badge\/version-v[\d.]+-cyan/, `badge/version-v${newVersion}-cyan`);
  const anchor = "## 当前版本\n";
  const anchorIndex = readmeNext.indexOf(anchor);
  if (anchorIndex === -1) fail("README.md 未找到「## 当前版本」区");
  const insertAt = anchorIndex + anchor.length;
  const lines = readmeEntries(changelogNext, newVersion);
  const block = `\n### v${newVersion} (${TODAY})\n${lines.join("\n")}\n`;
  readmeNext = readmeNext.slice(0, insertAt) + block + readmeNext.slice(insertAt);
  writeText("README.md", readmeNext, readme.eol, dryRun, changes);

  console.log(`✅ 已${dryRun ? "检查" : "更新"}以下文件:`);
  for (const file of changes) console.log(`   - ${file}`);
  console.log(`\n下一步: git diff 检查 → commit → git tag v${newVersion} → git push origin main v${newVersion}`);
}

main();
