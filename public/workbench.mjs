import { ASSETS, COLORS, INITIAL, DEFAULT, PRESETS, FACTORS, IDIO, COV, config, simulate, events, sensitivity, identifyBounds } from './engine.mjs';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const sgn = (v, d = 2) => Number.isFinite(v) ? (v > 1e-7 ? '+' : '') + fmt(Math.abs(v) < 1e-7 ? 0 : v, d) : '—';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const PARAMS = [
  ['gapEnd', '中国股票远端回报差', -4, 8, .25, '个百分点/年', '中国减美国，本币预期回报差；不是收益率预测。'],
  ['tau', '条件改善的时间常数', 3, 30, 1, '个月', '越小变化越快；不预设某个月必然转折。'],
  ['fx', '人民币净预期回报贡献', -4, 4, .25, '个百分点/年', '股票承受完整敞口，债券按未套保比例折算。'],
  ['flowFeedback', '美资外流→压力内生反馈', 0, 3, .1, '无量纲', '刻画美国股债净流出对再融资压力 P 的反哺；0 为单向基准。'],
  ['ratePass', '紧缩/政策→利率与黄金传导', 0, 2, .1, '无量纲', '控制紧缩 I 抬升美元现金套息锚、宽松 R 压低现金利率的强度。'],
  ['speed', '自愿配置速率上限', .1, 1.5, .05, '月⁻¹', '实际速率受通道流动性闸门 H 与边际优势约束。'],
  ['cashShock', '美元现金需求冲击', 0, 1.5, .05, '无量纲', '提高最低现金目标并触发字典序优先强售。'],
  ['access', '中国资产通道可达性', 0, 1, .05, '比例', '0 为关闭进出通道（含强售），1 为无额外额度限制。'],
  ['confirm', '持续确认长度', 1, 6, 1, '个月', '连续满足判据的月数；情景判据而非经验常数。']
];

const ADV = [
  ['gap0', '股票起始回报差', -8, 4, .25, '个百分点/年', '起点假设，不由今天的市场总市值推断。'],
  ['bond0', '债券起始回报差', -6, 4, .25, '个百分点/年', '持有期预期总回报差，含久期影响。'],
  ['bondEnd', '债券远端回报差', -4, 6, .25, '个百分点/年', '与股票独立；不以名义政策利差代替总回报。'],
  ['bondHedge', '中国债券外汇套保比例', 0, 1, .05, '比例', '1 为完全套保（不承受 fx 项），0 为完全敞口。'],
  ['friction', '中国资产退出折价', 0, 2, .1, '个百分点/年', '额外流动性与退出补偿，不与单次交易费重复计。'],
  ['costUC', '跨境进入中资单次成本', 0, 40, 1, 'bp', '对美股债、美元现金及第三地进入中资桶一致生效。'],
  ['costCU', '跨境退出中资单次成本', 0, 40, 1, 'bp', '从中资桶退往任意境外桶一致生效，消除绕道漏洞。'],
  ['tight', '起始融资收紧强度', 0, 2, .05, '无量纲', '抬升美元短端现金锚并压低通道流动性 H。'],
  ['tightEnd', '远端融资收紧强度', 0, 2, .05, '无量纲', '假如未来融资环境逐步收敛到该水平。'],
  ['threshold', '政策响应压力阈值', .2, .8, .05, '无量纲', '压力 P 越过阈值后触发政策缓释反应函数。'],
  ['policy', '政策响应启用', 0, 1, 1, '0/1', '关闭后无政策宽松托底，压力仅靠自然衰减。'],
  ['gamma', '组合协方差风险厌恶', .5, 6, .25, '无量纲', '保留七类资产因子相关性矩阵。'],
  ['conc', '市场容量与集中度弹性', 0, 20, 1, '个百分点/年', '防止单一市场被线性推至 0% 角点清零。'],
  ['deductCost', '实付交易费扣减资产池', 0, 1, 1, '0/1', '0 为纯配置指数守恒（同步统计摩擦），1 为实扣本金。'],
  ['mark', '共同估值基准漂移', -30, 30, 1, '%/年', '独立于预期回报差，不计入交易净流量。']
];

const ID_SPECS = [
  ['nU', '美国侧观测净流 n_U', -600, 600, 10, '亿美元/月', '正为净流入美国，负为净流出美国。'],
  ['nC', '中国侧观测净流 n_C', -600, 600, 10, '亿美元/月', '正为净流入中国，负为净流出中国。'],
  ['tol', '双侧统计与口径误差界 ±δ', 0, 200, 5, '亿美元/月', '允许居民/风险归属不完全对齐的误差带。'],
  ['capR', '第三地/现金中转容量上限', 0, 600, 10, '亿美元/月', '离岸枢纽、第三地及美元现金池单月最大吞吐。'],
  ['capUC', '中美直连单向通道上限', 50, 800, 10, '亿美元/月', '受互联互通、QFII/QDII 等渠道容量约束。']
];

let state = { preset: 'base', p: config(), month: 1, chart: 'J', page: 'model', htab: 'cnhk' };
let idState = { nU: -100, nC: 100, tol: 0, capR: 300, capUC: 400 };
let rows = [], ev = null, sens = null, obs = null, archive = null, timer = null, redrawTimer, sensTimer, toastTimer, busy = false;

function toast(s) {
  $('#toast').textContent = s;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3600);
}

function controls(list, prefix = 'p', values = state.p) {
  return list.map(([k, label, min, max, step, u, desc]) =>
    `<div class="control"><label for="${prefix}-${k}">${label}<output id="o-${prefix}-${k}"></output></label><input id="${prefix}-${k}" data-${prefix}="${k}" type="range" min="${min}" max="${max}" step="${step}" value="${values[k]}"><div class="ends"><span>${min} ${esc(u)}</span><span>${max}</span></div><p>${desc}</p></div>`
  ).join('');
}

$('#controls').innerHTML = controls(PARAMS, 'p', state.p);
$('#advanced-controls').innerHTML = controls(ADV, 'p', state.p);
$('#id-controls').innerHTML = controls(ID_SPECS, 'id', idState);
$('#presets').innerHTML = Object.entries(PRESETS).map(([k, v]) => `<button data-preset="${k}" aria-pressed="false">${v.label}</button>`).join('');

function stop() {
  clearInterval(timer);
  timer = null;
  $('#play').textContent = '▶';
  $('#play').setAttribute('aria-label', '播放情景路径');
}

function unitSuffix(u) {
  if (u.includes('个百分点')) return ' pp';
  if (u === 'bp') return ' bp';
  if (u === '个月') return ' 月';
  if (u === '亿美元/月') return ' 亿';
  return '';
}

function syncControls() {
  for (const [k, , , , step, u] of [...PARAMS, ...ADV]) {
    $('#p-' + k).value = state.p[k];
    $('#o-p-' + k).textContent = fmt(state.p[k], step < 1 ? (step < .1 ? 2 : 1) : 0) + unitSuffix(u);
  }
  $$('[data-preset]').forEach(b => {
    const yes = b.dataset.preset === state.preset;
    b.classList.toggle('active', yes);
    b.setAttribute('aria-pressed', String(yes));
  });
  $('#scenario-brief').textContent = PRESETS[state.preset].brief;
}

function recompute() {
  sens = null;
  rows = simulate(state.p);
  ev = events(rows, state.p.confirm);
  syncControls();
  renderModel();
  renderParams();
  clearTimeout(sensTimer);
  $('#sensitivity').textContent = '正在计算 27 组条件扰动…';
  sensTimer = setTimeout(() => { sens = sensitivity(state.p); renderSensitivity(); }, 60);
}

function chart(target, series, { min = null, max = null, includeZero = true, unit = '', selection = null, windows = [], height = 245, labels = null } = {}) {
  const el = $(target);
  if (!el) return;
  const width = Math.max(300, el.clientWidth || 560), W = width, H = height, l = 52, r = 14, t = 23, b = 30, n = series[0]?.values.length || 0;
  if (!n) { el.innerHTML = '<p class="chart-empty">没有同口径的有效序列；未以情景数据代替。</p>'; return; }
  const values = series.flatMap(s => s.values).filter(Number.isFinite);
  if (!values.length) { el.innerHTML = '<p class="chart-empty">当前分项暂无有效观测。</p>'; return; }
  let lo = min ?? (includeZero ? Math.min(0, ...values) : Math.min(...values));
  let hi = max ?? (includeZero ? Math.max(0, ...values) : Math.max(...values));
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * (includeZero ? .08 : .16);
  if (min === null) lo = (!includeZero && Math.min(...values) >= 0) ? Math.max(0, lo - pad) : lo - pad;
  if (max === null) hi += (hi - lo) * .10;
  const x = i => l + i * (W - l - r) / Math.max(1, n - 1), y = v => t + (hi - v) * (H - t - b) / (hi - lo);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(x => x.name).join('、') + '；' + unit)}"><text x="${l}" y="11" font-size="9" fill="#7691ad">${esc(unit)}</text>`;
  for (const win of windows) {
    const a = win.start, z = win.end ?? n - 1;
    s += `<rect x="${x(a)}" y="${t}" width="${Math.max(1, x(z) - x(a))}" height="${H - t - b}" fill="#3bc5ac" opacity=".065"/>`;
  }
  for (let i = 0; i < 5; i++) {
    const v = lo + (hi - lo) * i / 4;
    s += `<line x1="${l}" y1="${y(v)}" x2="${W - r}" y2="${y(v)}" stroke="#24364d" stroke-dasharray="2 5"/><text x="${l - 8}" y="${y(v) + 3}" text-anchor="end" font-family="monospace" font-size="9" fill="#708da9">${fmt(v, Math.abs(hi - lo) > 25 ? 0 : 1)}</text>`;
  }
  if (lo < 0 && hi > 0) s += `<line x1="${l}" y1="${y(0)}" x2="${W - r}" y2="${y(0)}" stroke="#5a738d" stroke-width="1"/>`;
  const stride = Math.max(1, Math.ceil((n - 1) / (W < 420 ? 4 : 6)));
  for (let i = 0; i < n; i++) if (i % stride === 0 || i === n - 1) {
    s += `<text x="${x(i)}" y="${H - 7}" text-anchor="middle" font-size="9" fill="#7e98b4" font-family="monospace">${esc(labels ? labels[i] : '+' + i + '月')}</text>`;
  }
  if (selection !== null) s += `<line x1="${x(selection)}" y1="${t}" x2="${x(selection)}" y2="${H - b}" stroke="#829bb4" stroke-dasharray="3 4"/>`;
  for (const line of series) {
    let path = '', valid = false;
    line.values.forEach((v, i) => {
      if (!Number.isFinite(v)) { valid = false; return; }
      path += (valid ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2) + ' ';
      valid = true;
    });
    s += `<path d="${path}" fill="none" stroke="${line.color}" stroke-width="${line.width || 2.1}" stroke-linejoin="round" stroke-linecap="round" ${line.dash ? 'stroke-dasharray="4 4"' : ''}/>`;
    line.values.forEach((v, i) => {
      if (Number.isFinite(v)) s += `<circle cx="${x(i)}" cy="${y(v)}" r="${i === selection ? 4 : 2}" fill="${line.color}" opacity="${i === selection ? 1 : .6}"><title>${esc(line.name)} · ${esc(labels ? labels[i] : '第 ' + i + ' 月')}：${fmt(v, 3)} ${esc(unit)}</title></circle>`;
    });
  }
  el.innerHTML = s + '</svg>';
  if (selection !== null) {
    el.querySelector('svg').addEventListener('pointerdown', e => {
      const rect = e.currentTarget.getBoundingClientRect();
      state.month = clamp(Math.round(((e.clientX - rect.left) * W / rect.width - l) / (W - l - r) * (n - 1)), 0, n - 1);
      stop();
      renderModel();
    });
  }
}

const metric = (label, symbol, value, unit, foot, color, cls = '') =>
  `<article class="metric ${cls}" style="--c:${color}"><div class="label"><span>${label}</span><span class="symbol">${symbol}</span></div><div class="value">${value}<small>${unit}</small></div><div class="foot">${foot}</div></article>`;

function classifyPhase(r) {
  if (r.forced > 0.2 && r.NUSD > 0) return '现金挤兑 · 美元虹吸';
  if (r.NU < -1e-7 && r.NUSD >= 0) return '美股债出 · 留存美元池';
  if (r.NUSD < -1e-7 && r.NC > 1e-7 && r.J > 1e-7) return '非美化 · 双边向中';
  if (r.NUSD < -1e-7 && r.NC > 1e-7) return '现金出池 · 间接向中';
  if (r.J < -1e-7 && r.NU > 1e-7) return '向美国证券配置';
  if (r.NUSD > 1e-7 && r.NC < -1e-7) return '广义美元净吸纳';
  return '多边再平衡 / 停顿';
}

function renderModel() {
  if (!rows.length) return;
  const r = rows[state.month], p = state.p, m = state.month;
  const phase = classifyPhase(r);
  $('#metrics').innerHTML =
    metric('配置迁移总量', 'L', fmt(r.L), '指数点/月', `自愿 ${fmt(r.Lvol)} · 优先强售 ${fmt(r.forced)}`, '#55cabb') +
    metric('中美直接净迁移', 'J', sgn(r.J), '指数点/月', `中资总净流 NC ${sgn(r.NC)} · 中转差 ${sgn(r.Jindirect)}`, '#5590ff') +
    metric('当期配置流速', 'v', fmt(r.v * 100), '%/月', `自愿 ${fmt(r.vVol * 100, 1)}% · 强售 ${fmt(r.vForced * 100, 1)}%`, '#e8ae64') +
    metric('所选月机制状态', 'STATE', phase, '', `广义美元净流 ${sgn(r.NUSD)} · 情景第 ${m} 月`, '#a79aea', 'state');

  $('#month').max = p.months;
  $('#month').value = m;
  $('#month-label').textContent = `第 ${m} / ${p.months} 月`;
  $('#selected-badge').textContent = `情景 +${m} 月`;
  $$('[data-chart]').forEach(b => b.classList.toggle('active', b.dataset.chart === state.chart));

  let series, unit;
  if (state.chart === 'J') {
    series = [
      { name: '中美直接净迁移 J', color: '#55cabb', values: rows.map(r => r.J) },
      { name: '中国总净流入 NC（含现金/第三地中转）', color: '#5590ff', values: rows.map(r => r.NC) },
      { name: '广义美元体系净吸收 N_USD（美股债+美元现金）', color: '#e8ae64', dash: true, values: rows.map(r => r.NUSD) }
    ];
    unit = '资本指数点/月';
  } else if (state.chart === 'split') {
    series = [
      { name: '股票直连 J_e', color: '#55cabb', values: rows.map(r => r.Je) },
      { name: '债券直连 J_b', color: '#5590ff', values: rows.map(r => r.Jb) },
      { name: '跨类直连 J_cross', color: '#a79aea', dash: true, values: rows.map(r => r.Jcross) },
      { name: '黄金+第三地净吸收', color: '#edbb63', dash: true, values: rows.map(r => r.Nalt) }
    ];
    unit = '资本指数点/月';
  } else if (state.chart === 'L') {
    series = [
      { name: '配置迁移总量 L', color: '#5590ff', values: rows.map(r => r.L) },
      { name: '自愿边际配置 L_vol', color: '#55cabb', values: rows.map(r => r.Lvol) },
      { name: '优先强制换现金 L_forced', color: '#e8ae64', dash: true, values: rows.map(r => r.forced) }
    ];
    unit = '资本指数点/月';
  } else {
    series = [
      { name: '总配置流速 v', color: '#e8ae64', values: rows.map(r => r.v * 100) },
      { name: '自愿配置流速 v_vol（受流动性 H 约束）', color: '#55cabb', values: rows.map(r => r.vVol * 100) },
      { name: '强制变现流速 v_forced（受现金缺口驱动）', color: '#e98f8b', dash: true, values: rows.map(r => r.vForced * 100) }
    ];
    unit = '%/月';
  }

  chart('#main-chart', series, { unit, selection: m, windows: ev.windows, height: 260 });
  $('#main-legend').innerHTML = series.map(s => `<span style="--c:${s.color};margin-right:18px">${esc(s.name)}</span>`).join('');
  chart('#state-chart', [
    { name: 'H 通道流动性', color: '#55cabb', values: rows.map(r => r.H) },
    { name: 'P 融资压力（含外流反哺）', color: '#e8ae64', values: rows.map(r => r.P) },
    { name: 'R 政策响应', color: '#a79aea', values: rows.map(r => r.R) }
  ], { min: 0, max: 1, unit: '无量纲 · 双向耦合状态', height: 190, selection: m });

  $('#allocation').innerHTML =
    '<div class="allocation-bar">' + r.w.map((v, i) => `<span style="width:${v * 100}%;background:${COLORS[i]}"></span>`).join('') + '</div>' +
    ASSETS.map((a, i) => `<div class="allocation-row"><span><i style="--c:${COLORS[i]}"></i>${a}</span><span class="amount">${fmt(r.w[i] * 100, 1)}% <small class="${r.net[i] >= 0 ? 'positive' : 'negative'}">${sgn(r.net[i], 2)}</small></span></div>`).join('') +
    `<p class="micro">右侧为当月净迁移（点/月）· 当前池规模 ${fmt(r.W, 2)} 点 · 累计摩擦损耗 ${fmt(r.cumCost, 3)} 点</p>`;

  const time = x => x === null ? '未触发' : x === 0 ? '起点已满足' : `第 ${x} 月`;
  $('#events').innerHTML = [
    ['01 / 直连边际触发', time(ev.anyTrigger), `股 ${time(ev.equityTrigger)} · 债 ${time(ev.bondTrigger)} · 现金池 ${time(ev.cashTrigger)}`, '#55cabb'],
    ['02 / 直连净流翻转', ev.initialPositive ? '起点已偏中' : time(ev.flip), '满足 T_S ≤ T_flip；J 由负转正', '#5590ff'],
    ['03 / 双边直连持续', time(ev.confirm), `连续 ${p.confirm} 月 J>0、NC>0 且美股债 NU<0`, '#a79aea'],
    ['04 / 广义美元出池', time(ev.broadConfirm), `连续 ${p.confirm} 月中资净入 NC>0 且广义美元 N_USD<0`, '#e8ae64']
  ].map(([a, b, c, col]) => `<div class="event" style="--c:${col}"><small>${a}</small><b>${b}</b><p>${c}</p></div>`).join('');

  const directTxt = ev.windows.length
    ? ev.windows.map(w => `双边直连窗口：第 ${w.start} 月起，第 ${w.confirmed} 月确认，${w.censored ? `至第 ${p.months} 月仍持续（右删失）` : `第 ${w.end} 月后结束`}。`).join(' ')
    : `在 ${p.months} 个月演算期内，未出现连续 ${p.confirm} 个月的直接双边“美股债出、中资股债入”。`;
  const broadTxt = ev.broadWindows.length
    ? `广义美元出池窗口：第 ${ev.broadWindows[0].start} 月起（第 ${ev.broadWindows[0].confirmed} 月确认），反映包含美元现金池在内的广义美元资产向中国净再配置。`
    : '广义美元池（美股债＋美元现金）亦未形成持续向中国的净释放。';
  $('#window-detail').textContent = directTxt + ' ' + broadTxt;

  const edges = [];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i !== j && r.f[i][j] > 1e-5) edges.push({ i, j, value: r.f[i][j] });
  edges.sort((a, b) => b.value - a.value);
  $('#flow-edges').innerHTML = (edges.slice(0, 6).map(e => `<div class="edge"><span>${ASSETS[e.i]}<em>→</em>${ASSETS[e.j]}</span><strong>${fmt(e.value, 3)}</strong></div>`).join('') || '<p class="micro">本期没有达到显示量级的迁移。</p>') +
    `<div class="anchor-strip"><span>直连分项：股 <b>${sgn(r.Je, 2)}</b></span><span>债 <b>${sgn(r.Jb, 2)}</b></span><span>跨类 <b>${sgn(r.Jcross, 2)}</b></span><span>净位移效率 <b>${r.netEff !== null ? fmt(r.netEff * 100, 1) + '%' : '—'}</b></span></div>`;

  $('#flow-description').textContent = `自愿配置 ${fmt(r.Lvol)}、优先强售 ${fmt(r.forced)} 点/月；最低美元现金线 ${fmt(r.cashFloor * 100, 1)}%；当期摩擦 ${fmt(r.costDrag, 4)} 点。`;

  $('#driver-bars').innerHTML = [[0, 2, '股票', 'Se'], [1, 3, '债券', 'Sb']].map(([i, j, name, key]) => {
    const terms = [
      ['预期美元回报差', (r.mu[j] - r.mu[i]) * 10000],
      ['协方差与容量风险差', -(r.risk[j] - r.risk[i]) * 10000],
      ['退出折价差', -(r.chi[j] - r.chi[i]) * 10000],
      ['单次跨境准入成本', -p.costUC]
    ];
    return `<div class="driver total"><span>${name} · 扣成本边际优势</span><b class="${r[key] > 0 ? 'positive' : 'negative'}">${sgn(r[key])} bp</b></div>` +
      terms.map(([n, v]) => `<div class="driver"><span>${n}</span><b>${sgn(v)} bp</b></div>`).join('');
  }).join('') +
  `<div class="anchor-strip"><span>美元现金年化锚 <b>${fmt(r.annual[6], 2)}%</b></span><span>黄金预期 <b>${fmt(r.annual[4], 2)}%</b></span><span>中资对美元现金优势 <b class="${r.ScashC > 0 ? 'positive' : 'negative'}">${sgn(r.ScashC, 1)} bp</b></span></div>`;
}

function renderSensitivity() {
  if (!sens) return;
  $('#sensitivity').innerHTML =
    `确定性参数扰动（27 组）：双边直连确认 <b>${sens.hit} / ${sens.n}</b> 组，广义美元出池确认 <b>${sens.broadHit} / ${sens.n}</b> 组，未触发双边直连 <b>${sens.miss}</b> 组。` +
    (sens.hit ? `触发组直连确认月份范围 <b>第 ${sens.early}—${sens.late} 月</b>。` : '') +
    '<br>扰动网格：远端股票回报差 ±1 pp、配置速率与跨境成本 ×0.7/1/1.3；触发组数不是现实概率或置信区间。';
}

function renderParams() {
  const lookup = Object.fromEntries([...PARAMS, ...ADV].map(([k, label, , , , unit]) => [k, [label, unit]]));
  $('#parameter-table').innerHTML = Object.entries(state.p).map(([k, v]) =>
    `<tr><td>${esc(lookup[k]?.[0] || k)}</td><td>${fmt(v, 4)}</td><td>${esc(lookup[k]?.[1] || ({ months: '月 · 演算长度', step: '月 · RK2 步长' })[k] || '情景系数')}</td></tr>`
  ).join('');
  $('#fixed-params').textContent = JSON.stringify({
    model_version: '2.1.0',
    integrator: '2nd-order positivity-preserving conservative Heun (RK2)',
    initial_capital_index: INITIAL,
    assets: ASSETS,
    factor_loadings_annual: FACTORS,
    idiosyncratic_volatility_annual: IDIO,
    covariance_monthly: COV,
    initial_states: { H: .72, P: .28, R: .08 },
    dynamics: {
      H: [.22, .40, .65],
      P_base: [.22, .32, .12, .28],
      P_outflow_feedback: 'flowFeedback * max(0, -NU / W)',
      R_rate_per_month: .45,
      policy_sigmoid_width: .09,
      liquidity_half_saturation: .3,
      return_scale_monthly: .001,
      forced_rate_per_month: 1.4,
      forced_priority: 'lexicographic_before_voluntary',
      cash_target: 'clip(.08+.08*P+.40*Z,.05,.75)',
      cost_matrix_bp: { into_CN: 'costUC', out_of_CN: 'costCU', US_bond_cash: 1, same_market_eq_bond: 2, other_cross_asset: 3 }
    },
    note: '全部为公开情景系数，未由真实资本流样本回归估计。'
  }, null, 2);
}

function syncIdControls() {
  for (const [k, , , , step, u] of ID_SPECS) {
    const el = $('#id-' + k), out = $('#o-id-' + k);
    if (el) el.value = idState[k];
    if (out) out.textContent = (k === 'nU' || k === 'nC' ? sgn(idState[k], 0) : fmt(idState[k], step < 1 ? 1 : 0)) + unitSuffix(u);
  }
}

function renderIdentification() {
  syncIdControls();
  const res = identifyBounds({
    nU: idState.nU, nC: idState.nC,
    tolU: idState.tol, tolC: idState.tol,
    capUC: idState.capUC, capCU: idState.capUC,
    capR: idState.capR
  });
  const box = $('#id-result');
  if (!box) return;
  if (!res.feasible) {
    box.innerHTML = `<span class="id-status neg">约束冲突 · 集合为空</span><div class="id-bounds">无可行双边网络</div><p>给定净流量超出了直连通道与第三地中转容量之和（|n_U + n_C| &gt; 2·capR 或单侧净额超通道总和），须检查统计范围不匹配项 b_t 或放宽误差界 δ。</p>`;
    return;
  }
  const map = {
    positive_identified: ['pos', '方向可识别 · 稳健美→中（J_UC > 0）'],
    negative_identified: ['neg', '方向可识别 · 稳健中→美（J_UC < 0）'],
    unidentified_spans_zero: ['unk', '跨零未识别 · 仅凭净额无法锁定双边方向']
  }[res.status];
  const wMin = res.witnessMin, wMax = res.witnessMax;
  box.innerHTML =
    `<span class="id-status ${map[0]}">${map[1]}</span>` +
    `<div class="id-bounds">J_UC ∈ [${sgn(res.minJ, 1)}, ${sgn(res.maxJ, 1)}] <small style="font-size:11px;color:#91a4bc">亿美元/月（区间宽度 ${fmt(res.width, 1)}）</small></div>` +
    `<p>隐含第三地/现金池净吸收 n_R ≈ ${sgn(-(idState.nU + idState.nC), 1)} 亿美元/月。${res.status === 'unidentified_spans_zero' ? '由于第三地/离岸枢纽中转容量充足，同一组美中净额可由正向直连或反向绕道同时生成。' : '在当前通道上限与误差界下，绕道流量不足以翻转中美直接净迁移符号。'}</p>` +
    `<div class="id-witness">` +
    `<div><b>下界见证网络（J_UC = ${sgn(wMin.J, 1)}）</b><code>U→C ${fmt(wMin.flows.fUC, 1)} · C→U ${fmt(wMin.flows.fCU, 1)}<br>U→R ${fmt(wMin.flows.fUR, 1)} · R→U ${fmt(wMin.flows.fRU, 1)}<br>R→C ${fmt(wMin.flows.fRC, 1)} · C→R ${fmt(wMin.flows.fCR, 1)}</code></div>` +
    `<div><b>上界见证网络（J_UC = ${sgn(wMax.J, 1)}）</b><code>U→C ${fmt(wMax.flows.fUC, 1)} · C→U ${fmt(wMax.flows.fCU, 1)}<br>U→R ${fmt(wMax.flows.fUR, 1)} · R→U ${fmt(wMax.flows.fRU, 1)}<br>R→C ${fmt(wMax.flows.fRC, 1)} · C→R ${fmt(wMax.flows.fCR, 1)}</code></div>` +
    `</div>`;
}

for (const b of $$('[data-preset]')) b.addEventListener('click', () => {
  stop(); state.preset = b.dataset.preset; state.p = config(state.preset); state.month = 1; recompute();
});
$('#reset').addEventListener('click', () => { stop(); state.p = config(state.preset); state.month = 1; recompute(); });

$$('[data-p]').forEach(el => el.addEventListener('input', () => {
  stop();
  const spec = [...PARAMS, ...ADV].find(r => r[0] === el.dataset.p);
  state.p[el.dataset.p] = clamp(Number(el.value), spec[2], spec[3]);
  syncControls();
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(recompute, 60);
}));

$$('[data-id]').forEach(el => el.addEventListener('input', () => {
  const spec = ID_SPECS.find(r => r[0] === el.dataset.id);
  idState[el.dataset.id] = clamp(Number(el.value), spec[2], spec[3]);
  renderIdentification();
}));

$$('[data-idpreset]').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.idpreset;
  if (k === 'nullspace') {
    idState = { nU: -100, nC: 100, tol: 0, capR: 300, capUC: 300 };
  } else if (k === 'identified') {
    idState = { nU: -280, nC: 240, tol: 20, capR: 120, capUC: 500 };
  } else if (k === 'latest') {
    const w = regionData('world').at(-1);
    const uVal = clamp(Math.round((w?.total ?? 300) / 10) * 10, -600, 600);
    idState = { nU: uVal, nC: 20, tol: 40, capR: 450, capUC: 400 };
  }
  renderIdentification();
}));

$$('[data-htab]').forEach(b => b.addEventListener('click', () => {
  state.htab = b.dataset.htab;
  $$('[data-htab]').forEach(x => x.classList.toggle('active', x.dataset.htab === state.htab));
  renderHoldings();
}));

$('#month').addEventListener('input', e => { stop(); state.month = Number(e.target.value); renderModel(); });
$$('[data-chart]').forEach(b => b.addEventListener('click', () => { state.chart = b.dataset.chart; renderModel(); }));
$('#play').addEventListener('click', () => {
  if (timer) { stop(); return; }
  if (state.month >= state.p.months) state.month = 0;
  $('#play').textContent = 'Ⅱ';
  $('#play').setAttribute('aria-label', '暂停情景路径');
  timer = setInterval(() => { state.month++; renderModel(); if (state.month >= state.p.months) stop(); }, 800);
});

function showPage() {
  const page = state.page;
  $$('.page').forEach(el => el.hidden = el.id !== 'page-' + page);
  $$('nav a').forEach(a => {
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = ({ model: '三流演化', observed: '真实资金观测与识别', method: '模型诊断与升级' })[page] + ' · 资本三流研究台 V2.1';
  if (page !== 'model') stop();
  if (page === 'observed') { if (obs) renderObserved(); renderIdentification(); renderArchive(); }
  if (page === 'model') renderModel();
}

function readURL() {
  const [page = 'model', query = ''] = location.hash.slice(1).split('?');
  state.page = ['model', 'observed', 'method'].includes(page) ? page : 'model';
  const q = new URLSearchParams(query);
  if (q.has('preset') || q.has('p')) {
    try {
      const preset = Object.hasOwn(PRESETS, q.get('preset')) ? q.get('preset') : 'base';
      const extra = {};
      if (q.has('p')) {
        const o = JSON.parse(q.get('p'));
        for (const [k, , min, max] of [...PARAMS, ...ADV]) {
          if (Object.hasOwn(o, k)) extra[k] = clamp(Number(o[k]), min, max);
        }
      }
      state.preset = preset;
      state.p = config(preset, extra);
      state.month = Math.round(clamp(Number(q.get('m') || 1), 0, state.p.months));
      if (!Number.isFinite(state.month)) state.month = 1;
      recompute();
    } catch {
      toast('情景参数无效，已恢复安全默认参数。');
    }
  }
  showPage();
}

window.addEventListener('hashchange', () => { readURL(); window.scrollTo({ top: 0, behavior: 'instant' }); });

async function share() {
  const u = new URL(location.href);
  u.hash = 'model?' + new URLSearchParams({ preset: state.preset, p: JSON.stringify(state.p), m: state.month });
  try {
    await navigator.clipboard.writeText(u.href);
    toast('已复制可复算情景链接（含全部参数与检查月份）。');
  } catch {
    location.hash = u.hash;
    toast('参数已写入地址栏，可直接复制当前链接。');
  }
}
$('#share').addEventListener('click', share);

function download(text, name, type) {
  const u = URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1500);
}

$('#export-csv').addEventListener('click', () => {
  const head = 'month,flow_L,voluntary_L,forced_L,direct_J,Je,Jb,Jcross,NC_total,NU_sec,NUSD_broad,velocity_v,velocity_vol,velocity_forced,H,P,R,W,cost_drag,cum_cost,mark_G,' + ASSETS.map((_, i) => 'K_' + i).join(',');
  const lines = rows.map(r => [r.month, r.L, r.Lvol, r.forced, r.J, r.Je, r.Jb, r.Jcross, r.NC, r.NU, r.NUSD, r.v, r.vVol, r.vForced, r.H, r.P, r.R, r.W, r.costDrag, r.cumCost, r.G, ...r.K].join(','));
  download('\ufeff' + [head, ...lines].join('\r\n'), 'three-flow-v2.1-conditional-path.csv', 'text/csv;charset=utf-8');
  toast('逐月三流分解数据已导出 CSV。');
});

$('#export-json').addEventListener('click', () => download(JSON.stringify({
  model: 'capital-three-flow-v2.1',
  kind: 'conditional_coupled_not_fitted',
  units: 'capital index W0=100; month',
  initial: INITIAL,
  params: state.p,
  covariance_monthly: COV,
  rows,
  events: ev,
  sensitivity: sens
}, null, 2), 'three-flow-v2.1-reproducible.json', 'application/json'));

function beijing(s) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s)) + ' 北京时间';
  } catch { return '未取得'; }
}

async function sync(manual = false) {
  if (busy) return;
  busy = true;
  $('#refresh').disabled = true;
  try {
    const r = await fetch('data/observations.json', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw Error(r.status);
    const d = await r.json();
    if (d.schema_version !== 1 || !d.sources) throw Error('schema');
    obs = d;
    renderSnapshot();
    if (state.page === 'observed') renderObserved();
    if (manual) toast('已同步发布快照；刷新不代表上游公布了新一期数据。');
  } catch {
    $('#data-dot').classList.add('warn');
    $('#sync-status').textContent = obs ? '同步失败，保留原快照及原观测期。' : '无法获取观测快照；未以模拟值代替真实值。';
    if (manual) toast('快照暂不可读，已保留旧值或缺口。');
  } finally {
    busy = false;
    $('#refresh').disabled = false;
  }
}

async function loadArchive() {
  try {
    const r = await fetch('data/research-archive.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    archive = await r.json();
    if (state.page === 'observed') renderArchive();
  } catch { /* archive is optional supplement */ }
}

function renderArchive() {
  const tb = $('#archive-table');
  if (!tb) return;
  if (!archive?.rows?.length) {
    tb.innerHTML = '<tr><td colspan="5">静态核实档案未加载。</td></tr>';
    return;
  }
  $('#archive-meta').textContent = `核验封存日：${archive.last_verified}（自动更新：否）· 展示中美不同统计部门的口径边界，禁止直接横向相减。`;
  tb.innerHTML = archive.rows.map(r => {
    const num = Number(r.value);
    const cls = Number.isFinite(num) ? (num >= 0 ? 'positive' : 'negative') : '';
    return `<tr><td>${esc(r.jurisdiction)}</td><td><a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer">${esc(r.label)} ↗</a></td><td>${esc(r.observation_period)}</td><td class="${cls}">${Number.isFinite(num) ? sgn(num, 0) : esc(r.value)} ${esc(r.unit)}</td><td>${esc(r.sign_convention)} · ${esc(r.scope_and_limitations)}</td></tr>`;
  }).join('');
}

function regionData(k) { return obs?.sources?.tic_transactions?.regions?.[k]?.history || []; }

function renderSnapshot() {
  const src = obs.sources.tic_transactions, world = regionData('world').at(-1), cn = regionData('cn').at(-1), hk = regionData('hk').at(-1);
  const fx = obs.sources.ecb_fx?.metrics?.find(m => m.id === 'usd_cny');
  const bad = Object.values(obs.sources).some(s => s.status !== 'ok'), aged = Date.now() - new Date(obs.generated_at) > 86400000;
  $('#data-dot').classList.toggle('warn', bad || aged);
  $('#obs-period').textContent = (src?.period || '未取得') + ' · TIC 月频';
  $('#tickers').innerHTML = [
    ['全球对美长期证券', world?.total, '亿美元/月'],
    ['内地居民对美净额', cn?.total, '亿美元/月'],
    ['香港居民对美净额', hk?.total, '亿美元/月'],
    ['美元 / 人民币参考价', fx?.value, '元/美元']
  ].map(([s, v, u], i) => `<div class="tick"><span>${s}</span><b>${i === 3 ? fmt(v, 4) : sgn(v, 2)}</b><small>${u}</small></div>`).join('');
  $('#sync-status').textContent = `${bad ? '部分来源失败，保留旧值；' : aged ? '发布快照超过 24 小时；' : ''}证券统计期 ${src?.period || '—'} · 汇率期 ${obs.sources.ecb_fx?.period || '—'} · 快照生成 ${beijing(obs.generated_at)}。真实净额与条件模型分层展示。`;
}

function renderHoldings() {
  const h = obs?.sources?.tic_holdings?.history || [];
  if (!h.length) {
    $('#holdings-chart').innerHTML = '<p class="chart-empty">TIC 表 5 持仓序列暂不可用。</p>';
    $('#holdings-summary').textContent = '';
    return;
  }
  const labels = h.map(r => r.period.slice(2));
  const first = h[0], last = h.at(-1);
  if (state.htab === 'sector' && Number.isFinite(last.official)) {
    chart('#holdings-chart', [
      { name: '外国官方储备机构持有美债', color: '#55cabb', values: h.map(r => r.official) },
      { name: '外国私人与托管机构持有美债', color: '#e8ae64', values: h.map(r => r.private) }
    ], { unit: '亿美元 · 月末存量', labels, height: 220, includeZero: false });
    const dOff = last.official - first.official, dPriv = (last.private ?? 0) - (first.private ?? 0);
    $('#holdings-summary').innerHTML = `结构对照（${esc(first.period)} → ${esc(last.period)}）：外国官方机构存量 <b>${sgn(dOff, 1)}</b> 亿美元（月末 ${fmt(last.official, 1)} 亿），私人与托管部门 <b>${sgn(dPriv, 1)}</b> 亿美元（月末 ${fmt(last.private, 1)} 亿）。总量平稳掩盖了官方储备与私人套息盘的反向变动。`;
  } else {
    chart('#holdings-chart', [
      { name: '中国内地持有美债存量', color: '#55cabb', values: h.map(r => r.cn) },
      { name: '中国香港持有美债存量', color: '#5590ff', values: h.map(r => r.hk) }
    ], { unit: '亿美元 · 月末存量', labels, height: 220, includeZero: false });
    const dCn = last.cn - first.cn, dHk = last.hk - first.hk;
    $('#holdings-summary').innerHTML = `存量对照（${esc(first.period)} → ${esc(last.period)}）：内地名义托管存量 <b>${sgn(dCn, 1)}</b> 亿美元（最新 ${fmt(last.cn, 1)} 亿），香港托管存量 <b>${sgn(dHk, 1)}</b> 亿美元（最新 ${fmt(last.hk, 1)} 亿）。月末存量含美债价格重估与离岸转托管，不能直接等同净卖出回流。`;
  }
}

function renderObserved() {
  if (!obs) return;
  const key = $('#region').value, rs = regionData(key), r = rs.at(-1);
  const label = ({ world: '全球外国居民', cn: '中国内地居民', hk: '中国香港居民' })[key];
  $('#history-count').textContent = `${rs.length} 个月 · ${label}`;
  const world = regionData('world').at(-1), cn = regionData('cn').at(-1), hk = regionData('hk').at(-1);
  $('#observation-verdict').innerHTML = world
    ? `<strong>${esc(world.period)}：外国居民整体${world.total > 0 ? '仍在净买入' : '转为净卖出'}美国长期证券，但官方储备、私人套息与地区居民明显分化。</strong><p>当月全球对美长期证券净交易 ${sgn(world.total)} 亿美元；内地居民 ${sgn(cn?.total)}、香港居民 ${sgn(hk?.total)} 亿美元。单边吸收数据可证伪“美资全面溃逃”，但因缺少穿透对手方，须结合下方部分识别区间判断双边流向。</p>`
    : '官方序列尚不可用；不生成替代结论。';

  $('#observed-metrics').innerHTML =
    metric('对美长期证券净交易', 'q', sgn(r?.total), '亿美元/月', `${r?.period || '—'} · ${label}`, '#55cabb') +
    metric('其中股票', 'E', sgn(r?.equity), '亿美元/月', '直接使用官方净交易分项', '#5590ff') +
    metric('其中债券', 'B', sgn(r?.bond), '亿美元/月', '合计减股票（国债+机构债+公司债）', '#e8ae64') +
    metric('净配置强度', 'q/K', sgn(r?.intensity), '%/月', '净额代理，不是毛流速 v', '#a79aea');

  chart('#observed-chart', [
    { name: '长期证券合计', color: '#55cabb', values: rs.map(r => r.total) },
    { name: '股票', color: '#5590ff', values: rs.map(r => r.equity) },
    { name: '债券', color: '#e8ae64', values: rs.map(r => r.bond) }
  ], { unit: '亿美元/月', labels: rs.map(r => r.period.slice(2)), height: 280 });

  chart('#intensity-chart', [{ name: '净配置强度', color: '#a79aea', values: rs.map(r => r.intensity) }], { unit: '%/月 · 净额代理', labels: rs.map(r => r.period.slice(2)), height: 215 });

  $('#reconcile').innerHTML = r
    ? [['期末长期证券持仓', fmt(r.position)], ['本月净交易', sgn(r.total)], ['官方估值变动', sgn(r.valuation)], ['其他调整 / 对账残差', sgn(r.residual)]].map(([n, v]) => `<div class="driver"><span>${n}</span><b>${v}</b></div>`).join('') +
      '<p class="micro" style="margin-top:14px">残差 = 持仓增量 − 净交易 − 估值变动。可能含样本重分类、托管迁移与统计调整，不冒充隐藏净买入。</p>'
    : '<p class="micro">缺少可比数据。</p>';

  renderHoldings();
  renderIdentification();
  renderArchive();

  $('#region-table').innerHTML = ['world', 'cn', 'hk'].map(k => {
    const v = regionData(k).at(-1);
    return v ? `<tr><td>${({ world: '全球外国居民', cn: '中国内地居民', hk: '中国香港居民' })[k]}</td>${['total', 'equity', 'treasury', 'agency', 'corporate'].map(x => `<td class="${v[x] >= 0 ? 'positive' : 'negative'}">${sgn(v[x])}</td>`).join('')}<td>${esc(v.period)}</td></tr>` : '';
  }).join('');

  $('#source-log').innerHTML = Object.values(obs.sources).map(s =>
    `<div class="source"><span class="badge">${s.status === 'ok' ? '成功读取' : s.status === 'stale' ? '读取失败 · 保留旧值' : '暂不可用'}</span><b>${esc(s.name)}</b>观测期 ${esc(s.period || '—')} · ${esc(s.frequency)}<br>最近成功 ${beijing(s.last_success_at)}<br>最近尝试 ${beijing(s.last_attempt_at)}${s.error ? '<p>' + esc(s.error) + '</p>' : ''}<code>SHA-256 ${esc(s.sha256 || '—')}</code><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">原始官方来源 ↗</a></div>`
  ).join('');
}

$('#region').addEventListener('change', renderObserved);
$('#refresh').addEventListener('click', () => sync(true));
$('#export-observed').addEventListener('click', () => {
  if (!obs) return toast('尚无可导出的观测');
  const cols = ['period', 'total', 'equity', 'bond', 'treasury', 'agency', 'corporate', 'position', 'valuation', 'intensity', 'residual'];
  const out = ['region,' + cols.join(',')];
  for (const k of ['world', 'cn', 'hk']) for (const r of regionData(k)) out.push([k, ...cols.map(c => r[c] ?? '')].join(','));
  download('\ufeff' + out.join('\r\n'), 'tic-official-net-transactions.csv', 'text/csv;charset=utf-8');
});

$('#reference-link').href = 'https://wbapp-wmbv2t6xmnfyoinbr26r7j.app.workbuddy.host/?sharecode=HASTKAG67H&shareId=80a6844c7a72455b80a8bc7ac9923217';

let resize;
window.addEventListener('resize', () => {
  clearTimeout(resize);
  resize = setTimeout(() => {
    if (state.page === 'model') renderModel();
    if (state.page === 'observed' && obs) renderObserved();
  }, 140);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });

recompute();
readURL();
sync();
loadArchive();
renderIdentification();
setInterval(() => { if (!document.hidden) sync(); }, 300000);
