/**
 * Generates the icon assets for the launcher AND the Setup .exe.
 *
 * Two outputs:
 *   1. build/icon.ico         — Windows app icon (main launcher .exe)
 *   2. installer/assets/icon.png — installer wizard's window icon
 *   3. build/installer-icon.ico — Setup.exe file icon (Apps & features)
 *
 * The art is generated programmatically with `sharp` from an inline
 * SVG so contributors don't have to install Inkscape / Photoshop to
 * touch the launcher branding. To swap the design later, just hand-
 * write `assets/icon-source.svg` and delete this generator step from
 * the build pipeline — electron-builder will pick the file up directly.
 */
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Inline SVG so the generator is self-contained — no external file
// required. The shape is the same stylised "cloud with an N" used in
// the installer titlebar (consistent brand mark).
function nexusSvg(size, kind /* 'app' | 'installer' */) {
  // Installer icon gets a slightly brighter halo to read at small
  // sizes (in the Setup.exe file icon, 16×16 is the visible default).
  const halo = kind === 'installer' ? 0.55 : 0.4;
  return `
<svg width="${size}" height="${size}" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="62%">
      <stop offset="0" stop-color="#1b2838"/>
      <stop offset="1" stop-color="#06101b"/>
    </radialGradient>
    <linearGradient id="cloud" x1="40" y1="60" x2="220" y2="200" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#66c0f4"/>
      <stop offset="1" stop-color="#5ba32b"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="44%" r="50%">
      <stop offset="0" stop-color="#66c0f4" stop-opacity="${halo}"/>
      <stop offset="1" stop-color="#66c0f4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <!-- Rounded square background; matches Windows 11 taskbar icon aesthetic. -->
  <rect x="8" y="8" width="240" height="240" rx="48" fill="url(#bg)"/>
  <!-- Soft accent halo behind the cloud -->
  <circle cx="128" cy="118" r="100" fill="url(#halo)"/>
  <!-- Stylised cloud silhouette -->
  <path d="M58 168c0-26 21-47 47-47h3a47 47 0 0 1 92 5q0 4-1 8a36 36 0 0 1-16 68H92a47 47 0 0 1-34-34Z"
        fill="url(#cloud)"/>
  <!-- Tilted "N" stroke through the cloud -->
  <path d="M104 102v62M156 102v62M104 132l52-30"
        stroke="white" stroke-width="14" stroke-linecap="round" fill="none"/>
</svg>`;
}

async function pngBuffer(size, kind) {
  return sharp(Buffer.from(nexusSvg(size, kind))).png().toBuffer();
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

(async () => {
  console.log('━━━ Nexus Launcher art generator ━━━');

  await ensureDir(path.join(ROOT, 'build'));
  await ensureDir(path.join(ROOT, 'installer', 'assets'));

  // App icon — Windows wants .ico with multiple sizes embedded so it
  // renders crisp at every shell location (taskbar 32, alt-tab 48,
  // file explorer 256).
  console.log('  → build/icon.ico (256/128/64/48/32/16)');
  const appPngs = await Promise.all(
    [256, 128, 64, 48, 32, 16].map((s) => pngBuffer(s, 'app')),
  );
  await writeFile(
    path.join(ROOT, 'build', 'icon.ico'),
    await pngToIco(appPngs),
  );

  // Installer window icon — single PNG, used by the wizard's
  // BrowserWindow chrome (not the .exe file icon).
  console.log('  → installer/assets/icon.png (256)');
  await writeFile(
    path.join(ROOT, 'installer', 'assets', 'icon.png'),
    await pngBuffer(256, 'installer'),
  );

  // Setup.exe file icon — appears in the user's Downloads folder, on
  // the desktop after they save it, and in Apps & features (until
  // installation completes and DisplayIcon takes over).
  console.log('  → build/installer-icon.ico (256/128/64/48/32/16)');
  const setupPngs = await Promise.all(
    [256, 128, 64, 48, 32, 16].map((s) => pngBuffer(s, 'installer')),
  );
  await writeFile(
    path.join(ROOT, 'build', 'installer-icon.ico'),
    await pngToIco(setupPngs),
  );

  console.log('✓ Done');
})();
