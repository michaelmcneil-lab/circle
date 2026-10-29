// Circle's rules, shared by the server functions (mcp, notify). They mirror the
// app's own logic in index.html: keep the two in step when either changes.

// deno-lint-ignore no-explicit-any
// eventLinks: who calendar events are with, as corrected by the user ({ id: event UID or one meeting's key, personIds }).
export type Doc = { people: any[]; interactions: any[]; followUps: any[]; relations: any[]; eventLinks?: any[] };
export const IX_LABEL: Record<string, string> = { call: "Phone call", text: "Texted", inperson: "In person", video: "Video call", email: "Email", social: "Social media", card: "Card / letter" };
export const EV_LABEL: Record<string, string> = {
  birth: "Birth / adoption", wedding: "Engagement / wedding", graduation: "Graduation", job: "New job / career", move: "Moved",
  travel: "Big trip", milestone: "Milestone", loss: "Loss / death", health: "Health", breakup: "Divorce / breakup", hardship: "Job loss / hard time", other: "Other",
};
export const HARD = new Set(["loss", "health", "breakup", "hardship"]);
// The rings of the user's circle, centre out, as in index.html (RINGS, DIRECTIONS).
export const RINGS: Record<string, string> = { inner: "Deepest", close: "Trusted", connected: "Kindred", wider: "Community", acquaint: "Familiar" };
export const REL_LABEL: Record<string, string> = { spouse: "spouse", partner: "partner", child: "child", parent: "parent", sibling: "sibling", grandchild: "grandchild", grandparent: "grandparent", inlaw: "in-law", other: "family", pet: "pet" };
export const REL_REV: Record<string, string> = { spouse: "spouse", partner: "partner", child: "parent", parent: "child", sibling: "sibling", grandchild: "grandparent", grandparent: "grandchild", inlaw: "inlaw", other: "other" };

export const dayNum = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
export const fmt = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

export class Circle {
  today: string;
  constructor(public doc: Doc, timeZone: string) {
    this.today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  since(s: string) { return dayNum(this.today) - dayNum(s); }
  person(id: string) { return this.doc.people.find((p) => p.id === id); }
  ixFor(id: string) { return this.doc.interactions.filter((i) => i.personIds?.includes(id)).sort((a, b) => b.date.localeCompare(a.date)); }
  lastContact(id: string) { return this.ixFor(id)[0]?.date ?? null; }
  openFollowUps(id?: string) {
    return this.doc.followUps.filter((f) => !f.done && (!id || f.personIds?.includes(id)))
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  }
  // deno-lint-ignore no-explicit-any
  eventState(e: any): "prominent" | "quiet" | null {
    if (e.visibility === "hidden") return null;
    if (e.visibility === "pinned") return "prominent";
    const age = this.since(e.date);
    if (e.until) return this.since(e.until) <= 0 && age >= -60 ? "prominent" : null;
    if (age < 0) return -age <= 60 ? "prominent" : null;
    if (HARD.has(e.type)) return age <= 90 ? "prominent" : age <= 365 ? "quiet" : null;
    return age <= 42 ? "prominent" : null;
  }
  // Days until the next yearly date, and the age or years it marks.
  next(dateStr: string) {
    const parts = dateStr.split("-").map(Number);
    const [y, m, d] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    const ty = Number(this.today.slice(0, 4));
    let year = ty, target = Date.UTC(year, m - 1, d) / 86400000;
    if (target < dayNum(this.today)) { year++; target = Date.UTC(year, m - 1, d) / 86400000; }
    return { days: target - dayNum(this.today), years: y ? year - y : null, md: `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
  }
  // A person's family, as "Linda (spouse)": linked people in Circle (other than those who've
  // also passed) and family members kept on their page (not pets). For reaching out on the
  // days that matter after someone has passed.
  // deno-lint-ignore no-explicit-any
  family(p: any): string[] {
    const out: string[] = [];
    const who = (o: { firstName?: string; name: string }) => o.firstName || o.name;
    for (const r of this.doc.relations ?? []) {
      // A relation { from, to, type } means "to is from's <type>".
      const other = r.from === p.id ? this.person(r.to) : r.to === p.id ? this.person(r.from) : null;
      const type = r.from === p.id ? r.type : REL_REV[r.type];
      if (other && !other.inMemory) out.push(`${who(other)} (${REL_LABEL[type] || "family"})`);
    }
    for (const m of p.familyMembers ?? []) if (m.rel !== "pet") out.push(`${m.name} (${REL_LABEL[m.rel] || "family"})`);
    return out;
  }
  // The days to remember someone who has passed, within `days`: the anniversary of their
  // passing and their birthday.
  // deno-lint-ignore no-explicit-any
  remembrance(p: any, days: number): { days: number; line: string }[] {
    if (!p.inMemory) return [];
    const out: { days: number; line: string }[] = [];
    if (p.passedOn) {
      const n = this.next(p.passedOn);
      if (n.days <= days) out.push({ days: n.days, line: n.years ? `${n.years === 1 ? "one year" : `${n.years} years`} since ${p.name} passed` : `the anniversary of ${p.name}'s passing` });
    }
    if (p.birthday) {
      const n = this.next(p.birthday);
      if (n.days <= days) out.push({ days: n.days, line: `${p.name}'s birthday${n.years ? `; they would have been ${n.years}` : ""}` });
    }
    return out;
  }
  names(ids: string[], except?: string) { return ids.filter((i) => i !== except).map((i) => this.person(i)?.name).filter(Boolean).join(" & "); }
  // Someone who has passed is never "due a check-in".
  overdue(p: { id: string; contactEvery?: number; inMemory?: boolean }) {
    if (!p.contactEvery || p.inMemory) return false;
    const last = this.lastContact(p.id);
    return !last || this.since(last) > p.contactEvery;
  }
  // deno-lint-ignore no-explicit-any
  find(query: string): any[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const exact = this.doc.people.filter((p) => p.id === query || p.name?.toLowerCase() === q || p.nickname?.toLowerCase() === q);
    if (exact.length) return exact;
    const words = q.split(/\s+/);
    return this.doc.people.filter((p) => {
      const hay = [p.name, p.nickname, p.company, p.jobTitle, p.relationship, ...(p.tags || []), ...(p.interests || []),
        ...(p.familyMembers || []).map((m: { name: string }) => m.name)].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
}

