@echo off
setlocal
cd /d "%~dp0"

rem Build the unsigned DSH Desktop Windows x64 installer (NSIS Setup.exe).
rem Usage:
rem   package-win.bat              full preflight gate + package + verify
rem   package-win.bat /skipcheck   skip the package preflight gate (faster,
rem                                use only right after a successful full run)

set SKIP_CHECK=
if /i "%~1"=="/skipcheck" set DSH_PACKAGE_CHECK_ALREADY_RAN=1&& set SKIP_CHECK=yes

echo === [1/4] Initializing upstream submodule ===
git submodule update --init --recursive || goto :fail

echo === [2/4] Installing dependencies (corepack yarn install --immutable) ===
call corepack yarn install --immutable || goto :fail

echo === [3/4] Packaging the Windows x64 installer ===
echo     ^(preflight gate: build + typecheck + package tests; this takes a while^)
if "%SKIP_CHECK%"=="yes" echo     ^(/skipcheck: preflight gate will be skipped^)
call corepack yarn workspace dsh-plugin-desktop dist:win || goto :fail

echo === [4/4] Done ===
echo.
for %%f in ("dsh-plugin-desktop\dist\DSH-Desktop-*-x64-Setup.exe") do echo INSTALLER: %~dp0%%f
echo.
echo PACKAGE PASSED
exit /b 0

:fail
echo.
echo PACKAGE FAILED
exit /b 1
