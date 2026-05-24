@echo off
setlocal enabledelayedexpansion

pushd "%TEMP%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" 1>nul
if errorlevel 1 ( echo VCVARS_FAILED & popd & exit /b 10 )
popd
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\Installer;%PATH%"

cd /d "C:\nexus-overlay-build"

if not exist build (
    cmake -S . -B build -G "Visual Studio 17 2022" -A x64
    if errorlevel 1 ( echo CMAKE_CONFIG_FAILED & exit /b 12 )
)
cmake --build build --config Release --parallel
if errorlevel 1 ( echo CMAKE_BUILD_FAILED & exit /b 13 )

echo === BUILD OK ===
dir /b build\dist\
exit /b 0
