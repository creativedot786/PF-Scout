// Scout — one streaming endpoint, two model calls.
//   1. UNDERSTAND (structured): what has the person told/implied → preferences + filters.
//   2. Code matches listings against the filters (no model in the loop).
//   3. REPLY (streamed text): Scout talks about what changed and what it found.
// The response is newline-delimited JSON: a "state" event first, then "delta" text events, then "done".

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const config = { supportsResponseStreaming: true };

const here = path.dirname(fileURLToPath(import.meta.url));
const LISTINGS = JSON.parse(readFileSync(path.join(here, "..", "public", "data", "listings.json"), "utf8"));
const ALIASES = JSON.parse(readFileSync(path.join(here, "..", "public", "data", "aliases.json"), "utf8"));
const COMMUNITIES = [...new Set(LISTINGS.map((l) => l.community))];
const UNDERSTAND_MODEL = "claude-haiku-4-5";
const REPLY_MODEL = "claude-sonnet-5";
const SESSION_CAP = 15;

const COVERAGE = ["apartment", "townhouse", "villa"].map((t) => {
  const by = {}; LISTINGS.filter((l) => l.type === t).forEach((l) => { (by[l.community] ||= {}); (by[l.community][l.beds] ||= []).push(l.rentAed); });
  return `${t}s: ` + Object.entries(by).map(([c, beds]) => `${c} (${Object.entries(beds).map(([b, rents]) => `${b === "0" ? "studio" : b + "bd"} from ${Math.round(Math.min(...rents) / 1000)}k`).join(", ")})`).join("; ");
}).join("\n");
const aliasText = Object.entries(ALIASES).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n");

/* ------------------------------------------------------------------ */
/* 1. UNDERSTAND                                                        */
/* ------------------------------------------------------------------ */
const UNDERSTAND_SYSTEM = `You maintain Scout's understanding of a person looking for a home to RENT in Dubai. You read the conversation and return ONLY structured data — no prose to the user.

## Preferences — the checklist
Go through this checklist on every turn. If the person has stated something, it MUST appear as a preference with source "said". Never drop a stated preference unless they retract it.
- location (community or area; may be several) — normalise via the alias list below to the canonical community names. "near my office in DIFC" → location near DIFC, source "assumed" (they implied it).
- beds (studio = 0)
- budget — yearly AED. Normalise: "10k a month" → 120000/yr; "130k" → 130000; "130" (rent context) → 130000; "4 cheques" is a payment term, not a budget. If they say "around/roughly/about", set budgetSoft true; "under/max/up to" → budgetSoft false.
- type (apartment / townhouse / villa)
- furnished (true/false/either)
- pets, balcony, garden/backyard, gym, pool, near metro, near schools, quiet, parking, cheques
- move-in timing, anything else they care about

Labels: "label" is the VALUE in 1–4 words as it will appear in a one-line summary — "JVC", "3-bed", "under 130k", "~120k", "furnished", "pet-friendly", "near DIFC", "quiet" — never the category name ("Location", "Bedrooms", "Budget") and never scope words like "for now". Pets are always "pet-friendly", never the animal's name. Budgets: "under 130k" for a limit (including "max", "up to", "10k a month is my max" → "under 120k"), "~130k" only for "around/about/roughly". "sentence" is a short fragment that completes the phrase "You want …": "a 2-bed", "in JVC", "under 130k/year", "~130k/year", "furnished", "a pet-friendly building", "near a metro", "somewhere quiet". No subject, no "you'd like", no explanation, no animal names. Two to five words. Money is always written like "130k/year" or "~130k/year", never "a year" or "AED".

Sources: "said" = stated. "assumed" = you inferred it (mention of a cat → pets; office in DIFC → short commute; kids → schools). "unsure" = a vague word you can't safely interpret ("nice area", "cheap", "big") — record it as unsure and set needsClarification.
Scope: "standing" by default. "fornow" when they say "just for now", "for this search", "temporarily". A fornow preference NEVER replaces the standing one; keep both.

Corrections: "not important" / "drop" / "doesn't matter" → return that preference with changed:"removed". "actually X" → return it with changed:"updated". Keep preference ids stable across turns (reuse ids from the previous understanding).

A new criterion ADDS to what's already known; it never replaces or removes earlier preferences. Only remove when the person explicitly retracts ("not important", "drop", "forget", "instead of", "no longer").

IMPORTANT: "preferences" must contain ONLY the preferences that changed this turn (added, updated or removed). Do NOT repeat unchanged ones; the app keeps them. On the first turn everything is "added". If nothing changed, return an empty array.

## Filters
Translate the CURRENT effective preferences into filters (fornow overrides standing for this search).
- Everything they SAID is a hard filter.
- An ASSUMED preference is a hard filter when it is a necessity: a cat or dog → pets:true (an animal cannot live in a no-pets building); a family size that implies bedrooms → bedsMin; a wheelchair → ground floor/lift. Scout will tell them it applied it.
- An ASSUMED preference that is only a likely wish (office in DIFC → short commute; kids → schools nearby; "quiet") goes to "prefer" for ranking, not to filters.
- UNSURE preferences never filter.

## Aliases (canonical: how people write it)
${aliasText}
Known communities in the catalogue: ${COMMUNITIES.join("; ")}.

## askedTopics
Return the running list of topics Scout has already asked the person about (carry forward what you're given, add what was asked last turn, remove a topic if the person has now answered it).

## intent
"search" normally. "chat" when they're asking a question that doesn't change the search ("why do you think…", "what's JVC like"). "out_of_scope" for buying, other emirates, commercial, booking viewings, or anything Scout can't do — set outOfScopeNote to a short plain-language reason.`;

const UNDERSTAND_JSON_HINT = `

## Output
Return ONLY a compact JSON object, no prose, no code fences:
{"preferences":[{"id":"beds","label":"2-bed","sentence":"a 2-bed","source":"said","scope":"standing","changed":"added"}],
 "filters":{"communities":["Jumeirah Lakes Towers"],"bedsMin":2,"bedsMax":2,"maxRent":120000,"budgetSoft":true,"types":[],"furnished":null,"pets":true,"balcony":null,"garden":null,"gym":null,"pool":null,"nearMetro":null,"nearSchools":null},
 "prefer":["metro"],"askedTopics":[],"intent":"search","outOfScopeNote":"","needsClarification":""}
Omit filter keys that are null or empty. Omit askedTopics/outOfScopeNote/needsClarification when empty. Labels use the short common name for areas (JLT, JVC, Marina, Downtown).`;

const UNDERSTAND_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["preferences", "filters", "prefer", "askedTopics", "intent", "outOfScopeNote", "needsClarification"],
  properties: {
    preferences: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "label", "sentence", "source", "scope", "changed"],
      properties: { id: { type: "string" }, label: { type: "string" }, sentence: { type: "string" },
        source: { type: "string", enum: ["said", "assumed", "unsure"] }, scope: { type: "string", enum: ["standing", "fornow"] },
        changed: { type: "string", enum: ["added", "updated", "removed", "unchanged"] } } } },
    filters: { type: "object", additionalProperties: false,
      required: ["communities", "bedsMin", "bedsMax", "maxRent", "budgetSoft", "types", "furnished", "pets", "balcony", "garden", "gym", "pool", "nearMetro", "nearSchools"],
      properties: {
        communities: { type: "array", items: { type: "string" } },
        bedsMin: { anyOf: [{ type: "integer" }, { type: "null" }] }, bedsMax: { anyOf: [{ type: "integer" }, { type: "null" }] },
        maxRent: { anyOf: [{ type: "integer" }, { type: "null" }] }, budgetSoft: { type: "boolean" },
        types: { type: "array", items: { type: "string", enum: ["apartment", "townhouse", "villa"] } },
        furnished: { anyOf: [{ type: "boolean" }, { type: "null" }] }, pets: { anyOf: [{ type: "boolean" }, { type: "null" }] }, balcony: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        garden: { anyOf: [{ type: "boolean" }, { type: "null" }] }, gym: { anyOf: [{ type: "boolean" }, { type: "null" }] }, pool: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        nearMetro: { anyOf: [{ type: "boolean" }, { type: "null" }] }, nearSchools: { anyOf: [{ type: "boolean" }, { type: "null" }] } } },
    prefer: { type: "array", items: { type: "string", enum: ["metro", "schools", "quiet", "pets", "gym", "pool", "balcony", "garden", "furnished", "cheap", "large"] } },
    askedTopics: { type: "array", items: { type: "string" } },
    intent: { type: "string", enum: ["search", "chat", "out_of_scope"] },
    outOfScopeNote: { type: "string" },
    needsClarification: { type: "string" },
  },
};

/* ------------------------------------------------------------------ */
/* 2. MATCH                                                             */
/* ------------------------------------------------------------------ */
function canonical(name) {
  const n = String(name || "").toLowerCase().trim();
  for (const [canon, al] of Object.entries(ALIASES)) if (canon.toLowerCase() === n || al.includes(n)) return canon;
  return name;
}
const NEARBY = { // what "near X" reasonably includes when X itself has nothing
  "DIFC": ["Downtown Dubai", "Business Bay"], "Downtown Dubai": ["Business Bay", "DIFC"], "Business Bay": ["Downtown Dubai", "DIFC"],
  "Dubai Marina": ["Jumeirah Beach Residence", "Jumeirah Lakes Towers"], "Jumeirah Lakes Towers": ["Dubai Marina"], "Jumeirah Beach Residence": ["Dubai Marina"],
  "Barsha Heights": ["Al Barsha", "Jumeirah Lakes Towers"], "Dubai Media City": ["Al Barsha", "Dubai Marina"],
};
/* The brief is the source of truth: hard filters can never be looser than what it shows. */
function reconcile(f, prefs) {
  const live = prefs.filter((p) => p.changed !== "removed");
  const now = live.filter((p) => p.scope === "fornow"), standing = live.filter((p) => p.scope !== "fornow");
  const text = (p) => (p.label + " " + p.sentence).toLowerCase();
  const pick = (re) => now.find((p) => re.test(text(p))) || standing.find((p) => re.test(text(p)));
  const g = { ...f };
  const furn = pick(/furnish/); if (furn) g.furnished = /unfurnished/.test(text(furn)) ? false : true;
  if (pick(/pet[- ]?friendly|pets? (allowed|ok)/)) g.pets = true;
  if (pick(/balcon/)) g.balcony = true;
  if (pick(/garden|backyard/)) g.garden = true;
  if (pick(/\bgym\b/)) g.gym = true;
  if (pick(/\bpool\b/)) g.pool = true;
  if (pick(/metro/) && !pick(/metro/).source.match(/assumed|unsure/)) g.nearMetro = true;
  const beds = pick(/(\d)[- ]?bed|studio/); if (beds) { const m = text(beds).match(/(\d)[- ]?bed/); const n = /studio/.test(text(beds)) ? 0 : m ? +m[1] : null; if (n != null) { g.bedsMin = n; g.bedsMax = n; } }
  const bud = pick(/(under|max|up to|~|around|about|budget)\s*(aed\s*)?(\d{2,3})k/); if (bud) { const m = text(bud).match(/(\d{2,3})k/); if (m) { g.maxRent = +m[1] * 1000; g.budgetSoft = /~|around|about/.test(text(bud)); } }
  const anyArea = now.find((p) => /any area|anywhere|don't mind where/.test(text(p)));
  if (anyArea) g.communities = [];
  else { const areas = standing.filter((p) => /^(in|near) /.test(p.sentence.toLowerCase()) || Object.keys(ALIASES).some((c) => text(p).includes(c.toLowerCase())) || Object.values(ALIASES).some((al) => al.some((a) => a.length > 2 && new RegExp("\\b" + a + "\\b").test(text(p)))));
    if (areas.length && !(g.communities || []).length) g.communities = areas.flatMap((p) => Object.entries(ALIASES).filter(([c, al]) => text(p).includes(c.toLowerCase()) || al.some((a) => a.length > 2 && new RegExp("\\b" + a + "\\b").test(text(p)))).map(([c]) => c)); }
  return g;
}
function applyFilters(f, opts = {}) {
  const comms = (f.communities || []).map(canonical);
  const wanted = new Set(comms);
  if (opts.expandNearby) comms.forEach((c) => (NEARBY[c] || []).forEach((n) => wanted.add(n)));
  return LISTINGS.filter((l) => {
    if (wanted.size && !wanted.has(l.community)) return false;
    if (f.bedsMin != null && l.beds < f.bedsMin) return false;
    if (f.bedsMax != null && l.beds > f.bedsMax) return false;
    if (f.maxRent != null) { const cap = f.budgetSoft ? f.maxRent * 1.08 : f.maxRent; if (l.rentAed > cap) return false; }
    if (f.types?.length && !f.types.includes(l.type)) return false;
    if (f.furnished != null && l.furnished !== f.furnished) return false;
    if (f.pets === true && !l.petFriendly) return false;
    if (f.balcony === true && !l.balcony) return false;
    if (f.garden === true && !l.garden) return false;
    if (f.gym === true && !l.gym) return false;
    if (f.pool === true && !l.pool) return false;
    if (f.nearMetro === true && !l.metroMins) return false;
    if (f.nearSchools === true && !l.schoolsNearby) return false;
    return true;
  });
}
function rank(list, prefer, f) {
  const score = (l) => {
    let s = 0;
    if (prefer.includes("metro")) s += l.metroMins ? (15 - Math.min(l.metroMins, 15)) / 15 : -0.5;
    if (prefer.includes("schools")) s += l.schoolsNearby ? 1 : -0.3;
    if (prefer.includes("quiet")) s += l.quiet / 5;
    if (prefer.includes("pets")) s += l.petFriendly ? 0.8 : -1;
    if (prefer.includes("gym")) s += l.gym ? 0.4 : 0;
    if (prefer.includes("pool")) s += l.pool ? 0.4 : 0;
    if (prefer.includes("balcony")) s += l.balcony ? 0.4 : 0;
    if (prefer.includes("garden")) s += l.garden ? 0.8 : 0;
    if (prefer.includes("furnished")) s += l.furnished ? 0.5 : 0;
    if (prefer.includes("cheap")) s += 1 - l.rentAed / 900000;
    if (prefer.includes("large")) s += l.sqft / 5000;
    if (f.maxRent != null) s += 0.3 * (1 - l.rentAed / f.maxRent); // closer to budget ceiling is fine, cheaper is a mild plus
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a));
}
const RELAXABLE = [["furnished", "furnished"], ["pets", "pet-friendly"], ["balcony", "balcony"], ["garden", "garden"], ["gym", "gym"], ["pool", "pool"], ["nearMetro", "near a metro"], ["nearSchools", "near schools"], ["types", "property type"], ["communities", "the area"], ["bedsMin", "bedrooms"], ["maxRent", "budget"]];
function match(f, prefer) {
  let results = rank(applyFilters(f), prefer, f);
  let note = "", relax = null, expanded = false;
  if (!results.length && f.communities?.length) {
    results = rank(applyFilters(f, { expandNearby: true }), prefer, f);
    if (results.length) { expanded = true; note = `Nothing in ${f.communities.map(canonical).join(" / ")} itself. Showing nearby areas.`; }
  }
  if (!results.length) {
    let best = null;
    for (const [key, label] of RELAXABLE) {
      const empty = key === "communities" || key === "types" ? !(f[key]?.length) : f[key] == null || f[key] === false;
      if (empty) continue;
      const g = { ...f, [key]: key === "communities" || key === "types" ? [] : null };
      const r = rank(applyFilters(g), prefer, g);
      if (r.length && (!best || r.length > best.count)) best = { key, label, count: r.length, results: r.slice(0, 3) };
    }
    if (best) relax = best;
  }
  return { results: results.slice(0, 6), total: results.length, note, relax, expanded };
}

/* ------------------------------------------------------------------ */
/* 3. REPLY                                                             */
/* ------------------------------------------------------------------ */
const REPLY_SYSTEM = `You are Scout, Property Finder's rental search in Dubai — a sharp, warm human agent texting a client. You are given what the person just said, what Scout now understands, and the listings that actually match. Write Scout's next message.

How Scout talks
Plain, international English. Dubai's renters come from everywhere and many are not native English speakers.
- Short sentences, roughly under 18 words, one idea each. Two or three sentences is usually enough.
- No idioms, metaphors, slang or wordplay. No em dashes. No exclamation marks. No "Perfect", "Great", "Good news", "value pick". Contractions are fine.
- Concrete beats clever: always the area, the price, the distance. Numbers like "AED 95k", "500m from the metro". Use **bold** on at most one or two numbers.
- Lead with what just changed and what it did to the results. Don't recap everything they've told you; the app shows that already.
- When you inferred something and it was applied, say so once, plainly ("I'm assuming you need a pet-friendly building, so I only kept those. Tell me if not."). Don't say "I'm noting".
- Mention only facts tied to what they asked for, plus area and price. Don't volunteer amenities, metro distances or cheques they didn't ask about.
- When you normalised money, say what you understood ("10k a month is about 120k a year.").
- If nothing matched everything, NO listings are shown. Name the single requirement that's blocking and how many they'd get without it ("Nothing furnished in JVC under 90k. Without furnished there is one, at 88k."). The app shows a button for that. Don't describe listings they can't see. Don't apologise.
- Out of scope: one honest line, then back to renting. Never offer things Scout can't do here: booking viewings, contacting agents, negotiating, checking availability.
- NEVER ask a question in the main reply when listings are shown. Questions go in the follow-up only.
- Vary your openings. Never start two replies the same way. Never use "Here's what I'm working from", "to narrow this down", "Got it", "Noted".
- Respond to their last message, not the whole history.
- Only suggest areas, types or price ranges that exist in the coverage list below. Never invent inventory.
- A Dubai term like "cheques" is fine; if you use it, add a two-word gloss the first time ("2 cheques, so two payments").

What Scout actually has (community: bedrooms, yearly rent range)
${COVERAGE}

Follow-up (optional)
After the main reply, if — and only if — there is ONE genuinely high-impact thing you don't know yet (budget first, if unknown), write a line "===" and then a single short conversational question, no list. Never a topic in askedTopics. Never something you just answered yourself. If listings are shown and the person hasn't been asked anything for two turns, a follow-up is welcome; otherwise skip it more often than not. Skip it entirely when nothing matched, when intent is chat/out_of_scope, or when you asked something last turn.`;

function describeListing(l, lastIds) {
  const bits = [l.id, `${l.beds === 0 ? "studio" : l.beds + "-bed"} ${l.type} in ${l.building}, ${l.community}`, `AED ${Math.round(l.rentAed / 1000)}k/yr`, `${l.sqft} sqft`,
    l.furnished ? "furnished" : "unfurnished", l.petFriendly ? "pets ok" : "no pets", l.metroM ? `${l.metroM}m from ${l.metroStation}` : "no metro nearby",
    l.school ? `${l.school} ${l.schoolMins} min` : "", l.garden ? "garden" : "", l.balcony ? "balcony" : "", l.gym ? "gym" : "", l.pool ? "pool" : "", `quiet ${l.quiet}/5`, `${l.cheques} cheques`,
    l.available !== "now" ? `available ${l.available}` : "", l.highlights.join(", "), lastIds.includes(l.id) ? "(shown before)" : "(NEW)"];
  return bits.filter(Boolean).join(" | ");
}

/* ------------------------------------------------------------------ */
/* handler                                                              */
/* ------------------------------------------------------------------ */
const client = new Anthropic();

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true }); // warm-up ping from the page
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { messages = [], preferences = [], lastResults = [], askedTopics = [], turn = 0, debug = {} } = req.body || {};
  if (!messages.length) return res.status(400).json({ error: "No messages" });
  if (turn > SESSION_CAP) return res.status(429).json({ error: "This demo session has reached its limit. Tap the menu and start over." });

  const trimmed = messages.slice(-20).map((m) => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
  const lastUser = trimmed[trimmed.length - 1].content;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const t0 = Date.now();
    // 1. understand
    // Plain JSON is ~6s faster than strict schema mode on Haiku; strict mode is the fallback if parsing fails.
    const umsgs = [...trimmed.slice(0, -1), { role: "user", content: `${lastUser}\n\n[Previous understanding: ${JSON.stringify(preferences.map(({ sentence, ...p }) => p))}]\n[askedTopics so far: ${JSON.stringify(askedTopics)}]` }];
    const understand = async (structured) => {
      const u = await client.messages.create({
        model: debug.understandModel || UNDERSTAND_MODEL, max_tokens: 900,
        system: [{ type: "text", text: UNDERSTAND_SYSTEM + (structured ? "" : UNDERSTAND_JSON_HINT), cache_control: { type: "ephemeral" } }],
        messages: umsgs,
        ...(structured ? { output_config: { format: { type: "json_schema", schema: UNDERSTAND_SCHEMA } } } : {}),
      });
      const raw = u.content.find((b) => b.type === "text")?.text ?? "{}";
      const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      obj.preferences ||= []; obj.filters ||= {}; obj.prefer ||= []; obj.askedTopics ||= askedTopics; obj.intent ||= "search"; obj.outOfScopeNote ||= ""; obj.needsClarification ||= "";
      return { u, obj };
    };
    let res1; try { res1 = await understand(debug.structured === true); } catch (e) { console.warn("plain JSON failed, retrying strict", e?.message); res1 = await understand(true); }
    const { u } = res1; const und = res1.obj;
    // merge the delta into the previous understanding
    const merged = preferences.map((p) => ({ ...p, changed: "unchanged" }));
    const retracts = /not important|doesn'?t matter|don'?t (care|mind|need)|drop|forget|remove|no longer|instead|rather|scrap|ignore|without|skip|never mind|actually|change|cancel|any ?more/i.test(lastUser);
    for (const c of und.preferences || []) {
      if (c.changed === "removed" && !retracts) continue; // a removal needs a retraction in the message
      const i = merged.findIndex((p) => p.id === c.id || (p.label.toLowerCase() === c.label.toLowerCase()));
      if (i >= 0) merged[i] = { ...merged[i], ...c, changed: c.changed === "added" ? "updated" : c.changed };
      else if (c.changed !== "removed") merged.push({ ...c, changed: "added" });
    }
    und.preferences = merged;
    und.filters.communities = (und.filters.communities || []).map(canonical);
    und.filters = reconcile(und.filters, und.preferences || []);

    // 2. match (code)
    let m = { results: [], total: 0, note: "", relax: null, expanded: false };
    const showResults = und.intent === "search";
    if (showResults) m = match(und.filters, und.prefer || []);
    const ids = m.results.map((l) => l.id);
    const newIds = ids.filter((id) => !lastResults.includes(id));
    const goneIds = lastResults.filter((id) => !ids.includes(id));
    const gone = goneIds.map((id) => LISTINGS.find((l) => l.id === id)).filter(Boolean);
    const sameAsLast = ids.length > 0 && ids.length === lastResults.length && ids.every((id, i) => id === lastResults[i]);
    send({ type: "state", timing: { understandMs: Date.now() - t0, usage: u.usage }, preferences: und.preferences, filters: und.filters, askedTopics: und.askedTopics, intent: und.intent,
      results: ids, newIds, total: m.total, resultsNote: m.note, showResults: showResults && ids.length > 0 && !sameAsLast, sameAsLast,
      relax: m.relax ? { key: m.relax.key, label: m.relax.label, count: m.relax.count, prefId: (und.preferences.find((p) => p.changed !== "removed" && (p.label + " " + p.sentence).toLowerCase().includes(m.relax.label.split("/")[0].split(" ")[0])) || {}).id || null } : null });

    // 3. reply (streamed)
    const lastOpenings = trimmed.filter((m) => m.role === "assistant").slice(-2).map((m) => m.content.split(/[.!?\n]/)[0].trim()).filter(Boolean);
    const context = [
      `Person's last message: "${lastUser}"`,
      lastOpenings.length ? `Your previous replies began: ${lastOpenings.map((o) => `"${o}"`).join(" / ")}. Begin differently this time.` : "",
      `Understanding now (changed flags matter): ${JSON.stringify(und.preferences)}`,
      `Intent: ${und.intent}${und.outOfScopeNote ? " — " + und.outOfScopeNote : ""}${und.needsClarification ? " — needs clarification: " + und.needsClarification : ""}`,
      `askedTopics: ${JSON.stringify(und.askedTopics)}`,
      showResults ? `Matching listings (${m.total} total, showing ${ids.length}):\n${m.results.map((l) => describeListing(l, lastResults)).join("\n") || "(none)"}` : "No listings shown this turn.",
      m.note ? `Note: ${m.note}` : "",
      gone.length ? `Left the results since last time: ${gone.map((l) => `${l.building} (${l.community}, ${Math.round(l.rentAed / 1000)}k)`).join("; ")}` : "",
      m.relax ? `Nothing matched. NO listings are shown. If they drop "${m.relax.label}" there are ${m.relax.count} (e.g. ${m.relax.results.map((l) => `${l.building} in ${l.community}, ${Math.round(l.rentAed / 1000)}k`).join("; ")}). The app offers a button to do that — you just name the blocker and the count, and don't describe the listings in detail.` : "",
      sameAsLast ? "The matching listings are exactly the same as last time and are NOT re-shown. Confirm the change in one line; don't re-describe them." : "",
      (!showResults || ids.length) ? "" : "Nothing matched and nothing sensible to relax — say so and ask what they'd bend on.",
    ].filter(Boolean).join("\n\n");

    const stream = client.messages.stream({
      model: REPLY_MODEL, max_tokens: 700,
      system: [{ type: "text", text: REPLY_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [...trimmed.slice(0, -1), { role: "user", content: context }],
      output_config: { effort: "low" },
    });
    let first = 0;
    stream.on("text", (t) => { if (!first) first = Date.now(); send({ type: "delta", text: t }); });
    const fm = await stream.finalMessage();
    send({ type: "done", timing: { firstTokenMs: first - t0, totalMs: Date.now() - t0, usage: fm.usage } });
    res.end();
  } catch (err) {
    console.error(err);
    send({ type: "error", error: err?.message || "Scout couldn't answer" });
    res.end();
  }
}
