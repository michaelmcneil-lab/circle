// "New in Google": contacts added to Google that aren't in Circle yet, offered one by
// one to add (Circle stays a list of people you chose). No network or database here,
// so it can be tested on its own (new-in-google.test.ts).
//
// A contact is offered when it isn't linked to anyone in Circle, wouldn't be matched to
// someone in Circle by the sync, and hasn't been seen before. "Seen" starts as every
// such contact last changed more than BASELINE_DAYS ago, when the list is first opened,
// so the Gmail contacts left out of the original import don't all show up as new;
// adding a contact or choosing "Not now" also marks it seen.

import * as R from "../_shared/google-sync.ts";
import type { Link } from "./sync.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export const BASELINE_DAYS = 7;

const unlinked = (contacts: Any[], links: Link[], people: Any[]) => {
  const taken = new Set(links.map((l) => l.resource_name).filter(Boolean));
  const free = contacts.filter((g) => !taken.has(g.resourceName));
  // Someone already in Circle who isn't linked yet will be matched by the sync instead.
  const linkedPeople = new Set(links.map((l) => l.person_id));
  const matched = new Set(R.matchPeople(people.filter((p) => !linkedPeople.has(p.id)), free).values());
  return free.filter((g) => !matched.has(g.resourceName));
};

// The contacts to treat as already seen the first time the list is opened.
export function baseline(contacts: Any[], links: Link[], people: Any[], now: number): string[] {
  const cutoff = now - BASELINE_DAYS * 864e5;
  return unlinked(contacts, links, people).filter((g) => R.googleUpdated(g) < cutoff).map((g) => g.resourceName);
}

export type Candidate = { resourceName: string; name: string; company: string; phone: string; email: string; updated: string };
export function newInGoogle(contacts: Any[], links: Link[], people: Any[], seen: Set<string>): Candidate[] {
  return unlinked(contacts, links, people)
    .filter((g) => !seen.has(g.resourceName))
    .map((g) => {
      const v = R.fromGoogle(g);
      const name = [v.name.first, v.name.last].filter(Boolean).join(" ") || v.org.company || v.phones[0]?.value || v.emails[0]?.value || "";
      return { g, c: { resourceName: g.resourceName, name, company: v.org.company, phone: v.phones[0]?.value ?? "", email: v.emails[0]?.value ?? "", updated: new Date(R.googleUpdated(g) || 0).toISOString() } };
    })
    .filter((x) => x.c.name)
    .sort((a, b) => R.googleUpdated(b.g) - R.googleUpdated(a.g))
    .map((x) => x.c);
}

// A new Circle person made from a Google contact, in the shape Circle's app expects.
export function personFromGoogle(g: Any, id: string, relationship: string, today: string): Any {
  const p: Any = {
    id, relationship, createdAt: today, source: "google", firstName: "", lastName: "", name: "", nickname: "", company: "", jobTitle: "", birthday: "",
    phones: [], emails: [], addresses: [], links: [], interests: [], tags: [], events: [], familyMembers: [], notes: "", contactEvery: 0,
  };
  const v = R.fromGoogle(g);
  // A contact with only a company (a business) gets the company as its name, as Circle's import does.
  if (!v.name.first && !v.name.last) v.name.first = v.org.company || v.phones[0]?.value || v.emails[0]?.value || "Unnamed";
  R.applyToCircle(p, v);
  return p;
}
