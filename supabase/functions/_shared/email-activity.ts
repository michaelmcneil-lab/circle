// Turning Gmail messages into "Email" conversations in Circle. Only message headers
// are used (who, when, subject): Circle's Gmail permission can't read message bodies.
// No network or database here, so the rules can be tested on their own
// (email-activity.test.ts).
//
// Which emails count:
// - sent by you, to at most MAX_PEOPLE recipients (To, Cc and Bcc together);
// - sent to you by someone in Circle, to at most MAX_PEOPLE recipients, and not from a
//   mailing list or bulk sender;
// - never drafts, spam, trash or chat.
// Each person gets at most one entry per day; later emails that day add their subject.

// deno-lint-ignore no-explicit-any
type Any = any;

export const MAX_PEOPLE = 5;
const MAX_SUBJECTS = 3;
const SKIP_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);

// A message as Gmail returns it with format=metadata.
export type Message = { id: string; internalDate: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };
export type EmailEvent = { personId: string; date: string; subject: string; messageId: string };

export const emailsIn = (header: string) => (header.match(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+\.[^\s<>,;:"'()]+/g) ?? []).map((e) => e.toLowerCase());
export function cleanSubject(subject: string) {
  let s = subject.trim();
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/^(re|fw|fwd|aw|wg)\s*(\[\d+\])?\s*:\s*/i, "").trim(); }
  return s || "(no subject)";
}
// The calendar date of a moment in a time zone, as YYYY-MM-DD.
export const localDate = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

// Every email address of every person in Circle → their ids (a shared family address
// can belong to more than one person).
export function emailIndex(people: Any[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const p of people) for (const e of p.emails ?? []) {
    const key = String(e.value ?? "").trim().toLowerCase();
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), p.id].filter((id, i, all) => all.indexOf(id) === i));
  }
  return index;
}

export function eventsFrom(messages: Message[], people: Any[], me: string, timeZone: string): EmailEvent[] {
  const index = emailIndex(people);
  const self = me.toLowerCase();
  const out: EmailEvent[] = [];
  for (const m of messages) {
    const labels = new Set(m.labelIds ?? []);
    if ([...labels].some((l) => SKIP_LABELS.has(l))) continue;
    const h = new Map((m.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
    const recipients = [...new Set(["to", "cc", "bcc"].flatMap((k) => emailsIn(h.get(k) ?? "")))].filter((e) => e !== self);
    if (recipients.length > MAX_PEOPLE) continue;
    let who: string[];
    if (labels.has("SENT")) {
      who = recipients;
    } else {
      // Mailing lists and bulk mail say so in their headers.
      if (h.has("list-id") || h.has("list-unsubscribe") || /bulk|list|junk/i.test(h.get("precedence") ?? "")) continue;
      who = emailsIn(h.get("from") ?? "").filter((e) => e !== self);
    }
    const ids = [...new Set(who.flatMap((e) => index.get(e) ?? []))];
    if (!ids.length) continue;
    const date = localDate(Number(m.internalDate), timeZone);
    const subject = cleanSubject(h.get("subject") ?? "");
    for (const personId of ids) out.push({ personId, date, subject, messageId: m.id });
  }
  return out;
}

// ---------- Catching up on earlier email ----------
// Circle's Gmail permission (headers only) can't search, so catching up walks recent mail
// newest first. A Gmail message id carries its time (the id's top bits are milliseconds
// since 1970, within seconds), so the walk stops at the cut-off without opening older mail.
export const idTime = (id: string) => Number(BigInt(`0x${id}`) >> 20n);

// Gmail's batch endpoint answers many requests in one multipart reply: each part holds an
// HTTP status line and a JSON body, labelled with the Content-ID of the request it answers
// ("response-<id>"). Returns { id, status, body } per part.
export function parseBatch(text: string, boundary: string): { id: string; status: number; body: Any }[] {
  return text.split(`--${boundary}`).slice(1).filter((part) => !part.startsWith("--")).map((part) => {
    const id = part.match(/Content-ID:\s*<?response-([^>\s]+)>?/i)?.[1] ?? "";
    const status = Number(part.match(/HTTP\/[\d.]+ (\d{3})/)?.[1] ?? 0);
    const start = part.indexOf("{"), end = part.lastIndexOf("}");
    let body: Any = null;
    if (start >= 0 && end > start) { try { body = JSON.parse(part.slice(start, end + 1)); } catch { body = null; } }
    return { id, status, body };
  });
}

const summaryOf = (subjects: string[]) =>
  subjects.slice(0, MAX_SUBJECTS).join(" · ") + (subjects.length > MAX_SUBJECTS ? ` (+${subjects.length - MAX_SUBJECTS} more)` : "");

// Adds the events to Circle's conversations (in place). Returns how many entries were
// added or changed. An entry's id is fixed per person and day, so a message seen twice,
// or a run repeated, changes nothing. A note the user edited is left as they wrote it.
export function applyEvents(doc: Any, events: EmailEvent[]): number {
  doc.interactions ??= [];
  const people = new Set((doc.people ?? []).map((p: Any) => p.id));
  const touched = new Set<string>();
  for (const ev of events) {
    if (!people.has(ev.personId)) continue;
    const id = `gm-${ev.personId}-${ev.date}`;
    let ix = doc.interactions.find((i: Any) => i.id === id);
    if (!ix) {
      ix = { id, personIds: [ev.personId], date: ev.date, type: "email", summary: "", source: "gmail", emailSubjects: [], emailMessages: [], autoSummary: "" };
      doc.interactions.push(ix);
    }
    ix.emailMessages ??= [];
    if (ix.emailMessages.includes(ev.messageId)) continue;
    ix.emailMessages.push(ev.messageId);
    ix.emailSubjects ??= [];
    if (!ix.emailSubjects.includes(ev.subject)) ix.emailSubjects.push(ev.subject);
    if ((ix.summary ?? "") === (ix.autoSummary ?? "")) { ix.summary = summaryOf(ix.emailSubjects); ix.autoSummary = ix.summary; }
    touched.add(id);
  }
  return touched.size;
}
