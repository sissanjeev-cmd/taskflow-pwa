import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, deleteDoc, doc, getFirestore, onSnapshot, orderBy, query, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// ── Firebase init ──────────────────────────────────────────────────────────
const isConfigured = !firebaseConfig.apiKey.startsWith('REPLACE');
const fbApp = isConfigured ? initializeApp(firebaseConfig) : null;
const auth = isConfigured ? getAuth(fbApp) : null;
const db = isConfigured ? getFirestore(fbApp) : null;
const useLocal = !isConfigured;

// ── iOS / standalone detection ─────────────────────────────────────────────
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
const useRedirectAuth = isStandalone; // browser Safari can use popup; only standalone PWA needs redirect

const REDIRECT_PENDING_KEY = 'taskflow-redirect-pending';

function _friendlyAuthError(e) {
  if (!e) return 'Sign-in failed. Please try again.';
  switch (e.code) {
    case 'auth/network-request-failed':  return 'No internet connection. Please check your network.';
    case 'auth/popup-blocked':           return 'Popup was blocked. Redirecting to Google…';
    case 'auth/cancelled-popup-request':
    case 'auth/popup-closed-by-user':    return '';
    case 'auth/unauthorized-domain':     return 'This domain is not authorized. Contact support.';
    case 'auth/web-storage-unsupported': return 'Storage is blocked. Check Privacy settings.';
    default: return e.message || 'Sign-in failed. Please try again.';
  }
}

// ── Colours ────────────────────────────────────────────────────────────────
const TASK_COLORS = ['#60a5fa', '#a78bfa', '#f472b6', '#4ade80', '#fbbf24', '#22d3ee', '#2dd4bf', '#fb7185', '#818cf8', '#fb923c'];
let colorIndex = 0;
function nextColor() { return TASK_COLORS[colorIndex++ % TASK_COLORS.length]; }
function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// ── State ──────────────────────────────────────────────────────────────────
let currentUser = null;
let tasks = [];
let filter = 'all';
let search = '';
let blinkingIds = new Set();
let alarmFiredIds = new Set();
let modalPriority = 'medium';
let modalReminder = true;
let editingId = null;
let unsubSnapshot = null;
let pendingAlarms = [];
let alarmCtx = null;
let alarmInterval = null;
let mobileAudioNode = null;

// ── Docker API state ────────────────────────────────────────────────────────
let dockerConfig = null;
let useDocker = false;
let dockerSyncTimer = null;

function _getDockerConfig() { try { return JSON.parse(localStorage.getItem('taskflow-docker-config') || 'null'); } catch { return null; } }
function _saveDockerConfig(c) { localStorage.setItem('taskflow-docker-config', JSON.stringify(c)); }
function _clearDockerConfig() { localStorage.removeItem('taskflow-docker-config'); }

const $ = id => document.getElementById(id);
const app = document.getElementById('app');

// Robust local date parser avoiding web engine timezone evaluation pitfalls
function parseLocalDueDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hours, minutes] = timeStr ? timeStr.split(':').map(Number) : [0, 0];
    const parsedDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
    return isNaN(parsedDate.getTime()) ? null : parsedDate;
  } catch (e) {
    return null;
  }
}

// Global Audio Sandbox Unlocker for Mobile Safari
function _initAudio() {
  if (alarmCtx && alarmCtx.state !== 'closed') return;
  try {
    alarmCtx = new (window.AudioContext || window.webkitAudioContext)();
    alarmCtx.resume().catch(() => { });
    const silent = alarmCtx.createBuffer(1, 1, alarmCtx.sampleRate);
    const keep = alarmCtx.createBufferSource();
    keep.buffer = silent; keep.loop = true;
    keep.connect(alarmCtx.destination); keep.start(0);
  } catch (e) { }
}
document.addEventListener('touchstart', _initAudio, { passive: true });
document.addEventListener('click', _initAudio, { passive: true });

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Background Alarm Registration Delivery ────────────────────────────────
async function syncAlarmsToSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) return;
    const now = new Date().getTime();
    const alarms = tasks
      .filter(t => !t.completed && t.reminderEnabled && t.dueDate && !t.alarmTriggered)
      .map(t => {
        const localDate = parseLocalDueDateTime(t.dueDate, t.dueTime);
        return {
          id: t.id,
          title: t.title,
          description: t.description || '',
          dueAt: localDate ? localDate.toISOString() : new Date().toISOString(),
        };
      })
      .filter(a => new Date(a.dueAt).getTime() > now);
    reg.active.postMessage({ type: 'SCHEDULE_ALARMS', alarms });
  } catch (_) { }
}

async function init() {
  window.addEventListener('error', function (e) {
    alert("Runtime Error: " + e.message + " at " + e.filename + ":" + e.lineno);
  });

  const docCfg = _getDockerConfig();
  if (docCfg?.token) {
    dockerConfig = docCfg;
    useDocker = true;
    currentUser = { email: dockerConfig.email, displayName: dockerConfig.displayName || '' };
    try { tasks = await apiCall('GET', '/api/tasks'); }
    catch (e) { tasks = []; showToast('Cannot reach Docker API'); }
    tasks.forEach(t => { if (t.alarmTriggered && !t.completed) { blinkingIds.add(t.id); alarmFiredIds.add(t.id); } });
    buildApp(); startAlarmChecker(); startDockerSync();
    return;
  }

  if ('serviceWorker' in navigator) {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => { });
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
    navigator.serviceWorker.register('./sw.js').then(reg => {
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller)
            sw.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    }).catch(() => { });
  }

  app.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100dvh;color:rgba(255,255,255,0.5);font-size:16px;">Loading…</div>';

  if (useLocal) {
    try { tasks = JSON.parse(localStorage.getItem('taskflow-tasks') || '[]'); } catch { tasks = []; }
    let changed = false;
    tasks = tasks.map(t => { if (!t.color) { changed = true; return { ...t, color: nextColor() }; } return t; });
    if (changed) persistLocal();
    tasks.forEach(t => { if (t.alarmTriggered && !t.completed) { blinkingIds.add(t.id); alarmFiredIds.add(t.id); } });
    buildApp();
    startAlarmChecker();
    return;
  }

  const isRedirectReturn = !!localStorage.getItem(REDIRECT_PENDING_KEY);
  const loadingMsg = isRedirectReturn ? 'Completing sign-in…' : 'Loading…';
  app.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:rgba(255,255,255,0.5);font-size:16px;">${loadingMsg}</div>`;

  let redirectError = null;
  if (isRedirectReturn) {
    localStorage.removeItem(REDIRECT_PENDING_KEY);
    try {
      const result = await getRedirectResult(auth);
      if (!result) redirectError = 'Sign-in was interrupted. Please try again.';
    } catch (e) {
      console.error('Redirect result:', e.code, e.message);
      redirectError = _friendlyAuthError(e);
    }
  } else {
    try { await getRedirectResult(auth); } catch (e) { console.error('Redirect result:', e); }
  }

  onAuthStateChanged(auth, async user => {
    try {
      currentUser = user;
      if (user) {
        buildApp();
        startRealtimeSync();
        startAlarmChecker();
      } else {
        stopRealtimeSync();
        tasks = [];
        showAuthScreen(redirectError || '');
        redirectError = null;
      }
    } catch (e) {
      app.innerHTML = `<div style="padding:20px;text-align:center;color:#f87171;">Error: ${e.message}</div>`;
    }
  });
}

function persistLocal() { localStorage.setItem('taskflow-tasks', JSON.stringify(tasks)); syncAlarmsToSW(); }

// ── Auth Screen ────────────────────────────────────────────────────────────
const googleSvg = `<svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 14.021 17.64 11.712 17.64 9.2z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/><path d="M3.964 10.707A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/></svg>`;

function showAuthScreen(initialError = '') {
  app.innerHTML = `
    <div id="auth-screen">
      <div class="auth-card">
        <span class="auth-logo">✅</span>
        <h1 class="auth-title">TaskFlow</h1>
        <p class="auth-sub">Your tasks, everywhere</p>
        <button class="btn-google-signin" id="btn-signin">${googleSvg} Continue with Google</button>
        <p class="auth-error" id="auth-err">${escHtml(initialError)}</p>
        <div class="auth-divider-docker"><span>or</span></div>
        <button class="btn-docker-pwa" id="btn-docker-setup">🐳 Use self-hosted Docker</button>
      </div>
    </div>`;

  // Plain (non-async) handler — keeps the call synchronous with the user gesture.
  // Any await before signInWithPopup breaks iOS Safari's gesture chain and blocks the popup.
  $('btn-signin').addEventListener('click', () => {
    const errEl = $('auth-err');
    errEl.textContent = 'Opening Google sign-in…';
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    if (useRedirectAuth) {
      localStorage.setItem(REDIRECT_PENDING_KEY, '1');
      signInWithRedirect(auth, provider).catch(e => {
        localStorage.removeItem(REDIRECT_PENDING_KEY);
        errEl.textContent = _friendlyAuthError(e) || 'Could not start sign-in. Try again.';
      });
      return;
    }

    signInWithPopup(auth, provider).then(() => {
      errEl.textContent = '';
    }).catch(e => {
      if (e.code === 'auth/popup-blocked') {
        errEl.textContent = 'Popup blocked. Redirecting to Google…';
        localStorage.setItem(REDIRECT_PENDING_KEY, '1');
        signInWithRedirect(auth, provider).catch(e2 => {
          localStorage.removeItem(REDIRECT_PENDING_KEY);
          errEl.textContent = _friendlyAuthError(e2) || 'Sign-in failed. Please try again.';
        });
      } else {
        errEl.textContent = _friendlyAuthError(e);
      }
    });
  });
  $('btn-docker-setup').addEventListener('click', showDockerSetup);
}

function tasksCol() { return collection(db, 'users', currentUser.uid, 'tasks'); }

function startRealtimeSync() {
  stopRealtimeSync();
  const q = query(tasksCol(), orderBy('createdAt', 'desc'));
  unsubSnapshot = onSnapshot(q, snap => {
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    tasks.forEach(t => { if (t.alarmTriggered && !t.completed) { blinkingIds.add(t.id); alarmFiredIds.add(t.id); } });
    render();
    syncAlarmsToSW();
  });
}
function stopRealtimeSync() { if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; } }

async function saveTask(t) {
  if (useDocker) {
    const idx = tasks.findIndex(x => x.id === t.id);
    if (idx >= 0) tasks[idx] = t; else tasks.unshift(t);
    render();
    try { await apiCall('POST', '/api/tasks/' + t.id, t); } catch (e) { showToast('Sync error'); }
  } else if (useLocal) {
    const idx = tasks.findIndex(x => x.id === t.id);
    if (idx >= 0) tasks[idx] = t; else tasks.unshift(t);
    persistLocal(); render();
  } else {
    const { id, ...data } = t;
    await setDoc(doc(tasksCol(), id), data);
  }
}

async function removeTask(id) {
  if (useDocker) {
    tasks = tasks.filter(x => x.id !== id); render();
    try { await apiCall('DELETE', '/api/tasks/' + id); } catch (e) { showToast('Sync error'); }
  } else if (useLocal) {
    tasks = tasks.filter(x => x.id !== id); persistLocal(); render();
  } else {
    await deleteDoc(doc(tasksCol(), id));
  }
}

async function clearCompleted() {
  if (useDocker) {
    tasks = tasks.filter(t => !t.completed); render();
    try { await apiCall('DELETE', '/api/tasks?completed=true'); } catch (e) { showToast('Sync error'); }
  } else if (useLocal) {
    tasks = tasks.filter(t => !t.completed); persistLocal(); render();
  } else {
    tasks.filter(t => t.completed).forEach(t => deleteDoc(doc(tasksCol(), t.id)));
  }
}

// ── Docker Setup ───────────────────────────────────────────────────────────
function showDockerSetup() {
  app.innerHTML = `
    <div id="auth-screen">
      <div class="auth-card">
        <span class="auth-logo">🐳</span>
        <h1 class="auth-title" style="font-size:28px">Docker Setup</h1>
        <input class="auth-input-docker" id="docker-url" placeholder="API URL (http://localhost:3001)" value="http://localhost:3001" />
        <input class="auth-input-docker" id="docker-email" placeholder="Email" type="email" />
        <input class="auth-input-docker" id="docker-pass" placeholder="Password" type="password" />
        <button class="btn-docker-login-pwa" id="btn-docker-login">Sign In</button>
        <div class="auth-divider-docker"><span>new here?</span></div>
        <button class="btn-docker-secondary-pwa" id="btn-docker-register">Create Account</button>
        <p class="auth-error" id="docker-err"></p>
        <button class="btn-docker-pwa" id="btn-docker-back" style="margin-top:8px">← Back</button>
      </div>
    </div>`;
  $('btn-docker-back').addEventListener('click', showAuthScreen);
  $('btn-docker-login').addEventListener('click', () => {
    const url = ($('docker-url').value.trim() || 'http://localhost:3001').replace(/\/$/, '');
    dockerSignIn(url, $('docker-email').value.trim(), $('docker-pass').value);
  });
  $('btn-docker-register').addEventListener('click', () => {
    const url = ($('docker-url').value.trim() || 'http://localhost:3001').replace(/\/$/, '');
    dockerRegister(url, $('docker-email').value.trim(), $('docker-pass').value);
  });
}

async function apiCall(method, path, body) {
  const res = await fetch(dockerConfig.apiUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dockerConfig.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { dockerSignOut(); throw new Error('Session expired'); }
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
  return res.json();
}

async function dockerSignIn(apiUrl, email, password) {
  const errEl = $('docker-err'); if (errEl) errEl.textContent = 'Signing in…';
  try {
    const res = await fetch(apiUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Sign-in failed'; return; }
    dockerConfig = { apiUrl, token: data.token, email: data.email, displayName: data.displayName || '' };
    _saveDockerConfig(dockerConfig); useDocker = true;
    currentUser = { email: data.email, displayName: data.displayName || '' };
    tasks = await apiCall('GET', '/api/tasks');
    tasks.forEach(t => { if (t.alarmTriggered && !t.completed) { blinkingIds.add(t.id); alarmFiredIds.add(t.id); } });
    buildApp(); startAlarmChecker(); startDockerSync();
    showToast('🐳 Connected to Docker');
  } catch (e) { if (errEl) errEl.textContent = 'Connection failed: ' + e.message; }
}

async function dockerRegister(apiUrl, email, password) {
  const errEl = $('docker-err'); if (errEl) errEl.textContent = 'Registering…';
  try {
    const res = await fetch(apiUrl + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Registration failed'; return; }
    dockerConfig = { apiUrl, token: data.token, email: data.email, displayName: data.displayName || '' };
    _saveDockerConfig(dockerConfig); useDocker = true;
    currentUser = { email: data.email, displayName: data.displayName || '' }; tasks = [];
    buildApp(); startAlarmChecker(); startDockerSync();
    showToast('🐳 Account configured!');
  } catch (e) { if (errEl) errEl.textContent = 'Connection failed: ' + e.message; }
}

function dockerSignOut() {
  if (dockerSyncTimer) { clearInterval(dockerSyncTimer); dockerSyncTimer = null; }
  useDocker = false; dockerConfig = null; currentUser = null; tasks = [];
  _clearDockerConfig(); showAuthScreen();
}

function startDockerSync() {
  if (dockerSyncTimer) clearInterval(dockerSyncTimer);
  dockerSyncTimer = setInterval(async () => {
    if (!useDocker || !dockerConfig?.token) return;
    try {
      tasks = await apiCall('GET', '/api/tasks');
      tasks.forEach(t => { if (t.alarmTriggered && !t.completed) { blinkingIds.add(t.id); alarmFiredIds.add(t.id); } });
      render();
    } catch (_) { }
  }, 30000);
}

function showToast(msg) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(255,107,53,0.92);color:#fff;padding:9px 20px;border-radius:22px;font-size:14px;font-weight:600;z-index:9999;white-space:nowrap;backdrop-filter:blur(10px);box-shadow:0 4px 20px rgba(0,0,0,0.4);';
  el.textContent = msg; document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// ── Realtime Local Evaluation Loop ──────────────────────────────────────────
function startAlarmChecker() {
  if (alarmInterval) clearInterval(alarmInterval);

  const check = () => {
    const now = new Date();
    let stateChanged = false;

    tasks.forEach(t => {
      if (t.completed || !t.dueDate) return;

      const localDueDate = parseLocalDueDateTime(t.dueDate, t.dueTime);
      if (!localDueDate) return;

      const passedDeadline = localDueDate.getTime() <= now.getTime();
      const isCurrentlyMarkedOverdue = blinkingIds.has(t.id) || t.alarmTriggered;

      if (passedDeadline && !t.alarmTriggered) {
        t.alarmTriggered = true;
        stateChanged = true;

        if (t.reminderEnabled && !alarmFiredIds.has(t.id)) {
          alarmFiredIds.add(t.id);
          blinkingIds.add(t.id);
          fireAlarm(t);
        }
        saveTask(t);
      } else if (passedDeadline && !isCurrentlyMarkedOverdue) {
        stateChanged = true;
      }
    });

    if (stateChanged) {
      render();
    }
  };

  check();
  alarmInterval = setInterval(check, 3000);
}

function fireAlarm(t) {
  if (Notification.permission === 'granted') {
    new Notification('⏰ TaskFlow Reminder', {
      body: t.title,
      icon: './icon-192.png',
      requireInteraction: true
    });
  }
  pendingAlarms.push(t.id);
  startContinuousBeep();
  if (!document.getElementById('alarm-overlay')) showAlarmOverlay();
}

function startContinuousBeep() {
  if (mobileAudioNode) return;
  if (!alarmCtx) alarmCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (alarmCtx.state === 'suspended') alarmCtx.resume().catch(() => { });

  mobileAudioNode = setInterval(() => {
    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
    try {
      const now = alarmCtx.currentTime;
      const osc = alarmCtx.createOscillator();
      const gain = alarmCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.7, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.connect(gain);
      gain.connect(alarmCtx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
    } catch (e) { }
  }, 1500);
}

function stopContinuousBeep() {
  if (mobileAudioNode) { clearInterval(mobileAudioNode); mobileAudioNode = null; }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && alarmCtx && alarmCtx.state === 'suspended')
    alarmCtx.resume().catch(() => { });
});

function showAlarmOverlay() {
  const taskId = pendingAlarms.shift();
  if (!taskId) { stopContinuousBeep(); return; }
  const t = tasks.find(x => x.id === taskId);
  if (!t) { showAlarmOverlay(); return; }

  const prioIcon = { high: '🔴', medium: '🟡', low: '🟢' };
  let metaHtml = '';
  if (t.priority) metaHtml += `<span class="alarm-meta-prio alarm-prio-${t.priority}">${prioIcon[t.priority] || ''} ${t.priority}</span>`;
  if (t.dueDate) {
    const due = parseLocalDueDateTime(t.dueDate, t.dueTime);
    const dateStr = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = t.dueTime ? due.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    metaHtml += `<span class="alarm-meta-due">🕐 ${[dateStr, timeStr].filter(Boolean).join(' · ')}</span>`;
  }

  const ov = document.createElement('div');
  ov.id = 'alarm-overlay';
  ov.innerHTML = `
    <div class="alarm-box">
      <div class="alarm-icon">⏰</div>
      <div class="alarm-heading">Time's Up!</div>
      <div class="alarm-task-name">${escHtml(t.title)}</div>
      ${t.description ? `<div class="alarm-task-desc">${escHtml(t.description)}</div>` : ''}
      <div class="alarm-actions">
        <button class="alarm-btn alarm-snooze" id="alarm-snooze">😴 Snooze 5 min</button>
        <button class="alarm-btn alarm-stop"   id="alarm-stop">🛑 Stop Alarm</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(ov);

  document.getElementById('alarm-snooze').onclick = () => {
    const task = tasks.find(x => x.id === taskId);
    if (task) {
      const at = new Date(Date.now() + 5 * 60 * 1000);
      const p = n => n.toString().padStart(2, '0');
      const dd = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
      const dt = `${p(at.getHours())}:${p(at.getMinutes())}`;
      blinkingIds.delete(taskId); alarmFiredIds.delete(taskId);
      saveTask({ ...task, dueDate: dd, dueTime: dt, alarmTriggered: false });
    }
    ov.remove(); showAlarmOverlay();
  };

  document.getElementById('alarm-stop').onclick = () => {
    const task = tasks.find(x => x.id === taskId);
    if (task) { blinkingIds.delete(taskId); saveTask({ ...task, alarmTriggered: true }); }
    ov.remove(); showAlarmOverlay();
  };
}

// ── Derived Data Operations ──────────────────────────────────────────────────
function getStats() {
  const now = new Date().getTime();
  return {
    total: tasks.length, active: tasks.filter(t => !t.completed).length,
    done: tasks.filter(t => t.completed).length,
    overdue: tasks.filter(t => {
      if (t.completed || !t.dueDate) return false;
      const localDue = parseLocalDueDateTime(t.dueDate, t.dueTime);
      return localDue && localDue.getTime() < now;
    }).length
  };
}

function getFiltered() {
  const now = new Date().getTime();
  return tasks.filter(t => {
    const q = search.toLowerCase();
    if (!(t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))) return false;
    if (filter === 'active') return !t.completed;
    if (filter === 'completed') return t.completed;
    if (filter === 'overdue') {
      if (t.completed || !t.dueDate) return false;
      const localDue = parseLocalDueDateTime(t.dueDate, t.dueTime);
      return localDue && localDue.getTime() < now;
    }
    return true;
  });
}

function formatDue(dueDate, dueTime) {
  if (!dueDate) return null;
  const due = parseLocalDueDateTime(dueDate, dueTime);
  const now = new Date().getTime();
  if (!due) return null;

  return {
    label: [due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), dueTime ? due.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · '),
    isOverdue: due.getTime() < now,
    isSoon: due.getTime() >= now && (due.getTime() - now) / 3600000 < 24
  };
}

// ── Modal Window Window Management Functions ─────────────────────────────────
function openModal(id = null) {
  editingId = id;
  const overlay = $('modal-overlay');
  const mTitle = $('modal-title');
  const saveBtn = $('m-save');

  if (id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    mTitle.textContent = '✏️ Edit Task';
    $('m-title').value = t.title;
    $('m-desc').value = t.description || '';
    $('m-date').value = t.dueDate || '';
    $('m-time').value = t.dueTime || '';
    modalPriority = t.priority || 'medium';
    modalReminder = t.reminderEnabled !== false;
    saveBtn.textContent = 'Save Changes';
  } else {
    mTitle.textContent = '✨ New Task';
    $('m-title').value = '';
    $('m-desc').value = '';
    $('m-date').value = '';
    $('m-time').value = '';
    modalPriority = 'medium';
    modalReminder = true;
    saveBtn.textContent = 'Add Task';
  }

  document.querySelectorAll('.prio-btn').forEach(b => {
    b.classList.remove('active-high', 'active-medium', 'active-low');
    if (b.dataset.p === modalPriority) b.classList.add('active-' + modalPriority);
  });

  const rToggle = $('m-reminder');
  if (modalReminder) { rToggle.classList.add('on'); } else { rToggle.classList.remove('on'); }

  overlay.classList.remove('hidden');
}

function closeModal() {
  $('modal-overlay').classList.add('hidden');
  editingId = null;
}

// ── UI Builder ───────────────────────────────────────────────────────────────
function buildApp() {
  const u = currentUser;
  const av = u ? (u.displayName || u.email || '?')[0].toUpperCase() : null;

  app.innerHTML = `
    <div id="titlebar">
      <div class="logo">
        <span class="logo-icon">✅</span>
        <div><div class="logo-text">TaskFlow</div><div class="logo-sub">${u ? escHtml(u.email || '') : 'Todo &amp; Reminders'}</div></div>
      </div>
      <div class="header-actions">
        ${av ? `<div class="user-area"><div class="user-avatar">${av}</div><button class="btn-signout" id="btn-signout">Sign out</button></div>` : `<button class="btn-google-signin btn-signin-small" id="btn-signin-header">Sign In</button>`}
        <button class="ctrl-btn close-btn" id="btn-close-pwa">✕</button>
      </div>
    </div>
    <div id="add-bar">
      <input class="glass-input" id="quick-input" placeholder="Add a task…" />
      <button class="btn-add" id="btn-add-full">+</button>
    </div>
    <div id="search-wrap"><input id="search-input" placeholder="🔍 Search tasks…" /></div>
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
    <div id="bottom-bar"><span class="bottom-count" id="bottom-count"></span><button class="btn-clear" id="btn-clear">Clear completed</button></div>
    <div id="modal-overlay" class="hidden">
      <div id="modal-box">
        <div class="modal-handle"></div>
        <div class="modal-title" id="modal-title">✨ New Task</div>
        <div class="field-row"><label class="field-label">Title *</label><input class="field-input" id="m-title" /></div>
        <div class="field-row"><label class="field-label">Description</label><input class="field-input" id="m-desc" /></div>
        <div class="field-row">
          <label class="field-label">Priority</label>
          <div class="priority-btns">
            <button class="prio-btn" data-p="high">High</button>
            <button class="prio-btn active-medium" data-p="medium">Medium</button>
            <button class="prio-btn" data-p="low">Low</button>
          </div>
        </div>
        <div class="field-grid">
          <div><label class="field-label">Due Date</label><input class="field-input" type="date" id="m-date" /></div>
          <div><label class="field-label">Due Time</label><input class="field-input" type="time" id="m-time" /></div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">🔔 Enable reminder</span>
          <button class="toggle-switch on" id="m-reminder"><div class="toggle-knob"></div></button>
        </div>
        <div class="modal-btns"><button class="btn-cancel" id="m-cancel">Cancel</button><button class="btn-save" id="m-save">Add Task</button></div>
      </div>
    </div>`;

  // Global Subtree Click Delegator (fixes dynamic element bindings)
  $('task-list').onclick = e => {
    const toggleId = e.target.closest('.checkbox')?.dataset.toggle;
    if (toggleId) {
      const t = tasks.find(x => x.id === toggleId);
      if (t) {
        t.completed = !t.completed;
        if (t.completed) { blinkingIds.delete(t.id); alarmFiredIds.delete(t.id); }
        saveTask(t);
      }
      return;
    }
    const editId = e.target.closest('.btn-edit-card')?.dataset.edit;
    if (editId) { openModal(editId); return; }

    const delId = e.target.closest('.btn-delete-card')?.dataset.del;
    if (delId) { removeTask(delId); return; }
  };

  if ($('btn-signout')) $('btn-signout').addEventListener('click', () => useDocker ? dockerSignOut() : signOut(auth));
  $('btn-add-full').addEventListener('click', () => openModal(null));
  $('search-input').addEventListener('input', e => { search = e.target.value; render(); });

  $('quick-input').onkeydown = e => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      const nt = {
        id: useDocker ? Math.floor(Math.random() * 1000000).toString() : (useLocal ? 'local_' + Date.now() : doc(tasksCol()).id),
        title: e.target.value.trim(), completed: false, priority: 'medium', reminderEnabled: true,
        createdAt: new Date().toISOString(), color: nextColor(), alarmTriggered: false
      };
      e.target.value = '';
      saveTask(nt);
    }
  };

  $('filter-row').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab'); if (!btn) return;
    filter = btn.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); render();
  });

  $('btn-clear').addEventListener('click', clearCompleted);

  // Modal Panel Controllers
  document.querySelector('.priority-btns').onclick = e => {
    const btn = e.target.closest('.prio-btn'); if (!btn) return;
    modalPriority = btn.dataset.p;
    document.querySelectorAll('.prio-btn').forEach(b => b.classList.remove('active-high', 'active-medium', 'active-low'));
    btn.classList.add('active-' + modalPriority);
  };

  $('m-reminder').onclick = () => {
    modalReminder = !modalReminder;
    if (modalReminder) $('m-reminder').classList.add('on');
    else $('m-reminder').classList.remove('on');
  };

  $('m-cancel').onclick = closeModal;
  $('m-save').onclick = () => {
    const val = $('m-title').value.trim();
    if (!val) { alert('Title is mandatory.'); return; }

    let t = editingId ? tasks.find(x => x.id === editingId) : null;
    if (t) {
      t.title = val; t.description = $('m-desc').value.trim();
      t.dueDate = $('m-date').value; t.dueTime = $('m-time').value;
      t.priority = modalPriority; t.reminderEnabled = modalReminder;
      if (!t.reminderEnabled || t.completed) { blinkingIds.delete(t.id); alarmFiredIds.delete(t.id); }
    } else {
      t = {
        id: useDocker ? Math.floor(Math.random() * 1000000).toString() : (useLocal ? 'local_' + Date.now() : doc(tasksCol()).id),
        title: val, description: $('m-desc').value.trim(), dueDate: $('m-date').value, dueTime: $('m-time').value,
        priority: modalPriority, reminderEnabled: modalReminder, completed: false,
        createdAt: new Date().toISOString(), color: nextColor(), alarmTriggered: false
      };
    }
    closeModal(); saveTask(t);
  };

  render();
}

function render() {
  if (!$('stat-total')) return;
  const s = getStats();
  $('stat-total').textContent = s.total; $('stat-active').textContent = s.active;
  $('stat-done').textContent = s.done; $('stat-overdue').textContent = s.overdue;

  const filtered = getFiltered();
  $('bottom-count').textContent = filtered.length + ' task' + (filtered.length !== 1 ? 's' : '');
  const list = $('task-list');
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">No tasks to show.</div>`;
    return;
  }
  list.innerHTML = filtered.map(renderCard).join('');
}

function renderCard(t) {
  const due = t.dueDate ? formatDue(t.dueDate, t.dueTime) : null, isB = blinkingIds.has(t.id);
  let dC = due ? (due.isOverdue ? 'overdue' : due.isSoon ? 'soon' : '') : '';
  const col = t.color || '#a0a8c0', [r, g, b] = hexToRgb(col);
  return `
    <div class="task-card ${t.completed ? 'completed' : ''} ${isB ? 'blinking' : ''}" style="background:rgba(${r},${g},${b},0.38);border:2px solid rgba(${r},${g},${b},0.90);">
      <div class="card-row">
        <div class="checkbox ${t.completed ? 'checked' : ''}" data-toggle="${t.id}"></div>
        <div class="card-content">
          <div class="card-title">${escHtml(t.title)}</div>
          ${due ? `<span class="due-label ${dC}">🕐 ${due.label}${due.isOverdue && !t.completed ? ' <span class="badge badge-overdue">Overdue</span>' : ''}${due.isSoon && !due.isOverdue && !t.completed ? ' <span class="badge badge-soon">Soon</span>' : ''}</span>` : ''}
        </div>
        <div class="card-actions-overlay">
           <button class="btn-edit-card" data-edit="${t.id}">✏️</button>
           <button class="btn-delete-card" data-del="${t.id}">🗑️</button>
        </div>
      </div>
    </div>`;
}

window.init = init;
document.addEventListener('DOMContentLoaded', init);