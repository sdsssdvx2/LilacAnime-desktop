@echo off
setlocal
chcp 65001 >nul
"%~dp0LilacCompanion.exe" sources menu
if errorlevel 1 (
  echo.
  echo Source manager failed. Press any key to close.
  pause >nul
)
endlocal
