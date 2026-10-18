@echo off
title 共享歌词服务
cd /d "%~dp0"

if exist "%~dp0node.exe" goto runlocal

where node >nul 2>nul
if not errorlevel 1 goto runnode

echo.
echo 没有找到 Node.js。
echo 请先安装 Node.js 18 或更高版本：https://nodejs.org/
echo 或者把 node.exe 放到本文件夹里，再双击本文件。
echo.
pause
exit /b 1

:runlocal
"%~dp0node.exe" server.js
goto done

:runnode
node server.js

:done
echo.
echo 服务已停止，按任意键关闭窗口。
pause >nul
