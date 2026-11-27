/* 지표 사전 — 화면.
 *
 * 이 파일에는 지표 이름도, «무엇을 셀지»도 없다. metrics/ 폴더의 정의서(JSON)를 읽고 그대로 계산한다.
 * 정의서를 고치면 코드를 고치지 않아도 카드가 바뀐다.
 *
 * 정의서 한 장(JSON)에 들어 있는 것
 *   name · purpose · unit · kind("base" 테이블에서 계산 | "derived" 다른 지표로 계산)
 *   elements  분자 · 분모 · 기간 · 거르기 · 제외 · 최소 표본 — 빈 요소가 있으면 카드에 «정의 미완성»이 뜬다
 *   sql       numerator(와 denominator) 열을 돌려주는 SELECT. {month} · {month_start} · {month_end} 를 기준월로 바꿔 돌린다
 *   sources   어느 테이블의 어느 컬럼에서 오는지 (계보)
 *   rejected  버린 정의 — 이름 · SQL · 버린 이유. 같은 달 숫자를 나란히 보여 준다
 *   inputs · formula   derived 일 때: 다른 지표의 id 와 계산식 (예: a / b)
 *
 * DuckDB-WASM 이 브라우저 안에서 parquet 을 읽는다. 실행하는 SQL은 전부 «읽기 전용» 검사를 거친다.
 */
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MONTHS = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`);
const S = { db: null, conn: null, loaded: new Set(), schema: null, metrics: [], byId: {}, series: {}, month: "2025-12", dash: null, dashError: null };

// ── 엔진 ─────────────────────────────────────────────
async function startEngine() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  S.db = db;
  S.conn = await db.connect();
}

async function ensureTables(sql) {
  const names = Object.keys(S.schema.tables).filter(t => new RegExp(`\\b${t}\\b`, "i").test(sql));
  for (const t of names) {
    if (S.loaded.has(t)) continue;
    $("#engine").textContent = `테이블 «${t}» 받는 중…`;
    const buf = new Uint8Array(await (await fetch(`data/${t}.parquet`)).arrayBuffer());
    await S.db.registerFileBuffer(`${t}.parquet`, buf);
    await S.conn.query(`CREATE VIEW ${t} AS SELECT * FROM '${t}.parquet'`);
    S.loaded.add(t);
  }
}

const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|detach|copy|pragma|install|load|export|import|call|set)\b/i;
function readOnly(sql) {
  const s = String(sql || "").replace(/--[^\n]*/g, "").trim().replace(/;\s*$/, "").trim();
  if (!s || s.includes(";")) return null;
  if (!/^(select|with)\b/i.test(s)) return null;
  if (FORBIDDEN.test(s.replace(/'[^']*'/g, "''"))) return null;
  return s;
}

function monthParts(m) {
  const [y, mo] = m.split("-").map(Number);
  return { start: `${m}-01`, end: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10) };
}
function fill(sql, m) {
  const { start, end } = monthParts(m);
  return String(sql).replaceAll("{month_start}", start).replaceAll("{month_end}", end).replaceAll("{month}", m);
}

// 정의의 SQL 한 번 = 한 달의 분자(와 분모)
async function runDef(sql, m) {
  const safe = readOnly(fill(sql, m));
  if (!safe) throw new Error("읽기(SELECT · WITH)만 실행합니다. 한 문장만, 바꾸는 명령 없이.");
  await ensureTables(safe);
  const t = await S.conn.query(safe);
  const names = t.schema.fields.map(f => f.name.toLowerCase());
  if (!names.includes("numerator")) throw new Error("SQL이 numerator 열을 돌려주지 않습니다.");
  const r = t.toArray()[0];
  const get = k => { const f = t.schema.fields.find(x => x.name.toLowerCase() === k); return f ? r[f.name] : null; };
  const num = get("numerator"), den = names.includes("denominator") ? get("denominator") : null;
  return { num: num == null ? null : Number(num), den: den == null ? null : Number(den) };
}

// ── 정의서 읽기 · 점검 ───────────────────────────────────
const ELEMENTS = [["numerator", "분자"], ["denominator", "분모"], ["period", "기간"], ["filter", "거르기"], ["exclusion", "제외"]];
const blank = v => v == null || String(v).trim() === "";

function problems(m) {
  if (m.loadError) return [m.loadError];
  const p = [], e = m.elements || {};
  if (blank(m.name)) p.push("지표 이름이 없다");
  if (blank(m.purpose)) p.push("무엇을 재려는지(purpose)가 없다");
  for (const [k, label] of ELEMENTS) if (blank(e[k])) p.push(`${label}가 비어 있다`);
  if (!e.min_sample || blank(e.min_sample.reason)) p.push("최소 표본과 그 이유가 비어 있다");
  if (m.kind === "derived") {
    if (!m.inputs || blank(m.formula)) p.push("계산식(inputs · formula)이 없다");
    else for (const id of Object.values(m.inputs)) if (!S.byId[id]) p.push(`가져다 쓰는 지표 «${id}»가 사전에 없다`);
  } else {
    if (blank(m.sql)) p.push("계산 SQL이 없다");
    if (!(m.sources || []).length) p.push("출처(sources)가 없다");
  }
  const rej = m.rejected || [];
  if (!rej.length) p.push("버린 정의가 없다");
  rej.forEach((r, i) => {
    if (blank(r.name)) p.push(`버린 정의 ${i + 1}의 이름이 없다`);
    if (blank(r.reason)) p.push(`버린 정의 «${r.name || i + 1}»의 이유가 비어 있다`);
    if (m.kind !== "derived" && blank(r.sql)) p.push(`버린 정의 «${r.name || i + 1}»의 SQL이 없다`);
  });
  return p;
}

async function loadMetrics() {
  const names = await (await fetch("metrics/index.json")).json();
  const out = [];
  for (const n of names) {
    try {
      const j = await (await fetch(`metrics/${encodeURIComponent(n)}`)).json();
      out.push({ ...j, file: n });
    } catch (err) {
      out.push({ id: n, name: n, file: n, loadError: `정의서 파일을 읽지 못했다: ${err.message}` });
    }
  }
  S.metrics = out;
  S.byId = Object.fromEntries(out.map(m => [m.id, m]));
}

// ── 계산 ─────────────────────────────────────────────
function valueOf(m, num, den) {
  const scale = m.scale ?? (den != null ? 100 : 1);
  if (den != null) return den === 0 ? null : (num / den) * scale;
  return num == null ? null : num * scale;
}
function hidden(m, num, den) {
  const ms = m.elements?.min_sample;
  if (!ms || ms.value == null) return false;
  const basis = ms.applies_to === "numerator" ? num : (den ?? num);
  return basis != null && basis < ms.value;
}
function evalFormula(f, vars) {
  if (!/^[a-z0-9_+\-*/().\s]+$/i.test(f)) throw new Error("계산식에는 변수 · 숫자 · + − × ÷ ( )만 쓸 수 있습니다.");
  const ids = f.match(/[a-z_][a-z0-9_]*/gi) || [];
  for (const id of ids) if (!(id in vars)) throw new Error(`계산식의 «${id}»가 inputs에 없습니다.`);
  const v = Function(...Object.keys(vars), `"use strict"; return (${f});`)(...Object.values(vars));
  return Number.isFinite(v) ? v : null;
}

async function seriesOf(id, stack = []) {
  if (S.series[id]) return S.series[id];
  const m = S.byId[id];
  if (stack.includes(id)) throw new Error(`지표가 서로를 가져다 씁니다: ${[...stack, id].join(" → ")}`);
  const res = { months: {}, rej: [], error: null };
  S.series[id] = res;
  if (m.loadError || problems(m).some(p => /SQL이 없다|계산식|사전에 없다/.test(p))) {
    res.error = "정의서가 완성되지 않아 계산하지 않았습니다.";
    return res;
  }
  try {
    if (m.kind === "derived") {
      const inp = {};
      for (const [k, sid] of Object.entries(m.inputs)) inp[k] = await seriesOf(sid, [...stack, id]);
      for (const mo of MONTHS) {
        const vars = {};
        let ok = true;
        for (const [k, s] of Object.entries(inp)) { const v = s.months[mo]?.value; if (v == null) ok = false; vars[k] = v; }
        res.months[mo] = { value: ok ? evalFormula(m.formula, vars) : null, parts: vars };
      }
    } else {
      for (const mo of MONTHS) {
        const { num, den } = await runDef(m.sql, mo);
        res.months[mo] = { num, den, value: hidden(m, num, den) ? null : valueOf(m, num, den), hidden: hidden(m, num, den) };
      }
      for (const r of m.rejected || []) {
        if (blank(r.sql)) continue;
        const row = { name: r.name, months: {} };
        for (const mo of MONTHS) { const { num, den } = await runDef(r.sql, mo); row.months[mo] = valueOf(m, num, den); }
        res.rej.push(row);
      }
    }
  } catch (err) {
    res.error = err.message;
  }
  return res;
}

// ── 화면 ─────────────────────────────────────────────
const hasDen = m => Object.values(S.series[m.id]?.months || {}).some(x => x.den != null);
const decimalsOf = m => m.decimals ?? (hasDen(m) ? 1 : 0);
const unitOf = m => m.unit ?? (hasDen(m) ? "%" : "");
function fmt(v, m) {
  if (v == null) return "—";
  const d = decimalsOf(m);
  return v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function spark(s) {
  const vals = MONTHS.map(mo => s.months[mo]?.value);
  const nums = vals.filter(v => v != null);
  if (nums.length < 2) return "";
  const lo = Math.min(...nums), hi = Math.max(...nums), w = 120, h = 28;
  const x = i => (i / 11) * (w - 4) + 2, y = v => hi === lo ? h / 2 : h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const pts = vals.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(" ");
  const cur = MONTHS.indexOf(S.month);
  const cv = vals[cur];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}"/>${cv == null ? "" : `<circle cx="${x(cur).toFixed(1)}" cy="${y(cv).toFixed(1)}" r="2.6"/>`}</svg>`;
}

function chart(m, s) {
  const lines = [{ name: "채택한 정의", cls: "l0", vals: MONTHS.map(mo => s.months[mo]?.value) },
    ...s.rej.map((r, i) => ({ name: r.name, cls: `l${i + 1}`, vals: MONTHS.map(mo => r.months[mo]) }))];
  if (lines.length < 2) return "";
  const all = lines.flatMap(l => l.vals).filter(v => v != null);
  const hi = Math.max(...all, 0), lo = Math.min(...all, 0);
  const W = 640, H = 190, L = 56, R = 12, T = 12, B = 26;
  const x = i => L + (i / 11) * (W - L - R), y = v => T + (1 - (v - lo) / ((hi - lo) || 1)) * (H - T - B);
  const cur = MONTHS.indexOf(S.month);
  const grid = [lo, (lo + hi) / 2, hi].map(v => `<line class="g" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="t" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v, m))}</text>`).join("");
  const xs = MONTHS.map((mo, i) => `<text class="t" x="${x(i)}" y="${H - 8}" text-anchor="middle">${i + 1}월</text>`).join("");
  const paths = lines.map(l => {
    const pts = l.vals.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(" ");
    const cv = l.vals[cur];
    return `<polyline class="ln ${l.cls}" points="${pts}"/>${cv == null ? "" : `<circle class="dot ${l.cls}" cx="${x(cur)}" cy="${y(cv)}" r="4"/>`}`;
  }).join("");
  const legend = lines.map(l => `<span class="lg"><i class="sw ${l.cls}"></i>${esc(l.name)}</span>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 값 — 채택한 정의와 버린 정의">${grid}${xs}<line class="cur" x1="${x(cur)}" x2="${x(cur)}" y1="${T}" y2="${H - B}"/>${paths}</svg><div class="legend">${legend}</div>`;
}

function cardHtml(m) {
  const s = S.series[m.id];
  const probs = problems(m);
  const cur = s?.months[S.month];
  let value;
  if (s?.error) value = `<span class="v none">계산 못 함</span>`;
  else if (cur?.hidden) value = `<span class="v none">표시 안 함</span><span class="sub">분모 ${cur.den?.toLocaleString("ko-KR")} — 최소 표본 ${m.elements.min_sample.value.toLocaleString("ko-KR")} 미만</span>`;
  else value = `<span class="v">${fmt(cur?.value, m)}<small>${esc(unitOf(m))}</small></span>${cur?.den != null ? `<span class="sub">${cur.num.toLocaleString("ko-KR")} ÷ ${cur.den.toLocaleString("ko-KR")}</span>` : ""}`;
  const pill = s?.error ? `<span class="pill warn">계산 오류</span>` : probs.length ? `<span class="pill warn">정의 미완성 ${probs.length}</span>` : `<span class="pill ok">정의서 완성</span>`;

  const e = m.elements || {};
  const rows = [
    ...ELEMENTS.map(([k, label]) => `<tr><th>${label}</th><td class="${blank(e[k]) ? "empty" : ""}">${blank(e[k]) ? "비어 있음" : esc(e[k])}</td></tr>`),
    `<tr><th>최소 표본</th><td class="${blank(e.min_sample?.reason) ? "empty" : ""}">${blank(e.min_sample?.reason) ? "비어 있음" : `${e.min_sample.value == null ? "없음" : `${e.min_sample.value.toLocaleString("ko-KR")} 미만이면 값을 표시하지 않는다`} — ${esc(e.min_sample.reason)}`}</td></tr>`,
    ...(m.kind === "derived" && m.formula ? [`<tr><th>계산식</th><td><code>${esc(m.formula)}</code> — ${Object.entries(m.inputs || {}).map(([k, id]) => `${esc(k)} = ${esc(S.byId[id]?.name || id)}`).join(" · ")}</td></tr>`] : [])
  ].join("");

  const mine = cur && !s.error ? (cur.hidden ? null : cur.value) : null;
  const cmpRows = [`<tr class="adopt"><td>★ 채택 — ${esc(m.name)}</td><td class="n">${fmt(mine, m)}</td><td class="n">—</td><td>${esc(m.purpose || "")}</td></tr>`]
    .concat((m.rejected || []).map(r => {
      const rs = s?.rej.find(x => x.name === r.name);
      const v = rs?.months[S.month];
      const diff = v != null && mine != null ? v - mine : null;
      return `<tr><td>${esc(r.name)}</td><td class="n">${v == null ? "—" : fmt(v, m)}</td><td class="n">${diff == null ? "—" : (diff > 0 ? "+" : "") + fmt(diff, m)}</td><td class="${blank(r.reason) ? "empty" : ""}">${blank(r.reason) ? "이유 미기재" : esc(r.reason)}</td></tr>`;
    })).join("");

  const chips = [...(m.sources || []).map(x => `<span class="chip tb">${esc(x)}</span>`),
    ...Object.values(m.inputs || {}).map(id => `<span class="chip mt">${esc(S.byId[id]?.name || id)}</span>`)].join("") || `<span class="muted small">출처가 적혀 있지 않다</span>`;
  const used = S.metrics.filter(o => Object.values(o.inputs || {}).includes(m.id)).map(o => `<span class="chip mt">${esc(o.name)}</span>`).join("");

  const sqls = m.kind === "derived" ? "" : `<details class="sql"><summary>SQL 보기 — 모든 숫자 옆에 SQL이 있습니다</summary>
      <p class="label">채택한 정의</p><pre>${esc(m.sql || "")}</pre>
      ${(m.rejected || []).map(r => `<p class="label">버린 정의 — ${esc(r.name)}</p><pre>${esc(r.sql || "")}</pre>`).join("")}</details>`;

  return `<details class="mcard" data-id="${esc(m.id)}">
    <summary>
      <span class="name"><b>${esc(m.name)}</b><span class="purpose">${esc(m.purpose || "")}</span></span>
      <span class="val">${value}</span>
      ${s && !s.error ? spark(s) : ""}
      ${pill}
    </summary>
    <div class="body">
      ${probs.length ? `<div class="alert"><b>정의서에 빠진 곳</b><ul>${probs.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      ${s?.error ? `<div class="alert"><b>계산하지 못했습니다</b><br>${esc(s.error)}</div>` : ""}
      <h3>정의서</h3>
      <table class="def"><tbody>${rows}</tbody></table>
      ${cmpRows && !s?.error ? `<h3>정의에 따라 숫자가 달라진다 <span class="muted small">${S.month}</span></h3>
      <div class="scroll"><table class="cmp"><thead><tr><th>정의</th><th>값</th><th>채택과의 차이</th><th>이유</th></tr></thead><tbody>${cmpRows}</tbody></table></div>
      ${s ? chart(m, s) : ""}` : ""}
      <h3>계보</h3>
      <div class="chips"><span class="muted small">이 숫자는</span>${chips}<span class="muted small">에서 온다</span></div>
      ${used ? `<div class="chips"><span class="muted small">이 지표를 가져다 쓰는 지표</span>${used}</div>` : ""}
      ${m.unanswerable ? `<h3>이 지표로 답할 수 없는 것</h3><p>${esc(m.unanswerable)}</p>` : ""}
      ${m.decision ? `<p class="small muted">결정 기록 ${esc(m.decision)}</p>` : ""}
      <p class="small muted">정의서 파일: <code>metrics/${esc(m.file)}</code></p>
      ${sqls}
    </div>
  </details>`;
}

function renderCards() {
  const open = new Set([...document.querySelectorAll(".mcard[open]")].map(d => d.dataset.id));
  $("#cards").innerHTML = S.metrics.length ? S.metrics.map(cardHtml).join("")
    : `<p class="muted">metrics/ 폴더에 정의서가 없습니다. 정의서를 넣고 metrics/index.json에 파일 이름을 적으면 카드가 생깁니다.</p>`;
  document.querySelectorAll(".mcard").forEach(d => { if (open.has(d.dataset.id)) d.open = true; });
}

// ── 계보 ─────────────────────────────────────────────
function renderLineage() {
  const base = S.metrics.filter(m => m.kind !== "derived");
  const derived = S.metrics.filter(m => m.kind === "derived");
  const cols = {};
  for (const m of base) for (const src of m.sources || []) { const [t, c] = src.split("."); (cols[t] ??= new Set()).add(c || ""); }
  const tables = Object.keys(cols).sort();
  const W = 230, H = 46, GX = 90, GY = 16;
  const colX = [0, W + GX, 2 * (W + GX)];
  const pos = {};
  tables.forEach((t, i) => pos["t:" + t] = { x: colX[0], y: i * (H + GY) });
  base.forEach((m, i) => pos["m:" + m.id] = { x: colX[1], y: i * (H + GY) });
  derived.forEach((m, i) => pos["m:" + m.id] = { x: colX[2], y: i * (H + GY) });
  const rows = Math.max(tables.length, base.length, derived.length, 1);
  const width = (derived.length ? 3 : 2) * W + (derived.length ? 2 : 1) * GX + 4, height = rows * (H + GY);
  const edge = (a, b) => { const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, c = (x2 - x1) / 2;
    return `<path class="edge" d="M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}"/>`; };
  let edges = "";
  for (const m of base) for (const t of new Set((m.sources || []).map(s => s.split(".")[0]))) if (pos["t:" + t]) edges += edge(pos["t:" + t], pos["m:" + m.id]);
  for (const m of derived) for (const id of Object.values(m.inputs || {})) if (pos["m:" + id]) edges += edge(pos["m:" + id], pos["m:" + m.id]);
  const node = (p, cls, title, sub) => `<g class="nd ${cls}" transform="translate(${p.x},${p.y})"><rect width="${W}" height="${H}" rx="8"/><text x="12" y="20" class="n1">${esc(title)}</text><text x="12" y="37" class="n2">${esc(sub)}</text></g>`;
  const nodes = tables.map(t => node(pos["t:" + t], "tb", t, (j => j.length > 34 ? j.slice(0, 33) + "…" : j)([...cols[t]].filter(Boolean).join(" · "))))
    .concat(base.map(m => node(pos["m:" + m.id], "mt", m.name, `정의서 ${problems(m).length ? "미완성" : "완성"}`)))
    .concat(derived.map(m => node(pos["m:" + m.id], "dv", m.name, m.formula || "")));
  $("#lineage").innerHTML = `<div class="scroll"><svg class="lin" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="테이블에서 지표로 가는 계보">${edges}${nodes.join("")}</svg></div>`;
}

// ── 대시보드 ──────────────────────────────────────────
// 어느 지표를 어디에 둘지는 dashboard.json 에 정의서 id 로만 적는다. 숫자는 카드와 같은 S.series 를 그대로 쓴다 — 여기서 SQL을 돌리지 않는다.
async function loadDashboard() {
  try {
    const j = await (await fetch("dashboard.json")).json();
    const ids = k => Array.isArray(j[k]) ? j[k].filter(x => typeof x === "string") : [];
    S.dash = { top: ids("top"), trend: ids("trend") };
  } catch (err) {
    S.dashError = `dashboard.json 을 읽지 못했다: ${err.message}`;
  }
}

const idTag = id => `<code class="mid" title="정의서 id">${esc(id).replaceAll("_", "_<wbr>")}</code>`;

// 전월 대비. 비율(%)은 %p 차이, 개수 · 금액은 차이와 증감률. 1월은 전월 데이터가 없다.
function deltaHtml(m, s) {
  const i = MONTHS.indexOf(S.month);
  if (i < 1) return `<span class="delta">전월 데이터 없음</span>`;
  const cur = s.months[S.month]?.value, prev = s.months[MONTHS[i - 1]]?.value;
  if (cur == null || prev == null) return `<span class="delta">전월 대비 —</span>`;
  const d = cur - prev, arrow = d > 0 ? "▲" : d < 0 ? "▼" : "";
  if (unitOf(m) === "%") return `<span class="delta">${arrow} ${Math.abs(d).toFixed(1)}%p <span class="muted">전월 대비</span></span>`;
  const pct = prev === 0 ? "" : ` (${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs((d / prev) * 100).toFixed(1)}%)`;
  return `<span class="delta">${arrow} ${fmt(Math.abs(d), m)}${esc(unitOf(m))}${pct} <span class="muted">전월 대비</span></span>`;
}

// 카드와 같은 규칙으로 이번 달 값을 보여 준다: 계산 오류 · 최소 표본 미만이면 숫자 대신 이유를 쓴다.
function bigValue(m, s) {
  if (!s) return `<span class="tv none">계산 중…</span>`;
  if (s.error) return `<span class="tv none">계산 못 함</span>`;
  const cur = s.months[S.month];
  if (cur?.hidden) return `<span class="tv none">표시 안 함</span><span class="sub">분모 ${cur.den?.toLocaleString("ko-KR")} — 최소 표본 ${m.elements.min_sample.value.toLocaleString("ko-KR")} 미만</span>`;
  return `<span class="tv">${fmt(cur?.value, m)}<small>${esc(unitOf(m))}</small></span>`;
}

function missingHtml(id, cls) {
  return `<div class="${cls} missing"><span class="tname">정의서 없음</span>${idTag(id)}<span class="sub">dashboard.json 에 적힌 이 id 의 정의서가 metrics/ 에 없습니다.</span></div>`;
}

function tileHtml(id) {
  const m = S.byId[id];
  if (!m) return missingHtml(id, "tile");
  const s = S.series[id];
  const warn = problems(m).length ? `<span class="pill warn">정의 미완성</span>` : "";
  return `<button type="button" class="tile" data-open="${esc(id)}" aria-label="${esc(m.name)} — 정의서 카드 열기">
    <span class="thead"><span class="tname">${esc(m.name)}</span>${idTag(id)}</span>
    <span class="tval">${bigValue(m, s)}</span>
    <span>${s && !s.error ? deltaHtml(m, s) : ""}</span>
    <span>${s && !s.error ? spark(s) : ""}${warn}</span>
  </button>`;
}

// 월별 추이: 채택한 정의 한 줄. 표본이 모자라 값을 감춘 달은 선을 끊고 비워 둔다.
function trendChart(m, s) {
  const vals = MONTHS.map(mo => s.months[mo]?.value);
  const nums = vals.filter(v => v != null);
  if (!nums.length) return `<p class="muted small">보여 줄 값이 없습니다.</p>`;
  let lo = Math.min(...nums), hi = Math.max(...nums);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.01 || 1;
  lo -= pad; hi += pad;
  const W = 460, H = 200, L = 64, R = 14, T = 14, B = 26;
  const x = i => L + (i / 11) * (W - L - R), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const cur = MONTHS.indexOf(S.month);
  const grid = [lo + pad, (lo + hi) / 2, hi - pad].map(v => `<line class="g" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="t" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v, m))}</text>`).join("");
  const xs = MONTHS.map((mo, i) => `<text class="t" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${i + 1}월</text>`).join("");
  const segs = [];
  let seg = [];
  vals.forEach((v, i) => { if (v == null) { if (seg.length) segs.push(seg); seg = []; } else seg.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
  if (seg.length) segs.push(seg);
  const lines = segs.map(p => p.length > 1 ? `<polyline class="ln l0" points="${p.join(" ")}"/>` : "").join("");
  const dots = vals.map((v, i) => v == null ? "" : `<circle class="pt${i === cur ? " on" : ""}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === cur ? 4.5 : 2.6}"><title>${MONTHS[i]} · ${esc(fmt(v, m))}${esc(unitOf(m))}</title></circle>`).join("");
  const gaps = MONTHS.filter((mo, i) => vals[i] == null && s.months[mo]?.hidden).map(mo => `${Number(mo.slice(5))}월`);
  return `<svg class="chart tchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.name)} 월별 추이">${grid}${xs}<line class="cur" x1="${x(cur).toFixed(1)}" x2="${x(cur).toFixed(1)}" y1="${T}" y2="${H - B}"/>${lines}${dots}</svg>
    <p class="small muted">세로축은 0에서 시작하지 않습니다 — 작은 변화도 보이도록 값의 범위에 맞췄습니다.${gaps.length ? ` 최소 표본 미만이라 비운 달: ${gaps.join(", ")}.` : ""}</p>`;
}

function trendHtml(id) {
  const m = S.byId[id];
  if (!m) return missingHtml(id, "trend");
  const s = S.series[id];
  const body = !s ? `<p class="muted small">계산 중…</p>` : s.error ? `<p class="muted small">계산 못 함 — ${esc(s.error)}</p>` : trendChart(m, s);
  return `<div class="trend">
    <div class="thead"><span class="tname">${esc(m.name)}</span>${idTag(id)}
      <button type="button" class="link" data-open="${esc(id)}">정의서 보기</button></div>
    <div class="tnow"><span class="muted small">${esc(S.month)}</span> ${bigValue(m, s)}</div>
    ${body}
  </div>`;
}

function renderDashboard() {
  const el = $("#dashboard");
  if (S.dashError) { el.innerHTML = `<div class="alert">${esc(S.dashError)}</div>`; return; }
  if (!S.dash) { el.innerHTML = `<p class="muted">대시보드 구성을 읽는 중…</p>`; return; }
  el.innerHTML = `<p class="small muted">기준월 <b>${esc(S.month)}</b> · 숫자는 지표 카드와 같은 정의서 계산을 그대로 씁니다. 지표를 누르면 그 정의서 카드로 갑니다.</p>
    <div class="dash-top">${S.dash.top.map(tileHtml).join("")}</div>
    ${S.dash.trend.length ? `<h3>월별 추이</h3><div class="dash-trend">${S.dash.trend.map(trendHtml).join("")}</div>` : ""}`;
}

// ── 시작 ─────────────────────────────────────────────
function selectTab(tab) {
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", String(x.dataset.tab === tab)));
  document.querySelectorAll("main > section.panel").forEach(p => { p.hidden = p.id !== `tab-${tab}`; });
}
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => selectTab(b.dataset.tab)));
$("#dashboard").addEventListener("click", e => {
  const b = e.target.closest("[data-open]");
  if (!b) return;
  selectTab("cards");
  const card = [...document.querySelectorAll(".mcard")].find(d => d.dataset.id === b.dataset.open);
  if (card) { card.open = true; card.scrollIntoView({ behavior: "smooth", block: "start" }); }
});
$("#month").innerHTML = MONTHS.map(m => `<option value="${m}"${m === S.month ? " selected" : ""}>${m}</option>`).join("");
$("#month").addEventListener("change", e => { S.month = e.target.value; renderCards(); renderDashboard(); });

(async () => {
  try {
    S.schema = await (await fetch("schema.json")).json();
    await loadMetrics();
    await loadDashboard();
    renderCards();
    renderDashboard();
    $("#engine").textContent = "데이터 엔진 준비 중…";
    await startEngine();
    let done = 0;
    for (const m of S.metrics) {
      $("#engine").textContent = `계산 중 — ${m.name} (${++done}/${S.metrics.length})`;
      await seriesOf(m.id);
      renderCards();
      renderDashboard();
    }
    renderLineage();
    $("#engine").textContent = `준비됨 · 지표 ${S.metrics.length}개 · 불러온 테이블 ${S.loaded.size}개`;
    $("#engine").classList.add("ready");
    document.body.dataset.ready = "1";
  } catch (err) {
    $("#engine").textContent = `시작하지 못했습니다: ${err.message}`;
    document.body.dataset.ready = "error";
  }
})();
