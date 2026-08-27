@echo off
setlocal
cd /d "%~dp0"

echo === [1/4] Initializing upstream submodule ===
git submodule update --init --recursive || goto :fail

echo === [2/4] Installing dependencies (corepack yarn install --immutable) ===
call corepack yarn install --immutable || goto :fail

echo === [3/4] Building community-market and plugin-desktop ===
call corepack yarn build || goto :fail

echo === [4/4] Done ===
echo.
echo BUILD PASSED
exit /b 0

:fail
echo.
echo BUILD FAILED
exit /b 1
