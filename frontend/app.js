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
let modelInfo = { models: [], tiers: {} };
let runChoice = null;      // model choice of the run in progress

const KEY_STORE = "anviksha.key";
const MODEL_STORE = "anviksha.model";
const $ = (id) => document.getElementById(id);
const fmt = (v) => (v == null ? "–" : Number(v).toFixed(2));

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

// ---------------------------------------------------------------- dot-matrix agent icons
// 9x9 bitmaps drawn as dots. Each dot carries its distance from the centre (--d)
// so CSS can ripple outward while the agent works. Unknown agents get the fallback.

const GLYPHS = {
  retrieve: [".#####...", "#.....#..", "#.....#..", "#.....#..", "#.....#..", ".#####...", "......##.", ".......##", "........#"],
  summarize: ["#########", ".........", "#######..", ".........", "#####....", ".........", "###......", ".........", "#........"],
  find_gaps: ["###.###.#", "###.###.#", "###.###.#", ".........", "###.....#", "###.....#", "###.....#", ".........", "###.###.#"],
  propose: ["....#....", ".#..#..#.", "..#...#..", "...###...", "#.#####.#", "...###...", "..#...#..", ".#..#..#.", "....#...."],
  critique: [".........", "..#####..", ".#.....#.", "#..###..#", "#..###..#", "#..###..#", ".#.....#.", "..#####..", "........."],
  verify: ["#########", "#.......#", "#......##", "#.....#.#", "##...#..#", "#.#.#...#", "#..#....#", "#.......#", "#########"],
  decide: ["....#....", "...#.#...", "..#...#..", ".#.....#.", "#...#...#", ".#.....#.", "..#...#..", "...#.#...", "....#...."],
  design_experiment: ["...###...", "....#....", "....#....", "...#.#...", "..#...#..", ".#.....#.", "#.#####.#", "#########", ".#######."],
  write: ["######...", "#....##..", "#.###.##.", "#......##", "#.#####.#", "#.......#", "#.#####.#", "#.......#", "#########"],
  fallback: ["#########", "#.......#", "#.#####.#", "#.#...#.#", "#.#.#.#.#", "#.#...#.#", "#.#####.#", "#.......#", "#########"],
};

function glyphDots(name, cell = 1, offset = 0, r = 0.36) {
  const rows = GLYPHS[name] || GLYPHS.fallback;
  let out = "";
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== "#") return;
    const d = Math.hypot(x - 4, y - 4).toFixed(1);
    out += `<circle cx="${(x + 0.5) * cell + offset}" cy="${(y + 0.5) * cell + offset}" r="${r * cell}" style="--d:${d}"/>`;
  }));
  return out;
}

function glyph(name, className = "glyph") {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg class="${className}" viewBox="0 0 9 9" aria-hidden="true">${glyphDots(name)}</svg>`;
  return tpl.content.firstChild;
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
    return el("p", {}, `${state.final_paper.split(/\s+/).length} words. `, el("a", { href: "#/paper", textContent: "Read the paper" }));
  },
};

function genericView(key) {
  const out = Object.fromEntries(byName[key].outputs.filter((k) => k in state).map((k) => [k, state[k]]));
  return Object.keys(out).length ? el("pre", { className: "plan", textContent: JSON.stringify(out, null, 2) }) : null;
}

function skeleton() {
  return el("div", { className: "skel", ariaHidden: "true" }, el("i"), el("i"), el("i"));
}

function liveView(key) {
  const now = el("p", { className: "live-now", textContent: live[key]?.say || "Starting…" });
  // Placeholder bars until the first words stream in.
  const text = live[key]?.text ? el("pre", { className: "live-text", textContent: live[key].text }) : skeleton();
  return el("div", { className: "live" }, now, text);
}

// ---------------------------------------------------------------- panels and view state
// Every agent gets a panel in the grid; Paper and Activity panels are static in the HTML.
// Panels can be collapsed (body hidden) or hidden (removed from the grid); the choice persists.

const VIEW_STORE = "anviksha.view";
const SPAN = { summarize: "2", propose: "2", design_experiment: "2" };  // wider panels for longer output
let view = { hidden: [], collapsed: [] };
try { view = { ...view, ...JSON.parse(localStorage.getItem(VIEW_STORE) || "{}") }; } catch { /* storage blocked */ }

const ICON = {
  collapse: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4"/></svg>',
  hide: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>',
};

const panels = () => [...$("grid").querySelectorAll(".panel")];
const panelTitle = (p) => p.querySelector("h3").textContent;

function saveView() {
  try { localStorage.setItem(VIEW_STORE, JSON.stringify(view)); } catch { /* storage blocked */ }
}

function toggleIn(list, id, on = !view[list].includes(id)) {
  view[list] = view[list].filter((x) => x !== id);
  if (on) view[list].push(id);
  saveView();
  applyView();
}

function addControls(panel) {
  const id = panel.dataset.panel;
  const title = panelTitle(panel);
  const collapse = el("button", { type: "button", className: "icon-btn collapse", innerHTML: ICON.collapse,
    ariaLabel: `Collapse ${title}` });
  collapse.addEventListener("click", () => toggleIn("collapsed", id));
  const hide = el("button", { type: "button", className: "icon-btn", innerHTML: ICON.hide, ariaLabel: `Hide ${title}` });
  hide.addEventListener("click", () => toggleIn("hidden", id, true));
  panel.querySelector(".panel-ctl").replaceChildren(collapse, hide);
}

function buildPanels() {
  $("grid").querySelectorAll("[data-agent]").forEach((p) => p.remove());
  $("strip").replaceChildren();
  const anchor = $("panel-activity");
  AGENTS.forEach((agent, i) => {
    const panel = el("article", { className: "panel reveal", id: `cell-${agent.name}` },
      el("header", { className: "panel-head" },
        el("span", { className: "idx" }, glyph(agent.name), String(i + 1).padStart(2, "0")),
        el("h3", { textContent: agent.title }),
        el("div", { className: "panel-ctl" }),
        el("p", { className: "role", textContent: agent.description }),
        el("span", { className: "cell-status" })),
      el("div", { className: "panel-body" }));
    panel.dataset.panel = agent.name;
    panel.dataset.agent = "";
    panel.dataset.span = SPAN[agent.name] || "1";
    panel.style.setProperty("--delay", `${(i % 3) * 70}ms`);
    $("grid").insertBefore(panel, anchor);
    $("strip").append(el("li", { title: agent.title }));
    phase[agent.name] = "idle";
  });
  panels().forEach((p) => { addControls(p); p.classList.add("reveal"); });

  $("chips").replaceChildren(...panels().map((p) => {
    const chip = el("button", { type: "button", className: "chip", textContent: panelTitle(p) });
    chip.dataset.panel = p.dataset.panel;
    chip.addEventListener("click", () => toggleIn("hidden", p.dataset.panel));
    return chip;
  }));
  applyView();
  buildAgentList();
  buildGraph();
  observeReveal();
}

// Sidebar: one row per agent with status and a rerun button.
function buildAgentList() {
  $("agent-list").replaceChildren(...AGENTS.map((agent) => {
    const jump = el("button", { type: "button", className: "agent-jump", textContent: agent.title,
      title: `Show the ${agent.title} panel` });
    jump.addEventListener("click", () => focusPanel(agent.name));
    const rerun = el("button", { type: "button", className: "rerun", textContent: "Rerun",
      ariaLabel: `Rerun ${agent.title} and every step after it` });
    rerun.addEventListener("click", () => run(agent.name));
    const li = el("li", {}, glyph(agent.name), jump, rerun, el("span", { className: "agent-meta" }));
    li.dataset.agent = agent.name;
    return li;
  }));
}

function focusPanel(name) {
  view.hidden = view.hidden.filter((x) => x !== name);
  view.collapsed = view.collapsed.filter((x) => x !== name);
  saveView();
  applyView();
  if (screen() !== "flow") location.hash = "#/flow";
  requestAnimationFrame(() => $(`cell-${name}`)?.scrollIntoView({ block: "center" }));
}

function applyView() {
  for (const p of panels()) {
    const id = p.dataset.panel;
    const collapsed = view.collapsed.includes(id);
    p.hidden = view.hidden.includes(id);
    p.toggleAttribute("data-collapsed", collapsed);
    const btn = p.querySelector(".icon-btn.collapse");
    btn.ariaLabel = `${collapsed ? "Expand" : "Collapse"} ${panelTitle(p)}`;
    btn.setAttribute("aria-expanded", String(!collapsed));
  }
  for (const chip of $("chips").children) {
    const shown = !view.hidden.includes(chip.dataset.panel);
    chip.setAttribute("aria-pressed", String(shown));
    chip.title = shown ? "Click to hide this panel" : "Click to show this panel";
  }
}

$("expand-all").addEventListener("click", () => { view.collapsed = []; saveView(); applyView(); });
$("collapse-all").addEventListener("click", () => { view.collapsed = panels().map((p) => p.dataset.panel); saveView(); applyView(); });
$("show-all").addEventListener("click", () => { view.hidden = []; saveView(); applyView(); });

// ---------------------------------------------------------------- agent map (Flow screen)
// Agents as dot-glyph nodes. A bright packet travels each hand-off; a working agent
// ripples with orbiting dots; a rejected hypothesis draws an amber loop back.

const SVGNS = "http://www.w3.org/2000/svg";
const graph = { pos: {}, narrow: null, svg: null };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function linkPath(a, b) {
  const [ax, ay] = graph.pos[a];
  const [bx, by] = graph.pos[b];
  if (graph.narrow && ay !== by) return `M${ax} ${ay} C${ax} ${(ay + by) / 2} ${bx} ${(ay + by) / 2} ${bx} ${by}`;
  return `M${ax} ${ay} C${(ax + bx) / 2} ${ay} ${(ax + bx) / 2} ${by} ${bx} ${by}`;
}

function loopPath(a, b) {  // from a back to an earlier agent b, arcing above
  const [ax, ay] = graph.pos[a];
  const [bx, by] = graph.pos[b];
  const lift = graph.narrow ? 70 : 95;
  return `M${ax} ${ay - 26} C${ax} ${ay - lift} ${bx} ${by - lift} ${bx} ${by - 26}`;
}

function buildGraph() {
  const fig = $("constellation");
  const width = fig.clientWidth;
  if (!width || !ORDER.length) return;  // hidden screen: rebuilt when shown
  graph.narrow = width < 640;
  const n = ORDER.length;
  let w;
  let h;
  if (graph.narrow) {  // 3-column snake
    w = 360;
    h = Math.ceil(n / 3) * 140 + 30;
    ORDER.forEach((k, i) => {
      const row = Math.floor(i / 3);
      const col = row % 2 ? 2 - (i % 3) : i % 3;
      graph.pos[k] = [60 + col * 120, 80 + row * 140];
    });
  } else {
    w = 1000;
    h = 250;
    ORDER.forEach((k, i) => (graph.pos[k] = [60 + (i * 880) / (n - 1), 125 + Math.sin(i * 1.1) * 24]));
  }

  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Agent pipeline. Select an agent to see its panel." });
  const edges = svgEl("g");
  ORDER.slice(1).forEach((k, i) => edges.append(svgEl("path", { class: "edge", d: linkPath(ORDER[i], k), "data-from": ORDER[i] })));
  const loops = svgEl("g", { id: "graph-loops" });
  const packets = svgEl("g", { id: "graph-packets" });
  const nodes = svgEl("g");
  AGENTS.forEach((agent) => {
    const [x, y] = graph.pos[agent.name];
    const node = svgEl("g", { class: "node", transform: `translate(${x} ${y})`, tabindex: "0", role: "button",
      "aria-label": `${agent.title}: show panel` });
    node.dataset.node = agent.name;
    const orbit = svgEl("g", { class: "orbit" });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      orbit.append(svgEl("circle", { cx: (Math.cos(a) * 34).toFixed(1), cy: (Math.sin(a) * 34).toFixed(1), r: i % 3 ? 1 : 1.8 }));
    }
    const art = svgEl("g", { class: "art" });
    art.innerHTML = glyphDots(agent.name, 4.4, -19.8, 0.36);
    const title = svgEl("text", { class: "t", y: 52 });
    title.textContent = agent.title;
    const sub = svgEl("text", { class: "sub", y: 67 });
    node.append(svgEl("circle", { class: "mask", r: 28 }), orbit, art, title, sub);
    node.addEventListener("click", () => focusPanel(agent.name));
    node.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), focusPanel(agent.name)));
    nodes.append(node);
  });
  svg.append(edges, loops, packets, nodes);
  fig.replaceChildren(svg);
  graph.svg = svg;
  renderGraph();
}

function renderGraph() {
  if (!graph.svg) return;
  for (const node of graph.svg.querySelectorAll(".node")) {
    const k = node.dataset.node;
    node.dataset.state = phase[k];
    const t = took[k] != null ? ` ${took[k].toFixed(1)}s` : "";
    node.querySelector(".sub").textContent = { idle: "waiting", active: "working", done: `done${t}`, retry: `sent back${t}` }[phase[k]];
  }
  for (const edge of graph.svg.querySelectorAll(".edge")) {
    edge.classList.toggle("lit", phase[edge.dataset.from] === "done");
  }
}

// A comet of three dots travelling from one agent to the next.
function sendPacket(from, to, back = false) {
  if (!graph.svg || reduceMotion || !graph.pos[from] || !graph.pos[to]) return;
  const d = back ? loopPath(from, to) : linkPath(from, to);
  if (back && !graph.svg.querySelector(`#graph-loops [data-key="${from}-${to}"]`)) {
    const loop = svgEl("path", { class: "loop", d });
    loop.dataset.key = `${from}-${to}`;
    $("graph-loops").append(loop);
  }
  [3.4, 2.4, 1.6].forEach((r, i) => {
    const dot = svgEl("circle", { class: back ? "packet back" : "packet", r, opacity: 1 - i * 0.3 });
    const motion = svgEl("animateMotion", { dur: back ? "1.1s" : "0.7s", begin: "indefinite", fill: "freeze", path: d,
      calcMode: "spline", keyTimes: "0;1", keySplines: "0.4 0 0.2 1" });
    dot.append(motion);
    $("graph-packets").append(dot);
    setTimeout(() => motion.beginElement(), i * 45);
    setTimeout(() => dot.remove(), back ? 1300 : 900);
  });
}

// Model a step uses: its tier's model in Auto mode, otherwise the forced model.
function modelFor(key, choice = runChoice || $("model").value) {
  const tier = byName[key]?.tier;
  if (!tier) return "";
  return (choice === "auto" ? modelInfo.tiers[tier] : choice) || "";
}

function statusText(key) {
  const t = took[key] != null ? ` in ${took[key].toFixed(1)}s` : "";
  const text = { idle: "Waiting", active: "Working", done: `Done${t}`, retry: `Sent back${t}` }[phase[key]];
  const model = modelFor(key).replace(/^[^/]+\//, "");
  return model ? `${text}, ${model}` : text;
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
  const body = phase[key] === "active" ? liveView(key) : (VIEWS[key] || genericView)(key);
  cell.querySelector(".panel-body").replaceChildren(...(body ? [body] : []));
  $("strip").children[i].dataset.state = phase[key];
  const chip = $("chips").querySelector(`[data-panel="${key}"]`);
  if (chip) chip.dataset.state = phase[key];
  const row = $("agent-list").querySelector(`[data-agent="${key}"]`);
  if (row) {
    row.dataset.state = phase[key];
    row.querySelector(".agent-meta").textContent = statusText(key);
    row.querySelector(".rerun").disabled = !canRerun(i);
  }
}

function renderPaperScreen() {
  const paper = state.final_paper || live.write?.text || "";
  $("paper-blank").hidden = !!paper;
  $("paper-layout").hidden = !paper;
  if (state.final_paper) $("paper-text").textContent = state.final_paper;
  $("paper-text").classList.toggle("live", !state.final_paper && !!paper);
  ["copy-btn", "txt-btn", "print-btn"].forEach((id) => ($(id).disabled = !state.final_paper || !!controller));

  const summary = $("paper-summary");
  summary.replaceChildren();
  if (state.hypothesis) {
    summary.append(
      el("p", { className: "side-label", textContent: "Hypothesis" }),
      el("p", { className: "meta-hyp", textContent: state.hypothesis }),
      el("div", { className: "meta-line" }, "Confidence", el("b", { textContent: fmt(state.confidence) })),
      el("div", { className: "meta-line" }, "Verdict",
        el("b", { textContent: state.confidence == null ? "–" : state.approved ? "Approved" : "Below threshold" })),
      el("div", { className: "meta-line" }, "Attempts", el("b", { textContent: state.attempts || "–" })));
  }
  $("paper-refs").replaceChildren(...(state.papers || []).map((p) => el("li", {},
    /^https:\/\//.test(p.url || "") ? el("a", { href: p.url, target: "_blank", rel: "noopener", textContent: p.title }) : p.title,
    ` (${p.published?.slice(0, 4) || "n.d."})`)));
}

function render() {
  ORDER.forEach(renderCell);

  $("r-attempt").textContent = state.attempts ? `${state.attempts}/${cfg.max_attempts}` : "–";
  $("r-sources").textContent = state.papers ? state.papers.length : "–";
  $("r-confidence").textContent = fmt(state.confidence);
  $("r-confidence").dataset.tone = state.confidence != null && !state.approved ? "warn" : "";

  renderPaperScreen();
  renderGraph();
  $("flow-blank").hidden = !!state.topic;
  $("side-topic").textContent = state.topic || "No inquiry yet";
  const choice = runChoice || $("model").value;
  $("side-model").textContent = choice === "auto" ? "Model: Auto, best per step" : `Model: ${choice}`;
  $("stop-btn").hidden = !controller;

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
  if (byName[node]?.outputs.includes("final_paper")) {
    $("paper-text").textContent = entry.text;
    if ($("paper-layout").hidden) renderPaperScreen();
  }
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
  if (next) sendPacket(node, next, ORDER.indexOf(next) < ORDER.indexOf(node));
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
  $("model").disabled = on;
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
  runChoice = $("model").value;
  controller = new AbortController();
  lastTick = performance.now();
  setRunning(true);
  if (from > 0) focusPanel(start);
  else location.hash = "#/flow";
  graph.svg?.querySelectorAll("#graph-loops path").forEach((p) => p.remove());

  try {
    const headers = { "Content-Type": "application/json" };
    const key = $("access-key").value.trim();
    if (key) headers["X-Access-Key"] = key;
    const res = await fetch("/api/run", {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ topic: state.topic, start, state: seed, model: runChoice }),
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
    if (state.final_paper) setTimeout(() => (location.hash = "#/paper"), 900);  // let the last packet land
  } catch (err) {
    showAlert(err.name === "AbortError" ? "Stopped. Finished steps are kept; rerun from any agent to continue." : err.message);
    ORDER.forEach((k) => { if (phase[k] === "active") phase[k] = "idle"; });
  } finally {
    controller = null;
    runChoice = null;
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

$("stop-btn").addEventListener("click", () => controller?.abort());

$("side-toggle").addEventListener("click", () => {
  const open = $("side-toggle").getAttribute("aria-expanded") !== "true";
  $("side-toggle").setAttribute("aria-expanded", String(open));
});

// ---------------------------------------------------------------- screens
// Hash routes: #/ (ask), #/flow, #/paper. Other hashes (skip link) are left alone.

const SCREENS = ["ask", "flow", "paper"];
const screen = () => document.body.dataset.screen;

function route() {
  const hash = location.hash;
  if (hash && !hash.startsWith("#/")) return;
  const name = SCREENS.includes(hash.slice(2)) ? hash.slice(2) : "ask";
  const changed = screen() !== name;
  document.body.dataset.screen = name;
  document.querySelectorAll("[data-screen]:not(body)").forEach((s) => (s.hidden = s.dataset.screen !== name));
  $("app").hidden = name === "ask";
  document.querySelectorAll(".steps a").forEach((a) => {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (name === "ask") field.relayout();
  if (name === "flow") buildGraph();
  if (changed) {
    scrollTo(0, 0);
    const heading = document.querySelector(`#screen-${name} h1, #screen-${name} h2`);
    heading?.focus({ preventScroll: true });
  }
  observeReveal();
}
addEventListener("hashchange", route);

let resizeGraph;
addEventListener("resize", () => {
  clearTimeout(resizeGraph);
  resizeGraph = setTimeout(() => {
    if (screen() === "flow" && graph.narrow !== $("constellation").clientWidth < 640) buildGraph();
  }, 150);
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
    else setStatus("ok", "Groq online");
    if (!ORDER.length) {
      await Promise.all([loadModels(), loadAgents()]);
      finishBoot();
    }
  } catch {
    setStatus("down", "Offline");
    if (!ORDER.length) finishBoot("Server unreachable. Retrying every 30 seconds.");
  }
}

async function loadModels() {
  const res = await fetch("/api/models");
  modelInfo = await res.json();
  const select = $("model");
  select.replaceChildren(
    el("option", { value: "auto", textContent: "Auto: best model for each step" }),
    ...modelInfo.models.map((id) => el("option", { value: id, textContent: `${id} for every step` })));
  let saved = "";
  try { saved = localStorage.getItem(MODEL_STORE) || ""; } catch { /* storage blocked */ }
  select.value = [...select.options].some((o) => o.value === saved) ? saved : "auto";
}

$("model").addEventListener("change", () => {
  try { localStorage.setItem(MODEL_STORE, $("model").value); } catch { /* storage blocked */ }
  if (ORDER.length) render();
});

async function loadAgents() {
  const res = await fetch("/api/agents");
  const data = await res.json();
  cfg = { max_attempts: data.max_attempts, threshold: data.threshold };
  AGENTS = data.agents;
  ORDER = AGENTS.map((a) => a.name);
  AGENTS.forEach((a) => (byName[a.name] = a));
  buildPanels();
  render();
}

// ---------------------------------------------------------------- boot loader, scroll reveal, scroll progress

document.documentElement.classList.add("js");

function lemniscate(n, cx, cy, a) {
  return Array.from({ length: n }, (_, i) => {
    const u = (i / n) * Math.PI * 2;
    const d = 1 + Math.sin(u) ** 2;
    return [cx + (a * Math.cos(u)) / d, cy + (a * Math.sin(u) * Math.cos(u)) / d, Math.abs(Math.cos(u))];
  });
}

// Dots light up one after another around the loop, like the agents taking turns.
const BOOT_DOTS = 22;
$("boot-mark").innerHTML = lemniscate(BOOT_DOTS, 16, 16, 13.5).map(([x, y, w], i) =>
  `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${(0.75 + 0.7 * w).toFixed(2)}" style="animation-delay:${((i / BOOT_DOTS) * 1.4).toFixed(2)}s"/>`).join("");
const bootStarted = performance.now();

function finishBoot(message) {
  if (message) $("boot-text").textContent = message;
  // Hold briefly so the loader never flashes, longer when there is a message to read.
  const wait = Math.max(0, (message ? 1600 : 700) - (performance.now() - bootStarted));
  setTimeout(() => $("boot").classList.add("done"), wait);
}

const revealer = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px" })
  : null;

function observeReveal() {
  document.querySelectorAll(".reveal:not(.in)").forEach((node) => {
    if (revealer) revealer.observe(node);
    else node.classList.add("in");
  });
}

let scrollQueued = false;
window.addEventListener("scroll", () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    $("scroll-line").style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
    scrollQueued = false;
  });
}, { passive: true });

// ---------------------------------------------------------------- dot-matrix field
// A figure-eight of dots: the research loop. A bright pulse travels along it,
// faster while agents are working.

const field = (function field() {
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
    if (!w || !h) return;  // ask screen hidden; relayout when it is shown
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const narrow = w < 640;
    const cx = narrow ? w / 2 : w * 0.63;
    const cy = narrow ? h / 2 : h * 0.42;
    const a = narrow ? w * 0.4 : Math.min(w * 0.3, h * 0.62);
    const band = a * 0.13;
    const step = narrow ? 7 : 9;
    const curve = lemniscate(480, cx, cy, a).map(([x, y], i) => [x, y, i / 480]);
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
    if (screen() === "ask") draw();  // no work while another screen is showing
    requestAnimationFrame(frame);
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 150);
  });
  if (!still) requestAnimationFrame(frame);
  return { relayout: layout };
})();

try { $("access-key").value = localStorage.getItem(KEY_STORE) || ""; } catch { /* storage blocked */ }
document.querySelectorAll(".blank[data-glyph]").forEach((b) => b.prepend(glyph(b.dataset.glyph, "glyph big")));
route();
checkHealth();
setInterval(checkHealth, 30000);
