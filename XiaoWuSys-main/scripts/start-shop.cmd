@echo off
rem Double-click to start XiaoMei ERP on a Windows shop computer (API :5000 + screens :3000).
rem Options are passed through, e.g.  start-shop.cmd -Demo   or   start-shop.cmd -Rebuild
title XiaoMei ERP (keep this window open)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-shop.ps1" %*
if errorlevel 1 pause
