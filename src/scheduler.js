require("dotenv").config();
const cron = require("node-cron");
const { sendWithTemplateFallback } = require("./sendMessage");
const supabase = require("./supabase");
const { ensureRowExists } = require("./usage");

function getLocalTimeComponents() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: "America/Argentina/Cordoba",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const [{ value: day }, , { value: month }] = formatter.formatToParts(now);

  const dowFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Cordoba",
    weekday: "short",
  });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dowStr = dowFormatter.format(now).slice(0, 3);

  return {
    day: parseInt(day),
    month: parseInt(month),
    dayOfWeek: dowMap[dowStr],
    todayLocal: new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Cordoba",
    }).format(now),
    timeStr: new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Argentina/Cordoba",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
  };
}

// Guard flags — prevent overlapping executions
let reminderRunning = false;
let routineRunning = false;
let recurringRunning = false;
let eventAlertRunning = false;
let dailySummaryRunning = false;

// Heartbeat tracking (in-memory fallback for dashboard)
const lastHeartbeats = {
  "Reminder Dispatch": null,
  "Routine Dispatch": null,
  "Recurring Task Dispatch": null,
  "Event Alert": null,
  "Daily Summary": null,
};

async function recordHeartbeat(jobName) {
  const now = new Date().toISOString();
  lastHeartbeats[jobName] = now;
  try {
    await ensureRowExists();
    await supabase
      .from("system_jobs")
      .upsert({ job_name: jobName, last_fired: now, status: "active" }, { onConflict: "job_name" });
  } catch (_) {
    // in-memory fallback already set
  }
}

// -----------------------------------------------------------------------
// Exported dispatch functions — called by both cron AND /api/tick
// -----------------------------------------------------------------------

async function runReminderDispatch() {
  if (reminderRunning) return;
  reminderRunning = true;

  try {
    const now = new Date().toISOString();

    const { data: dueReminders } = await supabase
      .from("personal_reminders")
      .select("*")
      .lte("reminder_time", now)
      .eq("status", "pending");

    for (const reminder of dueReminders || []) {
      // Atomic claim — skips row if already taken by a concurrent dispatcher
      const { data: claimed } = await supabase
        .from("personal_reminders")
        .update({ status: "completed" })
        .eq("id", reminder.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWithTemplateFallback(reminder.phone, reminder.message);
      } catch (_) {
        // Revert so it retries next cycle
        await supabase.from("personal_reminders").update({ status: "pending" }).eq("id", reminder.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    reminderRunning = false;
    await recordHeartbeat("Reminder Dispatch");
  }
}

async function runRoutineDispatch() {
  if (routineRunning) return;
  routineRunning = true;

  try {
    const { timeStr, todayLocal } = getLocalTimeComponents();

    const { data: routines } = await supabase
      .from("daily_routines")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`);

    for (const routine of routines || []) {
      if (timeStr < routine.reminder_time.slice(0, 5)) continue;

      const { data: claimed } = await supabase
        .from("daily_routines")
        .update({ last_fired_date: todayLocal })
        .eq("id", routine.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWithTemplateFallback(routine.phone, routine.task_name);
      } catch (_) {
        await supabase.from("daily_routines").update({ last_fired_date: null }).eq("id", routine.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    routineRunning = false;
    await recordHeartbeat("Routine Dispatch");
  }
}

async function runRecurringDispatch() {
  if (recurringRunning) return;
  recurringRunning = true;

  try {
    const { day, dayOfWeek, timeStr, todayLocal } = getLocalTimeComponents();

    const { data: tasks } = await supabase
      .from("recurring_tasks")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`);

    for (const task of tasks || []) {
      if (timeStr < task.reminder_time.slice(0, 5)) continue;

      let shouldFire = false;
      if (task.recurrence_type === "weekly") {
        shouldFire = task.day_of_week === dayOfWeek;
      } else if (task.recurrence_type === "monthly") {
        const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Cordoba" }));
        const tomorrowLocal = new Date(nowLocal);
        tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
        const isLastDayOfMonth = tomorrowLocal.getDate() === 1;
        shouldFire = (isLastDayOfMonth && task.day_of_month > day) || task.day_of_month === day;
      }

      if (!shouldFire) continue;

      const { data: claimed } = await supabase
        .from("recurring_tasks")
        .update({ last_fired_date: todayLocal })
        .eq("id", task.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWithTemplateFallback(task.phone, task.task_name);
      } catch (_) {
        await supabase.from("recurring_tasks").update({ last_fired_date: null }).eq("id", task.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    recurringRunning = false;
    await recordHeartbeat("Recurring Task Dispatch");
  }
}

// -----------------------------------------------------------------------
// Daily summary — proactive morning digest, no message from the owner
// required. Uses the template fallback since the 24h window may well be
// closed if the owner hasn't messaged Kael recently.
// -----------------------------------------------------------------------
async function runDailySummary() {
  if (dailySummaryRunning) return;
  dailySummaryRunning = true;

  try {
    const { day, month, dayOfWeek, todayLocal, timeStr } = getLocalTimeComponents();
    const ownerPhone = process.env.MY_PHONE_NUMBER;
    if (!ownerPhone) return;

    // Gate 1: only send from 07:00 local onward — safe to call this function
    // from /api/tick every minute without spamming the summary at 3 AM.
    if (timeStr < "07:00") return;

    // Gate 2: don't send twice in the same day (tick fires this every minute).
    const { data: jobRow } = await supabase
      .from("system_jobs")
      .select("last_fired")
      .eq("job_name", "Daily Summary")
      .maybeSingle();
    if (jobRow?.last_fired) {
      const lastFiredLocal = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Argentina/Cordoba",
      }).format(new Date(jobRow.last_fired));
      if (lastFiredLocal === todayLocal) return;
    }

    const startOfDay = `${todayLocal}T00:00:00-03:00`;
    const endOfDay = `${todayLocal}T23:59:59-03:00`;

    const [
      { data: reminders },
      { data: routines },
      { data: recurring },
      { data: events },
      { data: pendingLists },
    ] = await Promise.all([
      supabase.from("personal_reminders").select("*").eq("phone", ownerPhone).eq("status", "pending")
        .gte("reminder_time", startOfDay).lte("reminder_time", endOfDay),
      supabase.from("daily_routines").select("*").eq("phone", ownerPhone).eq("is_active", true),
      supabase.from("recurring_tasks").select("*").eq("phone", ownerPhone).eq("is_active", true),
      supabase.from("special_events").select("*"),
      supabase.from("lists").select("list_name").eq("phone", ownerPhone).eq("is_done", false),
    ]);

    let text = "Good morning, Braian. Here's your day:\n\n";
    let hasContent = false;

    if (reminders?.length) {
      hasContent = true;
      text += "Reminders today:\n";
      reminders
        .slice()
        .sort((a, b) => new Date(a.reminder_time) - new Date(b.reminder_time))
        .forEach((r) => {
          const t = new Date(r.reminder_time).toLocaleTimeString("en-US", {
            timeZone: "America/Argentina/Cordoba", hour: "numeric", minute: "2-digit", hour12: true,
          });
          text += `- ${t}: ${r.message}\n`;
        });
      text += "\n";
    }

    if (routines?.length) {
      hasContent = true;
      text += "Daily routines:\n";
      routines.forEach((r) => (text += `- ${r.reminder_time.slice(0, 5)}: ${r.task_name}\n`));
      text += "\n";
    }

    const todaysRecurring = (recurring || []).filter((t) =>
      t.recurrence_type === "weekly" ? t.day_of_week === dayOfWeek : t.day_of_month === day
    );
    if (todaysRecurring.length) {
      hasContent = true;
      text += "Recurring tasks today:\n";
      todaysRecurring.forEach((t) => (text += `- ${t.reminder_time.slice(0, 5)}: ${t.task_name}\n`));
      text += "\n";
    }

    const todaysEvents = (events || []).filter((e) => {
      const d = new Date(e.event_date);
      return d.getDate() === day && d.getMonth() + 1 === month;
    });
    if (todaysEvents.length) {
      hasContent = true;
      text += "Today:\n";
      todaysEvents.forEach((e) => (text += `- ${e.person_name}'s ${e.event_type}\n`));
      text += "\n";
    }

    if (pendingLists?.length) {
      hasContent = true;
      const counts = {};
      pendingLists.forEach((row) => { counts[row.list_name] = (counts[row.list_name] || 0) + 1; });
      text += "Pending lists:\n";
      Object.entries(counts).forEach(([name, count]) => (text += `- ${name}: ${count} item(s)\n`));
    }

    if (!hasContent) {
      text += "Nothing scheduled — clear day.";
    }

    await sendWithTemplateFallback(ownerPhone, text.trim());
  } catch (_) {
    // silent — retried automatically tomorrow
  } finally {
    dailySummaryRunning = false;
    await recordHeartbeat("Daily Summary");
  }
}

// -----------------------------------------------------------------------
// Cron jobs — fire every minute.
// /api/tick calls the same functions when the process wakes from sleep.
// -----------------------------------------------------------------------

cron.schedule("* * * * *", runReminderDispatch);
cron.schedule("* * * * *", runRoutineDispatch);
cron.schedule("* * * * *", runRecurringDispatch);

// Special event alerts — 08:30 local time, Argentina (UTC-3) = 11:30 UTC. Cron-only to avoid duplicates.
cron.schedule("30 11 * * *", async () => {
  if (eventAlertRunning) return;
  eventAlertRunning = true;
  try {
    const { day: todayDay, month: todayMonth } = getLocalTimeComponents();

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDay = tomorrowDate.getDate();
    const tomorrowMonth = tomorrowDate.getMonth() + 1;

    const { data: events } = await supabase.from("special_events").select("*");
    if (!events) return;

    for (const event of events) {
      const eDate = new Date(event.event_date);
      const eDay = eDate.getDate();
      const eMonth = eDate.getMonth() + 1;

      if (eDay === todayDay && eMonth === todayMonth) {
        await sendWithTemplateFallback(event.phone, `${event.person_name}'s ${event.event_type} is today.`);
      } else if (eDay === tomorrowDay && eMonth === tomorrowMonth) {
        await sendWithTemplateFallback(event.phone, `${event.person_name}'s ${event.event_type} is tomorrow.`);
      }
    }
  } catch (_) {
    // silent
  } finally {
    eventAlertRunning = false;
    await recordHeartbeat("Event Alert");
  }
});

// Daily summary — 07:00 local time, Argentina (UTC-3) = 10:00 UTC.
// Fires before the 08:30-local birthday alert so the summary reads as the
// first proactive message of the day.
cron.schedule("0 10 * * *", runDailySummary);

module.exports = {
  getHeartbeats: () => lastHeartbeats,
  runReminderDispatch,
  runRoutineDispatch,
  runRecurringDispatch,
  runDailySummary,
};
