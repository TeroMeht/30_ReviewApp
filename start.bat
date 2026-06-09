@echo off
setlocal
set ROOT=%~dp0

echo Starting FastAPI Backend...
start "Backend" cmd /k "cd /d %ROOT%backend && python -m uvicorn main:app"

timeout /t 3 /nobreak >nul

echo Starting Next.js Frontend...
start "Frontend" cmd /k "cd /d %ROOT%frontend && npm start"

timeout /t 5 /nobreak >nul

echo Opening Browser...
start "" http://localhost:3000

endlocal