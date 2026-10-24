// Tests for turning Gmail headers into Circle conversations.
// Run: deno test supabase/functions/_shared/email-activity.test.ts
import { applyEvents, cleanSubject, emailsIn, eventsFrom, type Message } from "./email-activity.ts";

const eq = (a: unknown, b: unknown, msg = "") => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}\n  got:  ${x}\n  want: ${y}`); };

const ME = "me@gmail.com", TZ = "America/Los_Angeles";
const people = [
  { id: "anna", name: "Anna Lee", emails: [{ label: "Personal", value: "Anna@Example.com" }] },
  { id: "ben", name: "Ben Ng", emails: [{ label: "Work", value: "ben@work.com" }, { label: "Personal", value: "ben@home.com" }] },
  { id: "cara", name: "Cara Diaz", emails: [] },
];
// 2026-10-24 18:00 UTC = 11:00 in Los Angeles; 2026-10-25 05:00 UTC = 22:00 on the 24th there.
const at = (iso: string) => String(Date.parse(iso));
const msg = (id: string, labels: string[], headers: Record<string, string>, when = "2026-10-24T18:00:00Z"): Message =>
  ({ id, internalDate: at(when), labelIds: labels, payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });

Deno.test("addresses are found in headers with names, quotes and commas", () => {
  eq(emailsIn('"Lee, Anna" <Anna@Example.com>, ben@work.com; Someone <x@y.org>'), ["anna@example.com", "ben@work.com", "x@y.org"]);
});

Deno.test("subjects lose Re: and Fwd:", () => {
  eq([cleanSubject("Re: RE: Fwd: Dinner Friday?"), cleanSubject("  "), cleanSubject("Re[2]: Plans")], ["Dinner Friday?", "(no subject)", "Plans"]);
});

Deno.test("which emails count", () => {
  const ev = eventsFrom([
    msg("m1", ["SENT"], { To: "Anna Lee <anna@example.com>", Subject: "Dinner Friday?" }),
    msg("m2", ["INBOX"], { From: "Ben <ben@home.com>", To: ME, Subject: "Re: Dinner Friday?" }),
    msg("m3", ["INBOX"], { From: "anna@example.com", To: ME, "List-Id": "<club.example.com>", Subject: "Newsletter" }),
    msg("m4", ["SENT"], { To: "a@x.com, b@x.com, c@x.com, d@x.com, e@x.com, anna@example.com", Subject: "Big group" }),
    msg("m5", ["DRAFT"], { To: "anna@example.com", Subject: "Unsent" }),
    msg("m6", ["INBOX"], { From: "stranger@x.com", To: ME, Subject: "Hi" }),
    msg("m7", ["SENT"], { To: "anna@example.com", Cc: "ben@work.com", Subject: "Both of you" }),
    msg("m8", ["INBOX"], { From: "ben@work.com", To: ME, Precedence: "bulk", Subject: "Automated" }),
  ], people, ME, TZ);
  eq(ev.map((e) => `${e.messageId}:${e.personId}`), ["m1:anna", "m2:ben", "m7:anna", "m7:ben"]);
  eq(ev[0].date, "2026-10-24");
});

Deno.test("the day is your day, not Greenwich's", () => {
  const ev = eventsFrom([msg("late", ["SENT"], { To: "anna@example.com", Subject: "Late" }, "2026-10-25T05:00:00Z")], people, ME, TZ);
  eq(ev[0].date, "2026-10-24");
});

Deno.test("one entry per person per day, collecting subjects", () => {
  const doc = { people, interactions: [] as Record<string, unknown>[] };
  const day = (ids: string[], subjects: string[]) => eventsFrom(ids.map((id, i) => msg(id, ["SENT"], { To: "anna@example.com", Subject: subjects[i] })), people, ME, TZ);
  eq(applyEvents(doc, day(["a", "b"], ["Dinner Friday?", "Re: Dinner Friday?"])), 1);
  eq(doc.interactions.length, 1);
  eq([doc.interactions[0].id, doc.interactions[0].type, doc.interactions[0].summary, doc.interactions[0].personIds], ["gm-anna-2026-10-24", "email", "Dinner Friday?", ["anna"]]);
  applyEvents(doc, day(["c", "d", "e", "f"], ["Photos", "Address", "Gift", "Directions"]));
  eq(doc.interactions[0].summary, "Dinner Friday? · Photos · Address (+2 more)");
  eq(applyEvents(doc, day(["c"], ["Photos"])), 0, "a message seen again changes nothing");
});

Deno.test("a note the user rewrote is kept", () => {
  const doc = { people, interactions: [] as Record<string, unknown>[] };
  applyEvents(doc, eventsFrom([msg("a", ["SENT"], { To: "anna@example.com", Subject: "Dinner" })], people, ME, TZ));
  doc.interactions[0].summary = "Planned dinner for her birthday";
  applyEvents(doc, eventsFrom([msg("b", ["SENT"], { To: "anna@example.com", Subject: "Restaurant" })], people, ME, TZ));
  eq(doc.interactions[0].summary, "Planned dinner for her birthday");
  eq(doc.interactions[0].emailSubjects, ["Dinner", "Restaurant"]);
});

Deno.test("someone removed from Circle gets nothing", () => {
  const doc = { people: [people[1]], interactions: [] as Record<string, unknown>[] };
  eq(applyEvents(doc, [{ personId: "anna", date: "2026-10-24", subject: "x", messageId: "m" }]), 0);
});
