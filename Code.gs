/**
 * Mayafx PM — Google Apps Script backend
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

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
