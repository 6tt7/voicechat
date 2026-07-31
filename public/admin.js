// Admin login + panel. Authentication is entirely server-side (see server.js);
// this module only sends credentials, reflects the result, and renders the
// moderation controls once the server confirms the socket is an admin.

const $ = (id) => document.getElementById(id);

let ctx = null;
let admin = false;
let name = null;

export function isAdmin() { return admin; }
export function adminName() { return name; }

export function initAdmin(context) {
  ctx = context;

  $('adminBtn').onclick = () => {
    if (admin) togglePanel();
    else { $('adminSheet').hidden = false; $('adminUser').focus(); }
  };

  $('adminLoginBtn').onclick = submitLogin;
  $('adminPass').onkeydown = (e) => { if (e.key === 'Enter') submitLogin(); };
  $('adminSheet').onclick = (e) => { if (e.target === $('adminSheet')) $('adminSheet').hidden = true; };
  $('adminLoginDone').onclick = () => { $('adminSheet').hidden = true; };

  $('adminPanelClose').onclick = () => { $('adminPanel').hidden = true; };
  $('announceBtn').onclick = () => {
    const text = $('announceInput').value.trim();
    if (text) { ctx.sendAction('announce', null, { text }); $('announceInput').value = ''; }
  };
  $('confettiBtn').onclick = () => ctx.sendAction('confetti');
  $('lockBtn').onclick = () => {
    const locked = $('lockBtn').classList.toggle('on');
    ctx.sendAction('lock', null, { value: locked });
    $('lockBtn').textContent = locked ? '🔓 unlock room' : '🔒 lock room';
  };
  $('spotlightClearBtn').onclick = () => ctx.sendAction('spotlight', null);

  $('warnClose').onclick = () => { $('warnModal').hidden = true; };
}

function submitLogin() {
  const username = $('adminUser').value;
  const password = $('adminPass').value;
  $('adminLoginMsg').textContent = 'checking…';
  $('adminLoginMsg').className = 'key-status';
  ctx.login(username, password);
}

function togglePanel() { $('adminPanel').hidden = !$('adminPanel').hidden; }

/** Returns true if the message was an admin-related type we handled. */
export function onServerMessage(msg) {
  switch (msg.type) {
    case 'admin-login-result':
      if (msg.ok) {
        admin = true;
        name = msg.adminName;
        $('adminSheet').hidden = true;
        $('adminPass').value = '';
        $('adminBtn').classList.add('on');
        $('adminBtnLabel').textContent = `admin: ${name}`;
        $('adminPanel').hidden = false;
        $('adminWho').textContent = name;
        ctx.log('admin', `signed in as admin "${name}"`);
      } else {
        $('adminLoginMsg').textContent = msg.reason || 'login failed';
        $('adminLoginMsg').className = 'key-status bad';
      }
      return true;

    case 'kicked':
      ctx.log('admin', `kicked by ${msg.by}${msg.reason ? `: ${msg.reason}` : ''}`);
      ctx.onKicked(`removed by ${msg.by}${msg.reason ? `: ${msg.reason}` : ''}`);
      return true;

    case 'banned':
      ctx.onKicked(msg.by ? `banned by ${msg.by}` : 'you are banned from this room');
      return true;

    case 'warn':
      showWarn(msg.by, msg.text);
      ctx.log('admin', `warning from ${msg.by}: ${msg.text}`);
      return true;

    case 'force-mute':
      showToast(msg.value ? `muted by ${msg.by}` : `unmuted by ${msg.by}`);
      return true;

    case 'announce':
      typeBanner(msg.by, msg.text);
      ctx.log('admin', `announcement from ${msg.by}: ${msg.text}`);
      return true;

    case 'confetti':
      confettiBurst();
      return true;

    case 'admin-log':
      // Transparency: every admin action is logged for everyone in the console.
      ctx.log('admin', `${msg.by} → ${msg.detail}`);
      return true;
  }
  return false;
}

/* ---------- visuals ---------- */

function showWarn(by, text) {
  $('warnBy').textContent = by || 'admin';
  $('warnText').textContent = text || '';
  $('warnModal').hidden = false;
}

let toastTimer = 0;
function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

let bannerTimer = 0;
function typeBanner(by, text) {
  const el = $('announce');
  const full = `📢 ${by}: ${text}`;
  el.hidden = false;
  el.textContent = '';
  let i = 0;
  clearInterval(bannerTimer);
  // Types out in real time so it reads like a live message.
  bannerTimer = setInterval(() => {
    el.textContent = full.slice(0, ++i);
    if (i >= full.length) {
      clearInterval(bannerTimer);
      setTimeout(() => { el.hidden = true; }, 5000);
    }
  }, 35);
}

function confettiBurst() {
  const box = $('confetti');
  const colors = ['#7c8cff', '#46d39a', '#ffb547', '#ff6b9d', '#5ec8f2', '#c084fc'];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.4 + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.append(p);
    setTimeout(() => p.remove(), 2600);
  }
}
