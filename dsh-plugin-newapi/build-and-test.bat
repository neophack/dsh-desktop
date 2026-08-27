@echo off
setlocal
cd /d "%~dp0"

echo === [1/3] Checking dependencies ===
if not exist "node_modules\@esbuild" (
    echo node_modules missing, running npm install ...
    call npm install || goto :fail
)

echo === [2/3] Building dsh-plugin-newapi ===
call npm run build || goto :fail

echo === [3/3] Running tests (smoke / client-shape / login-flow) ===
call npm test || goto :fail

echo.
echo BUILD AND TESTS PASSED
exit /b 0

:fail
echo.
echo BUILD OR TESTS FAILED
exit /b 1
