// Whole sync runs against stand-ins for Supabase and Google.
// Run: deno test supabase/functions/google-contacts/sync.test.ts
import { type Google, type Link, runSync, type Store } from "./sync.ts";
import { canon, fromGoogle } from "../_shared/google-sync.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const eq = (a: unknown, b: unknown, msg = "") => { if (canon(a) !== canon(b)) throw new Error(`${msg}\n  got:  ${canon(a)}\n  want: ${canon(b)}`); };

function memoryStore(people: Any[]) {
  const s = {
    doc: { people, interactions: [], followUps: [], relations: [] } as Any, rev: 1, updatedAt: Date.now() - 60_000,
    links: new Map<string, Link>(), photos: new Map<string, Uint8Array>(), saves: 0,
    raceNextSave: false,
  };
  const store: Store = {
    userId: "u1",
    loadDoc: () => Promise.resolve({ doc: structuredClone(s.doc), rev: s.rev, updatedAt: s.updatedAt }),
    saveDoc: (doc, rev) => {
      if (s.raceNextSave) { s.raceNextSave = false; s.rev++; return Promise.resolve(false); }
      if (rev !== s.rev) return Promise.resolve(false);
      s.doc = structuredClone(doc); s.rev++; s.saves++; s.updatedAt = Date.now();
      return Promise.resolve(true);
    },
    links: () => Promise.resolve([...s.links.values()].map((l) => structuredClone(l))),
    saveLink: (l) => { s.links.set(l.person_id, structuredClone(l)); return Promise.resolve(); },
    removeLink: (id) => { s.links.delete(id); return Promise.resolve(); },
    photoGet: (path) => Promise.resolve(s.photos.get(path) ?? null),
    photoPut: (path, bytes) => { s.photos.set(path, bytes); return Promise.resolve(); },
    photoRemove: (path) => { s.photos.delete(path); return Promise.resolve(); },
  };
  return { s, store };
}

function fakeGoogle(contacts: Any[]) {
  const all = new Map(contacts.map((c) => [c.resourceName, { etag: "e0", metadata: { sources: [{ type: "CONTACT", updateTime: new Date(Date.now() - 3600_000).toISOString() }] }, ...c }]));
  let n = 0, created = 0;
  const log: string[] = [];
  const touch = (c: Any) => { c.etag = `e${++n}`; c.metadata = { sources: [{ type: "CONTACT", updateTime: new Date().toISOString() }] }; return structuredClone(c); };
  const api: Google = {
    list: () => Promise.resolve([...all.values()].map((c) => structuredClone(c))),
    get: (rn) => Promise.resolve(structuredClone(all.get(rn))),
    create: (body) => { const rn = `people/new${++created}`; const c = { resourceName: rn, ...body }; all.set(rn, c); log.push(`create ${rn}`); return Promise.resolve(touch(c)); },
    update: (rn, body, fields) => {
      const c = all.get(rn);
      if (body.etag !== c.etag) return Promise.reject(new Error("etag mismatch"));
      for (const f of fields) c[f] = body[f];
      log.push(`update ${rn} ${fields.join(",")}`);
      return Promise.resolve(touch(c));
    },
    setPhoto: (rn) => { const c = all.get(rn); c.photos = [{ url: `https://photo/${rn}/${n + 1}`, metadata: { primary: true } }]; log.push(`photo ${rn}`); return Promise.resolve(touch(c)); },
    removePhoto: (rn) => { const c = all.get(rn); c.photos = [{ url: "https://placeholder", default: true }]; log.push(`unphoto ${rn}`); return Promise.resolve(touch(c)); },
    remove: (rn) => { all.delete(rn); return Promise.resolve(); },
    fetchPhoto: (url) => Promise.resolve({ bytes: new TextEncoder().encode(url), type: "image/jpeg" }),
  };
  return { all, api, log, edit: (rn: string, f: (c: Any) => void) => { const c = all.get(rn); f(c); touch(c); } };
}

const person = (id: string, first: string, last: string, over = {}) => ({
  id, firstName: first, lastName: last, name: `${first} ${last}`, nickname: "", company: "", jobTitle: "", birthday: "", address: "",
  phones: [], emails: [], notes: "", ...over,
});
const contact = (rn: string, first: string, last: string, over = {}) => ({ resourceName: rn, names: [{ givenName: first, familyName: last }], ...over });

function setup() {
  const { s, store } = memoryStore([
    person("a", "Anna", "Lee", { emails: [{ label: "Personal", value: "anna@example.com" }], company: "Acme" }),
    person("b", "Ben", "Ng", { phones: [{ label: "Mobile", value: "206-555-0100" }], photo: { path: "u1/b.jpg", v: 111 } }),
    person("c", "Cara", "Diaz", { birthday: "1980-02-03" }), // not in Google
  ]);
  s.photos.set("u1/b.jpg", new Uint8Array([1, 2, 3]));
  const g = fakeGoogle([
    contact("people/1", "Anna", "Lee", { emailAddresses: [{ value: "anna@example.com", type: "home" }], organizations: [{ name: "Acme Corp" }], birthdays: [{ date: { month: 7, day: 9 } }] }),
    contact("people/2", "Ben", "Ng", { phoneNumbers: [{ value: "(206) 555-0100", type: "mobile" }, { value: "425-555-0111", type: "work" }], photos: [{ url: "https://placeholder", default: true }] }),
    contact("people/3", "Zed", "Only-in-Google"),
  ]);
  return { s, store, g };
}

Deno.test("preview reports everything and changes nothing", async () => {
  const { s, store, g } = setup();
  const r = await runSync(store, g.api, { apply: false });
  eq(r.linked, 2);
  const a = r.changes.find((c) => c.personId === "a")!;
  eq(a.conflicts, [{ group: "org", circle: "Acme", google: "Acme Corp" }]);
  eq(a.toCircle, { Birthday: "07-09" });
  const b = r.changes.find((c) => c.personId === "b")!;
  eq(b.toCircle, { Phones: "206-555-0100 (Mobile), 425-555-0111 (Work)" });
  eq(b.photo, "Circle's photo → Google");
  eq(r.changes.find((c) => c.personId === "c")!.create, true);
  eq([g.log, s.saves, s.links.size], [[], 0, 0], "nothing written");
});

Deno.test("one-person test touches only that person", async () => {
  const { s, store, g } = setup();
  const r = await runSync(store, g.api, { apply: true, personIds: ["b"] });
  eq(r.changes.map((c) => c.personId), ["b"]);
  eq(g.log, ["photo people/2"]);
  eq(s.doc.people.find((p: Any) => p.id === "b").phones.length, 2, "Ben's work phone came from Google");
  eq(s.doc.people.find((p: Any) => p.id === "a").birthday, "", "Anna untouched");
  eq([...s.links.keys()], ["b"]);
  // Running again finds nothing more to do.
  const again = await runSync(store, g.api, { apply: true, personIds: ["b"] });
  eq([again.changes, g.log.length, s.saves], [[], 1, 1]);
});

Deno.test("everyone: links, creates, conflicts, then two-way edits", async () => {
  const { s, store, g } = setup();
  let r = await runSync(store, g.api, { apply: true });
  eq(g.log, ["photo people/2", "create people/new1"]);
  eq(fromGoogle(g.all.get("people/new1")).birthday, "1980-02-03", "Cara created in Google with her birthday");
  eq(s.links.get("a")!.conflicts.map((c) => c.group), ["org"], "Anna's company waits for a decision");
  eq(r.flags, []);
  eq(s.doc.people.find((p: Any) => p.id === "c").firstName, "Cara");

  // Quiet run: nothing to do.
  g.log.length = 0;
  r = await runSync(store, g.api, { apply: true });
  eq([g.log, r.changes.map((c) => c.personId)], [[], ["a"]], "only Anna's open conflict is reported");

  // Edit in Google → reaches Circle.
  g.edit("people/2", (c) => c.phoneNumbers = [{ value: "206-555-0177", type: "mobile" }]);
  await runSync(store, g.api, { apply: true });
  eq(s.doc.people.find((p: Any) => p.id === "b").phones, [{ label: "Mobile", value: "206-555-0177" }]);
  eq(g.log, []);

  // Edit in Circle → reaches Google, keeping what Circle doesn't manage.
  s.doc.people.find((p: Any) => p.id === "c").nickname = "CeCe"; s.rev++; s.updatedAt = Date.now();
  await runSync(store, g.api, { apply: true });
  eq(g.log, ["update people/new1 nicknames"]);
  eq(fromGoogle(g.all.get("people/new1")).nickname, "CeCe");

  // A new photo in Google reaches Circle.
  g.edit("people/2", (c) => c.photos = [{ url: "https://photo/ben-new", metadata: { primary: true } }]);
  await runSync(store, g.api, { apply: true });
  const ben = s.doc.people.find((p: Any) => p.id === "b");
  eq(new TextDecoder().decode(s.photos.get(ben.photo.path)), "https://photo/ben-new");
  g.log.length = 0;
  eq((await runSync(store, g.api, { apply: true })).changes.map((c) => c.personId), ["a"]);
  eq(g.log, [], "the pulled photo isn't sent back");
});

Deno.test("deletes are flagged, never copied", async () => {
  const { s, store, g } = setup();
  await runSync(store, g.api, { apply: true });
  g.all.delete("people/1");
  s.doc.people = s.doc.people.filter((p: Any) => p.id !== "b"); s.rev++;
  g.log.length = 0;
  const r = await runSync(store, g.api, { apply: true });
  eq(r.flags.map((f) => `${f.personId}:${f.kind}`).sort(), ["a:google_deleted", "b:circle_deleted"]);
  eq(g.log, [], "nothing deleted or re-created in Google");
  eq(g.all.has("people/2"), true);
  eq(s.doc.people.some((p: Any) => p.id === "a"), true, "Anna stays in Circle");
});

Deno.test("someone marked don't-sync is left alone on both sides", async () => {
  const { s, store, g } = setup();
  await store.saveLink({ person_id: "c", resource_name: null, status: "excluded", etag: null, snapshot: {}, conflicts: [], photo_synced: false, circle_photo_v: null, google_photo_url: null });
  const r = await runSync(store, g.api, { apply: true });
  eq(g.log.some((x) => x.startsWith("create")), false, "Cara isn't created in Google");
  eq([r.changes.some((c) => c.personId === "c"), r.flags], [false, []]);
  eq(s.links.get("c")!.status, "excluded");
});

Deno.test("a save from a device mid-run stops before touching Google", async () => {
  const { s, store, g } = setup();
  s.raceNextSave = true;
  const r = await runSync(store, g.api, { apply: true });
  eq([r.busy, g.log, s.links.size], [true, [], 0]);
  const again = await runSync(store, g.api, { apply: true });
  eq(again.busy, undefined); eq(g.log.length, 2);
});

Deno.test("new contacts go a few at a time", async () => {
  const people = Array.from({ length: 25 }, (_, i) => person(`p${i}`, `P${i}`, "X"));
  const { store } = memoryStore(people);
  const g = fakeGoogle([]);
  let r = await runSync(store, g.api, { apply: true });
  eq([g.log.length, r.waiting], [10, 15]);
  r = await runSync(store, g.api, { apply: true });
  r = await runSync(store, g.api, { apply: true });
  eq([g.log.length, r.waiting], [25, 0]);
  r = await runSync(store, g.api, { apply: true });
  eq(g.log.length, 25, "and never twice");
});
