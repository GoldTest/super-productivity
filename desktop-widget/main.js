const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let widgetWin = null;
const SNAP_THRESHOLD = 28; // pixels to snap to screen edges
let isCollapsed = false;
let isSnappedToEdge = false;
let isAnimating = false;
const DEFAULT_EXPANDED_WIDTH = 320; // Compact, clean main window width
const DEFAULT_EXPANDED_HEIGHT = 540;
let expandedWidth = DEFAULT_EXPANDED_WIDTH;
let expandedHeight = DEFAULT_EXPANDED_HEIGHT;

// Adaptive mini-bar constraints (Requirement: 160px ~ 320px)
const MIN_COLLAPSED_WIDTH = 160;
const MAX_COLLAPSED_WIDTH = 320; // Capped to 320px so it never exceeds the main window
let currentCollapsedWidth = 220;
const COLLAPSED_HEIGHT = 32; // Comfortable slim height avoiding OS window clipping
let mouseWatcherTimer = null;
let outsideCount = 0;

let config = {
  width: DEFAULT_EXPANDED_WIDTH,
  height: DEFAULT_EXPANDED_HEIGHT,
  x: undefined,
  y: undefined,
  alwaysOnTop: true,
  opacity: 0.94,
  snapToEdge: true,
  autoCollapseOnEdge: true,
  serverUrl: 'http://127.0.0.1:3876',
  token: '',
};

function getConfigPath() {
  return path.join(app.getPath('userData'), 'widget-settings.json');
}

function loadConfig() {
  try {
    const file = getConfigPath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = { ...config, ...data };
      // Clamp to a comfortable, compact window width (default 320, max 340)
      if (typeof config.width === 'number') {
        expandedWidth = Math.min(340, Math.max(300, config.width));
        config.width = expandedWidth;
      }
      if (typeof config.height === 'number') {
        expandedHeight = Math.min(650, Math.max(400, config.height));
        config.height = expandedHeight;
      }
    }
  } catch (err) {
    console.warn('[Widget] Failed to load config:', err.message);
  }
}

function saveConfig(updates) {
  try {
    config = { ...config, ...updates };
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[Widget] Failed to save config:', err.message);
  }
}

function autoDetectSuperProductivityToken() {
  const candidates = [];
  const home = os.homedir();

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'superProductivity', 'local-rest-api-token'));
    candidates.push(path.join(appData, 'superProductivity-development', 'local-rest-api-token'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'superProductivity', 'local-rest-api-token'),
      path.join(home, 'Library', 'Application Support', 'superProductivity-development', 'local-rest-api-token')
    );
  } else {
    candidates.push(
      path.join(home, '.config', 'superProductivity', 'local-rest-api-token'),
      path.join(home, '.config', 'superProductivity-development', 'local-rest-api-token')
    );
  }

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const token = fs.readFileSync(filePath, 'utf8').trim();
        if (token && token.length >= 10) {
          return { found: true, token, path: filePath };
        }
      }
    } catch (_e) {
      // Continue searching
    }
  }

  return { found: false, token: '', path: null };
}

// ── Smooth Window Bounds Animation ──
let resizeAnimTimer = null;

function animateWindowBounds(targetBounds, duration = 180) {
  if (!widgetWin || widgetWin.isDestroyed()) return Promise.resolve();
  if (resizeAnimTimer) {
    clearInterval(resizeAnimTimer);
    resizeAnimTimer = null;
  }

  const startBounds = widgetWin.getBounds();
  const startTime = Date.now();
  const diffX = targetBounds.x - startBounds.x;
  const diffY = targetBounds.y - startBounds.y;
  const diffW = targetBounds.width - startBounds.width;
  const diffH = targetBounds.height - startBounds.height;

  return new Promise((resolve) => {
    resizeAnimTimer = setInterval(() => {
      if (!widgetWin || widgetWin.isDestroyed()) {
        clearInterval(resizeAnimTimer);
        resizeAnimTimer = null;
        resolve();
        return;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Smooth cubic ease-out curve
      const ease = 1 - Math.pow(1 - progress, 3);

      widgetWin.setBounds({
        x: Math.round(startBounds.x + diffX * ease),
        y: Math.round(startBounds.y + diffY * ease),
        width: Math.round(startBounds.width + diffW * ease),
        height: Math.round(startBounds.height + diffH * ease),
      });

      if (progress >= 1) {
        clearInterval(resizeAnimTimer);
        resizeAnimTimer = null;
        resolve();
      }
    }, 12);
  });
}

// ── Helper to Evaluate Edge Snapping ──
function evaluateEdgeSnap(bounds) {
  const currentDisplay = screen.getDisplayMatching(bounds);
  const area = currentDisplay.workArea;

  const isNearLeft = Math.abs(bounds.x - area.x) < SNAP_THRESHOLD;
  const isNearRight = Math.abs(bounds.x + bounds.width - (area.x + area.width)) < SNAP_THRESHOLD;
  const isNearTop = Math.abs(bounds.y - area.y) < SNAP_THRESHOLD;
  const isNearBottom = Math.abs(bounds.y + bounds.height - (area.y + area.height)) < SNAP_THRESHOLD;

  let edge = null;
  if (isNearLeft) edge = 'left';
  else if (isNearRight) edge = 'right';

  if (isNearTop) edge = edge ? `${edge}-top` : 'top';
  else if (isNearBottom) edge = edge ? `${edge}-bottom` : 'bottom';

  return { isSnapped: !!edge, edge };
}

// ── Centralized Collapse / Expand Controller ──
async function setCollapsedState(shouldCollapse, customWidth) {
  if (!widgetWin || widgetWin.isDestroyed() || isAnimating) return isCollapsed;
  if (shouldCollapse === isCollapsed && !customWidth) return isCollapsed;

  isAnimating = true;
  const bounds = widgetWin.getBounds();
  const currentDisplay = screen.getDisplayMatching(bounds);
  const area = currentDisplay.workArea;
  const centerX = bounds.x + bounds.width / 2;

  if (shouldCollapse) {
    expandedWidth = Math.min(340, Math.max(300, bounds.width));
    expandedHeight = Math.max(260, bounds.height);
    isCollapsed = true;

    // Use the exact expandedWidth of the main window as the ceiling!
    const maxBarWidth = expandedWidth;
    if (typeof customWidth === 'number' && customWidth > 0) {
      currentCollapsedWidth = Math.min(maxBarWidth, Math.max(MIN_COLLAPSED_WIDTH, Math.round(customWidth)));
    } else {
      currentCollapsedWidth = Math.min(maxBarWidth, Math.max(MIN_COLLAPSED_WIDTH, currentCollapsedWidth));
    }

    // Anchor strictly to centerX using the adaptive width!
    let targetX = Math.round(centerX - currentCollapsedWidth / 2);
    targetX = Math.max(area.x, Math.min(targetX, area.x + area.width - currentCollapsedWidth));

    widgetWin.webContents.send('widget:collapsed-changed', true);
    await animateWindowBounds({
      x: targetX,
      y: bounds.y,
      width: currentCollapsedWidth,
      height: COLLAPSED_HEIGHT,
    }, 180);
  } else {
    isCollapsed = false;

    // Expand symmetrically around centerX
    let targetX = Math.round(centerX - expandedWidth / 2);
    targetX = Math.max(area.x, Math.min(targetX, area.x + area.width - expandedWidth));

    let targetY = bounds.y;
    if (targetY + expandedHeight > area.y + area.height) {
      targetY = Math.max(area.y, area.y + area.height - expandedHeight);
    }

    widgetWin.webContents.send('widget:collapsed-changed', false);
    await animateWindowBounds({
      x: targetX,
      y: targetY,
      width: expandedWidth,
      height: expandedHeight,
    }, 200);
  }

  isAnimating = false;
  return isCollapsed;
}

// ── Hardware OS-Level Cursor Position Watcher ──
function startMouseWatcher() {
  if (mouseWatcherTimer) clearInterval(mouseWatcherTimer);

  mouseWatcherTimer = setInterval(() => {
    if (!widgetWin || widgetWin.isDestroyed() || isAnimating) return;
    if (!config.autoCollapseOnEdge || !isSnappedToEdge) return;

    const cursor = screen.getCursorScreenPoint();
    const bounds = widgetWin.getBounds();

    const isInside =
      cursor.x >= bounds.x &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height;

    if (isInside) {
      outsideCount = 0;
      // If cursor is on the widget and it's collapsed, expand it!
      if (isCollapsed) {
        setCollapsedState(false);
      }
    } else {
      // Cursor is outside the window
      if (!isCollapsed) {
        outsideCount += 1;
        // 4 ticks of 120ms = ~480ms grace period outside
        if (outsideCount >= 4) {
          outsideCount = 0;
          setCollapsedState(true);
        }
      } else {
        outsideCount = 0;
      }
    }
  }, 120);
}

function createWidgetWindow() {
  loadConfig();

  const primaryDisplay = screen.getPrimaryDisplay();
  const { workArea } = primaryDisplay;

  // Default position: snapped flush to top-right corner
  const defaultX = workArea.x + workArea.width - config.width;
  const defaultY = workArea.y;

  const posX = typeof config.x === 'number' ? config.x : defaultX;
  const posY = typeof config.y === 'number' ? config.y : defaultY;

  widgetWin = new BrowserWindow({
    width: config.width,
    height: config.height,
    x: posX,
    y: posY,
    minWidth: 160,
    minHeight: 28,
    maxWidth: 650,
    maxHeight: 960,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: config.alwaysOnTop,
    skipTaskbar: false,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  widgetWin.setOpacity(config.opacity || 0.94);
  widgetWin.loadFile(path.join(__dirname, 'index.html'));

  // 1. Immediately evaluate initial edge snapping on launch!
  const initialSnap = evaluateEdgeSnap(widgetWin.getBounds());
  isSnappedToEdge = initialSnap.isSnapped;

  widgetWin.webContents.on('did-finish-load', () => {
    if (initialSnap.edge) {
      widgetWin.webContents.send('widget:edge-snapped', initialSnap.edge);
    }
  });

  // Edge Snapping logic on move
  let isSnapping = false;
  widgetWin.on('move', () => {
    if (!config.snapToEdge || isSnapping || isAnimating || !widgetWin) return;

    const bounds = widgetWin.getBounds();
    const currentDisplay = screen.getDisplayMatching(bounds);
    const area = currentDisplay.workArea;

    let newX = bounds.x;
    let newY = bounds.y;
    const snapResult = evaluateEdgeSnap(bounds);
    isSnappedToEdge = snapResult.isSnapped;

    // Check Left Edge
    if (Math.abs(bounds.x - area.x) < SNAP_THRESHOLD) {
      newX = area.x;
    }
    // Check Right Edge
    else if (Math.abs(bounds.x + bounds.width - (area.x + area.width)) < SNAP_THRESHOLD) {
      newX = area.x + area.width - bounds.width;
    }

    // Check Top Edge
    if (Math.abs(bounds.y - area.y) < SNAP_THRESHOLD) {
      newY = area.y;
    }
    // Check Bottom Edge
    else if (Math.abs(bounds.y + bounds.height - (area.y + area.height)) < SNAP_THRESHOLD) {
      newY = area.y + area.height - bounds.height;
    }

    if (newX !== bounds.x || newY !== bounds.y) {
      isSnapping = true;
      widgetWin.setPosition(newX, newY);
      setTimeout(() => {
        isSnapping = false;
      }, 50);
    }

    if (widgetWin && !widgetWin.isDestroyed()) {
      widgetWin.webContents.send('widget:edge-snapped', snapResult.edge);
    }

    if (!isCollapsed) {
      saveConfig({ x: newX, y: newY });
    }
  });

  widgetWin.on('resize', () => {
    if (!widgetWin || widgetWin.isDestroyed() || isAnimating) return;
    const { width, height } = widgetWin.getBounds();
    if (!isCollapsed && height > 100 && width >= 260) {
      expandedWidth = Math.min(340, Math.max(300, width));
      expandedHeight = height;
      saveConfig({ width: expandedWidth, height });
    }
  });

  widgetWin.on('closed', () => {
    if (mouseWatcherTimer) {
      clearInterval(mouseWatcherTimer);
      mouseWatcherTimer = null;
    }
    widgetWin = null;
  });

  // Start watching mouse cursor immediately on launch
  startMouseWatcher();
}

// ── IPC Handlers ──
ipcMain.handle('widget:get-config', () => {
  return config;
});

ipcMain.handle('widget:save-config', (_event, updates) => {
  saveConfig(updates);
  if (updates.opacity !== undefined && widgetWin) {
    widgetWin.setOpacity(updates.opacity);
  }
  if (updates.alwaysOnTop !== undefined && widgetWin) {
    widgetWin.setAlwaysOnTop(updates.alwaysOnTop);
  }
  return config;
});

ipcMain.handle('widget:auto-detect-token', () => {
  return autoDetectSuperProductivityToken();
});

ipcMain.on('widget:minimize', () => {
  if (widgetWin) widgetWin.minimize();
});

ipcMain.on('widget:close', () => {
  if (widgetWin) widgetWin.close();
});

ipcMain.handle('widget:toggle-pin', () => {
  if (!widgetWin) return config.alwaysOnTop;
  const next = !widgetWin.isAlwaysOnTop();
  widgetWin.setAlwaysOnTop(next);
  saveConfig({ alwaysOnTop: next });
  return next;
});

ipcMain.on('widget:set-opacity', (_event, val) => {
  if (widgetWin && typeof val === 'number') {
    widgetWin.setOpacity(Math.max(0.3, Math.min(1, val)));
    saveConfig({ opacity: val });
  }
});

// Manual Collapse / Expand
ipcMain.handle('widget:set-collapsed', async (_event, shouldCollapse, customWidth) => {
  return setCollapsedState(shouldCollapse, customWidth);
});

// Dynamic mini-bar width adjustment when task text changes
ipcMain.handle('widget:update-mini-width', async (_event, newWidth) => {
  if (!widgetWin || widgetWin.isDestroyed() || !isCollapsed || isAnimating) return;
  const targetW = Math.min(expandedWidth, Math.max(MIN_COLLAPSED_WIDTH, Math.round(newWidth)));
  if (Math.abs(targetW - currentCollapsedWidth) < 4) return;
  currentCollapsedWidth = targetW;

  const bounds = widgetWin.getBounds();
  const currentDisplay = screen.getDisplayMatching(bounds);
  const area = currentDisplay.workArea;
  const centerX = bounds.x + bounds.width / 2;

  let targetX = Math.round(centerX - currentCollapsedWidth / 2);
  targetX = Math.max(area.x, Math.min(targetX, area.x + area.width - currentCollapsedWidth));

  await animateWindowBounds({
    x: targetX,
    y: bounds.y,
    width: currentCollapsedWidth,
    height: COLLAPSED_HEIGHT,
  }, 140);
});

app.whenReady().then(() => {
  createWidgetWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWidgetWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (mouseWatcherTimer) {
    clearInterval(mouseWatcherTimer);
    mouseWatcherTimer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
