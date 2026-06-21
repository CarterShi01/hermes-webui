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
let _teamPortal = null, _teamCatKind = 'all', _teamCatQuery = '', _teamCatViewF = 'all';  // resource-centric Catalog (L1) + saved views
let _teamPipeRes = null;  // L3 pipeline/lineage: { name, kind } currently traced
const _TEAM_HAND_LABEL = { 'claude-code':'Claude Code', 'codex':'Codex', 'none':'Hermes (brain)' };
const _TEAM_VIEW_KEY = 'hermes-webui-team-view';
const _TEAM_KIND_BADGE = { skill:'tb-native', plugin:'tb-oss', cli:'tb-mcp', toolset:'tb-shared', mcp:'tb-mcp', role:'tb-self' };
let _teamLabelDim = 'division';  // Labels 视图当前维度
// 每个 tab 顶部的一句话中文介绍(看什么)
const _TEAM_VIEW_INTRO = {
  catalog: '资源目录:全部 skill/mcp/cli/plugin/toolset 一张表,按 kind 筛、按复用排序;点行看详情。',
  labels: '按 label 维度查:挑 division/hand/project,把资源分组看分布(谁挂在哪个维度下)。',
  graph: '组织树:角色按部门挂在 cto/看板下;ring 实时点亮谁在干。',
  roster: '花名册表:角色 × tier/autonomy/hand/skills 一览。',
  reuse: '复用矩阵:资源×角色,深蓝=直接绑定 / 浅蓝=组级继承——看什么被谁复用。',
  pipeline: '分发管线:一个资源 → 哪些角色 → 哪只手,带"改它冲击谁"影响分析。',
  planes: '操作面 & 生命周期:5 个 /team 入口面 ↔ 对齐 profile + agent-ops 9 站工具。',
  health: '体检:孤儿/缺描述/重复资源、薄描述角色等治理信号(带处理动作)。',
  sources: '来源/供应链:资源按 marketplace 来源分组,看哪些抄来、哪些自建。',
  calibrate: '路由校准:promptfoo 命中率 + per-role 精度 + 混淆矩阵。',
};

const _TEAM_NATIVE_SKILLS = new Set(['software-development','autonomous-ai-agents','productivity','creative','research','data-science','mlops','devops','social-media','dogfood','github','kanban-orchestrator','kanban-worker']);
const _TEAM_SELFBUILD_SKILLS = new Set(['writing-plans','write-adr-from-decision','diagramming','encoding-review']);
const _TEAM_DIV_ORDER = ['leadership','engineering','product','design','data','domain','gtm-marketing','gtm-sales','ops-finance','ops-support','strategy'];
const _TEAM_DIV_COLORS = { leadership:'#b8860b', engineering:'#5b8def', product:'#0288a8', design:'#a855f7', data:'#3fa45b', domain:'#e0852e', 'gtm-marketing':'#e0529c', 'gtm-sales':'#d4a017', 'ops-finance':'#16a34a', 'ops-support':'#0ea5e9', strategy:'#6b7280' };
const _TEAM_AUTONOMY_COLOR = { autonomous:'#3fa45b', 'hitl-assistant':'#b8860b', none:'#9aa0a6' };
const _TEAM_SRC_COLOR = { 'tb-native':'#3fa45b','tb-self':'#7c3aed','tb-oss':'#1a56db','tb-official':'#a8620b','tb-mcp':'#0a6e80','tb-shared':'#64748b' };

function _teamEsc(s){ return (typeof esc === 'function') ? esc(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function _teamLoadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = false; s.onload = () => res(); s.onerror = () => rej(new Error('failed to load ' + src)); document.head.appendChild(s); }); }
// Perf: load heavy libs ONLY for views that need them (cytoscape = graph/pipeline;
// js-yaml + /api/team = graph/roster). Catalog/Reuse/Planes/Health/Sources/Calibrate
// need neither → fast first paint (was: eager-load all on every Team open).
async function _teamEnsureCy(){
  if (!window.cytoscape)      await _teamLoadScript('static/vendor/cytoscape.min.js');
  if (!window.dagre)          await _teamLoadScript('static/vendor/dagre.min.js');
  if (!window.cytoscapeDagre) await _teamLoadScript('static/vendor/cytoscape-dagre.js');
  try { if (window.cytoscape && window.cytoscapeDagre && !window.cytoscape.__dagreRegistered){ window.cytoscape.use(window.cytoscapeDagre); window.cytoscape.__dagreRegistered = true; } } catch(_){}
}
async function _teamEnsureData(){   // roster v1 yaml — only graph/roster need it
  if (_teamData) return _teamData;
  if (!window.jsyaml) await _teamLoadScript('static/vendor/js-yaml/4.1.0/js-yaml.min.js');
  const r = await fetch('/api/team', { headers: { 'Accept': 'application/json' } });
  const raw = ((await r.json()) || {}).team || {};
  _teamData = { roster: raw.roster ? jsyaml.load(raw.roster) : null, plugins: raw.plugins ? jsyaml.load(raw.plugins) : null, engines: raw.engines ? jsyaml.load(raw.engines) : null };
  return _teamData;
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
  #teamInfo .ti-stat{color:var(--muted,#6b7280)}
  #teamInfo .ti-intro{margin-top:7px;padding:7px 9px;font-size:12px;line-height:1.6;color:var(--text,#374151);background:var(--surface,#f3f4f6);border-left:3px solid var(--accent,#5b8def);border-radius:0 6px 6px 0}
  #teamInfo .ti-legend{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--muted,#6b7280)}
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
  #teamCenter .team-cat-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 4px;position:sticky;top:0;background:var(--main-bg,#fff);z-index:5;border-bottom:1px solid var(--border,#eee)}
  #teamCenter .team-kind-btn{padding:3px 10px;font-size:12px;border:1px solid var(--border,#e5e7eb);border-radius:6px;background:var(--bg,#fff);color:var(--muted,#6b7280);cursor:pointer}
  #teamCenter .team-kind-btn.active{background:var(--accent,#5b8def);color:#fff;border-color:transparent}
  #teamCenter .team-kind-btn .tk-n{opacity:.7;font-size:10.5px}
  #teamCenter .team-cat-q{margin-left:auto;padding:4px 10px;font-size:12px;border:1px solid var(--border,#e5e7eb);border-radius:6px;min-width:200px;background:var(--bg,#fff);color:var(--text,#111)}
  #teamCenter .team-cat-count{padding:6px 2px 2px;font-size:11px;color:var(--muted,#6b7280)}
  .th-orphan{background:#fdecec;color:#b91c1c;border-color:#f5c6c6} .th-warn{background:#fff4e0;color:#a8620b;border-color:#f3dcb0}
  #teamCenter .team-matrix td.mx-d{background:#1a56db} #teamCenter .team-matrix td.mx-i{background:#bcd3fb}
  #teamCenter .team-mx-legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:6px 2px;font-size:11px;color:var(--muted,#6b7280)}
  #teamCenter .team-mx-legend i{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:4px}
  #teamCenter .team-mx-legend i.mx-d{background:#1a56db} #teamCenter .team-mx-legend i.mx-i{background:#bcd3fb}
  #teamCenter .team-cat-view{display:inline-flex;gap:4px;align-items:center;font-size:11px;color:var(--muted,#6b7280)}
  #teamCenter .team-cat-view button{padding:2px 8px;font-size:11px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--bg,#fff);color:var(--muted,#6b7280);cursor:pointer}
  #teamCenter .team-cat-view button.active{background:#111827;color:#fff;border-color:transparent}
  #teamCenter .team-pipe-impact{padding:5px 8px;font-size:11.5px;color:var(--muted,#6b7280);border-bottom:1px solid var(--border,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  `;
  const el = document.createElement('style'); el.id = 'teamPanelStyle'; el.textContent = css; document.head.appendChild(el);
}

// Entry point — mirrors loadKanban(). Called by switchPanel('team') and Refresh.
// Fast path: only the small portal.json (no cytoscape/yaml). Heavy libs + roster
// yaml load lazily inside the views that need them (graph/roster/pipeline).
async function loadTeamPanel(force){
  _teamInjectStyle();
  if (force){ _teamData = null; _teamPortal = null; }
  _teamView = _teamView || localStorage.getItem(_TEAM_VIEW_KEY) || 'catalog';
  const center = document.getElementById('teamCenter');
  if (center && !_teamPortal) center.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px">Loading team…</div>';
  try { await _teamEnsurePortal(); }
  catch(e){ if (center) center.innerHTML = '<div style="padding:16px;color:#e05252;font-size:12px">Failed to load team: ' + _teamEsc(e && e.message) + '</div>'; return; }
  _teamRender();
}

// ── data helpers ─────────────────────────────────────────────────────────────
function _teamRoles(){ return (_teamData && _teamData.roster && _teamData.roster.roles) || []; }
function _teamDefaults(){ return (_teamData && _teamData.roster && _teamData.roster.defaults) || {}; }
function _teamRole(name){ return _teamRoles().find(r => r.name === name) || null; }
function _teamField(r, k){ const d = _teamDefaults(); return (r[k] !== undefined && r[k] !== null) ? r[k] : d[k]; }
function _teamPluginsFor(role){ /* ADR 0014: per-role/shared plugin assignment moved into roster (catalog/assignment split); plugins.yaml is now a pure marketplace catalog. */ const D = (_teamData && _teamData.roster && _teamData.roster.defaults) || {}; const r = _teamRole(role); const shared = [].concat(D.plugins || []); const dp = D.division_plugins || {}; if (r && r.division && dp[r.division]) shared.push(...dp[r.division]); return { shared, role: [].concat((r && r.plugins) || []) }; }
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
  [['teamViewCatalogBtn','catalog'],['teamViewLabelsBtn','labels'],['teamViewGraphBtn','graph'],['teamViewRosterBtn','roster'],['teamViewReuseBtn','reuse'],['teamViewPipelineBtn','pipeline'],['teamViewPlanesBtn','planes'],['teamViewHealthBtn','health'],['teamViewSourcesBtn','sources'],['teamViewCalibrateBtn','calibrate']].forEach(([id,v]) => { const b = document.getElementById(id); if (b) b.classList.toggle('active', _teamView === v); });
  // sidebar: stats (from portal.json) + per-view 中文介绍 + legend
  const info = document.getElementById('teamInfo');
  if (info){
    const st = _teamPortal && _teamPortal.stats;
    let h = st ? `<div class="ti-stat"><b>${_teamEsc((_teamPortal.team)||'team')}</b> · ${st.resources} resources · ${st.roles} roles · ${Object.keys(st.by_kind||{}).length} kinds${st.orphans?` · <span style="color:#b91c1c">${st.orphans} orphan</span>`:''}${st.pending_promote?` · <span style="color:#dc2626;cursor:pointer" onclick="setTeamView('health')">⬆ ${st.pending_promote} 待promote</span>`:''}</div>` : '<div class="ti-stat">team</div>';
    if (_TEAM_VIEW_INTRO[_teamView]) h += `<div class="ti-intro">${_teamEsc(_TEAM_VIEW_INTRO[_teamView])}</div>`;
    if (_teamView === 'graph') h += '<div class="ti-legend"><span><i style="background:' + _TEAM_AUTONOMY_COLOR.autonomous + '"></i>autonomous</span><span><i style="background:' + _TEAM_AUTONOMY_COLOR['hitl-assistant'] + '"></i>hitl</span><span>◇ brain-side</span><span>ring=live: <i style="background:#ffc233"></i>run <i style="background:#5b8def"></i>ready <i style="background:#e05252"></i>blocked</span></div>';
    info.innerHTML = h;
  }
  // main center
  _teamStopLive(); if (_teamCy){ try { _teamCy.destroy(); } catch(_){} _teamCy = null; }
  const center = document.getElementById('teamCenter'); if (!center) return; center.innerHTML = '';
  if (_teamView === 'catalog') _teamRenderCatalog(center);
  else if (_teamView === 'labels') _teamRenderLabels(center);
  else if (_teamView === 'roster') _teamRenderRoster(center);
  else if (_teamView === 'reuse') _teamRenderReuse(center);
  else if (_teamView === 'pipeline') _teamRenderPipeline(center);
  else if (_teamView === 'planes') _teamRenderPlanes(center);
  else if (_teamView === 'health') _teamRenderHealth(center);
  else if (_teamView === 'sources') _teamRenderSources(center);
  else if (_teamView === 'calibrate') _teamRenderCalibrate(center);
  else _teamRenderGraph(center);
  _teamRenderDetail();
}

async function _teamRenderGraph(center){
  center.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px">Loading graph…</div>';
  await _teamEnsureData(); await _teamEnsureCy();
  if (_teamView !== 'graph') return; center.innerHTML = '';
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

async function _teamRenderRoster(center){
  center.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px">Loading roster…</div>';
  await _teamEnsureData();
  if (_teamView !== 'roster') return; center.innerHTML = '';
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

// Reuse view (L2) = resource × role matrix, tri-state cells (portal-based):
// direct (role.bind) vs inherited (group selector, ADR 0034 就近覆盖) vs none —
// visualising the v2 selector-inheritance the old binary matrix couldn't. Rows =
// resources sorted by reuse desc (most-shared on top = reuse hierarchy), cols =
// roles grouped by division. Matrix beats a bipartite hairball for >20 dense nodes
// (Ghoniem/Okoe/Abdelaal); see design/team-portal-ui.md §6.
async function _teamRenderReuse(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  wrap.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">Loading matrix…</div>';
  const p = await _teamEnsurePortal();
  if (!p){ wrap.innerHTML = '<div style="padding:8px;font-size:12px">No portal data. Run team/scripts/gen-portal-view.py.</div>'; return; }
  const res = (p.resources||[]).filter(r => (r.consumer_count||0) > 0).sort((a,b)=>(b.consumer_count-a.consumer_count)||a.name.localeCompare(b.name));
  const roles = (p.roles||[]).slice().sort((a,b)=>(_TEAM_DIV_ORDER.indexOf(a.division)-_TEAM_DIV_ORDER.indexOf(b.division))||a.name.localeCompare(b.name));
  if (!res.length || !roles.length){ wrap.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:12px">No reuse data.</div>'; return; }
  let h = '<div class="team-mx-legend"><span><i class="mx-d"></i>direct (role.bind)</span><span><i class="mx-i"></i>inherited (group selector)</span><span class="tm-x">rows=resource ×reuse · cols=role by division · click row/col for detail</span></div>';
  h += '<table class="team-matrix"><thead><tr><th class="tm-corner">resource ↓ ×reuse / role →</th>';
  roles.forEach((r, i) => { h += `<th class="tm-rolehead" data-col="${i}" style="border-top:3px solid ${_TEAM_DIV_COLORS[r.division] || '#999'}" title="${_teamEsc(r.name)} · ${_teamEsc(r.division)}" onclick="_teamSelectRole('${_teamEsc(r.name)}')" onmouseover="_teamColHL(${i},true)" onmouseout="_teamColHL(${i},false)"><span>${_teamEsc(r.name)}</span></th>`; });
  h += '</tr></thead><tbody>';
  res.forEach(rs => {
    const dir = new Set(rs.consumers_direct||[]), inh = new Set(rs.consumers_inherited||[]);
    h += `<tr><td class="tm-cap" onclick="_teamSelectResource('${_teamEsc(rs.name)}','${_teamEsc(rs.kind)}')" title="${_teamEsc(rs.name)} · ${_teamEsc(rs.kind)}"><span>${_teamEsc(rs.name.replace(/^[^/]*\//, ''))}</span> <span class="tm-x">×${rs.consumer_count}</span></td>`;
    roles.forEach((r, i) => { const st = dir.has(r.name) ? 'mx-d' : (inh.has(r.name) ? 'mx-i' : ''); h += `<td class="tm-cell ${st}" data-col="${i}" onmouseover="_teamColHL(${i},true)" onmouseout="_teamColHL(${i},false)"></td>`; });
    h += '</tr>';
  });
  h += '</tbody></table>';
  wrap.innerHTML = h;
}
function _teamColHL(i, on){ document.querySelectorAll('#teamCenter .team-matrix [data-col="' + i + '"]').forEach(el => el.classList.toggle('tm-colhl', on)); }

// Pipeline / Lineage (L3) — trace a resource's dispatch chain: resource → roles
// (binding: direct=solid / inherited=dashed) → hands (projector → engine). Plus
// impact analysis ("changing X affects N roles → these hands"). All from portal.json
// (consumers_direct/inherited + role.hand); JS does no binding. design §L3.
function _teamSetPipeRes(v){ const i = v.lastIndexOf('::'); _teamPipeRes = { name: v.slice(0, i), kind: v.slice(i + 2) }; _teamRender(); }
async function _teamRenderPipeline(center){
  center.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px">Loading pipeline…</div>';
  const p = await _teamEnsurePortal(); await _teamEnsureCy();
  if (_teamView !== 'pipeline') return;
  if (!p){ center.innerHTML = '<div style="padding:8px;font-size:12px">No portal data. Run team/scripts/gen-portal-view.py.</div>'; return; }
  const consumed = (p.resources||[]).filter(r => r.consumer_count > 0).sort((a,b)=>(b.consumer_count-a.consumer_count)||a.name.localeCompare(b.name));
  if (!consumed.length){ center.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:12px">No bound resources to trace.</div>'; return; }
  let tgt = _teamPipeRes || (_teamSel && _teamSel.res ? { name:_teamSel.res, kind:_teamSel.resKind } : null);
  let r = tgt ? consumed.find(x => x.name===tgt.name && x.kind===tgt.kind) : null; if (!r) r = consumed[0];
  const roleBy = {}; (p.roles||[]).forEach(x => roleBy[x.name] = x);
  const dir = new Set(r.consumers_direct||[]), inh = new Set(r.consumers_inherited||[]);
  const allRoles = [...dir, ...inh];
  const handOf = n => { const ro = roleBy[n]; const h = ro && ro.hand; return (!h) ? 'none' : h; };
  const hands = [...new Set(allRoles.map(handOf))];
  const divs = new Set(allRoles.map(n => (roleBy[n]||{}).division).filter(Boolean));
  const hc = {}; allRoles.forEach(n => { const h = handOf(n); hc[h] = (hc[h]||0)+1; });
  const AGG = allRoles.length > 8;   // 多消费者→按 division 聚合中间层(消毛球;Inframap 式)
  const impact = `Changing <b>${_teamEsc(r.name)}</b> affects <b>${allRoles.length}</b> role(s) across <b>${divs.size}</b> division(s) → hands: ` + hands.map(h => `${_teamEsc(_TEAM_HAND_LABEL[h]||h)} (${hc[h]})`).join(' · ') + (AGG ? ' <span class="tm-x">· 中间层按部门聚合(选复用更少的资源看具体角色)</span>' : '');
  let bar = '<div class="team-cat-bar"><span class="tm-x">trace resource ↓</span> <select class="team-cat-q" style="margin-left:0;min-width:260px" onchange="_teamSetPipeRes(this.value)">';
  consumed.forEach(x => { const val = x.name + '::' + x.kind; bar += `<option value="${_teamEsc(val)}"${(x.name===r.name&&x.kind===r.kind)?' selected':''}>${_teamEsc(x.name)} · ${_teamEsc(x.kind)} ×${x.consumer_count}</option>`; });
  bar += '</select></div><div class="team-pipe-impact">' + impact + '</div>';
  center.innerHTML = bar;
  const host = document.createElement('div'); host.className = 'team-cy'; host.style.top = '70px'; center.appendChild(host);
  const nodes = [], edges = [];
  nodes.push({ data: { id:'res', label: r.name.replace(/^[^/]*\//,'') + '  [' + r.kind + ']', kind:'res' } });
  hands.forEach(h => nodes.push({ data: { id:'hand__'+h, label: _TEAM_HAND_LABEL[h]||h, kind:'hand' } }));
  if (AGG){
    const byDiv = {}; allRoles.forEach(n => { const d = (roleBy[n]||{}).division || '?'; (byDiv[d]=byDiv[d]||[]).push(n); });
    Object.keys(byDiv).forEach(d => { const rs = byDiv[d];
      nodes.push({ data: { id:'div__'+d, label: d+' ('+rs.length+')', kind:'div', color:_TEAM_DIV_COLORS[d]||'#6b7280' } });
      edges.push({ data: { id:'e_res_'+d, source:'res', target:'div__'+d, rel: rs.some(n=>dir.has(n))?'direct':'inherited' } });
      [...new Set(rs.map(handOf))].forEach(h => edges.push({ data: { id:'e_'+d+'_'+h, source:'div__'+d, target:'hand__'+h } }));
    });
  } else {
    allRoles.forEach(n => { const ro = roleBy[n]||{}; nodes.push({ data: { id:'role__'+n, label:n, kind:'role', role:n, color:_TEAM_DIV_COLORS[ro.division]||'#6b7280' } });
      edges.push({ data: { id:'e_res_'+n, source:'res', target:'role__'+n, rel: dir.has(n)?'direct':'inherited' } });
      edges.push({ data: { id:'e_'+n+'_h', source:'role__'+n, target:'hand__'+handOf(n) } });
    });
  }
  _teamCy = cytoscape({ container: host, elements: { nodes, edges }, style: [
      { selector:'node', style:{ 'label':'data(label)','font-size':10,'color':'#fff','text-valign':'center','text-halign':'center','text-wrap':'wrap','text-max-width':110,'width':'label','height':'label','padding':7,'shape':'round-rectangle' } },
      { selector:'node[kind="res"]', style:{ 'background-color':'#111827','font-size':12,'font-weight':'bold' } },
      { selector:'node[kind="role"]', style:{ 'background-color':'data(color)' } },
      { selector:'node[kind="div"]', style:{ 'background-color':'data(color)','font-size':11 } },
      { selector:'node[kind="hand"]', style:{ 'background-color':'#0a6e80','shape':'round-diamond','font-size':11 } },
      { selector:'edge', style:{ 'width':1.6,'line-color':'#94a3b8','target-arrow-color':'#94a3b8','target-arrow-shape':'triangle','curve-style':'bezier' } },
      { selector:'edge[rel="direct"]', style:{ 'line-color':'#1a56db','target-arrow-color':'#1a56db','width':2.4 } },
      { selector:'edge[rel="inherited"]', style:{ 'line-style':'dashed' } },
      { selector:'.faded', style:{ 'opacity':0.16 } },
      { selector:'node.team-sel', style:{ 'border-width':4,'border-color':'#0ea5e9' } },
    ], layout: { name: window.cytoscape.__dagreRegistered ? 'dagre' : 'breadthfirst', rankDir:'LR', nodeSep:14, rankSep:90, directed:true, padding:18 }, wheelSensitivity:0.2 });
  _teamCy.on('tap', 'node[kind="role"]', e => _teamSelectRole(e.target.data('role')));
  _teamCy.on('tap', 'node[kind="res"]', () => _teamSelectResource(r.name, r.kind));
  _teamCy.on('mouseover', 'node', e => { const hood = e.target.closedNeighborhood(); _teamCy.elements().not(hood).addClass('faded'); });
  _teamCy.on('mouseout', 'node', () => _teamCy.elements().removeClass('faded'));
  setTimeout(() => { try { _teamCy && _teamCy.resize(); _teamCy && _teamCy.fit(undefined, 24); } catch(_){} }, 60);
}

async function _teamRenderCalibrate(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  wrap.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading eval…</div>';
  let summary = null;
  try { const r = await fetch('/api/team/eval', { headers: { 'Accept': 'application/json' } }); if (r.ok) summary = ((await r.json()) || {}).summary; } catch(_){}
  const rows = (summary && summary.rows) || [];
  if (!rows.length){ wrap.innerHTML = '<div style="max-width:640px;margin:8px auto;padding:18px 20px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--surface,#f9fafb);font-size:12.5px;line-height:1.7"><div style="font-size:14px;font-weight:600;margin-bottom:4px">📊 路由评测尚未运行</div>这是<b>空状态,不是错误</b>。命中率由开源引擎 <a href="https://github.com/promptfoo/promptfoo" target="_blank" rel="noopener">promptfoo</a> 算(本面板只渲染其输出)。在 <code>team/eval/</code> 跑一次即可填充:<pre style="background:var(--bg,#fff);border:1px solid var(--border,#eee);padding:8px;border-radius:6px;overflow:auto;margin-top:8px">npx promptfoo@latest eval -c promptfooconfig.yaml -o results.json\npython3 summarize.py results.json eval-summary.json</pre>跑完后产出 <code>eval-summary.json</code>,本视图自动显示总命中率 + per-role precision/recall + 混淆矩阵。</div>'; return; }
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

// ── Catalog (L1) — resource-centric inventory, reads /api/team/portal ─────────
// The portal recentres the panel on RESOURCES (skill/plugin/cli/toolset/mcp) with
// roles as consumers. Data is pre-resolved by gen-portal-view.py (JS does no binding).
const _TEAM_HEALTH_BADGE = { orphan:{l:'orphan',c:'th-orphan'}, no_desc:{l:'no-desc',c:'th-warn'}, dup_desc:{l:'dup',c:'th-warn'} };
async function _teamEnsurePortal(){
  if (_teamPortal) return _teamPortal;
  try { const r = await fetch('/api/team/portal', { headers:{Accept:'application/json'} }); _teamPortal = ((await r.json())||{}).portal || null; } catch(_){ _teamPortal = null; }
  return _teamPortal;
}
async function _teamRenderCatalog(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  wrap.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">Loading resources…</div>';
  const p = await _teamEnsurePortal();
  if (!p){ wrap.innerHTML = '<div style="font-size:12.5px;line-height:1.7;padding:6px"><b>No portal data.</b> Generate it (or run gen-team.sh):<pre style="background:var(--surface,#f3f4f6);padding:8px;border-radius:6px">python3 team/scripts/gen-portal-view.py</pre></div>'; return; }
  const kinds = p.stats.by_kind || {};
  const tabs = [['all','All',(p.resources||[]).length]]
    .concat(['skill','plugin','cli','toolset','mcp'].map(k => [k,k,kinds[k]||0]))
    .concat([['role','role',(p.roles||[]).length]]);
  let h = '<div class="team-cat-bar">';
  tabs.forEach(([k,lbl,n]) => { h += `<button class="team-kind-btn${_teamCatKind===k?' active':''}" onclick="_teamSetCatKind('${k}')">${_teamEsc(lbl)} <span class="tk-n">${n}</span></button>`; });
  h += `<input class="team-cat-q" placeholder="search name / does / source…" value="${_teamEsc(_teamCatQuery)}" oninput="_teamCatSearch(this.value)"></div>`;
  // saved views (built-in dynamic lenses; design L2 §3)
  const views = [['all','All'],['orphan','Orphans'],['external','External'],['nosource','Self/native']];
  h += '<div class="team-cat-bar" style="border-bottom:none;padding-top:0"><span class="team-cat-view">views:' + views.map(([k,l])=>` <button class="${_teamCatViewF===k?'active':''}" onclick="_teamSetCatView('${k}')">${_teamEsc(l)}</button>`).join('') + '</span></div>';
  h += '<div id="teamCatBody"></div>';
  wrap.innerHTML = h;
  _teamCatFill();
}
function _teamSetCatKind(k){ _teamCatKind = k; _teamRender(); }
function _teamSetCatView(v){ _teamCatViewF = v; _teamRender(); }   // built-in saved views
function _teamCatSearch(v){ _teamCatQuery = v; _teamCatFill(); }   // refill body only → input keeps focus
function _teamCatViewPred(r){ const v=_teamCatViewF; if(v==='orphan') return (r.health||[]).includes('orphan'); if(v==='external') return !!r.marketplace; if(v==='nosource') return !r.marketplace && !r.url; return true; }

// Labels (L: label-dimension query) — group resources by a chosen label key
// (division / hand / project). Answers "按 label 维度看资源分布". design facet.
function _teamSetLabelDim(d){ _teamLabelDim = d; _teamRender(); }
async function _teamRenderLabels(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  const p = await _teamEnsurePortal(); if (!p){ wrap.innerHTML = '<div style="padding:8px;font-size:12px">No portal data.</div>'; return; }
  const dim = _teamLabelDim;
  let h = '<div class="team-cat-bar"><span class="tm-x">label 维度:</span> ' + ['division','hand','project'].map(k => `<button class="team-kind-btn${dim===k?' active':''}" onclick="_teamSetLabelDim('${k}')">${k}</button>`).join('') + '</div>';
  const groups = {};
  (p.resources||[]).forEach(r => { const v = (r.labels && r.labels[dim]!=null) ? String(r.labels[dim]) : '(无)'; (groups[v]=groups[v]||[]).push(r); });
  const keys = Object.keys(groups).sort((a,b)=> groups[b].length-groups[a].length || a.localeCompare(b));
  h += `<div class="team-cat-count">按 <b>${_teamEsc(dim)}</b> 分 ${keys.length} 组 · ${(p.resources||[]).length} 资源</div><div style="padding:0 2px">`;
  keys.forEach(v => {
    h += `<div class="team-div-h">${_teamEsc(dim)} = ${_teamEsc(v)} · ${groups[v].length}</div><div>`;
    groups[v].sort((a,b)=>(b.consumer_count||0)-(a.consumer_count||0)||a.name.localeCompare(b.name)).forEach(r => { const kb = _TEAM_KIND_BADGE[r.kind]||'tb-shared'; h += `<span class="team-chip" style="cursor:pointer" onclick="_teamSelectResource('${_teamEsc(r.name)}','${_teamEsc(r.kind)}')"><span class="team-badge ${kb}" style="margin:0 4px 0 0">${_teamEsc(r.kind)}</span>${_teamEsc(r.name.replace(/^[^/]*\//,''))} <span class="tm-x">×${r.consumer_count||0}</span></span>`; });
    h += '</div>';
  });
  h += '</div>';
  wrap.innerHTML = h;
}
function _teamCatFill(){
  const body = document.getElementById('teamCatBody'); if (!body || !_teamPortal) return;
  const p = _teamPortal, q = _teamCatQuery.trim().toLowerCase();
  if (_teamCatKind === 'role'){
    let rows = (p.roles||[]).filter(r => !q || (r.name+' '+(r.does||'')).toLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name));
    let html = `<div class="team-cat-count">${rows.length} roles</div><table class="team-tbl"><thead><tr><th>role</th><th>division</th><th>hand</th><th>tier</th><th>does</th></tr></thead><tbody>`;
    rows.forEach(r => { const hd=r.hand; html += `<tr class="team-row" onclick="_teamSelectRole('${_teamEsc(r.name)}')"><td><b>${_teamEsc(r.name)}</b>${r.is_orchestrator?' <span class="team-badge tb-official">orch</span>':''}</td><td>${_teamEsc(r.division||'')}</td><td>${_teamEsc((!hd||hd==='none')?'—':hd)}</td><td>${_teamEsc(r.tier||'')}</td><td style="max-width:360px">${_teamEsc(r.does||'')}</td></tr>`; });
    body.innerHTML = html + '</tbody></table>'; return;
  }
  let rows = (p.resources||[]).filter(r => (_teamCatKind==='all' || r.kind===_teamCatKind) && _teamCatViewPred(r));
  if (q) rows = rows.filter(r => (r.name+' '+(r.does||'')+' '+(r.marketplace||'')).toLowerCase().includes(q));
  rows.sort((a,b)=> (b.consumer_count||0)-(a.consumer_count||0) || a.name.localeCompare(b.name));
  let html = `<div class="team-cat-count">${rows.length} resources · sorted by reuse</div><table class="team-tbl"><thead><tr><th>resource</th><th>kind</th><th>source</th><th>×used</th><th>health</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const kb = _TEAM_KIND_BADGE[r.kind] || 'tb-shared';
    const src = r.marketplace ? _teamEsc(r.marketplace) : (r.kind==='toolset' ? '<span class="tm-x">native</span>' : (r.endpoint ? '<span class="tm-x">'+_teamEsc(r.endpoint)+'</span>' : '—'));
    const health = (r.health||[]).map(x => { const b=_TEAM_HEALTH_BADGE[x]||{l:x,c:'th-warn'}; return `<span class="team-badge ${b.c}">${b.l}</span>`; }).join('');
    html += `<tr class="team-row" onclick="_teamSelectResource('${_teamEsc(r.name)}','${_teamEsc(r.kind)}')"><td><b>${_teamEsc(r.name)}</b></td><td><span class="team-badge ${kb}">${_teamEsc(r.kind)}</span></td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${src}</td><td>${r.consumer_count||0}</td><td>${health||'<span class="tm-x">ok</span>'}</td></tr>`;
  });
  body.innerHTML = html + '</tbody></table>';
}

// ── Planes & Lifecycle (L5) — team as resource manager: entry planes + agent-ops
// lifecycle stations with their ecosystem glue (wired? cross-checked in gen). ────
function _teamResKind(name){ const r = ((_teamPortal&&_teamPortal.resources)||[]).find(x=>x.name===name); return r ? r.kind : 'cli'; }
function _teamWiredBadge(b){ return b===null ? '<span class="tm-x">—</span>' : (b ? '<span class="team-badge tb-native">wired</span>' : '<span class="team-badge th-orphan">missing</span>'); }
async function _teamRenderPlanes(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  const p = await _teamEnsurePortal(); if (!p){ wrap.innerHTML = '<div style="padding:8px;font-size:12px">No portal data.</div>'; return; }
  let h = '<div class="team-div-h">操作面 planes — team(资源管理器)的入口面 ↔ 对齐 profile</div>';
  h += '<table class="team-tbl"><thead><tr><th>plane</th><th>对齐 profile</th><th>入口</th><th>做什么</th></tr></thead><tbody>';
  (p.planes||[]).forEach(pl => { const prof = pl.profile ? `<b class="team-row" style="cursor:pointer" onclick="_teamSelectRole('${_teamEsc(pl.profile)}')">${_teamEsc(pl.profile)}</b> ${_teamWiredBadge(pl.profile_exists)}` : '<span class="tm-x">—(本地投影,无 profile)</span>'; h += `<tr><td><b>${_teamEsc(pl.plane)}</b></td><td>${prof}</td><td><code>${_teamEsc(pl.entry)}</code></td><td style="max-width:340px">${_teamEsc(pl.does)}</td></tr>`; });
  h += '</tbody></table>';
  h += '<div class="team-div-h" style="margin-top:16px">agent-ops 生命周期 9 站 — 每站接的生态 glue</div>';
  h += '<table class="team-tbl"><thead><tr><th>站</th><th>glue 工具</th><th>已接</th></tr></thead><tbody>';
  (p.lifecycle||[]).forEach(l => { const tool = l.tool ? `<span class="team-row" style="cursor:pointer" onclick="_teamSelectResource('${_teamEsc(l.tool)}','${_teamEsc(_teamResKind(l.tool))}')">${_teamEsc(l.tool)}</span>` : '<span class="tm-x">原生 / 对话</span>'; h += `<tr><td>${_teamEsc(l.station)}</td><td>${tool}</td><td>${_teamWiredBadge(l.tool_exists)}</td></tr>`; });
  h += '</tbody></table>';
  wrap.innerHTML = h;
}

// ── Health / Stewardship (L6) — static governance signals (orphan/no-desc/dup/
// thin roles). Dynamic 0-dispatch needs live board (checkup --usage at runtime). ─
async function _teamRenderHealth(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  const p = await _teamEnsurePortal(); if (!p){ wrap.innerHTML = '<div style="padding:8px;font-size:12px">No portal data.</div>'; return; }
  const H = p.health || {};
  const resChip = n => `<span class="team-chip" style="cursor:pointer" onclick="_teamSelectResource('${_teamEsc(n)}','${_teamEsc(_teamResKind(n))}')">${_teamEsc(n)}</span>`;
  const card = (title, items, render, empty) => `<div class="team-div-h">${_teamEsc(title)} · ${items.length}</div>` + (items.length ? ('<div>' + items.map(render).join('') + '</div>') : `<div class="ts-sub" style="padding:1px 0 4px">${empty}</div>`);
  let h = '<div style="font-size:12.5px;margin:2px 0 8px;color:var(--muted)">静态治理信号(读 portal)。动态「0 派工角色」需 live board → 运行时 <code>checkup --usage</code>。每条带 STEWARDSHIP 动作。</div>';
  // ── 待 promote 的候选 skill(Line B 机器自学的;看顺眼就人工搬进资源中心)— 放最上,最 actionable ──
  const cands = p.candidates || [];
  h += `<div class="team-div-h" style="color:#b45309">⬆ 待 promote 的候选 skill · ${cands.length}</div>`;
  if (!cands.length) h += '<div class="ts-sub" style="padding:1px 0 4px">✓ 暂无候选(每周 Hermes 从你的上报里自学;有了会在这评审)</div>';
  cands.forEach(c => {
    const sim = (c.similar_declared && c.similar_declared.length)
      ? `<span class="team-badge th-warn" title="资源中心已有名字相近的,注意别重复 promote">⚠ 近似已有:${c.similar_declared.map(_teamEsc).join(', ')}</span>` : '';
    const cmd = _teamEsc(c.promote_cmd || '');
    h += `<div style="border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:8px 10px;margin:0 0 9px">`
      + `<div><b>${_teamEsc(c.skill)}</b> <span class="team-badge tb-self">${_teamEsc(c.role)} 学的</span> <span class="tm-x">${_teamEsc(c.learned_at||'')}</span> ${sim}</div>`
      + `<div style="font-size:12px;margin:3px 0">${_teamEsc(c.desc||'(无描述)')}</div>`
      + (c.note ? `<div class="ts-sub" style="font-size:11.5px">来自:${_teamEsc(c.note)}</div>` : '')
      + `<details style="margin:4px 0"><summary style="cursor:pointer;font-size:11.5px;color:var(--muted)">看全文(自己判断好不好)</summary>`
      + `<pre style="white-space:pre-wrap;font-size:11px;background:var(--surface,#f8fafc);padding:6px;border-radius:6px;max-height:260px;overflow:auto;margin:4px 0 0">${_teamEsc(c.content||'(读不到内容)')}</pre></details>`
      + `<div style="display:flex;gap:6px;align-items:center;margin-top:5px">`
      + `<code style="font-size:11px;background:var(--surface,#f3f4f6);padding:3px 7px;border-radius:5px;flex:1;overflow:auto;white-space:nowrap">${cmd}</code>`
      + `<button onclick="(navigator.clipboard&&navigator.clipboard.writeText('${cmd}'))" style="font-size:11px;padding:3px 9px;cursor:pointer;border:1px solid var(--border,#e5e7eb);border-radius:5px;background:var(--bg,#fff)">复制命令</button>`
      + `</div><div class="ts-sub" style="font-size:10.5px;margin-top:3px">门户只读;复制命令到你的 CC/codex 会话人工跑 → 搬进资源中心 + install-team。</div>`
      + `</div>`;
  });
  h += card('orphan 资源(无角色消费 → 解 binding 或下线)', H.orphans||[], resChip, '✓ 无孤儿');
  h += card('缺 does 描述(equip 推荐失准 → 补描述)', H.no_desc||[], resChip, '✓ 资源都有描述');
  h += card('描述重复(潜在可合并)', H.dup_desc||[], resChip, '✓ 无重复描述');
  h += card('执行角色 description 偏薄(<28 字,易混淆 → sharpen 或合并)', H.thin_roles||[], r => `<span class="team-chip" style="cursor:pointer" onclick="_teamSelectRole('${_teamEsc(r.name)}')">${_teamEsc(r.name)} <span class="tm-x">${r.len}字</span></span>`, '✓ 描述都够厚');
  wrap.innerHTML = h;
}

// ── Sources / Supply chain (L7) — resources grouped by marketplace + provenance. ─
async function _teamRenderSources(center){
  const wrap = document.createElement('div'); wrap.className = 'team-scroll'; center.appendChild(wrap);
  const p = await _teamEnsurePortal(); if (!p){ wrap.innerHTML = '<div style="padding:8px;font-size:12px">No portal data.</div>'; return; }
  const mk = p.marketplaces || {}, byMk = {};
  (p.resources||[]).forEach(r => { const key = r.marketplace || '·self / native'; (byMk[key] = byMk[key] || []).push(r); });
  const keys = Object.keys(byMk).sort((a,b)=> byMk[b].length - byMk[a].length || a.localeCompare(b));
  let h = '<div style="font-size:12.5px;margin:2px 0 8px;color:var(--muted)">供应链:资源按来源分组。external=marketplace 抄来 / self=自建本地。点资源看 provenance + dependents。</div>';
  keys.forEach(k => {
    const spec = mk[k], repo = spec && spec.repo ? 'https://github.com/'+spec.repo : null;
    h += `<div class="team-div-h">${_teamEsc(k)} · ${byMk[k].length}${repo?` · <a href="${_teamEsc(repo)}" target="_blank" rel="noopener" style="text-transform:none">${_teamEsc(spec.repo)}</a>`:''}</div><div>`;
    byMk[k].sort((a,b)=>(b.consumer_count||0)-(a.consumer_count||0)||a.name.localeCompare(b.name)).forEach(r => { const kb = _TEAM_KIND_BADGE[r.kind]||'tb-shared'; h += `<span class="team-chip" style="cursor:pointer" onclick="_teamSelectResource('${_teamEsc(r.name)}','${_teamEsc(r.kind)}')"><span class="team-badge ${kb}" style="margin:0 4px 0 0">${_teamEsc(r.kind)}</span>${_teamEsc(r.name.replace(/^[^/]*\//,''))} <span class="tm-x">×${r.consumer_count||0}</span></span>`; });
    h += '</div>';
  });
  wrap.innerHTML = h;
}

// ── detail (sidebar #teamDetail) ─────────────────────────────────────────────
function _teamSelectRole(name){ _teamSel = { role: name }; if (_teamCy){ _teamCy.nodes('.team-sel').removeClass('team-sel'); const n = _teamCy.getElementById('role__' + name); if (n) n.addClass('team-sel'); } _teamRenderDetail(); }
function _teamSelectCapability(id){ _teamSel = { cap: id }; if (_teamCy) _teamCy.nodes('.team-sel').removeClass('team-sel'); _teamRenderDetail(); }
function _teamSelectResource(name, kind){ _teamSel = { res: name, resKind: kind }; if (_teamCy) _teamCy.nodes('.team-sel').removeClass('team-sel'); _teamRenderDetail(); }
function _teamRenderDetail(){ const el = document.getElementById('teamDetail'); if (!el || !_teamSel) return; if (_teamSel.role) _teamRenderRoleDetail(el, _teamSel.role); else if (_teamSel.cap) _teamRenderCapDetail(el, _teamSel.cap); else if (_teamSel.res) _teamRenderResourceDetail(el, _teamSel.res, _teamSel.resKind); }
function _teamRenderResourceDetail(el, name, kind){
  const r = ((_teamPortal && _teamPortal.resources)||[]).find(x => x.name===name && x.kind===kind); if (!r) return;
  const mk = (_teamPortal && _teamPortal.marketplaces) || {}, kb = _TEAM_KIND_BADGE[r.kind]||'tb-shared';
  let h = `<h3>${_teamEsc(r.name)}</h3>`;
  h += `<div class="ts-sub" style="margin:3px 0 6px"><span class="team-badge ${kb}">kind: ${_teamEsc(r.kind)}</span> ${(r.health||[]).map(x=>`<span class="team-badge th-orphan">${_teamEsc(x)}</span>`).join('')}</div>`;
  // labels up top (right under kind) — most-asked-for fields, keep them visible
  if (r.labels && Object.keys(r.labels).length) h += '<div class="ts-sec">labels</div><div style="margin-bottom:4px">' + Object.entries(r.labels).map(([k,v])=>`<span class="team-chip">${_teamEsc(k)}=${_teamEsc(String(v))}</span>`).join('') + '</div>';
  if (r.does) h += `<div style="margin:8px 0;font-size:12.5px;line-height:1.6">${_teamEsc(r.does)}</div>`;
  h += '<div class="ts-sec">provenance</div>';
  if (r.marketplace){ const spec = mk[r.marketplace]||{}, repo = spec.repo ? 'https://github.com/'+spec.repo : (r.url||null); h += `<div class="ts-sub">marketplace <b>${_teamEsc(r.marketplace)}</b>${repo?` · <a href="${_teamEsc(repo)}" target="_blank" rel="noopener">repo</a>`:''}${r.license?` · ${_teamEsc(r.license)}`:''}</div>`; }
  else if (r.url) h += `<div class="ts-sub"><a href="${_teamEsc(r.url)}" target="_blank" rel="noopener">${_teamEsc(r.url)}</a>${r.license?` · ${_teamEsc(r.license)}`:''}</div>`;
  else if (r.endpoint) h += `<div class="ts-sub">endpoint <code>${_teamEsc(r.endpoint)}</code></div>`;
  else h += '<div class="ts-sub">self-built / native</div>';
  if (r.note) h += `<div class="ts-sub" style="margin-top:4px">${_teamEsc(r.note)}</div>`;
  h += `<div class="ts-sec">dependents · ×${r.consumer_count||0}</div>`;
  h += (r.consumers && r.consumers.length) ? '<div>'+r.consumers.map(c=>`<span class="team-chip" style="cursor:pointer" onclick="_teamSelectRole('${_teamEsc(c)}')">${_teamEsc(c)}</span>`).join('')+'</div>' : '<div class="ts-sub">none — ' + ((r.kind==='cli'||r.kind==='toolset')?'ambient/native (not role-bound)':'orphan: unbind or retire') + '</div>';
  el.innerHTML = h;
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

// ── Rail 红点:有待 promote 的候选 skill → Team 导航按钮显 ●N(不打开 Team 也看得见 = 通知)──
async function _teamUpdateRailDot(){
  try {
    const p = await _teamEnsurePortal();
    const n = (p && p.stats && p.stats.pending_promote) || 0;
    document.querySelectorAll('[data-panel="team"]').forEach(b => {
      let d = b.querySelector('.team-promote-dot');
      if (n > 0){
        if (!d){
          d = document.createElement('span'); d.className = 'team-promote-dot';
          d.style.cssText = 'position:absolute;top:1px;right:1px;min-width:14px;height:14px;padding:0 3px;border-radius:8px;background:#dc2626;color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:700;box-sizing:border-box;pointer-events:none';
          b.style.position = 'relative'; b.appendChild(d);
        }
        d.textContent = n > 9 ? '9+' : String(n);
        d.title = n + ' 条 skill 待 promote(Team → 体检/治理)';
      } else if (d){ d.remove(); }
    });
  } catch(_){}
}
try { (document.readyState === 'loading')
  ? document.addEventListener('DOMContentLoaded', () => setTimeout(_teamUpdateRailDot, 700))
  : setTimeout(_teamUpdateRailDot, 700); } catch(_){}
