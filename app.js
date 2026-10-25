'use strict';

/* ==========================================================================
   Setup
   ========================================================================== */

const cfg = window.COMICS_CONFIG || {};
const CONFIGURED = Boolean(
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/YOUR_/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY)
);
const BUCKET = 'comic-pages';
const MAX_IMAGE_SIDE = 2000; // px; uploads are scaled down to this to save storage
const sb = CONFIGURED && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const app = document.getElementById('app');
let session = null;
let cleanup = null; // set by a view that needs to tidy up (e.g. flush unsaved text) before leaving
let viewToken = 0; // guards against a slow view rendering after the user has navigated away

/* Bubble kinds. Positions and sizes are stored in % of the page image, text size in % of image width. */
const TYPES = {
  text: { label: 'טקסט', add: 'טקסט לבועה קיימת', inset: [0.04, 0.06], fill: null, w: 16, ratio: 0.55, size: 1.8 },
  speech: { label: 'בועת דיבור', add: 'בועת דיבור', inset: [0.16, 0.2], fill: '#ffffff', w: 24, ratio: 0.6, size: 1.8 },
  thought: { label: 'בועת מחשבה', add: 'בועת מחשבה', inset: [0.2, 0.25], fill: '#ffffff', w: 24, ratio: 0.65, size: 1.8 },
  caption: { label: 'כיתוב', add: 'תיבת כיתוב', inset: [0.05, 0.1], fill: '#fff4b8', w: 32, ratio: 0.2, size: 1.7 },
  sfx: { label: 'אפקט קולי', add: 'אפקט קולי', inset: [0, 0], fill: null, w: 26, ratio: 0.3, size: 5 },
};
const FONTS = [
  { id: 'Rubik', label: 'רוביק' },
  { id: 'Varela Round', label: 'ורלה עגול' },
  { id: 'Secular One', label: 'סקולר' },
  { id: 'Karantina', label: 'קרנטינה' },
  { id: 'Amatic SC', label: 'כתב יד' },
];
const INK = '#17181d';
const SFX_RED = '#d62d20';

/* ==========================================================================
   Small helpers
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const newId = () =>
  window.crypto?.randomUUID ? crypto.randomUUID() : 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2);
const n2 = (v) => Math.round(v * 100) / 100;

let toastTimer;
function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3000);
}

function heError(err) {
  const m = (err && (err.message || err.error_description)) || String(err);
  if (/Invalid login credentials/i.test(m)) return 'האימייל או הסיסמה שגויים.';
  if (/Email not confirmed/i.test(m)) return 'צריך לאשר את כתובת האימייל. חפשו את מייל האישור בתיבת הדואר.';
  if (/already registered|already been registered/i.test(m)) return 'כבר קיים חשבון עם האימייל הזה. נסו להיכנס.';
  if (/Password should be at least/i.test(m)) return 'הסיסמה צריכה להיות באורך 6 תווים לפחות.';
  if (/Signups not allowed|signup is disabled/i.test(m)) return 'ההרשמה סגורה. בקשו ממנהל האתר ליצור לכם חשבון.';
  if (/rate limit/i.test(m)) return 'יותר מדי ניסיונות. חכו כמה דקות ונסו שוב.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.';
  return 'משהו השתבש: ' + m;
}

/* A destructive button asks once, then acts on a second click within a few seconds. */
function confirmClick(btn, askLabel, action) {
  const original = btn.textContent;
  let armed = false;
  let timer;
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.textContent = askLabel;
      btn.classList.add('armed');
      timer = setTimeout(() => { armed = false; btn.textContent = original; btn.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    try { await action(); } finally {
      btn.disabled = false;
      armed = false;
      btn.textContent = original;
      btn.classList.remove('armed');
    }
  });
}

const urlCache = new Map();
async function signedUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => p && !(urlCache.get(p)?.exp > now));
  if (need.length) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
    if (error) throw error;
    for (const d of data || []) {
      if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 50 * 60 * 1000 });
    }
  }
  return Object.fromEntries(paths.map((p) => [p, urlCache.get(p)?.url || '']));
}

async function removeFiles(paths) {
  for (let i = 0; i < paths.length; i += 900) {
    const { error } = await sb.storage.from(BUCKET).remove(paths.slice(i, i + 900));
    if (error) throw error;
  }
}

/* Scale an uploaded picture down and re-encode it as JPEG, so the free storage lasts longer. */
async function compressImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sw, sh));
  const width = Math.round(sw * scale);
  const height = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  source.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('could not encode image');
  return { blob, width, height };
}

/* ==========================================================================
   Routing and account
   ========================================================================== */

async function init() {
  if (!CONFIGURED || !sb) return renderSetup();
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_event, s) => {
    const changed = Boolean(s) !== Boolean(session) || (s && session && s.user.id !== session.user.id);
    session = s;
    if (changed) route();
  });
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  if (cleanup) {
    const fn = cleanup;
    cleanup = null;
    try { await fn(); } catch (err) { console.error(err); }
  }
  viewToken++;
  updateTopbar();
  if (!session) return renderAuth();
  const [, view, id] = (location.hash.slice(1) || '/').split('/');
  if (view === 'comic' && id) return renderComic(id);
  if (view === 'page' && id) return renderEditor(id);
  return renderComics();
}

function updateTopbar() {
  const box = $('#account');
  if (!session) { box.innerHTML = ''; return; }
  box.innerHTML = `<span class="account-email" dir="ltr">${esc(session.user.email)}</span>
    <button class="btn ghost small" id="logout" type="button">יציאה</button>`;
  $('#logout').onclick = async () => {
    await sb.auth.signOut();
    location.hash = '#/';
  };
}

function renderSetup() {
  app.innerHTML = `
    <section class="panel setup" dir="ltr">
      <h1>Almost there</h1>
      <p>This app needs its Supabase project details before it can run.</p>
      <ol>
        <li>Run <code>supabase/setup.sql</code> in your Supabase project (SQL Editor → New query → Run).</li>
        <li>Open <code>config.js</code> and fill in the Project URL and the anon public key from Project Settings → API.</li>
        <li>Commit and push. GitHub Pages republishes the site within a minute or two.</li>
      </ol>
      <p class="muted">Step-by-step instructions are in README.md.</p>
    </section>`;
}

function renderAuth() {
  app.innerHTML = `
    <section class="auth">
      <div class="panel auth-card">
        <h1>ברוכים הבאים לבועות</h1>
        <p class="muted">מעלים עמוד קומיקס, לוחצים על בועה ומקלידים בעברית. הכול נשמר אוטומטית.</p>
        <form id="auth-form" class="stack" novalidate>
          <label for="auth-email">אימייל</label>
          <input id="auth-email" type="email" autocomplete="email" required dir="ltr">
          <label for="auth-password">סיסמה</label>
          <input id="auth-password" type="password" autocomplete="current-password" minlength="6" required dir="ltr">
          <div class="row">
            <button class="btn primary" type="submit" data-mode="in">כניסה</button>
            <button class="btn" type="submit" data-mode="up">הרשמה</button>
          </div>
          <p id="auth-msg" class="form-msg" role="status"></p>
        </form>
      </div>
    </section>`;
  const form = $('#auth-form');
  const msg = $('#auth-msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode || 'in';
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || !password) { msg.textContent = 'מלאו אימייל וסיסמה.'; return; }
    if (password.length < 6) { msg.textContent = 'הסיסמה צריכה להיות באורך 6 תווים לפחות.'; return; }
    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    msg.textContent = mode === 'up' ? 'יוצר חשבון…' : 'נכנס…';
    try {
      if (mode === 'up') {
        const { data, error } = await sb.auth.signUp({
          email, password, options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) msg.textContent = 'החשבון נוצר. שלחנו אליכם מייל אישור; לחצו על הקישור שבו ואז היכנסו.';
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      msg.textContent = heError(err);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}

/* ==========================================================================
   Comics list
   ========================================================================== */

async function renderComics() {
  const token = viewToken;
  app.innerHTML = `
    <section class="view">
      <div class="view-head">
        <h1>הקומיקסים שלי</h1>
        <form id="new-comic" class="inline-form">
          <label for="new-title" class="sr-only">שם הקומיקס החדש</label>
          <input id="new-title" placeholder="שם לקומיקס חדש" maxlength="120" required>
          <button class="btn primary" type="submit">יצירת קומיקס</button>
        </form>
      </div>
      <div id="comic-grid" class="comic-grid"><p class="muted">טוען…</p></div>
    </section>`;

  $('#new-comic').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#new-title').value.trim() || 'קומיקס חדש';
    const { data, error } = await sb.from('comics').insert({ title }).select('id').single();
    if (error) return toast(heError(error), 'error');
    location.hash = '#/comic/' + data.id;
  });

  const { data, error } = await sb
    .from('comics')
    .select('id,title,updated_at,pages(id,image_path,position)')
    .order('updated_at', { ascending: false });
  if (token !== viewToken) return;
  const grid = $('#comic-grid');
  if (error) { grid.innerHTML = `<p class="form-msg">${esc(heError(error))}</p>`; return; }
  if (!data.length) {
    grid.innerHTML = `
      <div class="empty">
        <h2>עוד אין כאן קומיקסים</h2>
        <p class="muted">תנו שם לקומיקס הראשון למעלה ולחצו "יצירת קומיקס". אחר כך מעלים את העמודים.</p>
      </div>`;
    return;
  }
  const covers = data.map((c) => [...c.pages].sort((a, b) => a.position - b.position)[0]?.image_path).filter(Boolean);
  let urls = {};
  try { urls = await signedUrls(covers); } catch (err) { console.error(err); }
  if (token !== viewToken) return;
  grid.innerHTML = data
    .map((c) => {
      const cover = [...c.pages].sort((a, b) => a.position - b.position)[0];
      const n = c.pages.length;
      return `
        <a class="comic-card" href="#/comic/${c.id}">
          <div class="cover">${cover && urls[cover.image_path] ? `<img src="${esc(urls[cover.image_path])}" alt="" loading="lazy">` : '<span class="cover-empty">אין עמודים</span>'}</div>
          <div class="comic-meta">
            <strong>${esc(c.title)}</strong>
            <span class="muted">${n === 1 ? 'עמוד אחד' : n + ' עמודים'}</span>
          </div>
        </a>`;
    })
    .join('');
}

/* ==========================================================================
   One comic: its pages, upload, reorder, delete
   ========================================================================== */

async function renderComic(comicId) {
  const token = viewToken;
  app.innerHTML = `<section class="view"><p class="muted">טוען…</p></section>`;
  const [comicRes, pagesRes] = await Promise.all([
    sb.from('comics').select('id,title').eq('id', comicId).maybeSingle(),
    sb.from('pages').select('id,image_path,position,width,height').eq('comic_id', comicId).order('position'),
  ]);
  if (token !== viewToken) return;
  if (comicRes.error || pagesRes.error) {
    app.innerHTML = `<section class="view"><p class="form-msg">${esc(heError(comicRes.error || pagesRes.error))}</p></section>`;
    return;
  }
  const comic = comicRes.data;
  if (!comic) {
    app.innerHTML = `<section class="view"><a class="back" href="#/">→ כל הקומיקסים</a><p>הקומיקס הזה לא נמצא.</p></section>`;
    return;
  }
  const pages = pagesRes.data;

  app.innerHTML = `
    <section class="view">
      <a class="back" href="#/">→ כל הקומיקסים</a>
      <div class="view-head">
        <label for="comic-title" class="sr-only">שם הקומיקס</label>
        <input id="comic-title" class="title-input" maxlength="120" value="${esc(comic.title)}">
        <div class="row">
          <label class="btn primary" for="upload">העלאת עמודים</label>
          <input id="upload" type="file" accept="image/*" multiple hidden>
          <button id="delete-comic" class="btn danger ghost" type="button">מחיקת הקומיקס</button>
        </div>
      </div>
      <div id="drop" class="dropzone">
        <strong>גררו לכאן תמונות של עמודים</strong>
        <span class="muted">או לחצו על "העלאת עמודים". אפשר לבחור כמה תמונות בבת אחת; הן נכנסות לפי סדר שמות הקבצים.</span>
      </div>
      <p id="upload-status" class="upload-status" role="status"></p>
      <ol id="page-list" class="page-grid"></ol>
    </section>`;

  const list = $('#page-list');
  const status = $('#upload-status');

  async function draw() {
    if (!pages.length) {
      list.innerHTML = '';
      return;
    }
    let urls = {};
    try { urls = await signedUrls(pages.map((p) => p.image_path)); } catch (err) { console.error(err); }
    if (token !== viewToken) return;
    list.innerHTML = pages
      .map((p, i) => `
        <li class="page-card" data-id="${p.id}">
          <a class="thumb" href="#/page/${p.id}" style="aspect-ratio:${p.width}/${p.height}">
            <img src="${esc(urls[p.image_path] || '')}" alt="עמוד ${i + 1}" loading="lazy">
          </a>
          <div class="page-meta">
            <a class="page-open" href="#/page/${p.id}">עמוד ${i + 1}</a>
            <div class="row tight">
              <button class="btn small ghost" type="button" data-act="earlier" ${i === 0 ? 'disabled' : ''} title="להזיז לפני העמוד הקודם">לפני</button>
              <button class="btn small ghost" type="button" data-act="later" ${i === pages.length - 1 ? 'disabled' : ''} title="להזיז אחרי העמוד הבא">אחרי</button>
              <button class="btn small ghost danger" type="button" data-act="delete">מחיקה</button>
            </div>
          </div>
        </li>`)
      .join('');
    list.querySelectorAll('[data-act="delete"]').forEach((btn) => {
      const id = btn.closest('.page-card').dataset.id;
      confirmClick(btn, 'בטוח?', () => deletePage(id));
    });
  }

  async function renumber() {
    const changed = pages.filter((p, i) => p.position !== i);
    changed.forEach((p) => { p.position = pages.indexOf(p); });
    const results = await Promise.all(changed.map((p) => sb.from('pages').update({ position: p.position }).eq('id', p.id)));
    const failed = results.find((r) => r.error);
    if (failed) toast(heError(failed.error), 'error');
  }

  async function deletePage(id) {
    const page = pages.find((p) => p.id === id);
    if (!page) return;
    const { error } = await sb.from('pages').delete().eq('id', id);
    if (error) return toast(heError(error), 'error');
    removeFiles([page.image_path]).catch((err) => console.error(err));
    pages.splice(pages.indexOf(page), 1);
    await renumber();
    toast('העמוד נמחק.');
    draw();
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="earlier"], [data-act="later"]');
    if (!btn) return;
    const i = pages.findIndex((p) => p.id === btn.closest('.page-card').dataset.id);
    const j = btn.dataset.act === 'earlier' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    draw();
    await renumber();
  });

  async function uploadFiles(fileList) {
    const files = [...fileList]
      .filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) return toast('בחרו קובצי תמונה (JPG או PNG).', 'error');
    let next = pages.length ? Math.max(...pages.map((p) => p.position)) + 1 : 0;
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      status.textContent = files.length > 1 ? `מעלה עמוד ${i + 1} מתוך ${files.length}…` : 'מעלה את העמוד…';
      try {
        const { blob, width, height } = await compressImage(f);
        const path = `${session.user.id}/${comicId}/${newId()}.jpg`;
        const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw up.error;
        const { data, error } = await sb
          .from('pages')
          .insert({ comic_id: comicId, image_path: path, width, height, position: next++ })
          .select('id,image_path,position,width,height')
          .single();
        if (error) {
          removeFiles([path]).catch(() => {});
          throw error;
        }
        if (token !== viewToken) continue;
        pages.push(data);
        await draw();
      } catch (err) {
        console.error(err);
        failed.push(f.name);
      }
    }
    if (token !== viewToken) return;
    status.textContent = failed.length
      ? `לא הצלחנו להעלות: ${failed.join(', ')}. נסו לשמור את התמונות כ-JPG או PNG ולהעלות שוב.`
      : files.length > 1 ? `${files.length} עמודים הועלו.` : 'העמוד הועלה.';
  }

  $('#upload').addEventListener('change', (e) => {
    uploadFiles(e.target.files);
    e.target.value = '';
  });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadFiles(e.dataTransfer.files);
  });

  const titleInput = $('#comic-title');
  titleInput.addEventListener('change', async () => {
    const title = titleInput.value.trim();
    if (!title) { titleInput.value = comic.title; return; }
    const { error } = await sb.from('comics').update({ title }).eq('id', comicId);
    if (error) return toast(heError(error), 'error');
    comic.title = title;
    toast('השם נשמר.');
  });

  confirmClick($('#delete-comic'), 'בטוח? כל העמודים יימחקו', async () => {
    try {
      await removeFiles(pages.map((p) => p.image_path));
    } catch (err) {
      console.error(err);
    }
    const { error } = await sb.from('comics').delete().eq('id', comicId);
    if (error) return toast(heError(error), 'error');
    toast('הקומיקס נמחק.');
    location.hash = '#/';
  });

  draw();
}

/* ==========================================================================
   Bubble shapes, shared by the on-screen editor (SVG) and the image export (canvas)
   ========================================================================== */

function ellipseRadiusToward(rx, ry, ux, uy) {
  return 1 / Math.sqrt((ux / rx) ** 2 + (uy / ry) ** 2);
}

/* Returns a list of primitive shapes in image pixels. Outline-then-fill drawing merges them into one bubble. */
function bubbleShapes(b, W, H) {
  const x = (b.x / 100) * W, y = (b.y / 100) * H, w = (b.w / 100) * W, h = (b.h / 100) * H;
  const cx = x + w / 2, cy = y + h / 2, rx = Math.max(1, w / 2), ry = Math.max(1, h / 2);
  const tx = (b.tx / 100) * W, ty = (b.ty / 100) * H;
  const dx = tx - cx, dy = ty - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const tailOutside = (dx / rx) ** 2 + (dy / ry) ** 2 > 1.05;
  const m = Math.min(rx, ry);
  const out = [];

  if (b.type === 'speech') {
    out.push({ k: 'ellipse', cx, cy, rx, ry });
    if (tailOutside) {
      const bw = m * 0.32;
      out.push({ k: 'poly', pts: [[cx - uy * bw, cy + ux * bw], [tx, ty], [cx + uy * bw, cy - ux * bw]] });
    }
  } else if (b.type === 'thought') {
    const ring = 0.72;
    const perim = Math.PI * (rx + ry) * ring;
    const n = clamp(Math.round(perim / (m * 0.5)), 7, 22);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([cx + rx * ring * Math.cos(a), cy + ry * ring * Math.sin(a)]);
    }
    pts.forEach((p, i) => {
      const a = pts[(i + n - 1) % n], c = pts[(i + 1) % n];
      const chord = Math.max(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(p[0] - c[0], p[1] - c[1]));
      out.push({ k: 'circle', cx: p[0], cy: p[1], r: chord * 0.62 });
    });
    out.push({ k: 'ellipse', cx, cy, rx: rx * ring, ry: ry * ring });
    if (tailOutside) {
      const edge = ellipseRadiusToward(rx, ry, ux, uy);
      const ex = cx + ux * edge, ey = cy + uy * edge;
      [[0.3, 0.17], [0.62, 0.11], [0.92, 0.07]].forEach(([t, r]) => {
        out.push({ k: 'circle', cx: ex + (tx - ex) * t, cy: ey + (ty - ey) * t, r: m * r });
      });
    }
  } else if (b.type === 'caption') {
    out.push({ k: 'rect', x, y, w, h });
  }
  return out;
}

const strokeWidth = (W) => Math.max(2, W * 0.0045);

function shapesToSvg(b, W, H) {
  const fill = TYPES[b.type]?.fill;
  const shapes = bubbleShapes(b, W, H);
  if (!fill || !shapes.length) return '';
  const f = (v) => v.toFixed(1);
  const el = (s) => {
    if (s.k === 'ellipse') return `<ellipse cx="${f(s.cx)}" cy="${f(s.cy)}" rx="${f(s.rx)}" ry="${f(s.ry)}"/>`;
    if (s.k === 'circle') return `<circle cx="${f(s.cx)}" cy="${f(s.cy)}" r="${f(s.r)}"/>`;
    if (s.k === 'rect') return `<rect x="${f(s.x)}" y="${f(s.y)}" width="${f(s.w)}" height="${f(s.h)}"/>`;
    return `<polygon points="${s.pts.map((p) => f(p[0]) + ',' + f(p[1])).join(' ')}"/>`;
  };
  const body = shapes.map(el).join('');
  return `<g fill="${INK}" stroke="${INK}" stroke-width="${f(strokeWidth(W))}" stroke-linejoin="round">${body}</g><g fill="${fill}">${body}</g>`;
}

function canvasPath(ctx, s) {
  ctx.beginPath();
  if (s.k === 'ellipse') ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
  else if (s.k === 'circle') ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
  else if (s.k === 'rect') ctx.rect(s.x, s.y, s.w, s.h);
  else {
    ctx.moveTo(s.pts[0][0], s.pts[0][1]);
    s.pts.slice(1).forEach((p) => ctx.lineTo(p[0], p[1]));
    ctx.closePath();
  }
}

function fontCss(b, px) {
  return `${b.bold ? 700 : 500} ${px}px "${b.font}", "Rubik", sans-serif`;
}

function wrapLines(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxW) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

async function renderPageToBlob(page, bubbles) {
  const { data: file, error } = await sb.storage.from(BUCKET).download(page.image_path);
  if (error) throw error;
  const bmp = await createImageBitmap(file);
  const W = page.width, H = page.height;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close?.();

  await Promise.all(bubbles.map((b) => document.fonts.load(fontCss(b, 40), b.text || 'א').catch(() => {})));

  for (const b of bubbles) {
    const t = TYPES[b.type] || TYPES.text;
    const shapes = bubbleShapes(b, W, H);
    if (t.fill && shapes.length) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = strokeWidth(W);
      ctx.strokeStyle = ctx.fillStyle = INK;
      shapes.forEach((s) => { canvasPath(ctx, s); ctx.fill(); ctx.stroke(); });
      ctx.fillStyle = t.fill;
      shapes.forEach((s) => { canvasPath(ctx, s); ctx.fill(); });
    }
    if (!b.text.trim()) continue;
    const bx = (b.x / 100) * W, by = (b.y / 100) * H, bw = (b.w / 100) * W, bh = (b.h / 100) * H;
    const boxW = bw * (1 - 2 * t.inset[0]);
    const px = (b.size / 100) * W;
    const lh = px * 1.15;
    ctx.font = fontCss(b, px);
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapLines(ctx, b.text, boxW);
    const cx = bx + bw / 2;
    const top = by + bh / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((line, i) => {
      const ly = top + i * lh;
      if (b.type === 'sfx') {
        ctx.lineJoin = 'round';
        ctx.lineWidth = px * 0.16;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(line, cx, ly);
      }
      ctx.fillStyle = b.color;
      ctx.fillText(line, cx, ly);
    });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ==========================================================================
   Page editor
   ========================================================================== */

async function renderEditor(pageId) {
  const token = viewToken;
  app.innerHTML = `<section class="view"><p class="muted">טוען…</p></section>`;
  const { data: page, error } = await sb
    .from('pages')
    .select('id,comic_id,image_path,width,height,position,bubbles,comics(title)')
    .eq('id', pageId)
    .maybeSingle();
  if (token !== viewToken) return;
  if (error || !page) {
    app.innerHTML = `<section class="view"><a class="back" href="#/">→ כל הקומיקסים</a><p>${error ? esc(heError(error)) : 'העמוד הזה לא נמצא.'}</p></section>`;
    return;
  }
  const [{ data: siblings }, urls] = await Promise.all([
    sb.from('pages').select('id,position').eq('comic_id', page.comic_id).order('position'),
    signedUrls([page.image_path]).catch(() => ({})),
  ]);
  if (token !== viewToken) return;

  const W = page.width, H = page.height;
  const comicTitle = page.comics?.title || 'קומיקס';
  const order = siblings || [];
  const idx = order.findIndex((p) => p.id === page.id);
  const prev = order[idx - 1], next = order[idx + 1];
  const bubbles = (Array.isArray(page.bubbles) ? page.bubbles : []).filter((b) => b && TYPES[b.type]);

  app.innerHTML = `
    <section class="editor">
      <div class="editor-head">
        <a class="back" href="#/comic/${page.comic_id}">→ ${esc(comicTitle)}</a>
        <nav class="pager" aria-label="מעבר בין עמודים">
          ${prev ? `<a class="btn small ghost" href="#/page/${prev.id}">→ הקודם</a>` : ''}
          <span>עמוד ${idx + 1} מתוך ${order.length}</span>
          ${next ? `<a class="btn small ghost" href="#/page/${next.id}">הבא ←</a>` : ''}
        </nav>
        <div class="row">
          <span class="zoom" role="group" aria-label="זום">
            <button class="btn small icon" type="button" id="zoom-out" aria-label="הקטנת התצוגה">−</button>
            <span id="zoom-level" class="zoom-level">100%</span>
            <button class="btn small icon" type="button" id="zoom-in" aria-label="הגדלת התצוגה">+</button>
          </span>
          <span id="save-state" class="save-state" data-state="saved">נשמר</span>
          <button id="export" class="btn" type="button">הורדה כתמונה</button>
        </div>
      </div>

      <div class="toolbar" id="toolbar">
        <div class="tool-group" role="group" aria-label="הוספה">
          ${Object.entries(TYPES)
            .map(([k, t]) => `<button class="btn small ${k === 'text' ? 'primary' : ''}" type="button" data-add="${k}" aria-pressed="false">+ ${t.add}</button>`)
            .join('')}
        </div>
        <div class="tool-group" id="sel-tools" role="group" aria-label="הבועה שנבחרה" hidden>
          <button class="btn small" type="button" id="t-edit">עריכת טקסט</button>
          <label class="field"><span>סוג</span>
            <select id="t-type">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}</select>
          </label>
          <label class="field"><span>גופן</span>
            <select id="t-font">${FONTS.map((f) => `<option value="${esc(f.id)}" style="font-family:'${esc(f.id)}'">${f.label}</option>`).join('')}</select>
          </label>
          <span class="field"><span>גודל</span>
            <button class="btn small icon" type="button" id="t-smaller" aria-label="הקטנת הטקסט">−</button>
            <button class="btn small icon" type="button" id="t-bigger" aria-label="הגדלת הטקסט">+</button>
          </span>
          <button class="btn small" type="button" id="t-bold" aria-pressed="false"><b>מודגש</b></button>
          <label class="field"><span>צבע</span><input type="color" id="t-color"></label>
          <button class="btn small" type="button" id="t-front">לחזית</button>
          <button class="btn small" type="button" id="t-dup">שכפול</button>
          <button class="btn small danger" type="button" id="t-del">מחיקה</button>
        </div>
      </div>
      <p id="hint" class="hint">לחצו על "+ טקסט לבועה קיימת" ואז על הבועה בתמונה. לחיצה על תיבה בוחרת אותה, לחיצה נוספת פותחת הקלדה. גוררים כדי להזיז, ואת העיגולים בפינות כדי לשנות גודל.</p>

      <div class="stage-wrap">
        <div class="stage" id="stage" style="aspect-ratio:${W}/${H}">
          <img id="page-img" src="${esc(urls[page.image_path] || '')}" alt="עמוד ${idx + 1}" draggable="false">
          <svg id="shapes" class="shapes" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div id="layer" class="layer"></div>
        </div>
      </div>

      <div id="edit-sheet" class="edit-sheet" hidden>
        <label for="sheet-text" class="sr-only">הטקסט בבועה</label>
        <textarea id="sheet-text" dir="rtl" rows="3" placeholder="הקלידו כאן את הטקסט"></textarea>
        <button id="sheet-done" class="btn primary" type="button">סיום</button>
      </div>
    </section>`;

  const stage = $('#stage');
  const svg = $('#shapes');
  const layer = $('#layer');
  const selTools = $('#sel-tools');
  const hint = $('#hint');
  if (window.matchMedia('(pointer: coarse)').matches) {
    hint.textContent = 'הקישו על "+ טקסט לבועה קיימת" ואז על הבועה בתמונה. הקשה על תיבה בוחרת אותה, הקשה נוספת פותחת הקלדה. גוררים כדי להזיז, ואת העיגולים בפינות כדי לשנות גודל. כפתורי הזום עוזרים לדייק.';
  }
  const img = $('#page-img');
  img.addEventListener('error', () => toast('לא הצלחנו לטעון את תמונת העמוד. רעננו את הדף.', 'error'));

  let selectedId = null;
  let editingId = null;
  let placing = null; // a bubble type waiting for a tap on the page
  let pendingEditId = null; // opened on the following click, so phones treat it as a tap and show the keyboard
  const useSheet = window.matchMedia('(pointer: coarse)').matches; // phones and tablets type in a docked text field
  const sheet = $('#edit-sheet');
  const sheetText = $('#sheet-text');

  const find = (id) => bubbles.find((b) => b.id === id);
  const bubbleEl = (id) => layer.querySelector(`.bubble[data-id="${CSS.escape(id)}"]`);

  /* ---- saving ---- */
  let saveTimer = null;
  let dirty = false;
  let savePromise = null;
  const saveState = $('#save-state');
  const SAVE_LABELS = { pending: 'שינויים לא שמורים', saving: 'שומר…', saved: 'נשמר', error: 'השמירה נכשלה, מנסה שוב…' };
  const setSave = (s) => { saveState.dataset.state = s; saveState.textContent = SAVE_LABELS[s]; };

  function markDirty() {
    dirty = true;
    setSave('pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (savePromise) await savePromise;
    if (!dirty) return;
    dirty = false;
    setSave('saving');
    const payload = bubbles.map((b) => ({ ...b, x: n2(b.x), y: n2(b.y), w: n2(b.w), h: n2(b.h), tx: n2(b.tx), ty: n2(b.ty) }));
    savePromise = sb.from('pages').update({ bubbles: payload }).eq('id', page.id).then(({ error: err }) => {
      savePromise = null;
      if (err) {
        dirty = true;
        setSave('error');
        saveTimer = setTimeout(saveNow, 4000);
      } else if (!dirty) {
        setSave('saved');
      }
    });
    await savePromise;
  }
  const onBeforeUnload = (e) => {
    if (dirty || savePromise) { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  /* ---- drawing ---- */
  function drawShapes() {
    svg.innerHTML = bubbles.map((b) => shapesToSvg(b, W, H)).join('');
  }

  function updateBubbleEl(b, el = bubbleEl(b.id)) {
    if (!el) return;
    const t = TYPES[b.type];
    el.className = `bubble type-${b.type}${b.id === selectedId ? ' selected' : ''}${b.id === editingId ? ' editing' : ''}`;
    Object.assign(el.style, { left: b.x + '%', top: b.y + '%', width: b.w + '%', height: b.h + '%' });
    el.style.setProperty('--fs', b.size);
    el.style.setProperty('--font', `"${b.font}"`);
    el.style.setProperty('--color', b.color);
    el.style.setProperty('--weight', b.bold ? 700 : 500);
    el.style.setProperty('--ix', t.inset[0] * 100 + '%');
    el.style.setProperty('--iy', t.inset[1] * 100 + '%');
    const tail = layer.querySelector('.tail-handle');
    if (tail && tail.dataset.id === b.id) Object.assign(tail.style, { left: b.tx + '%', top: b.ty + '%' });
  }

  function renderLayer() {
    layer.innerHTML = '';
    for (const b of bubbles) {
      const el = document.createElement('div');
      el.dataset.id = b.id;
      el.innerHTML = '<div class="text"><div class="t" dir="rtl" data-ph="הקלידו כאן"></div></div>';
      el.querySelector('.t').textContent = b.text;
      if (b.id === selectedId) {
        for (const c of ['nw', 'ne', 'sw', 'se']) {
          const h = document.createElement('span');
          h.className = 'h ' + c;
          h.dataset.handle = c;
          h.dataset.id = b.id;
          el.appendChild(h);
        }
      }
      layer.appendChild(el);
      updateBubbleEl(b, el);
    }
    const sel = find(selectedId);
    if (sel && (sel.type === 'speech' || sel.type === 'thought')) {
      const tail = document.createElement('span');
      tail.className = 'tail-handle';
      tail.dataset.handle = 'tail';
      tail.dataset.id = sel.id;
      tail.title = 'גררו כדי לכוון את הזנב';
      Object.assign(tail.style, { left: sel.tx + '%', top: sel.ty + '%' });
      layer.appendChild(tail);
    }
    syncToolbar();
  }

  function syncToolbar() {
    const b = find(selectedId);
    selTools.hidden = !b;
    if (!b) return;
    $('#t-type').value = b.type;
    $('#t-font').value = b.font;
    $('#t-color').value = b.color;
    $('#t-bold').setAttribute('aria-pressed', String(Boolean(b.bold)));
  }

  function select(id) {
    if (editingId && editingId !== id) stopEditing();
    selectedId = id && find(id) ? id : null;
    renderLayer();
  }

  /* ---- text editing ---- */
  const readText = (t) => t.innerText.replace(/ /g, ' ').replace(/\n+$/, '');

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }

  function startEditing(id) {
    const b = find(id);
    if (!b) return;
    if (selectedId !== id) select(id);
    const el = bubbleEl(id);
    const t = el?.querySelector('.t');
    if (!t) return;
    if (editingId === id) { (useSheet ? sheetText : t).focus(); return; }
    editingId = id;
    el.classList.add('editing');
    if (useSheet) {
      sheetText.value = b.text;
      sheet.hidden = false;
      positionSheet();
      sheetText.oninput = () => { b.text = sheetText.value; t.textContent = b.text; markDirty(); };
      sheetText.focus();
      sheetText.setSelectionRange(sheetText.value.length, sheetText.value.length);
      setTimeout(() => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }), 300);
      return;
    }
    t.contentEditable = 'plaintext-only';
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.oninput = () => { b.text = readText(t); markDirty(); };
    t.onblur = () => stopEditing();
    t.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); t.blur(); } };
    t.onpaste = (e) => {
      if (t.contentEditable === 'plaintext-only') return;
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    };
    t.focus();
    placeCaretAtEnd(t);
  }

  function stopEditing() {
    if (!editingId) return;
    const b = find(editingId);
    const el = bubbleEl(editingId);
    editingId = null;
    const t = el?.querySelector('.t');
    if (!t) return;
    el.classList.remove('editing');
    if (useSheet) {
      sheetText.oninput = null;
      sheet.hidden = true;
      if (document.activeElement === sheetText) sheetText.blur();
      if (b) {
        const text = sheetText.value.replace(/\n+$/, '');
        if (text !== b.text) { b.text = text; markDirty(); }
        t.textContent = b.text;
      }
      return;
    }
    t.contentEditable = 'false';
    t.oninput = t.onblur = t.onkeydown = t.onpaste = null;
    if (b) {
      const text = readText(t);
      if (text !== b.text) { b.text = text; markDirty(); }
      t.textContent = b.text;
    }
  }

  /* Keep the docked text field just above the on-screen keyboard. */
  function positionSheet() {
    const vv = window.visualViewport;
    const offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    sheet.style.bottom = offset + 'px';
  }
  window.visualViewport?.addEventListener('resize', positionSheet);
  window.visualViewport?.addEventListener('scroll', positionSheet);
  $('#sheet-done').addEventListener('click', () => stopEditing());
  sheetText.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopEditing(); });

  /* ---- zoom, for precise work on small screens ---- */
  const ZOOMS = [1, 1.5, 2, 3];
  let zoomIdx = 0;
  const stageWrap = stage.parentElement;
  function applyZoom() {
    const z = ZOOMS[zoomIdx];
    $('#zoom-level').textContent = Math.round(z * 100) + '%';
    $('#zoom-out').disabled = zoomIdx === 0;
    $('#zoom-in').disabled = zoomIdx === ZOOMS.length - 1;
    if (z === 1) { stage.style.width = ''; stage.style.maxWidth = ''; return; }
    const base = Math.min(stageWrap.clientWidth, 1100);
    stage.style.maxWidth = 'none';
    stage.style.width = Math.round(base * z) + 'px';
  }
  function setZoom(i) {
    const before = stageWrap.scrollWidth;
    const midX = stageWrap.scrollLeft + stageWrap.clientWidth / 2;
    const rect = stage.getBoundingClientRect();
    const midY = window.innerHeight / 2 - rect.top;
    const ratioY = midY / rect.height;
    zoomIdx = clamp(i, 0, ZOOMS.length - 1);
    applyZoom();
    const scale = stageWrap.scrollWidth / before;
    stageWrap.scrollLeft = midX * scale - stageWrap.clientWidth / 2;
    const newRect = stage.getBoundingClientRect();
    window.scrollBy(0, newRect.top + ratioY * newRect.height - window.innerHeight / 2);
  }
  $('#zoom-in').addEventListener('click', () => setZoom(zoomIdx + 1));
  $('#zoom-out').addEventListener('click', () => setZoom(zoomIdx - 1));
  const onResize = () => { if (zoomIdx) applyZoom(); };
  window.addEventListener('resize', onResize);
  applyZoom();

  /* ---- adding ---- */
  function setPlacing(type) {
    placing = type;
    document.querySelectorAll('[data-add]').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.add === type)));
    stage.classList.toggle('placing', Boolean(type));
    // Same-length text swap would still reflow on phones, so only the colour changes; the default hint already explains placing.
    hint.classList.toggle('active', Boolean(type));
  }

  function addBubble(type, cxPct, cyPct) {
    const t = TYPES[type];
    const w = t.w;
    const h = clamp(w * (W / H) * t.ratio, 2, 60);
    const x = clamp(cxPct - w / 2, 0, 100 - w);
    const y = clamp(cyPct - h / 2, 0, 100 - h);
    let ty = y + h * 1.5;
    if (ty > 98) ty = y - h * 0.5;
    const b = {
      id: newId(), type, x, y, w, h,
      tx: x + w * 0.3, ty: clamp(ty, 1, 99),
      text: '',
      font: type === 'sfx' ? 'Secular One' : 'Rubik',
      size: t.size,
      bold: type === 'sfx',
      color: type === 'sfx' ? SFX_RED : INK,
    };
    bubbles.push(b);
    selectedId = b.id;
    renderLayer();
    drawShapes();
    markDirty();
    pendingEditId = b.id;
  }

  document.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => setPlacing(placing === btn.dataset.add ? null : btn.dataset.add));
  });

  /* ---- pointer: place, select, move, resize, aim the tail ---- */
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pendingEditId = null;
    const handle = e.target.closest('[data-handle]');
    const bEl = e.target.closest('.bubble');
    if (editingId && bEl && bEl.dataset.id === editingId && e.target.closest('.t')) return; // caret placement

    if (!handle && !bEl) {
      if (placing) {
        const r = stage.getBoundingClientRect();
        const type = placing;
        setPlacing(null);
        e.preventDefault();
        addBubble(type, ((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100);
        return;
      }
      select(null);
      return;
    }

    e.preventDefault();
    const id = handle ? handle.dataset.id : bEl.dataset.id;
    const b = find(id);
    if (!b) return;
    if (editingId && editingId !== id) stopEditing();
    const wasSelected = selectedId === id;
    if (!wasSelected) select(id);
    startDrag(e, b, handle ? handle.dataset.handle : 'move', wasSelected);
  });

  function startDrag(e, b, mode, wasSelected) {
    const rect = stage.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const o = { ...b };
    const MIN = 3;
    let moved = false;
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      moved = true;
      const dx = ((ev.clientX - sx) / rect.width) * 100;
      const dy = ((ev.clientY - sy) / rect.height) * 100;
      if (mode === 'move') {
        b.x = clamp(o.x + dx, -o.w / 2, 100 - o.w / 2);
        b.y = clamp(o.y + dy, -o.h / 2, 100 - o.h / 2);
        b.tx = o.tx + (b.x - o.x);
        b.ty = o.ty + (b.y - o.y);
      } else if (mode === 'tail') {
        b.tx = clamp(o.tx + dx, -2, 102);
        b.ty = clamp(o.ty + dy, -2, 102);
      } else {
        if (mode.includes('w')) { const nx = Math.min(o.x + dx, o.x + o.w - MIN); b.x = nx; b.w = o.x + o.w - nx; }
        if (mode.includes('e')) b.w = Math.max(MIN, o.w + dx);
        if (mode.includes('n')) { const ny = Math.min(o.y + dy, o.y + o.h - MIN); b.y = ny; b.h = o.y + o.h - ny; }
        if (mode.includes('s')) b.h = Math.max(MIN, o.h + dy);
      }
      updateBubbleEl(b);
      drawShapes();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) markDirty();
      else if (wasSelected && mode === 'move') pendingEditId = b.id;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // Listen on the document: the tap's click can land just outside the stage if anything moved under the finger.
  const onClick = () => {
    if (!pendingEditId) return;
    const id = pendingEditId;
    pendingEditId = null;
    startEditing(id);
  };
  document.addEventListener('click', onClick);

  stage.addEventListener('dblclick', (e) => {
    const bEl = e.target.closest('.bubble');
    if (bEl) startEditing(bEl.dataset.id);
  });

  /* ---- toolbar for the selected bubble ---- */
  function changeSelected(fn, { relayout = false } = {}) {
    const b = find(selectedId);
    if (!b) return;
    fn(b);
    if (relayout) renderLayer();
    else updateBubbleEl(b);
    drawShapes();
    markDirty();
  }

  $('#t-edit').addEventListener('click', () => selectedId && startEditing(selectedId));
  $('#t-type').addEventListener('change', (e) => changeSelected((b) => {
    const from = b.type;
    b.type = e.target.value;
    if (b.type === 'sfx' && b.color === INK) { b.color = SFX_RED; b.bold = true; }
    if (from === 'sfx' && b.type !== 'sfx' && b.color === SFX_RED) b.color = INK;
  }, { relayout: true }));
  $('#t-font').addEventListener('change', (e) => changeSelected((b) => { b.font = e.target.value; }));
  $('#t-smaller').addEventListener('click', () => changeSelected((b) => { b.size = n2(clamp(b.size / 1.12, 0.6, 20)); }));
  $('#t-bigger').addEventListener('click', () => changeSelected((b) => { b.size = n2(clamp(b.size * 1.12, 0.6, 20)); }));
  $('#t-bold').addEventListener('click', () => changeSelected((b) => { b.bold = !b.bold; }, { relayout: true }));
  $('#t-color').addEventListener('input', (e) => changeSelected((b) => { b.color = e.target.value; }));
  $('#t-front').addEventListener('click', () => changeSelected((b) => {
    bubbles.splice(bubbles.indexOf(b), 1);
    bubbles.push(b);
  }, { relayout: true }));
  $('#t-dup').addEventListener('click', () => {
    const b = find(selectedId);
    if (!b) return;
    const copy = { ...b, id: newId(), x: clamp(b.x + 3, 0, 100 - b.w), y: clamp(b.y + 3, 0, 100 - b.h), tx: b.tx + 3, ty: b.ty + 3 };
    bubbles.push(copy);
    select(copy.id);
    drawShapes();
    markDirty();
  });
  function deleteSelected() {
    const b = find(selectedId);
    if (!b) return;
    if (editingId) stopEditing();
    bubbles.splice(bubbles.indexOf(b), 1);
    selectedId = null;
    renderLayer();
    drawShapes();
    markDirty();
  }
  $('#t-del').addEventListener('click', deleteSelected);

  /* ---- keyboard ---- */
  const onKey = (e) => {
    if (editingId) return;
    if (e.target.closest?.('input, select, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
    if (e.key === 'Escape') { if (placing) setPlacing(null); else select(null); return; }
    if (!selectedId) return;
    const b = find(selectedId);
    const step = e.shiftKey ? 2 : 0.4;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'Enter') { e.preventDefault(); startEditing(selectedId); }
    else if (nudge) {
      e.preventDefault();
      b.x += nudge[0]; b.tx += nudge[0]; b.y += nudge[1]; b.ty += nudge[1];
      updateBubbleEl(b);
      drawShapes();
      markDirty();
    }
  };
  window.addEventListener('keydown', onKey);

  /* ---- export ---- */
  const exportBtn = $('#export');
  exportBtn.addEventListener('click', async () => {
    if (editingId) stopEditing();
    exportBtn.disabled = true;
    exportBtn.textContent = 'מכין תמונה…';
    try {
      const blob = await renderPageToBlob(page, bubbles);
      const safe = comicTitle.replace(/[\\/:*?"<>|]+/g, '').trim() || 'comic';
      downloadBlob(blob, `${safe} - עמוד ${idx + 1}.jpg`);
    } catch (err) {
      console.error(err);
      toast(heError(err), 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = 'הורדה כתמונה';
    }
  });

  cleanup = async () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('click', onClick);
    window.visualViewport?.removeEventListener('resize', positionSheet);
    window.visualViewport?.removeEventListener('scroll', positionSheet);
    stopEditing();
    if (dirty || savePromise) await saveNow();
    clearTimeout(saveTimer);
  };

  renderLayer();
  drawShapes();
}

init().catch((err) => {
  console.error(err);
  app.innerHTML = `<section class="view"><p class="form-msg">${esc(heError(err))}</p></section>`;
});
