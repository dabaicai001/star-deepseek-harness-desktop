"""
本地工作区(LocalView)重设计视觉回归
- 基线 1280x800
- 场景 A(暗/浅):无 Tauri IPC,验证空态 / 错误条 / 状态栏布局("Load directory failed"
  是 loadDirectory 的预期 console.error,非页面异常,过滤)
- 场景 B(暗色):addInitScript 注入 window.__TAURI_INTERNALS__.invoke mock,
  让目录树 / 文件列表 / 编辑器 tab / 面包屑 / 状态栏统计全部真实渲染
- 预置 app-v2 tab + startPage=restore,直达 /local/:id 路由
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:1420"
OUT_DIR = Path("D:/code/new_project/starhub/scripts/local-verify")
OUT_DIR.mkdir(parents=True, exist_ok=True)

SEED = """
(localStorage.setItem('app-v2', JSON.stringify({
  tabs: [{ id: 'local-test', assetId: 'asset-local-test', title: 'local-test', type: 'local' }],
  activeTab: 'local-test',
  sidebarOpen: true
})), localStorage.setItem('starhub.settings.general', JSON.stringify({ startPage: 'restore' })),
localStorage.setItem('theme-v2', JSON.stringify({ theme: '%s' })))
"""

# 仅覆盖 LocalView 用到的 local_* command;其余 command 一律 reject,
# 与浏览器无 IPC 时的 reject 路径一致,走调用方既有 catch。
MOCK_TAURI = """
window.__TAURI_INTERNALS__ = {
  metadata: {},
  transformCallback: () => 0,
  invoke: async (cmd, args) => {
    const list = (p) => {
      const base = (p || 'C:/Users/demo').replace(/\\\\/g, '/').replace(/\\/+$/, '');
      const ts = 1780000000;
      return [
        { name: 'docs', path: base + '/docs', kind: 'directory', size: 0, modified_at: ts },
        { name: 'src', path: base + '/src', kind: 'directory', size: 0, modified_at: ts + 3600 },
        { name: 'README.md', path: base + '/README.md', kind: 'file', size: 2048, modified_at: ts + 7200 },
        { name: 'package.json', path: base + '/package.json', kind: 'file', size: 1024, modified_at: ts + 10800 },
      ];
    };
    if (cmd === 'local_system_info') return { home_dir: 'C:/Users/demo' };
    if (cmd === 'local_list_directory') return list(args && args.path);
    if (cmd === 'local_read_text_file') return { content: '# StarHub\\n\\n本地工作区重设计预览。\\n\\n- 目录树\\n- 文件列表\\n- 编辑器 tab\\n' };
    if (cmd === 'local_write_text_file') return null;
    throw new Error('mock: unhandled ' + cmd);
  }
};
"""

# 预期的应用层日志(非页面运行时异常)
ERROR_WHITELIST = ("Load directory failed", "mock: unhandled")

EXPECTED = [
    ".local-view",
    ".local-sidebar",
    ".local-side-head",
    ".local-statusbar",
    ".local-breadcrumb",
]


def filtered(errors):
    return [e for e in errors if not any(w in e for w in ERROR_WHITELIST)]


def check_page(page, shot_path, label, results):
    page.screenshot(path=str(shot_path), full_page=False)
    dom = {sel: page.locator(sel).count() for sel in EXPECTED}
    cyan = page.evaluate(
        "getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim()")
    results.append({"label": label, "shot": str(shot_path), "dom": dom, "cyan": cyan})
    return all(v > 0 for v in dom.values())


def run():
    all_pass = True
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---- 场景 A:空态(无 IPC)暗 / 浅 ----
        for theme in ("darkTheme", "lightTheme"):
            ctx = browser.new_context(viewport={"width": 1280, "height": 800})
            ctx.add_init_script(SEED % theme)
            page = ctx.new_page()
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            try:
                page.goto(f"{BASE}/local/local-test", wait_until="domcontentloaded", timeout=15000)
                page.wait_for_timeout(3000)
                ok = check_page(page, OUT_DIR / f"local-{theme}.png", f"A 空态 {theme}", results)
                ok = ok and page.locator(".empty-state").count() >= 1
                all_pass = all_pass and ok and not filtered(errors)
                results[-1]["errors"] = filtered(errors)
            except Exception as e:
                results.append({"label": f"A {theme}", "exception": str(e)})
                all_pass = False
            finally:
                ctx.close()

        # ---- 场景 B:mock IPC,数据态(暗色) ----
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        ctx.add_init_script(SEED % "darkTheme")
        ctx.add_init_script(MOCK_TAURI)
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        try:
            page.goto(f"{BASE}/local/local-test", wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(3000)
            # B1:目录树 + 文件列表 + 状态栏统计
            ok = check_page(page, OUT_DIR / "local-data-filelist.png", "B1 文件列表", results)
            ok = ok and page.locator(".local-tree-row").count() >= 4
            ok = ok and page.locator(".local-file-row").count() >= 4
            # B2:点开树里的 README.md → 编辑器 tab + 面包屑;输入触发 dirty
            page.locator(".local-tree-row", has_text="README.md").first.click()
            page.wait_for_timeout(800)
            page.locator(".local-editor-textarea").click()
            page.keyboard.type("x")
            page.wait_for_timeout(400)
            ok2 = check_page(page, OUT_DIR / "local-data-editor.png", "B2 编辑器 dirty", results)
            ok2 = ok2 and page.locator(".local-editor-tab").count() == 1
            ok2 = ok2 and page.locator(".local-tab-dirty").count() == 1
            ok2 = ok2 and page.locator(".local-tab-save").count() == 1
            # B3:展开 src 目录 → 缩进参考线层
            page.locator(".local-tree-row", has_text="src").first.click()
            page.wait_for_timeout(800)
            ok3 = check_page(page, OUT_DIR / "local-data-tree-expanded.png", "B3 树展开", results)
            ok3 = ok3 and page.locator(".local-tree-children").count() >= 1
            all_pass = all_pass and ok and ok2 and ok3 and not filtered(errors)
            for r in results[-3:]:
                r["errors"] = filtered(errors)
        except Exception as e:
            results.append({"label": "B mock", "exception": str(e)})
            all_pass = False
        finally:
            ctx.close()
        browser.close()
    return all_pass, results


def report(all_pass, results):
    print("=" * 60)
    print("LocalView 重设计 - 视觉回归 (1280x800)")
    print("=" * 60)
    for r in results:
        print()
        print(f"### {r['label']}")
        if "exception" in r:
            print(f"  [X] 异常:{r['exception']}")
            continue
        print(f"  [shot] {r['shot']}")
        print(f"  DOM:{r['dom']}")
        print(f"  --cyan = {r['cyan'] or '(未定义)'}")
        errs = r.get("errors", [])
        if errs:
            print(f"  [X] Console errors({len(errs)}):")
            for e in errs[:5]:
                print(f"    - {e[:200]}")
        else:
            print("  [OK] 无预期外 console error")
    print()
    print("=" * 60)
    print("结论:", "[OK] 全部通过" if all_pass else "[X] 有失败")
    return all_pass


if __name__ == "__main__":
    ok, results = run()
    report(ok, results)
    sys.exit(0 if ok else 1)
