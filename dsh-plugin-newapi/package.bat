@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo === [1/4] Checking dependencies ===
if not exist "node_modules\@esbuild" (
    echo node_modules missing, running npm install ...
    call npm install || goto :fail
)

echo === [2/4] Building dsh-plugin-newapi ===
call npm run build || goto :fail

echo === [3/4] Running tests (smoke / client-shape / login-flow / snapshot-cache) ===
call npm test || goto :fail
call node test\snapshot-cache.mjs || goto :fail

echo === [4/4] Packing install package (npm pack) ===
if not exist dist mkdir dist
for /f "delims=" %%i in ('node -p "require('./package.json').version"') do set VERSION=%%i
set TGZ=dist\dsh-plugin-newapi-%VERSION%.tgz
if exist "%TGZ%" del /q "%TGZ%"
rem Old artifacts from earlier versions only pile up; keep dist to the latest.
for %%f in (dist\dsh-plugin-newapi-*.tgz) do if /i not "%%f"=="%TGZ%" del /q "%%f"
call npm pack --pack-destination dist || goto :fail

if not exist "%TGZ%" (
    echo packed file not found: %TGZ%
    goto :fail
)

echo.
echo PACKAGE READY: %~dp0%TGZ%
echo.
echo Install it into the desktop profile with:
echo   corepack yarn workspace dsh-plugin-desktop exec dsh plugin --profile desktop add file:%~dp0%TGZ%
echo (pnpm may reuse a stale copy; evict first if reinstalling the same version:)
echo   rmdir /s /q "%%USERPROFILE%%\.dsh\profiles\desktop\node_modules\dsh-plugin-newapi"
exit /b 0

:fail
echo.
echo PACKAGING FAILED
exit /b 1
