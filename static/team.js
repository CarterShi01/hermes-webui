// ── Team panel — self-contained, full-area overlay (minimal-invasion) ─────────
// Mirrors the Kanban layout (left info column + big center diagram) but is 100%
// INDEPENDENT of the host webui: the ONLY hook is a rail button calling
// teamOpen(). This file builds its own overlay covering the content area (right
// of the 48px rail, below the titlebar), manages its own show/hide (it closes
// when any other rail/sidebar nav tab is clicked), and reads team/*.yaml +
// eval-summary.json read-only via /api/team and /api/team/eval. It does NOT touch
// panels.js / switchPanel / the sidebar panel-view system.
//
// Views (left column switches them): Graph (org tree, live Kanban overlay) ·
// Roster (table) · Reuse (capability bipartite) · Calibrate (promptfoo hit-rate).
// Clicking a node fills the left detail pane with source-badged capabilities.
//
// No bundler: vendored cytoscape+dagre + js-yaml lazy-injected on first open.

let _teamData = null, _teamView = 'graph', _teamCy = null, _teamSel = null, _teamMounted = false;
let _teamLiveTimer = null, _teamPulseTimer = null, _teamPulseOn = false;
const _TEAM_VIEW_KEY = 'hermes-webui-team-view';

const _TEAM_NATIVE_SKILLS = new Set(['software-development','autonomous-ai-agents','productivity','creative','research','data-science','mlops','devops','social-media','dogfood','github','kanban-orchestrator','kanban-worker']);
const _TEAM_SELFBUILD_SKILLS = new Set(['writing-plans','write-adr-from-decision','diagramming','encoding-review']);
const _TEAM_DIV_ORDER = ['leadership','engineering','product','design','data','domain','gtm-marketing','gtm-sales','ops-finance','ops-support','strategy'];
const _TEAM_DIV_COLORS = { leadership:'#b8860b', engineering:'#5b8def', product:'#0288a8', design:'#a855f7', data:'#3fa45b', domain:'#e0852e', 'gtm-marketing':'#e0529c', 'gtm-sales':'#d4a017', 'ops-finance':'#16a34a', 'ops-support':'#0ea5e9', strategy:'#6b7280' };
const _TEAM_AUTONOMY_COLOR = { autonomous:'#3fa45b', 'hitl-assistant':'#b8860b', none:'#9aa0a6' };
const _TEAM_SRC_COLOR = { 'tb-native':'#3fa45b','tb-self':'#7c3aed','tb-oss':'#1a56db','tb-official':'#a8620b','tb-mcp':'#0a6e80','tb-shared':'#64748b' };

function _teamEsc(s){ return (typeof esc === 'function') ? esc(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function _teamLoadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = false; s.onload = () => res(); s.onerror = () => rej(new Error('failed to load ' + src)); document.head.appendChild(s); }); }
async function _teamEnsureLibs(){
  if (!window.jsyaml)         await _teamLoadScript('static/vendor/js-yaml/4.1.0/js-yaml.min.js');
  if (!window.cytoscape)      await _teamLoadScript('static/vendor/cytoscape.min.js');
  if (!window.dagre)          await _teamLoadScript('static/vendor/dagre.min.js');
  if (!window.cytoscapeDagre) await _teamLoadScript('static/vendor/cytoscape-dagre.js');
  try { if (window.cytoscape && window.cytoscapeDagre && !window.cytoscape.__dagreRegistered){ window.cytoscape.use(window.cytoscapeDagre); window.cytoscape.__dagreRegistered = true; } } catch(_){}
}

function _teamInjectStyle(){
  if (document.getElementById('teamPanelStyle')) return;
  const css = `
  #teamRoot{position:fixed;z-index:15;display:flex;background:var(--main-bg,#fff);color:var(--text,#111)}
  #teamRoot .team-left{width:280px;flex-shrink:0;border-right:1px solid var(--border,#e5e7eb);background:var(--sidebar,#fafafa);display:flex;flex-direction:column;overflow:hidden}
  #teamRoot .team-center{flex:1;position:relative;min-width:0;overflow:hidden}
  #teamRoot .tl-head{padding:12px 14px 8px;border-bottom:1px solid var(--border,#eee)}
  #teamRoot .tl-head h2{margin:0;font-size:15px}
  #teamRoot .tl-head .tl-sub{color:var(--muted,#6b7280);font-size:11.5px;margin-top:2px}
  #teamRoot .tl-views{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px}
  #teamRoot .tl-views button{flex:1 1 calc(50% - 4px);border:1px solid var(--border,#e5e7eb);background:var(--bg,#fff);color:var(--muted,#6b7280);font-size:12px;padding:5px 8px;border-radius:6px;cursor:pointer}
  #teamRoot .tl-views button.active{background:var(--accent,#5b8def);color:#fff;border-color:transparent}
  #teamRoot .tl-legend{padding:4px 14px 8px;font-size:11px;color:var(--muted,#6b7280);display:flex;flex-wrap:wrap;gap:6px}
  #teamRoot .tl-legend span{display:inline-flex;align-items:center;gap:4px}
  #teamRoot .tl-legend i{width:9px;height:9px;border-radius:2px;display:inline-block}
  #teamRoot .tl-detail{flex:1;overflow:auto;padding:12px 14px;border-top:1px solid var(--border,#eee)}
  #teamRoot .tl-detail h3{margin:0 0 2px;font-size:14px}
  #teamRoot .ts-sub{color:var(--muted,#6b7280);font-size:12px}
  #teamRoot .ts-sec{margin:11px 0 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#6b7280)}
  #teamRoot .team-cy{position:absolute;inset:0}
  #teamRoot .team-scroll{position:absolute;inset:0;overflow:auto;padding:10px 14px}
  #teamRoot .team-note{position:absolute;top:6px;left:12px;font-size:11px;color:var(--muted,#6b7280);z-index:2;pointer-events:none;background:var(--main-bg,#fff);padding:0 4px;border-radius:4px}
  #teamRoot .team-div-h{margin:14px 0 4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#6b7280)}
  #teamRoot .team-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
  #teamRoot .team-tbl th{text-align:left;color:var(--muted,#6b7280);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--border,#e5e7eb)}
  #teamRoot .team-tbl td{padding:5px 8px;border-bottom:1px solid var(--border,#f0f0f0);vertical-align:top}
  #teamRoot .team-row{cursor:pointer} #teamRoot .team-row:hover{background:var(--surface,#f6f7f9)}
  #teamRoot .team-badge{display:inline-block;font-size:10.5px;line-height:1.5;padding:0 6px;border-radius:10px;margin:1px 3px 1px 0;white-space:nowrap;border:1px solid transparent}
  #teamRoot .tb-native{background:#e7f6ec;color:#1f7a3f;border-color:#bfe3cc} #teamRoot .tb-self{background:#f3e8ff;color:#7c3aed;border-color:#e4cdff}
  #teamRoot .tb-oss{background:#e8f0fe;color:#1a56db;border-color:#cdddfb} #teamRoot .tb-official{background:#fff4e0;color:#a8620b;border-color:#f3dcb0}
  #teamRoot .tb-mcp{background:#e0f5f8;color:#0a6e80;border-color:#bce6ec} #teamRoot .tb-shared{background:#eef0f2;color:#475569;border-color:#d8dde2;font-style:italic}
  #teamRoot .team-chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:6px;background:var(--surface,#f3f4f6);margin:2px 4px 2px 0}
  @media(max-width:640px){#teamRoot{flex-direction:column}#teamRoot .team-left{width:auto;max-height:46%;border-right:0;border-bottom:1px solid var(--border,#eee)}}
  `;
  const el = document.createElement('style'); el.id = 'teamPanelStyle'; el.textContent = css; document.head.appendChild(el);
}

function _teamMount(){
  if (_teamMounted) return; _teamMounted = true;
  _teamInjectStyle();
  const root = document.createElement('div'); root.id = 'teamRoot'; root.style.display = 'none';
  root.innerHTML =
    '<div class="team-left">'
    + '<div class="tl-head"><h2>Team</h2><div class="tl-sub" id="teamStats"></div></div>'
    + '<div class="tl-views">'
    +   '<button data-view="graph" onclick="setTeamView(\'graph\')">Graph</button>'
    +   '<button data-view="roster" onclick="setTeamView(\'roster\')">Roster</button>'
    +   '<button data-view="reuse" onclick="setTeamView(\'reuse\')">Reuse</button>'
    +   '<button data-view="calibrate" onclick="setTeamView(\'calibrate\')">Calibrate</button>'
    + '</div>'
    + '<div class="tl-legend" id="teamLegend"></div>'
    + '<div class="tl-detail" id="teamDetail"><div class="ts-sub">Click a role / capability to inspect its skills, tools and sources.</div></div>'
    + '</div>'
    + '<div class="team-center" id="teamCenter"></div>';
  document.body.appendChild(root);
  // Self-managed visibility: close when any OTHER nav tab is clicked (capture phase).
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('[data-panel]');
    if (btn && btn.dataset.panel !== 'team') _teamHide();
  }, true);
  window.addEventListener('resize', _teamReposition);
}

function _teamReposition(){
  const root = document.getElementById('teamRoot'); if (!root || root.style.display === 'none') return;
  const rail = document.querySelector('.rail');
  const tb = document.querySelector('.app-titlebar');
  const railShown = rail && rail.getBoundingClientRect().width > 0;
  const top = tb ? Math.round(tb.getBoundingClientRect().bottom) : 0;
  const left = railShown ? Math.round(rail.getBoundingClientRect().right) : 0;
  root.style.left = left + 'px'; root.style.top = top + 'px'; root.style.right = '0'; root.style.bottom = '0';
}

async function teamOpen(){
  _teamMount();
  document.querySelectorAll('[data-panel]').forEach(t => t.classList.toggle('active', t.dataset.panel === 'team'));
  const root = document.getElementById('teamRoot'); root.style.display = 'flex'; _teamReposition();
  if (!_teamData){
    try {
      await _teamEnsureLibs();
      const r = await fetch('/api/team', { headers: { 'Accept': 'application/json' } });
      const raw = ((await r.json()) || {}).team || {};
      _teamData = { roster: raw.roster ? jsyaml.load(raw.roster) : null, plugins: raw.plugins ? jsyaml.load(raw.plugins) : null, engines: raw.engines ? jsyaml.load(raw.engines) : null };
    } catch(e){ document.getElementById('teamCenter').innerHTML = '<div style="padding:20px;color:#e05252;font-size:12px">Failed to load team: ' + _teamEsc(e && e.message) + '</div>'; return; }
  }
  _teamView = _teamView || localStorage.getItem(_TEAM_VIEW_KEY) || 'graph';
  _teamRender();
}
function _teamHide(){ const root = document.getElementById('teamRoot'); if (root) root.style.display = 'none'; _teamStopLive(); }

// ── data helpers ─────────────────────────────────────────────────────────────
function _teamRoles(){ return (_teamData && _teamData.roster && _teamData.roster.roles) || []; }
function _teamDefaults(){ return (_teamData && _teamData.roster && _teamData.roster.defaults) || {}; }
function _teamRole(name){ return _teamRoles().find(r => r.name === name) || null; }
function _teamField(r, k){ const d = _teamDefaults(); return (r[k] !== undefined && r[k] !== null) ? r[k] : d[k]; }
function _teamPluginsFor(role){ const P = _teamData && _teamData.plugins; if (!P) return { shared: [], role: [] }; const r = _teamRole(role); const shared = [].concat(P.shared || []); if (r && r.division === 'engineering') shared.push(...(P.shared_engineering || [])); return { shared, role: [].concat((P.roles || {})[role] || []) }; }
function _teamPluginBadge(entry){ const i = entry.indexOf('/'); const mkt = i >= 0 ? entry.slice(0, i) : entry, plugin = i >= 0 ? entry.slice(i + 1) : null; if (mkt === 'official') return { label: (plugin || entry) + ' · official', cls: 'tb-official' }; const m = (_teamData.plugins && _teamData.plugins.marketplaces) || {}, spec = m[mkt] || {}; return { label: (plugin ? plugin + ' · ' : '') + mkt + (spec.type === 'skillkit' ? ' · skillkit' : ''), cls: 'tb-oss' }; }
function _teamSkillBadge(sk){ if (_TEAM_NATIVE_SKILLS.has(sk)) return { label: sk + ' · Hermes', cls: 'tb-native' }; if (_TEAM_SELFBUILD_SKILLS.has(sk)) return { label: sk + ' · self-build', cls: 'tb-self' }; return { label: sk, cls: 'tb-shared' }; }
function _teamPluginRepo(entry){ const i = entry.indexOf('/'); const mkt = i >= 0 ? entry.slice(0, i) : entry; if (mkt === 'official') return 'https://github.com/anthropics/claude-plugins-official'; const m = (_teamData.plugins && _teamData.plugins.marketplaces) || {}, spec = m[mkt]; return spec && spec.repo ? 'https://github.com/' + spec.repo : null; }
function _teamBuildCaps(){
  if (_teamData.__caps) return _teamData.__caps;
  const map = new Map(); const get = (k, init) => { let c = map.get(k); if (!c){ c = Object.assign({ key: k, id: 'cap_' + map.size, roles: [] }, init); map.set(k, c); } return c; };
  const add = (c, role) => { if (c.roles.indexOf(role) < 0) c.roles.push(role); };
  _teamRoles().forEach(r => {
    (r.skills || []).forEach(sk => add(get('skill:' + sk, { kind: 'skill', label: sk, source: _teamSkillBadge(sk), repo: null }), r.name));
    (r.mcp || []).forEach(m => add(get('mcp:' + m, { kind: 'mcp', label: m, source: { cls: 'tb-mcp', label: 'MCP' }, repo: null, where: 'external/mcp/' + m }), r.name));
    const { shared, role: own } = _teamPluginsFor(r.name);
    shared.forEach(e => { const c = get('plugin:' + e, { kind: 'plugin', label: e, source: _teamPluginBadge(e), repo: _teamPluginRepo(e), shared: true }); c.shared = true; add(c, r.name); });
    own.forEach(e => add(get('plugin:' + e, { kind: 'plugin', label: e, source: _teamPluginBadge(e), repo: _teamPluginRepo(e), shared: false }), r.name));
  });
  const caps = [...map.values()], byId = {}; caps.forEach(c => byId[c.id] = c);
  _teamData.__caps = caps; _teamData.__capById = byId; _teamData.__capByKey = map; return caps;
}

// ── render ───────────────────────────────────────────────────────────────────
function setTeamView(v){ _teamView = v; try { localStorage.setItem(_TEAM_VIEW_KEY, v); } catch(_){} _teamRender(); }

function _teamRender(){
  if (!_teamData) return;
  const root = document.getElementById('teamRoot'); if (!root || root.style.display === 'none') return;
  root.querySelectorAll('.tl-views button').forEach(b => b.classList.toggle('active', b.dataset.view === _teamView));
  // left: stats + legend
  const roles = _teamRoles(), divs = new Set(roles.map(r => r.division));
  const core = roles.filter(r => r.tier === 'core').length;
  const st = document.getElementById('teamStats'); if (st) st.textContent = `${(_teamData.roster && _teamData.roster.team) || 'team'} · ${roles.length} roles · ${divs.size} divisions · ${core} core / ${roles.length - core} optional`;
  const lg = document.getElementById('teamLegend');
  if (lg) lg.innerHTML = (_teamView === 'graph')
    ? '<span><i style="background:' + _TEAM_AUTONOMY_COLOR.autonomous + '"></i>autonomous</span><span><i style="background:' + _TEAM_AUTONOMY_COLOR['hitl-assistant'] + '"></i>hitl</span><span>◇ brain-side</span><span>ring = live: <i style="background:#ffc233"></i>running <i style="background:#5b8def"></i>ready <i style="background:#e05252"></i>blocked</span>'
    : '';
  // center
  _teamStopLive(); if (_teamCy){ try { _teamCy.destroy(); } catch(_){} _teamCy = null; }
  const center = document.getElementById('teamCenter'); center.innerHTML = '';
  if (_teamView === 'roster') _teamRenderRoster(center);
  else if (_teamView === 'reuse') _teamRenderReuse(center);
  else if (_teamView === 'calibrate') _teamRenderCalibrate(center);
  else _teamRenderGraph(center);
  _teamRenderDetail();
}

function _teamRenderGraph(center){
  const host = document.createElement('div'); host.className = 'team-cy'; center.appendChild(host);
  const nodes = [], edges = [];
  nodes.push({ data: { id: '__root', label: 'Founder ▸ CTO / Kanban', kind: 'root' } });
  const seen = {};
  _teamRoles().forEach(r => {
    if (!seen[r.division]){ seen[r.division] = 1; nodes.push({ data: { id: 'div__' + r.division, label: r.division, kind: 'div', color: _TEAM_DIV_COLORS[r.division] || '#6b7280' } }); edges.push({ data: { id: 'e_root_' + r.division, source: '__root', target: 'div__' + r.division } }); }
    const hand = _teamField(r, 'hand'); const brain = (!hand || hand === 'none') ? 1 : 0;
    nodes.push({ data: { id: 'role__' + r.name, label: r.name, kind: 'role', role: r.name, color: _TEAM_AUTONOMY_COLOR[r.autonomy] || '#6b7280', tier: r.tier || 'optional', brain } });
    edges.push({ data: { id: 'e_' + r.division + '_' + r.name, source: 'div__' + r.division, target: 'role__' + r.name } });
  });
  _teamCy = cytoscape({
    container: host, elements: { nodes, edges },
    style: [
      { selector: 'node', style: { 'label': 'data(label)', 'font-size': 10, 'color': '#fff', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 96, 'width': 'label', 'height': 'label', 'padding': 8, 'shape': 'round-rectangle' } },
      { selector: 'node[kind="root"]', style: { 'background-color': '#111827', 'font-size': 12, 'font-weight': 'bold' } },
      { selector: 'node[kind="div"]', style: { 'background-color': 'data(color)', 'font-size': 11 } },
      { selector: 'node[kind="role"]', style: { 'background-color': 'data(color)' } },
      { selector: 'node[brain=1]', style: { 'shape': 'round-diamond', 'border-width': 2, 'border-color': '#111827' } },
      { selector: 'node[tier="core"]', style: { 'border-width': 3, 'border-color': '#111827' } },
      { selector: 'edge', style: { 'width': 1.5, 'line-color': '#cbd5e1', 'target-arrow-color': '#cbd5e1', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
      { selector: 'node[kind="role"][live="running"]', style: { 'border-width': 5, 'border-color': '#ffc233' } },
      { selector: 'node[kind="role"][live="blocked"]', style: { 'border-width': 4, 'border-color': '#e05252' } },
      { selector: 'node[kind="role"][live="ready"]',   style: { 'border-width': 4, 'border-color': '#5b8def' } },
      { selector: 'node[kind="role"].lp', style: { 'border-width': 8 } },
      { selector: 'node.team-sel', style: { 'border-width': 4, 'border-color': '#0ea5e9' } },
    ],
    layout: { name: window.cytoscape.__dagreRegistered ? 'dagre' : 'breadthfirst', rankDir: 'TB', nodeSep: 16, rankSep: 56, directed: true, padding: 18 },
    wheelSensitivity: 0.2,
  });
  _teamCy.on('tap', 'node[kind="role"]', evt => _teamSelectRole(evt.target.data('role')));
  if (_teamSel && _teamSel.role){ const n = _teamCy.getElementById('role__' + _teamSel.role); if (n) n.addClass('team-sel'); }
  _teamStartLive();
}

function _teamRenderRoster(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  const byDiv = {}; _teamRoles().forEach(r => (byDiv[r.division] = byDiv[r.division] || []).push(r));
  let html = '';
  _TEAM_DIV_ORDER.concat(Object.keys(byDiv).filter(d => !_TEAM_DIV_ORDER.includes(d))).forEach(div => {
    const rows = byDiv[div]; if (!rows) return;
    html += `<div class="team-div-h">${_teamEsc(div)}</div><table class="team-tbl"><thead><tr><th>role</th><th>tier</th><th>autonomy</th><th>hand</th><th>skills</th><th>does</th></tr></thead><tbody>`;
    rows.sort((a,b)=>(a.tier!=='core')-(b.tier!=='core')||a.name.localeCompare(b.name)).forEach(r => { const h = _teamField(r,'hand'); html += `<tr class="team-row" onclick="_teamSelectRole('${_teamEsc(r.name)}')"><td><b>${_teamEsc(r.name)}</b></td><td>${_teamEsc(r.tier||'')}</td><td>${_teamEsc(r.autonomy||'')}</td><td>${_teamEsc((!h||h==='none')?'—':h)}</td><td>${(r.skills||[]).map(s=>'<span class="team-chip">'+_teamEsc(s)+'</span>').join('')}</td><td style="max-width:320px">${_teamEsc(r.does||'')}</td></tr>`; });
    html += '</tbody></table>';
  });
  wrap.innerHTML = html;
}

function _teamRenderReuse(center){
  const caps = _teamBuildCaps().filter(c => c.roles.length >= 2);
  const host = document.createElement('div'); host.className = 'team-cy'; center.appendChild(host);
  const note = document.createElement('div'); note.className = 'team-note'; note.textContent = 'Shared capabilities reused by ≥2 roles — click a hub for detail'; center.appendChild(note);
  if (!caps.length){ host.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:12px">No capability shared by ≥2 roles.</div>'; return; }
  const roleSet = new Set(); caps.forEach(c => c.roles.forEach(r => roleSet.add(r)));
  const nodes = [], edges = [];
  caps.forEach(c => { nodes.push({ data: { id: c.id, label: c.label.replace(/^[^/]*\//, '') + ' ×' + c.roles.length, kind: 'cap', color: _TEAM_SRC_COLOR[c.source.cls] || '#6b7280' } }); c.roles.forEach(rn => edges.push({ data: { id: c.id + '__' + rn, source: c.id, target: 'r__' + rn } })); });
  roleSet.forEach(rn => { const r = _teamRole(rn) || {}; nodes.push({ data: { id: 'r__' + rn, label: rn, kind: 'role', role: rn, color: _TEAM_AUTONOMY_COLOR[r.autonomy] || '#6b7280' } }); });
  _teamCy = cytoscape({ container: host, elements: { nodes, edges }, style: [
      { selector: 'node', style: { 'label': 'data(label)', 'font-size': 9, 'color': '#fff', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 100, 'width': 'label', 'height': 'label', 'padding': 6, 'shape': 'round-rectangle' } },
      { selector: 'node[kind="cap"]', style: { 'background-color': 'data(color)', 'font-weight': 'bold', 'padding': 9, 'border-width': 2, 'border-color': '#fff' } },
      { selector: 'node[kind="role"]', style: { 'background-color': 'data(color)' } },
      { selector: 'edge', style: { 'width': 1, 'line-color': '#d1d5db', 'curve-style': 'haystack', 'haystack-radius': 0.4 } },
    ],
    layout: { name: 'concentric', concentric: n => n.data('kind') === 'cap' ? 2 : 1, levelWidth: () => 1, minNodeSpacing: 16, padding: 24 }, wheelSensitivity: 0.2 });
  _teamCy.on('tap', 'node[kind="cap"]', e => _teamSelectCapability(e.target.id()));
  _teamCy.on('tap', 'node[kind="role"]', e => _teamSelectRole(e.target.data('role')));
}

async function _teamRenderCalibrate(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  wrap.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading eval…</div>';
  let summary = null;
  try { const r = await fetch('/api/team/eval', { headers: { 'Accept': 'application/json' } }); if (r.ok) summary = ((await r.json()) || {}).summary; } catch(_){}
  const rows = (summary && summary.rows) || [];
  if (!rows.length){ wrap.innerHTML = '<div style="font-size:12.5px;line-height:1.7"><b>No eval yet.</b> Hit-rate is computed by the open-source engine <a href="https://github.com/promptfoo/promptfoo" target="_blank" rel="noopener">promptfoo</a> (we only render its output). Run in <code>team/eval/</code>:<pre style="background:var(--surface,#f3f4f6);padding:8px;border-radius:6px;overflow:auto">npx promptfoo@latest eval -c promptfooconfig.yaml -o results.json\npython3 summarize.py results.json eval-summary.json</pre></div>'; return; }
  const roles = [...new Set(rows.flatMap(r => [r.expected, r.actual]).filter(Boolean))].sort();
  const total = rows.length, correct = rows.filter(r => r.ok || r.expected === r.actual).length;
  const conf = {}; roles.forEach(e => { conf[e] = {}; roles.forEach(a => conf[e][a] = 0); });
  rows.forEach(r => { if (conf[r.expected] && conf[r.expected][r.actual] !== undefined) conf[r.expected][r.actual]++; });
  const pct = x => (x*100).toFixed(0) + '%';
  let html = '';
  if (summary.sample) html += '<div class="team-badge tb-official">SAMPLE (baseline keyword router) — run the eval for real numbers</div>';
  html += `<div style="margin:8px 0;font-size:14px">Routing accuracy <b>${pct(correct/total)}</b> <span class="ts-sub">(${correct}/${total}) · ${_teamEsc(summary.engine||'promptfoo')} · ${_teamEsc(summary.generated||'')}</span></div>`;
  html += '<div class="team-div-h">per-role</div><table class="team-tbl"><thead><tr><th>role</th><th>support</th><th>recall</th><th>precision</th><th>F1</th></tr></thead><tbody>';
  roles.map(role => { const rs = roles.reduce((s,a)=>s+conf[role][a],0), cs = roles.reduce((s,e)=>s+conf[e][role],0), tp = conf[role][role]; const rc = rs?tp/rs:0, pr = cs?tp/cs:0; return { role, s: rs, rc, pr, f1: (pr+rc)?2*pr*rc/(pr+rc):0 }; }).filter(m=>m.s>0).sort((a,b)=>a.f1-b.f1).forEach(m => { html += `<tr${m.f1<0.999?' style="color:#b45309"':''}><td><b>${_teamEsc(m.role)}</b></td><td>${m.s}</td><td>${pct(m.rc)}</td><td>${pct(m.pr)}</td><td>${pct(m.f1)}</td></tr>`; });
  html += '</tbody></table><div class="team-div-h" style="margin-top:14px">confusion (rows=expected, cols=routed)</div><div style="overflow:auto"><table class="team-tbl" style="font-size:11px"><thead><tr><th>exp ＼ got</th>' + roles.map(a=>`<th title="${_teamEsc(a)}">${_teamEsc(a.length>6?a.slice(0,6)+'…':a)}</th>`).join('') + '</tr></thead><tbody>';
  roles.forEach(e => { html += `<tr><td><b>${_teamEsc(e)}</b></td>` + roles.map(a => { const v = conf[e][a]; if (!v) return '<td></td>'; const bg = e===a?'background:#e7f6ec;color:#1f7a3f;font-weight:bold':'background:#fdecec;color:#b91c1c'; return `<td style="text-align:center;${bg}">${v}</td>`; }).join('') + '</tr>'; });
  html += '</tbody></table></div><div class="ts-sub" style="margin-top:8px">Off-diagonal (red) = misroutes → role pairs to tighten in routing.md.</div>';
  wrap.innerHTML = html;
}

// ── detail (left column) ─────────────────────────────────────────────────────
function _teamSelectRole(name){ _teamSel = { role: name }; if (_teamCy){ _teamCy.nodes('.team-sel').removeClass('team-sel'); const n = _teamCy.getElementById('role__' + name); if (n) n.addClass('team-sel'); } _teamRenderDetail(); }
function _teamSelectCapability(id){ _teamSel = { cap: id }; if (_teamCy) _teamCy.nodes('.team-sel').removeClass('team-sel'); _teamRenderDetail(); }

function _teamRenderDetail(){
  const el = document.getElementById('teamDetail'); if (!el || !_teamSel) return;
  if (_teamSel.role) return _teamRenderRoleDetail(el, _teamSel.role);
  if (_teamSel.cap) return _teamRenderCapDetail(el, _teamSel.cap);
}
function _teamRenderRoleDetail(el, name){
  const r = _teamRole(name); if (!r) return;
  _teamBuildCaps(); const capByKey = _teamData.__capByKey;
  const clk = key => { const c = capByKey && capByKey.get(key); return c ? ` style="cursor:pointer" onclick="_teamSelectCapability('${c.id}')"` : ''; };
  const hand = _teamField(r, 'hand'); const isBrain = (!hand || hand === 'none');
  const eng = (_teamData.engines && _teamData.engines.engines && _teamData.engines.engines[hand]) || null;
  const handLine = isBrain ? 'brain-side (no hand): kanban + memory' : (hand + (eng ? ` · ${eng.binary || ''}${eng.status ? ' (' + eng.status + ')' : ''}` : ''));
  const { shared, role: own } = _teamPluginsFor(name);
  const skills = (r.skills || []).map(sk => { const b = _teamSkillBadge(sk); return `<span class="team-badge ${b.cls}"${clk('skill:'+sk)}>${_teamEsc(b.label)}</span>`; }).join('') || '<span class="ts-sub">—</span>';
  const prow = (e, sh) => { const b = _teamPluginBadge(e); return `<span class="team-badge ${b.cls}"${clk('plugin:'+e)}>${_teamEsc(b.label)}</span>${sh ? '<span class="team-badge tb-shared">shared</span>' : ''}`; };
  const plugins = isBrain ? '<span class="ts-sub">brain-side — no CC plugins</span>' : ((shared.map(e=>prow(e,true)).join('') + own.map(e=>prow(e,false)).join('')) || '<span class="ts-sub">base layer only</span>');
  const mcp = (r.mcp || []).map(x => `<span class="team-badge tb-mcp"${clk('mcp:'+x)}>${_teamEsc(x)} · MCP</span>`).join('') || '<span class="ts-sub">—</span>';
  el.innerHTML = `<h3>${_teamEsc(r.name)}</h3><div class="ts-sub">${_teamEsc(r.division)} · ${_teamEsc(r.tier||'')} · ${_teamEsc(r.autonomy||'')}</div>`
    + `<div style="margin-top:6px;font-size:12.5px">${_teamEsc(r.does || '')}</div>`
    + `<div class="ts-sec">hand (engine · L4a)</div><div style="font-size:12.5px">${_teamEsc(handLine)}</div>`
    + `<div class="ts-sec">toolsets</div><div>${(r.toolsets||[]).map(x=>'<span class="team-chip">'+_teamEsc(x)+'</span>').join('')||'—'}</div>`
    + `<div class="ts-sec">skills (source)</div><div>${skills}</div>`
    + `<div class="ts-sec">CC plugins (source · reuse)</div><div>${plugins}</div>`
    + `<div class="ts-sec">MCP tools (L4b)</div><div>${mcp}</div>`;
}
function _teamRenderCapDetail(el, id){
  const c = (_teamData.__capById || {})[id]; if (!c) return;
  const roles = [...new Set(c.roles)].sort();
  const chips = roles.map(rn => `<span class="team-chip" style="cursor:pointer" onclick="_teamSelectRole('${_teamEsc(rn)}')">${_teamEsc(rn)}</span>`).join('');
  let where = '<span class="ts-sub">—</span>';
  if (c.repo) where = `<a href="${_teamEsc(c.repo)}" target="_blank" rel="noopener">${_teamEsc(c.repo.replace('https://github.com/', ''))}</a>`;
  else if (c.where) where = _teamEsc(c.where);
  else if (c.source.cls === 'tb-native') where = 'Hermes bundled skill';
  else if (c.source.cls === 'tb-self') where = 'self-build (team/skills or docs)';
  el.innerHTML = `<h3>${_teamEsc(c.label)}</h3><div class="ts-sub">${_teamEsc(c.kind)}${c.shared ? ' · shared layer' : ''}</div>`
    + `<div class="ts-sec">source</div><div><span class="team-badge ${c.source.cls}">${_teamEsc(c.source.label)}</span></div>`
    + `<div class="ts-sec">used by ${roles.length} role(s)</div><div>${chips}</div>`
    + `<div class="ts-sec">where</div><div style="font-size:12px;word-break:break-all">${where}</div>`;
}

// ── live Kanban overlay (P3) ─────────────────────────────────────────────────
async function _teamFetchBoard(){ try { if (typeof api === 'function'){ const q = (typeof _kanbanBoardQuery === 'function') ? _kanbanBoardQuery() : ''; return await api('/api/kanban/board' + (q || '')); } } catch(_){} return (typeof _kanbanBoard !== 'undefined' && _kanbanBoard) || null; }
function _teamLiveByRole(board){ const m = {}; ((board && board.columns) || []).forEach(col => (col.tasks || []).forEach(t => { let a = t.assignee || ''; if (a[0] === '@') a = a.slice(1); if (!a) return; const st = t.status || 'triage'; if (st === 'done' || st === 'archived') return; const e = m[a] || (m[a] = { running:0,blocked:0,ready:0,todo:0,total:0 }); if (st==='running') e.running++; else if (st==='blocked') e.blocked++; else if (st==='ready') e.ready++; else e.todo++; e.total++; })); return m; }
async function _teamApplyLive(){ if (!_teamCy || _teamView !== 'graph') return; const board = await _teamFetchBoard(); if (!_teamCy || _teamView !== 'graph') return; const live = _teamLiveByRole(board || {}); _teamCy.batch(() => { _teamRoles().forEach(r => { const n = _teamCy.getElementById('role__' + r.name); if (!n || n.empty()) return; const e = live[r.name]; const s = e ? (e.running?'running':e.blocked?'blocked':e.ready?'ready':e.todo?'todo':'') : ''; n.data('live', s); n.data('label', r.name + (e && e.total ? '  ●' + e.total : '')); }); }); }
function _teamPulseTick(){ if (!_teamCy || _teamView !== 'graph') return; _teamPulseOn = !_teamPulseOn; try { _teamCy.nodes('node[live="running"]').toggleClass('lp', _teamPulseOn); } catch(_){} }
function _teamStartLive(){ _teamStopLive(); _teamApplyLive(); _teamLiveTimer = setInterval(_teamApplyLive, 9000); _teamPulseTimer = setInterval(_teamPulseTick, 600); }
function _teamStopLive(){ if (_teamLiveTimer){ clearInterval(_teamLiveTimer); _teamLiveTimer = null; } if (_teamPulseTimer){ clearInterval(_teamPulseTimer); _teamPulseTimer = null; } }
