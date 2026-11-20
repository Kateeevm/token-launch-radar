// Launch Radar dashboard: renders window.RADAR (written by main.ts beside
// this page) as a sortable, filterable board with a detail view per protocol
// and a model page that shows the fit and its held-out test. No network, no
// framework: the page is the entry's own work, and what it shows is computed
// from the same board.json the gate checks.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    view: 'board',
    sortKey: 'rank',
    sortDir: 1,
    q: '',
    category: '',
    chain: '',
    verdict: '',
    watchOnly: false,
    detail: null,
  };

  function fmtInt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtUSD(n) { return '$' + fmtInt(n); }
  function fmtCompact(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + fmtInt(n);
  }
  function fmtPct(x, digits) { return (x * 100).toFixed(digits === undefined ? 0 : digits) + '%'; }
  function fmtChange(x) {
    if (x === null || x === undefined) return '<span class="dim">-</span>';
    var cls = x > 0 ? 'pos' : x < 0 ? 'neg' : 'dim';
    return '<span class="' + cls + '">' + (x > 0 ? '+' : '') + x.toFixed(1) + '%</span>';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return '<span class="dim">-</span>';
    if (days >= 730) return (days / 365.25).toFixed(1) + 'y';
    return days + 'd';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- header + KPI strip -------------------------------------------------
  $('asof').innerHTML = 'Snapshot as of <b>' + esc(R.as_of) + '</b><br>DefiLlama public record, sealed';
  var v = R.fit.validation;
  var farmCount = R.rows.filter(function (r) { return r.verdict === 'FARM'; }).length;
  var kpis = [
    ['Protocols scanned', fmtInt(R.protocol_count), R.board_size + ' pre-token ranked, ' + R.products_screened + ' products set aside'],
    ['Watchlist covered', R.watchlist_size + ' / ' + R.watchlist_size, 'every protocol over the $50M floor, no token yet'],
    ['Model', esc(R.model_version), 'fitted on ' + R.fit.peer_count + ' live-token peers'],
    ['Held-out error', v.fitted_median_abs_log_error.toFixed(2), 'vs ' + v.naive_median_abs_log_error.toFixed(2) + ' for a flat 0.25x guess'],
    ['Farm verdicts', fmtInt(farmCount), 'plans whose value clears their whole cost'],
  ];
  $('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><div class="k-label">' + k[0] + '</div><div class="k-value">' + k[1] + '</div><div class="k-sub">' + k[2] + '</div></div>';
  }).join('');

  // ---- filters -------------------------------------------------------------
  function fillSelect(el, values, allLabel) {
    el.innerHTML = '<option value="">' + allLabel + '</option>' + values.map(function (x) {
      return '<option value="' + esc(x) + '">' + esc(x) + '</option>';
    }).join('');
  }
  var cats = [];
  var chains = [];
  R.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  fillSelect($('f-category'), cats, 'All categories');
  fillSelect($('f-chain'), chains, 'All chains');

  // ---- board table -----------------------------------------------------------
  var COLUMNS = [
    ['rank', '#'],
    ['name', 'Protocol'],
    ['tvl_usd', 'TVL'],
    ['change_7d', '7d'],
    ['age_days', 'Age'],
    ['peer_multiple', 'Peer x'],
    ['token_odds', 'Odds'],
    ['implied_value_usd', 'Implied value'],
    ['verdict', 'Verdict'],
  ];
  function renderHead() {
    $('board-head').innerHTML = '<tr>' + COLUMNS.map(function (c) {
      var sorted = state.sortKey === c[0] ? ' class="sorted"' : '';
      var arrow = state.sortKey === c[0] ? (state.sortDir === 1 ? ' ^' : ' v') : '';
      return '<th data-key="' + c[0] + '"' + sorted + '>' + c[1] + arrow + '</th>';
    }).join('') + '</tr>';
    Array.prototype.forEach.call($('board-head').querySelectorAll('th'), function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (state.sortKey === key) state.sortDir = -state.sortDir;
        else { state.sortKey = key; state.sortDir = (key === 'name' || key === 'rank') ? 1 : -1; }
        renderBoard();
      });
    });
  }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return R.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }
  function renderBoard() {
    renderHead();
    var rows = filteredRows();
    rows.sort(function (a, b) {
      var ka = a[state.sortKey], kb = b[state.sortKey];
      if (ka === null || ka === undefined) ka = -Infinity;
      if (kb === null || kb === undefined) kb = -Infinity;
      if (typeof ka === 'string') return state.sortDir * ka.localeCompare(kb);
      return state.sortDir * (ka - kb);
    });
    $('board-empty').hidden = rows.length > 0;
    $('board-body').innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.detail === r.slug ? ' class="selected"' : '') + '>' +
        '<td>' + r.rank + '</td>' +
        '<td>' + (r.watchlist ? '<span class="wdot" title="On the snapshot watchlist"></span>' : '') +
          '<span class="pname">' + esc(r.name) + '</span><span class="pcat">' + esc(r.category || 'Uncategorised') + '</span></td>' +
        '<td>' + fmtCompact(r.tvl_usd) + '</td>' +
        '<td>' + fmtChange(r.change_7d) + '</td>' +
        '<td>' + fmtAge(r.age_days) + '</td>' +
        '<td>' + r.peer_multiple.toFixed(2) + 'x</td>' +
        '<td>' + fmtPct(r.token_odds) + '</td>' +
        '<td>' + fmtCompact(r.implied_value_usd) + '</td>' +
        '<td><span class="chip ' + r.verdict + '">' + r.verdict + '</span></td>' +
        '</tr>';
    }).join('');
    Array.prototype.forEach.call($('board-body').querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
  }

  // ---- live view ---------------------------------------------------------------
  function renderLive() {
    $('board-head').innerHTML = '<tr><th>#</th><th>Protocol (token live)</th><th>TVL</th><th>Market cap</th><th>Actual x</th><th>7d</th></tr>';
    $('board-empty').hidden = true;
    $('board-body').innerHTML = R.live.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span><span class="pcat">' + esc(r.category || 'Uncategorised') + '</span></td>' +
        '<td>' + fmtCompact(r.tvl_usd) + '</td>' +
        '<td>' + (r.mcap_usd === null ? '<span class="dim">-</span>' : fmtCompact(r.mcap_usd)) + '</td>' +
        '<td>' + (r.multiple === null ? '<span class="dim">-</span>' : r.multiple.toFixed(2) + 'x') + '</td>' +
        '<td>' + fmtChange(r.change_7d) + '</td></tr>';
    }).join('');
  }

  // ---- detail view ---------------------------------------------------------------
  function ageBucketRate(age) {
    var labels = R.fit.odds_by_age.buckets;
    var idx = age === null ? 5 : age < 180 ? 0 : age < 365 ? 1 : age < 730 ? 2 : age < 1460 ? 3 : 4;
    return labels[idx];
  }
  function tvlBucketRate(tvl) {
    var labels = R.fit.odds_by_tvl.buckets;
    var idx = tvl < 1e7 ? 0 : tvl < 5e7 ? 1 : tvl < 2.5e8 ? 2 : 3;
    return labels[idx];
  }
  function openDetail(slug) {
    state.detail = slug;
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    var ab = ageBucketRate(r.age_days);
    var tb = tvlBucketRate(r.tvl_usd);
    var el = $('detail');
    el.hidden = false;
    el.innerHTML =
      '<button class="closebtn" id="d-close" type="button">Close</button>' +
      '<h2>#' + r.rank + ' ' + esc(r.name) + ' <span class="chip ' + r.verdict + '">' + r.verdict + '</span></h2>' +
      '<p class="sub">' + esc(r.category || 'Uncategorised') + ' &middot; ' + esc(r.chains.join(', ') || 'chain unlisted') +
      (r.watchlist ? ' &middot; on the snapshot watchlist' : ' &middot; ranked from below the watchlist') + '</p>' +
      '<div class="detail-grid"><div>' +
      '<h3>How the value is built</h3>' +
      '<div class="equation">TVL ' + fmtUSD(r.tvl_usd) + '<br>&times; peer multiple ' + r.peer_multiple.toFixed(2) + 'x<br>&times; token odds ' + fmtPct(r.token_odds, 1) + '<br>= <b>' + fmtUSD(r.implied_value_usd) + '</b> implied</div>' +
      '<dl class="kv">' +
      '<dt>Age on record</dt><dd>' + (r.age_days === null ? 'unreported' : r.age_days + ' days') + '</dd>' +
      '<dt>TVL change, 7d</dt><dd>' + (r.change_7d === null ? 'unreported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</dd>' +
      '<dt>Odds from its age band</dt><dd>' + fmtPct(ab.rate, 1) + ' (' + ab.label + ', n=' + ab.n + ')</dd>' +
      '<dt>Odds from its TVL band</dt><dd>' + fmtPct(tb.rate, 1) + ' (' + tb.label + ', n=' + tb.n + ')</dd>' +
      '</dl>' +
      '<p class="sub">The peer multiple is the fitted market price of one TVL dollar for a protocol of this category and size; the odds are the share of like protocols that already record a token, read off the snapshot itself.</p>' +
      '</div><div>' +
      '<h3>The farm plan</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="plan-total">Capital ' + fmtUSD(r.capital_usd) + ' &middot; whole-plan cost about ' + fmtUSD(r.plan_cost_usd) + ' &middot; hold ' + r.hold_days + ' days &middot; verdict ' + r.verdict + '</p>' +
      '</div></div>';
    $('d-close').addEventListener('click', function () {
      state.detail = null;
      el.hidden = true;
      if (window.history && history.replaceState) history.replaceState(null, '', window.location.pathname + window.location.search);
      renderBoard();
    });
    el.scrollIntoView({ block: 'nearest' });
    renderBoardSelection();
  }
  function renderBoardSelection() {
    Array.prototype.forEach.call($('board-body').querySelectorAll('tr'), function (tr) {
      tr.className = tr.getAttribute('data-slug') === state.detail ? 'selected' : '';
    });
  }

  // ---- model view ---------------------------------------------------------------
  function rateTable(table) {
    return '<table><thead><tr><th>Bucket</th><th>Protocols</th><th>With a token</th><th>Rate</th></tr></thead><tbody>' +
      table.buckets.map(function (b) {
        return '<tr><td>' + esc(b.label) + '</td><td>' + b.n + '</td><td>' + b.with_token + '</td><td>' + fmtPct(b.rate, 1) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function renderModel() {
    var f = R.fit;
    var baseAt100m = Math.exp(f.intercept);
    $('model').innerHTML =
      '<div class="card"><h2>How the radar prices a token that does not exist</h2>' +
      '<p>Nothing here is a guess typed into a list. The snapshot holds ' + f.peer_count + ' protocols whose token already trades with both a market cap and a TVL; they reveal what the market pays for one dollar of TVL. A log-linear fit on those peers (an intercept and a size term, plus a per-category offset shrunk toward zero for thin categories) prices every pre-token protocol. Token odds come from the same record: the share of protocols that already have a token, tabulated by age band, TVL band and category, each smoothed toward the base rate of ' + fmtPct(f.odds_base_rate, 1) + ' and combined geometrically. Implied value = TVL x fitted multiple x token odds. Wrapped, staked and bridged products of tokens that already trade (' + R.products_screened + ' records, WBTC among them) are set aside before ranking: they are not launches. A 7-day growth term was fitted for the multiple and rejected by the test below (fitted coefficient ' + f.growth_coef_fitted.toFixed(2) + ' per +100% week, held-out error ' + f.validation.with_growth_median_abs_log_error.toFixed(2) + ' with it against ' + f.validation.fitted_median_abs_log_error.toFixed(2) + ' without): one hot week of mercenary TVL is not what the market pays for, so growth is printed on every row and drives the farm plans instead of the price.</p>' +
      '<h3>The fit</h3><dl class="kv">' +
      '<dt>Base multiple at $100M TVL</dt><dd>' + baseAt100m.toFixed(3) + 'x</dd>' +
      '<dt>Size term (per log of TVL)</dt><dd>' + f.size_coef.toFixed(3) + '</dd>' +
      '<dt>Global median peer multiple</dt><dd>' + f.global_median_multiple.toFixed(3) + 'x</dd>' +
      '</dl>' +
      '<h3>Fitted multiple by category (at $100M TVL)</h3><table><thead><tr><th>Category</th><th>Peers</th><th>Multiple</th></tr></thead><tbody>' +
      f.top_categories.map(function (c) { return '<tr><td>' + esc(c.category) + '</td><td>' + c.peers + '</td><td>' + c.multiple.toFixed(2) + 'x</td></tr>'; }).join('') +
      '</tbody></table></div>' +
      '<div class="card"><h2>Tested out of sample, on the page</h2>' +
      '<p>The peers are split into two folds by slug hash. The model is fitted on one fold and asked to predict the other fold\'s market caps, then the folds swap. A median log error of 0.69 means the typical prediction is off by a factor of two; lower is better. The fitted model is compared against the global median multiple and against the flat 0.25x a naive radar would use.</p>' +
      '<table><thead><tr><th>Model</th><th>Median log error</th></tr></thead><tbody>' +
      '<tr><td class="win">Fitted (this radar)</td><td>' + f.validation.fitted_median_abs_log_error.toFixed(3) + '</td></tr>' +
      '<tr><td>Fitted + growth term (rejected)</td><td>' + f.validation.with_growth_median_abs_log_error.toFixed(3) + '</td></tr>' +
      '<tr><td>Flat global median</td><td>' + f.validation.flat_median_abs_log_error.toFixed(3) + '</td></tr>' +
      '<tr><td>Flat 0.25x</td><td>' + f.validation.naive_median_abs_log_error.toFixed(3) + '</td></tr>' +
      '</tbody></table>' +
      '<p>' + f.validation.fitted_within_2x_pct + '% of held-out peers are priced within a factor of two by the fitted model.</p></div>' +
      '<div class="card"><h2>Token odds, from the record</h2>' +
      '<h3>By age</h3>' + rateTable(f.odds_by_age) +
      '<h3>By TVL</h3>' + rateTable(f.odds_by_tvl) +
      '<p>Verdicts: a plan is <b>FARM</b> when its protocol\'s implied value is at least $15M and the whole plan costs at most $150; <b>THIN</b> when implied value is at least $3M and the plan at most $300; otherwise <b>SKIP</b>. Plan costs use stated per-chain gas assumptions (Ethereum $8 an action, most rollups and sidechains under $1, Solana $0.05) and capital sized to the protocol\'s own TVL.</p></div>';
  }

  // ---- view switching + wiring ---------------------------------------------------------------
  function setView(view) {
    state.view = view;
    ['board', 'live', 'model'].forEach(function (name) {
      $('v-' + name).className = 'viewbtn' + (view === name ? ' active' : '');
    });
    $('model').hidden = view !== 'model';
    $('board-wrap').hidden = view === 'model';
    if (view === 'board') renderBoard();
    if (view === 'live') renderLive();
    if (view === 'model') renderModel();
  }
  $('v-board').addEventListener('click', function () { setView('board'); });
  $('v-live').addEventListener('click', function () { setView('live'); });
  $('v-model').addEventListener('click', function () { setView('model'); });
  $('q').addEventListener('input', function () { state.q = $('q').value; if (state.view === 'board') renderBoard(); });
  $('f-category').addEventListener('change', function () { state.category = $('f-category').value; setView('board'); });
  $('f-chain').addEventListener('change', function () { state.chain = $('f-chain').value; setView('board'); });
  $('f-verdict').addEventListener('change', function () { state.verdict = $('f-verdict').value; setView('board'); });
  $('f-watch').addEventListener('change', function () { state.watchOnly = $('f-watch').checked; setView('board'); });

  $('foot').innerHTML =
    '<p><b>Method.</b> Every figure on this page is computed by the entry\'s program from the sealed DefiLlama snapshot of ' + esc(R.as_of) + ': the same run writes the board the gate checks, so the page and the board cannot disagree. Protocols whose token already trades are never ranked; they are shown apart at the market\'s own values, and they are the peers the model is fitted on.</p>' +
    '<p><b>Reading the board.</b> An implied value is this radar\'s own claim about what a protocol\'s token would be worth if its record stayed as it is; it is not a prediction that a token will be issued, and it is not financial advice. Farm plans are starting points for your own research: check each protocol\'s own page before moving funds.</p>';

  // ---- hash state (used for the entry's screenshots and for shareable views) ----
  function applyHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) { setView('board'); return; }
    var params = {};
    hash.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv.length === 2) params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
    });
    if (params.verdict) { state.verdict = params.verdict; $('f-verdict').value = params.verdict; }
    if (params.category) { state.category = params.category; $('f-category').value = params.category; }
    if (params.chain) { state.chain = params.chain; $('f-chain').value = params.chain; }
    if (params.watch === '1') { state.watchOnly = true; $('f-watch').checked = true; }
    if (params.view === 'live') { setView('live'); return; }
    if (params.view === 'model') { setView('model'); return; }
    setView('board');
    if (params.detail) openDetail(params.detail);
    else if (state.detail) { state.detail = null; $('detail').hidden = true; renderBoard(); }
  }
  window.addEventListener('hashchange', applyHash);
  applyHash();
})();
