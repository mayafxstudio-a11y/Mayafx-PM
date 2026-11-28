"""
Mayafx HQ AI — the centre of HQ.

  HQ app  ──►  this AI server  ──►  local AI (Ollama, laptop first, desktop backup)
                     │
                     ├─ reads HQ data from your Google Sheet (same Apps Script the HQ uses)
                     │    projects, to-dos, Print Cost jobs, quotes & invoices, prints, HQ apps
                     ├─ writes to-dos / reminders back into HQ
                     ├─ finds your n8n workflows tagged "hq" and can run them (its tools)
                     └─ answers you on Telegram

Only Python's built-in libraries. Settings come from the .env file.
"""
import json, os, re, threading, time, uuid, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

E = os.environ.get
try:
    TZ = ZoneInfo("Asia/Kolkata")
except Exception:  # no tz database in the container
    TZ = timezone(timedelta(hours=5, minutes=30))
SHEET_URL = E("HQ_SHEET_URL", "")          # Apps Script /exec URL (HQ Settings)
HQ_KEY = E("HQ_KEY", "")                   # same KEY as in Code.gs
MODEL = E("HQ_MODEL", "mayafx-hq")
OLLAMAS = [u.rstrip("/") for u in (E("LAPTOP_OLLAMA_URL", ""), E("DESKTOP_OLLAMA_URL", "http://ollama:11434")) if u]
N8N_URL = E("N8N_URL", "http://n8n:5678").rstrip("/")
N8N_API_KEY = E("N8N_API_KEY", "")
TG_TOKEN, TG_CHAT = E("TELEGRAM_BOT_TOKEN", ""), E("TELEGRAM_CHAT_ID", "").strip()
ORIGINS = [o.strip() for o in E("ALLOWED_ORIGINS", "https://mayafxstudio-a11y.github.io").split(",")]
PORT = int(E("PORT", "8787"))


# ------------------------------------------------------------------ small helpers
def now():
    return datetime.now(TZ)


def http(url, data=None, headers=None, timeout=60, method=None):
    body = None if data is None else (data if isinstance(data, bytes) else json.dumps(data).encode())
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except ValueError:
        return {"raw": raw}


def num(v):
    try:
        return float(str(v).replace(",", "").replace("₹", "").strip() or 0)
    except ValueError:
        return 0.0


def inr(v):
    return "₹" + f"{round(v):,}"


def truthy(x):
    return x is True or str(x).upper() == "TRUE"


# ------------------------------------------------------------------ HQ data (Google Sheet)
_cache = {"t": 0, "d": None}
_lock = threading.Lock()


def sheet(action, **extra):
    if not SHEET_URL:
        raise RuntimeError("HQ_SHEET_URL is empty in .env")
    d = http(SHEET_URL, dict(extra, action=action, key=HQ_KEY), {"Content-Type": "text/plain;charset=utf-8"}, timeout=90)
    if d.get("ok") is False:
        raise RuntimeError(d.get("error", "Sheet refused"))
    return d


def hq_data(fresh=False):
    with _lock:
        if not fresh and _cache["d"] and time.time() - _cache["t"] < 60:
            return _cache["d"]
        a, b = sheet("getAll"), sheet("getHQ")
        d = {
            "projects": [p for p in a.get("projects", []) if not truthy(p.get("deleted"))],
            "tasks": [t for t in a.get("tasks", []) if not truthy(t.get("deleted"))],
            "calc": (a.get("calc") or {}).get("jobs", []),
            "quotes": b.get("quotes", []),
            "prints": b.get("prints", []),
            "apps": (b.get("settings") or {}).get("apps") or [],
        }
        _cache.update(t=time.time(), d=d)
        return d


def save_task(rec):
    rec["updatedAt"] = now().isoformat()
    sheet("upsertTask", record=rec)
    _cache["t"] = 0


# ------------------------------------------------------------------ what's going on (plain facts)
def facts(d):
    t = now()
    today, nowstr, ym = t.strftime("%Y-%m-%d"), t.strftime("%Y-%m-%dT%H:%M"), t.strftime("%Y-%m")
    pname = {p["id"]: p.get("name", "") for p in d["projects"]}
    openT = [x for x in d["tasks"] if x.get("status") != "Done"]
    lbl = lambda x: f"- {x.get('title')}" + (f" ({pname.get(x.get('projectId'), '')})" if pname.get(x.get("projectId")) else "") + (f" · due {x['dueDate']}" if x.get("dueDate") else "")
    overdue = [x for x in openT if x.get("dueDate") and str(x["dueDate"]) < today]
    due_today = [x for x in openT if str(x.get("dueDate")) == today]
    doing = [x for x in openT if x.get("status") == "Doing" and x not in overdue + due_today]
    upcoming = sorted([x for x in openT if x.get("remindAt") and str(x["remindAt"]) > nowstr], key=lambda x: x["remindAt"])[:8]
    done_today = [x for x in d["tasks"] if x.get("status") == "Done" and str(x.get("doneAt", "")).startswith(today)]
    projects = [p for p in d["projects"] if p.get("status") not in ("Done",)]
    to_print = [j for j in d["calc"] if (j.get("jobStatus") or "Not started") != "Done"]
    to_collect = [j for j in d["calc"] if j.get("jobStatus") == "Done" and (j.get("payment") or "Unpaid") != "Paid"]
    invoices, month_in = [], 0.0
    for q in d["quotes"]:
        if q.get("deleted"):
            continue
        pays = q.get("payments") or []
        month_in += sum(num(p.get("amount")) for p in pays if str(p.get("date", "")).startswith(ym))
        if q.get("type") == "invoice":
            total = sum(num(i.get("qty")) * num(i.get("rate")) for i in q.get("items") or []) - num(q.get("discount")) if q.get("items") else num(q.get("total"))
            bal = total - sum(num(p.get("amount")) for p in pays)
            if bal > 0.5:
                late = bool(q.get("due_date")) and str(q["due_date"]) < today
                invoices.append(f"- {q.get('number', '')} {q.get('client', '')}: {inr(bal)} {'OVERDUE' if late else 'due ' + str(q.get('due_date') or '')}")
    week_ago = (t - timedelta(days=7)).strftime("%Y-%m-%d")
    prints_week = [p for p in d["prints"] if str(p.get("start", ""))[:10] >= week_ago]
    sec = lambda title, rows: f"{title}:\n" + ("\n".join(rows) if rows else "- none")
    return "\n\n".join([
        f"Now: {t.strftime('%A %d %b %Y, %H:%M')} (IST)",
        sec("OVERDUE to-dos", [lbl(x) for x in overdue]),
        sec("DUE TODAY", [lbl(x) for x in due_today]),
        sec("IN PROGRESS", [lbl(x) for x in doing][:10]),
        sec("UPCOMING REMINDERS", [f"- {x['remindAt'].replace('T', ' ')} {x.get('title')}" for x in upcoming]),
        sec("DONE TODAY", [f"- {x.get('title')}" for x in done_today]),
        sec("ACTIVE PROJECTS", [f"- {p.get('name')} [{p.get('branch', '')}] {p.get('status', '')}" + (f" · due {p['dueDate']}" if p.get("dueDate") else "") for p in projects][:15]),
        sec("PRINT QUEUE (Print Cost)", [f"- #{j.get('srNo')} {j.get('project')} ({j.get('client', '')}) {j.get('jobStatus') or 'Not started'}" for j in to_print]),
        sec("COLLECT PAYMENT (Print Cost)", [f"- #{j.get('srNo')} {j.get('project')} ({j.get('client', '')}) {inr(num(j.get('sellingPrice')))}" for j in to_collect]),
        sec("UNPAID INVOICES", invoices),
        f"MONEY THIS MONTH: received {inr(month_in)} (invoice payments) · still to collect from prints {inr(sum(num(j.get('sellingPrice')) for j in to_collect))}",
        f"PRINTS LAST 7 DAYS: {len(prints_week)} prints, {round(sum(num(p.get('grams')) for p in prints_week))} g",
    ])


def apps_text(d):
    rows = []
    for a in d["apps"]:
        line = f"- {a.get('name')}: {a.get('about') or 'no description'}"
        if a.get("data"):
            try:
                js = http(a["data"], {"action": "getAll", "key": HQ_KEY}, {"Content-Type": "text/plain;charset=utf-8"}, timeout=30)
                line += "\n  data: " + json.dumps(js, ensure_ascii=False)[:1500]
            except Exception as e:
                line += f" (data not reachable: {e})"
        rows.append(line)
    return "HQ APPS:\n" + ("\n".join(rows) or "- PM (projects & to-dos), Print Cost (3D print jobs), Quotes & Invoices, Prints (Bambu history)")


# ------------------------------------------------------------------ n8n tools (workflows tagged "hq")
_tools = {"t": 0, "list": []}


def n8n_tools():
    if not N8N_API_KEY:
        return []
    if time.time() - _tools["t"] < 120:
        return _tools["list"]
    out = []
    try:
        d = http(f"{N8N_URL}/api/v1/workflows?active=true&limit=100", headers={"X-N8N-API-KEY": N8N_API_KEY}, timeout=20)
        for wf in d.get("data", []):
            if "hq" not in [str(tg.get("name", "")).lower() for tg in wf.get("tags") or []]:
                continue
            hook = next((n for n in wf.get("nodes", []) if n.get("type") == "n8n-nodes-base.webhook"), None)
            if not hook:
                continue
            note = next((n["parameters"].get("content", "") for n in wf.get("nodes", []) if n.get("type") == "n8n-nodes-base.stickyNote"), "")
            out.append({"name": wf["name"], "path": hook["parameters"].get("path", ""), "about": re.sub(r"[#*]", "", note).strip()[:400]})
    except Exception as e:
        print("n8n tools:", e)
    _tools.update(t=time.time(), list=out)
    return out


def run_tool(name, data):
    tool = next((x for x in n8n_tools() if x["name"].lower() == str(name).lower() or x["path"] == name), None)
    if not tool:
        return f"no n8n tool called {name}"
    try:
        http(f"{N8N_URL}/webhook/{tool['path']}", data or {}, {"Content-Type": "application/json"}, timeout=120)
        return f"ran {tool['name']}"
    except Exception as e:
        return f"{tool['name']} failed: {e}"


def tools_text():
    t = n8n_tools()
    return "N8N TOOLS (run_workflow):\n" + ("\n".join(f"- {x['name']}: {x['about'] or 'no description'}" for x in t) or "- none connected")


# ------------------------------------------------------------------ local AI
def ask_ai(prompt, as_json=False):
    for u in OLLAMAS:
        try:
            http(u + "/api/tags", timeout=3)
            r = http(u + "/api/generate", {"model": MODEL, "prompt": prompt, "stream": False, "think": False, **({"format": "json"} if as_json else {})}, {"Content-Type": "application/json"}, timeout=300)
            if r.get("response"):
                return re.sub(r"<think>[\s\S]*?</think>", "", r["response"]).strip()
        except Exception:
            continue
    return ""


# ------------------------------------------------------------------ actions the AI can take
def new_task(title, due="", remind="", prio="Normal", project=""):
    t = now().isoformat()
    rec = {"id": "ai" + uuid.uuid4().hex[:10], "projectId": project, "title": title, "status": "To do", "priority": prio or "Normal",
           "dueDate": due or "", "remindAt": remind or "", "reminded": False, "notes": "Added by HQ AI", "doneAt": "",
           "deleted": False, "createdAt": t, "updatedAt": t, "calEventId": ""}
    save_task(rec)
    return f"✅ Added to-do: {title}" + (f" · due {due}" if due else "") + (f" · ⏰ {remind.replace('T', ' ')}" if remind else "")


def find_task(q):
    q = str(q).lower().strip()
    open_ = [x for x in hq_data()["tasks"] if x.get("status") != "Done"]
    exact = next((x for x in open_ if x["id"].lower() == q), None) or next((x for x in open_ if q and q in str(x.get("title", "")).lower()), None)
    if exact:
        return exact
    words = [w[:4] for w in re.findall(r"\w+", q) if len(w) > 2]
    best, score = None, 0
    for x in open_:
        title = str(x.get("title", "")).lower()
        sc = sum(1 for w in words if w in title)
        if sc > score:
            best, score = x, sc
    return best if words and score >= max(1, len(words) / 2) else None


def done_task(q):
    t = find_task(q)
    if not t:
        return f"Couldn't find an open to-do matching “{q}”."
    t = dict(t, status="Done", doneAt=now().strftime("%Y-%m-%d"))
    save_task(t)
    return f"🎉 Done: {t['title']}"


def norm_remind(s):
    """Accepts 'YYYY-MM-DD HH:MM', 'YYYY-MM-DDTHH:MM', 'tomorrow 10:00', 'today 18:30', '10am', 'in 2h'."""
    if not s:
        return ""
    s = str(s).strip().lower()
    s = re.sub(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", lambda m: f"{int(m[1]) % 12 + (12 if m[3] == 'pm' else 0):02d}:{m[2] or '00'}", s)
    t = now()
    if m := re.match(r"in\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)", s):
        d = t + (timedelta(hours=int(m[1])) if m[2].startswith("h") else timedelta(minutes=int(m[1])))
        return d.strftime("%Y-%m-%dT%H:%M")
    if m := re.match(r"(\d{4}-\d{2}-\d{2})[ t](\d{1,2}):(\d{2})", s):
        return f"{m[1]}T{int(m[2]):02d}:{m[3]}"
    day = t
    if s.startswith("tomorrow") or s.startswith("tmrw"):
        day = t + timedelta(days=1)
    if m := re.search(r"(\d{1,2}):(\d{2})", s):
        d = day.replace(hour=int(m[1]), minute=int(m[2]))
        if d < t and day is t:
            d += timedelta(days=1)
        return d.strftime("%Y-%m-%dT%H:%M")
    return ""


def norm_date(s):
    if not s:
        return ""
    s = str(s).strip().lower()
    if re.match(r"\d{4}-\d{2}-\d{2}$", s):
        return s
    if s in ("today",):
        return now().strftime("%Y-%m-%d")
    if s in ("tomorrow", "tmrw"):
        return (now() + timedelta(days=1)).strftime("%Y-%m-%d")
    return ""


def do_actions(actions):
    out = []
    for a in actions or []:
        try:
            typ = a.get("type")
            if typ == "add_todo" and a.get("title"):
                out.append(new_task(a["title"], norm_date(a.get("dueDate")), norm_remind(a.get("remindAt")), (a.get("priority") or "Normal").title()))
            elif typ == "done_todo" and a.get("query"):
                out.append(done_task(a["query"]))
            elif typ == "run_workflow" and a.get("name"):
                out.append("⚙ " + run_tool(a["name"], a.get("data") or {}))
        except Exception as e:
            out.append(f"⚠ {typ} failed: {e}")
    return out


# ------------------------------------------------------------------ quick commands (work even if the AI is off)
HELP = """Mayafx HQ commands
/today – what's due, late, to collect
/todo <text> [today|tomorrow|2026-12-20] [at 10am]
/remind <tomorrow 10am | in 2h | 2026-12-01 18:00> <text>
/done <words from the to-do>
/tools – n8n workflows I can run
Or just talk normally."""


def quick(text):
    m = re.match(r"^/(\w+)(?:@\w+)?\s*([\s\S]*)$", text.strip())
    if not m:
        return None
    cmd, arg = m[1].lower(), m[2].strip()
    if cmd in ("start", "help"):
        return HELP
    if cmd == "today":
        return facts(hq_data(True))
    if cmd == "tools":
        return tools_text()
    if cmd == "done":
        return done_task(arg)
    if cmd == "todo":
        tm = due = ""
        if mm := re.search(r"\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)", arg, re.I):
            tm, arg = mm[1], arg.replace(mm[0], "")
        if mm := re.search(r"\b(today|tomorrow|tmrw|\d{4}-\d{2}-\d{2})\b", arg, re.I):
            due, arg = norm_date(mm[1]), arg.replace(mm[0], "")
        remind = norm_remind(f"{due} {tm}" if due else tm) if tm else ""
        title = re.sub(r"\s+", " ", arg).strip(" ,")
        return new_task(title, due or remind[:10], remind) if title else "What's the to-do? e.g. /todo call Shankar tomorrow at 10am"
    if cmd == "remind":
        mm = re.match(r"(in\s+\d+\s*\w+|(?:today|tomorrow|tmrw|\d{4}-\d{2}-\d{2})\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+)", arg, re.I)
        if not mm or not norm_remind(mm[1]):
            return "e.g. /remind tomorrow 10am call Shankar"
        r = norm_remind(mm[1])
        return new_task(mm[2], r[:10], r)
    return HELP


# ------------------------------------------------------------------ chat + summary
def chat(message, history=None):
    q = quick(message)
    if q is not None:
        return {"reply": q, "actions": []}
    d = hq_data()
    hist = "\n".join(f"{h.get('role', 'user')}: {h.get('text', '')}" for h in (history or [])[-6:])
    prompt = f"""{facts(d)}

{apps_text(d)}

{tools_text()}

You are Mayafx HQ AI. Answer Sai using the HQ data above. Simple English, short.
You can act. Return ONLY JSON: {{"reply":"text for Sai","actions":[...]}}
Possible actions:
 {{"type":"add_todo","title":"...","dueDate":"YYYY-MM-DD or today/tomorrow or empty","remindAt":"YYYY-MM-DD HH:MM or 'tomorrow 10:00' or empty","priority":"Low|Normal|High"}}  (a reminder = a to-do with remindAt)
 {{"type":"done_todo","query":"words of the to-do"}}
 {{"type":"run_workflow","name":"exact n8n tool name","data":{{...}}}}
Only add actions when Sai asks for them. Never invent numbers.

Recent chat:
{hist}
Sai: {message}"""
    raw = ask_ai(prompt, as_json=True)
    if not raw:
        return {"reply": "The AI is offline (laptop and desktop models not reachable). Commands like /today and /todo still work.", "actions": []}
    try:
        j = json.loads(raw)
    except ValueError:
        j = {"reply": raw, "actions": []}
    done = do_actions(j.get("actions"))
    reply = str(j.get("reply") or "").strip()
    if done:
        reply = (reply + "\n\n" if reply else "") + "\n".join(done)
    return {"reply": reply or "OK.", "actions": done}


SLOTS = {
    "morning": "Give today's plan in max 6 bullets: top 3 tasks in order, 1 money action (invoice or print payment to chase), 1 risk. If someone owes money, add a short polite WhatsApp reminder for the oldest one.",
    "afternoon": "3 bullets: is the day on track, one quick win for the next 30 minutes, what to drop if short on time.",
    "evening": "3 bullets: what moved today, what to park, the first task for tomorrow morning. Remind him to post tonight if a post is due.",
    "night": "Short day recap (3 bullets). Then explain 1–2 technical or business concepts from today's work in plain beginner words (2–3 lines each) so Sai understands what he did. End with one line of encouragement.",
    "home": "Write a short HQ summary for the home screen: 3–5 bullets on what needs attention now, then 1 line on money.",
}


def summary(slot="auto"):
    h = now().hour
    if slot == "auto":
        slot = "morning" if h < 12 else "afternoon" if h < 17 else "evening" if h < 22 else "night"
    f = facts(hq_data(True))
    ai = ask_ai(f"{f}\n\n{SLOTS.get(slot, SLOTS['home'])}\nSimple English, no long paragraphs.")
    titles = {"morning": "☀️ Good morning Sai", "afternoon": "🕑 2 PM check-in", "evening": "🌙 8 PM wind-up", "night": "🌌 Day recap", "home": "🏠 HQ now"}
    text = f"{titles.get(slot, 'HQ')}\n\n" + (ai if ai else f"(AI offline, data only)\n\n{f}")
    return {"slot": slot, "text": text, "facts": f}


def due_reminders():
    nowstr = now().strftime("%Y-%m-%dT%H:%M")
    items = []
    for t in hq_data(True)["tasks"]:
        if t.get("status") == "Done" or truthy(t.get("reminded")) or not t.get("remindAt"):
            continue
        if str(t["remindAt"]) <= nowstr:
            save_task(dict(t, reminded=True))
            items.append({"id": t["id"], "text": f"⏰ Reminder: {t.get('title')}" + (f"\n{t['notes']}" if t.get("notes") and t["notes"] != "Added by HQ AI" else "")})
    return {"items": items}


# ------------------------------------------------------------------ Telegram (polling: no public URL needed)
def tg(method, data, timeout=70):
    return http(f"https://api.telegram.org/bot{TG_TOKEN}/{method}", data, {"Content-Type": "application/json"}, timeout=timeout)


def tg_send(chat_id, text):
    for i in range(0, max(len(text), 1), 3900):
        tg("sendMessage", {"chat_id": chat_id, "text": text[i:i + 3900] or "…", "disable_web_page_preview": True}, 30)


def typing(chat_id, stop):
    while not stop.is_set():
        try:
            tg("sendChatAction", {"chat_id": chat_id, "action": "typing"}, 10)
        except Exception:
            pass
        stop.wait(5)


def telegram_loop():
    if not TG_TOKEN:
        return
    offset, history = 0, []
    print("Telegram bot running")
    while True:
        try:
            for u in tg("getUpdates", {"timeout": 50, "offset": offset, "allowed_updates": ["message"]}).get("result", []):
                offset = u["update_id"] + 1
                msg = u.get("message") or {}
                chat_id, text = str(msg.get("chat", {}).get("id", "")), msg.get("text") or ""
                if not chat_id or not text:
                    continue
                if not TG_CHAT:
                    tg_send(chat_id, f"Your chat id is {chat_id}. Put it in .env as TELEGRAM_CHAT_ID and restart.")
                    continue
                if chat_id != TG_CHAT:
                    continue
                stop = threading.Event()
                threading.Thread(target=typing, args=(chat_id, stop), daemon=True).start()
                try:
                    r = chat(text, history)
                except Exception as e:
                    r = {"reply": f"HQ error: {e}"}
                stop.set()
                history = (history + [{"role": "user", "text": text}, {"role": "ai", "text": r["reply"]}])[-8:]
                tg_send(chat_id, r["reply"])
        except Exception as e:
            print("telegram:", e)
            time.sleep(5)


# ------------------------------------------------------------------ web API (used by HQ app and n8n)
class H(BaseHTTPRequestHandler):
    def cors(self):
        o = self.headers.get("Origin", "")
        if o in ORIGINS or "*" in ORIGINS or o.startswith("http://localhost"):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-HQ-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def reply(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/health"):
            return self.reply(200, {"ok": True, "ai": OLLAMAS, "sheet": bool(SHEET_URL), "n8n_tools": len(n8n_tools()), "telegram": bool(TG_TOKEN)})
        self.reply(404, {"ok": False})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            body = {}
        if not HQ_KEY or (self.headers.get("X-HQ-Key") or body.get("key")) != HQ_KEY:
            return self.reply(401, {"ok": False, "error": "Wrong key"})
        try:
            p = self.path.split("?")[0]
            if p == "/api/chat":
                return self.reply(200, dict(ok=True, **chat(str(body.get("message", "")), body.get("history"))))
            if p == "/api/summary":
                return self.reply(200, dict(ok=True, **summary(body.get("slot", "auto"))))
            if p == "/api/reminders/due":
                return self.reply(200, dict(ok=True, **due_reminders()))
            if p == "/api/tools":
                return self.reply(200, {"ok": True, "tools": n8n_tools()})
            if p == "/api/todo":
                return self.reply(200, {"ok": True, "reply": new_task(body.get("title", ""), norm_date(body.get("dueDate")), norm_remind(body.get("remindAt")))})
            self.reply(404, {"ok": False, "error": "unknown"})
        except Exception as e:
            self.reply(500, {"ok": False, "error": str(e)})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=telegram_loop, daemon=True).start()
    print(f"Mayafx HQ AI on :{PORT}  ai={OLLAMAS}  sheet={'yes' if SHEET_URL else 'NO'}  n8n_key={'yes' if N8N_API_KEY else 'no'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
