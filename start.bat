@echo off
setlocal EnableExtensions
title StoryRealm v3.1.0

set "APP_DIR=%~dp0"
set "LLAMA_DIR=%APP_DIR%runtime\llama-cpp"
set "MODEL=%APP_DIR%models\model.gguf"
if exist "%APP_DIR%start.local.bat" call "%APP_DIR%start.local.bat"
if not defined LLAMA_CTX set "LLAMA_CTX=12288"
set "LLAMA_EXE=%LLAMA_DIR%\llama-server.exe"
set "LLAMA_URL=http://127.0.0.1:8080/health"
set "WEB_URL=http://127.0.0.1:5173"

echo ========================================
echo   StoryRealm v3.1.0 - Start All
echo ========================================
echo.

if not exist "%LLAMA_EXE%" goto missing_llama
if not exist "%MODEL%" goto missing_model

echo [1/3] Checking llama.cpp...
curl -s -m 2 "%LLAMA_URL%" >nul 2>&1
if not errorlevel 1 goto llama_ready
echo       Starting llama.cpp. First load may take a few minutes...
start "llama.cpp server" /D "%LLAMA_DIR%" "%LLAMA_EXE%" -m "%MODEL%" -c %LLAMA_CTX% -ngl 99 --jinja --reasoning off --reasoning-budget 0 --host 127.0.0.1 --port 8080
:llama_ready
echo       llama.cpp is ready or still loading.

echo [2/3] Checking web server...
curl -s -m 2 "%WEB_URL%/api/workspace" >nul 2>&1
if not errorlevel 1 goto web_ready
curl -s -m 2 "%WEB_URL%/" >nul 2>&1
if not errorlevel 1 goto old_web_server
echo       Starting StoryRealm web server with local persistence...
start "StoryRealm web server" /D "%APP_DIR%" "%ComSpec%" /k python "%APP_DIR%server.py" --port 5173 --bind 127.0.0.1

echo [3/3] Waiting for web server...
set /a WEB_TRIES=0
:wait_web
curl -s -m 2 "%WEB_URL%/" >nul 2>&1
if not errorlevel 1 goto web_ready
set /a WEB_TRIES+=1
if %WEB_TRIES% GEQ 15 goto web_timeout
timeout /t 1 /nobreak >nul
goto wait_web

:web_ready
echo       Web server is ready.
start "" "%WEB_URL%"
echo.
echo Platform: %WEB_URL%
echo Model:    http://127.0.0.1:8080
echo.
echo Services are running in separate windows.
echo Close those windows to stop the services.
echo.
pause
exit /b 0

:old_web_server
echo [WARNING] Port 5173 is occupied by an older web server without file persistence.
echo           Close that server window and run start.bat again.
start "" "%WEB_URL%"
pause
exit /b 1

:web_timeout
echo [WARNING] Web server did not respond. Check that Python is installed.
start "" "%WEB_URL%"
pause
exit /b 1

:missing_llama
echo [ERROR] llama-server.exe was not found:
echo %LLAMA_EXE%
echo Copy start.local.example.bat to start.local.bat and set LLAMA_DIR.
pause
exit /b 1

:missing_model
echo [ERROR] Model file was not found:
echo %MODEL%
echo Copy start.local.example.bat to start.local.bat and set MODEL.
pause
exit /b 1

