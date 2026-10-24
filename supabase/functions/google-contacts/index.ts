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

type Account = { user_id: string; refresh_token: string | null; google_email: string | null; mode: "off" | "all"; last_sync_at: string | null; last_error: string | null; last_result: Any };
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
    linked: (links ?? []).filter((l) => l.status === "linked").length,
    excluded: (links ?? []).filter((l) => l.status === "excluded").map((l) => ({ personId: l.person_id, name: name(l.person_id) })),
    conflicts: (links ?? []).flatMap((l) => (l.conflicts ?? []).map((c: R.Conflict) => ({ personId: l.person_id, name: name(l.person_id), group: c.group, circle: show(c.group, c.circle), google: show(c.group, c.google) }))),
    flags: (links ?? []).filter((l) => l.status === "google_deleted" || l.status === "circle_deleted").map((l) => ({ personId: l.person_id, name: name(l.person_id), kind: l.status })),
  };
}

// ---------- Google sign-in ----------
async function startConnect(userId: string) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Supabase → Edge Functions → Secrets.");
  const state = crypto.randomUUID();
  await admin.from("circle_google_oauth").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await admin.from("circle_google_oauth").insert({ state, user_id: userId });
  if (error) throw new Error(`Couldn't start Google sign-in: ${error.message}`);
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", state, include_granted_scopes: "true" });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

const back = (q: Record<string, string>) => Response.redirect(`${APP_URL}?${new URLSearchParams(q)}`, 302);
async function finishConnect(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const { data: pending } = await admin.from("circle_google_oauth").select("user_id, created_at").eq("state", state).maybeSingle();
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
  const { error } = await admin.from("circle_google").upsert({ user_id: pending.user_id, refresh_token: tok.refresh_token, google_email: email || before?.google_email, last_error: null, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return back({ google: "error", why: `Couldn't save the connection: ${error.message}` });
  return back({ google: "connected" });
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

  // The schedule: everyone with sync turned on.
  if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) {
    const { data: all } = await admin.from("circle_google").select("user_id").eq("mode", "all").not("refresh_token", "is", null);
    const results = [];
    for (const a of all ?? []) {
      try { const r = await syncUser(a.user_id, { apply: true }); results.push({ user: a.user_id.slice(0, 8), changes: r.changes.length, busy: !!r.busy }); }
      catch (err) { console.error("sync failed", a.user_id, err); }
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
