@echo off
title 共享歌词服务
cd /d "%~dp0"
if exist "%~dp0node.exe" goto runlocal
where node >nul 2>nul
if errorlevel 1 goto nonode
node server.js
goto done
:runlocal
"%~dp0node.exe" server.js
goto done
:nonode
echo.
echo 没有找到 Node.js。
echo 请安装 Node.js（https://nodejs.org/），或把 node.exe 放到本文件夹里。
echo.
pause
exit /b 1
:done
echo.
echo 服务已停止，按任意键关闭窗口。
pause >nul
