// Run: deno test supabase/functions/google-contacts/new-in-google.test.ts
import { baseline, newInGoogle, personFromGoogle } from "./new-in-google.ts";
import { fromCircle, fromGoogle } from "../_shared/google-sync.ts";
import type { Link } from "./sync.ts";

const eq = (a: unknown, b: unknown, msg = "") => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}\n  got:  ${x}\n  want: ${y}`); };

const NOW = Date.parse("2026-10-26T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 864e5).toISOString();
const contact = (rn: string, first: string, last: string, daysAgo: number, over = {}) =>
  ({ resourceName: rn, names: [{ givenName: first, familyName: last }], metadata: { sources: [{ type: "CONTACT", updateTime: ago(daysAgo) }] }, ...over });
const link = (personId: string, rn: string | null, status: Link["status"] = "linked"): Link =>
  ({ person_id: personId, resource_name: rn, status, etag: null, snapshot: {}, conflicts: [], photo_synced: false, circle_photo_v: null, google_photo_url: null });

const contacts = [
  contact("people/anna", "Anna", "Lee", 300),                       // linked to Circle
  contact("people/old", "Old", "Acquaintance", 400),               // left out of the import long ago
  contact("people/jim", "Jim", "", 0, { organizations: [{ name: "Cabinetree" }], phoneNumbers: [{ value: "555-0100", type: "mobile" }] }),
  contact("people/cara", "Cara", "Diaz", 1),                       // matches an unlinked Circle person
  contact("people/biz", "", "", 2, { organizations: [{ name: "Joe's Plumbing" }] }),
];
const people = [{ id: "a", firstName: "Anna", lastName: "Lee" }, { id: "c", firstName: "Cara", lastName: "Diaz", phones: [], emails: [] }];
const links = [link("a", "people/anna")];

Deno.test("the first time, only recent contacts are offered", () => {
  const seen = new Set(baseline(contacts, links, people, NOW));
  eq([...seen], ["people/old"]);
  eq(newInGoogle(contacts, links, people, seen).map((c) => c.name), ["Jim", "Joe's Plumbing"], "newest first; Cara is left to the sync");
  const jim = newInGoogle(contacts, links, people, seen)[0];
  eq([jim.company, jim.phone], ["Cabinetree", "555-0100"]);
});

Deno.test("seen and linked contacts aren't offered", () => {
  const seen = new Set(["people/old", "people/biz"]);
  eq(newInGoogle(contacts, [...links, link("j", "people/jim")], people, seen).map((c) => c.name), []);
});

Deno.test("a new person matches their contact field for field", () => {
  const p = personFromGoogle(contacts[2], "p1", "Work", "2026-10-26");
  eq([p.id, p.name, p.company, p.relationship, p.createdAt, p.phones], ["p1", "Jim", "Cabinetree", "Work", "2026-10-26", [{ label: "Mobile", value: "555-0100" }]]);
  eq(fromCircle(p), fromGoogle(contacts[2]), "so the next sync has nothing to change");
  eq(personFromGoogle(contacts[4], "p2", "Other", "2026-10-26").name, "Joe's Plumbing", "a business gets its company as the name");
});
