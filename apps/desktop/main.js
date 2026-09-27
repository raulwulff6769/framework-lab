// Windows shell around the web cabinet (platform/dist), served from app:// rather than file://
// so module workers (map rendering) and fetch behave exactly as on https.
const { app, BrowserWindow, net, protocol, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB = path.join(__dirname, 'web');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    title: 'Отсчёт',
    backgroundColor: '#0a0907', // brand graphite — flows out of the intro without a flash
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadURL('app://itles/app/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const win = createWindow();
  if (process.env.ITLES_SELFTEST) require('./selftest')(win, app);
});
app.on('window-all-closed', () => app.quit());
