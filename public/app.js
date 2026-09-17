import { createOrb } from "./orb.js";

/* Scout prototype — front end.
   Scout's understanding lives in `state.prefs` and is always visible in the Living Brief.
   The server streams: a "state" event (understanding + matched listings), then reply text. */

const $ = (id) => document.getElementById(id);
const el = {
  device: $("device"), scroll: $("scroll"), empty: $("empty"), thread: $("thread"), orb: $("orb"),
  brief: $("brief"), briefText: $("briefText"), composer: $("composer"), input: $("input"), send: $("send"), mic: $("mic"),
  sheet: $("sheet"), sheetBody: $("sheetBody"), backdrop: $("backdrop"), popover: $("popover"), toast: $("toast"),
  menuBtn: $("menuBtn"), menu: $("menu"),
};
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const MOCK = LOCAL && new URLSearchParams(location.search).has("mock");
const API_BASE = LOCAL ? "https://scout-prototype-omega.vercel.app" : "";
const SESSION_CAP = 15;
let LISTINGS = [];
fetch("data/listings.json").then((r) => r.json()).then((d) => (LISTINGS = d));
if (!MOCK) fetch(API_BASE + "/api/chat").catch(() => {}); // wake the server so the first message doesn't pay the cold start

const state = { messages: [], prefs: [], lastResults: [], askedTopics: [], turn: 0, started: false, busy: false };
let orb = null;
const reveal = () => el.empty.classList.remove("loading");
const revealTimer = setTimeout(reveal, 2500); // never hold the page hostage to the CDN
try { orb = createOrb(el.orb, { size: 220, onReady: () => { clearTimeout(revealTimer); requestAnimationFrame(reveal); } }); } catch (e) { console.warn("orb unavailable", e); clearTimeout(revealTimer); reveal(); }

/* ---------- helpers ---------- */
const fmtAed = (n) => "AED " + n.toLocaleString("en-US");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^- /gm, "– ");
function toast(text, ms = 2200) { el.toast.textContent = text; el.toast.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.toast.hidden = true), ms); }
let scrollQueued = false;
function scrollToEnd(smooth = true) {
  if (scrollQueued) return; scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; el.scroll.scrollTo({ top: el.scroll.scrollHeight, behavior: smooth ? "smooth" : "auto" }); });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- thread rendering ---------- */
function addMsg(role, html) {
  const m = document.createElement("div");
  m.className = `msg ${role}`;
  m.innerHTML = role === "scout" ? `<div class="avatar"><svg aria-hidden="true"><use href="#pf"/></svg></div><div class="bubble">${html}</div>` : `<div class="bubble">${html}</div>`;
  const prev = el.thread.lastElementChild;
  if (prev && prev.classList.contains("msg") && prev.classList.contains(role)) { prev.classList.add("grouped"); m.classList.add("cont"); }
  el.thread.appendChild(m); scrollToEnd(); return m;
}
function addThinking() {
  const m = addMsg("scout", `<span class="typing"><i></i><i></i><i></i></span>`);
  m.querySelector(".avatar").classList.add("thinking"); return m;
}

/* Pills on a card come from what the person asked about — facts, not ticks. */
function relevantTags(l, prefs, filters, isNew, over) {
  const text = prefs.map((p) => (p.label + " " + p.sentence).toLowerCase()).join(" ");
  const tags = [];
  if (over) tags.push({ t: "Over budget", c: "over" });
  if (/metro|commute|office|transport/.test(text)) tags.push({ t: l.metroM ? `${l.metroM}m from metro` : "No metro nearby", i: "metro" });
  if (/school|kid|child|family|nursery/.test(text)) tags.push({ t: l.school ? `${l.school} · ${l.schoolMins} min` : "No schools close by", i: "school" });
  if (/pet|cat|dog/.test(text)) tags.push({ t: l.petFriendly ? "Pets allowed" : "No pets", i: "paw" });
  if (/furnish/.test(text)) tags.push({ t: l.furnished ? "Furnished" : "Unfurnished" });
  if (/balcon/.test(text)) tags.push({ t: l.balcony ? "Balcony" : "No balcony" });
  if (/garden|backyard|yard|outdoor/.test(text)) tags.push({ t: l.garden ? "Private garden" : "No garden" });
  if (/gym/.test(text)) tags.push({ t: l.gym ? "Gym" : "No gym" });
  if (/pool|swim/.test(text)) tags.push({ t: l.pool ? "Pool" : "No pool" });
  if (/quiet|calm|peace/.test(text)) tags.push({ t: l.quiet >= 4 ? "Quiet area" : l.quiet === 3 ? "Fairly quiet" : "Lively area" });
  if (/cheque|chq|payment/.test(text)) tags.push({ t: `${l.cheques} cheque${l.cheques > 1 ? "s" : ""}` });
  if (/move|available|asap|now|soon/.test(text)) tags.push({ t: l.available === "now" ? "Available now" : `From ${l.available}` });
  if (l.priceDrop) tags.push({ t: "Price dropped", c: "drop", i: "down" });
  if (tags.length < 2) { if (!/furnish/.test(text)) tags.push({ t: l.furnished ? "Furnished" : "Unfurnished" }); if (l.available !== "now") tags.push({ t: `From ${l.available}` }); }
  return tags.slice(0, 4);
}
function cardHtml(l, prefs, filters, isNew) {
  const beds = l.beds === 0 ? "Studio" : `${l.beds} bed`;
  const over = filters?.maxRent != null && l.rentAed > filters.maxRent;
  const tags = relevantTags(l, prefs, filters, isNew, over);
  return `<article class="card">
    <div class="photos">
      <div class="track" data-i="0" style="width:${l.photos.length * 100}%">${l.photos.map((p) => `<img src="${p.replace("w=900", "w=640")}" alt="" width="640" height="480" loading="lazy" decoding="async" style="width:${100 / l.photos.length}%" onload="this.classList.add('in')" />`).join("")}</div>
      <div class="dots">${l.photos.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("")}</div>
      <button class="ph-nav prev" aria-label="Previous photo"></button><button class="ph-nav next" aria-label="Next photo"></button>
      <span class="badge">${l.type[0].toUpperCase() + l.type.slice(1)}</span>
    </div>
    <div class="card-body">
      <div class="price">${fmtAed(l.rentAed)}<small>/ year</small></div>
      <div class="meta">${beds} · ${l.baths} bath · ${l.sqft.toLocaleString("en-US")} sq ft</div>
      <div class="where">${l.building}, ${l.community}</div>
      <div class="tags">${tags.map((x) => `<span class="${x.c || ""}">${x.i ? `<svg aria-hidden="true"><use href="#i-${x.i}"/></svg>` : ""}${x.t}</span>`).join("")}</div>
    </div>
  </article>`;
}
function addResults(ids, newIds, note, filters, after = null) {
  const items = ids.map((id) => LISTINGS.find((l) => l.id === id)).filter(Boolean);
  if (!items.length) return;
  const frag = document.createDocumentFragment();
  if (note) { const n = document.createElement("div"); n.className = "results-note"; n.textContent = note; frag.appendChild(n); }
  const wrap = document.createElement("div"); wrap.className = "results";
  wrap.innerHTML = items.map((l) => cardHtml(l, state.prefs, filters, newIds.includes(l.id))).join("");
  frag.appendChild(wrap);
  if (after && after.parentNode) after.after(frag); else el.thread.appendChild(frag);
  wrap.querySelectorAll(".ph-nav").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const ph = b.parentElement, t = ph.querySelector(".track"), n = t.children.length;
    let i = (+t.dataset.i + (b.classList.contains("next") ? 1 : -1) + n) % n;
    t.dataset.i = i; t.style.transform = `translateX(-${(100 / n) * i}%)`;
    ph.querySelectorAll(".dots i").forEach((d, j) => d.classList.toggle("on", j === i));
  }));
  scrollToEnd();
}

/* ---------- the Living Brief ---------- */
function renderBrief(prefs) {
  const live = prefs.filter((p) => p.changed !== "removed");
  if (!prefs.length) { el.brief.hidden = true; return; }
  el.brief.hidden = false;
  el.briefText.innerHTML = prefs.map((p) => `<span class="p ${p.source} ${p.scope} ${p.changed}">${esc(p.label)}</span>`).join(`<span class="sep">·</span>`) + `<span class="more" hidden></span>`;
  fitBrief();
  if (prefs.some((p) => p.changed && p.changed !== "unchanged")) {
    el.brief.classList.remove("pulse"); void el.brief.offsetWidth; el.brief.classList.add("pulse");
    setTimeout(() => { state.prefs = live.map((p) => ({ ...p, changed: "unchanged" })); renderBrief(state.prefs); }, 1700);
  }
}
function fitBrief() {
  const box = el.briefText, more = box.querySelector(".more"); if (!more) return;
  const items = [...box.querySelectorAll(".p")], seps = [...box.querySelectorAll(".sep")];
  items.forEach((i) => (i.hidden = false)); seps.forEach((s) => (s.hidden = false)); more.hidden = true;
  const limit = box.clientWidth - 44; let hidden = 0;
  for (let i = items.length - 1; i > 0; i--) {
    const last = items.slice(0, i + 1).filter((x) => !x.hidden).pop();
    if (last && last.offsetLeft + last.offsetWidth <= limit) break;
    items[i].hidden = true; seps[i - 1].hidden = true; hidden++;
  }
  if (hidden) { more.hidden = false; more.textContent = `+${hidden}`; }
}
window.addEventListener("resize", () => fitBrief());
function openSheet() {
  const live = state.prefs.filter((p) => p.changed !== "removed");
  const said = live.filter((p) => p.source === "said"), guessed = live.filter((p) => p.source !== "said");
  const term = (p) => `<span class="term ${p.source} ${p.scope}" data-id="${p.id}">${esc(p.sentence)}</span>`;
  const join = (arr) => arr.map(term).join(", ");
  let html = "";
  if (!live.length) html = `<p class="empty-note">Nothing yet — tell me what you're looking for and I'll keep track here.</p>`;
  else {
    if (said.length) html += `<p>You want ${join(said)}.</p>`;
    if (guessed.length) html += `<p>I'm also assuming ${join(guessed)} — tell me if I've got that wrong.</p>`;
  }
  el.sheetBody.innerHTML = html;
  el.sheet.hidden = false; el.backdrop.hidden = false;
  el.sheet.classList.remove("closing"); el.backdrop.classList.remove("closing");
}
function closeSheet() { hidePopover(); el.sheet.classList.add("closing"); el.backdrop.classList.add("closing"); setTimeout(() => { el.sheet.hidden = true; el.backdrop.hidden = true; }, 240); }
let activeTerm = null;
function showPopover(termEl) {
  hidePopover(); activeTerm = termEl; termEl.classList.add("active"); el.popover.hidden = false;
  const d = el.device.getBoundingClientRect(), t = termEl.getBoundingClientRect(), p = el.popover.getBoundingClientRect();
  let left = Math.max(12, Math.min(t.left - d.left + t.width / 2 - p.width / 2, d.width - p.width - 12));
  let top = t.top - d.top - p.height - 8; if (top < 12) top = t.bottom - d.top + 8;
  el.popover.style.left = left + "px"; el.popover.style.top = top + "px";
}
function hidePopover() { el.popover.hidden = true; if (activeTerm) activeTerm.classList.remove("active"); activeTerm = null; }
function moveOnPref(move, pref) {
  closeSheet();
  if (move === "drop") send(`"${pref.label}" isn't important to me — drop it.`);
  if (move === "why") send(`Why did you note "${pref.label}"?`);
  if (move === "change") { el.input.value = `Instead of "${pref.label}", `; el.input.focus(); el.composer.classList.add("has-text"); el.input.setSelectionRange(el.input.value.length, el.input.value.length); }
}

/* ---------- conversation ---------- */
function startIfNeeded() {
  if (state.started) return;
  state.started = true; stopHints();
  el.orb.style.transition = "transform .55s cubic-bezier(.4,0,.2,1), opacity .4s";
  el.orb.style.transform = "scale(.12)"; el.orb.style.opacity = "0";
  el.empty.style.transition = "opacity .3s"; el.empty.style.opacity = "0";
  setTimeout(() => { el.empty.hidden = true; el.thread.hidden = false; orb?.pause(); }, 320);
}
async function send(text) {
  text = (text || "").trim();
  if (!text || state.busy) return;
  if (state.turn >= SESSION_CAP) { toast("This demo session has reached its limit — start over from the menu", 3200); return; }
  startIfNeeded();
  el.input.value = ""; el.composer.classList.remove("has-text");
  state.messages.push({ role: "user", content: text }); state.turn++;
  await wait(state.thread ? 0 : 340);
  addMsg("user", md(text));
  await ask();
}
async function ask() {
  state.busy = true; el.composer.classList.add("busy"); orb?.setState(2);
  const bubble = addThinking();                       // this same bubble becomes the reply
  const skeleton = document.createElement("div"); skeleton.className = "results skeleton";
  skeleton.innerHTML = [0, 1].map(() => `<article class="card"><div class="sk photo"></div><div class="sk line w40"></div><div class="sk line w60"></div><div class="sk line last"></div></article>`).join("");
  el.thread.appendChild(skeleton);
  let replyText = "", followText = "", inFollow = false, pending = null, cardsShown = false, gotText = false;
  const showCards = () => {
    if (cardsShown) return; cardsShown = true;
    skeleton.remove();
    if (pending?.showResults && pending.results?.length) { addResults(pending.results, pending.newIds || [], pending.resultsNote, pending.filters, bubble); state.lastResults = pending.results; }
  };
  const onState = (s) => {
    pending = s;
    state.prefs = s.preferences || []; state.askedTopics = s.askedTopics || state.askedTopics;
    state.relax = s.relax?.prefId ? s.relax : null;
    if (!(s.showResults && s.results?.length)) skeleton.remove();
  };
  let paintQueued = false;
  const paint = () => { paintQueued = false; bubble.querySelector(".bubble").innerHTML = md(replyText.trim()); scrollToEnd(false); };
  const onDelta = (t) => {
    if (!gotText) { gotText = true; bubble.querySelector(".avatar").classList.remove("thinking"); renderBrief(state.prefs); }
    if (!inFollow) {
      replyText += t;
      const i = replyText.indexOf("===");
      if (i >= 0) { inFollow = true; followText = replyText.slice(i + 3); replyText = replyText.slice(0, i); paint(); showCards(); }
      else if (!paintQueued) { paintQueued = true; requestAnimationFrame(paint); }
    } else followText += t;
  };
  const finish = () => {
    if (!gotText) renderBrief(state.prefs);
    paint(); showCards();
    if (state.relax) { const r = state.relax; const pref = state.prefs.find((p) => p.id === r.prefId); if (pref) {
      const a = document.createElement("button"); a.className = "inline-action"; a.textContent = `Drop ${pref.label}`;
      a.onclick = () => { a.remove(); send(`Drop "${pref.label}" and show me those.`); };
      bubble.querySelector(".bubble").appendChild(a); } }
    if (followText.trim()) addMsg("scout", md(followText.trim()));
    state.messages.push({ role: "assistant", content: replyText.trim() + (followText.trim() ? "\n" + followText.trim() : "") });
    scrollToEnd();
  };
  try {
    if (MOCK) await mockRespond(onState, onDelta); else await callScout(onState, onDelta);
    finish();
  } catch (err) {
    console.error(err); skeleton.remove(); bubble.remove();
    const m = addMsg("scout", esc(err.message && /limit/.test(err.message) ? err.message : "I lost my train of thought. Give me a second and try again."));
    if (!/limit/.test(err.message || "")) { const r = document.createElement("button"); r.className = "inline-action"; r.textContent = "Try again"; r.onclick = () => { m.remove(); ask(); }; m.querySelector(".bubble").appendChild(r); }
  } finally { state.busy = false; el.composer.classList.remove("busy"); orb?.setState(0); }
}
async function callScout(onState, onDelta) {
  const res = await fetch(API_BASE + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: state.messages, preferences: state.prefs.filter((p) => p.changed !== "removed").map(({ changed, ...p }) => p), lastResults: state.lastResults, askedTopics: state.askedTopics, turn: state.turn }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "state") onState(ev); else if (ev.type === "delta") onDelta(ev.text); else if (ev.type === "error") throw new Error(ev.error);
    }
  }
}

/* ---------- scripted fallback (no API) ---------- */
async function mockRespond(onState, onDelta) {
  await wait(700);
  const text = state.messages.filter((m) => m.role === "user").slice(-1)[0].content.toLowerCase();
  let prefs = state.prefs.filter((p) => p.changed !== "removed").map((p) => ({ ...p, changed: "unchanged" }));
  const upsert = (id, label, sentence, source = "said", scope = "standing") => { const i = prefs.findIndex((p) => p.id === id); if (i >= 0) prefs[i] = { ...prefs[i], label, sentence, source, scope, changed: "updated" }; else prefs.push({ id, label, sentence, source, scope, changed: "added" }); };
  const beds = text.match(/(\d)\s*-?\s*(bed|br|bhk)/); if (beds) upsert("beds", `${beds[1]}-bed`, `you want ${beds[1]} bedrooms`);
  const budget = text.match(/(\d{2,3})\s*k/); if (budget) upsert("budget", `under ${budget[1]}k`, `your budget is up to AED ${budget[1]}k a year`);
  for (const [k, c, label] of [["jvc", "Jumeirah Village Circle", "JVC"], ["jlt", "Jumeirah Lakes Towers", "JLT"], ["marina", "Dubai Marina", "Marina"], ["difc", "DIFC", "near DIFC"], ["downtown", "Downtown Dubai", "Downtown"]]) if (text.includes(k)) upsert("area", label, `you'd like to be in ${c}`, k === "difc" ? "assumed" : "said");
  if (/furnished/.test(text) && !/unfurnished/.test(text)) upsert("furn", "furnished", "you want it furnished");
  if (/cat|dog|pet/.test(text)) upsert("pets", "pet-friendly", "the building needs to allow pets", "assumed");
  if (/not important|drop/.test(text)) { const t = prefs.find((p) => text.includes(p.label.toLowerCase()) || text.includes(p.sentence.toLowerCase().slice(0, 18))); if (t) t.changed = "removed"; }
  const live = prefs.filter((p) => p.changed !== "removed"); const w = Object.fromEntries(live.map((p) => [p.id, p]));
  const results = LISTINGS.filter((l) => (!w.beds || l.beds === +w.beds.label[0]) && (!w.budget || l.rentAed <= +w.budget.label.replace(/\D/g, "") * 1000) && (!w.furn || l.furnished) && (!w.area || w.area.sentence.includes(l.community) || (w.area.label === "near DIFC" && ["DIFC", "Business Bay", "Downtown Dubai"].includes(l.community)))).sort((a, b) => a.rentAed - b.rentAed).slice(0, 5);
  const ids = results.map((l) => l.id);
  onState({ preferences: prefs, filters: { maxRent: w.budget ? +w.budget.label.replace(/\D/g, "") * 1000 : null }, askedTopics: state.askedTopics, results: ids, newIds: ids.filter((i) => !state.lastResults.includes(i)), showResults: ids.length > 0, resultsNote: "", relax: null });
  const changed = live.filter((p) => p.changed !== "unchanged").map((p) => p.label);
  let reply = ids.length ? `${changed.length ? "Noted " + changed.join(" and ") + " — " : ""}${ids.length} place${ids.length > 1 ? "s" : ""} fit, from ${Math.round(results[0].rentAed / 1000)}k in ${results[0].community}.` : `Nothing fits all of that yet — tell me what you'd bend on.`;
  if (!w.budget && ids.length) reply += "\n===\nWhat's your budget for the year, roughly?";
  for (const word of reply.split(" ")) { onDelta(word + " "); await wait(18); }
}

/* ---------- demo scenarios (staged through the live model) ---------- */
const SCENARIOS = {
  noresults: ["A furnished 3-bed villa in Mirdif under 150k", "Okay, go up to 180k"],
  changeofmind: ["2-bed near my office in DIFC, around 130k a year. I have a dog", "Actually I can go to 150k if there's a pool", "Just for now, show me anything under 110k", "Being near DIFC isn't important, drop it"],
};
async function runScenario(key) {
  const steps = SCENARIOS[key]; if (!steps) return;
  location.hash = ""; if (state.started) { location.reload(); sessionStorage.setItem("scenario", key); return; }
  for (const s of steps) { await send(s); while (state.busy) await wait(200); await wait(1400); }
}
const pending = sessionStorage.getItem("scenario"); if (pending) { sessionStorage.removeItem("scenario"); setTimeout(() => runScenario(pending), 600); }

/* ---------- placeholder ticker (first screen only) ---------- */
const HINTS = ["Ask Scout…", "2-bed in Marina under 120k", "Villa with a garden in Arabian Ranches", "Somewhere quiet, near a metro", "Furnished studio, monthly payments", "I have a dog and a budget of 90k", "Townhouse near good schools"];
const hint = $("hint");
let hintI = 0, hintTimer = null;
function hintVisible() { return !state.started && document.activeElement !== el.input && !el.input.value; }
function tickHint() {
  if (state.started) { stopHints(); return; }
  if (!hintVisible()) return;
  const cur = hint.querySelector(".hint-text");
  const next = document.createElement("span"); next.className = "hint-text in";
  hintI = (hintI + 1) % HINTS.length; next.textContent = HINTS[hintI];
  hint.appendChild(next); cur.classList.add("out");
  requestAnimationFrame(() => requestAnimationFrame(() => next.classList.remove("in")));
  setTimeout(() => cur.remove(), 420);
}
function stopHints() { clearInterval(hintTimer); hintTimer = null; hint.hidden = true; el.input.placeholder = "Ask Scout…"; }
function syncHint() { hint.hidden = !hintVisible(); }
el.input.placeholder = ""; hintTimer = setInterval(tickHint, 3200);
el.input.addEventListener("focus", syncHint); el.input.addEventListener("blur", syncHint); el.input.addEventListener("input", syncHint);

/* ---------- wiring ---------- */
el.composer.addEventListener("submit", (e) => { e.preventDefault(); send(el.input.value); });
el.input.addEventListener("input", () => el.composer.classList.toggle("has-text", el.input.value.trim().length > 0));
el.input.addEventListener("focus", () => setTimeout(() => scrollToEnd(false), 250));
document.addEventListener("click", (e) => { const pill = e.target.closest(".pill[data-text]"); if (pill) send(pill.dataset.text); if (!e.target.closest("#menu,#menuBtn")) el.menu.hidden = true; });
el.mic.addEventListener("click", () => toast("Voice is next — type for now"));
el.brief.addEventListener("click", openSheet);
el.backdrop.addEventListener("click", closeSheet);
(() => {
  const h = el.sheet.querySelector(".handle"); let y0 = null, dy = 0;
  const start = (e) => { y0 = (e.touches ? e.touches[0] : e).clientY; dy = 0; el.sheet.style.transition = "none"; };
  const move = (e) => { if (y0 == null) return; dy = Math.max(0, (e.touches ? e.touches[0] : e).clientY - y0); el.sheet.style.transform = `translateY(${dy}px)`; };
  const end = () => { if (y0 == null) return; el.sheet.style.transition = ""; y0 = null; if (dy > 70) { el.sheet.style.transform = ""; closeSheet(); } else el.sheet.style.transform = ""; };
  h.addEventListener("touchstart", start, { passive: true }); h.addEventListener("touchmove", move, { passive: true }); h.addEventListener("touchend", end);
  h.addEventListener("mousedown", start); window.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
})();
el.sheetBody.addEventListener("click", (e) => { const t = e.target.closest(".term"); if (!t) return hidePopover(); e.stopPropagation(); showPopover(t); });
el.popover.addEventListener("click", (e) => { const b = e.target.closest("button[data-move]"); if (!b || !activeTerm) return; const pref = state.prefs.find((p) => p.id === activeTerm.dataset.id); if (pref) moveOnPref(b.dataset.move, pref); });
el.menuBtn.addEventListener("click", (e) => { e.stopPropagation(); el.menu.hidden = !el.menu.hidden; });
el.menu.addEventListener("click", (e) => { const b = e.target.closest("button[data-action]"); if (!b) return; el.menu.hidden = true;
  if (b.dataset.action === "restart") location.reload(); else runScenario(b.dataset.action); });
window.visualViewport?.addEventListener("resize", () => scrollToEnd(false));
