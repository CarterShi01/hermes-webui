// ── Team panel: view & manage the agent team (P1) ────────────────────────────
// A left-rail panel, peer to Chat/Kanban. Reads the team's single source of truth
// (team/roster.yaml + plugins.yaml + engines.yaml, served read-only by /api/team)
// and renders, with an internal view toggle:
//   • Graph  — global org view: CTO/Kanban → divisions → roles (colored by autonomy)
//   • Roster — table grouped by division
// Clicking a role opens a drill-down drawer: identity, hand (engine), toolsets,
// skills + CC plugins WITH SOURCE BADGES (Hermes-native / OSS marketplace / shared
// layer / self-build), MCP. Source of truth stays in the repo; this panel is
// read-only. No bundler: reuses the vendored cytoscape+dagre (like kanban-graph.js)
// and js-yaml, lazy-injected on first open.

let _teamData = null;            // { roster, plugins, engines } parsed objects
let _teamView = null;            // 'graph' | 'roster'
let _teamCy = null;
let _teamSelectedRole = null;
const _TEAM_VIEW_KEY = 'hermes-webui-team-view';

// Hermes-native bundled skills (free baseline) vs self-built — drives source badges.
const _TEAM_NATIVE_SKILLS = new Set(['software-development','autonomous-ai-agents','productivity','creative','research','data-science','mlops','devops','social-media','dogfood','github','kanban-orchestrator','kanban-worker']);
const _TEAM_SELFBUILD_SKILLS = new Set(['writing-plans','write-adr-from-decision','diagramming','encoding-review']);

const _TEAM_DIV_COLORS = { leadership:'#b8860b', engineering:'#5b8def', product:'#0288a8', design:'#a855f7', data:'#3fa45b', domain:'#e0852e', 'gtm-marketing':'#e0529c', 'gtm-sales':'#d4a017', 'ops-finance':'#16a34a', 'ops-support':'#0ea5e9', strategy:'#6b7280' };
const _TEAM_AUTONOMY_COLOR = { autonomous:'#3fa45b', 'hitl-assistant':'#b8860b', none:'#9aa0a6' };
const _TEAM_DIV_ORDER = ['leadership','engineering','product','design','data','domain','gtm-marketing','gtm-sales','ops-finance','ops-support','strategy'];
// Source badge class → node color (reuse graph hubs).
const _TEAM_SRC_COLOR = { 'tb-native':'#3fa45b', 'tb-self':'#7c3aed', 'tb-oss':'#1a56db', 'tb-official':'#a8620b', 'tb-mcp':'#0a6e80', 'tb-shared':'#64748b' };

function _teamEsc(s){ return (typeof esc === 'function') ? esc(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function _teamLoadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = false; s.onload = () => res(); s.onerror = () => rej(new Error('failed to load ' + src)); document.head.appendChild(s); }); }

async function _teamEnsureLibs(){
  if (!window.jsyaml)        await _teamLoadScript('static/vendor/js-yaml/4.1.0/js-yaml.min.js');
  if (!window.cytoscape)     await _teamLoadScript('static/vendor/cytoscape.min.js');
  if (!window.dagre)         await _teamLoadScript('static/vendor/dagre.min.js');
  if (!window.cytoscapeDagre)await _teamLoadScript('static/vendor/cytoscape-dagre.js');
  try { if (window.cytoscape && window.cytoscapeDagre && !window.cytoscape.__dagreRegistered){ window.cytoscape.use(window.cytoscapeDagre); window.cytoscape.__dagreRegistered = true; } } catch(_){}
}

function _teamInjectStyle(){
  if (document.getElementById('teamPanelStyle')) return;
  const css = `
  #panelTeam .team-toggle{display:inline-flex;gap:2px;background:var(--surface,#f3f4f6);border-radius:8px;padding:2px}
  #panelTeam .team-toggle button{border:0;background:transparent;color:var(--muted,#6b7280);font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer}
  #panelTeam .team-toggle button.active{background:var(--bg,#fff);color:var(--text,#111);box-shadow:0 1px 2px rgba(0,0,0,.08)}
  #teamBody{position:relative}
  .team-cy{position:absolute;inset:0}
  .team-roster{padding:8px 12px;overflow:auto;height:100%}
  .team-div-h{margin:14px 0 4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#6b7280)}
  .team-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
  .team-tbl th{text-align:left;color:var(--muted,#6b7280);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--border,#e5e7eb)}
  .team-tbl td{padding:5px 8px;border-bottom:1px solid var(--border,#f0f0f0);vertical-align:top}
  .team-row{cursor:pointer}
  .team-row:hover{background:var(--surface,#f6f7f9)}
  .team-badge{display:inline-block;font-size:10.5px;line-height:1.5;padding:0 6px;border-radius:10px;margin:1px 3px 1px 0;white-space:nowrap;border:1px solid transparent}
  .tb-native{background:#e7f6ec;color:#1f7a3f;border-color:#bfe3cc}
  .tb-self{background:#f3e8ff;color:#7c3aed;border-color:#e4cdff}
  .tb-oss{background:#e8f0fe;color:#1a56db;border-color:#cdddfb}
  .tb-official{background:#fff4e0;color:#a8620b;border-color:#f3dcb0}
  .tb-mcp{background:#e0f5f8;color:#0a6e80;border-color:#bce6ec}
  .tb-shared{background:#eef0f2;color:#475569;border-color:#d8dde2;font-style:italic}
  .team-side{position:absolute;top:0;right:0;height:100%;width:min(380px,86%);background:var(--bg,#fff);border-left:1px solid var(--border,#e5e7eb);box-shadow:-4px 0 16px rgba(0,0,0,.08);overflow:auto;padding:14px 16px;z-index:5}
  .team-side h3{margin:0 0 2px;font-size:15px}
  .team-side .ts-sub{color:var(--muted,#6b7280);font-size:12px;margin-bottom:10px}
  .team-side .ts-sec{margin:12px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#6b7280)}
  .team-side .ts-close{position:absolute;top:10px;right:12px;border:0;background:transparent;font-size:18px;cursor:pointer;color:var(--muted,#6b7280)}
  .team-chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:6px;background:var(--surface,#f3f4f6);margin:2px 4px 2px 0}
  `;
  const el = document.createElement('style'); el.id = 'teamPanelStyle'; el.textContent = css; document.head.appendChild(el);
}

async function loadTeamPanel(force){
  const panel = document.getElementById('panelTeam'); if (!panel) return;
  _teamInjectStyle();
  if (_teamData && !force){ _teamRender(); return; }
  const body = document.getElementById('teamBody');
  if (body) body.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px">Loading team…</div>';
  try {
    await _teamEnsureLibs();
    const r = await fetch('/api/team', { headers: { 'Accept': 'application/json' } });
    const data = await r.json();
    const raw = (data && data.team) || {};
    _teamData = {
      roster:  raw.roster  ? jsyaml.load(raw.roster)  : null,
      plugins: raw.plugins ? jsyaml.load(raw.plugins) : null,
      engines: raw.engines ? jsyaml.load(raw.engines) : null,
    };
  } catch(e){
    if (body) body.innerHTML = '<div style="padding:16px;color:#e05252;font-size:12px">Failed to load team: ' + _teamEsc(e && e.message) + '</div>';
    return;
  }
  _teamView = _teamView || (localStorage.getItem(_TEAM_VIEW_KEY) || 'graph');
  _teamRender();
}

function _teamRoles(){ return (_teamData && _teamData.roster && _teamData.roster.roles) || []; }
function _teamDefaults(){ return (_teamData && _teamData.roster && _teamData.roster.defaults) || {}; }
function _teamRole(name){ return _teamRoles().find(r => r.name === name) || null; }
function _teamField(r, k){ const d = _teamDefaults(); return (r[k] !== undefined && r[k] !== null) ? r[k] : d[k]; }

function _teamPluginsFor(role){
  const P = _teamData && _teamData.plugins; if (!P) return { shared: [], role: [] };
  const r = _teamRole(role);
  const shared = [].concat(P.shared || []);
  if (r && r.division === 'engineering') shared.push(...(P.shared_engineering || []));
  const own = [].concat((P.roles || {})[role] || []);
  return { shared, role: own };
}

function _teamPluginBadge(entry){
  const slash = entry.indexOf('/');
  const mkt = slash >= 0 ? entry.slice(0, slash) : entry;
  const plugin = slash >= 0 ? entry.slice(slash + 1) : null;
  if (mkt === 'official') return { label: (plugin || entry) + ' · official', cls: 'tb-official' };
  const m = (_teamData && _teamData.plugins && _teamData.plugins.marketplaces) || {};
  const spec = m[mkt] || {};
  const suffix = spec.type === 'skillkit' ? ' · skillkit' : '';
  return { label: (plugin ? plugin + ' · ' : '') + mkt + suffix, cls: 'tb-oss' };
}
function _teamSkillBadge(skill){
  if (_TEAM_NATIVE_SKILLS.has(skill)) return { label: skill + ' · Hermes', cls: 'tb-native' };
  if (_TEAM_SELFBUILD_SKILLS.has(skill)) return { label: skill + ' · self-build', cls: 'tb-self' };
  return { label: skill, cls: 'tb-shared' };
}

function setTeamView(v){ _teamView = v; try { localStorage.setItem(_TEAM_VIEW_KEY, v); } catch(_){} _teamRender(); }

function _teamRender(){
  if (!_teamData) return;
  [['teamGraphBtn','graph'],['teamRosterBtn','roster'],['teamReuseBtn','reuse']].forEach(([id,v]) => { const b = document.getElementById(id); if (b) b.classList.toggle('active', _teamView === v); });
  const body = document.getElementById('teamBody'); if (!body) return;
  if (_teamCy){ try { _teamCy.destroy(); } catch(_){} _teamCy = null; }
  body.innerHTML = '';
  if (_teamView === 'roster') _teamRenderRoster(body);
  else if (_teamView === 'reuse') _teamRenderReuse(body);
  else _teamRenderGraph(body);
  if (_teamSelectedRole) _teamRenderSide(_teamSelectedRole);
}

// ── Capability index (skill / CC plugin / MCP) across all roles → drives the
// Reuse bipartite view and the capability-detail drawer. Cached on _teamData. ──
function _teamPluginRepo(entry){
  const slash = entry.indexOf('/'); const mkt = slash >= 0 ? entry.slice(0, slash) : entry;
  if (mkt === 'official') return 'https://github.com/anthropics/claude-plugins-official';
  const m = (_teamData && _teamData.plugins && _teamData.plugins.marketplaces) || {};
  const spec = m[mkt];
  return (spec && spec.repo) ? ('https://github.com/' + spec.repo) : null;
}
function _teamBuildCaps(){
  if (_teamData.__caps) return _teamData.__caps;
  const map = new Map();
  const get = (key, init) => { let c = map.get(key); if (!c){ c = Object.assign({ key, id: 'cap_' + map.size, roles: [] }, init); map.set(key, c); } return c; };
  const add = (c, role) => { if (c.roles.indexOf(role) < 0) c.roles.push(role); };
  _teamRoles().forEach(r => {
    (r.skills || []).forEach(sk => add(get('skill:' + sk, { kind: 'skill', label: sk, source: _teamSkillBadge(sk), repo: null }), r.name));
    (r.mcp || []).forEach(m => add(get('mcp:' + m, { kind: 'mcp', label: m, source: { cls: 'tb-mcp', label: 'MCP' }, repo: null, where: 'external/mcp/' + m }), r.name));
    const { shared, role: own } = _teamPluginsFor(r.name);
    shared.forEach(e => { const c = get('plugin:' + e, { kind: 'plugin', label: e, source: _teamPluginBadge(e), repo: _teamPluginRepo(e), shared: true }); c.shared = true; add(c, r.name); });
    own.forEach(e => add(get('plugin:' + e, { kind: 'plugin', label: e, source: _teamPluginBadge(e), repo: _teamPluginRepo(e), shared: false }), r.name));
  });
  const caps = [...map.values()]; const byId = {}; caps.forEach(c => byId[c.id] = c);
  _teamData.__caps = caps; _teamData.__capById = byId; _teamData.__capByKey = map; return caps;
}

function _teamRenderReuse(body){
  const caps = _teamBuildCaps().filter(c => c.roles.length >= 2);
  const host = document.createElement('div'); host.className = 'team-cy'; body.appendChild(host);
  const note = document.createElement('div'); note.style.cssText = 'position:absolute;top:6px;left:10px;font-size:11px;color:var(--muted,#6b7280);z-index:2;pointer-events:none';
  note.textContent = 'Shared capabilities reused by ≥2 roles — click a hub for detail'; body.appendChild(note);
  if (!caps.length){ host.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:12px">No capability is shared by ≥2 roles yet.</div>'; return; }
  const roleSet = new Set(); caps.forEach(c => c.roles.forEach(r => roleSet.add(r)));
  const nodes = [], edges = [];
  caps.forEach(c => {
    nodes.push({ data: { id: c.id, label: c.label.replace(/^[^/]*\//, '') + ' ×' + c.roles.length, kind: 'cap', n: c.roles.length, color: _TEAM_SRC_COLOR[c.source.cls] || '#6b7280' } });
    c.roles.forEach(rn => edges.push({ data: { id: c.id + '__' + rn, source: c.id, target: 'r__' + rn } }));
  });
  roleSet.forEach(rn => { const r = _teamRole(rn) || {}; nodes.push({ data: { id: 'r__' + rn, label: rn, kind: 'role', role: rn, color: _TEAM_AUTONOMY_COLOR[r.autonomy] || '#6b7280' } }); });
  _teamCy = cytoscape({
    container: host, elements: { nodes, edges },
    style: [
      { selector: 'node', style: { 'label': 'data(label)', 'font-size': 9, 'color': '#fff', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 100, 'width': 'label', 'height': 'label', 'padding': 6, 'shape': 'round-rectangle' } },
      { selector: 'node[kind="cap"]', style: { 'background-color': 'data(color)', 'font-weight': 'bold', 'padding': 9, 'border-width': 2, 'border-color': '#fff' } },
      { selector: 'node[kind="role"]', style: { 'background-color': 'data(color)', 'font-size': 9 } },
      { selector: 'edge', style: { 'width': 1, 'line-color': '#d1d5db', 'curve-style': 'haystack', 'haystack-radius': 0.4 } },
      { selector: 'node.team-sel', style: { 'border-width': 4, 'border-color': '#0ea5e9' } },
    ],
    layout: { name: 'concentric', concentric: n => n.data('kind') === 'cap' ? 2 : 1, levelWidth: () => 1, minNodeSpacing: 16, padding: 24 },
    wheelSensitivity: 0.2,
  });
  _teamCy.on('tap', 'node[kind="cap"]', e => _teamSelectCapability(e.target.id()));
  _teamCy.on('tap', 'node[kind="role"]', e => _teamSelectRole(e.target.data('role')));
}

function _teamSelectCapability(id){
  const c = (_teamData.__capById || {})[id]; const s = document.getElementById('teamSide'); if (!c || !s) return;
  _teamSelectedRole = null; if (_teamCy) _teamCy.nodes('.team-sel').removeClass('team-sel');
  const roles = [...new Set(c.roles)].sort();
  const chips = roles.map(rn => `<span class="team-chip" style="cursor:pointer" onclick="_teamSelectRole('${_teamEsc(rn)}')">${_teamEsc(rn)}</span>`).join('');
  let where = '<span class="ts-sub">—</span>';
  if (c.repo) where = `<a href="${_teamEsc(c.repo)}" target="_blank" rel="noopener">${_teamEsc(c.repo.replace('https://github.com/', ''))}</a>`;
  else if (c.where) where = _teamEsc(c.where);
  else if (c.source.cls === 'tb-native') where = 'Hermes bundled skill';
  else if (c.source.cls === 'tb-self') where = 'self-build (team/skills or docs)';
  s.innerHTML = `<button class="ts-close" onclick="_teamCloseSide()" aria-label="Close">×</button>`
    + `<h3>${_teamEsc(c.label)}</h3>`
    + `<div class="ts-sub">${_teamEsc(c.kind)}${c.shared ? ' · shared layer' : ''}</div>`
    + `<div class="ts-sec">source</div><div><span class="team-badge ${c.source.cls}">${_teamEsc(c.source.label)}</span></div>`
    + `<div class="ts-sec">used by ${roles.length} role(s)</div><div>${chips}</div>`
    + `<div class="ts-sec">where</div><div style="font-size:12px;word-break:break-all">${where}</div>`;
  s.style.display = 'block';
}

function _teamRenderRoster(body){
  const byDiv = {};
  _teamRoles().forEach(r => { (byDiv[r.division] = byDiv[r.division] || []).push(r); });
  const order = _TEAM_DIV_ORDER.concat(Object.keys(byDiv).filter(d => !_TEAM_DIV_ORDER.includes(d)));
  const wrap = document.createElement('div'); wrap.className = 'team-roster';
  let html = '';
  order.forEach(div => {
    const rows = byDiv[div]; if (!rows) return;
    html += `<div class="team-div-h">${_teamEsc(div)}</div>`;
    html += '<table class="team-tbl"><thead><tr><th>role</th><th>tier</th><th>autonomy</th><th>hand</th><th>skills</th><th>does</th></tr></thead><tbody>';
    rows.sort((a,b)=> (a.tier!=='core')-(b.tier!=='core') || a.name.localeCompare(b.name)).forEach(r => {
      const hand = _teamField(r,'hand'); const handTxt = (!hand || hand==='none') ? '—' : hand;
      html += `<tr class="team-row" onclick="_teamSelectRole('${_teamEsc(r.name)}')">`
        + `<td><b>${_teamEsc(r.name)}</b></td><td>${_teamEsc(r.tier||'')}</td>`
        + `<td>${_teamEsc(r.autonomy||'')}</td><td>${_teamEsc(handTxt)}</td>`
        + `<td>${(r.skills||[]).map(s=>'<span class="team-chip">'+_teamEsc(s)+'</span>').join('')}</td>`
        + `<td style="max-width:280px">${_teamEsc(r.does||'')}</td></tr>`;
    });
    html += '</tbody></table>';
  });
  wrap.innerHTML = html; body.appendChild(wrap);
}

function _teamRenderGraph(body){
  const host = document.createElement('div'); host.className = 'team-cy'; host.id = 'teamCyHost'; body.appendChild(host);
  const nodes = [], edges = [];
  nodes.push({ data: { id: '__root', label: 'CTO ▸ Kanban', kind: 'root' } });
  const divs = {};
  _teamRoles().forEach(r => {
    if (!divs[r.division]){
      divs[r.division] = true;
      nodes.push({ data: { id: 'div__' + r.division, label: r.division, kind: 'div', color: _TEAM_DIV_COLORS[r.division] || '#6b7280' } });
      edges.push({ data: { id: 'e_root_' + r.division, source: '__root', target: 'div__' + r.division } });
    }
    const hand = _teamField(r, 'hand'); const isBrain = (!hand || hand === 'none');
    nodes.push({ data: { id: 'role__' + r.name, label: r.name, kind: 'role', role: r.name,
      color: _TEAM_AUTONOMY_COLOR[r.autonomy] || '#6b7280', tier: r.tier || 'optional', brain: isBrain ? 1 : 0 } });
    edges.push({ data: { id: 'e_' + r.division + '_' + r.name, source: 'div__' + r.division, target: 'role__' + r.name } });
  });
  if (_teamCy){ try { _teamCy.destroy(); } catch(_){} _teamCy = null; }
  _teamCy = cytoscape({
    container: host, elements: { nodes, edges },
    style: [
      { selector: 'node', style: { 'label': 'data(label)', 'font-size': 10, 'color': '#fff', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 90, 'width': 'label', 'height': 'label', 'padding': 8, 'shape': 'round-rectangle' } },
      { selector: 'node[kind="root"]', style: { 'background-color': '#111827', 'font-size': 12, 'font-weight': 'bold' } },
      { selector: 'node[kind="div"]', style: { 'background-color': 'data(color)', 'font-size': 11 } },
      { selector: 'node[kind="role"]', style: { 'background-color': 'data(color)' } },
      { selector: 'node[brain=1]', style: { 'shape': 'round-diamond', 'border-width': 2, 'border-color': '#111827' } },
      { selector: 'node[tier="core"]', style: { 'border-width': 3, 'border-color': '#111827' } },
      { selector: 'edge', style: { 'width': 1.5, 'line-color': '#cbd5e1', 'target-arrow-color': '#cbd5e1', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
      { selector: 'node.team-sel', style: { 'border-width': 4, 'border-color': '#0ea5e9' } },
    ],
    layout: { name: window.cytoscape && window.cytoscape.__dagreRegistered ? 'dagre' : 'breadthfirst', rankDir: 'TB', nodeSep: 14, rankSep: 48, directed: true, padding: 16 },
    wheelSensitivity: 0.2,
  });
  _teamCy.on('tap', 'node[kind="role"]', evt => _teamSelectRole(evt.target.data('role')));
  if (_teamSelectedRole){ const n = _teamCy.getElementById('role__' + _teamSelectedRole); if (n) n.addClass('team-sel'); }
}

function _teamSelectRole(name){
  _teamSelectedRole = name;
  if (_teamCy){ _teamCy.nodes('.team-sel').removeClass('team-sel'); const n = _teamCy.getElementById('role__' + name); if (n) n.addClass('team-sel'); }
  _teamRenderSide(name);
}
function _teamCloseSide(){ _teamSelectedRole = null; const s = document.getElementById('teamSide'); if (s){ s.style.display = 'none'; s.innerHTML = ''; } if (_teamCy) _teamCy.nodes('.team-sel').removeClass('team-sel'); }

function _teamRenderSide(name){
  const r = _teamRole(name); const s = document.getElementById('teamSide'); if (!r || !s) return;
  const hand = _teamField(r, 'hand'); const isBrain = (!hand || hand === 'none');
  const eng = (_teamData.engines && _teamData.engines.engines && _teamData.engines.engines[hand]) || null;
  const handLine = isBrain ? 'brain-side (no hand): kanban + memory'
    : (hand + (eng ? ` · ${eng.binary || ''}${eng.status ? ' ('+eng.status+')' : ''}` : ''));
  _teamBuildCaps(); const capByKey = _teamData.__capByKey;
  const clk = (key) => { const c = capByKey && capByKey.get(key); return c ? ` style="cursor:pointer" onclick="_teamSelectCapability('${c.id}')"` : ''; };
  const { shared, role: own } = _teamPluginsFor(name);
  const skillBadges = (r.skills || []).map(sk => { const b = _teamSkillBadge(sk); return `<span class="team-badge ${b.cls}"${clk('skill:'+sk)}>${_teamEsc(b.label)}</span>`; }).join('') || '<span class="ts-sub">—</span>';
  const pluginRow = (entry, isShared) => { const b = _teamPluginBadge(entry); return `<span class="team-badge ${b.cls}"${clk('plugin:'+entry)}>${_teamEsc(b.label)}</span>${isShared ? '<span class="team-badge tb-shared">shared</span>' : ''}`; };
  const sharedHtml = shared.length ? shared.map(e => pluginRow(e, true)).join('') : '';
  const ownHtml = own.length ? own.map(e => pluginRow(e, false)).join('') : '';
  const pluginsHtml = (isBrain) ? '<span class="ts-sub">brain-side role — no CC plugins</span>'
    : ((sharedHtml || ownHtml) ? (sharedHtml + ownHtml) : '<span class="ts-sub">base layer only</span>');
  const toolsets = (r.toolsets || []).map(x => `<span class="team-chip">${_teamEsc(x)}</span>`).join('') || '—';
  const mcp = (r.mcp || []).map(x => `<span class="team-badge tb-mcp"${clk('mcp:'+x)}>${_teamEsc(x)} · MCP</span>`).join('') || '<span class="ts-sub">—</span>';
  s.innerHTML = `<button class="ts-close" onclick="_teamCloseSide()" aria-label="Close">×</button>`
    + `<h3>${_teamEsc(r.name)}</h3>`
    + `<div class="ts-sub">${_teamEsc(r.division)} · ${_teamEsc(r.tier||'')} · ${_teamEsc(r.autonomy||'')}</div>`
    + `<div>${_teamEsc(r.does || '')}</div>`
    + `<div class="ts-sec">hand (engine · L4a)</div><div>${_teamEsc(handLine)}</div>`
    + `<div class="ts-sec">toolsets</div><div>${toolsets}</div>`
    + `<div class="ts-sec">skills (source)</div><div>${skillBadges}</div>`
    + `<div class="ts-sec">CC plugins (source · reuse)</div><div>${pluginsHtml}</div>`
    + `<div class="ts-sec">MCP tools (L4b)</div><div>${mcp}</div>`;
  s.style.display = 'block';
}
