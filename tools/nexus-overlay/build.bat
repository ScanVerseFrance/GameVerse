@echo off
REM ============================================================
REM   nexus-overlay one-shot build (DUAL BITNESS)
REM
REM   Configures + builds the hook DLL + injector for BOTH x64
REM   and x86. We need both because LoadLibraryW refuses cross-
REM   bitness module loads — a 64-bit DLL can't be injected into
REM   a 32-bit game (LEGO série, jeux pré-2014) and vice-versa.
REM
REM   Output structure :
REM     build/dist/x64/nexus-overlay.dll
REM     build/dist/x64/nexus-overlay-injector.exe
REM     build/dist/x86/nexus-overlay.dll
REM     build/dist/x86/nexus-overlay-injector.exe
REM
REM   Internal build dirs (per arch, isolated CMake state) :
REM     build-x64/   →  build/dist/x64/  (copié à la fin)
REM     build-x86/   →  build/dist/x86/
REM
REM   Usage :
REM     build.bat            (Release, both x64 + x86)
REM     build.bat Debug      (Debug, both)
REM     build.bat x64        (Release, x64 only — itération rapide)
REM     build.bat x86        (Release, x86 only)
REM     build.bat clean      (wipe build*/ and re-config)
REM
REM   Prérequis :
REM     - VS Build Tools 2022 + C++ workload + Windows SDK
REM     - (optionnel) Vulkan SDK pour le backend Vulkan
REM ============================================================

setlocal enabledelayedexpansion

set CONFIG=Release
set ARCHS=x64 x86
if /i "%1"=="Debug" set CONFIG=Debug
if /i "%1"=="x64"   set ARCHS=x64
if /i "%1"=="x86"   set ARCHS=x86
if /i "%2"=="x64"   set ARCHS=x64
if /i "%2"=="x86"   set ARCHS=x86
if /i "%1"=="clean" goto :clean

REM Source MSVC env — vcvars64 sets up BOTH x64 and x86 toolchains
REM in the same shell, so on peut bouger entre les deux via -A x64 /
REM -A Win32 sans re-source quoi que ce soit. On call vcvars depuis
REM %TEMP% pour éviter que les parenthèses dans le path projet
REM (ex. SVU-(ScanVerseUnivers)) cassent le parsing IF EXIST du script.
pushd "%TEMP%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" 1>nul
if errorlevel 1 (
    echo ERROR: vcvars64 failed. VS Build Tools 2022 installes ?
    popd
    exit /b 1
)
popd

REM Ajout de vswhere au PATH (CMake l'appelle en interne pour piger
REM la version VS — sans, CMake erreur en silence sur "vswhere unknown").
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\Installer;%PATH%"

cd /d "%~dp0"

REM Make sure the unified dist root exists. We mirror per-arch
REM artifacts here at the end of each successful build.
if not exist build mkdir build
if not exist build\dist mkdir build\dist

for %%A in (%ARCHS%) do (
    set ARCH=%%A
    if /i "!ARCH!"=="x64" (
        set CMAKE_PLATFORM=x64
    ) else (
        set CMAKE_PLATFORM=Win32
    )
    set BUILD_DIR=build-!ARCH!
    set DIST_DIR=build\dist\!ARCH!

    echo.
    echo ============================================================
    echo   Building nexus-overlay : !ARCH! / %CONFIG%
    echo ============================================================
    if not exist !BUILD_DIR! (
        echo Configuring CMake ^(Visual Studio 17 2022, !CMAKE_PLATFORM!^) ...
        cmake -S . -B !BUILD_DIR! -G "Visual Studio 17 2022" -A !CMAKE_PLATFORM! ^
            -DCMAKE_CONFIGURATION_TYPES=Debug;Release
        if errorlevel 1 (
            echo ERROR: CMake configure failed for !ARCH!.
            exit /b 2
        )
    )

    echo Building !ARCH! %CONFIG% ...
    cmake --build !BUILD_DIR! --config %CONFIG% --parallel
    if errorlevel 1 (
        echo ERROR: build failed for !ARCH!.
        exit /b 3
    )

    REM Mirror per-arch artifacts into the unified dist tree. CMake
    REM already wrote them to !BUILD_DIR!/dist/ via the dist target;
    REM on les copie sous build/dist/<arch>/ pour qu'Electron y trouve
    REM le bon couple en runtime (resolveOverlayPaths choisit selon
    REM le PE header du jeu).
    if not exist !DIST_DIR! mkdir !DIST_DIR!
    copy /Y "!BUILD_DIR!\dist\nexus-overlay.dll" "!DIST_DIR!\" 1>nul
    if errorlevel 1 (
        echo ERROR: copy DLL !ARCH! failed.
        exit /b 4
    )
    copy /Y "!BUILD_DIR!\dist\nexus-overlay-injector.exe" "!DIST_DIR!\" 1>nul
    if errorlevel 1 (
        echo ERROR: copy injector !ARCH! failed.
        exit /b 4
    )
)

echo.
echo ============================================================
echo   Build OK :
for %%A in (%ARCHS%) do (
    echo     build\dist\%%A\nexus-overlay.dll
    echo     build\dist\%%A\nexus-overlay-injector.exe
)
echo ============================================================
exit /b 0

:clean
echo Wiping build dirs ...
if exist build      rmdir /s /q build
if exist build-x64  rmdir /s /q build-x64
if exist build-x86  rmdir /s /q build-x86
echo Done. Run build.bat again to re-configure.
exit /b 0
