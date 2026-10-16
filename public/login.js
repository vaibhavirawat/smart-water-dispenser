const $ = id => document.getElementById(id);
const card = $('card'), err = $('err'), go = $('go');
let signupOn = false, mode = 'in', resetToken = null;

// bubbles
for (let i = 0; i < 16; i++) {
  const b = document.createElement('span'), s = 6 + Math.random() * 22;
  b.style.cssText = `left:${Math.random() * 100}%;width:${s}px;height:${s}px;animation-duration:${8 + Math.random() * 12}s;animation-delay:${-Math.random() * 15}s;--dx:${(Math.random() - .5) * 80}px`;
  $('bubbles').appendChild(b);
}
try { const u = localStorage.getItem('swd_user'); if (u) { $('u').value = u; $('rem').checked = true; } } catch {}

// already signed in? skip the form (but not when following a reset link)
if (!location.hash.startsWith('#reset=')) fetch('/api/auth/me').then(r => { if (r.ok) location.replace('/'); }).catch(() => {});

$('eye').onclick = () => {
  const show = $('p').type === 'password';
  $('p').type = $('c').type = show ? 'text' : 'password';
  $('eye').textContent = show ? '🙈' : '👁';
  $('eye').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
};

const fail = msg => {
  err.className = 'err'; err.textContent = msg;
  card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
};
const good = msg => { err.className = 'err ok'; err.textContent = msg; };

// each mode: which pieces are visible and how the texts read
const MODES = {
  in:     { sub: 'Sign in to your dashboard', btn: 'Sign in',        show: ['f-u', 'f-p', 'f-row'], tabs: true },
  up:     { sub: 'Create your account',       btn: 'Create account', show: ['f-u', 'f-e', 'f-p', 'f-meter', 'f-c'], tabs: true },
  forgot: { sub: 'Reset your password',       btn: 'Send reset link', show: ['f-u'], back: true,
            note: 'Enter your username or email and we’ll send you a reset link.' },
  reset:  { sub: 'Choose a new password',     btn: 'Set new password', show: ['f-p', 'f-meter', 'f-c'] },
};
const ALL = ['f-u', 'f-e', 'f-p', 'f-meter', 'f-c', 'f-row'];

function setMode(m, keepMessage) {
  mode = m; const c = MODES[m];
  if (!keepMessage) { err.textContent = ''; err.className = 'err'; }
  ALL.forEach(id => $(id).hidden = !c.show.includes(id));
  $('tabs').classList.toggle('show', !!c.tabs && signupOn);
  $('tabs').classList.toggle('up', m === 'up');
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('sub').textContent = c.sub; $('goText').textContent = c.btn;
  $('note').hidden = !c.note; $('note').textContent = c.note || '';
  $('backLink').hidden = !c.back;
  $('forgotLink').hidden = false;
  $('u-label').textContent = m === 'forgot' ? 'Username or email' : 'Username';
  $('p-label').textContent = m === 'reset' ? 'New password' : 'Password';
  $('p').autocomplete = m === 'in' ? 'current-password' : 'new-password';
  $('foot').textContent = m === 'up' ? 'Accounts you create here are read-only.'
    : m === 'in' ? (signupOn ? 'New here? Choose “Create account”.' : 'Contact an administrator if you need an account.') : '';
  go.disabled = false; go.classList.remove('loading');
  const first = ALL.concat([]).map($).find(el => !el.hidden && el.querySelector('input'));
  if (first && m !== 'in') first.querySelector('input').focus();
  else if (m === 'in') ($('u').value ? $('p') : $('u')).focus();
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('forgotLink').onclick = () => setMode('forgot');
$('backLink').onclick = () => setMode('in');

fetch('/api/auth/config').then(r => r.json()).then(c => { signupOn = !!c.signup; setMode(mode, true); if (!resetToken) handleHash(); }).catch(() => {});

// reset links look like /login.html#reset=<token>; react on load and when the hash changes in an already-open tab
function handleHash() {
  if (location.hash.startsWith('#reset=')) {
    resetToken = location.hash.slice(7);
    history.replaceState(null, '', location.pathname); // keep the token out of the address bar and history
    setMode('reset');
  } else if (location.hash === '#signup' && signupOn) setMode('up');
}
window.addEventListener('hashchange', handleHash);
if (location.hash.startsWith('#reset=')) handleHash(); else setMode('in');

$('p').addEventListener('input', () => {
  const v = $('p').value;
  const score = Math.min(4, (v.length >= 8) + (v.length >= 12) + (/[A-Z]/.test(v) && /[a-z]/.test(v)) + (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)));
  const m = $('meter');
  m.style.width = (v ? Math.max(12, score * 25) : 0) + '%';
  m.style.background = ['#ff6b6b', '#ff6b6b', '#ffd166', '#9be37f', '#4cd964'][score];
});

async function call(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
const busy = text => { go.disabled = true; go.classList.add('loading'); $('goText').textContent = text; };
const idle = () => { go.disabled = false; go.classList.remove('loading'); $('goText').textContent = MODES[mode].btn; };
function enter(text) {
  $('goText').textContent = text;
  card.style.transition = 'opacity .35s, transform .35s'; card.style.opacity = 0; card.style.transform = 'translateY(-14px) scale(.97)';
  setTimeout(() => location.href = '/', 320);
}

card.addEventListener('submit', async e => {
  e.preventDefault();
  err.textContent = ''; err.className = 'err';
  const username = $('u').value.trim(), password = $('p').value;
  try {
    if (mode === 'in') {
      if (!username || !password) return fail('Enter your username and password');
      busy('Signing in…');
      await call('/api/auth/login', { username, password });
      try { $('rem').checked ? localStorage.setItem('swd_user', username) : localStorage.removeItem('swd_user'); } catch {}
      return enter('Welcome ✓');
    }
    if (mode === 'up') {
      if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return fail('Username: 3–30 letters, numbers, . _ -');
      if (password.length < 8) return fail('Password must be at least 8 characters');
      if (password !== $('c').value) return fail('Passwords do not match');
      busy('Creating…');
      await call('/api/auth/register', { username, password, email: $('e').value.trim() || undefined });
      return enter('Account created ✓');
    }
    if (mode === 'forgot') {
      if (!username) return fail('Enter your username or email');
      busy('Sending…');
      const d = await call('/api/auth/forgot', { identifier: username });
      idle(); return good(d.message);
    }
    if (mode === 'reset') {
      if (password.length < 8) return fail('Password must be at least 8 characters');
      if (password !== $('c').value) return fail('Passwords do not match');
      busy('Saving…');
      await call('/api/auth/reset', { token: resetToken, password });
      $('p').value = $('c').value = ''; resetToken = null;
      setMode('in'); return good('Password updated. Please sign in.');
    }
  } catch (x) {
    fail(x.message === 'Failed to fetch' ? 'Cannot reach the server' : x.message);
    idle();
  }
});
