// Tests for the Google Contacts sync rules. Run: deno test supabase/functions/_shared/google-sync.test.ts
import {
  applyToCircle, canon, formatAddress, fromCircle, fromGoogle, matchPeople, parseAddress, photoPlan, plan, settle, toGoogle,
} from "./google-sync.ts";

const eq = (a: unknown, b: unknown, msg = "") => { if (canon(a) !== canon(b)) throw new Error(`${msg}\n  got:  ${canon(a)}\n  want: ${canon(b)}`); };

const circle = (over = {}) => ({
  id: "p1", firstName: "Anna", lastName: "Lee", name: "Anna Lee", nickname: "", company: "Acme", jobTitle: "",
  birthday: "05-04", addresses: [{ label: "Home", value: "1 Main St\nSeattle, WA 98101\nUSA" }],
  phones: [{ label: "Mobile", value: "(206) 555-0100" }], emails: [{ label: "Personal", value: "anna@example.com" }], notes: "private", ...over,
});
const google = (over = {}) => ({
  resourceName: "people/c1", etag: "e1",
  names: [{ metadata: { primary: true, source: { type: "CONTACT" } }, givenName: "Anna", familyName: "Lee", displayName: "Anna Lee" }],
  organizations: [{ metadata: { primary: true, source: { type: "CONTACT" } }, name: "Acme" }],
  birthdays: [{ date: { month: 5, day: 4 } }],
  addresses: [{ metadata: { primary: true, source: { type: "CONTACT" } }, type: "home", streetAddress: "1 Main St", city: "Seattle", region: "WA", postalCode: "98101", country: "USA", formattedValue: "1 Main St\nSeattle, WA 98101\nUSA" }],
  phoneNumbers: [{ metadata: { source: { type: "CONTACT" } }, value: "(206) 555-0100", type: "mobile" }],
  emailAddresses: [{ metadata: { source: { type: "CONTACT" } }, value: "anna@example.com", type: "home" }],
  ...over,
});

Deno.test("the same person reads the same from both sides", () => {
  eq(fromGoogle(google()), fromCircle(circle()));
});

Deno.test("addresses round-trip, and odd ones go as plain text", () => {
  for (const t of ["1 Main St\nSeattle, WA 98101\nUSA", "10 Rue X\nParis, 75001\nFrance", "Flat 2, 3 High St\nLondon\nUK", "Somewhere vague"]) {
    eq(formatAddress(parseAddress(t)), t, t);
  }
  eq(parseAddress("Somewhere vague"), { formattedValue: "Somewhere vague" });
});

Deno.test("first sync fills blanks both ways and combines lists", () => {
  const c = fromCircle(circle({ company: "", phones: [{ label: "Mobile", value: "206-555-0100" }, { label: "Work", value: "206 555 0199" }] }));
  const g = fromGoogle(google({ birthdays: [], phoneNumbers: [{ value: "(206) 555-0100", type: "mobile" }, { value: "425-555-0111", type: "home" }] }));
  const r = plan({}, c, g, true);
  eq(r.conflicts, []);
  eq(r.toCircle.org, { company: "Acme", title: "" }, "company comes from Google");
  eq(r.toGoogle.birthday, "05-04", "birthday goes to Google");
  eq(r.snapshot.phones?.map((x) => x.value), ["206-555-0100", "206 555 0199", "425-555-0111"], "phones combined, matched by digits");
  eq(Object.keys(r.toCircle).sort(), ["org", "phones"]);
  eq(Object.keys(r.toGoogle).sort(), ["birthday", "phones"]);
});

Deno.test("first sync never overwrites a different value", () => {
  const r = plan({}, fromCircle(circle({ company: "Acme Corp" })), fromGoogle(google()), true);
  eq(r.conflicts.map((x) => x.group), ["org"]);
  eq(r.toCircle.org, undefined); eq(r.toGoogle.org, undefined); eq(r.snapshot.org, undefined);
});

Deno.test("settling a conflict makes the chosen side win next time", () => {
  const c = fromCircle(circle({ company: "Acme Corp" })), g = fromGoogle(google());
  let snap = plan({}, c, g, true).snapshot;
  snap = settle(snap, "org", "circle", c, g);
  let r = plan(snap, c, g, true);
  eq(r.toGoogle.org, { company: "Acme Corp", title: "" }); eq(r.conflicts, []);
  snap = settle(plan({}, c, g, true).snapshot, "org", "google", c, g);
  r = plan(snap, c, g, false);
  eq(r.toCircle.org, { company: "Acme", title: "" });
});

Deno.test("after the first sync, whichever side changed wins", () => {
  const base = fromCircle(circle());
  const snap = plan({}, base, fromGoogle(google()), true).snapshot;
  // Changed in Circle only.
  let r = plan(snap, fromCircle(circle({ nickname: "Annie" })), fromGoogle(google()), true);
  eq(r.toGoogle, { nickname: "Annie" }); eq(r.toCircle, {});
  // Changed in Google only (even though Google is older).
  r = plan(snap, base, fromGoogle(google({ phoneNumbers: [{ value: "206-555-0177", type: "mobile" }] })), false);
  eq(r.toCircle, { phones: [{ label: "Mobile", value: "206-555-0177" }] }); eq(r.toGoogle, {});
  // Cleared in Circle: the blank goes to Google, not the other way round.
  r = plan(snap, fromCircle(circle({ birthday: "" })), fromGoogle(google()), true);
  eq(r.toGoogle, { birthday: "" });
});

Deno.test("both changed: the more recent edit wins", () => {
  const snap = plan({}, fromCircle(circle()), fromGoogle(google()), true).snapshot;
  const c = fromCircle(circle({ lastName: "Lee-Park" })), g = fromGoogle(google({ names: [{ givenName: "Anna", familyName: "Park" }] }));
  eq(plan(snap, c, g, true).toCircle.name, { first: "Anna", last: "Park" });
  eq(plan(snap, c, g, false).toGoogle.name, { first: "Anna", last: "Lee-Park" });
});

Deno.test("nothing changed means nothing to write", () => {
  const snap = plan({}, fromCircle(circle()), fromGoogle(google()), true).snapshot;
  const r = plan(snap, fromCircle(circle()), fromGoogle(google()), true);
  eq([r.toCircle, r.toGoogle, r.conflicts], [{}, {}, []]);
});

Deno.test("writing to Google keeps what Circle doesn't manage", () => {
  const g = google({
    names: [{ metadata: { primary: true, source: { type: "CONTACT" } }, givenName: "Anna", middleName: "Marie", familyName: "Lee", honorificPrefix: "Dr." }],
    addresses: [
      { metadata: { primary: true, source: { type: "CONTACT" } }, type: "home", streetAddress: "1 Main St", city: "Seattle", region: "WA", postalCode: "98101", country: "USA" },
      { metadata: { source: { type: "CONTACT" } }, type: "work", formattedValue: "Office" },
    ],
    phoneNumbers: [{ value: "206-555-0100", type: "main" }],
  });
  // Changing the last name keeps Google's middle name and title.
  eq(fromGoogle(g).name, { first: "Anna", last: "Lee" });
  const { body, fields } = toGoogle(g, {
    name: { first: "Anna", last: "Lee-Park" },
    addresses: [{ label: "Home", value: "9 Elm St\nTacoma, WA 98402\nUSA" }, { label: "Work", value: "Office" }],
    phones: [{ label: "Other", value: "206-555-0100" }],
  });
  eq(fields, ["names", "addresses", "phoneNumbers"]);
  eq(body.etag, "e1");
  eq(body.names, [{ givenName: "Anna", middleName: "Marie", familyName: "Lee-Park", honorificPrefix: "Dr." }]);
  eq(body.addresses, [{ type: "home", streetAddress: "9 Elm St", city: "Tacoma", region: "WA", postalCode: "98402", country: "USA" }, { type: "work", formattedValue: "Office" }]);
  eq(body.phoneNumbers, [{ value: "206-555-0100", type: "main" }], "Google's own phone type is kept when it still means the same");
  const after = { ...g, ...body };
  eq(fromGoogle(after).name, { first: "Anna", last: "Lee-Park" });
  // An apartment number Circle doesn't hold survives a change of street.
  const apt = google({ addresses: [{ metadata: { primary: true }, type: "home", streetAddress: "1 Main St", extendedAddress: "Apt 4", city: "Seattle", region: "WA", postalCode: "98101", country: "USA" }] });
  eq(fromGoogle(apt).addresses, [{ label: "Home", value: "1 Main St\nSeattle, WA 98101\nUSA" }]);
  eq(toGoogle(apt, { addresses: [{ label: "Home", value: "2 Main St\nSeattle, WA 98101\nUSA" }] }).body.addresses[0].extendedAddress, "Apt 4");
});

Deno.test("several addresses, with labels of the user's own, go both ways", () => {
  const g = google({ addresses: [
    { type: "home", streetAddress: "1 Main St", city: "Seattle", region: "WA", postalCode: "98101", country: "USA" },
    { type: "Summer home", formattedValue: "Cabin on Lake Chelan" },
  ] });
  eq(fromGoogle(g).addresses, [{ label: "Home", value: "1 Main St\nSeattle, WA 98101\nUSA" }, { label: "Summer home", value: "Cabin on Lake Chelan" }]);
  const { body } = toGoogle(g, { addresses: [
    { label: "Summer home", value: "Cabin on Lake Chelan" },
    { label: "Ski place", value: "4 Pine Rd\nLeavenworth, WA 98826" },
  ] });
  eq(body.addresses, [
    { type: "Summer home", formattedValue: "Cabin on Lake Chelan" },
    { type: "Ski place", streetAddress: "4 Pine Rd", city: "Leavenworth", region: "WA", postalCode: "98826", country: "" },
  ], "the home address is gone, the summer home kept as it was, the ski place added");
  eq(fromGoogle({ ...g, ...body }).addresses.map((x) => x.label), ["Summer home", "Ski place"]);
});

Deno.test("first sync of addresses: Google's extra addresses come in, without doubling the one Circle already has", () => {
  // Circle's one address (from the old single field) is Google's first, written slightly differently.
  const c = fromCircle({ ...circle(), addresses: undefined, address: "1 Main St.\nSeattle, WA 98101\nUSA" });
  eq(c.addresses, [{ label: "Home", value: "1 Main St.\nSeattle, WA 98101\nUSA" }], "old single address read as a list");
  const g = fromGoogle(google({ addresses: [
    { type: "home", streetAddress: "1 Main St", city: "Seattle", region: "WA", postalCode: "98101", country: "USA" },
    { type: "Summer home", formattedValue: "Cabin on Lake Chelan" },
  ] }));
  const r = plan({}, c, g, false);
  eq(r.toCircle.addresses, g.addresses);
  eq([r.toGoogle.addresses, r.conflicts], [undefined, []]);
  // An address only Circle has is added to Google's list, and nothing is lost.
  const r2 = plan({}, fromCircle(circle({ addresses: [{ label: "Home", value: "77 Other Rd\nBoise, ID 83702" }] })), g, false);
  eq(r2.snapshot.addresses?.map((x) => x.label), ["Home", "Home", "Summer home"]);
});

Deno.test("an old link's single-address snapshot is ignored, so addresses sync as a first sync", () => {
  const old = { address: "1 Main St\nSeattle, WA 98101\nUSA" } as Record<string, unknown>;
  const r = plan(old, fromCircle(circle()), fromGoogle(google()), true);
  eq([r.toCircle, r.toGoogle, Object.keys(r.snapshot).includes("address")], [{}, {}, false]);
});

Deno.test("applying addresses to Circle replaces the old single field", () => {
  const p: Record<string, unknown> = { ...circle(), addresses: undefined, address: "old" };
  applyToCircle(p, { addresses: [{ label: "Home", value: "new" }] });
  eq([p.addresses, "address" in p], [[{ label: "Home", value: "new" }], false]);
});

Deno.test("first sync of the same phone with different labels keeps Google's label, so Google isn't rewritten", () => {
  const c = fromCircle(circle({ emails: [{ label: "Personal", value: "Anna@Example.com" }] }));
  const g = fromGoogle(google({ emailAddresses: [{ value: "anna@example.com", type: "other" }] }));
  const r = plan({}, c, g, true);
  eq(r.toGoogle.emails, undefined);
  eq(r.toCircle.emails, [{ label: "Other", value: "anna@example.com" }], "Google's version stands");
});

Deno.test("applying to Circle updates the full name and leaves other things alone", () => {
  const p = circle();
  applyToCircle(p, { name: { first: "Ann", last: "Lee" }, phones: [] });
  eq([p.firstName, p.name, p.phones, p.notes, p.company], ["Ann", "Ann Lee", [], "private", "Acme"]);
});

Deno.test("photos: whichever side changed, with removals", () => {
  eq(photoPlan({ circleV: undefined, googleUrl: undefined }, 5, null, true), "push", "first sync, only Circle has one");
  eq(photoPlan({ circleV: undefined, googleUrl: undefined }, null, "u1", true), "pull");
  eq(photoPlan({ circleV: undefined, googleUrl: undefined }, 5, "u1", true), null, "both have one: keep both");
  const st = { circleV: 5, googleUrl: "u1" };
  eq(photoPlan(st, 5, "u1", true), null);
  eq(photoPlan(st, 6, "u1", true), "push");
  eq(photoPlan(st, 5, "u2", false), "pull");
  eq(photoPlan(st, null, "u1", true), "remove_google");
  eq(photoPlan(st, 5, null, true), "remove_circle");
  eq(photoPlan(st, 6, "u2", true), "pull", "both changed, Google newer");
  eq(photoPlan(st, 6, "u2", false), "push", "both changed, Circle newer");
});

Deno.test("matching links only clear one-to-one matches", () => {
  const people = [
    circle({ id: "a" }),
    circle({ id: "b", firstName: "Ben", lastName: "Ng", emails: [], phones: [{ label: "Work", value: "206-555-0999" }] }),
    circle({ id: "c", firstName: "Cara", lastName: "Diaz", emails: [], phones: [] }),
    // Two Circle people share an office number: neither links by it.
    circle({ id: "d", firstName: "Dev", lastName: "One", emails: [], phones: [{ label: "Work", value: "206-555-7000" }] }),
    circle({ id: "e", firstName: "Eve", lastName: "Two", emails: [], phones: [{ label: "Work", value: "206-555-7000" }] }),
  ];
  const contacts = [
    google({ resourceName: "people/x1", names: [{ givenName: "Anna", familyName: "L." }] }), // same email as a
    google({ resourceName: "people/x2", names: [{ givenName: "Benjamin", familyName: "Ng" }], emailAddresses: [], phoneNumbers: [{ value: "+1 206 555 0999" }] }),
    google({ resourceName: "people/x3", names: [{ givenName: "Cara", familyName: "Diaz" }], emailAddresses: [], phoneNumbers: [] }),
    google({ resourceName: "people/x4", names: [{ givenName: "Office", familyName: "" }], emailAddresses: [], phoneNumbers: [{ value: "206-555-7000" }] }),
  ];
  const m = matchPeople(people, contacts);
  eq(Object.fromEntries(m), { a: "people/x1", b: "people/x2", c: "people/x3" });
});
