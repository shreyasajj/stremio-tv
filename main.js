// Electron main process: fullscreen kiosk window for the TV UI.

const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const path = require('path');

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
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

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

ipcMain.on('app-quit', () => app.quit());

app.whenReady().then(() => {
  // The UI is loaded from file://; addon servers all send `ACAO: *` per the
  // Stremio addon protocol, so the default CORS behavior is fine.
  createWindow();
});

app.on('window-all-closed', () => app.quit());
