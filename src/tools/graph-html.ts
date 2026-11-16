import { GraphData } from "./graph-data";

/**
 * The graph page: one HTML file with its style, its script and its data inside, drawn on a canvas. It loads nothing (no
 * library, no font, no request), so it opens offline from a folder and shows only what is in the file.
 *
 * File and symbol names come from the repository, which can be anyone's, so they are treated as hostile text: the data is
 * embedded as JSON with every `<`, `>`, `&` and line separator escaped (a name cannot close the script tag), and the
 * script puts every name on screen with `textContent`, never `innerHTML`.
 */

const CSS = String.raw`
:root { --bg:#f6f6f3; --panel:#ffffff; --fg:#1d1f23; --muted:#667085; --line:#d9dbe0; --accent:#2f6fed; --warn:#c2410c; --halo:#f6f6f3; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#14161a; --panel:#1b1e24; --fg:#e6e8eb; --muted:#98a2b3; --line:#2c313a; --accent:#7aa7ff; --warn:#fb923c; --halo:#14161a; }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
header { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; padding: 8px 14px; background: var(--panel); border-bottom: 1px solid var(--line); position: relative; }
#repo { font-size: 15px; }
#stats { color: var(--muted); }
.controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-left: auto; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.seg button { border: 0; background: transparent; color: var(--fg); padding: 4px 12px; cursor: pointer; font: inherit; }
.seg button.on { background: var(--accent); color: #fff; }
label { color: var(--muted); display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
#q { width: 250px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
#results { position: absolute; right: 14px; top: 100%; z-index: 5; margin: 2px 0 0; padding: 4px; list-style: none; width: 460px; max-width: calc(100vw - 28px); max-height: 60vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
#results li { padding: 5px 8px; border-radius: 5px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#results li:hover { background: var(--bg); }
#results .sub { color: var(--muted); }
#error { margin: 10px 14px; padding: 10px 12px; border: 1px solid var(--warn); border-radius: 6px; color: var(--warn); }
main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 360px; }
#stage { position: relative; min-width: 0; min-height: 0; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; }
canvas.drag { cursor: grabbing; }
#crumbs { position: absolute; left: 12px; top: 10px; max-width: calc(100% - 24px); color: var(--muted); }
#crumbs b { color: var(--fg); }
#crumbs a { color: var(--accent); cursor: pointer; text-decoration: underline; }
#legend { position: absolute; left: 12px; bottom: 10px; display: flex; flex-wrap: wrap; gap: 4px 12px; max-width: calc(100% - 24px); color: var(--muted); }
#legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
#tip { position: absolute; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; box-shadow: 0 4px 14px rgba(0,0,0,.16); max-width: 420px; z-index: 4; }
aside { overflow: auto; background: var(--panel); border-left: 1px solid var(--line); padding: 12px 14px; }
aside h2 { margin: 0 0 2px; font-size: 14px; word-break: break-all; }
aside h3 { margin: 14px 0 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
aside .meta { color: var(--muted); margin-bottom: 6px; }
aside ul { list-style: none; margin: 0; padding: 0; }
aside li { padding: 2px 0; }
aside li.link { cursor: pointer; color: var(--accent); word-break: break-all; }
aside li.link:hover { text-decoration: underline; }
aside .bar { height: 5px; border-radius: 3px; background: var(--line); margin-top: 2px; }
aside .bar i { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
aside button { font: inherit; color: #fff; background: var(--accent); border: 0; border-radius: 6px; padding: 5px 12px; cursor: pointer; margin: 6px 0; }
.tag { display: inline-block; min-width: 3.3em; text-align: center; font-size: 10px; border-radius: 3px; padding: 0 4px; margin-right: 6px; color: #fff; background: #667085; }
.tag.class, .tag.struct, .tag.interface, .tag.trait, .tag.enum { background: #7c3aed; }
.tag.function, .tag.method { background: #0f766e; }
.tag.type, .tag.const, .tag.variable { background: #b45309; }
.ln { color: var(--muted); float: right; }
.sym { cursor: pointer; }
.sym.m { margin-left: 18px; }
.warn { color: var(--warn); }
.badge { font-size: 10px; border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; margin-left: 6px; color: var(--muted); }
details#help { position: absolute; right: 12px; top: 10px; max-width: 360px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
details#help summary { cursor: pointer; color: var(--muted); }
details#help p { margin: 6px 0 2px; }
@media (max-width: 860px) { main { grid-template-columns: 1fr; grid-template-rows: 62vh auto; } aside { border-left: 0; border-top: 1px solid var(--line); } }
`;

const SCRIPT = String.raw`
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function fail(e) {
    var box = $('error'); box.hidden = false;
    box.textContent = 'The graph could not be drawn: ' + (e && e.message ? e.message : String(e));
    document.title = 'ERROR - ' + document.title;
  }
  try { main(); } catch (e) { fail(e); }

  function main() {
    var DATA = JSON.parse($('ria-data').textContent);
    var N = DATA.nodes;
    var OUT = N.map(function () { return []; }), INN = N.map(function () { return []; }), CO = N.map(function () { return []; });
    DATA.links.forEach(function (l) { OUT[l[0]].push(l[1]); INN[l[1]].push(l[0]); });
    DATA.co.forEach(function (c) { CO[c[0]].push([c[1], c[2], c[3]]); CO[c[1]].push([c[0], c[2], c[3]]); });
    var DEG = N.map(function (n, i) { return OUT[i].length + INN[i].length; });

    var hasDocs = N.some(function (n) { return n.lang === 'other'; }), hasCode = N.some(function (n) { return n.lang !== 'other'; });
    // documents and configuration are hidden by default (the picture is about code), unless there is nothing else to draw
    var S = { view: N.length <= 300 ? 'files' : 'folders', folder: null, sel: -1, hover: -1, co: true, tests: true, nb: true, docs: !hasCode, q: '', k: 1, tx: 0, ty: 0, g: null, depth: 1 };
    var canvas = $('cv'), ctx = canvas.getContext('2d'), W = 800, H = 600, dpr = window.devicePixelRatio || 1;
    var css = getComputedStyle(document.documentElement);
    function cv(name) { return css.getPropertyValue(name).trim(); }

    function topOf(p) { var i = p.indexOf('/'); return i < 0 ? '(root)' : p.slice(0, i); }
    function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '(root)' : p.slice(0, i); }
    function folderKey(p, depth) { var parts = p.split('/'); parts.pop(); var k = parts.slice(0, depth).join('/'); return k || '(root)'; }
    function inFolder(p, folder) { return folder === '(root)' ? p.indexOf('/') < 0 : p.indexOf(folder + '/') === 0; }
    function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
    function colorOf(top) { return 'hsl(' + hue(top) + ',58%,50%)'; }

    function chooseDepth() {
      var best = 1;
      for (var d = 1; d <= 6; d++) {
        var seen = {}, cnt = 0;
        N.forEach(function (n) { var k = folderKey(n.path, d); if (!seen[k]) { seen[k] = 1; cnt++; } });
        if (cnt > 60) break;
        best = d;
        if (cnt >= 6) return d;
      }
      return best;
    }

    S.depth = chooseDepth();

    function buildFolders() {
      var depth = S.depth;
      var map = {}, list = [];
      N.forEach(function (n, i) {
        var key = folderKey(n.path, depth), f = map[key];
        if (!f) { f = map[key] = { key: key, label: key, top: key, files: [], lines: 0, tests: 0, langs: {}, internal: 0 }; list.push(f); }
        f.files.push(i); f.lines += n.lines; if (n.test) f.tests++; f.langs[n.lang] = (f.langs[n.lang] || 0) + 1;
      });
      list.forEach(function (f, j) { f.idx = j; f.r = clamp(10 + Math.sqrt(f.files.length) * 3.2, 12, 46); });
      var w = {};
      DATA.links.forEach(function (l) {
        var a = map[folderKey(N[l[0]].path, depth)].idx, b = map[folderKey(N[l[1]].path, depth)].idx;
        if (a === b) { list[a].internal++; return; }
        var k = a + '>' + b; w[k] = (w[k] || 0) + 1;
      });
      var edges = Object.keys(w).map(function (k) { var p = k.split('>'); return { a: +p[0], b: +p[1], w: w[k] }; });
      return { kind: 'folders', nodes: list, edges: edges, co: [], note: '' };
    }

    function buildFiles() {
      var ids = [], i;
      for (i = 0; i < N.length; i++) {
        if (!S.tests && N[i].test) continue;
        if (!S.docs && N[i].lang === 'other') continue;
        if (!S.folder || inFolder(N[i].path, S.folder)) ids.push(i);
      }
      var cap = 320, note = '';
      if (ids.length > cap) {
        ids.sort(function (a, b) { return DEG[b] - DEG[a] || N[b].lines - N[a].lines; });
        note = 'Showing the ' + cap + ' most connected of ' + fmt(ids.length) + ' files. Choose a folder to see the others.';
        ids = ids.slice(0, cap);
      }
      var inSet = {}; ids.forEach(function (x) { inSet[x] = true; });
      var ghosts = [];
      if (S.folder && S.nb) {
        var cand = {};
        ids.forEach(function (x) { OUT[x].concat(INN[x]).forEach(function (y) { if (!inSet[y] && (S.tests || !N[y].test) && (S.docs || N[y].lang !== 'other')) cand[y] = (cand[y] || 0) + 1; }); });
        ghosts = Object.keys(cand).map(Number).sort(function (a, b) { return cand[b] - cand[a] || DEG[b] - DEG[a]; }).slice(0, 40);
      }
      var all = ids.concat(ghosts), at = {};
      all.forEach(function (x, j) { at[x] = j; });
      var nodes = all.map(function (x, j) {
        var n = N[x];
        return { id: x, ghost: j >= ids.length, label: n.path.split('/').pop(), top: folderKey(n.path, S.depth), r: clamp(3.5 + Math.sqrt(n.lines) / 3.2, 4.5, n.lang === 'other' ? 8 : 17), test: n.test };
      });
      var edges = [];
      all.forEach(function (x, j) {
        OUT[x].forEach(function (y) {
          var t = at[y];
          if (t !== undefined && !(nodes[j].ghost && nodes[t].ghost)) edges.push({ a: j, b: t, w: 1 });
        });
      });
      var co = [];
      DATA.co.forEach(function (c) {
        var a = at[c[0]], b = at[c[1]];
        if (a !== undefined && b !== undefined) co.push({ a: a, b: b, support: c[2], conf: c[3] });
      });
      return { kind: 'files', nodes: nodes, edges: edges, co: co, note: note, at: at };
    }

    function layout(g) {
      var nodes = g.nodes, edges = g.edges, n = nodes.length, folders = g.kind === 'folders';
      var cx = 0, cy = 0, spread = folders ? 90 : 34;
      nodes.forEach(function (p, i) {
        var a = i * 2.399963, r = spread * Math.sqrt(i + 1);
        p.x = cx + Math.cos(a) * r; p.y = cy + Math.sin(a) * r; p.vx = 0; p.vy = 0;
      });
      var L = folders ? 170 : 78, REP = folders ? 14000 : 3400, iters = n > 200 ? 260 : 420, GRAV = folders ? 0.006 : 0.0022, PAD = folders ? 16 : 7;
      for (var it = 0; it < iters; it++) {
        var alpha = Math.max(0.03, 1 - it / iters), i, j, p, q, dx, dy, d2, d, f;
        for (i = 0; i < n; i++) {
          p = nodes[i];
          for (j = i + 1; j < n; j++) {
            q = nodes[j]; dx = p.x - q.x; dy = p.y - q.y; d2 = dx * dx + dy * dy;
            if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
            d = Math.sqrt(d2); f = REP * alpha / d2;
            p.vx += dx / d * f; p.vy += dy / d * f; q.vx -= dx / d * f; q.vy -= dy / d * f;
          }
        }
        for (i = 0; i < edges.length; i++) {
          p = nodes[edges[i].a]; q = nodes[edges[i].b]; dx = q.x - p.x; dy = q.y - p.y; d = Math.sqrt(dx * dx + dy * dy) || 1;
          f = (d - L) * (folders ? 0.03 : 0.018) * alpha * Math.min(3, 1 + Math.log(edges[i].w));
          p.vx += dx / d * f; p.vy += dy / d * f; q.vx -= dx / d * f; q.vy -= dy / d * f;
        }
        for (i = 0; i < n; i++) {
          p = nodes[i]; p.vx += (cx - p.x) * GRAV; p.vy += (cy - p.y) * GRAV;
          p.x += clamp(p.vx, -40, 40) * 0.5; p.y += clamp(p.vy, -40, 40) * 0.5; p.vx *= 0.6; p.vy *= 0.6;
        }
        // dots never sit on top of each other: push any pair that overlaps (plus a little air) apart
        for (i = 0; i < n; i++) {
          p = nodes[i];
          for (j = i + 1; j < n; j++) {
            q = nodes[j]; dx = p.x - q.x; dy = p.y - q.y; d = Math.sqrt(dx * dx + dy * dy);
            var min = p.r + q.r + PAD;
            if (d < min) { if (d < 0.01) { dx = 1; dy = 0; d = 1; } f = (min - d) / 2; p.x += dx / d * f; p.y += dy / d * f; q.x -= dx / d * f; q.y -= dy / d * f; }
          }
        }
      }
    }

    function fit() {
      var ns = S.g.nodes;
      if (!ns.length) return;
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      ns.forEach(function (p) { x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r); y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r); });
      var pad = 60, k = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
      S.k = clamp(k, 0.05, 2.5);
      S.tx = W / 2 - ((x0 + x1) / 2) * S.k; S.ty = H / 2 - ((y0 + y1) / 2) * S.k;
    }

    function rebuild() {
      S.g = S.view === 'folders' ? buildFolders() : buildFiles();
      S.sel = -1; S.hover = -1;
      layout(S.g); fit(); chrome(); overview(); draw();
    }

    // ---- drawing
    function matches(p) {
      if (!S.q) return true;
      var q = S.q.toLowerCase();
      if (S.g.kind === 'folders') {
        return p.files.some(function (i) { return N[i].path.toLowerCase().indexOf(q) >= 0; });
      }
      var n = N[p.id];
      return n.path.toLowerCase().indexOf(q) >= 0 || n.syms.some(function (s) { return s[1].toLowerCase().indexOf(q) >= 0; });
    }
    function related(i) {
      var r = {}; r[i] = true;
      S.g.edges.forEach(function (e) { if (e.a === i) r[e.b] = true; if (e.b === i) r[e.a] = true; });
      S.g.co.forEach(function (e) { if (S.co && e.a === i) r[e.b] = true; if (S.co && e.b === i) r[e.a] = true; });
      return r;
    }
    function arrow(x0, y0, x1, y1, r1, size) {
      var a = Math.atan2(y1 - y0, x1 - x0), px = x1 - Math.cos(a) * (r1 + 1), py = y1 - Math.sin(a) * (r1 + 1);
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px - Math.cos(a - 0.45) * size, py - Math.sin(a - 0.45) * size);
      ctx.lineTo(px - Math.cos(a + 0.45) * size, py - Math.sin(a + 0.45) * size);
      ctx.closePath(); ctx.fill();
    }
    var pending = false;
    function draw() {
      if (pending) return; pending = true;
      requestAnimationFrame(function () { pending = false; paint(); });
    }
    function paint() {
      var g = S.g; if (!g) return;
      var fg = cv('--fg'), muted = cv('--muted'), halo = cv('--halo'), warn = cv('--warn');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.translate(S.tx, S.ty); ctx.scale(S.k, S.k);
      var focus = S.sel >= 0 ? S.sel : (S.hover >= 0 ? S.hover : -1), rel = focus >= 0 ? related(focus) : null;
      var ns = g.nodes, i, e, a, b, hot;
      ctx.lineCap = 'round';
      for (i = 0; i < g.edges.length; i++) {
        e = g.edges[i]; a = ns[e.a]; b = ns[e.b]; hot = rel && (e.a === focus || e.b === focus);
        ctx.globalAlpha = rel ? (hot ? 0.95 : 0.07) : (g.kind === 'folders' ? 0.55 : 0.32);
        ctx.strokeStyle = hot ? cv('--accent') : muted; ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = (g.kind === 'folders' ? 1 + Math.min(7, Math.log(1 + e.w) * 1.6) : (hot ? 1.6 : 0.8)) / Math.sqrt(S.k);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        if (g.kind === 'folders' || hot) arrow(a.x, a.y, b.x, b.y, b.r, (g.kind === 'folders' ? 9 : 7) / Math.sqrt(S.k));
      }
      if (S.co && g.co.length) {
        ctx.setLineDash([5 / S.k, 4 / S.k]); ctx.strokeStyle = warn;
        for (i = 0; i < g.co.length; i++) {
          e = g.co[i]; a = ns[e.a]; b = ns[e.b]; hot = rel && (e.a === focus || e.b === focus);
          ctx.globalAlpha = rel ? (hot ? 0.95 : 0.05) : 0.5; ctx.lineWidth = (hot ? 1.8 : 1) / Math.sqrt(S.k);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      var wanted = [];
      for (i = 0; i < ns.length; i++) {
        var p = ns[i], dim = (rel && !rel[i]) || (S.q && !matches(p)), hitq = S.q && g.kind === 'files' && matches(p);
        ctx.globalAlpha = dim ? 0.13 : (p.ghost ? 0.55 : 1);
        ctx.fillStyle = colorOf(p.top);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
        if (p.test) { ctx.setLineDash([2.5, 2]); ctx.lineWidth = 1.4 / Math.sqrt(S.k); ctx.strokeStyle = fg; ctx.stroke(); ctx.setLineDash([]); }
        if (i === S.sel || hitq) { ctx.lineWidth = 2.4 / Math.sqrt(S.k); ctx.strokeStyle = i === S.sel ? fg : cv('--accent'); ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 2.5, 0, 6.2832); ctx.stroke(); }
        if (!dim) {
          var rank = (i === S.sel ? 1e9 : 0) + (i === S.hover ? 1e8 : 0) + (hitq ? 1e7 : 0) + (rel && rel[i] ? 1e6 : 0) + (g.kind === 'folders' ? p.files.length : (DEG[p.id] || 0)) + p.r / 100;
          wanted.push({ rank: rank, i: i });
        }
      }
      // labels in screen space at one size, most important first; a label that would cover one already placed is left out
      ctx.globalAlpha = 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.lineJoin = 'round';
      wanted.sort(function (x, y) { return y.rank - x.rank; });
      var placed = [], count = 0;
      for (var w = 0; w < wanted.length && count < 140; w++) {
        var q = ns[wanted[w].i], sx = q.x * S.k + S.tx, sy = q.y * S.k + S.ty + q.r * S.k + 2;
        if (sx < -50 || sx > W + 50 || sy < -20 || sy > H + 20) continue;
        var text = g.kind === 'folders' ? q.label + ' (' + q.files.length + ')' : q.label, tw = ctx.measureText(text).width, x0 = sx - tw / 2 - 2, x1 = sx + tw / 2 + 2, y1 = sy + 13, clash = false;
        for (var m = 0; m < placed.length; m++) { var r = placed[m]; if (x0 < r[2] && x1 > r[0] && sy < r[3] && y1 > r[1]) { clash = true; break; } }
        if (clash && wanted[w].rank < 1e8) continue; // only the selected or hovered dot may cover another label
        placed.push([x0, sy, x1, y1]); count++;
        ctx.globalAlpha = q.ghost ? 0.7 : 1; ctx.strokeText(text, sx, sy); ctx.fillStyle = fg; ctx.fillText(text, sx, sy);
      }
      ctx.globalAlpha = 1;
    }

    // ---- chrome: crumbs, legend, notes
    function chrome() {
      var c = $('crumbs'); c.textContent = '';
      var g = S.g;
      if (g.kind === 'folders') {
        c.appendChild(el('b', '', 'Architecture')); c.appendChild(document.createTextNode(' - folders (' + fmt(g.nodes.length) + ') and the imports between them. Double-click a folder to open it.'));
      } else {
        var all = el('a', '', S.folder ? 'all files' : 'Files'); all.onclick = function () { S.folder = null; S.view = N.length <= 300 ? 'files' : 'folders'; sync(); rebuild(); };
        c.appendChild(all);
        if (S.folder) { c.appendChild(document.createTextNode(' / ')); c.appendChild(el('b', '', S.folder)); }
        if (g.note) c.appendChild(document.createTextNode('  -  ' + g.note));
      }
      var lg = $('legend'); lg.textContent = '';
      var tops = {}; g.nodes.forEach(function (p) { tops[p.top] = (tops[p.top] || 0) + 1; });
      Object.keys(tops).sort(function (a, b) { return tops[b] - tops[a]; }).slice(0, 10).forEach(function (t) {
        var s = el('span'); var dot = el('i'); dot.style.background = colorOf(t); s.appendChild(dot); s.appendChild(document.createTextNode(t)); lg.appendChild(s);
      });
    }
    function sync() {
      $('v-folders').className = S.view === 'folders' ? 'on' : ''; $('v-files').className = S.view === 'files' ? 'on' : '';
      $('l-nb').style.display = S.view === 'files' && S.folder ? '' : 'none';
    }

    // ---- side panel
    function clear(p) { p.textContent = ''; return p; }
    function list(parent, items, max, onClick) {
      var ul = el('ul'); parent.appendChild(ul);
      items.slice(0, max).forEach(function (it) {
        var li = el('li', onClick ? 'link' : '', it.text); if (onClick) li.onclick = function () { onClick(it); }; ul.appendChild(li);
      });
      if (items.length > max) ul.appendChild(el('li', 'meta', '... and ' + fmt(items.length - max) + ' more'));
    }
    function overview() {
      var p = clear($('panel'));
      p.appendChild(el('h2', '', DATA.repo));
      p.appendChild(el('div', 'meta', 'Click a dot to see what is in it and what it connects to.'));
      p.appendChild(el('h3', '', 'Languages'));
      var max = DATA.stats.languages.length ? DATA.stats.languages[0][1] : 1;
      DATA.stats.languages.slice(0, 8).forEach(function (l) {
        var row = el('div', '', l[0] + '  ' + fmt(l[1])); var bar = el('div', 'bar'); var fill = el('i'); fill.style.width = Math.round(100 * l[1] / max) + '%'; bar.appendChild(fill); row.appendChild(bar); p.appendChild(row);
      });
      p.appendChild(el('h3', '', 'Most depended-on files'));
      var top = N.map(function (n, i) { return i; }).sort(function (a, b) { return INN[b].length - INN[a].length; }).filter(function (i) { return INN[i].length > 0; }).slice(0, 12);
      list(p, top.map(function (i) { return { id: i, text: N[i].path + '  (' + INN[i].length + ')' }; }), 12, function (it) { goToFile(it.id); });
      var u = DATA.stats.unresolved;
      if (u) p.appendChild(el('div', 'meta warn', fmt(u) + ' relative imports did not resolve to a file, so some arrows are missing.'));
      DATA.notes.forEach(function (n) { p.appendChild(el('div', 'meta', n)); });
    }
    function folderPanel(f) {
      var p = clear($('panel'));
      p.appendChild(el('h2', '', f.label));
      p.appendChild(el('div', 'meta', fmt(f.files.length) + ' files, ' + fmt(f.lines) + ' lines' + (f.tests ? ', ' + f.tests + ' of them tests' : '')));
      var open = el('button', '', 'Open these files'); open.onclick = function () { openFolder(f.key); }; p.appendChild(open);
      var out = {}, inn = {};
      S.g.edges.forEach(function (e) { if (e.a === f.idx) out[e.b] = e.w; if (e.b === f.idx) inn[e.a] = e.w; });
      var named = function (m) { return Object.keys(m).map(Number).sort(function (a, b) { return m[b] - m[a]; }).map(function (j) { return { idx: j, text: S.g.nodes[j].label + '  (' + m[j] + ' imports)' }; }); };
      p.appendChild(el('h3', '', 'Imports from'));
      var o = named(out); if (o.length) list(p, o, 12, function (it) { selectNode(it.idx); }); else p.appendChild(el('div', 'meta', 'nothing in another folder'));
      p.appendChild(el('h3', '', 'Imported by'));
      var n = named(inn); if (n.length) list(p, n, 12, function (it) { selectNode(it.idx); }); else p.appendChild(el('div', 'meta', 'nothing in another folder'));
      p.appendChild(el('div', 'meta', fmt(f.internal) + ' imports stay inside this folder.'));
      p.appendChild(el('h3', '', 'Largest files'));
      var big = f.files.slice().sort(function (a, b) { return N[b].lines - N[a].lines; }).slice(0, 8);
      list(p, big.map(function (i) { return { id: i, text: N[i].path.split('/').pop() + '  (' + fmt(N[i].lines) + ' lines)' }; }), 8, function (it) { goToFile(it.id); });
    }
    var CLASSY = { 'class': 1, 'struct': 1, 'interface': 1, 'trait': 1, 'enum': 1 };
    function tag(kind) { var t = el('span', 'tag ' + kind, kind); return t; }
    function symRow(parent, s, nested, path) {
      var li = el('li', 'sym' + (nested ? ' m' : '')); li.appendChild(tag(s[0]));
      li.appendChild(document.createTextNode(nested && s[1].lastIndexOf('.') >= 0 ? s[1].slice(s[1].lastIndexOf('.') + 1) : s[1]));
      li.appendChild(el('span', 'ln', 'L' + s[2])); li.title = path + ':' + s[2] + (s[3] ? '  (exported)' : '');
      li.onclick = function () { if (navigator.clipboard) navigator.clipboard.writeText(path + ':' + s[2]).catch(function () {}); };
      parent.appendChild(li);
    }
    function filePanel(id) {
      var n = N[id], p = clear($('panel'));
      var h = el('h2', '', n.path); if (n.test) h.appendChild(el('span', 'badge', 'test')); p.appendChild(h);
      p.appendChild(el('div', 'meta', n.lang + ', ' + fmt(n.lines) + ' lines, ' + (n.syms.length + n.moreSyms) + ' symbols. Imports ' + OUT[id].length + ' files, imported by ' + INN[id].length + '.'));
      p.appendChild(el('h3', '', 'What is in it'));
      var ul = el('ul'); p.appendChild(ul);
      var groups = {}, order = [], loose = [];
      n.syms.forEach(function (s) { if (CLASSY[s[0]]) { groups[s[1]] = { head: s, kids: [] }; order.push(s[1]); } });
      n.syms.forEach(function (s) {
        if (CLASSY[s[0]]) return;
        var dot = s[1].lastIndexOf('.'), owner = dot > 0 ? s[1].slice(0, dot) : null;
        if (owner && groups[owner]) groups[owner].kids.push(s); else loose.push(s);
      });
      var shown = 0, LIMIT = 220;
      order.forEach(function (k) { if (shown >= LIMIT) return; symRow(ul, groups[k].head, false, n.path); shown++; groups[k].kids.forEach(function (m) { if (shown < LIMIT) { symRow(ul, m, true, n.path); shown++; } }); });
      loose.forEach(function (s) { if (shown < LIMIT) { symRow(ul, s, false, n.path); shown++; } });
      if (!n.syms.length) p.appendChild(el('div', 'meta', 'No functions or classes were found in this file.'));
      var rest = n.syms.length - shown + n.moreSyms; if (rest > 0) p.appendChild(el('div', 'meta', '... and ' + fmt(rest) + ' more not listed.'));
      p.appendChild(el('div', 'meta', 'Click a row to copy path:line.'));
      var go = function (it) { goToFile(it.id); };
      p.appendChild(el('h3', '', 'It imports')); if (OUT[id].length) list(p, OUT[id].map(function (j) { return { id: j, text: N[j].path }; }), 25, go); else p.appendChild(el('div', 'meta', 'no file of this repository'));
      p.appendChild(el('h3', '', 'Imported by')); if (INN[id].length) list(p, INN[id].map(function (j) { return { id: j, text: N[j].path }; }), 25, go); else p.appendChild(el('div', 'meta', 'no file'));
      if (CO[id].length) {
        p.appendChild(el('h3', '', 'Changes together in git, no import'));
        var together = CO[id].slice().sort(function (a, b) { return b[1] - a[1]; });
        list(p, together.map(function (c) { return { id: c[0], text: N[c[0]].path + '  (' + c[1] + ' commits, ' + c[2] + '%)' }; }), 12, go);
      }
      if (n.gaps.length) { p.appendChild(el('h3', 'warn', 'Imports that did not resolve')); list(p, n.gaps.map(function (g) { return { text: g }; }), 12); }
    }

    // ---- navigation
    function selectNode(i) {
      S.sel = i; var p = S.g.nodes[i];
      if (S.g.kind === 'folders') folderPanel(p); else filePanel(p.id);
      draw();
    }
    function openFolder(key) { S.view = 'files'; S.folder = key; sync(); rebuild(); }
    function goToFile(id) {
      if (S.view !== 'files' || !S.g || S.g.at === undefined || S.g.at[id] === undefined) {
        S.view = 'files'; S.folder = N.length > 300 ? dirOf(N[id].path) : null; sync(); rebuild();
      }
      var j = S.g.at[id];
      if (j === undefined) return;
      selectNode(j);
      var p = S.g.nodes[j]; S.k = Math.max(S.k, 1.4); S.tx = W / 2 - p.x * S.k; S.ty = H / 2 - p.y * S.k; draw();
    }

    // ---- search
    function search(q) {
      S.q = q.trim(); var box = $('results'); box.textContent = '';
      if (!S.q) { box.hidden = true; draw(); return; }
      var lq = S.q.toLowerCase(), hits = [], i;
      for (i = 0; i < N.length && hits.length < 14; i++) if (N[i].path.toLowerCase().indexOf(lq) >= 0) hits.push({ id: i, text: N[i].path, sub: '' });
      for (i = 0; i < N.length && hits.length < 14; i++) {
        for (var k = 0; k < N[i].syms.length; k++) {
          var s = N[i].syms[k];
          if (s[1].toLowerCase().indexOf(lq) >= 0) { hits.push({ id: i, text: s[1], sub: '  ' + N[i].path + ':' + s[2] }); break; }
        }
      }
      hits.forEach(function (h) {
        var li = el('li', '', h.text); if (h.sub) li.appendChild(el('span', 'sub', h.sub));
        li.onclick = function () { box.hidden = true; goToFile(h.id); }; box.appendChild(li);
      });
      if (!hits.length) box.appendChild(el('li', 'sub', 'Nothing matches. Only file paths and the functions and classes found in files are searched.'));
      box.hidden = false; draw();
    }

    // ---- pointer
    function world(ev) { var r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - S.tx) / S.k, y: (ev.clientY - r.top - S.ty) / S.k, sx: ev.clientX - r.left, sy: ev.clientY - r.top }; }
    function hit(w) { var ns = S.g.nodes; for (var i = ns.length - 1; i >= 0; i--) { var p = ns[i], dx = w.x - p.x, dy = w.y - p.y, r = p.r + 3 / S.k; if (dx * dx + dy * dy <= r * r) return i; } return -1; }
    var drag = null;
    canvas.addEventListener('mousedown', function (ev) {
      var w = world(ev), h = hit(w);
      drag = { x: ev.clientX, y: ev.clientY, tx: S.tx, ty: S.ty, node: h, moved: false };
      canvas.className = 'drag';
    });
    window.addEventListener('mousemove', function (ev) {
      if (drag) {
        var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          if (drag.node >= 0) { var p = S.g.nodes[drag.node], w = world(ev); p.x = w.x; p.y = w.y; } else { S.tx = drag.tx + dx; S.ty = drag.ty + dy; }
          draw();
        }
        return;
      }
      if (ev.target !== canvas) return;
      var h = hit(world(ev)), tip = $('tip');
      if (h !== S.hover) { S.hover = h; draw(); }
      if (h >= 0) {
        var p2 = S.g.nodes[h], w2 = world(ev);
        tip.textContent = S.g.kind === 'folders' ? p2.label + ': ' + fmt(p2.files.length) + ' files, ' + fmt(p2.lines) + ' lines' : N[p2.id].path + ' (' + fmt(N[p2.id].lines) + ' lines)';
        tip.hidden = false; tip.style.left = Math.min(W - 200, w2.sx + 14) + 'px'; tip.style.top = (w2.sy + 14) + 'px';
      } else tip.hidden = true;
    });
    window.addEventListener('mouseup', function () {
      if (drag && !drag.moved) { if (drag.node >= 0) selectNode(drag.node); else { S.sel = -1; overview(); draw(); } }
      drag = null; canvas.className = '';
    });
    canvas.addEventListener('dblclick', function (ev) { var h = hit(world(ev)); if (h >= 0 && S.g.kind === 'folders') openFolder(S.g.nodes[h].key); });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault(); var w = world(ev), f = ev.deltaY < 0 ? 1.15 : 1 / 1.15, nk = clamp(S.k * f, 0.04, 8);
      S.tx = w.sx - w.x * nk; S.ty = w.sy - w.y * nk; S.k = nk; draw();
    }, { passive: false });
    window.addEventListener('keydown', function (ev) {
      if (ev.key === '/' && document.activeElement !== $('q')) { ev.preventDefault(); $('q').focus(); }
      if (ev.key === 'Escape') { $('q').value = ''; search(''); S.sel = -1; overview(); draw(); }
    });

    function resize() {
      var r = $('stage').getBoundingClientRect(); W = Math.max(200, r.width); H = Math.max(200, r.height);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      if (S.g) { fit(); draw(); }
    }

    // ---- start
    $('repo').textContent = DATA.repo;
    var st = DATA.stats;
    $('stats').textContent = fmt(st.files) + ' files, ' + fmt(st.lines) + ' lines, ' + fmt(st.symbols) + ' functions and classes, ' + fmt(st.links) + ' imports' + (DATA.commits ? ', ' + fmt(DATA.commits) + ' commits read' : '');
    $('v-folders').onclick = function () { S.view = 'folders'; S.folder = null; sync(); rebuild(); };
    $('v-files').onclick = function () { S.view = 'files'; sync(); rebuild(); };
    $('c-co').checked = DATA.co.length > 0; S.co = DATA.co.length > 0; $('c-co').disabled = DATA.co.length === 0;
    $('c-co').onchange = function () { S.co = this.checked; draw(); };
    $('c-tests').onchange = function () { S.tests = this.checked; rebuild(); };
    $('c-nb').onchange = function () { S.nb = this.checked; rebuild(); };
    $('c-docs').checked = S.docs; $('c-docs').onchange = function () { S.docs = this.checked; rebuild(); };
    $('l-docs').style.display = hasDocs && hasCode ? '' : 'none';
    $('q').oninput = function () { search(this.value); };
    window.addEventListener('resize', resize);
    // a link can open the page on a view: graph.html#view=folders, #folder=src/tools, #file=src/server.ts, #q=gate
    var want = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) want[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
    if (want.view === 'folders' || want.view === 'files') S.view = want.view;
    if (want.docs === '1') { S.docs = true; $('c-docs').checked = true; }
    if (want.folder) { S.view = 'files'; S.folder = want.folder; }
    sync(); resize(); rebuild();
    if (want.q) { $('q').value = want.q; search(want.q); $('results').hidden = true; }
    if (want.file) { var fid = -1; N.forEach(function (n, i) { if (n.path === want.file) fid = i; }); if (fid >= 0) goToFile(fid); }
    document.body.setAttribute('data-ready', String(S.g.nodes.length));
  }
})();
`;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** JSON that is safe inside a script tag: no `<`, `>` or `&` for a name to close the tag with, and no line separators. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEPARATOR).join("\\u2028")
    .split(PARAGRAPH_SEPARATOR).join("\\u2029");
}

export function renderGraphHtml(data: GraphData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.repo)} - RIA graph</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div><b id="repo"></b> <span id="stats"></span></div>
  <div class="controls">
    <div class="seg"><button id="v-folders" type="button">Folders</button><button id="v-files" type="button">Files</button></div>
    <label><input type="checkbox" id="c-co"> changes together</label>
    <label><input type="checkbox" id="c-tests" checked> tests</label>
    <label id="l-docs"><input type="checkbox" id="c-docs"> config &amp; docs</label>
    <label id="l-nb"><input type="checkbox" id="c-nb" checked> neighbours</label>
    <input id="q" type="search" placeholder="find a file or function (press /)" autocomplete="off">
  </div>
  <ul id="results" hidden></ul>
</header>
<div id="error" hidden></div>
<main>
  <div id="stage">
    <canvas id="cv"></canvas>
    <div id="crumbs"></div>
    <div id="legend"></div>
    <div id="tip" hidden></div>
    <details id="help"><summary>How to read this</summary>
      <p>A dot is a file (folders in the Folders view); a bigger dot is a bigger file. An arrow from A to B means A imports B. A dashed orange line joins files that change together in git without importing each other. A dashed ring marks a test file.</p>
      <p>Click a dot for what is in it and what it connects to. Double-click a folder to open it. Scroll to zoom, drag to move. Search finds file names and the functions and classes RIA found.</p>
      <p>Only imports are drawn: the page does not know which function calls which.</p>
    </details>
  </div>
  <aside id="panel"></aside>
</main>
<script type="application/json" id="ria-data">${safeJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
