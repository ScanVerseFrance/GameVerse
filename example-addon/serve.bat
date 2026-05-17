@echo off
cd /d %~dp0
echo.
echo  Nexus example addon
echo  -------------------
echo  Serving at: http://localhost:8000
echo  Manifest:   http://localhost:8000/manifest.json
echo.
echo  Press Ctrl+C to stop.
echo.
python -m http.server 8000
