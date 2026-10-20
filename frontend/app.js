"use strict";

// The pipeline (order, names, descriptions, outputs) comes from GET /api/agents,
// so a new backend agent shows up here without frontend changes.
let AGENTS = [];
let ORDER = [];
const byName = {};

let cfg = { max_attempts: 3, threshold: 0.8 };
let state = {};
let history = [];          // earlier hypotheses in this run
const phase = {};          // node -> idle | active | done | retry
const took = {};           // node -> seconds
const live = {};           // node -> { say, text } while running
let controller = null;
let timer = null;
let lastTick = 0;

const KEY_STORE = "anviksha.key";
const $ = (id) => document.getElementById(id);
const fmt = (v) => (v == null ? "–" : Number(v).toFixed(2));

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

// ---------------------------------------------------------------- per-agent views
// Optional custom renderers keyed by agent name. Agents without one get a generic view.

function hint(text) {
  return el("p", { className: "hint", textContent: text });
}

function nameOf(key) {
  return byName[key]?.title || key;
}

const VIEWS = {
  retrieve() {
    if (!state.papers) return null;
    if (!state.papers.length) return el("p", { className: "empty", textContent: "No papers were found. The next agents work from general knowledge, so double-check their output. A broader question usually helps." });
    const copy = el("button", { type: "button", className: "small-btn", textContent: "Copy citations" });
    copy.addEventListener("click", () => copyText(copy, state.papers
      .map((p, i) => `[${i + 1}] ${p.title}. arXiv, ${p.published || "n.d."}. ${p.url}`).join("\n")));
    return el("div", {},
      el("ol", { className: "srcs" }, ...state.papers.map((p) => el("li", {},
        /^https:\/\//.test(p.url || "") ? el("a", { href: p.url, target: "_blank", rel: "noopener", textContent: p.title }) : p.title,
        el("div", { className: "meta", textContent: `Published ${p.published || "date unknown"}` }),
        el("details", {}, el("summary", { textContent: "Abstract" }), el("p", { textContent: p.abstract }))))),
      copy);
  },
  summarize() {
    if (!state.summaries) return null;
    return el("ol", { className: "sums" }, ...state.summaries.map((s) =>
      el("li", {}, el("strong", { textContent: s.title }), el("p", { textContent: s.summary }))));
  },
  find_gaps() {
    if (!state.gaps) return null;
    const note = hint(`One question per line. Edit freely, then rerun ${nameOf("propose")} to use your version.`);
    const area = el("textarea", { rows: Math.max(4, state.gaps.length * 2), value: state.gaps.join("\n"),
      disabled: !!controller, ariaLabel: "Open research questions, one per line" });
    area.addEventListener("input", () => {
      state.gaps = area.value.split("\n").map((s) => s.trim()).filter(Boolean);
      note.textContent = `Edited. Rerun ${nameOf("propose")} to use these questions.`;
      note.classList.add("edited");
    });
    return el("div", {}, area, note);
  },
  propose() {
    if (state.hypothesis == null) return null;
    const note = hint(`Attempt ${state.attempts || 1} of ${cfg.max_attempts}. Edit the idea, then rerun ${nameOf("critique")} to test your version.`);
    const area = el("textarea", { className: "hyp", rows: 3, value: state.hypothesis,
      disabled: !!controller, ariaLabel: "Hypothesis" });
    area.addEventListener("input", () => {
      state.hypothesis = area.value.trim();
      note.textContent = `Edited. Rerun ${nameOf("critique")} to check this idea.`;
      note.classList.add("edited");
    });
    return el("div", {}, area, note,
      history.length > 0 && el("div", { className: "history" }, "Ideas rejected earlier",
        el("ol", {}, ...history.map((h) => el("li", { textContent: `${h.hypothesis} (score ${fmt(h.confidence)})` })))));
  },
  critique() {
    if (state.critic_score == null) return null;
    return el("div", {},
      el("div", { className: "score" }, el("b", { textContent: fmt(state.critic_score) }), el("span", { textContent: "Reviewer score, 0 to 1" })),
      state.critic_reason && el("p", { className: "reason", textContent: state.critic_reason }));
  },
  verify() {
    if (state.hallucination_risk == null) return null;
    return el("div", { className: "score" }, el("b", { textContent: fmt(state.hallucination_risk) }),
      el("span", { textContent: "Risk of made-up claims, lower is better" }));
  },
  decide() {
    if (state.confidence == null) return null;
    const gauge = el("div", { className: "gauge" + (state.approved ? "" : " warn") }, el("i"), el("span", { className: "thr" }));
    gauge.firstChild.style.width = `${state.confidence * 100}%`;
    gauge.lastChild.style.left = `${cfg.threshold * 100}%`;
    const verdict = state.approved ? "Approved"
      : ORDER.indexOf(state.route) < ORDER.indexOf("decide") ? "Too low, sent back for a better idea" : "Still too low after all attempts, moving on";
    return el("div", {},
      el("div", { className: "score" }, el("b", { textContent: fmt(state.confidence) }),
        el("span", { textContent: `Overall score (60% reviewer, 40% grounding). Pass mark ${fmt(cfg.threshold)}` })),
      gauge,
      el("span", { className: "verdict " + (state.approved ? "ok" : "warn"), textContent: verdict }));
  },
  design_experiment() {
    return state.experiment_plan ? el("pre", { className: "plan", textContent: state.experiment_plan }) : null;
  },
  write() {
    if (!state.final_paper) return null;
    return el("p", {}, `${state.final_paper.split(/\s+/).length} words. `, el("a", { href: "#paper", textContent: "Read the paper" }));
  },
};

function genericView(key) {
  const out = Object.fromEntries(byName[key].outputs.filter((k) => k in state).map((k) => [k, state[k]]));
  return Object.keys(out).length ? el("pre", { className: "plan", textContent: JSON.stringify(out, null, 2) }) : null;
}

function liveView(key) {
  const now = el("p", { className: "live-now", textContent: live[key]?.say || "Starting…" });
  const text = live[key]?.text ? el("pre", { className: "live-text", textContent: live[key].text }) : null;
  return el("div", { className: "live" }, now, text);
}

// ---------------------------------------------------------------- cells

function buildCells() {
  $("cells").replaceChildren();
  $("strip").replaceChildren();
  AGENTS.forEach((agent, i) => {
    const rerun = el("button", { type: "button", className: "rerun", textContent: "Rerun from here",
      title: `Run ${agent.title} again, then every agent after it` });
    rerun.addEventListener("click", () => run(agent.name));
    $("cells").append(el("li", { className: "cell", id: `cell-${agent.name}` },
      el("div", { className: "cell-head" },
        el("span", { className: "idx", textContent: String(i + 1).padStart(2, "0") }),
        el("h3", { textContent: agent.title }),
        el("span", { className: "role", textContent: agent.description }),
        el("span", { className: "cell-status" }),
        rerun),
      el("div", { className: "cell-body" })));
    $("strip").append(el("li", { title: agent.title }));
    phase[agent.name] = "idle";
  });
}

function statusText(key) {
  const t = took[key] != null ? ` in ${took[key].toFixed(1)}s` : "";
  return { idle: "Waiting", active: "Working", done: `Done${t}`, retry: `Sent back${t}` }[phase[key]];
}

function canRerun(i) {
  if (controller || !state.topic) return false;
  return i === 0 || byName[ORDER[i - 1]].outputs.every((k) => k in state);
}

function renderCell(key) {
  const i = ORDER.indexOf(key);
  const cell = $(`cell-${key}`);
  cell.dataset.state = phase[key];
  cell.querySelector(".cell-status").textContent = statusText(key);
  cell.querySelector(".rerun").disabled = !canRerun(i);
  const body = phase[key] === "active" ? liveView(key) : (VIEWS[key] || genericView)(key);
  cell.querySelector(".cell-body").replaceChildren(...(body ? [body] : []));
  $("strip").children[i].dataset.state = phase[key];
}

function render() {
  ORDER.forEach(renderCell);

  $("r-attempt").textContent = state.attempts ? `${state.attempts}/${cfg.max_attempts}` : "–";
  $("r-sources").textContent = state.papers ? state.papers.length : "–";
  $("r-confidence").textContent = fmt(state.confidence);
  $("r-confidence").dataset.tone = state.confidence != null && !state.approved ? "warn" : "";

  if (state.final_paper) $("paper-text").textContent = state.final_paper;
  else if (!live.write?.text) $("paper-text").replaceChildren(el("p", { className: "empty", textContent: "The paper appears here, written live, once the earlier agents finish." }));
  ["copy-btn", "txt-btn", "print-btn"].forEach((id) => ($(id).disabled = !state.final_paper || !!controller));

  const active = ORDER.find((k) => phase[k] === "active");
  $("hero-tag").textContent = active ? `Working: ${nameOf(active)}` : state.final_paper ? "Run complete" : "Agents standing by";
  $("hero-tag").toggleAttribute("data-live", !!active);
  setNow(active ? live[active]?.say || `${nameOf(active)} is starting` : "");
}

function setNow(text) {
  $("now").textContent = text;
  $("nav-now").textContent = text;
}

// ---------------------------------------------------------------- stream events

function onStatus({ node, text }) {
  live[node] = { ...live[node], say: text };
  setNow(text);
  addActivity({ agent: nameOf(node), text, kind: "say" });
  const now = document.querySelector(`#cell-${node} .live-now`);
  if (now) now.textContent = text;
}

function onToken({ node, text }) {
  const entry = (live[node] = live[node] || { say: "" });
  entry.text = (entry.text || "") + text;
  const body = document.querySelector(`#cell-${node} .live`);
  if (body) {
    let pre = body.querySelector(".live-text");
    if (!pre) body.append((pre = el("pre", { className: "live-text" })));
    pre.textContent = entry.text;
    pre.scrollTop = pre.scrollHeight;
  }
  if (byName[node]?.outputs.includes("final_paper")) $("paper-text").textContent = entry.text;
}

function onUpdate(node, update) {
  const now = performance.now();
  took[node] = (now - lastTick) / 1000;
  lastTick = now;
  delete live[node];

  // A new hypothesis replaces the old one: remember it, then reset everything downstream.
  if ("hypothesis" in update && state.hypothesis && state.confidence != null) {
    history.push({ hypothesis: state.hypothesis, confidence: state.confidence });
  }
  ORDER.slice(ORDER.indexOf(node) + 1).forEach((k) => {
    if (phase[k] === "idle") return;
    byName[k].outputs.forEach((key) => delete state[key]);
    phase[k] = "idle";
    delete took[k];
  });

  for (const [k, v] of Object.entries(update || {})) if (k !== "messages") state[k] = v;
  (update.messages || []).forEach((m) => addActivity({ agent: m.agent, text: m.intent.replaceAll("_", " "),
    confidence: m.confidence, payload: m.payload }));

  let next = ORDER[ORDER.indexOf(node) + 1];
  if (update.route) {
    next = update.route;
    phase[node] = ORDER.indexOf(next) < ORDER.indexOf(node) ? "retry" : "done";
  } else {
    phase[node] = "done";
  }
  if (next) phase[next] = "active";
  render();
}

function addActivity({ agent, text, kind = "", confidence = null, payload = null }) {
  const list = $("log-list");
  list.querySelector(".empty")?.remove();
  list.append(el("li", { className: kind },
    el("time", { textContent: new Date().toLocaleTimeString([], { hour12: false }) }),
    el("span", { className: "who", textContent: agent }),
    el("span", { className: "what", textContent: text }),
    el("span", { className: "conf" + (confidence != null && confidence < cfg.threshold ? " low" : ""),
      textContent: confidence == null ? "" : fmt(confidence) }),
    payload && el("details", {}, el("summary", { textContent: "Data passed on" }),
      el("pre", { textContent: JSON.stringify(payload, null, 2) }))));
}

// ---------------------------------------------------------------- run

function showAlert(text) {
  $("alert").textContent = text;
  $("alert").hidden = !text;
}

function setRunning(on) {
  $("run-btn").textContent = on ? "Stop" : "Run inquiry";
  $("run-btn").toggleAttribute("data-running", on);
  $("topic").disabled = on;
  document.querySelectorAll(".example").forEach((b) => (b.disabled = on));
  clearInterval(timer);
  if (on) {
    const t0 = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $("r-elapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  render();
}

async function errorText(res) {
  try {
    const body = await res.json();
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) return "The research question must be between 3 and 200 characters.";
  } catch { /* not JSON */ }
  return `The server returned status ${res.status}.`;
}

// start = first agent runs from scratch; any other agent reruns from there with the current state.
async function run(start, topic = state.topic) {
  const from = ORDER.indexOf(start);
  if (from === 0) {
    state = { topic };
    history = [];
    $("log-list").replaceChildren();
  }
  ORDER.slice(from).forEach((k) => {
    byName[k].outputs.forEach((key) => delete state[key]);
    phase[k] = "idle";
    delete took[k];
    delete live[k];
  });
  phase[start] = "active";
  showAlert("");

  const { messages, ...seed } = state;
  controller = new AbortController();
  lastTick = performance.now();
  setRunning(true);
  if (from > 0) $(`cell-${start}`).scrollIntoView({ block: "center" });

  try {
    const headers = { "Content-Type": "application/json" };
    const key = $("access-key").value.trim();
    if (key) headers["X-Access-Key"] = key;
    const res = await fetch("/api/run", {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ topic: state.topic, start, state: seed }),
    });
    if (!res.ok) throw new Error(await errorText(res));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "status") onStatus(ev);
        else if (ev.type === "token") onToken(ev);
        else if (ev.type === "reset") live[ev.node] = { ...live[ev.node], text: "" };
        else if (ev.type === "update") onUpdate(ev.node, ev.update);
        else if (ev.type === "done") finished = true;
        else if (ev.type === "error") throw new Error(`The run stopped with an error: ${ev.text}`);
      }
    }
    if (!finished) throw new Error("The connection dropped before the run finished. Rerun from the agent that was working.");
  } catch (err) {
    showAlert(err.name === "AbortError" ? "Stopped. Finished steps are kept; rerun from any agent to continue." : err.message);
    ORDER.forEach((k) => { if (phase[k] === "active") phase[k] = "idle"; });
  } finally {
    controller = null;
    Object.keys(live).forEach((k) => delete live[k]);
    setRunning(false);
  }
}

$("run-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (controller) return controller.abort();
  if (!ORDER.length) return showAlert("The agent list has not loaded. Check the server is running, then reload.");
  const topic = $("topic").value.trim();
  if (topic.length < 3) return showAlert("Enter a research question of at least 3 characters.");
  try { localStorage.setItem(KEY_STORE, $("access-key").value.trim()); } catch { /* storage blocked */ }
  run(ORDER[0], topic);
});

document.querySelectorAll(".example").forEach((b) => b.addEventListener("click", () => {
  $("topic").value = b.textContent;
  $("topic").focus();
}));

// ---------------------------------------------------------------- paper export

async function copyText(btn, text) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy blocked by browser";
  }
  setTimeout(() => (btn.textContent = label), 1600);
}

$("copy-btn").addEventListener("click", () => copyText($("copy-btn"), state.final_paper));

$("txt-btn").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([state.final_paper], { type: "text/plain" }));
  const name = (state.topic || "anviksha").replace(/[^\w-]+/g, "_").slice(0, 60);
  el("a", { href: url, download: `${name}_paper.txt` }).click();
  URL.revokeObjectURL(url);
});

$("print-btn").addEventListener("click", () => window.print()); // print stylesheet isolates the paper

// ---------------------------------------------------------------- server status

function setStatus(kind, text) {
  $("status").dataset.state = kind;
  $("status-text").textContent = text;
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error();
    const h = await res.json();
    $("access-key").hidden = !h.key_required;
    if (!h.groq_configured) setStatus("warn", "GROQ_API_KEY missing");
    else setStatus("ok", h.model);
    if (!ORDER.length) await loadAgents();
  } catch {
    setStatus("down", "Offline");
  }
}

async function loadAgents() {
  const res = await fetch("/api/agents");
  const data = await res.json();
  cfg = { max_attempts: data.max_attempts, threshold: data.threshold };
  AGENTS = data.agents;
  ORDER = AGENTS.map((a) => a.name);
  AGENTS.forEach((a) => (byName[a.name] = a));
  buildCells();
  render();
}

// ---------------------------------------------------------------- dot-matrix field
// A figure-eight of dots: the research loop. A bright pulse travels along it,
// faster while agents are working.

(function field() {
  const canvas = $("field");
  const ctx = canvas.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let dots = [];
  let w = 0;
  let h = 0;
  let t = 0;
  let last = 0;

  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const narrow = w < 640;
    const cx = narrow ? w / 2 : w * 0.63;
    const cy = narrow ? h / 2 : h * 0.42;
    const a = narrow ? w * 0.4 : Math.min(w * 0.3, h * 0.62);
    const band = a * 0.13;
    const step = narrow ? 7 : 9;
    const curve = [];
    for (let i = 0; i < 480; i++) {
      const u = (i / 480) * Math.PI * 2;
      const d = 1 + Math.sin(u) ** 2;
      curve.push([cx + (a * Math.cos(u)) / d, cy + (a * Math.sin(u) * Math.cos(u)) / d, i / 480]);
    }
    dots = [];
    for (let y = step / 2; y < h; y += step) {
      if (Math.abs(y - cy) > a * 0.4 + band) continue;
      for (let x = step / 2; x < w; x += step) {
        if (Math.abs(x - cx) > a + band) continue;
        let best = Infinity;
        let at = 0;
        for (const [px, py, pt] of curve) {
          const dd = (px - x) ** 2 + (py - y) ** 2;
          if (dd < best) { best = dd; at = pt; }
        }
        const dist = Math.sqrt(best);
        // Ragged edge, like a halftone print.
        if (dist < band && Math.random() > (dist / band) ** 2 * 0.7) dots.push([x, y, at, 1 - dist / band]);
      }
    }
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (const [x, y, at, core] of dots) {
      let d = Math.abs(at - t);
      d = Math.min(d, 1 - d);
      const glow = Math.max(0, 1 - d * 7);
      ctx.fillStyle = `rgba(255,255,255,${0.22 + core * 0.38 + glow * 0.4})`;
      const s = 1.4 + glow * 1.2;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }

  function frame(ms) {
    const dt = last ? (ms - last) / 1000 : 0;
    last = ms;
    t = (t + dt * (controller ? 0.3 : 0.06)) % 1;
    draw();
    requestAnimationFrame(frame);
  }

  layout();
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 150);
  });
  if (!still) requestAnimationFrame(frame);
})();

try { $("access-key").value = localStorage.getItem(KEY_STORE) || ""; } catch { /* storage blocked */ }
checkHealth();
setInterval(checkHealth, 30000);
