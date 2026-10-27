// Circle's connector for Claude: a remote MCP server (Supabase Edge Function).
//
// Claude signs in through Supabase Auth's OAuth 2.1 server, so every request
// carries the user's own access token and row-level security limits it to their
// data. The tools can read Circle and add notes to the Inbox for review; they
// can't change or delete anything.
//
// Speaks MCP's Streamable HTTP transport, statelessly: each POST is a JSON-RPC
// message (or batch) answered with JSON. No server-sent events are needed.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import { Circle, type Doc, EV_LABEL, fmt, HARD, IX_LABEL, REL_LABEL, REL_REV } from "../_shared/circle.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RESOURCE = `${SUPABASE_URL}/functions/v1/mcp`;
const METADATA_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_TIME_ZONE = "America/Los_Angeles";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

// ---------- Tools ----------
const TOOLS = [
  {
    name: "find_people",
    title: "Find people in Circle",
    description: "Search the user's Circle (friends, family, colleagues) by name, nickname, company, tag, interest or a family member's name. Returns matching people with their id, relationship and when the user last talked to them. Leave query empty to list everyone.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to search for, e.g. 'Tiz' or 'college'" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_person",
    title: "Get a person's brief",
    description: "Everything Circle knows about one person, to prepare before talking to them: what they're going through right now and how the user wants to show up, open follow-ups, recent conversations and life events, family (with birthdays), interests, notes and contact details. Pass a name, nickname or id.",
    inputSchema: { type: "object", properties: { person: { type: "string", description: "Name, nickname or id" } }, required: ["person"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "whats_coming_up",
    title: "What's coming up",
    description: "The user's relationship to-do list: people going through something hard, follow-ups that are overdue or due soon, upcoming birthdays and anniversaries (including family members), and people they're overdue to check in with.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "How many days ahead to look (default 14)" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_note",
    title: "Add a note to the Circle Inbox",
    description: "Send a note to the user's Circle Inbox, where it's sorted into suggested updates (conversations, follow-ups with dates, life events, facts, and contact details such as a birthday, phone number, email, address, company or job title) that the user reviews and approves in the Circle app. Use it when the user wants to record something about someone, e.g. 'I just spoke with Tiz, he's having a hard week, follow up Sunday'. Pass the user's note in their own words, including names and any dates. Nothing in Circle changes until they approve it.",
    inputSchema: { type: "object", properties: { note: { type: "string", description: "The note, in the user's own words" } }, required: ["note"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

function personLine(c: Circle, p: { id: string; name: string; nickname?: string; relationship?: string; company?: string }) {
  const last = c.lastContact(p.id);
  const hard = (c.person(p.id).events || []).filter((e: { type: string }) => HARD.has(e.type) && c.eventState(e) === "prominent");
  const bits = [p.relationship, p.company, last ? `last talked ${fmt(last)}` : "no conversations logged"];
  if (hard.length) bits.push(`going through: ${hard.map((e: { title: string }) => e.title).join("; ")}`);
  const due = c.openFollowUps(p.id).filter((f) => f.due && c.since(f.due) >= 0);
  if (due.length) bits.push(`${due.length} follow-up${due.length > 1 ? "s" : ""} due`);
  return `- ${p.name}${p.nickname ? ` ("${p.nickname}")` : ""} [id ${p.id}]: ${bits.filter(Boolean).join(", ")}`;
}

// deno-lint-ignore no-explicit-any
function brief(c: Circle, p: any): string {
  const out: string[] = [];
  out.push(`# ${p.name}${p.pronouns ? ` (${p.pronouns})` : ""}`);
  out.push([p.relationship, [p.jobTitle, p.company].filter(Boolean).join(" at ")].filter(Boolean).join(" · "));
  const last = c.lastContact(p.id);
  out.push(last ? `Last talked: ${fmt(last)} (${c.since(last)} days ago)` : "No conversations logged yet.");
  if (p.contactEvery) out.push(`Check-in goal: every ${p.contactEvery} days${c.overdue(p) ? " (overdue)" : ""}`);
  if (p.birthday) { const n = c.next(p.birthday); out.push(`Birthday: ${n.md}${n.years ? `, turns ${n.years}` : ""} (in ${n.days} days)`); }

  const events = (p.events || []).slice().sort((a: { date: string }, b: { date: string }) => b.date.localeCompare(a.date));
  const top = events.filter((e: unknown) => c.eventState(e) === "prominent");
  if (top.length) {
    out.push("\n## Top of mind");
    for (const e of top) {
      out.push(`- ${e.title} (${EV_LABEL[e.type] || e.type}, ${fmt(e.date)}${e.until ? `, until ${fmt(e.until)}` : ""})`);
      if (e.notes) out.push(`  What they shared: ${e.notes}`);
      if (e.howToShowUp) out.push(`  How the user wants to show up: ${e.howToShowUp}`);
    }
  }
  const fus = c.openFollowUps(p.id);
  if (fus.length) {
    out.push("\n## Open follow-ups");
    for (const f of fus) out.push(`- ${f.text}${f.due ? ` (by ${fmt(f.due)}${c.since(f.due) > 0 ? ", overdue" : ""})` : ""}${f.personIds.length > 1 ? ` with ${c.names(f.personIds, p.id)}` : ""}`);
  }
  const ixs = c.ixFor(p.id).slice(0, 6);
  if (ixs.length) {
    out.push("\n## Recent conversations");
    for (const i of ixs) out.push(`- ${fmt(i.date)}, ${IX_LABEL[i.type] || i.type}${i.personIds.length > 1 ? ` with ${c.names(i.personIds, p.id)}` : ""}: ${i.summary}`);
  }
  const older = events.filter((e: { date: string }) => !top.includes(e) && c.since(e.date) <= 730).slice(0, 6);
  if (older.length) {
    out.push("\n## Other life events (last two years)");
    for (const e of older) out.push(`- ${fmt(e.date)}: ${e.title}${e.notes ? `. ${e.notes}` : ""}`);
  }
  const fam: string[] = [];
  for (const r of c.doc.relations || []) {
    if (r.from === p.id) fam.push(`- ${c.person(r.to)?.name} (${REL_LABEL[r.type] || r.type}, in Circle)`);
    else if (r.to === p.id) fam.push(`- ${c.person(r.from)?.name} (${REL_LABEL[REL_REV[r.type]] || r.type}, in Circle)`);
  }
  for (const m of p.familyMembers || []) {
    const n = m.birthday ? c.next(m.birthday) : null;
    fam.push(`- ${m.name} (${REL_LABEL[m.rel] || m.rel})${n ? `, birthday ${n.md}${n.years ? ` turning ${n.years}` : ""}, in ${n.days} days` : ""}${m.note ? `. ${m.note}` : ""}`);
  }
  if (fam.length || p.family) out.push("\n## Family", ...fam, ...(p.family ? [`Notes: ${p.family}`] : []));
  if (p.interests?.length) out.push(`\nInterests: ${p.interests.join(", ")}`);
  if (p.tags?.length) out.push(`Tags: ${p.tags.join(", ")}`);
  if (p.howMet) out.push(`How they met: ${p.howMet}`);
  if (p.notes) out.push(`\n## Notes\n${p.notes}`);
  // Data saved before addresses became a list has one "address" until a device updates it.
  const addresses = Array.isArray(p.addresses) ? p.addresses : p.address ? [{ label: "Home", value: p.address }] : [];
  const contact = [...(p.phones || []).map((x: { label: string; value: string }) => `${x.label} phone ${x.value}`),
    ...(p.emails || []).map((x: { label: string; value: string }) => `${x.label} email ${x.value}`),
    ...addresses.map((x: { label: string; value: string }) => `${x.label} address ${String(x.value).replace(/\n/g, ", ")}`)];
  if (contact.length) out.push(`\n## Contact\n${contact.join("\n")}`);
  return out.filter((l) => l !== "").join("\n");
}

function comingUp(c: Circle, days: number): string {
  const out: string[] = [`Today is ${fmt(c.today)}. Looking ${days} days ahead.`];
  const hard = c.doc.people.flatMap((p) => (p.events || []).filter((e: { type: string }) => HARD.has(e.type) && c.eventState(e) === "prominent").map((e: { title: string; date: string; howToShowUp?: string }) =>
    `- ${p.name}: ${e.title} (since ${fmt(e.date)})${e.howToShowUp ? `. How to show up: ${e.howToShowUp}` : ""}`));
  if (hard.length) out.push("\n## Going through something", ...hard);
  const fus = c.openFollowUps().filter((f) => f.due && c.since(f.due) >= -days);
  if (fus.length) out.push("\n## Follow-ups due", ...fus.map((f) => `- ${c.names(f.personIds)}: ${f.text} (by ${fmt(f.due)}${c.since(f.due) > 0 ? ", overdue" : ""})`));
  const undated = c.openFollowUps().filter((f) => !f.due);
  if (undated.length) out.push(`\n${undated.length} more open follow-up${undated.length > 1 ? "s have" : " has"} no date.`);
  const dates: { days: number; line: string }[] = [];
  for (const p of c.doc.people) {
    if (p.birthday) { const n = c.next(p.birthday); if (n.days <= days) dates.push({ days: n.days, line: `${p.name}'s birthday${n.years ? `, turning ${n.years}` : ""}` }); }
    for (const m of p.familyMembers || []) if (m.birthday) { const n = c.next(m.birthday); if (n.days <= days) dates.push({ days: n.days, line: `${m.name}'s birthday (${p.name}'s ${REL_LABEL[m.rel] || m.rel})${n.years ? `, turning ${n.years}` : ""}` }); }
    for (const e of p.events || []) if (e.recurring || (e.type === "loss" && c.next(e.date).years === 1)) {
      const n = c.next(e.date);
      if (n.days <= days && n.years) dates.push({ days: n.days, line: e.type === "loss" ? `${n.years} year${n.years > 1 ? "s" : ""} since ${p.name}'s ${e.title}` : `${p.name}: ${e.title}, ${n.years} years` });
    }
  }
  if (dates.length) out.push("\n## Birthdays and anniversaries", ...dates.sort((a, b) => a.days - b.days).map((d) => `- ${d.days === 0 ? "Today" : d.days === 1 ? "Tomorrow" : `In ${d.days} days`}: ${d.line}`));
  const due = c.doc.people.filter((p) => c.overdue(p)).map((p) => {
    const last = c.lastContact(p.id);
    return `- ${p.name} (goal every ${p.contactEvery} days, ${last ? `last talked ${fmt(last)}` : "never logged"})`;
  });
  if (due.length) out.push("\n## Time to check in", ...due.slice(0, 15));
  if (out.length === 1) out.push("Nothing pressing.");
  return out.join("\n");
}

async function callTool(name: string, args: Record<string, unknown>, db: SupabaseClient, token: string, userId: string) {
  if (name === "add_note") {
    const note = String(args.note ?? "").trim();
    if (!note) return { text: "The note is empty.", isError: true };
    // Same path as the app's Quick note: the capture function sorts it into the Inbox.
    const res = await fetch(`${SUPABASE_URL}/functions/v1/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text: note, source: "claude", timeZone: await userTimeZone(db, userId) }),
    });
    const row = await res.json().catch(() => null);
    if (!res.ok || !row) return { text: `Couldn't add the note: ${row?.error ?? res.statusText}`, isError: true };
    if (row.status === "error") return { text: `The note was saved to the Circle Inbox, but sorting it failed (${row.error}). The user can tap "Try again" there.` };
    const actions = row.suggestion?.actions ?? [];
    type Action = { kind: string; people: { name: string }[]; summary: string; follow_up_text: string; due: string; title: string; note: string; detail_field?: string; detail_value?: string; detail_label?: string };
    // A contact-detail change reads as "detail for Jim: birthday → 03-12" (MM-DD when no year was given).
    const what = (a: Action) => a.kind === "detail"
      ? `${String(a.detail_field ?? "").replace("_", " ")}${a.detail_label ? ` (${a.detail_label})` : ""} → ${String(a.detail_value ?? "").replace(/\n/g, ", ")}`
      : a.summary || a.follow_up_text || a.title || a.note;
    const lines = actions.map((a: Action) =>
      `- ${a.kind.replace("_", " ")}${a.people.length ? ` for ${a.people.map((x) => x.name).join(" & ")}` : " (person to be chosen)"}: ${what(a)}${a.due ? ` (by ${a.due})` : ""}`);
    return { text: `Added to the Circle Inbox for the user to review and approve in the Circle app.${lines.length ? `\nSuggested updates:\n${lines.join("\n")}` : "\nNo specific updates were suggested."}` };
  }

  const { data: row, error } = await db.from("circle_data").select("data").eq("user_id", userId).maybeSingle();
  if (error) return { text: `Couldn't read Circle: ${error.message}`, isError: true };
  const doc: Doc = { people: [], interactions: [], followUps: [], relations: [], ...(row?.data ?? {}) };
  const c = new Circle(doc, await userTimeZone(db, userId));

  if (name === "find_people") {
    const q = String(args.query ?? "").trim();
    const found = q ? c.find(q) : doc.people.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!found.length) return { text: `No one in Circle matches "${q}".` };
    return { text: `${found.length} ${found.length === 1 ? "person" : "people"}:\n${found.slice(0, 50).map((p) => personLine(c, p)).join("\n")}${found.length > 50 ? `\n…and ${found.length - 50} more. Narrow the search.` : ""}` };
  }
  if (name === "get_person") {
    const found = c.find(String(args.person ?? ""));
    if (!found.length) return { text: `No one in Circle matches "${args.person}". Try find_people.` };
    if (found.length > 1) return { text: `Several people match. Ask the user which one, or call again with an id:\n${found.slice(0, 10).map((p) => personLine(c, p)).join("\n")}` };
    return { text: brief(c, found[0]) };
  }
  if (name === "whats_coming_up") {
    const days = Math.min(Math.max(Number(args.days) || 14, 1), 90);
    return { text: comingUp(c, days) };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

// The time zone saved with the user's most recent Shortcut key, if any.
async function userTimeZone(db: SupabaseClient, userId: string) {
  const { data } = await db.from("circle_tokens").select("time_zone").eq("user_id", userId).not("time_zone", "is", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data?.time_zone || DEFAULT_TIME_ZONE;
}

// ---------- MCP over HTTP ----------
const INSTRUCTIONS = "Circle is the user's personal app for staying close to friends, family and colleagues. Use get_person before the user talks to someone, whats_coming_up for who needs attention, and add_note to record anything they tell you about someone (it goes to their Inbox for review). Treat what you read with care: it's private information about people in the user's life.";

// deno-lint-ignore no-explicit-any
async function handle(msg: any, db: SupabaseClient, token: string, userId: string) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  if (msg.id === undefined) return null; // a notification, such as notifications/initialized
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "circle", title: "Circle", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, msg.params?.arguments ?? {}, db, token, userId);
        return reply({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
      } catch (err) {
        console.error("tool failed", name, err);
        return reply({ content: [{ type: "text", text: `Something went wrong: ${err instanceof Error ? err.message : err}` }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  // Tells Claude where to sign in (RFC 9728).
  if (path.endsWith("/.well-known/oauth-protected-resource")) {
    return json({ resource: RESOURCE, authorization_servers: [`${SUPABASE_URL}/auth/v1`], bearer_methods_supported: ["header"], resource_name: "Circle" });
  }

  const unauthorized = (why: string) => json({ error: "unauthorized", error_description: why }, 401,
    { "WWW-Authenticate": `Bearer resource_metadata="${METADATA_URL}"` });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return unauthorized("Sign in to Circle to use this connector");
  // Acting as the user, so row-level security limits every query to their own rows.
  const db = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return unauthorized("The sign-in has expired or isn't valid");

  if (req.method !== "POST") return json({ error: "This server only accepts POST" }, 405, { Allow: "POST" });
  let body;
  try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const results = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => handle(m, db, token, user.id)))).filter(Boolean);
  if (!results.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? results : results[0]);
});
