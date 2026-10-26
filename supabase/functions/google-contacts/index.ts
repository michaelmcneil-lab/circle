// Two-way sync between Circle and Google Contacts (Supabase Edge Function).
//
// Google sign-in: the app asks for { action: "connect" } and opens the returned
// Google page; Google sends the browser back here (GET ?code&state), the refresh
// token is stored in circle_google (readable only by this function), and the browser
// returns to the app.
//
// Syncing: every 5 minutes the notify function's schedule calls this with
// X-Cron-Secret, which syncs everyone who turned sync on for all their people. The
// app (signed in) can also preview, run the one-person test, sync now, settle
// conflicts and decide what to do about deleted contacts. See sync.ts for how a run works.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import * as R from "../_shared/google-sync.ts";
import type { Doc } from "../_shared/circle.ts";
import { type Google, type Link, runSync, show, type Store } from "./sync.ts";
import { applyEvents, eventsFrom, type Message } from "../_shared/email-activity.ts";
import { baseline, newInGoogle, personFromGoogle } from "./new-in-google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const APP_URL = "https://michaelmcneil-lab.github.io/circle/";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-contacts`;
const PEOPLE_API = "https://people.googleapis.com/v1";
const SCOPES = "openid email https://www.googleapis.com/auth/contacts";
// Email activity: headers only (who, when, subject). This permission can't read message bodies.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const EMAIL_PER_RUN = 150; // messages read per run; the rest wait for the next one
const PHOTO_BUCKET = "photos";
const LOCK_SECONDS = 140; // one run at a time per person, so nothing is created twice

// deno-lint-ignore no-explicit-any
type Any = any;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

// ---------- Google ----------
class NeedsReconnect extends Error {}

async function accessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error === "invalid_grant") throw new NeedsReconnect("Google disconnected Circle. Connect Google again to keep syncing.");
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return body.access_token;
}

function googleApi(token: string): Google {
  const call = async (method: string, path: string, body?: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${PEOPLE_API}/${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return res.status === 204 ? {} : await res.json();
      // Google asks callers to slow down now and then; wait and try again.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      const err = await res.json().catch(() => ({}));
      throw new Error(`Google said: ${err.error?.message ?? res.status}`);
    }
  };
  const fields = `personFields=${R.PERSON_FIELDS}`;
  return {
    async list() {
      const out: Any[] = [];
      let page = "";
      do {
        const r = await call("GET", `people/me/connections?${fields}&pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
        out.push(...(r.connections ?? []));
        page = r.nextPageToken ?? "";
      } while (page);
      return out;
    },
    get: (rn) => call("GET", `${rn}?${fields}`),
    create: (body) => call("POST", `people:createContact?${fields}`, body),
    update: (rn, body, f) => call("PATCH", `${rn}:updateContact?updatePersonFields=${f.join(",")}&${fields}`, body),
    setPhoto: async (rn, b64) => (await call("PATCH", `${rn}:updateContactPhoto`, { photoBytes: b64, personFields: R.PERSON_FIELDS })).person,
    removePhoto: async (rn) => (await call("DELETE", `${rn}:deleteContactPhoto?${fields}`)).person,
    remove: async (rn) => { await call("DELETE", `${rn}:deleteContact`); },
    async fetchPhoto(url) {
      // Google's photo links end in a size, e.g. "=s100"; ask for Circle's size instead.
      const res = await fetch(url.replace(/=s\d+(-[a-z]+)*$/, "") + "=s400-c", { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Couldn't download the photo from Google (${res.status})`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "image/jpeg" };
    },
  };
}

// ---------- Supabase ----------
function supabaseStore(userId: string): Store {
  return {
    userId,
    async loadDoc() {
      const { data, error } = await admin.from("circle_data").select("data, revision, updated_at").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`Circle's data couldn't be read: ${error.message}`);
      if (!data) return null;
      const doc: Doc = { people: [], interactions: [], followUps: [], relations: [], ...(data.data ?? {}) };
      return { doc, rev: data.revision, updatedAt: Date.parse(data.updated_at) || 0 };
    },
    async saveDoc(doc, rev) {
      const { data, error } = await admin.from("circle_data").update({ data: doc, revision: rev + 1, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("revision", rev).select("revision");
      if (error) throw new Error(`Circle's data couldn't be saved: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async links() {
      const { data, error } = await admin.from("circle_google_links").select("*").eq("user_id", userId);
      if (error) throw new Error(`Sync links unavailable: ${error.message}`);
      return (data ?? []) as Link[];
    },
    async saveLink(l) {
      const { error } = await admin.from("circle_google_links").upsert({ ...l, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: "user_id,person_id" });
      if (error) throw new Error(`Sync link not saved: ${error.message}`);
    },
    async removeLink(personId) { await admin.from("circle_google_links").delete().eq("user_id", userId).eq("person_id", personId); },
    async photoGet(path) {
      const { data } = await admin.storage.from(PHOTO_BUCKET).download(path);
      return data ? new Uint8Array(await data.arrayBuffer()) : null;
    },
    async photoPut(path, bytes, _type) {
      // The photos bucket accepts only image/jpeg. Some Google photos are PNG; they're stored
      // under the JPEG label all the same, since browsers read the image itself to draw it.
      const { error } = await admin.storage.from(PHOTO_BUCKET).upload(path, bytes, { upsert: true, contentType: "image/jpeg" });
      if (error) throw new Error(`Photo not saved: ${error.message}`);
    },
    async photoRemove(path) { await admin.storage.from(PHOTO_BUCKET).remove([path]); },
  };
}

type Account = {
  user_id: string; refresh_token: string | null; google_email: string | null; mode: "off" | "all"; last_sync_at: string | null; last_error: string | null; last_result: Any;
  google_seen: string[] | null; // contacts already offered under "New in Google"
  scopes: string | null; gmail_on: boolean; gmail_history_id: string | null; gmail_checked_at: string | null; gmail_error: string | null; gmail_last: Any;
};
async function account(userId: string): Promise<Account | null> {
  const { data } = await admin.from("circle_google").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

// Runs a sync for one person using Circle, holding a lock so two runs never overlap.
async function syncUser(userId: string, opt: { apply: boolean; personIds?: string[] }) {
  const acct = await account(userId);
  if (!acct?.refresh_token) throw new Error("Google isn't connected.");
  if (opt.apply) {
    const now = new Date();
    const { data: got } = await admin.from("circle_google").update({ running_until: new Date(+now + LOCK_SECONDS * 1000).toISOString() })
      .eq("user_id", userId).or(`running_until.is.null,running_until.lt.${now.toISOString()}`).select("user_id");
    if (!got?.length) return { busy: true, changes: [], linked: 0, flags: [], waiting: 0 };
  }
  try {
    const result = await runSync(supabaseStore(userId), googleApi(await accessToken(acct.refresh_token)), opt);
    if (opt.apply) {
      const summary = { at: new Date().toISOString(), changes: result.changes.length, errors: result.changes.filter((c) => c.error).length, waiting: result.waiting, flags: result.flags.length };
      await admin.from("circle_google").update({ last_sync_at: summary.at, last_error: null, last_result: summary }).eq("user_id", userId);
    }
    return result;
  } catch (err) {
    if (opt.apply) await admin.from("circle_google").update({ last_error: msg(err), ...(err instanceof NeedsReconnect ? { refresh_token: null } : {}) }).eq("user_id", userId);
    throw err;
  } finally {
    if (opt.apply) await admin.from("circle_google").update({ running_until: null }).eq("user_id", userId);
  }
}

// What the app shows: connection, the last run, open conflicts and flags.
async function status(userId: string) {
  const acct = await account(userId);
  if (!acct) return { connected: false };
  const { data: links } = await admin.from("circle_google_links").select("person_id, status, conflicts").eq("user_id", userId);
  const { data: row } = await admin.from("circle_data").select("data").eq("user_id", userId).maybeSingle();
  const name = (id: string) => (row?.data?.people ?? []).find((p: Any) => p.id === id)?.name ?? "Someone";
  return {
    connected: !!acct.refresh_token, email: acct.google_email, mode: acct.mode, lastSyncAt: acct.last_sync_at, lastError: acct.last_error, last: acct.last_result,
    emailActivity: { on: !!acct.gmail_on, allowed: (acct.scopes ?? "").includes(GMAIL_SCOPE), checkedAt: acct.gmail_checked_at, error: acct.gmail_error, last: acct.gmail_last },
    linked: (links ?? []).filter((l) => l.status === "linked").length,
    excluded: (links ?? []).filter((l) => l.status === "excluded").map((l) => ({ personId: l.person_id, name: name(l.person_id) })),
    conflicts: (links ?? []).flatMap((l) => (l.conflicts ?? []).map((c: R.Conflict) => ({ personId: l.person_id, name: name(l.person_id), group: c.group, circle: show(c.group, c.circle), google: show(c.group, c.google) }))),
    flags: (links ?? []).filter((l) => l.status === "google_deleted" || l.status === "circle_deleted").map((l) => ({ personId: l.person_id, name: name(l.person_id), kind: l.status })),
  };
}

// ---------- Google sign-in ----------
// withEmail: also ask for Gmail headers, and turn email activity on once Google says yes.
async function startConnect(userId: string, withEmail = false) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Supabase → Edge Functions → Secrets.");
  const state = crypto.randomUUID();
  await admin.from("circle_google_oauth").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await admin.from("circle_google_oauth").insert({ state, user_id: userId, enable_email: withEmail });
  if (error) throw new Error(`Couldn't start Google sign-in: ${error.message}`);
  const acct = await account(userId);
  const email = withEmail || (acct?.scopes ?? "").includes(GMAIL_SCOPE);
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: email ? `${SCOPES} ${GMAIL_SCOPE}` : SCOPES, access_type: "offline", prompt: "consent", state, include_granted_scopes: "true" });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

const back = (q: Record<string, string>) => Response.redirect(`${APP_URL}?${new URLSearchParams(q)}`, 302);
async function finishConnect(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const { data: pending } = await admin.from("circle_google_oauth").select("user_id, created_at, enable_email").eq("state", state).maybeSingle();
  if (state) await admin.from("circle_google_oauth").delete().eq("state", state);
  if (!pending || Date.now() - Date.parse(pending.created_at) > 15 * 60_000) return back({ google: "error", why: "That sign-in link expired. Try Connect Google again." });
  if (url.searchParams.get("error")) return back({ google: "error", why: "Google sign-in was cancelled." });
  if (!(url.searchParams.get("scope") ?? "").includes("auth/contacts")) return back({ google: "error", why: "Circle needs permission to see and edit your contacts. Try again and tick that box." });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: url.searchParams.get("code") ?? "", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!tok.refresh_token) return back({ google: "error", why: `Google didn't finish the sign-in (${tok.error_description ?? tok.error ?? res.status}).` });
  let email = "";
  try { email = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email ?? ""; } catch { /* the address is only shown in the app */ }
  const before = await account(pending.user_id);
  // A different Google account: its contacts aren't the ones linked before.
  if (before?.google_email && email && before.google_email !== email) await admin.from("circle_google_links").delete().eq("user_id", pending.user_id);
  const scopes = String(tok.scope ?? url.searchParams.get("scope") ?? "");
  const { error } = await admin.from("circle_google").upsert({ user_id: pending.user_id, refresh_token: tok.refresh_token, google_email: email || before?.google_email, scopes, last_error: null, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return back({ google: "error", why: `Couldn't save the connection: ${error.message}` });
  if (pending.enable_email) {
    if (!scopes.includes(GMAIL_SCOPE)) return back({ google: "error", why: "Email activity needs permission to see your email headers. Try again and tick that box." });
    await startEmail(pending.user_id, tok.access_token);
    return back({ google: "email" });
  }
  return back({ google: "connected" });
}

// ---------- Email activity ----------
// Gmail keeps a numbered history of changes. Circle remembers where it read up to
// (gmail_history_id) and each run reads only the messages added since, so nothing
// is counted twice and nothing from before email activity was turned on is added.
async function gmail(token: string, path: string) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GMAIL_API}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return await res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`Gmail said: ${err.error?.message ?? res.status}`), { status: res.status });
  }
}

// Turns email activity on, starting from now.
async function startEmail(userId: string, token: string) {
  const profile = await gmail(token, "profile");
  await admin.from("circle_google").update({ gmail_on: true, gmail_history_id: String(profile.historyId), gmail_error: null, gmail_checked_at: new Date().toISOString() }).eq("user_id", userId);
}

async function emailUser(userId: string): Promise<{ logged: number; read: number; busy?: boolean }> {
  const acct = await account(userId);
  if (!acct?.refresh_token || !acct.gmail_on) return { logged: 0, read: 0 };
  const now = new Date();
  const { data: got } = await admin.from("circle_google").update({ running_until: new Date(+now + LOCK_SECONDS * 1000).toISOString() })
    .eq("user_id", userId).or(`running_until.is.null,running_until.lt.${now.toISOString()}`).select("user_id");
  if (!got?.length) return { logged: 0, read: 0, busy: true };
  try {
    const token = await accessToken(acct.refresh_token);
    if (!acct.gmail_history_id) { await startEmail(userId, token); return { logged: 0, read: 0 }; }
    // The message ids added since last time, oldest first, a batch per run.
    const ids: string[] = [];
    let upTo = acct.gmail_history_id, page = "", full = false;
    try {
      do {
        const r = await gmail(token, `history?startHistoryId=${acct.gmail_history_id}&historyTypes=messageAdded&maxResults=500${page ? `&pageToken=${page}` : ""}`);
        for (const h of r.history ?? []) {
          for (const m of h.messagesAdded ?? []) if (!ids.includes(m.message.id)) ids.push(m.message.id);
          upTo = String(h.id);
          if (ids.length >= EMAIL_PER_RUN) { full = true; break; }
        }
        if (!full) upTo = String(r.historyId ?? upTo);
        page = full ? "" : r.nextPageToken ?? "";
      } while (page);
    } catch (err) {
      // Gmail forgets history after about a week; start again from now.
      if ((err as { status?: number }).status === 404) {
        await startEmail(userId, token);
        await admin.from("circle_google").update({ gmail_error: "Circle couldn't check email for a while, so some emails may be missing." }).eq("user_id", userId);
        return { logged: 0, read: 0 };
      }
      throw err;
    }
    const messages: Message[] = [];
    for (const id of ids) {
      try {
        messages.push(await gmail(token, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject&metadataHeaders=List-Id&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence`));
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err; // deleted since: skip it
      }
    }
    let logged = 0;
    if (messages.length) {
      const store = supabaseStore(userId);
      const loaded = await store.loadDoc();
      if (loaded) {
        const { data: s } = await admin.from("circle_settings").select("time_zone").eq("user_id", userId).maybeSingle();
        const events = eventsFrom(messages, loaded.doc.people ?? [], acct.google_email ?? "", s?.time_zone || "America/Los_Angeles");
        logged = applyEvents(loaded.doc, events);
        // Saved from a device mid-run: read the same messages again next time.
        if (logged && !(await store.saveDoc(loaded.doc, loaded.rev))) return { logged: 0, read: 0, busy: true };
      }
    }
    await admin.from("circle_google").update({ gmail_history_id: upTo, gmail_checked_at: new Date().toISOString(), gmail_error: null,
      gmail_last: { at: new Date().toISOString(), read: messages.length, logged } }).eq("user_id", userId);
    return { logged, read: messages.length };
  } catch (err) {
    await admin.from("circle_google").update({ gmail_error: msg(err), ...(err instanceof NeedsReconnect ? { refresh_token: null } : {}) }).eq("user_id", userId);
    throw err;
  } finally {
    await admin.from("circle_google").update({ running_until: null }).eq("user_id", userId);
  }
}

// ---------- Requests ----------
Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("google-contacts failed", err);
    return json({ error: msg(err) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (req.method === "GET" && (url.searchParams.has("state") || url.searchParams.has("error"))) return await finishConnect(url);
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // The schedule: everyone with contacts sync or email activity turned on.
  if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) {
    const { data: all } = await admin.from("circle_google").select("user_id, mode, gmail_on").or("mode.eq.all,gmail_on.eq.true").not("refresh_token", "is", null);
    const results = [];
    for (const a of all ?? []) {
      const result: Record<string, unknown> = { user: a.user_id.slice(0, 8) };
      if (a.mode === "all") {
        try { const r = await syncUser(a.user_id, { apply: true }); Object.assign(result, { changes: r.changes.length, busy: !!r.busy }); }
        catch (err) { console.error("sync failed", a.user_id, err); }
      }
      if (a.gmail_on) {
        try { result.email = await emailUser(a.user_id); }
        catch (err) { console.error("email activity failed", a.user_id, err); }
      }
      results.push(result);
    }
    return json({ ok: true, results });
  }

  // The app, signed in.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const asUser = createClient(SUPABASE_URL, req.headers.get("apikey") ?? ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user } } = await asUser.auth.getUser(token);
  if (!user) return json({ error: "Not signed in" }, 401);
  let body: Any;
  try { body = await req.json(); } catch { body = {}; }
  const uid = user.id;
  const personIds = body.personId ? [String(body.personId)] : undefined;

  switch (body.action) {
    case "status": return json(await status(uid));
    case "connect": return json({ url: await startConnect(uid) });
    case "preview": return json(await syncUser(uid, { apply: false, personIds }));
    // The one-person test (personId) works while sync is off; syncing everyone needs it on.
    case "sync": {
      const acct = await account(uid);
      if (!personIds && acct?.mode !== "all") return json({ error: "Turn sync on for everyone first, or sync one person." }, 400);
      return json(await syncUser(uid, { apply: true, personIds }));
    }
    case "turn_on": {
      await admin.from("circle_google").update({ mode: "all" }).eq("user_id", uid);
      return json(await syncUser(uid, { apply: true }));
    }
    case "pause": {
      await admin.from("circle_google").update({ mode: "off" }).eq("user_id", uid);
      return json({ ok: true });
    }
    case "settle": {
      // Use Circle's or Google's value for one detail, then sync that person.
      const pid = String(body.personId), group = body.group as R.Group, use = body.use === "google" ? "google" : "circle";
      const { data: link } = await admin.from("circle_google_links").select("*").eq("user_id", uid).eq("person_id", pid).maybeSingle();
      if (!link?.resource_name || !R.GROUPS.includes(group)) return json({ error: "Nothing to settle" }, 400);
      const acct = await account(uid);
      const g = await googleApi(await accessToken(acct!.refresh_token!)).get(link.resource_name);
      const loaded = await supabaseStore(uid).loadDoc();
      const p = loaded?.doc.people.find((x: Any) => x.id === pid);
      if (!p) return json({ error: "That person isn't in Circle any more" }, 400);
      link.snapshot = R.settle(link.snapshot ?? {}, group, use, R.fromCircle(p), R.fromGoogle(g));
      link.conflicts = (link.conflicts ?? []).filter((c: R.Conflict) => c.group !== group);
      await supabaseStore(uid).saveLink(link);
      return json(await syncUser(uid, { apply: true, personIds: [pid] }));
    }
    case "exclude": {
      // Keep someone out of Google from now on (their Google contact, if any, stays as it is).
      const pid = String(body.personId);
      const { data: link } = await admin.from("circle_google_links").select("*").eq("user_id", uid).eq("person_id", pid).maybeSingle();
      await supabaseStore(uid).saveLink({ ...(link ?? { person_id: pid, resource_name: null, etag: null, snapshot: {}, photo_synced: false, circle_photo_v: null, google_photo_url: null }), conflicts: [], status: "excluded" });
      return json({ ok: true });
    }
    case "include": {
      // Back into the sync: linked again on the next run (or created in Google).
      await admin.from("circle_google_links").delete().eq("user_id", uid).eq("person_id", String(body.personId)).eq("status", "excluded");
      return json({ ok: true });
    }
    case "resolve_flag": {
      const pid = String(body.personId);
      const { data: link } = await admin.from("circle_google_links").select("*").eq("user_id", uid).eq("person_id", pid).maybeSingle();
      if (!link) return json({ error: "Nothing to resolve" }, 400);
      if (link.status === "circle_deleted" && body.choice === "delete_google") {
        // Google keeps deleted contacts in its Trash for 30 days.
        const acct = await account(uid);
        await googleApi(await accessToken(acct!.refresh_token!)).remove(link.resource_name);
        await supabaseStore(uid).removeLink(pid);
      } else if (link.status === "circle_deleted") {
        await supabaseStore(uid).removeLink(pid); // keep the Google contact, stop tracking it
      } else if (link.status === "google_deleted" && body.choice === "put_back") {
        await supabaseStore(uid).removeLink(pid); // the next run creates them in Google again
      } else if (link.status === "google_deleted") {
        await supabaseStore(uid).saveLink({ ...link, status: "excluded", resource_name: null }); // Circle only from now on
      }
      return json({ ok: true });
    }
    case "new_in_google": {
      const acct = await account(uid);
      if (!acct?.refresh_token) return json({ candidates: [] });
      const store = supabaseStore(uid);
      const [contacts, links, loaded] = [await googleApi(await accessToken(acct.refresh_token)).list(), await store.links(), await store.loadDoc()];
      const people = loaded?.doc.people ?? [];
      let seen = acct.google_seen;
      if (!seen) {
        seen = baseline(contacts, links, people, Date.now());
        await admin.from("circle_google").update({ google_seen: seen }).eq("user_id", uid);
      }
      return json({ candidates: newInGoogle(contacts, links, people, new Set(seen)) });
    }
    case "add_from_google": {
      // Makes a Circle person from the contact, already linked, so the sync has nothing to redo.
      const rn = String(body.resourceName ?? ""), relationship = String(body.relationship || "Friend").slice(0, 40);
      const acct = await account(uid);
      if (!acct?.refresh_token || !rn.startsWith("people/")) return json({ error: "Nothing to add" }, 400);
      const store = supabaseStore(uid);
      if ((await store.links()).some((l) => l.resource_name === rn)) return json({ error: "Already in Circle" }, 400);
      const g = await googleApi(await accessToken(acct.refresh_token)).get(rn);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); // the same shape as the app's ids
      let person: Any = null;
      for (let attempt = 0; attempt < 4 && !person; attempt++) {
        const loaded = await store.loadDoc();
        if (!loaded) return json({ error: "Circle's data isn't set up yet" }, 400);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
        const p = personFromGoogle(g, id, relationship, today);
        loaded.doc.people.push(p);
        if (await store.saveDoc(loaded.doc, loaded.rev)) person = p; // else a device saved first: try again
      }
      if (!person) return json({ error: "Circle was busy. Try again." }, 409);
      await store.saveLink({ person_id: id, resource_name: rn, status: "linked", etag: g.etag ?? null, snapshot: R.plan({}, R.fromCircle(person), R.fromGoogle(g), false).snapshot,
        conflicts: [], photo_synced: false, circle_photo_v: null, google_photo_url: null });
      await admin.from("circle_google").update({ google_seen: [...(acct.google_seen ?? []), rn] }).eq("user_id", uid);
      return json({ personId: id, name: person.name });
    }
    case "dismiss_google": {
      const acct = await account(uid);
      const rn = String(body.resourceName ?? "");
      if (rn) await admin.from("circle_google").update({ google_seen: [...new Set([...(acct?.google_seen ?? []), rn])] }).eq("user_id", uid);
      return json({ ok: true });
    }
    case "email_on": {
      // Already allowed: start now. Otherwise Google asks for the extra permission first.
      const acct = await account(uid);
      if (!acct?.refresh_token) return json({ error: "Connect Google first." }, 400);
      if (!(acct.scopes ?? "").includes(GMAIL_SCOPE)) return json({ url: await startConnect(uid, true) });
      await startEmail(uid, await accessToken(acct.refresh_token));
      return json({ ok: true });
    }
    case "email_off": {
      await admin.from("circle_google").update({ gmail_on: false, gmail_history_id: null }).eq("user_id", uid);
      return json({ ok: true });
    }
    case "email_check": return json(await emailUser(uid));
    case "disconnect": {
      const acct = await account(uid);
      if (acct?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acct.refresh_token)}`, { method: "POST" }).catch(() => {});
      await admin.from("circle_google_links").delete().eq("user_id", uid);
      await admin.from("circle_google").delete().eq("user_id", uid);
      return json({ ok: true });
    }
  }
  return json({ error: "Unknown action" }, 400);
}
