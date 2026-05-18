/**
 * Nexus Launcher Setup — custom Electron installer.
 *
 * A separate mini-Electron app whose only job is to deploy the actual
 * Nexus Launcher desktop app onto the user's machine. We ship our own
 * wizard instead of the default NSIS one so the install flow uses the
 * same design tokens as the launcher (dark + cyan/green accents, Syne
 * typeface, frameless window) — no jarring Win32 controls in the
 * middle of an otherwise polished install.
 *
 * Pattern is lifted from ScanVerse Webview's installer — same two-stage
 * build: a portable .exe wrapping the wizard, with the actual app
 * packaged as a `payload` directory in extraResources.
 *
 * Bundle layout when packed:
 *   process.resourcesPath/
 *     ├── app.asar              ← this installer's main+preload+ui
 *     └── payload/              ← the actual Nexus Launcher app bytes
 *         └── (win-unpacked/)
 *
 * On install:
 *   1. User picks an install path (default %LOCALAPPDATA%\Programs\Nexus Launcher).
 *   2. We copy `payload/` into that path.
 *   3. We register an uninstall key in HKCU so Apps & features lists it.
 *   4. We create Start Menu + Desktop shortcuts via PowerShell.
 *   5. Optionally launch the app and quit the installer.
 *
 * --silent mode: the running launcher spawns
 *   Nexus-Launcher-Setup-X.Y.Z.exe --silent --install-path <existing-dir>
 * when applying an auto-update. The wizard UI is skipped entirely —
 * we kill the running launcher, overwrite the install in place, refresh
 * the uninstall registry entry, and relaunch.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
// `original-fs` is Electron's unpatched fs. Regular `fs` treats `.asar`
// files as directories (so you can require() into them) — that's
// disastrous when you want to copy them byte-for-byte during install:
// readdir() walks into the archive's virtual contents and copyFile()
// chokes with ENOENT on entries that don't really exist on disk.
// We use ofs strictly for the payload copy where asar archives appear.
const ofs  = require('original-fs');
const ofsp = ofs.promises;
const { spawn, execFile } = require('child_process');
const os = require('os');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.svu.nexuslauncher.installer');
}

// ── Silent mode detection ────────────────────────────────────────────────────
function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return null;
}
const IS_SILENT = process.argv.includes('--silent');
const SILENT_INSTALL_PATH = getArg('install-path');

// Single-instance lock — don't let two installer windows run at once.
// Silent mode skips the lock; the caller already quit and we may briefly
// overlap during update self-extract.
const lock = IS_SILENT ? true : app.requestSingleInstanceLock();
if (!lock) { app.quit(); }

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// ── Paths ────────────────────────────────────────────────────────────────────
// In dev (electron .) the payload sits next to this script under ./payload.
// In packed builds electron-builder unpacks it under resourcesPath/payload.
function resolvePayloadPath() {
  const packed = path.join(process.resourcesPath || '', 'payload');
  if (fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, 'payload');
  if (fs.existsSync(dev)) return dev;
  return null;
}

const DEFAULT_INSTALL_DIR = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'Programs', 'Nexus Launcher',
);

// Branding strings — kept in one place so a rename later (e.g. cobranded
// edition) is a one-line change rather than a grep-replace.
const APP_NAME       = 'Nexus Launcher';
const APP_EXE        = 'Nexus Launcher.exe';
const APP_PUBLISHER  = 'SVU';
const APP_REG_KEY    = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NexusLauncher';
const APP_SHORTCUT   = `${APP_NAME}.lnk`;
// The launcher's AppUserModelID — MUST match the value passed to
// app.setAppUserModelId() in electron/services/native-notif.service.ts.
// Without it stamped on the Start-Menu shortcut Windows silently drops
// every Notification.show() call from the running launcher.
const APP_AUMID      = 'com.svu.nexuslauncher';

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 540,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: true,
    backgroundColor: '#0b1622',
    title: `Installation de ${APP_NAME}`,
    icon: ICON_PATH,
    autoHideMenuBar: true,
    frame: false,                  // we paint our own titlebar in HTML
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (process.env.NEXUS_INSTALLER_DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

if (IS_SILENT) {
  app.whenReady().then(runSilentInstall);
} else {
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => app.quit());

// ── Silent install path ──────────────────────────────────────────────────────
// Headless update — invoked by the running launcher via:
//   spawn(setupExe, ['--silent', '--install-path', <existingDir>])
// Steps:
//   1. Wait a beat for the caller's process to die so file locks release.
//   2. taskkill any leftover Nexus Launcher.exe just in case.
//   3. Overwrite-copy the payload over the existing install (we DON'T
//      clean the dir — orphan files from old versions linger, which is
//      acceptable in v1 and avoids nuking user data placed alongside).
//   4. Re-write the uninstaller + uninstall registry key with the new
//      version string.
//   5. Launch the new launcher and quit.
//
// All of this runs without UI. Errors go to %TEMP%/nexus-installer.log
// where the user can find them if something breaks mid-update.
async function runSilentInstall() {
  const installPath = SILENT_INSTALL_PATH || DEFAULT_INSTALL_DIR;
  const logPath = path.join(os.tmpdir(), 'nexus-installer.log');
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] [silent] ${msg}\n`;
    return fsp.appendFile(logPath, line).catch(() => {});
  };

  await log(`Start. installPath=${installPath} pid=${process.pid}`);
  try {
    // 1. Let the caller's process clean up (file handles release).
    await sleep(2000);

    // 2. Force-kill any stale launcher process (caller should have quit
    //    already, but if it crashed mid-quit we need files unlocked).
    await new Promise((resolve) => {
      execFile(
        'taskkill',
        ['/IM', APP_EXE, '/F', '/T'],
        { windowsHide: true },
        () => resolve(),
      );
    });
    await sleep(800);

    const payload = resolvePayloadPath();
    if (!payload) {
      await log('ABORT: payload not found');
      app.quit();
      return;
    }

    // 3. Overwrite-copy the payload. We deliberately skip ensureCleanDir —
    //    in update mode we preserve any user-side files in the install
    //    dir (caches, custom plugins, etc.) and just replace binaries.
    await ofsp.mkdir(installPath, { recursive: true });
    await copyDir(payload, installPath, () => {});
    await log(`Copy done`);

    // 4. Refresh uninstaller + registry with the new version.
    await writeUninstaller(installPath);
    const exePath = path.join(installPath, APP_EXE);
    await registerUninstall(installPath, exePath);
    await log(`Registry refreshed`);

    // 5. Launch the new app, detached.
    if (fs.existsSync(exePath)) {
      spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
      await log(`Launched ${exePath}`);
    } else {
      await log(`ERROR: ${exePath} missing after copy`);
    }
  } catch (err) {
    await log(`FAIL: ${err && (err.stack || err.message || err)}`);
  } finally {
    // Give the spawned launcher a moment to take over before we exit.
    setTimeout(() => app.quit(), 500);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── IPC ──────────────────────────────────────────────────────────────────────
// Renderer asks for default path / picks a folder / kicks off install.

ipcMain.handle('installer:default-path', () => DEFAULT_INSTALL_DIR);

ipcMain.handle('installer:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: `Choisir le dossier d'installation`,
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: DEFAULT_INSTALL_DIR,
  });
  if (r.canceled || !r.filePaths[0]) return null;
  // Always append "Nexus Launcher" so the user doesn't accidentally
  // install into a populated directory. Skip the append if the leaf
  // already is it.
  let target = r.filePaths[0];
  if (path.basename(target).toLowerCase() !== APP_NAME.toLowerCase()) {
    target = path.join(target, APP_NAME);
  }
  return target;
});

ipcMain.handle('installer:install', async (_event, opts = {}) => {
  const installPath = String(opts.installPath || DEFAULT_INSTALL_DIR);
  const createDesktop   = opts.createDesktop !== false;
  const createStartMenu = opts.createStartMenu !== false;
  const launchAfter     = opts.launchAfter !== false;

  const payload = resolvePayloadPath();
  if (!payload) {
    return { ok: false, error: 'payload introuvable (build incomplet ?)' };
  }

  try {
    // 1. Copy the payload into the install path.
    await ensureCleanDir(installPath);
    await copyDir(payload, installPath, (cur, total) => {
      win.webContents.send('installer:progress', {
        phase: 'copy', cur, total,
      });
    });

    const exePath = path.join(installPath, APP_EXE);
    if (!fs.existsSync(exePath)) {
      return { ok: false, error: `${APP_EXE} manquant dans ${installPath}` };
    }

    // 2. Drop a small Uninstall.cmd that wipes the install folder + registry.
    await writeUninstaller(installPath);

    // 3. Register in Apps & features (HKCU so we don't need admin).
    win.webContents.send('installer:progress', { phase: 'registry' });
    await registerUninstall(installPath, exePath);

    // 4. Shortcuts.
    win.webContents.send('installer:progress', { phase: 'shortcuts' });
    if (createStartMenu) {
      const smPath = path.join(
        process.env.APPDATA || os.homedir(),
        'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_SHORTCUT,
      );
      await createShortcut({ target: exePath, location: smPath });
      // Critical for Win10/11 toasts — the .lnk needs the AUMID
      // stamped on it before Notification.show() will actually pop
      // a toast from the running launcher process.
      await setShortcutAumid(smPath, APP_AUMID);
    }
    if (createDesktop) {
      const dtPath = path.join(os.homedir(), 'Desktop', APP_SHORTCUT);
      await createShortcut({ target: exePath, location: dtPath });
      await setShortcutAumid(dtPath, APP_AUMID);
    }

    // 5. Launch (optional) + quit installer.
    if (launchAfter) {
      spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
    }

    return { ok: true, installPath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.on('installer:close',    () => app.quit());
ipcMain.on('installer:minimize', () => win?.minimize());
ipcMain.on('installer:open-url', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureCleanDir(dir) {
  await ofsp.mkdir(dir, { recursive: true });
  // If the dir already has files (re-install over previous version),
  // wipe them — safer than merging since old versions may have stale
  // files. Use ofs in case the install dir somehow contains an asar.
  const existing = await ofsp.readdir(dir);
  for (const name of existing) {
    await ofsp.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

async function copyDir(src, dst, onProgress) {
  // Two passes: count files for an accurate progress bar, then copy.
  // ALL fs ops go through original-fs because the source tree contains
  // `resources/app.asar` (the main launcher bundled as an asar), and
  // patched fs would walk *into* that archive and try to copy its
  // virtual contents as if they were on disk. ofs treats it as a single
  // file blob — which is exactly what we want.
  let total = 0;
  let cur   = 0;
  async function count(p) {
    const entries = await ofsp.readdir(p, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) await count(full);
      else total++;
    }
  }
  await count(src);
  if (onProgress) onProgress(0, total);

  async function walk(srcDir, dstDir) {
    await ofsp.mkdir(dstDir, { recursive: true });
    const entries = await ofsp.readdir(srcDir, { withFileTypes: true });
    for (const e of entries) {
      const sFull = path.join(srcDir, e.name);
      const dFull = path.join(dstDir, e.name);
      if (e.isDirectory()) {
        await walk(sFull, dFull);
      } else {
        await ofsp.copyFile(sFull, dFull);
        cur++;
        if (onProgress && (cur % 8 === 0 || cur === total)) {
          onProgress(cur, total);
        }
      }
    }
  }
  await walk(src, dst);
}

async function writeUninstaller(installPath) {
  // Minimal .cmd uninstaller — kills the running launcher then removes
  // the install dir + registry key + shortcuts. Not pretty but reliable
  // and zero deps. Apps & features calls this via UninstallString.
  const cmd = `@echo off
chcp 65001 > nul
echo Désinstallation de Nexus Launcher en cours...
taskkill /IM "${APP_EXE}" /F > nul 2>&1
timeout /t 1 /nobreak > nul
reg delete "${APP_REG_KEY}" /f > nul 2>&1
del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\${APP_SHORTCUT}" > nul 2>&1
del "%USERPROFILE%\\Desktop\\${APP_SHORTCUT}" > nul 2>&1
cd /d "%TEMP%"
rmdir /s /q "${installPath}" > nul 2>&1
echo Nexus Launcher a été désinstallé.
timeout /t 2 /nobreak > nul
exit
`;
  await fsp.writeFile(path.join(installPath, 'Uninstall.cmd'), cmd, 'utf8');
}

function registerUninstall(installPath, exePath) {
  return new Promise((resolve, reject) => {
    // reg.exe directly — no extra deps, no permissions surprise.
    const version = require('./package.json').version;
    const sets = [
      ['DisplayName',     APP_NAME],
      ['DisplayVersion',  version],
      ['Publisher',       APP_PUBLISHER],
      ['DisplayIcon',     exePath],
      ['InstallLocation', installPath],
      ['UninstallString',
        `cmd.exe /c "${path.join(installPath, 'Uninstall.cmd')}"`],
      ['NoModify',      '1', 'REG_DWORD'],
      ['NoRepair',      '1', 'REG_DWORD'],
      // Approx 280 MB key (KB units). Slightly conservative — the real
      // unpacked size is around 240 MB but estimations matter little
      // to users in Apps & features anyway.
      ['EstimatedSize', String(280 * 1024), 'REG_DWORD'],
    ];
    let i = 0;
    function next() {
      if (i >= sets.length) return resolve();
      const [name, value, type = 'REG_SZ'] = sets[i++];
      execFile(
        'reg',
        ['add', APP_REG_KEY, '/v', name, '/t', type, '/d', value, '/f'],
        { windowsHide: true },
        (err) => err ? reject(err) : next(),
      );
    }
    next();
  });
}

/**
 * Stamp PKEY_AppUserModel_ID onto an existing .lnk via the bundled
 * set-aumid.ps1 helper. Required for Win10/11 to even consider
 * showing a toast notification from the launcher.
 *
 * Best-effort: swallows all errors (logs to stderr) so a malformed
 * .lnk or missing PowerShell never aborts the install. The launcher
 * will retry on its next boot via its own heal pass.
 */
function setShortcutAumid(lnkPath, aumid) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'scripts', 'set-aumid.ps1');
    if (!fs.existsSync(script)) {
      // eslint-disable-next-line no-console
      console.warn('[installer] set-aumid.ps1 not bundled — skipping');
      resolve();
      return;
    }
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-LinkPath', lnkPath,
        '-Aumid', aumid,
      ],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[installer] set-aumid failed for ${lnkPath}:`,
            (stderr || '').trim() || err.message,
          );
        }
        resolve();
      },
    );
  });
}

function createShortcut({ target, location }) {
  // PowerShell one-liner = cheapest way to create a .lnk without a
  // native module. WorkingDirectory = install dir so the app starts
  // from a sane place (relative paths in the app resolve correctly).
  return new Promise((resolve) => {
    const wd = path.dirname(target);
    const ps = [
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${location.replace(/'/g, "''")}');`,
      `$s.TargetPath = '${target.replace(/'/g, "''")}';`,
      `$s.WorkingDirectory = '${wd.replace(/'/g, "''")}';`,
      `$s.IconLocation = '${target.replace(/'/g, "''")},0';`,
      `$s.Save()`,
    ].join(' ');
    execFile(
      'powershell',
      ['-NoProfile', '-Command', ps],
      { windowsHide: true },
      () => resolve(),
    );
  });
}
