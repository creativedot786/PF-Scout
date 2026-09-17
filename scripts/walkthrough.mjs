// Replays a conversation against the live API and checks the things that went wrong before.
// usage: node scripts/walkthrough.mjs [baseUrl]
const BASE = process.argv[2] || "https://scout-prototype-omega.vercel.app";
const turns = [
  "Need 2 bedroom near metro",
  "looking for 3 bed in jvc under 130k",
  "make it 2 bed",
  "under 80k",
  "10k a month is my max actually, and I have a cat",
  "just for now show me anything furnished, don't mind the area",
  "being in jvc isn't important, drop it",
];
const st = { messages: [], prefs: [], lastResults: [], askedTopics: [], turn: 0 };
const openings = [], asked = [], fails = [];
const LISTINGS = await (await fetch(BASE + "/data/listings.json")).json();
for (const t of turns) {
  st.messages.push({ role: "user", content: t }); st.turn++;
  const t0 = Date.now();
  const res = await fetch(BASE + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: st.messages, preferences: st.prefs, lastResults: st.lastResults, askedTopics: st.askedTopics, turn: st.turn }) });
  const text = await res.text();
  let state = null, reply = "";
  for (const line of text.split("\n")) { if (!line.trim()) continue; const ev = JSON.parse(line); if (ev.type === "state") state = ev; if (ev.type === "delta") reply += ev.text; if (ev.type === "error") fails.push(`turn "${t}": server error ${ev.error}`); }
  const [main, follow] = reply.split("===").map((s) => (s || "").trim());
  const tFirst = Date.now() - t0;
  console.log(`\n> ${t}\n  (${(tFirst / 1000).toFixed(1)}s) ${main}${follow ? "\n  ↳ " + follow : ""}`);
  console.log("  brief:", state.preferences.filter((p) => p.changed !== "removed").map((p) => `${p.label}${p.source !== "said" ? "?" : ""}${p.scope === "fornow" ? " (now)" : ""}`).join(" · "), "| results:", state.results.length, state.total ? `of ${state.total}` : "", state.relax ? `| relax: ${state.relax.label} → ${state.relax.count}` : "");
  // checks
  const banned = /room to breathe|the wall|say the word|lands you|value pick|good news|perfect|great news|nudg|sweet spot|opens things up|in the mix/i;
  if (/—/.test(reply)) fails.push(`turn "${t}": em dash`);
  if (banned.test(reply)) fails.push(`turn "${t}": idiom/filler: "${reply.match(banned)[0]}"`);
  if (/!/.test(reply)) fails.push(`turn "${t}": exclamation mark`);
  if (/\?/.test(main) && state.showResults) fails.push(`turn "${t}": question inside main reply while results shown`);
  const op = main.split(" ").slice(0, 3).join(" ").toLowerCase(); if (openings.includes(op)) fails.push(`turn "${t}": opening repeated: "${op}"`); openings.push(op);
  if (follow) { const key = follow.toLowerCase().replace(/[^a-z ]/g, "").split(" ").filter((w) => w.length > 4).slice(0, 3).join(" "); if (asked.some((a) => a && key && a === key)) fails.push(`turn "${t}": follow-up repeated`); asked.push(key); }
  const retracts = /not important|drop|forget|instead|no longer|actually|any ?more|don'?t mind/i.test(t);
  if (!retracts) for (const p of st.prefs) if (!state.preferences.some((q) => q.id === p.id && q.changed !== "removed")) fails.push(`turn "${t}": "${p.label}" vanished without a retraction`);
  const maxRent = state.filters?.maxRent; if (maxRent != null && !state.filters.budgetSoft && !state.relax) for (const id of state.results) { const l = LISTINGS.find((x) => x.id === id); if (l.rentAed > maxRent) fails.push(`turn "${t}": ${id} ${l.rentAed} over budget ${maxRent}`); }
  for (const p of state.preferences) if (/^(location|bedrooms|budget|area|type|furnishing)$/i.test(p.label.trim())) fails.push(`turn "${t}": category label "${p.label}"`);
  if (t.includes("near metro") && !state.preferences.some((p) => /metro/i.test(p.label + p.sentence))) fails.push(`turn "${t}": metro not recorded`);
  if (t.includes("jvc") && !retracts && !state.preferences.some((p) => /jvc|jumeirah village/i.test(p.label + p.sentence))) fails.push(`turn "${t}": JVC not recorded`);
  if (/cat|dog/.test(t) && state.filters?.pets !== true) fails.push(`turn "${t}": pet not applied as filter`);
  if (/cat|dog/.test(t)) for (const id of state.results) { const l = LISTINGS.find((x) => x.id === id); if (!l.petFriendly) fails.push(`turn "${t}": ${id} allows no pets`); }
  if (t.includes("10k a month") && !state.preferences.some((p) => /120/.test(p.label + p.sentence))) fails.push(`turn "${t}": monthly budget not normalised to 120k`);
  if (t.includes("just for now") && !state.preferences.some((p) => p.scope === "fornow")) fails.push(`turn "${t}": fornow scope missing`);
  if (t.includes("drop it") && state.preferences.some((p) => /jvc|jumeirah village/i.test(p.label) && p.changed !== "removed")) fails.push(`turn "${t}": JVC not removed`);
  st.prefs = state.preferences.filter((p) => p.changed !== "removed").map(({ changed, ...p }) => p);
  st.lastResults = state.results; st.askedTopics = state.askedTopics || []; st.messages.push({ role: "assistant", content: reply.replace("===", "\n") });
}
console.log("\n" + (fails.length ? "FAILS:\n- " + fails.join("\n- ") : "ALL CHECKS PASSED"));
