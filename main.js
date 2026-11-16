'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const SRC_ROOT = path.join(__dirname, 'src');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
let allowClose = false;
let isDirty = false;
let pendingFile = null;

function pdfFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (typeof a === 'string' && /\.pdf$/i.test(a)) {
      try { if (fs.statSync(a).isFile()) return path.resolve(a); } catch (_) { /* ignore */ }
    }
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'PDF Signature',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f3f4f7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (allowClose || !isDirty) return;
    e.preventDefault();
    win.webContents.send('close-request');
  });
  win.on('closed', () => { win = null; });
  win.loadURL('app://local/index.html');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = pdfFromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) win.webContents.send('open-file', f);
    }
  });

  app.whenReady().then(() => {
    protocol.handle('app', async (req) => {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const full = path.normalize(path.join(SRC_ROOT, rel));
      if (!full.startsWith(SRC_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
      const res = await net.fetch(pathToFileURL(full).toString());
      if (/\.html?$/i.test(full)) {
        const headers = new Headers(res.headers);
        headers.set('Content-Security-Policy', CSP);
        headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(await res.arrayBuffer(), { status: res.status, headers });
      }
      return res;
    });
    pendingFile = pdfFromArgv(process.argv);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}

/* ---------------- IPC ---------------- */

function readPdf(filePath) {
  const data = fs.readFileSync(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

ipcMain.handle('get-initial-file', () => {
  const f = pendingFile;
  pendingFile = null;
  return f;
});

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return readPdf(r.filePaths[0]);
});

ipcMain.handle('read-file', (_e, filePath) => {
  if (typeof filePath !== 'string' || !/\.pdf$/i.test(filePath)) throw new Error('Only PDF files can be opened.');
  return readPdf(filePath);
});

ipcMain.handle('file-exists', (_e, filePath) => {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
});

ipcMain.handle('save-dialog', async (_e, defaultPath, data) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save signed PDF',
    defaultPath,
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  let out = r.filePath;
  if (!/\.pdf$/i.test(out)) out += '.pdf';
  fs.writeFileSync(out, Buffer.from(data));
  return out;
});

ipcMain.handle('write-file', (_e, filePath, data) => {
  if (typeof filePath !== 'string' || !/\.pdf$/i.test(filePath)) throw new Error('Invalid file path.');
  fs.writeFileSync(filePath, Buffer.from(data));
  return filePath;
});

ipcMain.handle('show-in-folder', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('path-info', (_e, p) => ({ dir: path.dirname(p), base: path.basename(p), sep: path.sep }));
ipcMain.on('set-dirty', (_e, v) => { isDirty = !!v; });
ipcMain.on('set-title', (_e, t) => { if (win) win.setTitle(String(t)); });
ipcMain.on('force-close', () => { allowClose = true; if (win) win.close(); });
