# Mayafx PM — setup (about 10 minutes)

The app works right away in "Local only" mode. Do these steps so your data is safe in Google Sheets, calculator jobs flow in, and reminders reach your phone.

## 1. Make the Sheet + script
1. On your main Gmail, create a new Google Sheet named **Mayafx PM**.
2. **Extensions → Apps Script**. Delete the sample code and paste all of `Code.gs`.
3. At the top of Code.gs set `KEY` — any password (you'll type it in the app). `NTFY_TOPIC` is optional (step 4).
4. **Project Settings (gear icon)** → set Time zone to **(GMT+05:30) India Standard Time**.
5. Save, choose **setupTriggers** in the function dropdown and press **Run**. Allow the permissions, including Google Calendar (Advanced → Go to project). You'll get a "Mayafx PM is set up" email.

## 2. Deploy
**Deploy → New deployment → Web app** · Execute as **Me** · Who has access **Anyone** → Deploy → copy the URL ending in `/exec`.

## 3. Connect the app
Open the app → **Settings** → paste the URL + your KEY → **Save & sync**. Then tap **Test reminder**.

## 4. Phone push notifications (optional, free)
Email already works. For instant pop-up alerts:
1. Install **ntfy** from the Play Store.
2. Subscribe to a hard-to-guess topic, e.g. `mayafx-sai-8392`.
3. Put the same name in `NTFY_TOPIC`, then **Deploy → Manage deployments → Edit → New version**.

## How it works
- **Projects** for every branch: 3D Printing, CGI/VFX, Interactive, Game Dev, YouTube, Business, Other.
- **Calculator link is automatic** when the calculator is used in the same browser (both apps are on mayafxstudio-a11y.github.io). Otherwise paste the calculator URL + key in Settings → Print Cost calculator.
- **Google Calendar**: tasks with a reminder become a 30-min event with a pop-up; tasks with only a due date become all-day events; project deadlines show as 🎯 all-day events. Done or deleted tasks are removed from the calendar.
- **Calculator jobs appear automatically** as 3D Printing projects. Unfinished jobs become "Print —" tasks; done-but-unpaid jobs become "Collect ₹…" tasks. Update status/payment in the calculator; the app follows. You can add your own tasks to a calculator job (e.g. "Paint and pack").
- **Reminders**: set "Remind me at" on any task → email/push within the hour. Summary at 9 AM, 2 PM and 8 PM (change `DIGEST_HOURS`).
- Updating an older Code.gs: paste the new one, run **setupTriggers** again (for Calendar permission), then
- After editing Code.gs later, always **Manage deployments → Edit → New version** so the URL stays the same.
