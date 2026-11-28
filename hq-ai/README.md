# Mayafx HQ — 3 parts: AI · HQ · n8n

> The `shared/` folder (AI personality + studio knowledge) is private and not in this public repo. Copy it from your mayafx-hq-v3.zip into `hq-ai/shared/` before running the installers.

```
                ┌──────────── HQ app (GitHub Pages) ────────────┐
                │ 🤖 AI tab (summary + chat) · PM · Print Cost   │
                │ Quotes & Invoices · Prints · any app you add   │
                └───────────────┬───────────────────────────────┘
                                │ reads/writes through your Google Sheet (Apps Script)
   Telegram ◄──►  🤖 HQ AI  (desktop :8787)  ◄── laptop AI first, desktop AI backup
                                │
                                ▼
                    ⚙ n8n — briefs 9/2/8/11, to-do reminders, + any "HQ Tool" you add
```

- **HQ:** your existing app. Data flow stays the same, through the Sheet. It gets a new 🤖 AI home tab.
- **AI:** knows all HQ data: projects, to-dos, Print Cost jobs, invoices and payments, prints and apps. It can add to-dos and reminders, mark them done, and run n8n tools.
- **n8n:** sends briefs and reminders, and does any automation you add.

## Grow it (no coding)
| Want to… | Do this |
|---|---|
| Add an app | HQ → ⚙ Settings → Apps → + Add app. Fill in **"For the AI: what this app does"**. If the app has its own Apps Script, paste its `/exec` link in **data URL** and the AI reads its data too. |
| Add an n8n workflow the AI can use | In n8n, duplicate **HQ Tool · TEMPLATE**. Rename it "HQ Tool · …", write in the yellow note when to use it, tag it `hq` and turn it on. The AI picks it up within 2 minutes. Check with `/tools`. |
| Set a reminder | Any to-do with **Remind me at** (in PM, the AI chat or Telegram) is sent to Telegram on time. |

## Setup (once)
1. **HQ app.** Replace `hq/index.html` in your `Mayafx-PM` repo with `hq-update/index.html`, then commit. Keep your old file as a backup.
2. **Telegram.** Message @BotFather and send `/newbot`. Copy the token.
3. **Laptop.** Run `laptop-ai/install-laptop.bat` and note the IP it shows.
4. **Desktop.** Run `desktop/install-desktop.bat`. Fill in `.env`:
   - Sheet URL and KEY: the same ones as in HQ.
   - Laptop IP.
   - Telegram token.
   Then run it again.
5. **Your chat id.** Message your bot. It replies with your chat id. Put it in `.env` and run `desktop/restart.bat`.
6. **n8n.** Open http://localhost:5678.
   - Go to Settings → n8n API → create a key. Put it in `.env` as `N8N_API_KEY`, then run `restart.bat`.
   - Turn on the 3 workflows: Briefs, To-do Reminders and Send Telegram. Add the tag `hq` to **Send Telegram** if it's missing.
7. **Phone anywhere (Cloudflare Tunnel).** In Cloudflare Zero Trust, create a tunnel and route `hq-ai.yourdomain.com` to `http://hq-ai:8787`. Put the token in `.env` and run `restart.bat`.
8. **Connect HQ.** In HQ, go to ⚙ Settings → 🤖 HQ AI. Paste `https://hq-ai.yourdomain.com` and tap **Save & test**.

Check it's all working: http://localhost:8787/api/health

## Telegram / chat commands
```
/today                         everything due, late, to collect
/todo call Shankar tomorrow at 10am
/remind in 2h send invoice to bar
/done painting guitar          (loose words are fine)
/tools                         n8n workflows the AI can run
```
You can also just talk normally, for example "who owes me money?" or "remind me Monday 9am to order PLA".

## Good to know
- The commands work even when both AI machines are off. Only free chat needs the AI.
- Your Apps Script still emails hourly reminders and 9/2/8 summaries. To get only Telegram, set `DIGEST_HOURS = []` in Code.gs.
- Keep `.env` private. It has your keys.
- The HQ link must be https, which is why the tunnel is needed. A Cloudflare tunnel needs a domain (about ₹800/year). No domain? Ask me and I'll set it up with Tailscale instead (free).
