// ── Storage ────────────────────────────────────────────────────────────────
function loadTasks() {
  try { return JSON.parse(localStorage.getItem('taskflow-tasks') || '[]'); } catch { return []; }
}
function saveTasks(tasks) {
  localStorage.setItem('taskflow-tasks', JSON.stringify(tasks));
}

// ── Colours ────────────────────────────────────────────────────────────────
const TASK_COLORS = [
  '#60a5fa','#a78bfa','#f472b6','#4ade80',
  '#fbbf24','#22d3ee','#2dd4bf','#fb7185',
  '#818cf8','#fb923c'
];
let colorIndex = 0;
function nextTaskColor() { return TASK_COLORS[colorIndex++ % TASK_COLORS.length]; }
function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

// ── State ──────────────────────────────────────────────────────────────────
let tasks = [];
let filter = 'all';
let search = '';
let blinkingIds = new Set();
let alarmFiredIds = new Set();
let modalPriority = 'medium';
let modalReminderOn = true;
let editingTaskId = null;

const $ = id => document.getElementById(id);
const app = document.getElementById('app');

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  buildUI();
  tasks = loadTasks();

  let colorsAdded = false;
  tasks = tasks.map(t => { if (!t.color) { colorsAdded = true; return { ...t, color: nextTaskColor() }; } return t; });
  if (colorsAdded) saveTasks(tasks);

  tasks.forEach(t => {
    if (t.alarmTriggered && !t.completed) {
      blinkingIds.add(t.id);
      alarmFiredIds.add(t.id);
    }
  });

  render();
  startAlarmChecker();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  requestNotificationPermission();
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ── Alarm checker ──────────────────────────────────────────────────────────
function startAlarmChecker() {
  const check = () => {
    const now = new Date();
    tasks.forEach(t => {
      if (t.completed || !t.reminderEnabled || !t.dueDate) return;
      if (alarmFiredIds.has(t.id) || t.alarmTriggered) return;
      const dueStr = t.dueDate + (t.dueTime ? 'T' + t.dueTime : 'T00:00');
      if (new Date(dueStr) <= now) {
        alarmFiredIds.add(t.id);
        blinkingIds.add(t.id);
        t.alarmTriggered = true;
        playAlarm();
        if (Notification.permission === 'granted') {
          new Notification('⏰ TaskFlow Reminder', { body: t.title, icon: './icon-192.png' });
        }
      }
    });
    saveTasks(tasks);
    render();
  };
  check();
  setInterval(check, 30000);
}

function playAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.38, 0.76].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime + offset);
      osc.frequency.linearRampToValueAtTime(660, ctx.currentTime + offset + 0.18);
      gain.gain.setValueAtTime(0, ctx.currentTime + offset);
      gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + offset + 0.03);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + offset + 0.32);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.35);
    });
  } catch(e) {}
}

// ── Derived data ───────────────────────────────────────────────────────────
function getStats() {
  const now = new Date();
  return {
    total: tasks.length,
    active: tasks.filter(t => !t.completed).length,
    done: tasks.filter(t => t.completed).length,
    overdue: tasks.filter(t => {
      if (t.completed || !t.dueDate) return false;
      return new Date(t.dueDate + (t.dueTime ? 'T' + t.dueTime : 'T00:00')) < now;
    }).length
  };
}

function getFiltered() {
  const now = new Date();
  return tasks.filter(t => {
    const q = search.toLowerCase();
    const match = t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);
    if (!match) return false;
    if (filter === 'active') return !t.completed;
    if (filter === 'completed') return t.completed;
    if (filter === 'overdue') {
      if (t.completed || !t.dueDate) return false;
      return new Date(t.dueDate + (t.dueTime ? 'T' + t.dueTime : 'T00:00')) < now;
    }
    return true;
  });
}

function formatDue(dueDate, dueTime) {
  if (!dueDate) return null;
  const due = new Date(dueDate + (dueTime ? 'T' + dueTime : 'T00:00'));
  const now = new Date();
  const diffH = (due - now) / 3600000;
  const dateStr = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeStr = dueTime ? due.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
  return { label: [dateStr, timeStr].filter(Boolean).join(' · '), isOverdue: due < now, isSoon: due >= now && diffH < 24 };
}

// ── Build UI ───────────────────────────────────────────────────────────────
function buildUI() {
  app.innerHTML = `
    <div id="titlebar">
      <div class="logo">
        <span class="logo-icon">✅</span>
        <div>
          <div class="logo-text">TaskFlow</div>
          <div class="logo-sub">Todo & Reminders</div>
        </div>
      </div>
    </div>

    <div id="add-bar">
      <input class="glass-input" id="quick-input" placeholder="Add a task… (tap + for details)" />
      <button class="btn-add" id="btn-add-full">+</button>
    </div>

    <div id="search-wrap">
      <input id="search-input" placeholder="🔍 Search tasks…" />
    </div>

    <div id="stats-strip">
      <div class="stat-pill"><div class="num" id="stat-total">0</div><div class="lbl">Total</div></div>
      <div class="stat-pill"><div class="num" id="stat-active" style="color:#93c5fd">0</div><div class="lbl">Active</div></div>
      <div class="stat-pill"><div class="num" id="stat-done" style="color:#86efac">0</div><div class="lbl">Done</div></div>
      <div class="stat-pill"><div class="num" id="stat-overdue" style="color:#fca5a5">0</div><div class="lbl">Overdue</div></div>
    </div>

    <div id="filter-row">
      <button class="filter-tab active" data-filter="all">📋 All</button>
      <button class="filter-tab" data-filter="active">⚡ Active</button>
      <button class="filter-tab" data-filter="completed">✅ Done</button>
      <button class="filter-tab" data-filter="overdue">⚠️ Overdue</button>
    </div>

    <div id="body"><div id="task-list"></div></div>

    <div id="bottom-bar">
      <span class="bottom-count" id="bottom-count"></span>
      <button class="btn-clear" id="btn-clear">Clear completed</button>
    </div>

    <div id="modal-overlay" class="hidden">
      <div id="modal-box">
        <div class="modal-handle"></div>
        <div class="modal-title" id="modal-title">✨ New Task</div>
        <div class="field-row">
          <label class="field-label">Title *</label>
          <input class="field-input" id="m-title" placeholder="What needs to be done?" />
        </div>
        <div class="field-row">
          <label class="field-label">Description</label>
          <input class="field-input" id="m-desc" placeholder="Optional notes…" />
        </div>
        <div class="field-row">
          <label class="field-label">Priority</label>
          <div class="priority-btns">
            <button class="prio-btn" data-p="high">🔴 High</button>
            <button class="prio-btn active-medium" data-p="medium">🟡 Medium</button>
            <button class="prio-btn" data-p="low">🟢 Low</button>
          </div>
        </div>
        <div class="field-grid">
          <div>
            <label class="field-label">Due Date</label>
            <input class="field-input" type="date" id="m-date" />
          </div>
          <div>
            <label class="field-label">Due Time</label>
            <input class="field-input" type="time" id="m-time" />
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">🔔 Enable reminder</span>
          <button class="toggle-switch on" id="m-reminder"><div class="toggle-knob"></div></button>
        </div>
        <div class="modal-btns">
          <button class="btn-cancel" id="m-cancel">Cancel</button>
          <button class="btn-save" id="m-save">Add Task</button>
        </div>
      </div>
    </div>
  `;

  $('quick-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.value.trim()) { addQuickTask(e.target.value.trim()); e.target.value = ''; }
  });
  $('btn-add-full').addEventListener('click', () => openModal(null));
  $('search-input').addEventListener('input', e => { search = e.target.value; render(); });
  $('filter-row').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab');
    if (!btn) return;
    filter = btn.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    render();
  });
  $('btn-clear').addEventListener('click', () => { tasks = tasks.filter(t => !t.completed); saveTasks(tasks); render(); });
  $('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });
  $('m-cancel').addEventListener('click', closeModal);
  $('m-save').addEventListener('click', saveModal);
  $('m-title').addEventListener('keydown', e => { if (e.key === 'Enter') saveModal(); });
  document.querySelectorAll('.prio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modalPriority = btn.dataset.p;
      document.querySelectorAll('.prio-btn').forEach(b => b.className = 'prio-btn');
      btn.classList.add('active-' + modalPriority);
    });
  });
  $('m-reminder').addEventListener('click', () => {
    modalReminderOn = !modalReminderOn;
    $('m-reminder').className = 'toggle-switch ' + (modalReminderOn ? 'on' : 'off');
  });
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const stats = getStats();
  $('stat-total').textContent = stats.total;
  $('stat-active').textContent = stats.active;
  $('stat-done').textContent = stats.done;
  $('stat-overdue').textContent = stats.overdue;

  const filtered = getFiltered();
  $('bottom-count').textContent = filtered.length + ' task' + (filtered.length !== 1 ? 's' : '');

  const list = $('task-list');
  if (filtered.length === 0) {
    const msgs = { all: 'No tasks yet. Tap + to add one!', active: 'No active tasks — great work!', completed: 'Nothing completed yet.', overdue: "You're all caught up! 🎉" };
    const icons = { all: '📝', active: '⚡', completed: '🎉', overdue: '✨' };
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">${icons[filter]}</span>${search ? 'No tasks match your search.' : msgs[filter]}</div>`;
    return;
  }

  list.innerHTML = filtered.map(t => renderCard(t)).join('');
  list.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => toggleTask(el.dataset.toggle)));
  list.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openModal(el.dataset.edit)));
  list.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', () => deleteTask(el.dataset.delete)));
  list.querySelectorAll('[data-dismiss]').forEach(el => el.addEventListener('click', () => dismissAlarm(el.dataset.dismiss)));
}

function renderCard(t) {
  const due = t.dueDate ? formatDue(t.dueDate, t.dueTime) : null;
  const isBlinking = blinkingIds.has(t.id);
  const dueClass = due ? (due.isOverdue ? 'overdue' : due.isSoon ? 'soon' : '') : '';
  const priorityMap = { high: 'badge-high', medium: 'badge-medium', low: 'badge-low' };
  const priorityIcon = { high: '🔴', medium: '🟡', low: '🟢' };
  const col = t.color || '#a0a8c0';
  const [r, g, b] = hexToRgb(col);
  const colorStyle = ` style="background:rgba(${r},${g},${b},0.38);border:2px solid rgba(${r},${g},${b},0.90);"`;

  return `
    <div class="task-card ${t.completed ? 'completed' : ''} ${isBlinking ? 'blinking' : ''}"${colorStyle}>
      <div class="card-row">
        <div class="checkbox ${t.completed ? 'checked' : ''}" data-toggle="${t.id}"></div>
        <div class="card-content">
          <div class="card-title ${t.completed ? 'done' : ''}">${escHtml(t.title)}</div>
          ${t.description ? `<div class="card-desc">${escHtml(t.description)}</div>` : ''}
          <div class="card-meta">
            <span class="badge ${priorityMap[t.priority]}">${priorityIcon[t.priority]} ${t.priority}</span>
            ${due ? `<span class="due-label ${dueClass}">🕐 ${due.label}${due.isOverdue && !t.completed ? ' <span class="badge badge-overdue">Overdue</span>' : ''}${due.isSoon && !due.isOverdue && !t.completed ? ' <span class="badge badge-soon">Soon</span>' : ''}</span>` : ''}
            ${t.reminderEnabled && !t.completed ? `<span style="color:rgba(255,255,255,0.30);font-size:12px">🔔</span>` : ''}
          </div>
          ${isBlinking ? `
            <div class="alarm-banner">
              <span class="alarm-text">⏰ Reminder! Task is due</span>
              <button class="alarm-dismiss" data-dismiss="${t.id}">Dismiss</button>
            </div>` : ''}
        </div>
        <div class="card-actions">
          <button class="card-btn" data-edit="${t.id}">✏️</button>
          <button class="card-btn del" data-delete="${t.id}">🗑</button>
        </div>
      </div>
    </div>`;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Task operations ────────────────────────────────────────────────────────
function addQuickTask(title) {
  tasks.unshift({ id: crypto.randomUUID(), title, description: '', priority: 'medium',
    completed: false, createdAt: Date.now(), dueDate: '', dueTime: '',
    reminderEnabled: false, alarmTriggered: false, color: nextTaskColor() });
  saveTasks(tasks); render();
}

function toggleTask(id) {
  tasks = tasks.map(t => t.id === id ? { ...t, completed: !t.completed } : t);
  blinkingIds.delete(id);
  saveTasks(tasks); render();
}

function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  blinkingIds.delete(id); alarmFiredIds.delete(id);
  saveTasks(tasks); render();
}

function dismissAlarm(id) { blinkingIds.delete(id); render(); }

// ── Modal ──────────────────────────────────────────────────────────────────
function openModal(taskId) {
  editingTaskId = taskId;
  const t = taskId ? tasks.find(x => x.id === taskId) : null;
  $('modal-title').textContent = t ? '✏️ Edit Task' : '✨ New Task';
  $('m-title').value = t ? t.title : '';
  $('m-desc').value = t ? (t.description || '') : '';
  $('m-date').value = t ? (t.dueDate || '') : '';
  $('m-time').value = t ? (t.dueTime || '') : '';
  $('m-save').textContent = t ? 'Save Changes' : 'Add Task';
  modalPriority = t ? t.priority : 'medium';
  modalReminderOn = t ? t.reminderEnabled : true;
  document.querySelectorAll('.prio-btn').forEach(b => {
    b.className = 'prio-btn' + (b.dataset.p === modalPriority ? ' active-' + modalPriority : '');
  });
  $('m-reminder').className = 'toggle-switch ' + (modalReminderOn ? 'on' : 'off');
  $('modal-overlay').classList.remove('hidden');
  setTimeout(() => $('m-title').focus(), 80);
}

function closeModal() { $('modal-overlay').classList.add('hidden'); editingTaskId = null; }

function saveModal() {
  const title = $('m-title').value.trim();
  if (!title) return;
  if (editingTaskId) {
    tasks = tasks.map(t => {
      if (t.id !== editingTaskId) return t;
      blinkingIds.delete(t.id); alarmFiredIds.delete(t.id);
      return { ...t, title, description: $('m-desc').value.trim(), priority: modalPriority,
        dueDate: $('m-date').value, dueTime: $('m-time').value, reminderEnabled: modalReminderOn, alarmTriggered: false };
    });
  } else {
    tasks.unshift({ id: crypto.randomUUID(), title, description: $('m-desc').value.trim(),
      priority: modalPriority, completed: false, createdAt: Date.now(),
      dueDate: $('m-date').value, dueTime: $('m-time').value,
      reminderEnabled: modalReminderOn, alarmTriggered: false, color: nextTaskColor() });
  }
  saveTasks(tasks); render(); closeModal();
}

init();
