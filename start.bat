@echo off
setlocal
set ROOT=%~dp0
set VENV=%ROOT%backend\.venv

if not exist "%VENV%\Scripts\activate.bat" (
    echo No venv found at %VENV% - creating it with uv sync...
    pushd "%ROOT%backend"
    uv sync || (echo uv sync failed & popd & pause & exit /b 1)
    popd
)

echo Starting FastAPI Backend...
start "Backend" cmd /k "cd /d %ROOT%backend && call "%VENV%\Scripts\activate.bat" && python -m uvicorn main:app"

timeout /t 3 /nobreak >nul

echo Starting Next.js Frontend...
start "Frontend" cmd /k "cd /d %ROOT%frontend && npm run build && npm start -- -p 3000"

timeout /t 5 /nobreak >nul

echo Opening Browser...
start "" http://localhost:3000

endlocal
