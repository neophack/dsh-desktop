@echo off
setlocal
cd /d "%~dp0"

echo === [1/3] Building dsh-plugin-newapi ===
pushd dsh-plugin-newapi
if not exist "node_modules\@esbuild" (
    echo node_modules missing, running npm install ...
    call npm install || goto :fail
)
call npm run build || goto :fail
popd

echo === [2/3] Installing dsh-plugin-newapi into the desktop profile ===
rem pnpm skips file: deps whose lockfile entry is unchanged, so evict the old
rem copy first to guarantee the freshly built bundle is copied in.
if exist "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-newapi" (
    rmdir /s /q "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-newapi"
)
call corepack yarn workspace dsh-plugin-desktop exec dsh plugin --profile desktop add file:E:/dsh-desktop/dsh-plugin-newapi || goto :fail

echo === [3/3] Starting dsh-plugin-desktop ===
call corepack yarn start || goto :fail

exit /b 0

:fail
echo.
echo RUN FAILED
exit /b 1
