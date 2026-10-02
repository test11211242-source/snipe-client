@echo off
call "%~dp0..\publish-update.cmd" %*
exit /b %errorlevel%
