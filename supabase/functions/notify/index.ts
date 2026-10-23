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
type Meeting = { key: string; start: Date; end: Date; title: string; personIds: string[]; attendees: number };

// Turns a calendar feed into meetings between `from` and `to` that include someone in Circle.
// `seen`, if given, collects every timed event in the window, matched or not (for "Check calendar now").
function meetingsFrom(ics: string, doc: Doc, selfEmail: string, from: Date, to: Date, seen?: { title: string; start: Date }[]): Meeting[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
  const events = root.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
  // Moved or edited single occurrences of a repeating meeting belong to their series.
  const masters = new Map<string, InstanceType<typeof ICAL.Event>>();
  for (const e of events) if (!e.isRecurrenceException()) masters.set(e.uid, e);
  for (const e of events) if (e.isRecurrenceException()) masters.get(e.uid)?.relateException(e);

  const people = doc.people ?? [];
  const byEmail = new Map<string, string>();
  for (const p of people) for (const em of p.emails ?? []) byEmail.set(String(em.value).toLowerCase(), p.id);
  const firstNames = new Map<string, number>();
  for (const p of people) { const f = String(p.firstName || "").toLowerCase(); if (f) firstNames.set(f, (firstNames.get(f) ?? 0) + 1); }
  const word = (s: string) => new RegExp(`(^|[^\\p{L}])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu");
  const self = selfEmail.toLowerCase();

  const out: Meeting[] = [];
  const add = (e: InstanceType<typeof ICAL.Event>, start: InstanceType<typeof ICAL.Time>, end: InstanceType<typeof ICAL.Time>) => {
    if (start.isDate) return; // all-day events aren't meetings
    const vevent = e.component;
    if (String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    const attendees = vevent.getAllProperties("attendee").map((a) => ({
      email: String(a.getFirstValue() ?? "").replace(/^mailto:/i, "").toLowerCase(),
      name: String(a.getParameter("cn") ?? ""),
      status: String(a.getParameter("partstat") ?? "").toUpperCase(),
    }));
    if (attendees.some((a) => a.email === self && a.status === "DECLINED")) return;
    seen?.push({ title: e.summary || "(no title)", start: start.toJSDate() });
    const ids = new Set<string>();
    for (const a of attendees) if (a.email !== self && byEmail.has(a.email)) ids.add(byEmail.get(a.email)!);
    const text = [e.summary ?? "", ...attendees.map((a) => a.name)].join(" | ");
    for (const p of people) {
      if (ids.has(p.id)) continue;
      const names = [p.name, p.nickname].filter((n) => n && String(n).length >= 3);
      const first = String(p.firstName || "");
      // A first name alone only counts when nobody else in Circle shares it.
      if (first.length >= 3 && firstNames.get(first.toLowerCase()) === 1) names.push(first);
      if (names.some((n) => word(String(n)).test(text))) ids.add(p.id);
    }
    if (!ids.size) return;
    const startJs = start.toJSDate(), endJs = end.toJSDate();
    out.push({
      key: `${e.uid}|${startJs.toISOString()}`, start: startJs, end: endJs, title: e.summary || "Meeting", personIds: [...ids],
      attendees: Math.max(attendees.filter((a) => a.status !== "DECLINED").length, ids.size + 1),
    });
  };

  const fromT = ICAL.Time.fromJSDate(from, true), toT = ICAL.Time.fromJSDate(to, true);
  for (const e of masters.values()) {
    if (!e.isRecurring()) {
      if (e.endDate.compare(fromT) >= 0 && e.startDate.compare(toT) <= 0) add(e, e.startDate, e.endDate);
      continue;
    }
    const it = e.iterator();
    for (let n = 0, t = it.next(); t && n < 5000; t = it.next(), n++) {
      if (t.compare(toT) > 0) break;
      const d = e.getOccurrenceDetails(t);
      if (d.endDate.compare(fromT) >= 0) add(d.item, d.startDate, d.endDate);
    }
  }
  return out;
}

async function fetchCalendar(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: "text/calendar" } });
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

type Seen = { title: string; start: Date; calendar: string };
type Link = { id: string; label: string; url: string };

async function linksFor(userId: string): Promise<Link[]> {
  const { data, error } = await admin.from("circle_calendar_links").select("id, label, url").eq("user_id", userId).order("updated_at");
  if (error) throw new Error(`calendar list unavailable: ${error.message}`);
  return data ?? [];
}

// Re-reads every connected calendar and records meetings from yesterday to two days
// ahead. A calendar that fails doesn't stop the others; its error is kept on its link.
async function refreshAgenda(userId: string, doc: Doc, seen?: Seen[]) {
  const links = await linksFor(userId);
  if (!links.length) return null;
  const now = Date.now(), from = new Date(now - 864e5), to = new Date(now + 2 * 864e5);
  const self = await userEmail(userId);
  const byKey = new Map<string, Meeting & { calendar: string }>();
  const failed: string[] = [];
  for (const link of links) {
    try {
      const mine: { title: string; start: Date }[] = [];
      for (const m of meetingsFrom(await fetchCalendar(link.url), doc, self, from, to, mine)) {
        // The same event in two calendars (a shared family calendar) counts once.
        const dupe = [...byKey.values()].some((x) => x.title === m.title && +x.start === +m.start);
        if (!byKey.has(m.key) && !dupe) byKey.set(m.key, { ...m, calendar: link.label });
      }
      seen?.push(...mine.map((e) => ({ ...e, calendar: link.label })));
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
      user_id: userId, event_key: m.key, start_at: m.start.toISOString(), end_at: m.end.toISOString(), title: m.title, calendar_label: m.calendar,
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
function brief(c: Circle, tz: string, meetings: { start_at: string; person_ids: string[] }[]): Payload | null {
  const name = (id: string) => c.person(id)?.firstName || c.person(id)?.name || "someone";
  const hardFor = (id: string) => (c.person(id)?.events ?? []).filter((e: { type: string }) => HARD.has(e.type) && c.eventState(e) === "prominent")[0];
  const parts: string[] = [];
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
    if (p.birthday) { const n = c.next(p.birthday); if (n.days <= 1) dates.push(`${name(p.id)}'s birthday ${n.days ? "tomorrow" : "today"}`); }
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
  return { title: meetings.length ? `Today: ${meetings.length} meeting${meetings.length > 1 ? "s" : ""} with your people` : "Today in Circle",
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
  if (s.last_brief_date !== now.date && now.hm >= s.brief_time && now.hm < BRIEF_LATEST && (weekday || s.brief_weekends)) {
    const c = new Circle(doc, tz);
    const dayStart = new Date(Date.now() - 864e5).toISOString(), dayEnd = new Date(Date.now() + 864e5).toISOString();
    const { data: rows } = await admin.from("circle_agenda").select("start_at, person_ids").eq("user_id", s.user_id)
      .gte("start_at", dayStart).lte("start_at", dayEnd).order("start_at");
    const today = (rows ?? []).filter((r) => local(tz, new Date(r.start_at)).date === now.date && new Date(r.start_at).getTime() > Date.now() - 3600e3);
    const payload = brief(c, tz, today);
    if (payload) result.brief = await push(s.user_id, payload);
    await admin.from("circle_settings").update({ last_brief_date: now.date }).eq("user_id", s.user_id);
  }

  if (s.prompt_max_people > 0) {
    const since = new Date(Date.now() - PROMPT_WITHIN_MIN * 60000).toISOString();
    const { data: ended } = await admin.from("circle_agenda").select("event_key, title, person_ids, attendee_count")
      .eq("user_id", s.user_id).eq("prompted", false).lte("end_at", new Date().toISOString()).gte("end_at", since);
    const quiet = isQuiet(now.hm, s.quiet_start, s.quiet_end);
    for (const m of ended ?? []) {
      if (m.attendee_count <= s.prompt_max_people && !quiet) {
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

Deno.serve(async (req) => {
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
    return json({ ok: true, results });
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
      found = meetingsFrom(await fetchCalendar(url), doc, await userEmail(user.id), new Date(now - 864e5), new Date(now + 2 * 864e5));
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
    return json({ ok: true, label: name, meetings: found.length });
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
    // What Circle can see in the calendars right now, matched or not.
    const s = await settingsFor(user.id);
    const tz = s.time_zone || "America/Los_Angeles";
    const seen: Seen[] = [];
    const doc = await loadDoc(user.id);
    const meetings = await refreshAgenda(user.id, doc, seen);
    if (!meetings) return json({ error: "No calendar is connected." }, 400);
    const when = (d: Date) => `${local(tz, d).date} ${clock(tz, d)}`;
    const matchedKeys = new Set(meetings.map((m) => `${m.title}|${m.start.toISOString()}`));
    const { data: fresh } = await admin.from("circle_settings").select("calendar_error").eq("user_id", user.id).maybeSingle();
    return json({
      ok: true, checkedAt: new Date().toISOString(), errors: fresh?.calendar_error ?? null,
      matched: meetings.sort((a, b) => +a.start - +b.start).map((m) => ({ when: when(m.start), title: m.title, calendar: m.calendar,
        people: m.personIds.map((id) => doc.people.find((p) => p.id === id)?.name).filter(Boolean) })),
      others: seen.filter((e) => !matchedKeys.has(`${e.title}|${e.start.toISOString()}`)).sort((a, b) => +a.start - +b.start)
        .slice(0, 20).map((e) => ({ when: when(e.start), title: e.title, calendar: e.calendar })),
    });
  }
  if (body.action === "refresh") return json({ ok: true, ...(await runUser(await settingsFor(user.id), true)) });
  return json({ error: "Unknown action" }, 400);
});
