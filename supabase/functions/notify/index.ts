// Circle's notifications (Supabase Edge Function).
//
// Called every 5 minutes by a database schedule (pg_cron), with X-Cron-Secret. For
// each person using Circle it:
//   1. reads their calendar (Google's private iCal link) at most every 10 minutes and
//      keeps the upcoming meetings that include someone in Circle (circle_agenda);
//   2. sends the morning brief once a day at their chosen time;
//   3. after a small meeting with someone in Circle ends, asks "How did it go?",
//      except during quiet hours.
// Notifications go to every device that turned them on (circle_push_subscriptions)
// as Web Push messages, which the app's service worker shows.
//
// The app also calls it, signed in, with { action }: "test" (send a test
// notification), "save_calendar" / "remove_calendar" (the link is stored where only
// this function can read it), and "refresh" (re-read the calendar now).

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import webpush from "npm:web-push@3.6.7";
import ICAL from "npm:ical.js@2.2.1";
import { Circle, type Doc, HARD, REL_LABEL } from "../_shared/circle.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const APP_URL = "https://michaelmcneil-lab.github.io/circle/";
const CALENDAR_EVERY_MIN = 10;
const PROMPT_WITHIN_MIN = 60; // ask about meetings that ended in the last hour, never older ones
const BRIEF_LATEST = "12:00"; // a brief that couldn't go out by noon is skipped for the day

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(APP_URL, VAPID_PUBLIC, VAPID_PRIVATE);

type Settings = {
  user_id: string; time_zone: string; brief_time: string; brief_weekends: boolean; quiet_start: string; quiet_end: string;
  prompt_max_people: number; last_brief_date: string | null; calendar_checked_at: string | null;
};
type Payload = { title: string; body: string; url: string; tag: string };

// ---------- Time in the user's time zone ----------
function local(tz: string, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}`, weekday: parts.weekday };
}
const clock = (tz: string, at: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
const isQuiet = (hm: string, start: string, end: string) => start > end ? hm >= start || hm < end : hm >= start && hm < end;

// ---------- Push ----------
async function push(userId: string, payload: Payload) {
  const { data: subs } = await admin.from("circle_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // The device turned notifications off or the app was removed: forget it.
      if (status === 404 || status === 410) await admin.from("circle_push_subscriptions").delete().eq("id", s.id);
      else console.error("push failed", status, err);
    }
  }
  return sent;
}

// ---------- Calendar ----------
// An event from a calendar. personIds lists who in Circle it involves (often nobody).
// All-day events carry their date; their start and end are set to noon UTC on that day,
// which keeps them on the right date in every time zone.
type Meeting = { key: string; start: Date; end: Date; title: string; personIds: string[]; attendees: number; allDay: boolean; date: string };
const DAYS_AHEAD = 31;
const DAYS_BACK = 7; // past events kept for the app's Recent events (to log or correct who was there)

// Turns a calendar feed into meetings between `from` and `to` that include someone in Circle.
// A calendar feed can hold many years of events (iCloud family calendars often do),
// and reading all of them in detail takes longer than a server function is allowed.
// This keeps only what can matter: events that start or end within a day of the
// window, repeating events that haven't ended, and the time zone definitions.
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
function trimFeed(ics: string, from: Date, to: Date): string {
  const lo = ymd(new Date(+from - 864e5)), hi = ymd(new Date(+to + 864e5));
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const first = unfolded.indexOf("BEGIN:VEVENT");
  if (first < 0) return unfolded;
  const out = [unfolded.slice(0, first)];
  const re = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
  for (const m of unfolded.matchAll(re)) {
    const ev = m[0];
    const date = (prop: string) => ev.match(new RegExp(`(?:^|\\n)${prop}[^:\\n]*:(\\d{8})`))?.[1];
    if (/(?:^|\n)RRULE:/.test(ev)) {
      const until = ev.match(/(?:^|\n)RRULE:[^\n]*UNTIL=(\d{8})/)?.[1];
      if (!until || until >= lo) out.push(ev); // still repeating
      continue;
    }
    const start = date("RECURRENCE-ID") && !date("DTSTART") ? date("RECURRENCE-ID") : date("DTSTART");
    const end = date("DTEND") ?? start;
    const moved = date("RECURRENCE-ID");
    // A moved occurrence matters if either its new or its original date is near the window.
    if ((start && start <= hi && (end ?? start) >= lo) || (moved && moved >= lo && moved <= hi)) out.push(ev);
  }
  out.push("END:VCALENDAR");
  return out.join("\r\n");
}

// For a long-running daily or weekly series, start expanding a little before the
// window instead of at its first occurrence years ago. Moving the start by whole
// periods keeps every occurrence where it was. Series limited by COUNT are left as
// they are, since skipping would change which occurrences they include.
function nearStart(e: InstanceType<typeof ICAL.Event>, from: InstanceType<typeof ICAL.Time>) {
  const rule = e.component.getFirstPropertyValue("rrule") as InstanceType<typeof ICAL.Recur> | null;
  if (!rule || rule.count) return undefined;
  const period = rule.freq === "DAILY" ? (rule.interval || 1) : rule.freq === "WEEKLY" ? 7 * (rule.interval || 1) : 0;
  if (!period) return undefined;
  const behind = Math.floor((from.toUnixTime() - e.startDate.toUnixTime()) / 86400) - 14;
  if (behind <= period) return undefined;
  const start = e.startDate.clone();
  start.adjust(Math.floor(behind / period) * period, 0, 0, 0);
  return start;
}

// Every event between `from` and `to`, with who in Circle each one involves.
function meetingsFrom(ics: string, doc: Doc, selfEmail: string, from: Date, to: Date): Meeting[] {
  const root = new ICAL.Component(ICAL.parse(trimFeed(ics, from, to)));
  for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
  const events = root.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
  // Moved or edited single occurrences of a repeating meeting belong to their series.
  const masters = new Map<string, InstanceType<typeof ICAL.Event>>();
  for (const e of events) if (!e.isRecurrenceException()) masters.set(e.uid, e);
  for (const e of events) if (e.isRecurrenceException()) masters.get(e.uid)?.relateException(e);

  // People who have passed aren't matched to events by name (no "How did it go?" about them);
  // the user can still put them on an event with Who?.
  const people = (doc.people ?? []).filter((p) => !p.inMemory);
  const byEmail = new Map<string, string>();
  for (const p of people) for (const em of p.emails ?? []) byEmail.set(String(em.value).toLowerCase(), p.id);
  const firstNames = new Map<string, number>();
  for (const p of people) { const f = String(p.firstName || "").toLowerCase(); if (f) firstNames.set(f, (firstNames.get(f) ?? 0) + 1); }
  const word = (s: string) => new RegExp(`(^|[^\\p{L}])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu");
  // Each person's names are prepared once, not once per event: with hundreds of people
  // and a month of events, building them per event used up the function's computing time.
  // A plain substring check rules most people out before the slower whole-word check.
  const matchers = people.map((p) => {
    const names = [p.name, p.nickname].filter((n) => n && String(n).length >= 3).map(String);
    const first = String(p.firstName || "");
    // A first name alone only counts when nobody else in Circle shares it.
    if (first.length >= 3 && firstNames.get(first.toLowerCase()) === 1) names.push(first);
    return { id: p.id, names: names.map((n) => ({ lower: n.toLowerCase(), re: word(n) })) };
  });
  const self = selfEmail.toLowerCase();
  // Who an event is with, as the user corrected it in Circle: for one occurrence (keyed by
  // the meeting's key) or a whole repeating series (keyed by the event's UID). These win
  // over matching by name; an empty list means "nobody in Circle".
  const known = new Set((doc.people ?? []).map((p) => p.id));
  const chosen = new Map<string, string[]>((doc.eventLinks ?? []).map((l: { id: string; personIds: string[] }) =>
    [String(l.id), (l.personIds ?? []).filter((id) => known.has(id))]));

  const out: Meeting[] = [];
  const add = (e: InstanceType<typeof ICAL.Event>, start: InstanceType<typeof ICAL.Time>, end: InstanceType<typeof ICAL.Time>) => {
    const vevent = e.component;
    if (String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    const attendees = vevent.getAllProperties("attendee").map((a) => ({
      email: String(a.getFirstValue() ?? "").replace(/^mailto:/i, "").toLowerCase(),
      name: String(a.getParameter("cn") ?? ""),
      status: String(a.getParameter("partstat") ?? "").toUpperCase(),
    }));
    if (attendees.some((a) => a.email === self && a.status === "DECLINED")) return;
    const ids = new Set<string>();
    for (const a of attendees) if (a.email !== self && byEmail.has(a.email)) ids.add(byEmail.get(a.email)!);
    const text = [e.summary ?? "", ...attendees.map((a) => a.name)].join(" | ");
    const lower = text.toLowerCase();
    for (const m of matchers) {
      if (ids.has(m.id)) continue;
      if (m.names.some((n) => lower.includes(n.lower) && n.re.test(text))) ids.add(m.id);
    }
    const noon = (t: InstanceType<typeof ICAL.Time>) => new Date(Date.UTC(t.year, t.month - 1, t.day, 12));
    const allDay = start.isDate;
    const startJs = allDay ? noon(start) : start.toJSDate(), endJs = allDay ? noon(end) : end.toJSDate();
    if (isNaN(+startJs) || isNaN(+endJs)) return; // a date the feed doesn't spell out properly
    const date = allDay ? startJs.toISOString().slice(0, 10) : "";
    const key = `${e.uid}|${allDay ? date : startJs.toISOString()}`;
    const picked = chosen.get(key) ?? chosen.get(String(e.uid));
    if (picked) { ids.clear(); picked.forEach((id) => ids.add(id)); }
    out.push({
      key, start: startJs, end: endJs, title: e.summary || "(no title)", personIds: [...ids],
      attendees: Math.max(attendees.filter((a) => a.status !== "DECLINED").length, ids.size + 1), allDay, date,
    });
  };

  const fromT = ICAL.Time.fromJSDate(from, true), toT = ICAL.Time.fromJSDate(to, true);
  for (const e of masters.values()) {
    if (!e.isRecurring()) {
      if (e.endDate.compare(fromT) >= 0 && e.startDate.compare(toT) <= 0) add(e, e.startDate, e.endDate);
      continue;
    }
    const it = e.iterator(nearStart(e, fromT));
    for (let n = 0, t = it.next(); t && n < 5000; t = it.next(), n++) {
      if (t.compare(toT) > 0) break;
      const d = e.getOccurrenceDetails(t);
      if (d.endDate.compare(fromT) >= 0) add(d.item, d.startDate, d.endDate);
    }
  }
  return out;
}

async function fetchCalendar(url: string) {
  // Like a calendar app: say who's asking and accept any format (some servers refuse otherwise).
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "follow",
    headers: { Accept: "text/calendar, */*;q=0.8", "User-Agent": "Circle/1.0 (calendar reader; +https://michaelmcneil-lab.github.io/circle/)" } });
  if (!res.ok) throw new Error(res.status === 404 ? "Google says this link no longer works. It may have been reset." : `the calendar couldn't be read (HTTP ${res.status})`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("that link isn't a calendar feed. Use the 'Secret address in iCal format'.");
  return text;
}

async function loadDoc(userId: string): Promise<Doc> {
  const { data } = await admin.from("circle_data").select("data").eq("user_id", userId).maybeSingle();
  return { people: [], interactions: [], followUps: [], relations: [], ...(data?.data ?? {}) };
}
async function userEmail(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  return data?.user?.email ?? "";
}

type Link = { id: string; label: string; url: string };

async function linksFor(userId: string): Promise<Link[]> {
  const { data, error } = await admin.from("circle_calendar_links").select("id, label, url").eq("user_id", userId).order("updated_at");
  if (error) throw new Error(`calendar list unavailable: ${error.message}`);
  return data ?? [];
}

// Re-reads every connected calendar and records events from a week ago (DAYS_BACK) to a
// month ahead (DAYS_AHEAD). A calendar that fails doesn't stop the others; its error is kept on its link.
async function refreshAgenda(userId: string, doc: Doc) {
  const links = await linksFor(userId);
  if (!links.length) return null;
  const now = Date.now(), from = new Date(now - DAYS_BACK * 864e5), to = new Date(now + DAYS_AHEAD * 864e5);
  const self = await userEmail(userId);
  const byKey = new Map<string, Meeting & { calendar: string }>();
  const seen = new Set<string>(); // title + start, to spot the same event in two calendars
  const failed: string[] = [];
  for (const link of links) {
    try {
      for (const m of meetingsFrom(await fetchCalendar(link.url), doc, self, from, to)) {
        // The same event in two calendars (a shared family calendar) counts once.
        const twin = `${m.title}|${+m.start}`;
        if (!byKey.has(m.key) && !seen.has(twin)) { byKey.set(m.key, { ...m, calendar: link.label }); seen.add(twin); }
      }
      await admin.from("circle_calendar_links").update({ last_error: null, checked_at: new Date().toISOString() }).eq("id", link.id);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      failed.push(`${link.label}: ${msg}`);
      await admin.from("circle_calendar_links").update({ last_error: msg, checked_at: new Date().toISOString() }).eq("id", link.id);
    }
  }
  const meetings = [...byKey.values()];
  const { data: existing } = await admin.from("circle_agenda").select("event_key, prompted").eq("user_id", userId);
  const prompted = new Map((existing ?? []).map((r) => [r.event_key, r.prompted]));
  if (meetings.length) {
    const { error } = await admin.from("circle_agenda").upsert(meetings.map((m) => ({
      user_id: userId, event_key: m.key, start_at: m.start.toISOString(), end_at: m.end.toISOString(), title: m.title, calendar_label: m.calendar, all_day: m.allDay, start_date: m.date || null,
      person_ids: m.personIds, attendee_count: m.attendees, prompted: prompted.get(m.key) ?? false, updated_at: new Date().toISOString(),
    })), { onConflict: "user_id,event_key" });
    if (error) console.error("agenda not saved", error);
  }
  // Drop meetings that were cancelled or are now in the past, but only when every
  // calendar was read: otherwise a failed one would look like its meetings were cancelled.
  if (!failed.length) {
    const keep = new Set(meetings.map((m) => m.key));
    const gone = [...prompted.keys()].filter((k) => !keep.has(k));
    if (gone.length) await admin.from("circle_agenda").delete().eq("user_id", userId).in("event_key", gone);
  }
  await admin.from("circle_settings").update({ calendar_checked_at: new Date().toISOString(),
    calendar_error: failed.length ? failed.join(" · ").slice(0, 300) : null }).eq("user_id", userId);
  return meetings;
}

// ---------- The morning brief ----------
// Tomorrow's days of remembrance for people who have passed (the anniversary of their passing,
// their birthday), with family to reach out to. A day ahead, so there's time to honour them.
function remembranceTomorrow(c: Circle): string[] {
  return c.doc.people.flatMap((p) => c.remembrance(p, 1).filter((r) => r.days === 1).map((r) => {
    const fam = c.family(p);
    return `🕊️ Tomorrow: ${r.line}${fam.length ? `. Reach out to ${fam.slice(0, 3).join(", ")}` : ""}`;
  }));
}
function brief(c: Circle, tz: string, meetings: { start_at: string; person_ids: string[] }[]): Payload | null {
  const name = (id: string) => c.person(id)?.firstName || c.person(id)?.name || "someone";
  const hardFor = (id: string) => (c.person(id)?.events ?? []).filter((e: { type: string }) => HARD.has(e.type) && c.eventState(e) === "prominent")[0];
  const remember = remembranceTomorrow(c);
  const parts: string[] = [...remember];
  const seen = new Set<string>();
  for (const m of meetings.slice(0, 3)) {
    const who = m.person_ids.map((id: string) => { seen.add(id); const h = hardFor(id); return h ? `${name(id)} (${h.title.toLowerCase()})` : name(id); });
    parts.push(`${clock(tz, new Date(m.start_at))} ${who.join(" & ")}`);
  }
  if (meetings.length > 3) parts.push(`+${meetings.length - 3} more meetings`);
  const due = c.openFollowUps().filter((f) => f.due && c.since(f.due) >= 0);
  if (due.length === 1) parts.push(`Follow up: ${due[0].text} (${c.names(due[0].personIds)})`);
  else if (due.length) parts.push(`${due.length} follow-ups due`);
  const hard = c.doc.people.filter((p) => !seen.has(p.id) && hardFor(p.id)).map((p) => name(p.id));
  if (hard.length) parts.push(`Thinking of ${hard.slice(0, 3).join(", ")}`);
  const dates: string[] = [];
  for (const p of c.doc.people) {
    // Birthdays of people who have passed are among the remembrances above.
    if (p.birthday && !p.inMemory) { const n = c.next(p.birthday); if (n.days <= 1) dates.push(`${name(p.id)}'s birthday ${n.days ? "tomorrow" : "today"}`); }
    for (const m of p.familyMembers ?? []) if (m.birthday) {
      const n = c.next(m.birthday);
      if (n.days <= 1) dates.push(`${m.name}'s birthday ${n.days ? "tomorrow" : "today"} (${name(p.id)}'s ${REL_LABEL[m.rel] || m.rel})`);
    }
    for (const e of p.events ?? []) if (e.recurring || e.type === "loss") {
      const n = c.next(e.date);
      if (n.years && n.days <= 1 && (e.recurring || n.years === 1)) dates.push(`${e.type === "loss" ? "1 year since" : `${n.years} years:`} ${name(p.id)}'s ${e.title.toLowerCase()} ${n.days ? "tomorrow" : "today"}`);
    }
  }
  parts.push(...dates.slice(0, 2));
  if (!parts.length) return null;
  return { title: meetings.length ? `Today: ${meetings.length} meeting${meetings.length > 1 ? "s" : ""} with your people` : remember.length ? "Remembering tomorrow" : "Today in Circle",
    body: parts.join(" · ").slice(0, 240), url: `${APP_URL}?view=today`, tag: `brief-${c.today}` };
}

// ---------- One person's run ----------
async function runUser(s: Settings, force = false) {
  const tz = s.time_zone || "America/Los_Angeles";
  const now = local(tz);
  const doc = await loadDoc(s.user_id);
  const result: Record<string, unknown> = {};

  const stale = !s.calendar_checked_at || Date.now() - new Date(s.calendar_checked_at).getTime() >= CALENDAR_EVERY_MIN * 60000;
  if (stale || force) {
    try { const m = await refreshAgenda(s.user_id, doc); if (m) result.meetings = m.length; }
    catch (err) { result.calendarError = err instanceof Error ? err.message : String(err); }
  }

  const weekday = !["Sat", "Sun"].includes(now.weekday);
  // A remembrance tomorrow brings the brief on any day, weekends included.
  const remembering = remembranceTomorrow(new Circle(doc, tz)).length > 0;
  if (s.last_brief_date !== now.date && now.hm >= s.brief_time && now.hm < BRIEF_LATEST && (weekday || s.brief_weekends || remembering)) {
    const c = new Circle(doc, tz);
    const dayStart = new Date(Date.now() - 864e5).toISOString(), dayEnd = new Date(Date.now() + 864e5).toISOString();
    const { data: rows } = await admin.from("circle_agenda").select("start_at, person_ids, all_day").eq("user_id", s.user_id)
      .gte("start_at", dayStart).lte("start_at", dayEnd).order("start_at");
    const today = (rows ?? []).filter((r) => r.person_ids?.length && !r.all_day
      && local(tz, new Date(r.start_at)).date === now.date && new Date(r.start_at).getTime() > Date.now() - 3600e3);
    const payload = brief(c, tz, today);
    if (payload) result.brief = await push(s.user_id, payload);
    await admin.from("circle_settings").update({ last_brief_date: now.date }).eq("user_id", s.user_id);
  }

  if (s.prompt_max_people > 0) {
    const since = new Date(Date.now() - PROMPT_WITHIN_MIN * 60000).toISOString();
    const { data: ended } = await admin.from("circle_agenda").select("event_key, title, person_ids, attendee_count").eq("all_day", false)
      .eq("user_id", s.user_id).eq("prompted", false).lte("end_at", new Date().toISOString()).gte("end_at", since);
    const quiet = isQuiet(now.hm, s.quiet_start, s.quiet_end);
    for (const m of ended ?? []) {
      if (m.person_ids?.length && m.attendee_count <= s.prompt_max_people && !quiet) {
        const names = m.person_ids.map((id: string) => doc.people.find((p) => p.id === id)?.firstName || "them").join(" & ");
        await push(s.user_id, {
          title: `How did it go with ${names}?`, body: `${m.title} just ended. Tap to add a note.`,
          url: `${APP_URL}?note=${encodeURIComponent(`Met with ${names}: `)}`, tag: `prompt-${m.event_key}`,
        });
        result.prompts = (result.prompts as number ?? 0) + 1;
      }
      // Quiet hours or a big meeting: mark it anyway, so it isn't asked about later.
      await admin.from("circle_agenda").update({ prompted: true }).eq("user_id", s.user_id).eq("event_key", m.event_key);
    }
  }
  return result;
}

async function settingsFor(userId: string): Promise<Settings> {
  const { data } = await admin.from("circle_settings").select("*").eq("user_id", userId).maybeSingle();
  if (data) return data;
  const { data: created } = await admin.from("circle_settings").insert({ user_id: userId }).select("*").single();
  return created;
}

// Any unexpected failure still answers with JSON, so the app can show what went wrong.
Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("notify failed", err);
    return json({ error: `Something went wrong on Circle's server: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // The schedule: everyone who has settings.
  if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) {
    const { data: all } = await admin.from("circle_settings").select("*");
    const results = [];
    for (const s of all ?? []) {
      try { results.push({ user: s.user_id.slice(0, 8), ...(await runUser(s)) }); }
      catch (err) { console.error("run failed", s.user_id, err); }
    }
    // The same schedule keeps Google Contacts in sync (a separate function, with its own time limits).
    const google = await fetch(`${SUPABASE_URL}/functions/v1/google-contacts`, { method: "POST", headers: { "x-cron-secret": CRON_SECRET } })
      .then((r) => r.status).catch((err) => { console.error("google sync not reached", err); return 0; });
    return json({ ok: true, results, google });
  }

  // The app, signed in.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const asUser = createClient(SUPABASE_URL, req.headers.get("apikey") ?? ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user } } = await asUser.auth.getUser(token);
  if (!user) return json({ error: "Not signed in" }, 401);
  let body;
  try { body = await req.json(); } catch { body = {}; }

  if (body.action === "test") {
    const sent = await push(user.id, { title: "Circle notifications are on", body: "You'll get your morning brief and after-meeting prompts here.", url: APP_URL, tag: "test" });
    return json({ sent });
  }
  if (body.action === "list_calendars") {
    const { data } = await admin.from("circle_calendar_links").select("id, label, last_error, checked_at").eq("user_id", user.id).order("updated_at");
    return json({ calendars: data ?? [] });
  }
  if (body.action === "save_calendar") {
    const url = String(body.url ?? "").trim().replace(/^webcal:/i, "https:");
    const label = String(body.label ?? "").trim().slice(0, 40);
    if (!/^https:\/\/\S+$/i.test(url)) return json({ error: "Paste the calendar's secret address. It starts with https://" }, 400);
    await settingsFor(user.id);
    const doc = await loadDoc(user.id);
    // Check the link on its own first, so a bad one is never saved.
    let found: Meeting[];
    try {
      const now = Date.now();
      found = meetingsFrom(await fetchCalendar(url), doc, await userEmail(user.id), new Date(now - 864e5), new Date(now + DAYS_AHEAD * 864e5));
    } catch (err) {
      return json({ error: `Couldn't read that calendar: ${err instanceof Error ? err.message : err}` }, 400);
    }
    const links = await linksFor(user.id);
    const existing = links.find((l) => l.url === url);
    const name = label || existing?.label || `Calendar ${links.length + 1}`;
    const { error } = existing
      ? await admin.from("circle_calendar_links").update({ label: name, last_error: null }).eq("id", existing.id)
      : await admin.from("circle_calendar_links").insert({ user_id: user.id, url, label: name });
    if (error) return json({ error: `Couldn't save the calendar: ${error.message}` }, 500);
    await refreshAgenda(user.id, doc);
    return json({ ok: true, label: name, events: found.length, meetings: found.filter((m) => m.personIds.length && +m.start < Date.now() + 2 * 864e5).length });
  }
  if (body.action === "rename_calendar") {
    const label = String(body.label ?? "").trim().slice(0, 40);
    if (!label) return json({ error: "Give the calendar a name" }, 400);
    const { data: link } = await admin.from("circle_calendar_links").select("label").eq("id", body.id).eq("user_id", user.id).maybeSingle();
    if (!link) return json({ error: "Calendar not found" }, 404);
    const { error } = await admin.from("circle_calendar_links").update({ label }).eq("id", body.id).eq("user_id", user.id);
    if (error) return json({ error: error.message }, 500);
    await admin.from("circle_agenda").update({ calendar_label: label }).eq("user_id", user.id).eq("calendar_label", link.label);
    return json({ ok: true });
  }
  if (body.action === "remove_calendar") {
    await admin.from("circle_calendar_links").delete().eq("id", body.id).eq("user_id", user.id);
    if ((await linksFor(user.id)).length) {
      // Re-read the others; meetings only the removed calendar had disappear.
      await refreshAgenda(user.id, await loadDoc(user.id));
    } else {
      await admin.from("circle_agenda").delete().eq("user_id", user.id);
      await admin.from("circle_settings").update({ calendar_checked_at: null, calendar_error: null }).eq("user_id", user.id);
    }
    return json({ ok: true });
  }
  if (body.action === "check_calendar") {
    // What Circle can see in the calendars for the next two days, with or without people.
    const s = await settingsFor(user.id);
    const tz = s.time_zone || "America/Los_Angeles";
    const doc = await loadDoc(user.id);
    const meetings = await refreshAgenda(user.id, doc);
    if (!meetings) return json({ error: "No calendar is connected." }, 400);
    const soon = meetings.filter((m) => +m.start < Date.now() + 2 * 864e5).sort((a, b) => +a.start - +b.start);
    const when = (m: Meeting) => m.allDay ? `${m.date} (all day)` : `${local(tz, m.start).date} ${clock(tz, m.start)}`;
    const { data: fresh } = await admin.from("circle_settings").select("calendar_error").eq("user_id", user.id).maybeSingle();
    return json({
      ok: true, checkedAt: new Date().toISOString(), errors: fresh?.calendar_error ?? null, total: meetings.length,
      matched: soon.filter((m) => m.personIds.length).map((m) => ({ when: when(m), title: m.title, calendar: m.calendar,
        people: m.personIds.map((id) => doc.people.find((p) => p.id === id)?.name).filter(Boolean) })),
      others: soon.filter((m) => !m.personIds.length).slice(0, 20).map((m) => ({ when: when(m), title: m.title, calendar: m.calendar })),
    });
  }
  if (body.action === "refresh") return json({ ok: true, ...(await runUser(await settingsFor(user.id), true)) });
  return json({ error: "Unknown action" }, 400);
}
