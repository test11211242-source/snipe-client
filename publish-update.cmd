@echo off
setlocal
where py.exe >nul 2>nul
if errorlevel 1 goto python
py.exe -3 "%~dp0pc-build-v2\scripts\publish_update.py" %*
exit /b %errorlevel%
:python
python.exe "%~dp0pc-build-v2\scripts\publish_update.py" %*
exit /b %errorlevel%
