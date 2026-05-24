/**
 * Two-stage build for the Nexus Launcher Setup .exe.
 *
 *   1. Generate icon assets (build/icon.ico, installer-icon.ico, etc.)
 *      if they don't exist yet OR are older than the generator script.
 *   2. Build the main launcher in --dir mode via electron-builder.
 *      Output: release/win-unpacked/  — the actual launcher.
 *   3. Copy that win-unpacked tree into installer/payload/ so the next
 *      electron-builder pass picks it up via extraResources, then build
 *      the installer itself as a single portable .exe.
 *
 * Output: release/Nexus-Launcher-Setup-X.Y.Z.exe (frameless, branded UI)
 *
 * Run with: npm run build:setup
 */
import { spawnSync } from 'node:child_process';
import { mkdir, rm, readdir, stat, copyFile, symlink, lstat, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const APP_OUT = path.join(RELEASE, 'win-unpacked');
const OVERLAY_DIR = path.join(ROOT, 'tools', 'nexus-overlay');
const OVERLAY_BAT = path.join(OVERLAY_DIR, 'build.bat');
const OVERLAY_DIST = path.join(OVERLAY_DIR, 'build', 'dist');
// Per-run staging dir so a previous build's leftover (often held open
// briefly by Windows Defender / Search indexer after the build exits)
// doesn't block us. We mirror it into `installer/payload-active` via a
// junction so the electron-builder.installer.yml extraResources path
// stays stable regardless of which scratch dir we used. We deliberately
// avoid the name `installer/payload` here because that was the original
// (now leftover) directory, often still scan-locked when we re-run.
const PAYLOAD_LINK = path.join(ROOT, 'installer', 'payload-active');
const PAYLOAD = path.join(
  ROOT, 'installer', `payload-${Date.now()}`,
);
const ART_GEN = path.join(__dirname, 'gen-installer-art.mjs');
const APP_ICO = path.join(ROOT, 'build', 'icon.ico');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: ROOT,
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

async function rmrf(p) {
  if (!existsSync(p)) return;
  await rm(p, { recursive: true, force: true });
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else                 await copyFile(s, d);
  }
}

function iconsStale() {
  // Regenerate art if the .ico is missing OR the generator script
  // changed (treat the script's mtime as the source of truth, since
  // we don't pin a separate .svg).
  if (!existsSync(APP_ICO)) return true;
  return statSync(APP_ICO).mtimeMs < statSync(ART_GEN).mtimeMs;
}

(async () => {
  console.log('━━━ Nexus Launcher Setup builder ━━━');

  // 0) Make sure icons exist (skip if up to date).
  if (iconsStale()) {
    console.log('\n[0/3] Generate icon art…');
    run('node', [ART_GEN]);
  } else {
    console.log('\n[0/3] Icons up to date, skipping art generation.');
  }

  // 0.5) Build the in-game overlay (DLL + injector) for BOTH x64 and
  //      x86 so electron-builder's extraResources copy in step 1
  //      picks up fresh artefacts. Sans ce step, le build prod
  //      embarquerait silencieusement les binaires de la précédente
  //      itération — ou rien du tout si tools/nexus-overlay/build/dist
  //      n'a jamais été peuplé sur ce poste. C++ CMake build is
  //      incremental, donc no-op quand les sources n'ont pas bougé.
  if (process.platform === 'win32') {
    console.log('\n[0.5/3] Build Nexus Overlay (x64 + x86)…');
    if (!existsSync(OVERLAY_BAT)) {
      console.error(`✗ overlay build script missing: ${OVERLAY_BAT}`);
      process.exit(1);
    }
    run(OVERLAY_BAT, [], { cwd: OVERLAY_DIR });
    for (const arch of ['x64', 'x86']) {
      const dll = path.join(OVERLAY_DIST, arch, 'nexus-overlay.dll');
      const inj = path.join(OVERLAY_DIST, arch, 'nexus-overlay-injector.exe');
      if (!existsSync(dll) || !existsSync(inj)) {
        console.error(`✗ overlay ${arch} artefacts missing after build:`);
        console.error(`    ${dll}`);
        console.error(`    ${inj}`);
        process.exit(1);
      }
    }
  } else {
    console.log('\n[0.5/3] Skip overlay build (non-Windows host).');
  }

  // 1) Build the main launcher in --dir mode.
  console.log('\n[1/3] Build main Nexus Launcher (--dir)…');
  await rmrf(APP_OUT);
  run('npm', ['run', 'build']);
  // Drop the cosmetics tree from dist/ BEFORE electron-builder packs
  // it into app.asar. Vite copies the whole public/ to dist/ on every
  // build and we can't easily tell it to skip a subdir, so we just
  // delete after the fact. ~1.8 GB removed; matched by the
  // `!dist/cosmetics/**/*` exclusion in electron-builder.yml as
  // belt-and-suspenders.
  const cosmeticsInDist = path.join(ROOT, 'dist', 'cosmetics');
  if (existsSync(cosmeticsInDist)) {
    console.log('     pruning dist/cosmetics (will be CDN-loaded in v0.2)');
    await rmrf(cosmeticsInDist);
  }
  run('npx', ['electron-builder', '--win', '--dir']);
  if (!existsSync(APP_OUT)) {
    console.error('✗ release/win-unpacked/ missing after main build');
    process.exit(1);
  }

  // 2) Stage payload for the installer wrapper into a per-run dir,
  //    then point installer/payload at it via a junction. The link is
  //    cheap (no copy) and gets us a stable extraResources source
  //    regardless of which scratch dir we used this run.
  console.log('\n[2/3] Stage payload for installer…');
  await rmrf(PAYLOAD);
  await copyDir(APP_OUT, PAYLOAD);
  // Replace installer/payload with a fresh junction to PAYLOAD.
  try {
    const linkStat = await lstat(PAYLOAD_LINK).catch(() => null);
    if (linkStat) {
      // Try unlink (works for symlinks/junctions) first, fall back to
      // rmrf for directory remnants from older runs.
      try { await unlink(PAYLOAD_LINK); }
      catch { await rmrf(PAYLOAD_LINK); }
    }
  } catch {
    /* nothing to clean */
  }
  // 'junction' is Windows-only; on POSIX 'dir' symlinks work the same
  // way for electron-builder's purposes.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(PAYLOAD, PAYLOAD_LINK, linkType);
  console.log(`  ✓ ${PAYLOAD} → ${PAYLOAD_LINK}`);

  // 3) Build the installer with its own builder config.
  console.log('\n[3/3] Build Setup .exe…');
  run('npx', [
    'electron-builder',
    '--config', 'electron-builder.installer.yml',
    '--win',
  ]);

  // Cleanup: drop the junction (always safe), best-effort drop the
  // scratch payload too. If Defender is still holding a scan-handle
  // on it, we just leave it — next run uses a new dated dir and old
  // ones can be GC'd manually later.
  try { await unlink(PAYLOAD_LINK); } catch { /* ignore */ }
  await rmrf(PAYLOAD).catch(() => {
    console.log(
      `  ! Could not delete ${PAYLOAD} (likely Defender scan handle). ` +
      `Safe to delete manually later.`,
    );
  });
  console.log('\n✓ Setup ready in release/');
})();
