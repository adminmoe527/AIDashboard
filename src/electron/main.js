'use strict';

/**
 * Menu bar app. Lives in the macOS status bar (no Dock icon), polls the shared
 * monitoring core in the background, recolors its tray dot with the worst
 * provider status, notifies on transitions, and shows a popover dashboard on
 * click.
 */

const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  nativeImage,
  Notification,
  ipcMain,
  shell,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { Monitor, DEFAULT_INTERVAL_MS } = require('../core/monitor');
const { PROVIDERS } = require('../core/providers');
const { STATUS, LABEL, rank } = require('../core/state');

let tray = null;
let win = null;
let monitor = null;
let quitting = false;
// When the popover hides on blur because the user clicked the tray icon, the
// click event arrives just after the hide -- without this timestamp the
// toggle would instantly re-show the window, making the tray click unable to
// dismiss it.
let lastHiddenAt = 0;

/* ------------------------------- settings -------------------------------- */

const DEFAULT_SETTINGS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  notifications: true,
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  } catch (err) {
    console.error('failed to save settings:', err.message);
  }
}

let settings = DEFAULT_SETTINGS;

/* ----------------------- external link allowlist ------------------------- */

// The renderer can only ask us to open provider status pages -- nothing else.
const ALLOWED_HOSTS = new Set();
for (const p of PROVIDERS) {
  try { ALLOWED_HOSTS.add(new URL(p.homepage).host); } catch {}
  for (const s of p.sources) {
    try { ALLOWED_HOSTS.add(new URL(s.url).host); } catch {}
  }
}

function safeOpenExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.host)) {
      shell.openExternal(u.toString());
      return true;
    }
  } catch {}
  return false;
}

/* --------------------------------- tray ---------------------------------- */

function trayIconFor(status) {
  const file = path.join(__dirname, '..', '..', 'assets', 'tray', `dot-${status}.png`);
  const img = nativeImage.createFromPath(file);
  return img.isEmpty()
    ? nativeImage.createFromPath(
        path.join(__dirname, '..', '..', 'assets', 'tray', 'dot-unknown.png')
      )
    : img;
}

function trayTooltip(snapshot) {
  if (!snapshot) return 'AI Status: checking...';
  if (snapshot.offline) return 'AI Status: this machine is offline';
  const bad = snapshot.providers.filter((p) => p.status !== STATUS.OPERATIONAL);
  if (!bad.length) return 'AI Status: all providers operational';
  return (
    'AI Status: ' +
    bad.map((p) => `${p.name} ${LABEL[p.status]}`).join(', ')
  );
}

function buildContextMenu(snapshot) {
  const providerItems = (snapshot ? snapshot.providers : []).map((p) => ({
    label: `${p.name}: ${LABEL[p.status]}`,
    click: () => safeOpenExternal(p.homepage),
  }));

  return Menu.buildFromTemplate([
    { label: 'AI Status', enabled: false },
    { type: 'separator' },
    ...providerItems,
    ...(providerItems.length ? [{ type: 'separator' }] : []),
    { label: 'Open Dashboard', click: () => showWindow() },
    { label: 'Refresh Now', click: () => monitor && monitor.refresh() },
    { type: 'separator' },
    {
      label: 'Notifications',
      type: 'checkbox',
      checked: !!settings.notifications,
      click: (item) => {
        settings.notifications = item.checked;
        saveSettings(settings);
        broadcastSettings();
      },
    },
    {
      label: 'Start at Login',
      type: 'checkbox',
      // In dev (npm start) this would register the bare Electron binary as a
      // login item, which then launches a useless empty Electron on boot.
      // Only offer it from the packaged .app.
      enabled: app.isPackaged,
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: item.checked });
        broadcastSettings();
      },
    },
    {
      label: 'Check Every',
      submenu: [
        ['30 seconds', 30_000],
        ['1 minute', 60_000],
        ['2 minutes', 120_000],
        ['5 minutes', 300_000],
      ].map(([label, ms]) => ({
        label,
        type: 'radio',
        checked: settings.intervalMs === ms,
        click: () => {
          settings.intervalMs = ms;
          saveSettings(settings);
          monitor.setPollInterval(ms);
          broadcastSettings();
        },
      })),
    },
    { type: 'separator' },
    {
      label: 'Quit AI Status',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function updateTray(snapshot) {
  if (!tray) return;
  const overall = snapshot ? snapshot.overall : STATUS.UNKNOWN;
  tray.setImage(trayIconFor(overall));
  tray.setToolTip(trayTooltip(snapshot));
}

/* -------------------------------- window --------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Re-sync the settings panel on every show; it may have gone stale while
  // hidden if settings changed via the tray menu.
  win.on('show', () => broadcastSettings());

  // Popover behaviour: dismiss on blur, never actually close.
  win.on('blur', () => {
    if (!win.webContents.isDevToolsOpened()) {
      lastHiddenAt = Date.now();
      win.hide();
    }
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Lock the renderer down: no navigation, no popups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() {
  if (!win) return;
  const winBounds = win.getBounds();
  let x, y;

  const trayBounds = tray ? tray.getBounds() : null;
  if (trayBounds && trayBounds.width > 0) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
    y = Math.round(trayBounds.y + trayBounds.height + 6);
  } else {
    // Fallback (e.g. some Linux trays report zero bounds): open near cursor.
    const cursor = screen.getCursorScreenPoint();
    x = cursor.x - Math.round(winBounds.width / 2);
    y = cursor.y + 10;
  }

  // Clamp onto the display so the popover never opens off-screen.
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  x = Math.max(area.x, Math.min(x, area.x + area.width - winBounds.width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - winBounds.height));

  win.setPosition(x, y, false);
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }
  // A tray click that blurred (and thereby hid) the window lands here within
  // a few ms; treat it as the dismissal it was meant to be.
  if (Date.now() - lastHiddenAt < 300) return;
  showWindow();
}

/* ----------------------------- notifications ------------------------------ */

function notifyChange({ provider, from, to }) {
  if (!settings.notifications) return;
  // The monitor only emits definitive transitions (never to or from
  // unknown, probe-only outages debounced), so every event here is real news.
  const worsened = rank(to) > rank(from);
  const recovered = to === STATUS.OPERATIONAL;
  if (!worsened && !recovered) return;

  const n = new Notification({
    title: `${provider.name}: ${LABEL[to]}`,
    body: worsened
      ? provider.detail || `Status changed from ${LABEL[from]}`
      : `Recovered (was ${LABEL[from]})`,
    silent: !worsened,
  });
  n.on('click', () => showWindow());
  n.show();
}

/* ---------------------------------- ipc ----------------------------------- */

function settingsPayload() {
  return {
    ...settings,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    loginItemSupported: app.isPackaged,
  };
}

// Settings can change from two places (tray menu and popover panel); push
// every change to the renderer so the panel never shows stale values.
function broadcastSettings() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('settings', settingsPayload());
  }
}

function registerIpc() {
  ipcMain.handle('snapshot:get', () => monitor.snapshot);
  ipcMain.handle('history:get', () => monitor.history.toArray());
  ipcMain.handle('refresh', () => monitor.refresh());
  ipcMain.handle('open-url', (_e, url) => safeOpenExternal(String(url)));
  ipcMain.handle('settings:get', () => settingsPayload());
  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      if (typeof patch.notifications === 'boolean') {
        settings.notifications = patch.notifications;
      }
      if (
        Number.isFinite(patch.intervalMs) &&
        patch.intervalMs >= 15_000 &&
        patch.intervalMs <= 3_600_000
      ) {
        settings.intervalMs = patch.intervalMs;
        monitor.setPollInterval(settings.intervalMs);
      }
      if (typeof patch.launchAtLogin === 'boolean' && app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
      }
      saveSettings(settings);
      broadcastSettings();
    }
    return settingsPayload();
  });
  ipcMain.handle('quit', () => {
    quitting = true;
    app.quit();
  });
}

/* ---------------------------------- boot ---------------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    settings = loadSettings();

    // Menu bar app: no Dock presence. (The packaged app also sets LSUIElement.)
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    tray = new Tray(trayIconFor(STATUS.UNKNOWN));
    tray.setToolTip('AI Status: checking...');
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', () => toggleWindow());
    tray.on('right-click', () => {
      tray.popUpContextMenu(buildContextMenu(monitor && monitor.snapshot));
    });

    createWindow();
    registerIpc();

    monitor = new Monitor({ intervalMs: settings.intervalMs });
    monitor.on('update', (snapshot) => {
      updateTray(snapshot);
      if (win && !win.isDestroyed()) {
        win.webContents.send('snapshot', snapshot);
      }
    });
    monitor.on('change', notifyChange);
    monitor.on('error', (err) => console.error('monitor error:', err));
    monitor.start();
  });

  app.on('window-all-closed', () => {
    // Keep running in the menu bar; quitting happens via the tray menu.
  });

  app.on('before-quit', () => {
    quitting = true;
    if (monitor) monitor.stop();
  });
}
