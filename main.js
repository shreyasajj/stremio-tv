// Electron main process: fullscreen kiosk window for the TV UI.

const { app, BrowserWindow, ipcMain, net, powerSaveBlocker, clipboard } = require('electron');
const path = require('path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

// TV boxes: play without a click, prefer hardware decoding where available.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch(
  'enable-features',
  'VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,PlatformHEVCDecoderSupport,AcceleratedVideoDecodeLinuxZeroCopyGL'
);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: '#0c0d16',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Throttle timers/rendering whenever the window is hidden or occluded
      // so the app costs (almost) nothing in the background.
      backgroundThrottling: true,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    win.show();
    win.setFullScreen(true); // belt and braces: some WMs ignore the ctor flag
  });
  // If anything (compositor, shortcuts) drops us out of fullscreen, go back.
  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) win.setFullScreen(true);
  });
  // Tell the UI when the window loses/gains focus so playback can pause
  // instead of burning CPU/network behind another app.
  win.on('blur', () => { if (!win.isDestroyed()) win.webContents.send('window-blur'); });
  win.on('focus', () => { if (!win.isDestroyed()) win.webContents.send('window-focus'); });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

// Keep the display awake only while something is actually playing.
let powerBlockerId = null;
ipcMain.on('playback-state', (_e, playing) => {
  if (playing && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!playing && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
});

// Subtitle files live on hosts that don't send CORS headers; fetch them in the
// main process (no CORS there) and hand the text to the renderer.
ipcMain.handle('proxy-fetch', async (_e, url) => {
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs allowed');
    const res = await net.fetch(url, { redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) throw new Error('File too large');
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: buf.toString('utf8'),
    };
  } catch (e) {
    return { ok: false, status: 0, contentType: '', body: '', error: String(e.message || e) };
  }
});

// Paste into the on-screen keyboard (navigator.clipboard needs a permission
// dance in the renderer; the main-process clipboard doesn't).
ipcMain.handle('read-clipboard', () => clipboard.readText());


// Read-only troubleshooting information for Linux HDMI audio. Do not infer Atmos
// support from speaker count: encoded passthrough depends on the player and sink.
ipcMain.handle('audio-diagnostics', async () => {
  const diagnostics = {
    session: process.env.XDG_SESSION_TYPE || 'unknown',
    commands: {},
  };
  for (const [label, command, args] of [
    ['server', 'pactl', ['info']],
    ['sinks', 'pactl', ['list', 'short', 'sinks']],
    ['alsa', 'aplay', ['-l']],
  ]) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        timeout: 4000,
        maxBuffer: 128 * 1024,
        encoding: 'utf8',
      });
      diagnostics.commands[label] = stdout.slice(0, 10000).trim();
    } catch (error) {
      diagnostics.commands[label] = 'Unavailable: ' + (error.code || error.message);
    }
  }
  return diagnostics;
});

ipcMain.on('app-quit', () => app.quit());

app.whenReady().then(() => {
  // The UI is loaded from file://; addon servers all send `ACAO: *` per the
  // Stremio addon protocol, so the default CORS behavior is fine.
  createWindow();
});

app.on('window-all-closed', () => app.quit());
