/**
 * Mayafx PM + HQ — Google Apps Script backend (one Sheet for both apps)
 * Stores Projects + Tasks in this Google Sheet, puts dated tasks on your
 * Google Calendar, reads jobs from the Print Cost calculator, and sends
 * reminders (email + optional phone push).
 *
 * 1) Set KEY below (the calculator link is filled in by the app automatically).
 * 2) Run setupTriggers() once (allow the permissions).
 * 3) Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 */

// ---------- SETTINGS ----------
const KEY        = 'change-this-secret';   // any password; type the same one in the app
const CALC_URL   = '';                     // optional — the app sends this automatically
const CALC_KEY   = '';                     // optional — the app sends this automatically
const CALENDAR_SYNC = true;                // put tasks with a date / reminder on Google Calendar
const CALENDAR_ID   = '';                  // '' = your main calendar
const NTFY_TOPIC = '';                     // optional: ntfy.sh topic for phone push, e.g. 'mayafx-sai-8392'
const DIGEST_HOURS = [9, 14, 20];          // daily summary times (24h, sheet's time zone)
// ------------------------------

const PROJECT_COLS = ['id', 'name', 'branch', 'client', 'status', 'priority', 'startDate', 'dueDate',
  'budget', 'notes', 'deleted', 'createdAt', 'updatedAt', 'calEventId'];
const TASK_COLS = ['id', 'projectId', 'title', 'status', 'priority', 'dueDate', 'remindAt', 'reminded',
  'notes', 'doneAt', 'deleted', 'createdAt', 'updatedAt', 'calEventId'];

function doGet() {
  return json_({ ok: true, app: 'Mayafx PM', hint: 'Use POST from the app.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.key !== KEY) return json_({ ok: false, error: 'Wrong key' });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (body.action) {
        case 'getAll':
          return json_({
            ok: true,
            projects: readAll_('Projects', PROJECT_COLS),
            tasks: readAll_('Tasks', TASK_COLS),
            calc: fetchCalcJobs_()
          });
        case 'upsertProject': upsert_('Projects', PROJECT_COLS, body.record); return json_({ ok: true });
        case 'upsertTask':    upsert_('Tasks', TASK_COLS, body.record);       return json_({ ok: true });
        // ----- HQ: quotes & invoices, settings, Bambu prints -----
        case 'getHQ':        return json_(Object.assign({ ok: true }, getHQ_()));
        case 'upsertQuote':  upsertQuote_(body.record); return json_({ ok: true });
        case 'bulkQuotes':   (body.records || []).forEach(upsertQuote_); return json_({ ok: true, count: (body.records || []).length });
        case 'bulkPrints':   return json_({ ok: true, count: mergePrints_(body.records || []) });
        case 'saveHQSettings':
          PropertiesService.getScriptProperties().setProperty('hqSettings', JSON.stringify(body.settings || {}));
          return json_({ ok: true });
        case 'bambuLogin':   return json_(bambuLogin_(body.email, body.password));
        case 'bambuCode':    return json_(bambuCode_(body.email, body.code));
        case 'bambuToken':   saveBambuToken_(body.email || '', body.token); return json_({ ok: true, done: true });
        case 'bambuSync':    return json_(bambuSync_(body.full ? 40 : 3));
        case 'bambuLogout':  ['bambuToken', 'bambuEmail', 'bambuPending'].forEach(k => PropertiesService.getScriptProperties().deleteProperty(k));
                             return json_({ ok: true });
        case 'setCalc':
          PropertiesService.getScriptProperties().setProperties({ calcUrl: body.calcUrl || '', calcKey: body.calcKey || '' });
          return json_({ ok: true });
        case 'testReminder':  notify_('Mayafx PM test', 'Reminders are working ✔'); return json_({ ok: true });
        default: return json_({ ok: false, error: 'Unknown action' });
      }
    } finally { lock.releaseLock(); }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------- sheet helpers ----------
function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(cols); sh.setFrozenRows(1); }
  const head = sh.getRange(1, 1, 1, sh.getLastColumn() || 1).getValues()[0];
  cols.forEach(c => { if (head.indexOf(c) < 0) { sh.getRange(1, head.length + 1).setValue(c); head.push(c); } });
  return sh;
}

function readAll_(name, cols) {
  const sh = sheet_(name, cols);
  const v = sh.getDataRange().getValues();
  const head = v.shift();
  const tz = Session.getScriptTimeZone();
  return v.filter(r => r[0] !== '').map(r => {
    const o = {};
    head.forEach((h, i) => {
      let x = r[i];
      if (x instanceof Date) x = (h === 'remindAt')
        ? Utilities.formatDate(x, tz, "yyyy-MM-dd'T'HH:mm")
        : Utilities.formatDate(x, tz, 'yyyy-MM-dd');
      o[h] = x;
    });
    return o;
  });
}

function upsert_(name, cols, rec) {
  if (!rec || !rec.id) throw new Error('Missing record id');
  const sh = sheet_(name, cols);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const row = head.map(h => {
    const x = rec[h];
    if (x === undefined || x === null) return '';
    if (typeof x === 'object') return JSON.stringify(x);
    // keep dates as plain text so Sheets doesn't reformat them
    if ((h === 'dueDate' || h === 'startDate' || h === 'remindAt') && x) return "'" + x;
    return x;
  });
  const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0])) : [];
  const i = ids.indexOf(String(rec.id));
  if (i >= 0 && name === 'Tasks') {
    // don't re-send a reminder that already went out, unless the reminder time changed
    const old = sh.getRange(i + 2, 1, 1, head.length).getDisplayValues()[0];
    const rA = head.indexOf('remindAt'), rd = head.indexOf('reminded');
    if (old[rA] === String(rec.remindAt || '') && truthy_(old[rd])) row[rd] = true;
  }
  const cI = head.indexOf('calEventId');
  if (i >= 0 && cI >= 0 && !rec.calEventId) row[cI] = sh.getRange(i + 2, cI + 1).getValue();
  let r;
  if (i >= 0) { r = i + 2; sh.getRange(r, 1, 1, row.length).setValues([row]); }
  else { sh.appendRow(row); r = sh.getLastRow(); }
  if (CALENDAR_SYNC && cI >= 0) {
    try {
      const id = syncEvent_(name, rec, row[cI]);
      if (id !== row[cI]) sh.getRange(r, cI + 1).setValue(id);
    } catch (e) { console.warn('Calendar: ' + e.message); }
  }
}

// ---------- Google Calendar ----------
function cal_() { return CALENDAR_ID ? CalendarApp.getCalendarById(CALENDAR_ID) : CalendarApp.getDefaultCalendar(); }

// Creates / replaces / removes the calendar event for a task or project. Returns the event id ('' if none).
function syncEvent_(kind, rec, oldId) {
  const cal = cal_(), tz = Session.getScriptTimeZone();
  if (oldId) { try { const ev = cal.getEventById(oldId); if (ev) ev.deleteEvent(); } catch (e) {} }
  if (truthy_(rec.deleted)) return '';
  const day = s => Utilities.parseDate(String(s).slice(0, 10), tz, 'yyyy-MM-dd');
  let ev = null;
  if (kind === 'Tasks') {
    if (rec.status === 'Done') return '';
    const desc = (rec.notes || '') + '\n\nFrom Mayafx PM';
    if (rec.remindAt) {
      const start = Utilities.parseDate(String(rec.remindAt).slice(0, 16), tz, "yyyy-MM-dd'T'HH:mm");
      ev = cal.createEvent('✅ ' + rec.title, start, new Date(start.getTime() + 30 * 60000), { description: desc });
      ev.removeAllReminders(); ev.addPopupReminder(0);
    } else if (rec.dueDate) {
      ev = cal.createAllDayEvent('✅ ' + rec.title, day(rec.dueDate), { description: desc });
    }
  } else {
    if (rec.status === 'Done' || !rec.dueDate) return '';
    ev = cal.createAllDayEvent('🎯 Deadline: ' + rec.name, day(rec.dueDate),
      { description: [rec.client, rec.branch, rec.notes].filter(String).join(' · ') + '\n\nFrom Mayafx PM' });
  }
  if (ev) ev.setColor(kind === 'Tasks' ? CalendarApp.EventColor.MAUVE : CalendarApp.EventColor.RED);
  return ev ? ev.getId() : '';
}

// ---------- Print Cost calculator ----------
function fetchCalcJobs_() {
  const P = PropertiesService.getScriptProperties();
  const url = CALC_URL || P.getProperty('calcUrl'), key = CALC_KEY || P.getProperty('calcKey') || '';
  if (!url) return { ok: false, error: 'Calculator not linked yet', jobs: [] };
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'text/plain;charset=utf-8',
      payload: JSON.stringify({ action: 'getAll', key: key }),
      followRedirects: true, muteHttpExceptions: true
    });
    const d = JSON.parse(res.getContentText());
    if (!d.ok) return { ok: false, error: d.error || 'Calculator refused', jobs: [] };
    const keep = ['id', 'srNo', 'date', 'project', 'client', 'jobStatus', 'payment', 'sellingPrice',
      'grams', 'printHrs', 'notes', 'deleted', 'updatedAt'];
    const jobs = (d.jobs || []).map(j => { const o = {}; keep.forEach(k => o[k] = j[k]); return o; })
      .filter(j => !(j.deleted === true || String(j.deleted).toUpperCase() === 'TRUE'));
    return { ok: true, jobs: jobs };
  } catch (err) {
    return { ok: false, error: 'Could not reach calculator: ' + err.message, jobs: [] };
  }
}

// ---------- reminders ----------
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkReminders').timeBased().everyHours(1).create();
  sheet_('Projects', PROJECT_COLS); sheet_('Tasks', TASK_COLS);
  if (CALENDAR_SYNC) cal_().getName();   // asks for Calendar permission now
  notify_('Mayafx PM is set up', 'You will get task reminders and a summary at ' + DIGEST_HOURS.join(', ') + " o'clock.");
}

function truthy_(x) { return x === true || String(x).toUpperCase() === 'TRUE'; }

function checkReminders() {
  try { if (PropertiesService.getScriptProperties().getProperty('bambuToken')) bambuSync_(2); } catch (e) { console.warn('Bambu: ' + e.message); }
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const nowStr = Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm");
  const todayStr = nowStr.slice(0, 10);
  const tasks = readAll_('Tasks', TASK_COLS).filter(t => !truthy_(t.deleted) && t.status !== 'Done');
  const projects = readAll_('Projects', PROJECT_COLS);
  const pname = id => {
    const p = projects.find(x => x.id === id);
    return p ? p.name : (String(id).indexOf('calc:') === 0 ? '3D print job' : '');
  };

  // 1) individual reminders that are due
  const due = tasks.filter(t => t.remindAt && String(t.remindAt) <= nowStr && !truthy_(t.reminded));
  if (due.length) {
    const lines = due.map(t => '• ' + t.title + (pname(t.projectId) ? '  (' + pname(t.projectId) + ')' : ''));
    notify_('⏰ Reminder: ' + (due.length === 1 ? due[0].title : due.length + ' tasks'), lines.join('\n'));
    const sh = sheet_('Tasks', TASK_COLS);
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const col = head.indexOf('reminded') + 1;
    const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]));
    due.forEach(t => { const i = ids.indexOf(String(t.id)); if (i >= 0) sh.getRange(i + 2, col).setValue(true); });
  }

  // 2) summary at the digest hours
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const stamp = todayStr + ' ' + hour;
  const props = PropertiesService.getScriptProperties();
  if (DIGEST_HOURS.indexOf(hour) >= 0 && props.getProperty('lastDigest') !== stamp) {
    props.setProperty('lastDigest', stamp);
    const overdue = tasks.filter(t => t.dueDate && t.dueDate < todayStr);
    const today = tasks.filter(t => t.dueDate === todayStr);
    const doing = tasks.filter(t => t.status === 'Doing' && !(t.dueDate && t.dueDate <= todayStr));
    const calc = fetchCalcJobs_().jobs || [];
    const toPrint = calc.filter(j => (j.jobStatus || 'Not started') !== 'Done');
    const toCollect = calc.filter(j => j.jobStatus === 'Done' && (j.payment || 'Unpaid') !== 'Paid');
    const fmt = t => '• ' + t.title + (pname(t.projectId) ? '  (' + pname(t.projectId) + ')' : '');
    const parts = [];
    if (overdue.length) parts.push('OVERDUE\n' + overdue.map(fmt).join('\n'));
    if (today.length) parts.push('DUE TODAY\n' + today.map(fmt).join('\n'));
    if (doing.length) parts.push('IN PROGRESS\n' + doing.map(fmt).join('\n'));
    if (toPrint.length) parts.push('PRINT QUEUE\n' + toPrint.map(j => '• #' + j.srNo + ' ' + j.project + ' — ' + (j.jobStatus || 'Not started')).join('\n'));
    if (toCollect.length) parts.push('COLLECT PAYMENT\n' + toCollect.map(j => '• #' + j.srNo + ' ' + j.project + (j.client ? ' (' + j.client + ')' : '') + ' — ₹' + j.sellingPrice).join('\n'));
    if (parts.length) {
      const title = hour < 12 ? 'Good morning — today\'s plan' : hour < 17 ? 'Afternoon check-in' : 'Evening wind-up';
      notify_('Mayafx · ' + title, parts.join('\n\n'));
    }
  }
}

function notify_(title, text) {
  const email = Session.getEffectiveUser().getEmail();
  if (email) MailApp.sendEmail({ to: email, subject: title, body: text + '\n\n— Mayafx PM' });
  if (NTFY_TOPIC) {
    try {
      UrlFetchApp.fetch('https://ntfy.sh/' + encodeURIComponent(NTFY_TOPIC), {
        method: 'post', payload: text, muteHttpExceptions: true,
        headers: { Title: title.replace(/[^\x20-\x7E]/g, '').trim() || 'Mayafx PM', Tags: 'bell' }
      });
    } catch (e) { /* email still went */ }
  }
}

// =====================================================================
// HQ: quotes & invoices
// =====================================================================
const QUOTE_COLS = ['id', 'type', 'number', 'date', 'due_date', 'client', 'phone', 'total', 'paid', 'status',
  'data', 'deleted', 'createdAt', 'updatedAt'];
const PRINT_COLS = ['id', 'title', 'printer', 'start', 'end', 'seconds', 'grams', 'filament', 'colors', 'status', 'cover'];

function upsertQuote_(q) {
  if (!q || !q.id) throw new Error('Missing quote id');
  const rec = {};
  QUOTE_COLS.forEach(c => rec[c] = q[c]);
  rec.data = JSON.stringify(q);          // full quote (items, payments, notes) kept as JSON
  upsert_('Quotes', QUOTE_COLS, rec);
}

function getHQ_() {
  const P = PropertiesService.getScriptProperties();
  const quotes = readAll_('Quotes', QUOTE_COLS).filter(r => !truthy_(r.deleted)).map(r => {
    try { return JSON.parse(r.data); } catch (e) { return null; }
  }).filter(Boolean);
  const prints = readPrints_().slice(0, 400);
  let settings = {}, devices = [], bambu = {};
  try { settings = JSON.parse(P.getProperty('hqSettings') || '{}'); } catch (e) {}
  try { devices = JSON.parse(P.getProperty('bambuDevices') || '[]'); } catch (e) {}
  try { bambu = JSON.parse(P.getProperty('bambuMeta') || '{}'); } catch (e) {}
  bambu.loggedIn = !!P.getProperty('bambuToken');
  bambu.email = P.getProperty('bambuEmail') || '';
  return { quotes: quotes, settings: settings, prints: prints, devices: devices, bambu: bambu };
}

// =====================================================================
// HQ: Bambu Lab cloud (print history) — runs on Google's servers, no helper needed
// =====================================================================
const BAMBU_API = 'https://api.bambulab.com';   // use https://api.bambulab.cn for a China account
const BAMBU_HEADERS = {
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer', 'X-BBL-Client-Type': 'slicer', 'X-BBL-Client-Version': '01.09.05.01'
};
const BAMBU_STATUS = { 1: 'Printing', 2: 'Done', 3: 'Failed', 4: 'Cancelled', 5: 'Done' };

function bambu_(method, url, body, token) {
  const headers = Object.assign({}, BAMBU_HEADERS);
  if (token) headers.Authorization = 'Bearer ' + token;
  const opt = { method: method, headers: headers, muteHttpExceptions: true, followRedirects: true };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(url, opt);
  const txt = r.getContentText();
  let js = {};
  try { js = txt.trim() ? JSON.parse(txt) : {}; } catch (e) { js = { error: txt.slice(0, 200) }; }
  let cookies = r.getAllHeaders()['Set-Cookie'] || [];
  if (!Array.isArray(cookies)) cookies = [cookies];
  return { status: r.getResponseCode(), js: js, cookies: cookies };
}

function saveBambuToken_(email, token) {
  const P = PropertiesService.getScriptProperties();
  P.setProperty('bambuToken', token);
  if (email) P.setProperty('bambuEmail', email);
  P.deleteProperty('bambuPending');
}

function bambuLogin_(email, password) {
  const r = bambu_('post', BAMBU_API + '/v1/user-service/user/login', { account: email, password: password, apiError: '' });
  if (r.js.accessToken) { saveBambuToken_(email, r.js.accessToken); return { ok: true, done: true }; }
  const P = PropertiesService.getScriptProperties();
  if (r.js.loginType === 'verifyCode') {
    bambu_('post', BAMBU_API + '/v1/user-service/user/sendemail/code', { email: email, type: 'codeLogin' });
    P.setProperty('bambuPending', JSON.stringify({ type: 'verifyCode' }));
    return { ok: true, needCode: true, msg: 'Bambu emailed you a 6-digit code. Enter it below.' };
  }
  if (r.js.loginType === 'tfa') {
    P.setProperty('bambuPending', JSON.stringify({ type: 'tfa', tfaKey: r.js.tfaKey }));
    return { ok: true, needCode: true, msg: 'Enter the code from your authenticator app.' };
  }
  return { ok: false, msg: 'Login failed (' + r.status + '): ' + JSON.stringify(r.js).slice(0, 160) };
}

function bambuCode_(email, code) {
  const P = PropertiesService.getScriptProperties();
  let p = { type: 'verifyCode' };
  try { p = JSON.parse(P.getProperty('bambuPending') || '{}') || p; } catch (e) {}
  let token = '';
  if (p.type === 'tfa') {
    const r = bambu_('post', 'https://bambulab.com/api/sign-in/tfa', { tfaKey: p.tfaKey, tfaCode: code });
    token = r.js.accessToken || '';
    if (!token) r.cookies.forEach(c => { if (String(c).indexOf('token=') === 0) token = String(c).split(';')[0].slice(6); });
  } else {
    const r = bambu_('post', BAMBU_API + '/v1/user-service/user/login', { account: email, code: code });
    token = r.js.accessToken || '';
  }
  if (!token) return { ok: false, msg: 'Code not accepted. Try again.' };
  saveBambuToken_(email, token);
  return { ok: true, done: true };
}

function itemsOf_(js) {
  if (!js || typeof js !== 'object') return null;
  for (const k of ['hits', 'tasks', 'data', 'list']) {
    const v = js[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') for (const k2 of ['hits', 'tasks', 'list']) if (Array.isArray(v[k2])) return v[k2];
  }
  return null;
}

function normTask_(t) {
  const ams = t.amsDetailMapping || [];
  const ft = (ams.find(a => a.filamentType) || {}).filamentType || 'PLA';
  const colors = ams.map(a => a.sourceColor || a.targetColor).filter(Boolean).map(c => '#' + String(c).slice(0, 6));
  let status = BAMBU_STATUS[t.status] || String(t.status);
  if (!t.endTime && t.status === 1) status = 'Printing';
  return { id: String(t.id), title: t.title || t.designTitle || 'Untitled', printer: t.deviceName || t.deviceModel || '',
    start: t.startTime || '', end: t.endTime || '', seconds: Number(t.costTime || 0), grams: Number(t.weight || 0),
    filament: ft, colors: colors.join(' '), status: status, cover: t.cover || '' };
}

function bambuSync_(maxPages) {
  const P = PropertiesService.getScriptProperties();
  const token = P.getProperty('bambuToken');
  if (!token) return { ok: false, msg: 'Not logged in to Bambu' };
  const meta = {};
  const dev = bambu_('get', BAMBU_API + '/v1/iot-service/api/user/bind', null, token);
  if (dev.status === 401) { meta.error = 'Bambu login expired — log in again'; P.setProperty('bambuMeta', JSON.stringify(meta)); return { ok: false, msg: meta.error, expired: true }; }
  if (dev.status === 403 || dev.status >= 500) {
    meta.error = 'Bambu refused the connection (' + dev.status + ')';
    P.setProperty('bambuMeta', JSON.stringify(meta)); return { ok: false, msg: meta.error };
  }
  const devices = ((dev.js && dev.js.devices) || []).map(d => ({ id: d.dev_id, name: d.name,
    model: d.dev_product_name || d.dev_model_name, online: !!d.online, status: d.print_status || '' }));
  P.setProperty('bambuDevices', JSON.stringify(devices));

  const seen = {};
  let after = null, total = null;
  for (let page = 0; page < maxPages; page++) {
    const url = BAMBU_API + '/v1/user-service/my/tasks?limit=100' + (after ? '&after=' + after : '');
    const r = bambu_('get', url, null, token);
    if (r.status === 401) { meta.error = 'Bambu login expired — log in again'; break; }
    const items = itemsOf_(r.js);
    if (!items) { meta.error = 'Unexpected reply from Bambu'; break; }
    if (total === null && typeof r.js.total === 'number') total = r.js.total;
    let fresh = 0;
    items.forEach(t => { const id = String(t.id); if (!seen[id]) { seen[id] = normTask_(t); fresh++; } });
    if (!items.length || !fresh || items.length < 100) break;
    after = items[items.length - 1].id;
  }
  const count = mergePrints_(Object.keys(seen).map(k => seen[k]));
  meta.lastSync = new Date().toISOString(); meta.fetched = Object.keys(seen).length; meta.cloudTotal = total; meta.saved = count;
  P.setProperty('bambuMeta', JSON.stringify(meta));
  return Object.assign({ ok: !meta.error, msg: meta.error || 'Synced' }, meta, { devices: devices.length });
}

// merge print records into the Prints sheet (by id), newest first. Returns total rows.
function mergePrints_(list) {
  const sh = sheet_('Prints', PRINT_COLS);
  const all = {};
  readPrints_().forEach(p => all[p.id] = p);
  list.forEach(p => { if (p && p.id) all[String(p.id)] = Object.assign({}, all[String(p.id)], p, { colors: Array.isArray(p.colors) ? p.colors.join(' ') : (p.colors || '') }); });
  const rows = Object.keys(all).map(k => all[k]).sort((a, b) => String(b.start).localeCompare(String(a.start)))
    .map(p => PRINT_COLS.map(c => p[c] == null ? '' : (c === 'start' || c === 'end' ? "'" + p[c] : p[c])));
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, PRINT_COLS.length).setValues(rows);
  return rows.length;
}

function readPrints_() {
  const sh = sheet_('Prints', PRINT_COLS);
  if (sh.getLastRow() < 2) return [];
  const v = sh.getRange(1, 1, sh.getLastRow(), PRINT_COLS.length).getDisplayValues();
  const head = v.shift();
  return v.filter(r => r[0]).map(r => { const o = {}; head.forEach((h, i) => o[h] = r[i]); o.seconds = Number(o.seconds) || 0; o.grams = Number(o.grams) || 0; return o; });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
