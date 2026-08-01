@echo off
REM Run on the Windows IIS server to diagnose HTTP 500.19 / 0x8007000d.

echo === ASP.NET Core Module ===
reg query "HKLM\SOFTWARE\Microsoft\IIS Extensions\IIS AspNetCore Module V2" /ve 2>nul
if errorlevel 1 (
  echo MISSING: AspNetCoreModuleV2 is not installed.
  echo Download and install "ASP.NET Core 8.0 Hosting Bundle":
  echo   https://dotnet.microsoft.com/download/dotnet/8.0
  echo Then run: iisreset
) else (
  echo OK: AspNetCoreModuleV2 registry key found.
)

echo.
echo === dotnet runtime ===
where dotnet 2>nul
dotnet --list-runtimes 2>nul | findstr /i "Microsoft.AspNetCore.App 8."
if errorlevel 1 (
  echo WARNING: ASP.NET Core 8 runtime not listed. Hosting Bundle install may be incomplete.
)

echo.
echo === publish folder check ===
set SITE=C:\inetpub\wwwroot\4pos-Website\publish
if exist "%SITE%\4pos-web.dll" (
  echo OK: %SITE%\4pos-web.dll
) else (
  echo MISSING: %SITE%\4pos-web.dll — run publish-iis.cmd and deploy that output.
)
if exist "%SITE%\web.config" (
  echo OK: %SITE%\web.config
) else (
  echo MISSING: %SITE%\web.config
)
if exist "%SITE%\razorpay.env" (
  echo OK: %SITE%\razorpay.env
) else (
  echo WARNING: %SITE%\razorpay.env missing — payments will fail after site loads.
)
if not exist "%SITE%\logs" mkdir "%SITE%\logs" 2>nul
echo.
echo App pool must be: No Managed Code
echo Physical path must be the publish folder containing 4pos-web.dll
pause
