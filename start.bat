@echo off
REM ============================================================================
REM  30_ReviewApp launcher — opens backend and frontend in separate windows.
REM
REM  Backend:  uvicorn main:app --reload  (port 8000)
REM  Frontend: npm run dev                (port 3000)
REM
REM  Each service runs in its own cmd window so you can read logs and Ctrl+C
REM  them independently. Close the launched windows to stop the services.
REM
REM  IBKR / TWS does NOT need to be running for the backend to boot — the
REM  connection is established on demand when you click "Update Market Data"
REM  in the data-management UI.
REM
REM  Python detection (in priority order):
REM    1. uv         — if `uv` is on PATH, runs `uv run uvicorn ...`
REM    2. .venv      — if backend\.venv\Scripts\python.exe exists, uses it
REM    3. python     — falls back to plain `python -m uvicorn ...`
REM ============================================================================

REM Anchor every path off this file's own folder so the script works no
REM matter where it's invoked from.
set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"

if not exist "%BACKEND%\main.py" (
    echo [start.bat] ERROR: backend not found at "%BACKEND%"
    echo Place start.bat at the repo root next to the backend\ and frontend\ folders.
    pause
    exit /b 1
)
if not exist "%FRONTEND%\package.json" (
    echo [start.bat] ERROR: frontend not found at "%FRONTEND%"
    pause
    exit /b 1
)

REM ─── Pick how to launch the backend ─────────────────────────────────────────
REM Using labels rather than nested if/else because %ERRORLEVEL% inside a
REM parenthesised block expands at parse time, not at runtime.
where uv >nul 2>&1
if not errorlevel 1 goto :use_uv

if exist "%BACKEND%\.venv\Scripts\python.exe" goto :use_venv

where python >nul 2>&1
if not errorlevel 1 goto :use_python

echo [start.bat] ERROR: could not find `uv`, a local .venv, or `python` on PATH.
echo Install one of:
echo   - uv             ^(https://docs.astral.sh/uv/^)
echo   - or create a venv in backend\.venv with the project deps installed
echo   - or ensure `python` is on PATH and has uvicorn + the project deps
pause
exit /b 1

:use_uv
set "BACKEND_CMD=uv run uvicorn main:app --reload"
set "BACKEND_LABEL=uv"
goto :launch

:use_venv
set "BACKEND_CMD=.venv\Scripts\python.exe -m uvicorn main:app --reload"
set "BACKEND_LABEL=.venv python"
goto :launch

:use_python
set "BACKEND_CMD=python -m uvicorn main:app --reload"
set "BACKEND_LABEL=system python"
goto :launch

:launch
echo [start.bat] Launching backend  ^(%BACKEND_LABEL%, uvicorn :8000^)...
start "30_ReviewApp backend"  cmd /k "cd /d "%BACKEND%"  && %BACKEND_CMD%"

REM Tiny stagger so the two cmd windows don't fight over the same console
REM during the very first millisecond and end up on top of each other.
timeout /t 1 /nobreak >nul

echo [start.bat] Launching frontend ^(next dev :3000^)...
start "30_ReviewApp frontend" cmd /k "cd /d "%FRONTEND%" && npm run dev"

echo.
echo [start.bat] Both services are starting in their own windows.
echo   Backend:  http://127.0.0.1:8000   ^(docs at /docs^)
echo   Frontend: http://localhost:3000
echo.
echo Close the two cmd windows to stop the services.
