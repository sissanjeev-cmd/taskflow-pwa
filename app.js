import { initializeApp }     from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
         getRedirectResult, setPersistence, browserLocalPersistence,
         signOut, onAuthStateChanged }
                             from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy }
                             from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig }    from './firebase-config.js';

// ── Firebase init ──────────────────────────────────────────────────────────
const isConfigured = !firebaseConfig.apiKey.startsWith('REPLACE');
const fbApp  = isConfigured ? initializeApp(firebaseConfig) : null;
const auth   = isConfigured ? getAuth(fbApp)      : null;
const db     = isConfigured ? getFirestore(fbApp) : null;
const useLocal = !isConfigured;

// ── Colours ────────────────────────────────────────────────────────────────
const TASK_COLORS = ['#60a5fa','#a78bfa','#f472b6','#4ade80','#fbbf24','#22d3ee','#2dd4bf','#fb7185','#818cf8','#fb923c'];
let colorIndex = 0;
function nextColor() { return TASK_COLORS[colorIndex++ % TASK_COLORS.length]; }
function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

// ── State ──────────────────────────────────────────────────────────────────
let currentUser    = null;
let tasks          = [];
let filter         = 'all';
let search         = '';
let blinkingIds    = new Set();
let alarmFiredIds  = new Set();
let modalPriority  = 'medium';
let modalReminder  = true;
let editingId      = null;
let unsubSnapshot  = null;
let pendingAlarms  = [];
let alarmCtx       = null;
let alarmInterval  = null;

const $   = id => document.getElementById(id);
const app = document.getElementById('app');

// ── Entry ──────────────────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) {
    // When a new SW takes over, reload immediately to get fresh files
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
    navigator.serviceWorker.register('./sw.js').then(reg => {
      // If a new SW is already waiting, tell it to take over now
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller)
            sw.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    }).catch(() => {});
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

  // Await redirect result first so auth state is settled
  try {
    await getRedirectResult(auth);
  } catch (e) {
    console.error('Redirect result:', e.code, e.message);
    // auth state listener will still fire correctly
  }

  // ── Firebase auth ──────────────────────────────────────────────────────
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
        showAuthScreen();
      }
    } catch (e) {
      app.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100dvh;color:#f87171;font-size:14px;padding:20px;text-align:center;">Error: ${e.message}</div>`;
    }
  });
}

function persistLocal() { localStorage.setItem('taskflow-tasks', JSON.stringify(tasks)); }

// ── Auth screen ────────────────────────────────────────────────────────────
const googleSvg = `<svg width="20" height="20" viewBox="0 0 18 18" fill="none">
  <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 14.021 17.64 11.712 17.64 9.2z" fill="#4285F4"/>
  <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
  <path d="M3.964 10.707A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
  <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
</svg>`;

function showAuthScreen() {
  app.innerHTML = `
    <div id="auth-screen">
      <div class="auth-card">
        <span class="auth-logo">✅</span>
        <h1 class="auth-title">TaskFlow</h1>
        <p class="auth-sub">Your tasks, everywhere</p>
        <button class="btn-google-signin" id="btn-signin">
          ${googleSvg} Continue with Google
        </button>
        <p class="auth-error" id="auth-err"></p>
        <p class="auth-note">Sign in to sync tasks across iPhone &amp; Mac</p>
      </div>
    </div>`;

  $('btn-signin').addEventListener('click', async () => {
    const errEl = $('auth-err');
    errEl.textContent = 'Opening Google sign-in…';
    try {
      await setPersistence(auth, browserLocalPersistence);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === 'auth/popup-blocked') {
        errEl.textContent = 'Popup blocked. In Safari: Settings → Safari → turn off "Block Pop-ups", then retry.';
      } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        errEl.textContent = e.code || e.message;
      } else {
        errEl.textContent = '';
      }
    }
  });
}

// ── Firestore data ─────────────────────────────────────────────────────────
function tasksCol() {
  return collection(db, 'users', currentUser.uid, 'tasks');
}

function startRealtimeSync() {
  stopRealtimeSync();
  const q = query(tasksCol(), orderBy('createdAt', 'desc'));
  unsubSnapshot = onSnapshot(q, snap => {
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    tasks.forEach(t => { if (t.alarmTriggered && !t.completed) { blinkingIds.add(t.id); alarmFiredIds.add(t.id); } });
    render();
  });
}

function stopRealtimeSync() {
  if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
}

// ── CRUD ───────────────────────────────────────────────────────────────────
async function saveTask(t) {
  if (useLocal) {
    const idx = tasks.findIndex(x => x.id === t.id);
    if (idx >= 0) tasks[idx] = t; else tasks.unshift(t);
    persistLocal(); render();
  } else {
    const { id, ...data } = t;
    await setDoc(doc(tasksCol(), id), data);
  }
}

async function removeTask(id) {
  if (useLocal) {
    tasks = tasks.filter(x => x.id !== id); persistLocal(); render();
  } else {
    await deleteDoc(doc(tasksCol(), id));
  }
}

async function clearCompleted() {
  if (useLocal) {
    tasks = tasks.filter(t => !t.completed); persistLocal(); render();
  } else {
    tasks.filter(t => t.completed).forEach(t => deleteDoc(doc(tasksCol(), t.id)));
  }
}

// ── Alarm checker ──────────────────────────────────────────────────────────
function startAlarmChecker() {
  const check = () => {
    const now = new Date(); let changed = false;
    tasks.forEach(t => {
      if (t.completed || !t.reminderEnabled || !t.dueDate || alarmFiredIds.has(t.id) || t.alarmTriggered) return;
      if (new Date(t.dueDate + (t.dueTime ? 'T'+t.dueTime : 'T00:00')) <= now) {
        alarmFiredIds.add(t.id); blinkingIds.add(t.id); t.alarmTriggered = true; changed = true;
        fireAlarm(t);
        saveTask(t);
      }
    });
    if (changed) render();
  };
  check(); setInterval(check, 30000);
}

function fireAlarm(t) {
  if (Notification.permission === 'granted')
    new Notification('⏰ TaskFlow Reminder', { body: t.title, icon: './icon-192.png' });
  pendingAlarms.push(t.id);
  startContinuousBeep();
  if (!document.getElementById('alarm-overlay')) showAlarmOverlay();
}

function _scheduleBeep() {
  if (!alarmCtx || alarmCtx.state === 'closed') return;
  if (alarmCtx.state === 'suspended') { alarmCtx.resume().catch(() => {}); return; }
  const t0 = alarmCtx.currentTime;
  [[0,1047],[0.22,880],[0.44,1047],[0.66,1319]].forEach(([dt, freq]) => {
    const o = alarmCtx.createOscillator(), g = alarmCtx.createGain();
    o.connect(g); g.connect(alarmCtx.destination);
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0+dt);
    g.gain.linearRampToValueAtTime(0.6, t0+dt+0.01);
    g.gain.setValueAtTime(0.6, t0+dt+0.16);
    g.gain.linearRampToValueAtTime(0, t0+dt+0.21);
    o.start(t0+dt); o.stop(t0+dt+0.22);
  });
}

async function startContinuousBeep() {
  if (alarmInterval) return;
  try {
    alarmCtx = new (window.AudioContext || window.webkitAudioContext)();
    await alarmCtx.resume().catch(() => {});
    _scheduleBeep();
    alarmInterval = setInterval(_scheduleBeep, 2200);
  } catch(e) {}
}

function stopContinuousBeep() {
  if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
  if (alarmCtx) { alarmCtx.close().catch(() => {}); alarmCtx = null; }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && alarmCtx && alarmCtx.state === 'suspended')
    alarmCtx.resume().catch(() => {});
});

function showAlarmOverlay() {
  const taskId = pendingAlarms.shift();
  if (!taskId) { stopContinuousBeep(); return; }
  const t = tasks.find(x => x.id === taskId);
  if (!t) { showAlarmOverlay(); return; }

  const prioIcon = { high:'🔴', medium:'🟡', low:'🟢' };
  let metaHtml = '';
  if (t.priority) metaHtml += `<span class="alarm-meta-prio alarm-prio-${t.priority}">${prioIcon[t.priority]||''} ${t.priority}</span>`;
  if (t.dueDate) {
    const due = new Date(t.dueDate + (t.dueTime ? 'T'+t.dueTime : 'T00:00'));
    const dateStr = due.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    const timeStr = t.dueTime ? due.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }) : '';
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
      ${metaHtml ? `<div class="alarm-meta">${metaHtml}</div>` : ''}
      <div class="alarm-actions">
        <button class="alarm-btn alarm-snooze" id="alarm-snooze">😴 Snooze 5 min</button>
        <button class="alarm-btn alarm-stop"   id="alarm-stop">🛑 Stop Alarm</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(ov);

  document.getElementById('alarm-snooze').onclick = () => {
    const task = tasks.find(x => x.id === taskId);
    if (task) {
      const at = new Date(Date.now() + 5*60*1000);
      const p = n => n.toString().padStart(2,'0');
      const dd = `${at.getFullYear()}-${p(at.getMonth()+1)}-${p(at.getDate())}`;
      const dt = `${p(at.getHours())}:${p(at.getMinutes())}`;
      blinkingIds.delete(taskId); alarmFiredIds.delete(taskId);
      saveTask({...task, dueDate:dd, dueTime:dt, alarmTriggered:false});
    }
    ov.remove(); showAlarmOverlay();
  };

  document.getElementById('alarm-stop').onclick = () => {
    const task = tasks.find(x => x.id === taskId);
    if (task) { blinkingIds.delete(taskId); saveTask({...task, alarmTriggered:true}); }
    ov.remove(); showAlarmOverlay();
  };
}

// ── Derived data ───────────────────────────────────────────────────────────
function getStats() {
  const now = new Date();
  return {
    total: tasks.length, active: tasks.filter(t=>!t.completed).length,
    done: tasks.filter(t=>t.completed).length,
    overdue: tasks.filter(t=>{ if(t.completed||!t.dueDate) return false; return new Date(t.dueDate+(t.dueTime?'T'+t.dueTime:'T00:00'))<now; }).length
  };
}
function getFiltered() {
  const now = new Date();
  return tasks.filter(t => {
    const q = search.toLowerCase();
    if (!(t.title.toLowerCase().includes(q)||(t.description||'').toLowerCase().includes(q))) return false;
    if (filter==='active') return !t.completed;
    if (filter==='completed') return t.completed;
    if (filter==='overdue') { if(t.completed||!t.dueDate) return false; return new Date(t.dueDate+(t.dueTime?'T'+t.dueTime:'T00:00'))<now; }
    return true;
  });
}
function formatDue(dueDate, dueTime) {
  if (!dueDate) return null;
  const due = new Date(dueDate+(dueTime?'T'+dueTime:'T00:00')), now = new Date();
  return {
    label: [due.toLocaleDateString('en-US',{month:'short',day:'numeric'}), dueTime?due.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):''].filter(Boolean).join(' · '),
    isOverdue: due<now, isSoon: due>=now && (due-now)/3600000<24
  };
}

// ── Build UI ───────────────────────────────────────────────────────────────
function buildApp() {
  const u  = currentUser;
  const av = u ? (u.displayName || u.email || '?')[0].toUpperCase() : null;

  app.innerHTML = `
    <div id="titlebar">
      <div class="logo">
        <span class="logo-icon">✅</span>
        <div>
          <div class="logo-text">TaskFlow</div>
          <div class="logo-sub">${u ? escHtml(u.email||'') : 'Todo &amp; Reminders'}</div>
        </div>
      </div>
      ${av ? `<div class="user-area">
        <div class="user-avatar" title="${escHtml(u.displayName||u.email||'')}">${av}</div>
        <button class="btn-signout" id="btn-signout">Sign out</button>
      </div>` : `<button class="btn-google-signin btn-signin-small" id="btn-signin-header">Sign In</button>`}
    </div>
    <div id="add-bar">
      <input class="glass-input" id="quick-input" placeholder="Add a task… (tap + for details)" />
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
    <div id="bottom-bar">
      <span class="bottom-count" id="bottom-count"></span>
      <button class="btn-clear" id="btn-clear">Clear completed</button>
    </div>
    <div id="modal-overlay" class="hidden">
      <div id="modal-box">
        <div class="modal-handle"></div>
        <div class="modal-title" id="modal-title">✨ New Task</div>
        <div class="field-row"><label class="field-label">Title *</label><input class="field-input" id="m-title" placeholder="What needs to be done?" /></div>
        <div class="field-row"><label class="field-label">Description</label><input class="field-input" id="m-desc" placeholder="Optional notes…" /></div>
        <div class="field-row">
          <label class="field-label">Priority</label>
          <div class="priority-btns">
            <button class="prio-btn" data-p="high">🔴 High</button>
            <button class="prio-btn active-medium" data-p="medium">🟡 Medium</button>
            <button class="prio-btn" data-p="low">🟢 Low</button>
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
        <div class="modal-btns">
          <button class="btn-cancel" id="m-cancel">Cancel</button>
          <button class="btn-save" id="m-save">Add Task</button>
        </div>
      </div>
    </div>`;

  if ($('btn-signout')) $('btn-signout').addEventListener('click', () => signOut(auth));
  if ($('btn-signin-header')) $('btn-signin-header').addEventListener('click', async () => {
    if (!auth) { showAuthScreen(); return; }
    await setPersistence(auth, browserLocalPersistence).catch(() => {});
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider).catch(() => {});
  });
  $('quick-input').addEventListener('keydown', e => { if (e.key==='Enter'&&e.target.value.trim()) { addQuick(e.target.value.trim()); e.target.value=''; } });
  $('btn-add-full').addEventListener('click', () => openModal(null));
  $('search-input').addEventListener('input', e => { search=e.target.value; render(); });
  $('filter-row').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab'); if (!btn) return;
    filter=btn.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); render();
  });
  $('btn-clear').addEventListener('click', clearCompleted);
  $('modal-overlay').addEventListener('click', e => { if (e.target===$('modal-overlay')) closeModal(); });
  $('m-cancel').addEventListener('click', closeModal);
  $('m-save').addEventListener('click', saveModal);
  $('m-title').addEventListener('keydown', e => { if (e.key==='Enter') saveModal(); });
  document.querySelectorAll('.prio-btn').forEach(btn => btn.addEventListener('click', () => {
    modalPriority=btn.dataset.p;
    document.querySelectorAll('.prio-btn').forEach(b=>b.className='prio-btn');
    btn.classList.add('active-'+modalPriority);
  }));
  $('m-reminder').addEventListener('click', () => {
    modalReminder=!modalReminder;
    $('m-reminder').className='toggle-switch '+(modalReminder?'on':'off');
  });
  render();
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  if (!$('stat-total')) return;
  const s = getStats();
  $('stat-total').textContent=s.total; $('stat-active').textContent=s.active;
  $('stat-done').textContent=s.done; $('stat-overdue').textContent=s.overdue;

  const filtered = getFiltered();
  $('bottom-count').textContent=filtered.length+' task'+(filtered.length!==1?'s':'');
  const list=$('task-list');
  if (!filtered.length) {
    const msgs={all:'No tasks yet. Tap + to add one!',active:'No active tasks — great work!',completed:'Nothing completed yet.',overdue:"You're all caught up! 🎉"};
    const icons={all:'📝',active:'⚡',completed:'🎉',overdue:'✨'};
    list.innerHTML=`<div class="empty-state"><span class="empty-icon">${icons[filter]}</span>${search?'No tasks match your search.':msgs[filter]}</div>`;
    return;
  }
  list.innerHTML=filtered.map(renderCard).join('');
  list.querySelectorAll('[data-toggle]').forEach(el=>el.addEventListener('click',()=>toggleTask(el.dataset.toggle)));
  list.querySelectorAll('[data-edit]').forEach(el=>el.addEventListener('click',()=>openModal(el.dataset.edit)));
  list.querySelectorAll('[data-delete]').forEach(el=>el.addEventListener('click',()=>deleteTask(el.dataset.delete)));
  list.querySelectorAll('[data-snooze]').forEach(el=>el.addEventListener('click',()=>{
    const id=el.dataset.snooze, t=tasks.find(x=>x.id===id); if(!t) return;
    const at=new Date(Date.now()+5*60*1000);
    const dd=at.toISOString().split('T')[0];
    const dt=at.getHours().toString().padStart(2,'0')+':'+at.getMinutes().toString().padStart(2,'0');
    blinkingIds.delete(id); alarmFiredIds.delete(id);
    saveTask({...t, dueDate:dd, dueTime:dt, alarmTriggered:false});
  }));
  list.querySelectorAll('[data-stop]').forEach(el=>el.addEventListener('click',()=>{
    const id=el.dataset.stop, t=tasks.find(x=>x.id===id); if(!t) return;
    blinkingIds.delete(id); saveTask({...t, alarmTriggered:true});
  }));
}

function renderCard(t) {
  const due=t.dueDate?formatDue(t.dueDate,t.dueTime):null, isB=blinkingIds.has(t.id);
  const dC=due?(due.isOverdue?'overdue':due.isSoon?'soon':''):'';
  const pMap={high:'badge-high',medium:'badge-medium',low:'badge-low'}, pIcon={high:'🔴',medium:'🟡',low:'🟢'};
  const col=t.color||'#a0a8c0', [r,g,b]=hexToRgb(col);
  const cs=` style="background:rgba(${r},${g},${b},0.38);border:2px solid rgba(${r},${g},${b},0.90);"`;
  return `
    <div class="task-card ${t.completed?'completed':''} ${isB?'blinking':''}"${cs}>
      <div class="card-row">
        <div class="checkbox ${t.completed?'checked':''}" data-toggle="${t.id}"></div>
        <div class="card-content">
          <div class="card-title ${t.completed?'done':''}">${escHtml(t.title)}</div>
          ${t.description?`<div class="card-desc">${escHtml(t.description)}</div>`:''}
          <div class="card-meta">
            <span class="badge ${pMap[t.priority]}">${pIcon[t.priority]} ${t.priority}</span>
            ${due?`<span class="due-label ${dC}">🕐 ${due.label}${due.isOverdue&&!t.completed?' <span class="badge badge-overdue">Overdue</span>':''}${due.isSoon&&!due.isOverdue&&!t.completed?' <span class="badge badge-soon">Soon</span>':''}</span>`:''}
            ${t.reminderEnabled&&!t.completed?`<span style="color:rgba(255,255,255,0.30);font-size:12px">🔔</span>`:''}
          </div>
          ${isB?`<div class="alarm-banner"><span class="alarm-text">⏰ Alarm active</span><button class="alarm-dismiss" data-snooze="${t.id}">😴 5min</button><button class="alarm-dismiss alarm-stop-inline" data-stop="${t.id}">🛑 Stop</button></div>`:''}        </div>
        <div class="card-actions">
          <button class="card-btn" data-edit="${t.id}">✏️</button>
          <button class="card-btn del" data-delete="${t.id}">🗑</button>
        </div>
      </div>
    </div>`;
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Task ops ───────────────────────────────────────────────────────────────
function addQuick(title) {
  saveTask({ id:crypto.randomUUID(), title, description:'', priority:'medium', completed:false,
    createdAt:Date.now(), dueDate:'', dueTime:'', reminderEnabled:false, alarmTriggered:false, color:nextColor() });
}
function toggleTask(id) {
  const t=tasks.find(x=>x.id===id); if(!t) return;
  blinkingIds.delete(id); saveTask({...t, completed:!t.completed});
}
function deleteTask(id) {
  blinkingIds.delete(id); alarmFiredIds.delete(id); removeTask(id);
}

// ── Modal ──────────────────────────────────────────────────────────────────
function openModal(taskId) {
  editingId=taskId;
  const t=taskId?tasks.find(x=>x.id===taskId):null;
  $('modal-title').textContent=t?'✏️ Edit Task':'✨ New Task';
  $('m-title').value=t?t.title:''; $('m-desc').value=t?(t.description||''):'';
  $('m-date').value=t?(t.dueDate||''):''; $('m-time').value=t?(t.dueTime||''):'';
  $('m-save').textContent=t?'Save Changes':'Add Task';
  modalPriority=t?t.priority:'medium'; modalReminder=t?t.reminderEnabled:true;
  document.querySelectorAll('.prio-btn').forEach(b=>b.className='prio-btn'+(b.dataset.p===modalPriority?' active-'+modalPriority:''));
  $('m-reminder').className='toggle-switch '+(modalReminder?'on':'off');
  $('modal-overlay').classList.remove('hidden');
  setTimeout(()=>$('m-title').focus(),80);
}
function closeModal() { $('modal-overlay').classList.add('hidden'); editingId=null; }
function saveModal() {
  const title=$('m-title').value.trim(); if(!title) return;
  const base={title, description:$('m-desc').value.trim(), priority:modalPriority,
    dueDate:$('m-date').value, dueTime:$('m-time').value, reminderEnabled:modalReminder, alarmTriggered:false};
  if (editingId) {
    const t=tasks.find(x=>x.id===editingId); if(!t) return;
    blinkingIds.delete(t.id); alarmFiredIds.delete(t.id); saveTask({...t,...base});
  } else {
    saveTask({...base, id:crypto.randomUUID(), completed:false, createdAt:Date.now(), color:nextColor()});
  }
  closeModal();
}

init();
