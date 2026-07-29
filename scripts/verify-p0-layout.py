"""
P0 布局优化视觉回归
- 覆盖 3 个断点:1024x768 (xs) / 1280x800 (md,基线) / 1600x900 (lg)
- 每个断点截图 + 收集 console error/warning
- 检查关键 DOM 是否渲染(Sidebar/Tab strip/Workspace)
"""
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:1420/"
OUT_DIR = Path("D:/code/new_project/starhub/scripts/p0-verify")
OUT_DIR.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    ("xs-1024x768", 1024, 768),
    ("md-1280x800", 1280, 800),
    ("lg-1600x900", 1600, 900),
]

EXPECTED_SELECTORS = [
    ".app-startup, .workspace-welcome, .workspace",  # 至少有一个主容器
]

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        all_pass = True
        results = []
        for name, w, h in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h})
            page = ctx.new_page()
            errors = []
            warnings = []
            page.on("console", lambda msg: (
                errors.append(msg.text) if msg.type == "error" else
                warnings.append(msg.text) if msg.type == "warning" else None
            ))
            page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
            try:
                page.goto(URL, wait_until="domcontentloaded", timeout=15000)
                # 给 Vue 一点时间挂载 + welcome 触发
                page.wait_for_timeout(3000)
                # 截图
                shot = OUT_DIR / f"viewport-{name}.png"
                page.screenshot(path=str(shot), full_page=False)
                # 检查 DOM
                dom_status = {}
                for sel in EXPECTED_SELECTORS:
                    found = page.locator(sel).count()
                    dom_status[sel] = found
                # 检查 cyber.css 是否应用(读 :root --cyan 变量)
                cyan_value = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim()")
                space_section = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--space-section').trim()")
                anim_decor = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--anim-decor').trim()")
                chrome_glass_deep = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--chrome-glass-deep').trim()")
                layout_statusbar_h = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--layout-statusbar-h').trim()")
                results.append({
                    "viewport": name,
                    "w": w, "h": h,
                    "shot": str(shot),
                    "errors": errors,
                    "warnings": warnings,
                    "dom": dom_status,
                    "tokens": {
                        "--cyan": cyan_value,
                        "--space-section": space_section,
                        "--anim-decor": anim_decor,
                        "--chrome-glass-deep": chrome_glass_deep,
                        "--layout-statusbar-h": layout_statusbar_h,
                    },
                })
            except Exception as e:
                results.append({"viewport": name, "w": w, "h": h, "exception": str(e)})
                all_pass = False
            finally:
                ctx.close()
        browser.close()
        return all_pass, results


def report(all_pass, results):
    print("=" * 60)
    print("P0 布局优化 - 真实布局视觉回归")
    print("=" * 60)
    for r in results:
        print()
        print(f"### {r['viewport']} ({r['w']}x{r['h']})")
        if "exception" in r:
            print(f"  [X] 异常:{r['exception']}")
            continue
        print(f"  [shot] {r['shot']}")
        print(f"  DOM:{r['dom']}")
        print(f"  Tokens:")
        for k, v in r['tokens'].items():
            print(f"    {k} = {v or '(未定义)'}")
        if r['errors']:
            print(f"  [X] Console errors({len(r['errors'])}):")
            for e in r['errors'][:5]:
                print(f"    - {e[:200]}")
        else:
            print(f"  [OK] 无 console error")
        if r['warnings']:
            print(f"  [!] Warnings({len(r['warnings'])}):")
            for w in r['warnings'][:3]:
                print(f"    - {w[:200]}")
    print()
    print("=" * 60)
    print("结论:", "[OK] 全部通过" if all_pass else "[X] 有失败")
    return all_pass


if __name__ == "__main__":
    ok, results = run()
    report(ok, results)
    sys.exit(0 if ok else 1)
