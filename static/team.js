// ── Team panel — renders like Kanban (sidebar info + big center diagram) ──────
// Clean tab, switched by the host's switchPanel() exactly like chat→kanban: the
// rail Team button calls switchPanel('team'), which reveals the sidebar #panelTeam
// (left info: stats, legend, drill-down detail) and the main #mainTeam (center:
// org tree / roster / reuse / calibrate) via the `showing-team` class, then calls
// loadTeamPanel() — mirroring loadKanban(). This file only renders into those
// existing containers; it does not touch the panel/main switching machinery.
//
// Views (toggle in the main header): Graph (org tree, live Kanban overlay) ·
// Roster (table) · Reuse (capability bipartite) · Calibrate (promptfoo hit-rate).
// Reads team/*.yaml + eval-summary.json read-only via /api/team*. No bundler:
// vendored cytoscape+dagre + js-yaml lazy-injected on first open.

let _teamData = null, _teamView = null, _teamCy = null, _teamSel = null, _teamStyled = false;
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
  if (_teamStyled) return; _teamStyled = true;
  const css = `
  #mainTeam .team-view-toggle{display:inline-flex;gap:4px;flex-wrap:wrap}
  #mainTeam .team-view-btn{width:auto;height:auto;padding:4px 12px;font-size:12px;line-height:1.4;border:1px solid var(--border,#e5e7eb);border-radius:6px;background:var(--bg,#fff);color:var(--muted,#6b7280);cursor:pointer;white-space:nowrap}
  #mainTeam .team-view-btn:hover{background:var(--surface,#f3f4f6)}
  #mainTeam .team-view-btn.active{background:var(--accent,#5b8def);color:#fff;border-color:transparent}
  #teamCenter .team-cy{position:absolute;inset:0}
  #teamCenter .team-scroll{position:absolute;inset:0;overflow:auto;padding:10px 14px}
  #teamCenter .team-matrix{border-collapse:separate;border-spacing:0;font-size:13.5px}
  #teamCenter .team-matrix th,#teamCenter .team-matrix td{border-bottom:1px solid var(--border,#eee);border-right:1px solid var(--border,#eee)}
  #teamCenter .team-matrix thead th{position:sticky;top:0;z-index:3;background:var(--bg,#fff);vertical-align:bottom;padding:4px 0}
  #teamCenter .team-matrix .tm-rolehead{cursor:pointer}
  #teamCenter .team-matrix .tm-rolehead span{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;font-weight:500;font-size:13.5px;color:var(--muted,#6b7280);display:inline-block;padding:6px 2px}
  #teamCenter .team-matrix .tm-corner{position:sticky;left:0;top:0;z-index:4;background:var(--bg,#fff);text-align:left;color:var(--muted,#6b7280);min-width:170px;vertical-align:bottom;padding:4px 8px;font-weight:500}
  #teamCenter .team-matrix .tm-cap{position:sticky;left:0;z-index:2;background:var(--bg,#fff);cursor:pointer;white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis;padding:5px 10px}
  #teamCenter .team-matrix .tm-cap:hover{background:var(--surface,#f3f4f6)}
  #teamCenter .team-matrix .tm-x{color:var(--muted,#6b7280);font-size:11px}
  #teamCenter .team-matrix .tm-cell{width:22px;min-width:22px;height:22px;padding:0}
  #teamCenter .team-matrix tbody tr:hover td{box-shadow:inset 0 0 0 9999px rgba(14,165,233,.10)}
  #teamCenter .team-matrix .tm-colhl{box-shadow:inset 0 0 0 9999px rgba(14,165,233,.12)}
  #teamCenter .team-note{position:absolute;top:6px;left:12px;font-size:11px;color:var(--muted,#6b7280);z-index:2;pointer-events:none;background:var(--main-bg,#fff);padding:0 4px;border-radius:4px}
  #teamInfo .ti-stat{color:var(--muted,#6b7280)} #teamInfo .ti-legend{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--muted,#6b7280)}
  #teamInfo .ti-legend span{display:inline-flex;align-items:center;gap:4px} #teamInfo .ti-legend i{width:9px;height:9px;border-radius:2px;display:inline-block}
  #panelTeam .team-div-h,#teamCenter .team-div-h{margin:14px 0 4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#6b7280)}
  #teamCenter .team-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
  #teamCenter .team-tbl th{text-align:left;color:var(--muted,#6b7280);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--border,#e5e7eb)}
  #teamCenter .team-tbl td{padding:5px 8px;border-bottom:1px solid var(--border,#f0f0f0);vertical-align:top}
  #teamCenter .team-row{cursor:pointer} #teamCenter .team-row:hover{background:var(--surface,#f6f7f9)}
  #panelTeam .team-badge,#teamCenter .team-badge{display:inline-block;font-size:10.5px;line-height:1.5;padding:0 6px;border-radius:10px;margin:1px 3px 1px 0;white-space:nowrap;border:1px solid transparent}
  .tb-native{background:#e7f6ec;color:#1f7a3f;border-color:#bfe3cc} .tb-self{background:#f3e8ff;color:#7c3aed;border-color:#e4cdff}
  .tb-oss{background:#e8f0fe;color:#1a56db;border-color:#cdddfb} .tb-official{background:#fff4e0;color:#a8620b;border-color:#f3dcb0}
  .tb-mcp{background:#e0f5f8;color:#0a6e80;border-color:#bce6ec} .tb-shared{background:#eef0f2;color:#475569;border-color:#d8dde2;font-style:italic}
  #panelTeam .team-chip,#teamCenter .team-chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:6px;background:var(--surface,#f3f4f6);margin:2px 4px 2px 0}
  #panelTeam .ts-sub{color:var(--muted,#6b7280);font-size:12px} #panelTeam .ts-sec{margin:11px 0 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#6b7280)}
  #panelTeam #teamDetail h3{margin:0 0 2px;font-size:14px}
  `;
  const el = document.createElement('style'); el.id = 'teamPanelStyle'; el.textContent = css; document.head.appendChild(el);
}

// Entry point — mirrors loadKanban(). Called by switchPanel('team') and Refresh.
async function loadTeamPanel(force){
  _teamInjectStyle();
  const center = document.getElementById('teamCenter');
  if (_teamData && !force){ _teamRender(); return; }
  if (center) center.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px">Loading team…</div>';
  try {
    await _teamEnsureLibs();
    const r = await fetch('/api/team', { headers: { 'Accept': 'application/json' } });
    const raw = ((await r.json()) || {}).team || {};
    _teamData = { roster: raw.roster ? jsyaml.load(raw.roster) : null, plugins: raw.plugins ? jsyaml.load(raw.plugins) : null, engines: raw.engines ? jsyaml.load(raw.engines) : null };
  } catch(e){ if (center) center.innerHTML = '<div style="padding:16px;color:#e05252;font-size:12px">Failed to load team: ' + _teamEsc(e && e.message) + '</div>'; return; }
  _teamView = _teamView || localStorage.getItem(_TEAM_VIEW_KEY) || 'graph';
  _teamRender();
}

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
  [['teamViewGraphBtn','graph'],['teamViewRosterBtn','roster'],['teamViewReuseBtn','reuse'],['teamViewCalibrateBtn','calibrate']].forEach(([id,v]) => { const b = document.getElementById(id); if (b) b.classList.toggle('active', _teamView === v); });
  // sidebar: stats + legend
  const info = document.getElementById('teamInfo');
  if (info){
    const roles = _teamRoles(), divs = new Set(roles.map(r => r.division)), core = roles.filter(r => r.tier === 'core').length;
    let h = `<div class="ti-stat"><b>${_teamEsc((_teamData.roster && _teamData.roster.team) || 'team')}</b> · ${roles.length} roles · ${divs.size} divisions · ${core} core / ${roles.length - core} optional</div>`;
    if (_teamView === 'graph') h += '<div class="ti-legend"><span><i style="background:' + _TEAM_AUTONOMY_COLOR.autonomous + '"></i>autonomous</span><span><i style="background:' + _TEAM_AUTONOMY_COLOR['hitl-assistant'] + '"></i>hitl</span><span>◇ brain-side</span><span>ring=live: <i style="background:#ffc233"></i>run <i style="background:#5b8def"></i>ready <i style="background:#e05252"></i>blocked</span></div>';
    info.innerHTML = h;
  }
  // main center
  _teamStopLive(); if (_teamCy){ try { _teamCy.destroy(); } catch(_){} _teamCy = null; }
  const center = document.getElementById('teamCenter'); if (!center) return; center.innerHTML = '';
  if (_teamView === 'roster') _teamRenderRoster(center);
  else if (_teamView === 'reuse') _teamRenderReuse(center);
  else if (_teamView === 'calibrate') _teamRenderCalibrate(center);
  else _teamRenderGraph(center);
  _teamRenderDetail();
}

function _teamRenderGraph(center){
  const host = document.createElement('div'); host.className = 'team-cy'; center.appendChild(host);
  const nodes = [], edges = [], seen = {};
  nodes.push({ data: { id: '__root', label: 'Founder ▸ CTO / Kanban', kind: 'root' } });
  _teamRoles().forEach(r => {
    if (!seen[r.division]){ seen[r.division] = 1; nodes.push({ data: { id: 'div__' + r.division, label: r.division, kind: 'div', color: _TEAM_DIV_COLORS[r.division] || '#6b7280' } }); edges.push({ data: { id: 'e_root_' + r.division, source: '__root', target: 'div__' + r.division } }); }
    const hand = _teamField(r, 'hand'); const brain = (!hand || hand === 'none') ? 1 : 0;
    nodes.push({ data: { id: 'role__' + r.name, label: r.name, kind: 'role', role: r.name, color: _TEAM_AUTONOMY_COLOR[r.autonomy] || '#6b7280', tier: r.tier || 'optional', brain } });
    edges.push({ data: { id: 'e_' + r.division + '_' + r.name, source: 'div__' + r.division, target: 'role__' + r.name } });
  });
  _teamCy = cytoscape({ container: host, elements: { nodes, edges }, style: [
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
      { selector: '.faded', style: { 'opacity': 0.18 } },
      { selector: 'node.team-sel', style: { 'border-width': 4, 'border-color': '#0ea5e9' } },
    ],
    layout: { name: window.cytoscape.__dagreRegistered ? 'dagre' : 'breadthfirst', rankDir: 'TB', nodeSep: 16, rankSep: 56, directed: true, padding: 18 }, wheelSensitivity: 0.2 });
  _teamCy.on('tap', 'node[kind="role"]', evt => _teamSelectRole(evt.target.data('role')));
  _teamCy.on('mouseover', 'node', evt => { const hood = evt.target.closedNeighborhood(); _teamCy.elements().not(hood).addClass('faded'); });
  _teamCy.on('mouseout', 'node', () => _teamCy.elements().removeClass('faded'));
  if (_teamSel && _teamSel.role){ const n = _teamCy.getElementById('role__' + _teamSel.role); if (n) n.addClass('team-sel'); }
  setTimeout(() => { try { _teamCy && _teamCy.resize(); _teamCy && _teamCy.fit(undefined, 24); } catch(_){} }, 60);
  _teamStartLive();
}

function _teamRenderRoster(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  const byDiv = {}; _teamRoles().forEach(r => (byDiv[r.division] = byDiv[r.division] || []).push(r));
  let html = '';
  _TEAM_DIV_ORDER.concat(Object.keys(byDiv).filter(d => !_TEAM_DIV_ORDER.includes(d))).forEach(div => {
    const rows = byDiv[div]; if (!rows) return;
    html += `<div class="team-div-h">${_teamEsc(div)}</div><table class="team-tbl"><thead><tr><th>role</th><th>tier</th><th>autonomy</th><th>hand</th><th>skills</th><th>does</th></tr></thead><tbody>`;
    rows.sort((a,b)=>(a.tier!=='core')-(b.tier!=='core')||a.name.localeCompare(b.name)).forEach(r => { const h = _teamField(r,'hand'); html += `<tr class="team-row" onclick="_teamSelectRole('${_teamEsc(r.name)}')"><td><b>${_teamEsc(r.name)}</b></td><td>${_teamEsc(r.tier||'')}</td><td>${_teamEsc(r.autonomy||'')}</td><td>${_teamEsc((!h||h==='none')?'—':h)}</td><td>${(r.skills||[]).map(s=>'<span class="team-chip">'+_teamEsc(s)+'</span>').join('')}</td><td style="max-width:340px">${_teamEsc(r.does||'')}</td></tr>`; });
    html += '</tbody></table>';
  });
  wrap.innerHTML = html;
}

// Reuse view = capability × role matrix (the industry skills-matrix pattern):
// rows = capabilities sorted by reuse count desc (most-shared on top = the reuse
// hierarchy), cols = roles grouped by division, cells colored by source. Hover a
// row/column → it highlights; click → detail. Matrix beats a bipartite hairball
// for "what is reused" (visvar.github.io/abdelaal2022comparative).
function _teamRenderReuse(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  const caps = _teamBuildCaps().slice().sort((a, b) => b.roles.length - a.roles.length || a.label.localeCompare(b.label));
  const roles = _teamRoles().slice().sort((a, b) => (_TEAM_DIV_ORDER.indexOf(a.division) - _TEAM_DIV_ORDER.indexOf(b.division)) || a.name.localeCompare(b.name));
  if (!caps.length || !roles.length){ wrap.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:12px">No capabilities.</div>'; return; }
  let h = '<table class="team-matrix"><thead><tr><th class="tm-corner">capability ↓ · ×reuse / role →</th>';
  roles.forEach((r, i) => { h += `<th class="tm-rolehead" data-col="${i}" style="border-top:3px solid ${_TEAM_DIV_COLORS[r.division] || '#999'}" title="${_teamEsc(r.name)} · ${_teamEsc(r.division)}" onclick="_teamSelectRole('${_teamEsc(r.name)}')" onmouseover="_teamColHL(${i},true)" onmouseout="_teamColHL(${i},false)"><span>${_teamEsc(r.name)}</span></th>`; });
  h += '</tr></thead><tbody>';
  caps.forEach(c => {
    const used = new Set(c.roles);
    const col = _TEAM_SRC_COLOR[c.source.cls] || '#999';
    h += `<tr><td class="tm-cap" style="border-left:4px solid ${col}" onclick="_teamSelectCapability('${c.id}')" title="${_teamEsc(c.label)} — ${_teamEsc(c.source.label)}"><span>${_teamEsc(c.label.replace(/^[^/]*\//, ''))}</span> <span class="tm-x">×${c.roles.length}</span></td>`;
    roles.forEach((r, i) => { const on = used.has(r.name); h += `<td class="tm-cell" data-col="${i}"${on ? ` style="background:${col}"` : ''} onmouseover="_teamColHL(${i},true)" onmouseout="_teamColHL(${i},false)"></td>`; });
    h += '</tr>';
  });
  h += '</tbody></table>';
  wrap.innerHTML = h;
}
function _teamColHL(i, on){ document.querySelectorAll('#teamCenter .team-matrix [data-col="' + i + '"]').forEach(el => el.classList.toggle('tm-colhl', on)); }

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
  html += `<div style="margin:8px 0;font-size:14px">Routing accuracy <b>${pct(correct/total)}</b> <span style="color:var(--muted)">(${correct}/${total}) · ${_teamEsc(summary.engine||'promptfoo')} · ${_teamEsc(summary.generated||'')}</span></div>`;
  html += '<div class="team-div-h">per-role</div><table class="team-tbl"><thead><tr><th>role</th><th>support</th><th>recall</th><th>precision</th><th>F1</th></tr></thead><tbody>';
  roles.map(role => { const rs = roles.reduce((s,a)=>s+conf[role][a],0), cs = roles.reduce((s,e)=>s+conf[e][role],0), tp = conf[role][role]; const rc = rs?tp/rs:0, pr = cs?tp/cs:0; return { role, s: rs, rc, pr, f1: (pr+rc)?2*pr*rc/(pr+rc):0 }; }).filter(m=>m.s>0).sort((a,b)=>a.f1-b.f1).forEach(m => { html += `<tr${m.f1<0.999?' style="color:#b45309"':''}><td><b>${_teamEsc(m.role)}</b></td><td>${m.s}</td><td>${pct(m.rc)}</td><td>${pct(m.pr)}</td><td>${pct(m.f1)}</td></tr>`; });
  html += '</tbody></table><div class="team-div-h" style="margin-top:14px">confusion (rows=expected, cols=routed)</div><div style="overflow:auto"><table class="team-tbl" style="font-size:11px"><thead><tr><th>exp ＼ got</th>' + roles.map(a=>`<th title="${_teamEsc(a)}">${_teamEsc(a.length>6?a.slice(0,6)+'…':a)}</th>`).join('') + '</tr></thead><tbody>';
  roles.forEach(e => { html += `<tr><td><b>${_teamEsc(e)}</b></td>` + roles.map(a => { const v = conf[e][a]; if (!v) return '<td></td>'; const bg = e===a?'background:#e7f6ec;color:#1f7a3f;font-weight:bold':'background:#fdecec;color:#b91c1c'; return `<td style="text-align:center;${bg}">${v}</td>`; }).join('') + '</tr>'; });
  html += '</tbody></table></div><div style="color:var(--muted);font-size:12px;margin-top:8px">Off-diagonal (red) = misroutes → role pairs to tighten in routing.md.</div>';
  wrap.innerHTML = html;
}

// ── detail (sidebar #teamDetail) ─────────────────────────────────────────────
function _teamSelectRole(name){ _teamSel = { role: name }; if (_teamCy){ _teamCy.nodes('.team-sel').removeClass('team-sel'); const n = _teamCy.getElementById('role__' + name); if (n) n.addClass('team-sel'); } _teamRenderDetail(); }
function _teamSelectCapability(id){ _teamSel = { cap: id }; if (_teamCy) _teamCy.nodes('.team-sel').removeClass('team-sel'); _teamRenderDetail(); }
function _teamRenderDetail(){ const el = document.getElementById('teamDetail'); if (!el || !_teamSel) return; if (_teamSel.role) _teamRenderRoleDetail(el, _teamSel.role); else if (_teamSel.cap) _teamRenderCapDetail(el, _teamSel.cap); }

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
