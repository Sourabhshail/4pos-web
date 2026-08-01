@echo off
REM Publish 4POS website + Razorpay API for IIS.
REM Requires .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0

cd /d "%~dp0"

where dotnet >nul 2>&1
if errorlevel 1 (
  echo .NET SDK not found. Install .NET 8 SDK and try again.
  exit /b 1
)

set OUT=%~dp0publish
echo Publishing to %OUT% ...
dotnet publish "%~dp04pos-web.csproj" -c Release -o "%OUT%"
if errorlevel 1 exit /b 1

if exist "%~dp0razorpay.env" (
  copy /Y "%~dp0razorpay.env" "%OUT%\razorpay.env" >nul
  echo Copied razorpay.env into publish folder.
) else (
  echo WARNING: razorpay.env not found. Copy razorpay.env.example to publish\razorpay.env and add keys.
)

if not exist "%OUT%\logs" mkdir "%OUT%\logs"

REM Safety copy for root static assets (in case Content items were skipped).
if exist "%~dp0styles.css" copy /Y "%~dp0styles.css" "%OUT%\styles.css" >nul
if exist "%~dp0sitemap.xml" copy /Y "%~dp0sitemap.xml" "%OUT%\sitemap.xml" >nul
if exist "%~dp0robots.txt" copy /Y "%~dp0robots.txt" "%OUT%\robots.txt" >nul
if exist "%~dp0assets" xcopy /E /I /Y "%~dp0assets" "%OUT%\assets" >nul

if not exist "%OUT%\styles.css" (
  echo ERROR: styles.css missing from publish output — site will look unstyled.
  exit /b 1
)

echo.
echo Done. If you see HTTP 500.19 / 0x8007000d on IIS:
echo   Install ASP.NET Core 8 Hosting Bundle, then run iisreset.
echo   https://dotnet.microsoft.com/en-us/download/dotnet/thank-you/runtime-aspnetcore-8.0.17-windows-hosting-bundle-installer
echo.
echo In IIS:
echo   1. Point the site Physical Path to: %OUT%
echo   2. App Pool: No Managed Code
echo   3. Ensure %OUT%\logs exists and the app pool identity can write to it
echo   4. Recycle the app pool
echo.
