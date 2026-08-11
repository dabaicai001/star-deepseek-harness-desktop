@echo off
rem cargo check / test 便捷入口:先加载 MSVC 环境(vcvars64),再在 src-tauri 下跑 cargo。
rem
rem 解决 Git Bash 里直接 `cargo check` 报 "failed to find tool cl.exe" 的问题
rem (ring / aws-lc-sys / libsqlite3-sys 等 C 依赖需要 MSVC 工具链)。
rem
rem vcvars64.bat 路径取用户环境变量 STARHUB_VCVARS(新机器上 setx 一次即可),
rem 未设置时回退到本机默认 D:\c++1 的安装位置。
rem
rem 用法:
rem   scripts\cargo-env.bat check
rem   scripts\cargo-env.bat test
rem   scripts\cargo-env.bat build --release

if "%STARHUB_VCVARS%"=="" set "STARHUB_VCVARS=D:\c++1\VC\Auxiliary\Build\vcvars64.bat"
call "%STARHUB_VCVARS%" >nul 2>&1
cd /d "%~dp0..\src-tauri"
cargo %*
