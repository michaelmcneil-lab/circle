// The rules for syncing Circle people with Google Contacts: how each detail maps
// between the two, and how changes are merged. No network or database here, so the
// rules can be tested on their own (google-sync.test.ts).
//
// Details are synced in groups that match Google's own fields. For each linked
// person we remember the value both sides last agreed on (the "snapshot"). On each
// run, per group: if only one side differs from the snapshot, that side changed and
// wins; if both changed, the more recent edit wins. A group with no snapshot yet
// (first sync) fills in blanks and combines phone, email and address lists, but never
// overwrites a value on either side: it becomes a conflict for the user to settle.

// deno-lint-ignore no-explicit-any
type Any = any;

// "addresses" replaced a single "address" group; a link's old "address" snapshot is
// simply ignored, so the first run after the change syncs addresses as a first sync.
export const GROUPS = ["name", "nickname", "org", "birthday", "addresses", "phones", "emails"] as const;
export type Group = typeof GROUPS[number];
export type Item = { label: string; value: string };
export type Values = {
  name: { first: string; last: string };
  nickname: string;
  org: { company: string; title: string };
  birthday: string; // "YYYY-MM-DD", or "MM-DD" when the year isn't known, or ""
  // Each value in Circle's format: street / "city, region postal" / country, one per line.
  // Labels are Home, Work, Other or the user's own ("Summer home").
  addresses: Item[];
  phones: Item[];
  emails: Item[];
};
export type Snapshot = Partial<Values>;
export type Conflict = { group: Group; circle: unknown; google: unknown };

// Google's fields for each group, as used in personFields and updatePersonFields.
export const GOOGLE_FIELD: Record<Group, string> = {
  name: "names", nickname: "nicknames", org: "organizations", birthday: "birthdays",
  addresses: "addresses", phones: "phoneNumbers", emails: "emailAddresses",
};
export const PERSON_FIELDS = [...Object.values(GOOGLE_FIELD), "photos", "metadata"].join(",");

const s = (v: unknown) => String(v ?? "").trim();
export const digits = (v: string) => v.replace(/\D/g, "").slice(-10);

// ---------- Circle ⇄ shared values ----------
export function fromCircle(p: Any): Values {
  return {
    name: { first: s(p.firstName), last: s(p.lastName) },
    nickname: s(p.nickname),
    org: { company: s(p.company), title: s(p.jobTitle) },
    birthday: s(p.birthday),
    // Data saved before addresses became a list has one "address" until a device updates it.
    addresses: (Array.isArray(p.addresses) ? p.addresses : p.address ? [{ label: "Home", value: p.address }] : [])
      .map((x: Any) => ({ label: s(x.label) || "Home", value: s(x.value).replace(/\r\n/g, "\n") })).filter((x: Item) => x.value),
    phones: (p.phones ?? []).map((x: Any) => ({ label: s(x.label) || "Mobile", value: s(x.value) })).filter((x: Item) => x.value),
    emails: (p.emails ?? []).map((x: Any) => ({ label: s(x.label) || "Personal", value: s(x.value) })).filter((x: Item) => x.value),
  };
}

// Writes the given groups onto a Circle person (in place).
export function applyToCircle(p: Any, v: Partial<Values>) {
  if (v.name) { p.firstName = v.name.first; p.lastName = v.name.last; p.name = [v.name.first, v.name.last].filter(Boolean).join(" ") || "Unnamed"; }
  if (v.nickname !== undefined) p.nickname = v.nickname;
  if (v.org) { p.company = v.org.company; p.jobTitle = v.org.title; }
  if (v.birthday !== undefined) p.birthday = v.birthday;
  if (v.addresses) { p.addresses = v.addresses.map((x) => ({ ...x })); delete p.address; }
  if (v.phones) p.phones = v.phones.map((x) => ({ ...x }));
  if (v.emails) p.emails = v.emails.map((x) => ({ ...x }));
}

// ---------- Google ⇄ shared values ----------
const PHONE_IN: Record<string, string> = { mobile: "Mobile", home: "Home", work: "Work" };
const PHONE_OUT: Record<string, string> = { Mobile: "mobile", Home: "home", Work: "work", Other: "other" };
const EMAIL_IN: Record<string, string> = { home: "Personal", work: "Work", other: "Other" };
const EMAIL_OUT: Record<string, string> = { Personal: "home", Work: "work", Other: "other" };
// Google keeps a label of the user's own as the type itself ("Summer home").
const ADDRESS_IN: Record<string, string> = { home: "Home", work: "Work", other: "Other" };
const ADDRESS_OUT: Record<string, string> = { Home: "home", Work: "work", Other: "other" };
const addressLabel = (type: unknown) => ADDRESS_IN[s(type).toLowerCase()] ?? (s(type) || "Other");
const flat = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();

// Google's entries that came from the contact itself (not from someone's own profile).
const own = (list: Any[] | undefined) => (list ?? []).filter((x) => !x.metadata?.source || x.metadata.source.type === "CONTACT");
const primary = (list: Any[] | undefined) => { const l = own(list); return l.find((x) => x.metadata?.primary) ?? l[0]; };

export function formatAddress(a: Any): string {
  if (!a) return "";
  const cityLine = [s(a.city), [s(a.region), s(a.postalCode)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  // Like Circle's contacts import, this leaves out the extended part (apartment, suite).
  const structured = [s(a.streetAddress), cityLine, s(a.country)].filter(Boolean).join("\n");
  return structured || s(a.formattedValue).replace(/\r\n/g, "\n");
}
// Circle's address text back into Google's parts, when it has the usual shape and
// reads back exactly the same; otherwise Google gets it as one piece of text.
export function parseAddress(text: string): Any {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const m = lines[1]?.match(/^([^,]+),\s*(.*?)\s*(\d{4,5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)?$/);
  if (lines.length >= 2 && lines.length <= 3 && m) {
    const parts = { streetAddress: lines[0], city: m[1].trim(), region: (m[2] ?? "").trim(), postalCode: (m[3] ?? "").trim(), country: lines[2] ?? "" };
    if (formatAddress(parts) === text) return parts;
  }
  return { formattedValue: text };
}

export function fromGoogle(g: Any): Values {
  const n = primary(g.names), o = primary(g.organizations), b = (g.birthdays ?? []).find((x: Any) => x.date) ;
  const d = b?.date;
  const pad = (x: number) => String(x).padStart(2, "0");
  return {
    // Circle has no middle name (its import keeps only the given name), so Google's is left alone.
    name: { first: s(n?.givenName), last: s(n?.familyName) },
    nickname: s(primary(g.nicknames)?.value),
    org: { company: s(o?.name), title: s(o?.title) },
    birthday: d?.month && d?.day ? (d.year ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : `${pad(d.month)}-${pad(d.day)}`) : "",
    addresses: own(g.addresses).map((x) => ({ label: addressLabel(x.type), value: formatAddress(x) })).filter((x) => x.value),
    phones: own(g.phoneNumbers).map((x) => ({ label: PHONE_IN[s(x.type).toLowerCase()] ?? "Other", value: s(x.value) })).filter((x) => x.value),
    emails: own(g.emailAddresses).map((x) => ({ label: EMAIL_IN[s(x.type).toLowerCase()] ?? "Personal", value: s(x.value) })).filter((x) => x.value),
  };
}

// The body for Google's updateContact: the person's current Google fields for the
// given groups, with Circle's values written in. What Circle doesn't model (a middle
// name, an apartment number, a phone's custom type) is preserved.
export function toGoogle(current: Any, v: Partial<Values>): { body: Any; fields: string[] } {
  const body: Any = { etag: current.etag };
  const fields: string[] = [];
  const set = (group: Group, value: Any) => { body[GOOGLE_FIELD[group]] = value; fields.push(GOOGLE_FIELD[group]); };
  const replaceFirst = (list: Any[] | undefined, entry: Any | null) => {
    const l = own(list);
    const i = l.findIndex((x) => x.metadata?.primary); const at = i < 0 ? 0 : i;
    const rest = l.filter((_, j) => j !== at).map(strip);
    return entry ? [entry, ...rest] : rest;
  };
  if (v.name) {
    const n = primary(current.names) ?? {};
    set("name", replaceFirst(current.names, v.name.first || v.name.last ? { ...strip(n), givenName: v.name.first, familyName: v.name.last } : null));
  }
  if (v.nickname !== undefined) set("nickname", replaceFirst(current.nicknames, v.nickname ? { ...strip(primary(current.nicknames) ?? {}), value: v.nickname } : null));
  if (v.org) {
    const o = primary(current.organizations) ?? {};
    set("org", replaceFirst(current.organizations, v.org.company || v.org.title ? { ...strip(o), name: v.org.company, title: v.org.title } : null));
  }
  if (v.birthday !== undefined) {
    const m = v.birthday.match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
    set("birthday", m ? [{ date: { ...(m[1] ? { year: +m[1] } : {}), month: +m[2], day: +m[3] } }] : []);
  }
  if (v.addresses) {
    const have = own(current.addresses);
    set("addresses", v.addresses.map((x, i) => {
      const type = ADDRESS_OUT[x.label] ?? x.label;
      // The same address as before keeps Google's own parts (an apartment number, its type spelling).
      const same = have.find((h) => flat(formatAddress(h)) === flat(x.value));
      if (same) return { ...strip(same), type: addressLabel(same.type) === x.label ? same.type : type };
      // A changed address in the same place in the list keeps the parts Circle doesn't hold,
      // when it's still made of parts; text Google can't split replaces it all.
      const parsed = parseAddress(x.value);
      if (parsed.formattedValue) return { type, ...parsed };
      const { formattedValue: _f, streetAddress: _s, city: _c, region: _r, postalCode: _p, country: _n, countryCode: _cc, type: _t, ...extra } = strip(have.at(i) ?? {});
      return { ...extra, type, ...parsed };
    }));
  }
  if (v.phones) {
    const have = own(current.phoneNumbers);
    set("phones", v.phones.map((x) => {
      const same = have.find((h) => digits(s(h.value)) === digits(x.value) && digits(x.value));
      // Keep Google's own type (e.g. "main") when Circle's label still means the same thing.
      const type = same && (PHONE_IN[s(same.type).toLowerCase()] ?? "Other") === x.label ? same.type : PHONE_OUT[x.label] ?? "other";
      return { value: x.value, type };
    }));
  }
  if (v.emails) {
    const have = own(current.emailAddresses);
    set("emails", v.emails.map((x) => {
      const same = have.find((h) => s(h.value).toLowerCase() === x.value.toLowerCase());
      const type = same && (EMAIL_IN[s(same.type).toLowerCase()] ?? "Personal") === x.label ? same.type : EMAIL_OUT[x.label] ?? "other";
      return { value: x.value, type };
    }));
  }
  return { body, fields };
}
// Google returns read-only parts (metadata, formatted types) that it won't take back.
function strip(x: Any) {
  const { metadata: _m, formattedType: _f, displayName: _d, displayNameLastFirst: _l, unstructuredName: _u, ...rest } = x ?? {};
  return rest;
}

// ---------- Photos ----------
// The contact's own photo in Google (not the grey letter placeholder), if any.
export function googlePhoto(g: Any): string | null {
  const list = (g.photos ?? []).filter((x: Any) => !x.default && x.url);
  return (list.find((x: Any) => x.metadata?.primary) ?? list[0])?.url ?? null;
}
// Circle's photo is { path, v }; v changes whenever it's replaced.
export const circlePhoto = (p: Any): number | null => p.photo?.v ?? null;

export type PhotoState = { circleV: number | null | undefined; googleUrl: string | null | undefined };
export type PhotoMove = "push" | "pull" | "remove_google" | "remove_circle" | null;
export function photoPlan(state: PhotoState, circleV: number | null, googleUrl: string | null, googleNewer: boolean): PhotoMove {
  const first = state.circleV === undefined && state.googleUrl === undefined;
  if (first) return circleV && !googleUrl ? "push" : googleUrl && !circleV ? "pull" : null;
  const cChanged = circleV !== state.circleV, gChanged = googleUrl !== state.googleUrl;
  if (!cChanged && !gChanged) return null;
  const useCircle = cChanged && (!gChanged || !googleNewer);
  if (useCircle) return circleV ? "push" : "remove_google";
  return googleUrl ? "pull" : "remove_circle";
}

// ---------- Merging ----------
export const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
const empty = (v: unknown) => v === "" || (Array.isArray(v) && !v.length) || (!!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => x === ""));

// Combines Circle's list (a) with Google's (b): phones match by digits, emails ignoring
// case. For one on both sides, Google's label wins: Google was where these came from,
// and a label differing is usually just how the export wrote it.
function union(a: Item[], b: Item[], key: (x: Item) => string): Item[] {
  const fromB = new Map(b.map((x) => [key(x), x]));
  const seen = new Set(a.map(key));
  return [...a.map((x) => fromB.has(key(x)) ? { ...x, label: fromB.get(key(x))!.label } : x), ...b.filter((x) => !seen.has(key(x)) && seen.add(key(x)))];
}
const sameList = (a: Item[], b: Item[], key: (x: Item) => string) =>
  a.length === b.length && a.every((x, i) => key(x) === key(b[i]) && x.label === b[i].label);
const KEY: Partial<Record<Group, (x: Item) => string>> = {
  phones: (x) => digits(x.value) || x.value, emails: (x) => x.value.toLowerCase(), addresses: (x) => flat(x.value),
};
// Circle's addresses came from a Google export, which can spell one a little differently
// (an apartment line, punctuation). On a first sync, an address whose street line appears
// in one of Google's counts as that one, so it isn't copied over as a second address.
const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const looselySame = (a: string, b: string) => {
  const street = (t: string) => words(t.split("\n")[0]);
  return !!street(a) && (words(b).includes(street(a)) || (!!street(b) && words(a).includes(street(b))));
};
function same(group: Group, a: unknown, b: unknown) {
  const key = KEY[group];
  return key ? sameList(a as Item[], b as Item[], key) : canon(a) === canon(b);
}

export type Plan = {
  toCircle: Partial<Values>; // groups to write into Circle
  toGoogle: Partial<Values>; // groups to write into Google
  snapshot: Snapshot; // what both sides agree on afterwards
  conflicts: Conflict[]; // first-sync differences for the user to settle
};
export function plan(snap: Snapshot, c: Values, g: Values, googleNewer: boolean): Plan {
  const out: Plan = { toCircle: {}, toGoogle: {}, snapshot: {}, conflicts: [] };
  const take = (group: Group, value: Any) => {
    if (!same(group, value, c[group])) (out.toCircle as Any)[group] = value;
    if (!same(group, value, g[group])) (out.toGoogle as Any)[group] = value;
    (out.snapshot as Any)[group] = value;
  };
  for (const group of GROUPS) {
    const cv = c[group], gv = g[group], sv = snap[group];
    if (same(group, cv, gv)) { take(group, cv); continue; }
    if (sv === undefined) {
      // First sync of this detail.
      if (empty(cv)) take(group, gv);
      else if (empty(gv)) take(group, cv);
      else if (group === "addresses" && (cv as Item[]).every((a) => (gv as Item[]).some((b) => looselySame(a.value, b.value)))) take(group, gv);
      else if (KEY[group]) {
        // Combined; when that adds nothing to Google's list, Google's list (and its order) stands.
        const key = KEY[group]!, both = union(cv as Item[], gv as Item[], key);
        take(group, both.length === (gv as Item[]).length ? gv : both);
      } else out.conflicts.push({ group, circle: cv, google: gv });
      continue;
    }
    const cChanged = !same(group, cv, sv), gChanged = !same(group, gv, sv);
    take(group, cChanged && (!gChanged || !googleNewer) ? cv : gv);
  }
  return out;
}

// Settling a conflict: pretend the other side's value was the last agreed one, so
// the chosen side counts as the change and wins on the next run.
export function settle(snap: Snapshot, group: Group, use: "circle" | "google", c: Values, g: Values): Snapshot {
  return { ...snap, [group]: use === "circle" ? g[group] : c[group] };
}

// ---------- Linking people to contacts ----------
// Matches each Circle person to a Google contact by email, then phone, then exact
// name, using only matches that point one way on both sides (no guessing).
export function matchPeople(people: Any[], contacts: Any[]): Map<string, string> {
  const result = new Map<string, string>(); // person id → resourceName
  const taken = new Set<string>();
  const keysOf = (v: Values) => ({
    email: v.emails.map((x) => x.value.toLowerCase()),
    phone: v.phones.map((x) => digits(x.value)).filter((d) => d.length >= 7),
    name: [`${v.name.first} ${v.name.last}`.trim().toLowerCase()].filter(Boolean),
  });
  const P = people.map((p) => ({ id: p.id, k: keysOf(fromCircle(p)) }));
  const G = contacts.map((g) => ({ id: g.resourceName as string, k: keysOf(fromGoogle(g)) }));
  for (const kind of ["email", "phone", "name"] as const) {
    const index = (list: { id: string; k: Any }[], skip: (id: string) => boolean) => {
      const m = new Map<string, Set<string>>();
      for (const x of list) if (!skip(x.id)) for (const key of x.k[kind]) { if (!m.has(key)) m.set(key, new Set()); m.get(key)!.add(x.id); }
      return m;
    };
    const pIndex = index(P, (id) => result.has(id)), gIndex = index(G, (id) => taken.has(id));
    for (const p of P) {
      if (result.has(p.id)) continue;
      const hits = new Set<string>();
      for (const key of p.k[kind]) for (const gid of gIndex.get(key) ?? []) if ((pIndex.get(key)?.size ?? 0) === 1) hits.add(gid);
      if (hits.size === 1) {
        const gid = [...hits][0];
        // The contact must point back only at this person too.
        const back = new Set<string>();
        for (const key of G.find((x) => x.id === gid)!.k[kind]) for (const pid of pIndex.get(key) ?? []) back.add(pid);
        if (back.size === 1) { result.set(p.id, gid); taken.add(gid); }
      }
    }
  }
  return result;
}

// The more recent edit time Google has for a contact.
export function googleUpdated(g: Any): number {
  const times = (g.metadata?.sources ?? []).filter((x: Any) => x.type === "CONTACT" && x.updateTime).map((x: Any) => Date.parse(x.updateTime));
  return times.length ? Math.max(...times) : 0;
}
