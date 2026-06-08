// ── Kanban dependency graph (topology) view ───────────────────────────────────
// A Board ⇄ Graph toggle in the Kanban main header. The graph renders the board's
// tasks as nodes (colored by status) and task_links as directed edges
// (parent → child, the dependency/blocking direction), laid out as a DAG.
//
// On top of the dependency DAG it overlays a live role/handoff layer: each node
// shows its @assignee, the running task pulses, and active handoff edges (work
// flowing from a done parent into a running child) animate as marching ants — so
// you see both the task dependencies and which role is working right now.
//
// No bundler: Cytoscape + dagre + cytoscape-dagre are self-hosted under
// static/vendor/ and lazy-injected on FIRST switch to the graph view, so the
// ~500KB never loads for users who stay on the board.
//
// Reuses panels.js globals: _kanbanBoard (now carries .edges), _kanbanVisibleTasks(),
// loadKanbanTask(), esc(), t(). Degrades gracefully if any are absent.

let _kanbanView = null;            // 'board' | 'graph' (null = uninitialised)
let _kanbanCy = null;              // active cytoscape instance
let _kanbanGraphLibsPromise = null;

const _KANBAN_VIEW_KEY = 'hermes-webui-kanban-view';

// Status → color. Distinct hues that read on both light/dark skins; the board's
// own column accents are CSS-driven, so we keep an explicit, stable palette here.
const _KANBAN_STATUS_COLORS = {
  triage:   '#9aa0a6',
  todo:     '#5b8def',
  ready:    '#b8860b',
  running:  '#0288a8',
  blocked:  '#e05252',
  done:     '#3fa45b',
  archived: '#6b7280',
};
const _KANBAN_BLOCKED_COLOR = '#e05252';

function _kanbanLoadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;            // preserve execution order across the three libs
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

// Inject the vendored libs once. cytoscape-dagre (UMD) needs globals `cytoscape`
// and `dagre` present first, then registers `window.cytoscapeDagre`, which we
// hand to cytoscape.use(). Idempotent.
function _kanbanGraphEnsureLibs(){
  if (_kanbanGraphLibsPromise) return _kanbanGraphLibsPromise;
  _kanbanGraphLibsPromise = (async () => {
    if (!window.cytoscape) await _kanbanLoadScript('static/vendor/cytoscape.min.js');
    if (!window.dagre)     await _kanbanLoadScript('static/vendor/dagre.min.js');
    if (!window.cytoscapeDagre) await _kanbanLoadScript('static/vendor/cytoscape-dagre.js');
    try {
      if (window.cytoscape && window.cytoscapeDagre && !window.cytoscape.__dagreRegistered) {
        window.cytoscape.use(window.cytoscapeDagre);
        window.cytoscape.__dagreRegistered = true;
      }
    } catch (_) { /* layout falls back to a built-in if registration fails */ }
  })().catch(err => { _kanbanGraphLibsPromise = null; throw err; });
  return _kanbanGraphLibsPromise;
}

function _kanbanGraphElements(){
  const board = (typeof _kanbanBoard !== 'undefined' && _kanbanBoard) || null;
  if (!board || !board.columns) return null;
  const columns = (typeof _kanbanVisibleTasks === 'function') ? _kanbanVisibleTasks() : board.columns;
  const nodes = [];
  const status = {};
  const who = {};               // task.id → assignee (for edge handoff detection)
  columns.forEach(col => (col.tasks || []).forEach(task => {
    if (status[task.id] !== undefined) return;
    status[task.id] = task.status || 'triage';
    const title = task.title || task.summary || task.id || '';
    const assignee = task.assignee || '';
    who[task.id] = assignee;
    const label = title.length > 38 ? title.slice(0, 37) + '…' : title;
    nodes.push({ data: {
      id: task.id,
      // role visible at a glance: glabel = first line @assignee, second line title
      label,
      role: assignee || '—',
      glabel: (assignee ? '@' + assignee + '\n' : '') + label,
      status: status[task.id],
      assignee,
      running: status[task.id] === 'running' ? 1 : 0,
    }});
  }));
  const edges = (board.edges || [])
    .filter(e => status[e.source] !== undefined && status[e.target] !== undefined)
    .map(e => ({ data: {
      id: 'kge_' + e.source + '__' + e.target,
      source: e.source,
      target: e.target,
      blocked: status[e.target] === 'blocked' ? 1 : 0,
      // cross-role handoff edge (parent and child have different assignees)
      crossrole: (who[e.source] && who[e.target] && who[e.source] !== who[e.target]) ? 1 : 0,
      // active handoff: child running while parent is done/running -> work is flowing across this edge
      active: (status[e.target] === 'running' &&
               (status[e.source] === 'done' || status[e.source] === 'running')) ? 1 : 0,
    }}));
  return { nodes, edges };
}

function _kanbanGraphStyle(){
  const cs = getComputedStyle(document.documentElement);
  const cssVar = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  const text = cssVar('--text', '#222');
  const muted = cssVar('--muted', '#888');
  const accent = cssVar('--accent', '#b8860b');
  const line = cssVar('--border', muted);
  const running = '#ffc233';   // running highlight (pulsing border)
  return [
    { selector: 'node', style: {
      'background-color': (ele) => _KANBAN_STATUS_COLORS[ele.data('status')] || _KANBAN_STATUS_COLORS.triage,
      'label': 'data(glabel)',          // line 1 @role, line 2 task title
      'color': text,
      'font-size': '10px',
      'text-wrap': 'wrap',
      'text-max-width': '140px',
      'text-valign': 'bottom',
      'text-margin-y': 4,
      'width': 20,
      'height': 20,
      'border-width': 1,
      'border-color': line,
    }},
    { selector: 'edge', style: {
      'width': 1.5,
      'line-color': muted,
      'target-arrow-color': muted,
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.9,
      'curve-style': 'bezier',
    }},
    // cross-role handoff edge (parent.assignee != child.assignee): dashed to distinguish
    { selector: 'edge[crossrole = 1]', style: {
      'line-style': 'dashed',
      'line-dash-pattern': [5, 4],
    }},
    { selector: 'edge[blocked = 1]', style: {
      'line-color': _KANBAN_BLOCKED_COLOR,
      'target-arrow-color': _KANBAN_BLOCKED_COLOR,
      'width': 2,
    }},
    // active handoff (work flowing: child running, parent done) -> highlight + marching ants (JS-driven dash-offset)
    { selector: 'edge[active = 1]', style: {
      'line-color': running,
      'target-arrow-color': running,
      'width': 3,
      'line-style': 'dashed',
      'line-dash-pattern': [6, 4],
    }},
    // currently-running role/task: pulsing border, so you see who is working right now
    { selector: 'node[running = 1]', style: {
      'border-width': 4,
      'border-color': running,
    }},
    { selector: 'node:selected', style: {
      'border-width': 3,
      'border-color': accent,
    }},
  ];
}

function _kanbanGraphLegend(){
  const labelFor = (s) => (typeof _kanbanColumnLabel === 'function') ? _kanbanColumnLabel(s) : s;
  const wrap = document.createElement('div');
  wrap.className = 'kanban-graph-legend';
  wrap.innerHTML = ['triage','todo','ready','running','blocked','done']
    .map(s => `<span class="kanban-graph-legend-item"><span class="kanban-graph-legend-dot" style="background:${_KANBAN_STATUS_COLORS[s]}"></span>${esc(labelFor(s))}</span>`)
    .join('');
  // role/handoff legend (language-neutral symbols, no i18n needed): node line 1 @role; running = pulsing border; dashed = cross-role handoff; gold marching ants = active flow
  wrap.innerHTML += `<span class="kanban-graph-legend-item" style="opacity:.75"> @role · ◍ running · ┄ cross-role · ⇢ active flow</span>`;
  return wrap;
}

async function _kanbanGraphRender(){
  const host = document.getElementById('kanbanGraph');
  if (!host) return;
  const els = _kanbanGraphElements();
  if (!els || !els.nodes.length){
    _kanbanGraphStopAnimate();
    if (_kanbanCy){ try { _kanbanCy.destroy(); } catch(_){} _kanbanCy = null; }
    host.innerHTML = `<div class="kanban-empty">${esc(t('kanban_graph_empty'))}</div>`;
    return;
  }
  try {
    await _kanbanGraphEnsureLibs();
  } catch(_){
    host.innerHTML = `<div class="kanban-empty">${esc(t('kanban_graph_unavailable'))}</div>`;
    return;
  }
  if (_kanbanView !== 'graph') return;   // user toggled away while libs loaded

  // Incremental update: when the topology (node/edge id set) is unchanged, only
  // patch data (status/role/active) instead of rebuilding — preserves zoom/pan
  // and avoids a relayout, so live refreshes stay smooth.
  if (_kanbanCy){
    let sameTopo = true;
    try {
      const curN = new Set(_kanbanCy.nodes().map(n => n.id()));
      const curE = new Set(_kanbanCy.edges().map(e => e.id()));
      sameTopo = (curN.size === els.nodes.length && curE.size === els.edges.length
        && els.nodes.every(n => curN.has(n.data.id))
        && els.edges.every(e => curE.has(e.data.id)));
    } catch(_){ sameTopo = false; }
    if (sameTopo){
      _kanbanCy.batch(() => {
        els.nodes.forEach(n => { const el = _kanbanCy.getElementById(n.data.id); if (el && el.length) el.data(n.data); });
        els.edges.forEach(e => { const el = _kanbanCy.getElementById(e.data.id); if (el && el.length) el.data(e.data); });
      });
      _kanbanGraphAnimate();
      return;
    }
  }
  _kanbanGraphStopAnimate();
  host.innerHTML = '';
  const mount = document.createElement('div');
  mount.className = 'kanban-graph-canvas';
  host.appendChild(mount);
  host.appendChild(_kanbanGraphLegend());
  if (_kanbanCy){ try { _kanbanCy.destroy(); } catch(_){} _kanbanCy = null; }
  _kanbanCy = window.cytoscape({
    container: mount,
    elements: [...els.nodes, ...els.edges],
    style: _kanbanGraphStyle(),
    layout: { name: 'dagre', rankDir: 'LR', nodeSep: 18, rankSep: 65, edgeSep: 8 },
    wheelSensitivity: 0.2,
    minZoom: 0.2,
    maxZoom: 2.5,
  });
  _kanbanCy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    if (typeof loadKanbanTask === 'function') loadKanbanTask(id);
  });
  try { _kanbanCy.fit(undefined, 30); } catch(_){}
  _kanbanGraphAnimate();
}

// Marching-ants on active handoff edges + pulse on running nodes. Only opens a
// setInterval when there are active/running elements (saves CPU); restarted after
// every render/incremental update (collections refresh); stopped on toggle-away or destroy.
let _kanbanAnimTimer = null;
let _kanbanDash = 0;
function _kanbanGraphAnimate(){
  _kanbanGraphStopAnimate();
  if (!_kanbanCy) return;
  let active, runningNodes;
  try {
    active = _kanbanCy.edges('[active = 1]');
    runningNodes = _kanbanCy.nodes('[running = 1]');
  } catch(_){ return; }
  if ((!active || !active.length) && (!runningNodes || !runningNodes.length)) return;  // nothing live -> no loop
  _kanbanAnimTimer = setInterval(() => {
    if (!_kanbanCy || _kanbanView !== 'graph'){ _kanbanGraphStopAnimate(); return; }
    _kanbanDash = (_kanbanDash + 1) % 100000;
    try {
      _kanbanCy.batch(() => {
        if (active && active.length) active.style('line-dash-offset', -_kanbanDash);          // ants flow toward target
        if (runningNodes && runningNodes.length) runningNodes.style('border-width', 3 + 2 * (1 + Math.sin(_kanbanDash / 3)));  // pulse 3..7
      });
    } catch(_){ _kanbanGraphStopAnimate(); }
  }, 80);
}
function _kanbanGraphStopAnimate(){
  if (_kanbanAnimTimer){ clearInterval(_kanbanAnimTimer); _kanbanAnimTimer = null; }
}

function _kanbanApplyViewToggle(){
  const board = document.getElementById('kanbanBoard');
  const graph = document.getElementById('kanbanGraph');
  const btnBoard = document.getElementById('kanbanViewBoardBtn');
  const btnGraph = document.getElementById('kanbanViewGraphBtn');
  const isGraph = _kanbanView === 'graph';
  if (board) board.hidden = isGraph;
  if (graph) graph.hidden = !isGraph;
  if (btnBoard) btnBoard.classList.toggle('active', !isGraph);
  if (btnGraph) btnGraph.classList.toggle('active', isGraph);
}

// Public: bound to the toggle buttons in index.html.
function kanbanSetView(view){
  _kanbanView = (view === 'graph') ? 'graph' : 'board';
  try { localStorage.setItem(_KANBAN_VIEW_KEY, _kanbanView); } catch(_){}
  _kanbanApplyViewToggle();
  if (_kanbanView === 'graph') _kanbanGraphRender();
  else _kanbanGraphStopAnimate();
}

// Public: called by panels.js _kanbanRenderBoard() after each data refresh, so the
// graph stays in sync with board edits / SSE updates without its own fetch.
function kanbanGraphOnData(){
  if (_kanbanView === null){
    let v = 'board';
    try { v = localStorage.getItem(_KANBAN_VIEW_KEY) || 'board'; } catch(_){}
    _kanbanView = (v === 'graph') ? 'graph' : 'board';
    _kanbanApplyViewToggle();
  }
  if (_kanbanView === 'graph') _kanbanGraphRender();
}
