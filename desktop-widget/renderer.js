// ── State Management ──
const state = {
  config: {
    serverUrl: 'http://127.0.0.1:3876',
    token: '',
    opacity: 0.94,
    snapToEdge: true,
    autoCollapseOnEdge: true,
    sound: true,
  },
  isConnected: false,
  isPolling: false,
  isSnappedToEdge: false,
  isCollapsed: false,
  collapseTimeoutId: null,

  // Tab: 'today' or projectId
  currentTab: 'today',
  projects: [],
  tasks: [],
  currentTaskId: null,
  currentTask: null,

  // DOM Diffing & Anti-flicker Caches
  lastTasksFingerprint: null,
  lastRenderedTab: null,

  // Focus Timer state
  timer: {
    mode: 'FOCUS', // 'FOCUS' | 'BREAK'
    cycle: 1,
    remainingSeconds: 25 * 60,
    isRunning: false,
    timerInterval: null,
  },
};

let lastUserStopTimestamp = 0;

// ── Fallback Demo Data for Instant Exploration ──
const demoProjects = [
  { id: 'demo-p1', title: '工作任务' },
  { id: 'demo-p2', title: '学习计划' },
  { id: 'demo-p3', title: '个人生活' },
];

const demoTasks = [
  { id: 'demo-1', title: '体验贴边后自动收起为超薄小横条 (鼠标挪开触发)', isDone: false, timeSpent: 300000, timeEstimate: 1200000, tagIds: ['TODAY'], projectId: 'demo-p1' },
  { id: 'demo-2', title: '鼠标挪回小横条立即展开为完整任务面板', isDone: false, timeSpent: 120000, timeEstimate: 1200000, tagIds: ['TODAY'], projectId: 'demo-p1' },
  { id: 'demo-3', title: '点击任务播放按钮，在小横条里显示专注任务和时长', isDone: false, timeSpent: 0, timeEstimate: 1500000, tagIds: ['TODAY'], projectId: 'demo-p2' },
  { id: 'demo-4', title: '切换上方项目 Tab，在对应项目下快速新增任务', isDone: true, timeSpent: 60000, timeEstimate: 300000, projectId: 'demo-p3' },
];

// ── DOM Elements ──
const elements = {
  appWindow: document.getElementById('app-window'),
  miniBar: document.getElementById('mini-bar'),
  miniTaskTitle: document.getElementById('mini-task-title'),
  miniTimerText: document.getElementById('mini-timer-text'),

  // Header
  btnPin: document.getElementById('btn-pin'),
  btnSettings: document.getElementById('btn-settings'),
  btnMinimize: document.getElementById('btn-minimize'),
  btnClose: document.getElementById('btn-close'),

  // Focus Card
  focusModeBadge: document.getElementById('focus-mode-badge'),
  focusCycleText: document.getElementById('focus-cycle-text'),
  focusTaskTitle: document.getElementById('focus-task-title'),
  focusTimerText: document.getElementById('focus-timer-text'),
  btnTimerToggle: document.getElementById('btn-timer-toggle'),
  btnTimerReset: document.getElementById('btn-timer-reset'),

  // Tabs
  listPillsRow: document.getElementById('list-pills-row'),
  taskStatsText: document.getElementById('task-stats-text'),
  btnRefresh: document.getElementById('btn-refresh'),

  // Tasks
  tasksContainer: document.getElementById('tasks-container'),
  quickAddForm: document.getElementById('quick-add-form'),
  quickAddInput: document.getElementById('quick-add-input'),

  // Toast
  toastBanner: document.getElementById('toast-banner'),
  toastMessage: document.getElementById('toast-message'),

  // Settings Modal
  settingsModal: document.getElementById('settings-modal'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnCancelSettings: document.getElementById('btn-cancel-settings'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  btnDetectToken: document.getElementById('btn-detect-token'),
  cfgServerUrl: document.getElementById('cfg-server-url'),
  cfgToken: document.getElementById('cfg-token'),
  cfgOpacity: document.getElementById('cfg-opacity'),
  opacityValText: document.getElementById('opacity-val-text'),
  cfgSnapEdge: document.getElementById('cfg-snap-edge'),
  cfgAutoCollapse: document.getElementById('cfg-auto-collapse'),
  cfgSound: document.getElementById('cfg-sound'),
};

// ── Notification Sound Synthesis (Web Audio API) ──
function playChime() {
  if (!state.config.sound) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    const notes = [587.33, 880, 1174.66]; // D5, A5, D6
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.12);

      gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.12);
      gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + idx * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.12 + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + idx * 0.12);
      osc.stop(ctx.currentTime + idx * 0.12 + 0.65);
    });
  } catch (err) {
    console.warn('[Audio] Failed to synthesize sound:', err);
  }
}

// ── Show Toast & System Notification ──
function showNotification(title, message) {
  playChime();

  elements.toastMessage.textContent = message || title;
  elements.toastBanner.classList.add('show');
  setTimeout(() => {
    elements.toastBanner.classList.remove('show');
  }, 4000);

  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body: message, silent: true });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          new Notification(title, { body: message, silent: true });
        }
      });
    }
  }
}

// ── Adaptive Mini-Bar Width Calculation (160px ~ 320px) ──
function calculateMiniBarWidth() {
  const title = elements.miniTaskTitle.textContent || '';
  const timer = elements.miniTimerText.textContent || '25:00';

  if (!calculateMiniBarWidth.canvas) {
    calculateMiniBarWidth.canvas = document.createElement('canvas');
  }
  const ctx = calculateMiniBarWidth.canvas.getContext('2d');
  ctx.font = '500 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const titleWidth = ctx.measureText(title).width;

  ctx.font = '700 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const timerWidth = ctx.measureText(timer).width;

  const total = Math.ceil(titleWidth + timerWidth + 46);
  return Math.min(340, Math.max(160, total));
}

// ── Smooth Collapse & Expand ──
async function collapseToMiniBar() {
  const targetWidth = calculateMiniBarWidth();
  if (window.widgetAPI?.setCollapsed) {
    await window.widgetAPI.setCollapsed(true, targetWidth);
  }
}

async function expandToFull() {
  if (window.widgetAPI?.setCollapsed) {
    await window.widgetAPI.setCollapsed(false);
  }
}

// ── REST API Calls ──
async function apiRequest(endpoint, options = {}) {
  const url = `${state.config.serverUrl.replace(/\/$/, '')}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(state.config.token ? { Authorization: `Bearer ${state.config.token}` } : {}),
    ...(options.headers || {}),
  };

  const resp = await fetch(url, {
    ...options,
    headers,
  });

  if (!resp.ok) {
    const errorData = await resp.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP ${resp.status}`);
  }

  const result = await resp.json();
  return result.data !== undefined ? result.data : result;
}

// Helper to compare projects array equality to avoid useless DOM re-render
function areProjectsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].title !== b[i].title) return false;
  }
  return true;
}

// ── Sync with Super Productivity (Anti-flicker Diffing) ──
async function syncFromHost() {
  try {
    // 1. Health check
    await apiRequest('/health');

    // 2. Fetch Projects (Only re-render if projects changed)
    const projects = await apiRequest('/projects').catch(() => []);
    if (!areProjectsEqual(state.projects, projects)) {
      state.projects = projects;
      renderProjectTabs();
    }

    // 3. Fetch Tasks
    let taskParams = new URLSearchParams();
    taskParams.set('includeDone', 'true');

    if (state.currentTab === 'today') {
      taskParams.set('tagId', 'TODAY');
    } else {
      taskParams.set('projectId', state.currentTab);
    }

    const tasks = await apiRequest(`/tasks?${taskParams.toString()}`);
    state.tasks = tasks;

    // 4. Fetch Focus & Status
    const [statusData, focusData] = await Promise.all([
      apiRequest('/status').catch(() => null),
      apiRequest('/focus').catch(() => null),
    ]);

    // Bidirectional Focus Sync with Super Productivity
    if (statusData) {
      const hostTaskId = statusData.currentTaskId;
      const hostTask = statusData.currentTask;

      // If user recently stopped the task in widget (< 3.5s), ignore stale host state
      const isRecentlyStopped = Date.now() - lastUserStopTimestamp < 3500;

      if (!isRecentlyStopped) {
        if (hostTaskId && hostTask) {
          // Host is actively focusing on a task
          const isNewTask = state.currentTaskId !== hostTaskId;
          state.currentTaskId = hostTaskId;
          state.currentTask = hostTask;

          // Check if host Focus/Pomodoro mode is active
          if (focusData && focusData.timer && typeof focusData.timer.remainingMs === 'number') {
            state.timer.mode = focusData.mode === 'BREAK' ? 'BREAK' : 'FOCUS';
            state.timer.cycle = focusData.cycle || 1;
            state.timer.remainingSeconds = Math.max(0, Math.round(focusData.timer.remainingMs / 1000));
            if (focusData.timer.status === 'running') {
              startTimer();
            } else {
              pauseTimer();
            }
          } else {
            // Normal task tracking in Super Productivity: start local countdown if not running
            if (isNewTask && state.timer.remainingSeconds <= 0) {
              state.timer.remainingSeconds = 25 * 60;
            }
            if (!state.timer.isRunning) {
              startTimer();
            }
          }
        } else {
          // Host has stopped focusing on any task
          if (state.currentTaskId) {
            state.currentTaskId = null;
            state.currentTask = null;
            pauseTimer();
            resetTimer();
            state.lastTasksFingerprint = null;
          }
        }
      }
    }

    state.isConnected = true;
  } catch (err) {
    state.isConnected = false;

    if (state.projects.length === 0) {
      state.projects = demoProjects;
      state.tasks = demoTasks;
      renderProjectTabs();
    }
  } finally {
    renderUI();
  }
}

// ── Render Project Tabs ──
function renderProjectTabs() {
  elements.listPillsRow.innerHTML = '';

  // 1. Today Tab
  const todayBtn = document.createElement('button');
  todayBtn.className = `pill-tab ${state.currentTab === 'today' ? 'active' : ''}`;
  todayBtn.textContent = '📅 今日';
  todayBtn.addEventListener('click', () => {
    state.currentTab = 'today';
    state.lastTasksFingerprint = null;
    updateActiveTab();
    if (state.isConnected) syncFromHost(); else renderTasks();
  });
  elements.listPillsRow.appendChild(todayBtn);

  // 2. Each Project Tab
  state.projects.forEach((proj) => {
    const projBtn = document.createElement('button');
    projBtn.className = `pill-tab ${state.currentTab === proj.id ? 'active' : ''}`;
    projBtn.textContent = `📂 ${proj.title}`;
    projBtn.title = proj.title;
    projBtn.addEventListener('click', () => {
      state.currentTab = proj.id;
      state.lastTasksFingerprint = null;
      updateActiveTab();
      if (state.isConnected) syncFromHost(); else renderTasks();
    });
    elements.listPillsRow.appendChild(projBtn);
  });
}

function updateActiveTab() {
  const buttons = elements.listPillsRow.querySelectorAll('.pill-tab');
  buttons.forEach((btn, idx) => {
    if (idx === 0) {
      btn.classList.toggle('active', state.currentTab === 'today');
    } else {
      const proj = state.projects[idx - 1];
      btn.classList.toggle('active', proj && state.currentTab === proj.id);
    }
  });

  if (state.currentTab === 'today') {
    elements.quickAddInput.placeholder = '+ 添加任务到 [今日] (回车提交)...';
  } else {
    const currentProj = state.projects.find((p) => p.id === state.currentTab);
    const name = currentProj ? currentProj.title : '项目';
    elements.quickAddInput.placeholder = `+ 添加任务到 [${name}] (回车提交)...`;
  }
}

// ── Start/Stop Polling ──
function startPolling() {
  if (state.isPolling) return;
  state.isPolling = true;
  syncFromHost();
  setInterval(() => {
    syncFromHost();
  }, 2000); // 2-second real-time sync with Super Productivity
}

// ── Focus Timer Engine ──
function formatTime(totalSeconds) {
  const m = Math.floor(Math.max(0, totalSeconds) / 60);
  const s = Math.floor(Math.max(0, totalSeconds) % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Helper to set text only if changed to avoid browser repainting
function setText(el, val) {
  if (el && el.textContent !== val) {
    el.textContent = val;
  }
}

function updateTimerDisplay() {
  const timeStr = formatTime(state.timer.remainingSeconds);

  // Expanded View
  setText(elements.focusTimerText, timeStr);
  setText(elements.focusModeBadge, state.timer.mode);
  elements.focusModeBadge.className = `focus-badge ${state.timer.mode.toLowerCase()}`;
  setText(elements.focusCycleText, `#${state.timer.cycle}`);

  const currentTitle = state.currentTask
    ? state.currentTask.title
    : state.timer.mode === 'BREAK'
      ? '休息与走动中'
      : '未开始专注任务';

  setText(elements.focusTaskTitle, currentTitle);

  // Mini Bar View (Clean plain text, no emoji)
  setText(elements.miniTimerText, timeStr);
  setText(elements.miniTaskTitle, state.currentTask ? state.currentTask.title : currentTitle);
  elements.miniTaskTitle.title = state.currentTask ? state.currentTask.title : currentTitle;

  // Buttons icon
  const playIcon = state.timer.isRunning ? '⏸' : '▶';
  setText(elements.btnTimerToggle, playIcon);

  if (state.timer.isRunning) {
    elements.btnTimerToggle.classList.add('running');
  } else {
    elements.btnTimerToggle.classList.remove('running');
  }

  // If currently collapsed, dynamically adapt mini-bar width to new text length
  if (state.isCollapsed && window.widgetAPI?.updateMiniWidth) {
    const targetW = calculateMiniBarWidth();
    window.widgetAPI.updateMiniWidth(targetW);
  }
}

function startTimer() {
  if (state.timer.isRunning) return;
  state.timer.isRunning = true;
  updateTimerDisplay();

  if (state.timer.timerInterval) clearInterval(state.timer.timerInterval);
  state.timer.timerInterval = setInterval(() => {
    if (state.timer.remainingSeconds > 0) {
      state.timer.remainingSeconds -= 1;
      updateTimerDisplay();
    } else {
      clearInterval(state.timer.timerInterval);
      state.timer.isRunning = false;

      if (state.timer.mode === 'FOCUS') {
        state.timer.mode = 'BREAK';
        state.timer.remainingSeconds = 5 * 60;
        showNotification('专注达成 🎉', '专注周期已完成！休息 5 分钟吧。');
      } else {
        state.timer.mode = 'FOCUS';
        state.timer.cycle += 1;
        state.timer.remainingSeconds = 25 * 60;
        showNotification('休息结束 ⚡', '准备好开始下一个专注周期了吗？');
      }
      updateTimerDisplay();
    }
  }, 1000);
}

function pauseTimer() {
  state.timer.isRunning = false;
  if (state.timer.timerInterval) {
    clearInterval(state.timer.timerInterval);
    state.timer.timerInterval = null;
  }
  updateTimerDisplay();
}

function resetTimer() {
  pauseTimer();
  state.timer.remainingSeconds = state.timer.mode === 'FOCUS' ? 25 * 60 : 5 * 60;
  updateTimerDisplay();
}

// ── Centralized Stop Focus Function (Syncs with Super Productivity) ──
async function stopCurrentTask() {
  lastUserStopTimestamp = Date.now();
  state.currentTaskId = null;
  state.currentTask = null;
  pauseTimer();
  resetTimer();
  state.lastTasksFingerprint = null;
  renderUI();

  if (state.isConnected) {
    try {
      // 1. Call /task-control/stop with JSON body {}
      await apiRequest('/task-control/stop', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } catch (_e) {
      try {
        // 2. Fallback to /task-control/current with taskId: null
        await apiRequest('/task-control/current', {
          method: 'POST',
          body: JSON.stringify({ taskId: null }),
        });
      } catch (err) {
        console.warn('Failed to stop task on host:', err.message);
      }
    }
  }
}

// ── Task Actions ──
async function toggleTaskDone(task) {
  const newDone = !task.isDone;
  state.lastTasksFingerprint = null;

  if (state.isConnected) {
    try {
      await apiRequest(`/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDone: newDone }),
      });
      syncFromHost();
    } catch (err) {
      console.error('Failed to toggle task:', err);
    }
  } else {
    task.isDone = newDone;
    renderTasks();
  }
}

// ── 点击任务播放按钮开始专注并计时 ──
async function setCurrentTask(task) {
  // If clicking on already current task, stop focusing on it in both widget & host
  if (state.currentTaskId === task.id) {
    await stopCurrentTask();
    return;
  }

  // 1. Instantly update local state & start timer with 0ms latency
  state.currentTaskId = task.id;
  state.currentTask = task;
  if (state.timer.remainingSeconds <= 0) {
    state.timer.remainingSeconds = 25 * 60;
  }
  startTimer();
  state.lastTasksFingerprint = null;
  renderUI();

  // 2. Sync to Super Productivity via REST API (uses taskId: task.id)
  if (state.isConnected) {
    try {
      await apiRequest('/task-control/current', {
        method: 'POST',
        body: JSON.stringify({
          taskId: task.id,
          id: task.id,
        }),
      });
    } catch (err) {
      console.warn('Failed to set current task on host:', err.message);
    }
  }
}

// ── Quick Add Task ──
async function handleAddTask(title) {
  if (!title.trim()) return;

  const body = { title: title.trim() };
  if (state.currentTab === 'today') {
    body.tagIds = ['TODAY'];
  } else {
    body.projectId = state.currentTab;
  }

  state.lastTasksFingerprint = null;

  if (state.isConnected) {
    try {
      await apiRequest('/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      syncFromHost();
    } catch (err) {
      console.error('Failed to add task:', err);
    }
  } else {
    state.tasks.unshift({
      id: `local-${Date.now()}`,
      title: body.title,
      isDone: false,
      timeSpent: 0,
      timeEstimate: 0,
      projectId: body.projectId || null,
      tagIds: body.tagIds || [],
    });
    renderTasks();
  }
}

// ── Task Sorting Rule (未完成在前，已安排时间优先升序，无时间最新创建在前，已完成沉底) ──
function getTaskScheduledTime(task) {
  if (typeof task.dueWithTime === 'number' && task.dueWithTime > 0) return task.dueWithTime;
  if (typeof task.remindAt === 'number' && task.remindAt > 0) return task.remindAt;
  if (typeof task.deadlineWithTime === 'number' && task.deadlineWithTime > 0) return task.deadlineWithTime;
  if (task.dueDay && typeof task.dueDay === 'string') {
    const t = new Date(task.dueDay).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (task.deadlineDay && typeof task.deadlineDay === 'string') {
    const t = new Date(task.deadlineDay).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (typeof task.plannedAt === 'number' && task.plannedAt > 0) return task.plannedAt;
  return null;
}

function compareTasks(a, b) {
  // 1. 未完成排在最前，已完成自动沉底
  if (a.isDone !== b.isDone) {
    return a.isDone ? 1 : -1;
  }

  // 2. 时间排序判定
  const timeA = getTaskScheduledTime(a);
  const timeB = getTaskScheduledTime(b);

  const hasTimeA = timeA !== null;
  const hasTimeB = timeB !== null;

  // 2.1 优先排已安排时间的任务
  if (hasTimeA !== hasTimeB) {
    return hasTimeA ? -1 : 1;
  }

  // 2.2 两者都有安排时间：按照安排的时间从上到下排序（较早的时间在上，升序）
  if (hasTimeA && hasTimeB) {
    if (timeA !== timeB) {
      return timeA - timeB;
    }
  }

  // 2.3 两者都没有安排时间：按照最新创建的在上排序（创建时间倒序）
  const createdA = typeof a.created === 'number'
    ? a.created
    : (typeof a.id === 'string' && a.id.startsWith('local-') ? parseInt(a.id.replace('local-', ''), 10) : 0);
  const createdB = typeof b.created === 'number'
    ? b.created
    : (typeof b.id === 'string' && b.id.startsWith('local-') ? parseInt(b.id.replace('local-', ''), 10) : 0);

  if (createdA !== createdB) {
    return createdB - createdA;
  }

  return 0;
}

// ── Today Task Detection (Matches Super Productivity Virtual Tag Pattern) ──
function getTodayDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isTaskForToday(task) {
  // 1. Explicit TODAY tag
  if (task.tagIds && task.tagIds.includes('TODAY')) return true;

  const todayStr = getTodayDateStr();

  // 2. All-day scheduled date
  if (task.dueDay && task.dueDay === todayStr) return true;

  // 3. Specific-time scheduled task (dueWithTime: e.g. "Later Today / 今天晚些时候")
  if (typeof task.dueWithTime === 'number' && task.dueWithTime > 0) {
    const d = new Date(task.dueWithTime);
    const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
    if (dateStr === todayStr) return true;
  }

  // 4. Deadlines
  if (task.deadlineDay && task.deadlineDay === todayStr) return true;
  if (typeof task.deadlineWithTime === 'number' && task.deadlineWithTime > 0) {
    const d = new Date(task.deadlineWithTime);
    const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
    if (dateStr === todayStr) return true;
  }

  return false;
}

// ── Render Tasks (Anti-flicker: Only update DOM if task list data actually changed) ──
function renderTasks() {
  let filtered = state.tasks;

  if (state.currentTab === 'today') {
    // If connected, REST API (/tasks?tagId=TODAY) already returns all today tasks;
    // For local demo or fallback safety, use isTaskForToday which supports dueWithTime!
    filtered = state.isConnected ? state.tasks : state.tasks.filter(isTaskForToday);
  } else {
    filtered = state.tasks.filter((t) => t.projectId === state.currentTab);
  }

  // Compute fingerprint of current task list state
  const fingerprint = `${state.currentTab}|${state.currentTaskId}|` +
    filtered.map((t) => `${t.id}:${t.isDone}:${t.timeSpent}:${t.title}`).join('|');

  // Anti-flicker check: if nothing changed, SKIP DOM reconstruction completely!
  if (fingerprint === state.lastTasksFingerprint && elements.tasksContainer.children.length > 0) {
    return;
  }
  state.lastTasksFingerprint = fingerprint;

  setText(elements.taskStatsText, `${filtered.length} 个任务 (${filtered.filter((t) => t.isDone).length} 已完成)`);

  if (filtered.length === 0) {
    elements.tasksContainer.innerHTML = `<div class="empty-state">当前列表没有任务 ✨<br><span style="font-size: 11px; color: var(--text-dim);">可在下方回车快速添加</span></div>`;
    return;
  }

  elements.tasksContainer.innerHTML = '';

  const taskMap = new Map(filtered.map((t) => [t.id, t]));
  const renderedIds = new Set();

  function createTaskItem(task, isSubtask = false) {
    const isCurrent = state.currentTaskId === task.id;
    const item = document.createElement('div');
    item.className = `task-item ${isSubtask ? 'subtask' : ''} ${task.isDone ? 'done' : ''} ${isCurrent ? 'is-current' : ''}`;

    const spentMin = Math.round((task.timeSpent || 0) / 60000);
    const estMin = Math.round((task.timeEstimate || 0) / 60000);
    const timeBadge = estMin > 0 ? `${spentMin}m / ${estMin}m` : spentMin > 0 ? `${spentMin}m` : '';

    const directChildren = filtered.filter((t) => t.parentId === task.id);
    const subtaskBadge = directChildren.length > 0
      ? `<span class="tag-badge">${directChildren.filter((s) => s.isDone).length}/${directChildren.length} 子任务</span>`
      : '';

    // Scheduled time badge if present
    let scheduleBadge = '';
    if (typeof task.dueWithTime === 'number' && task.dueWithTime > 0) {
      const d = new Date(task.dueWithTime);
      const hours = d.getHours().toString().padStart(2, '0');
      const mins = d.getMinutes().toString().padStart(2, '0');
      scheduleBadge = `<span class="tag-badge" style="color: #67e8f9;">🕒 ${hours}:${mins}</span>`;
    } else if (task.dueDay) {
      scheduleBadge = `<span class="tag-badge" style="color: #67e8f9;">📅 ${task.dueDay.slice(5)}</span>`;
    }

    const prefix = isSubtask ? '<span class="subtask-branch-icon">↳</span>' : '';

    item.innerHTML = `
      <div class="task-checkbox ${task.isDone ? 'checked' : ''}" title="${task.isDone ? '标记为未完成' : '完成任务'}"></div>
      <div class="task-content">
        <div class="task-title-line" title="${task.title}">
          ${prefix}${task.title}
        </div>
        <div class="task-meta-line">
          ${scheduleBadge}
          ${timeBadge ? `<span class="tag-badge">⏱ ${timeBadge}</span>` : ''}
          ${subtaskBadge}
          ${isCurrent ? '<span class="tag-badge" style="color: var(--accent-light);">● 专注中</span>' : ''}
        </div>
      </div>
      <button class="task-action-btn" title="${isCurrent ? '停止专注' : '点击开始专注此任务'}">
        ${isCurrent ? '⏹' : '▶'}
      </button>
    `;

    // Checkbox click
    const checkbox = item.querySelector('.task-checkbox');
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTaskDone(task);
    });

    // Play/Focus button click
    const playBtn = item.querySelector('.task-action-btn');
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setCurrentTask(task);
    });

    item.addEventListener('click', () => {
      setCurrentTask(task);
    });

    return item;
  }

  // 1. Group & Sort root tasks according to requested hierarchy
  const rootTasks = filtered.filter((t) => !t.parentId || !taskMap.has(t.parentId));
  rootTasks.sort(compareTasks);

  rootTasks.forEach((task) => {
    elements.tasksContainer.appendChild(createTaskItem(task, false));
    renderedIds.add(task.id);

    // Subtasks for this parent, also sorted by the exact same rule!
    const children = filtered.filter((t) => t.parentId === task.id);
    children.sort(compareTasks);
    children.forEach((child) => {
      elements.tasksContainer.appendChild(createTaskItem(child, true));
      renderedIds.add(child.id);
    });
  });

  // 2. Any remaining orphaned tasks, sorted as well
  const orphanedTasks = filtered.filter((t) => !renderedIds.has(t.id));
  orphanedTasks.sort(compareTasks);
  orphanedTasks.forEach((task) => {
    elements.tasksContainer.appendChild(createTaskItem(task, !!task.parentId));
    renderedIds.add(task.id);
  });
}

function renderUI() {
  updateTimerDisplay();
  renderTasks();
}

// ── Event Bindings ──
function initEvents() {
  // Edge Snapped detection
  if (window.widgetAPI?.onEdgeSnapped) {
    window.widgetAPI.onEdgeSnapped((edge) => {
      state.isSnappedToEdge = !!edge;
      if (edge) {
        elements.appWindow.classList.add('edge-snapped');
      } else {
        elements.appWindow.classList.remove('edge-snapped');
      }
    });
  }

  // OS-level Collapsed status sync from main process
  if (window.widgetAPI?.onCollapsedChanged) {
    window.widgetAPI.onCollapsedChanged((collapsed) => {
      state.isCollapsed = collapsed;
      if (collapsed) {
        elements.appWindow.classList.add('collapsed');
      } else {
        elements.appWindow.classList.remove('collapsed');
      }
    });
  }

  // 点击小横条直接展开
  elements.miniBar.addEventListener('click', () => {
    expandToFull();
  });

  // Window Controls
  elements.btnPin.addEventListener('click', async () => {
    if (window.widgetAPI?.togglePin) {
      const isPinned = await window.widgetAPI.togglePin();
      elements.btnPin.classList.toggle('pinned', isPinned);
    }
  });

  elements.btnMinimize.addEventListener('click', () => {
    window.widgetAPI?.minimize();
  });

  elements.btnClose.addEventListener('click', () => {
    window.widgetAPI?.close();
  });

  // Timer Controls (Focus Card Play/Pause stops focus on both widget and Super Productivity!)
  elements.btnTimerToggle.addEventListener('click', async () => {
    if (state.timer.isRunning || state.currentTaskId) {
      await stopCurrentTask();
    } else {
      if (state.currentTask) {
        await setCurrentTask(state.currentTask);
      } else if (state.tasks.length > 0) {
        await setCurrentTask(state.tasks[0]);
      } else {
        startTimer();
      }
    }
  });

  elements.btnTimerReset.addEventListener('click', async () => {
    await stopCurrentTask();
  });

  elements.btnRefresh.addEventListener('click', () => {
    state.lastTasksFingerprint = null;
    syncFromHost();
  });

  // Quick Add
  elements.quickAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = elements.quickAddInput.value;
    if (val.trim()) {
      handleAddTask(val);
      elements.quickAddInput.value = '';
    }
  });

  // Settings Modal
  elements.btnSettings.addEventListener('click', () => {
    elements.cfgServerUrl.value = state.config.serverUrl;
    elements.cfgToken.value = state.config.token || '';
    elements.cfgOpacity.value = Math.round(state.config.opacity * 100);
    elements.opacityValText.textContent = `${Math.round(state.config.opacity * 100)}%`;
    elements.cfgSnapEdge.checked = !!state.config.snapToEdge;
    elements.cfgAutoCollapse.checked = !!state.config.autoCollapseOnEdge;
    elements.cfgSound.checked = !!state.config.sound;
    elements.settingsModal.classList.add('open');
  });

  elements.btnCloseSettings.addEventListener('click', () => {
    elements.settingsModal.classList.remove('open');
  });

  elements.btnCancelSettings.addEventListener('click', () => {
    elements.settingsModal.classList.remove('open');
  });

  elements.cfgOpacity.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    elements.opacityValText.textContent = `${val}%`;
    if (window.widgetAPI?.setOpacity) {
      window.widgetAPI.setOpacity(val / 100);
    }
  });

  elements.btnDetectToken.addEventListener('click', async () => {
    if (window.widgetAPI?.autoDetectToken) {
      const res = await window.widgetAPI.autoDetectToken();
      if (res.found && res.token) {
        elements.cfgToken.value = res.token;
        showNotification('已自动检测到 Token', `来自: ${res.path}`);
      } else {
        showNotification('未找到 Token 文件', '请在 Super Productivity 设置中开启 Local REST API 并复制 Token');
      }
    }
  });

  elements.btnSaveSettings.addEventListener('click', async () => {
    const newCfg = {
      serverUrl: elements.cfgServerUrl.value.trim(),
      token: elements.cfgToken.value.trim(),
      opacity: parseInt(elements.cfgOpacity.value, 10) / 100,
      snapToEdge: elements.cfgSnapEdge.checked,
      autoCollapseOnEdge: elements.cfgAutoCollapse.checked,
      sound: elements.cfgSound.checked,
    };

    state.config = { ...state.config, ...newCfg };
    if (window.widgetAPI?.saveConfig) {
      await window.widgetAPI.saveConfig(newCfg);
    }

    elements.settingsModal.classList.remove('open');
    state.lastTasksFingerprint = null;
    syncFromHost();
  });
}

// ── Startup ──
async function init() {
  initEvents();

  if (window.widgetAPI?.getConfig) {
    const saved = await window.widgetAPI.getConfig();
    state.config = { ...state.config, ...saved };
  }

  if (!state.config.token && window.widgetAPI?.autoDetectToken) {
    const detected = await window.widgetAPI.autoDetectToken();
    if (detected.found && detected.token) {
      state.config.token = detected.token;
      if (window.widgetAPI?.saveConfig) {
        window.widgetAPI.saveConfig({ token: detected.token });
      }
    }
  }

  updateActiveTab();
  updateTimerDisplay();
  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
