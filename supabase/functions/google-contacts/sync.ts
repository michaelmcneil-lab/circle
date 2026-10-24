// One sync run between Circle and Google Contacts. The storage (Supabase) and Google's
// API come in as small interfaces, so a whole run can be tested with stand-ins
// (sync.test.ts). The rules for each detail live in ../_shared/google-sync.ts.
//
// Order matters: Circle's copy is saved first (only if nobody else saved in between);
// then Google is updated person by person, and each person's agreed values are saved
// right after their Google update succeeds. If anything stops halfway, the next run
// sees the same differences again and finishes the job, without undoing anything.

import * as R from "../_shared/google-sync.ts";
import type { Doc } from "../_shared/circle.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type Link = {
  person_id: string;
  resource_name: string | null; // null when excluded before ever being linked
  // excluded: the user chose to keep this person out of Google.
  status: "linked" | "google_deleted" | "circle_deleted" | "excluded";
  etag: string | null;
  snapshot: R.Snapshot;
  conflicts: R.Conflict[];
  photo_synced: boolean;
  circle_photo_v: number | null;
  google_photo_url: string | null;
};

export interface Store {
  userId: string;
  loadDoc(): Promise<{ doc: Doc; rev: number; updatedAt: number } | null>;
  saveDoc(doc: Doc, rev: number): Promise<boolean>; // false: someone else saved first
  links(): Promise<Link[]>;
  saveLink(link: Link): Promise<void>;
  removeLink(personId: string): Promise<void>;
  photoGet(path: string): Promise<Uint8Array | null>;
  photoPut(path: string, bytes: Uint8Array, type: string): Promise<void>;
  photoRemove(path: string): Promise<void>;
}

export interface Google {
  list(): Promise<Any[]>;
  get(resourceName: string): Promise<Any>;
  create(body: Any): Promise<Any>;
  update(resourceName: string, body: Any, fields: string[]): Promise<Any>;
  setPhoto(resourceName: string, base64: string): Promise<Any>;
  removePhoto(resourceName: string): Promise<Any>;
  remove(resourceName: string): Promise<void>;
  fetchPhoto(url: string): Promise<{ bytes: Uint8Array; type: string }>;
}

export type Options = {
  apply: boolean; // false: only report what would change
  personIds?: string[]; // limit the run to these people (the one-person test)
  maxWrites?: number; // Google updates per run; the rest wait for the next run
  maxCreates?: number; // new Google contacts per run
  maxPhotoPulls?: number; // photos copied from Google per run
};

export type Change = {
  personId: string;
  name: string;
  create?: boolean;
  toCircle: Record<string, string>;
  toGoogle: Record<string, string>;
  photo?: string;
  conflicts: { group: R.Group; circle: string; google: string }[];
  error?: string;
};
export type Result = {
  changes: Change[]; // people with something to change (or a conflict)
  linked: number; // people linked to a Google contact
  flags: { personId: string; name: string; kind: "google_deleted" | "circle_deleted" }[];
  waiting: number; // changes left for the next run (over maxWrites)
  busy?: boolean; // Circle was saved from a device mid-run; nothing written, try again
};

const LABEL: Record<R.Group, string> = { name: "Name", nickname: "Nickname", org: "Company / job", birthday: "Birthday", addresses: "Addresses", phones: "Phones", emails: "Emails" };
export function show(group: R.Group, v: Any): string {
  if (v === undefined || v === null) return "";
  if (group === "name") return [v.first, v.last].filter(Boolean).join(" ");
  if (group === "org") return [v.company, v.title].filter(Boolean).join(" · ");
  if (group === "phones" || group === "emails") return (v as R.Item[]).map((x) => `${x.value} (${x.label})`).join(", ");
  if (group === "addresses") return (v as R.Item[]).map((x) => `${x.value.replace(/\n/g, ", ")} (${x.label})`).join("; ");
  return String(v).replace(/\n/g, ", ");
}
const describe = (vals: Partial<R.Values>) =>
  Object.fromEntries(Object.entries(vals).map(([g, v]) => [LABEL[g as R.Group], show(g as R.Group, v) || "(blank)"]));
const PHOTO_TEXT: Record<string, string> = { push: "Circle's photo → Google", pull: "Google's photo → Circle", remove_google: "Remove the photo in Google", remove_circle: "Remove the photo in Circle" };

const photoPath = (userId: string, personId: string) => `${userId}/${personId}.jpg`;
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

type Work = {
  p: Any; link: Link | null; g: Any | null; create: boolean;
  plan: R.Plan; photo: R.PhotoMove;
  photoLater?: boolean; // a photo from Google that waits for a later run
};

export async function runSync(store: Store, google: Google, opt: Options): Promise<Result> {
  const loaded = await store.loadDoc();
  if (!loaded) return { changes: [], linked: 0, flags: [], waiting: 0 };
  const { doc, rev, updatedAt } = loaded;
  const contacts = await google.list();
  const byName = new Map(contacts.map((g) => [g.resourceName as string, g]));
  const links = await store.links();
  const linkOf = new Map(links.map((l) => [l.person_id, l]));
  const people = doc.people ?? [];
  const inScope = (id: string) => !opt.personIds || opt.personIds.includes(id);

  // Deleted on one side: flag it, never delete the other side automatically.
  const flags: Result["flags"] = [];
  const personById = new Map(people.map((p: Any) => [p.id, p]));
  for (const l of links) {
    if (l.status === "excluded") continue;
    const status = !personById.has(l.person_id) ? "circle_deleted" : !byName.has(l.resource_name!) ? "google_deleted" : "linked";
    // A flag clears itself if the person or contact comes back (e.g. restored from trash).
    if (status === l.status || (l.status !== "linked" && status !== "linked")) continue;
    l.status = status;
    if (opt.apply) await store.saveLink(l);
  }
  for (const l of links) {
    if (l.status === "google_deleted" || l.status === "circle_deleted") {
      flags.push({ personId: l.person_id, name: personById.get(l.person_id)?.name ?? byName.get(l.resource_name!)?.names?.[0]?.displayName ?? "Someone", kind: l.status });
    }
  }

  // New links: people in Circle not yet linked, matched to contacts not yet linked.
  const takenContacts = new Set(links.map((l) => l.resource_name).filter(Boolean));
  const unlinked = people.filter((p: Any) => !linkOf.has(p.id) && inScope(p.id));
  const matches = R.matchPeople(unlinked, contacts.filter((g) => !takenContacts.has(g.resourceName)));

  const work: Work[] = [];
  for (const p of people) {
    if (!inScope(p.id)) continue;
    const link = linkOf.get(p.id) ?? null;
    if (link && link.status !== "linked") continue;
    const rn = link?.resource_name ?? matches.get(p.id);
    const g = rn ? byName.get(rn) ?? null : null;
    const c = R.fromCircle(p);
    if (!g) {
      // Not in Google yet: it will be created there with everything Circle has.
      const empty: R.Values = { name: { first: "", last: "" }, nickname: "", org: { company: "", title: "" }, birthday: "", addresses: [], phones: [], emails: [] };
      work.push({ p, link: null, g: null, create: true, plan: R.plan({}, c, empty, false), photo: R.circlePhoto(p) ? "push" : null });
      continue;
    }
    const newer = R.googleUpdated(g) > updatedAt;
    const plan = R.plan(link?.snapshot ?? {}, c, R.fromGoogle(g), newer);
    const state = link?.photo_synced ? { circleV: link.circle_photo_v, googleUrl: link.google_photo_url } : { circleV: undefined, googleUrl: undefined };
    const photo = R.photoPlan(state, R.circlePhoto(p), R.googlePhoto(g), newer);
    work.push({ p, link: link ?? { person_id: p.id, resource_name: rn!, status: "linked", etag: g.etag ?? null, snapshot: {}, conflicts: [], photo_synced: false, circle_photo_v: null, google_photo_url: null }, g, create: false, plan, photo });
  }

  const changed = (w: Work) => w.create || Object.keys(w.plan.toCircle).length || Object.keys(w.plan.toGoogle).length || w.photo || w.plan.conflicts.length;
  const changes: Change[] = work.filter(changed).map((w) => ({
    personId: w.p.id, name: w.p.name, create: w.create || undefined,
    toCircle: describe(w.plan.toCircle), toGoogle: w.create ? describe(R.fromCircle(w.p)) : describe(w.plan.toGoogle),
    photo: w.photo ? PHOTO_TEXT[w.photo] : undefined,
    conflicts: w.plan.conflicts.map((x) => ({ group: x.group, circle: show(x.group, x.circle), google: show(x.group, x.google) })),
  }));
  const linked = work.filter((w) => !w.create).length;
  if (!opt.apply) return { changes, linked, flags, waiting: 0 };

  // 1. Circle's side, saved in one go. Photos from Google come a batch per run (each is
  // a download and an upload), and one that fails is left for a later run: neither
  // may stop everyone else's changes from being saved.
  let circleChanged = false, pulls = 0, waiting = 0;
  const maxPulls = opt.maxPhotoPulls ?? 20;
  for (const w of work) {
    if (Object.keys(w.plan.toCircle).length) { R.applyToCircle(w.p, w.plan.toCircle); circleChanged = true; }
    if (w.photo === "pull") {
      if (pulls >= maxPulls) { w.photoLater = true; waiting++; continue; }
      try {
        const { bytes, type } = await google.fetchPhoto(R.googlePhoto(w.g)!);
        const path = photoPath(store.userId, w.p.id);
        await store.photoPut(path, bytes, type);
        w.p.photo = { path, v: Date.now() };
        circleChanged = true;
        pulls++;
      } catch (err) {
        w.photoLater = true;
        const change = changes.find((c) => c.personId === w.p.id);
        if (change) change.error = `Photo not copied from Google: ${err instanceof Error ? err.message : err}`;
      }
    } else if (w.photo === "remove_circle" && w.p.photo) {
      await store.photoRemove(w.p.photo.path);
      delete w.p.photo;
      circleChanged = true;
    }
  }
  if (circleChanged && !(await store.saveDoc(doc, rev))) return { changes, linked, flags, waiting: 0, busy: true };

  // 2. Google's side, one person at a time.
  let writes = 0, creates = 0;
  const max = opt.maxWrites ?? 40, maxCreates = opt.maxCreates ?? 10;
  for (const w of work) {
    const needs = w.create || Object.keys(w.plan.toGoogle).length > 0 || w.photo === "push" || w.photo === "remove_google";
    // New Google contacts go a few at a time, so a mistake can't flood Google with copies.
    if (needs && (writes >= max || (w.create && creates >= maxCreates))) { waiting++; continue; }
    const before = w.link && !w.create ? R.canon(linkOf.get(w.p.id) ?? null) : null;
    const change = changes.find((c) => c.personId === w.p.id);
    try {
      let g = w.g;
      if (w.create) {
        const { body } = R.toGoogle({}, R.fromCircle(w.p));
        delete body.etag;
        g = await google.create(body); writes++; creates++;
        w.link = { person_id: w.p.id, resource_name: g.resourceName, status: "linked", etag: g.etag ?? null, snapshot: {}, conflicts: [], photo_synced: false, circle_photo_v: null, google_photo_url: null };
        w.plan = R.plan({}, R.fromCircle(w.p), R.fromGoogle(g), false);
      } else if (Object.keys(w.plan.toGoogle).length) {
        const { body, fields } = R.toGoogle(g, w.plan.toGoogle);
        g = await google.update(w.link!.resource_name!, body, fields); writes++;
      }
      let googleUrl = g ? R.googlePhoto(g) : null;
      if (w.photo === "push" && w.p.photo) {
        const bytes = await store.photoGet(w.p.photo.path);
        if (bytes) { g = await google.setPhoto(w.link!.resource_name!, b64(bytes)); googleUrl = R.googlePhoto(g); writes++; }
      } else if (w.photo === "remove_google") {
        g = await google.removePhoto(w.link!.resource_name!); googleUrl = null; writes++;
      }
      const link = w.link!;
      link.snapshot = w.plan.snapshot;
      link.conflicts = w.plan.conflicts;
      link.etag = g?.etag ?? link.etag;
      // A photo still to come keeps the last agreed photo state, so the next run tries again.
      if (!w.photoLater) {
        link.photo_synced = true;
        link.circle_photo_v = R.circlePhoto(w.p);
        link.google_photo_url = googleUrl;
      }
      if (R.canon(link) !== before) await store.saveLink(link); // most runs change nothing
    } catch (err) {
      if (change) change.error = err instanceof Error ? err.message : String(err);
    }
  }
  return { changes, linked: work.filter((w) => w.link).length, flags, waiting };
}
