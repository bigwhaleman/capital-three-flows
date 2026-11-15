import { ASSETS, COLORS, INITIAL, DEFAULT, PRESETS, FACTORS, IDIO, COV, config, simulate, events, sensitivity, identifyBounds } from './engine.mjs';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const sgn = (v, d = 2) => Number.isFinite(v) ? (v > 1e-7 ? '+' : '') + fmt(Math.abs(v) < 1e-7 ? 0 : v, d) : '—';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const PAGES = ['overview', 'brief', 'model', 'observed', 'method'];

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

let state = { preset: 'base', p: config(), month: 1, chart: 'J', page: 'overview', htab: 'cnhk', theme: 'light' };
let idState = { nU: -100, nC: 100, tol: 0, capR: 300, capUC: 400 };
let rows = [], ev = null, sens = null, obs = null, archive = null, presetCache = null;
let timer = null, redrawTimer, sensTimer, toastTimer, busy = false;

function themeColors() {
  const dark = state.theme === 'dark';
  return {
    grid: dark ? '#22354d' : '#e6edf6',
    zero: dark ? '#5b7594' : '#94a7c0',
    axis: dark ? '#839ab5' : '#5b708f',
    cyan: dark ? '#38cbb8' : '#0d9488',
    blue: dark ? '#5894ff' : '#2563eb',
    amber: dark ? '#f0b25c' : '#d97706',
    red: dark ? '#f27b88' : '#e11d48',
    purple: dark ? '#a792f6' : '#7c3aed',
    winFill: dark ? '#3bc5ac' : '#0d9488'
  };
}

function applyTheme(t) {
  state.theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = state.theme === 'dark' ? '#0b1422' : '#f4f7fb';
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = state.theme === 'dark' ? '☀ 浅色' : '☾ 深色';
  try { localStorage.setItem('three_flows_theme', state.theme); } catch { /* ignore */ }
}

try {
  const saved = localStorage.getItem('three_flows_theme');
  if (saved === 'dark' || saved === 'light') applyTheme(saved);
} catch { /* ignore */ }

$('#theme-toggle')?.addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  renderActiveCharts();
});

function toast(s) {
  $('#toast').textContent = s;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3600);
}

function sparkline(vals, color, h = 36) {
  const clean = (vals || []).filter(Number.isFinite);
  if (clean.length < 2) return '<div class="micro">—</div>';
  const W = 180, pad = 3;
  let lo = Math.min(...clean), hi = Math.max(...clean);
  if (hi === lo) { lo -= 1; hi += 1; }
  const x = i => (i / (clean.length - 1)) * W;
  const y = v => pad + (hi - v) / (hi - lo) * (h - pad * 2);
  const d = clean.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const lastX = x(clean.length - 1).toFixed(1), lastY = y(clean.at(-1)).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${lastX}" cy="${lastY}" r="3" fill="${color}"/></svg>`;
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

function chart(target, series, { min = null, max = null, includeZero = true, refLine = null, unit = '', selection = null, windows = [], height = 245, labels = null } = {}) {
  const el = $(target);
  if (!el) return;
  const tc = themeColors();
  const width = Math.max(300, el.clientWidth || 560), W = width, H = height, l = 52, r = 14, t = 23, b = 30, n = series[0]?.values.length || 0;
  if (!n) { el.innerHTML = '<p class="chart-empty">没有同口径的有效序列；未以情景数据代替。</p>'; return; }
  const values = series.flatMap(s => s.values).filter(Number.isFinite);
  if (refLine !== null && Number.isFinite(refLine)) values.push(refLine);
  if (!values.length) { el.innerHTML = '<p class="chart-empty">当前分项暂无有效观测。</p>'; return; }
  let lo = min ?? (includeZero ? Math.min(0, ...values) : Math.min(...values));
  let hi = max ?? (includeZero ? Math.max(0, ...values) : Math.max(...values));
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * (includeZero ? .08 : .16);
  if (min === null) lo = (!includeZero && Math.min(...values) >= 0) ? Math.max(0, lo - pad) : lo - pad;
  if (max === null) hi += (hi - lo) * .10;
  const x = i => l + i * (W - l - r) / Math.max(1, n - 1), y = v => t + (hi - v) * (H - t - b) / (hi - lo);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(x => x.name).join('、') + '；' + unit)}"><text x="${l}" y="12" font-size="10" fill="${tc.axis}">${esc(unit)}</text>`;
  for (const win of windows) {
    const a = win.start, z = win.end ?? n - 1;
    s += `<rect x="${x(a)}" y="${t}" width="${Math.max(1, x(z) - x(a))}" height="${H - t - b}" fill="${tc.winFill}" opacity=".09"/>`;
  }
  for (let i = 0; i < 5; i++) {
    const v = lo + (hi - lo) * i / 4;
    s += `<line x1="${l}" y1="${y(v)}" x2="${W - r}" y2="${y(v)}" stroke="${tc.grid}" stroke-dasharray="2 4"/><text x="${l - 8}" y="${y(v) + 3}" text-anchor="end" font-family="monospace" font-size="9.5" fill="${tc.axis}">${fmt(v, Math.abs(hi - lo) > 25 ? 0 : 1)}</text>`;
  }
  if (lo < 0 && hi > 0) s += `<line x1="${l}" y1="${y(0)}" x2="${W - r}" y2="${y(0)}" stroke="${tc.zero}" stroke-width="1"/>`;
  if (refLine !== null && refLine >= lo && refLine <= hi) {
    s += `<line x1="${l}" y1="${y(refLine)}" x2="${W - r}" y2="${y(refLine)}" stroke="${tc.amber}" stroke-width="1.4" stroke-dasharray="5 4"/>`;
  }
  const stride = Math.max(1, Math.ceil((n - 1) / (W < 420 ? 4 : 6)));
  for (let i = 0; i < n; i++) if (i % stride === 0 || i === n - 1) {
    s += `<text x="${x(i)}" y="${H - 7}" text-anchor="middle" font-size="9.5" fill="${tc.axis}" font-family="monospace">${esc(labels ? labels[i] : '+' + i + '月')}</text>`;
  }
  if (selection !== null) s += `<line x1="${x(selection)}" y1="${t}" x2="${x(selection)}" y2="${H - b}" stroke="${tc.zero}" stroke-dasharray="3 4"/>`;
  for (const line of series) {
    let path = '', valid = false;
    line.values.forEach((v, i) => {
      if (!Number.isFinite(v)) { valid = false; return; }
      path += (valid ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2) + ' ';
      valid = true;
    });
    s += `<path d="${path}" fill="none" stroke="${line.color}" stroke-width="${line.width || 2.2}" stroke-linejoin="round" stroke-linecap="round" ${line.dash ? 'stroke-dasharray="4 4"' : ''}/>`;
    const showDots = n <= 40;
    line.values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      if (!showDots && i !== n - 1 && i !== selection) return;
      s += `<circle cx="${x(i)}" cy="${y(v)}" r="${i === selection ? 4.2 : 2.3}" fill="${line.color}" opacity="${i === selection || i === n - 1 ? 1 : .68}"><title>${esc(line.name)} · ${esc(labels ? labels[i] : '第 ' + i + ' 月')}：${fmt(v, 3)} ${esc(unit)}</title></circle>`;
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
  if (r.NUSD < -1e-7 && r.NC > 1e-7 && r.J > 1e-7) return '实质出池 · 双边向中';
  if (r.NUSD < -1e-7 && r.NC > 1e-7) return '现金出池 · 间接向中';
  if (r.J < -1e-7 && r.NU > 1e-7) return '向美国证券配置';
  if (r.NUSD > 1e-7 && r.NC < -1e-7) return '广义美元净吸纳';
  return '多边再平衡 / 停顿';
}

/* ==================== Overview & Briefing Synthesis ==================== */
function getMetric(sourceKey, id) {
  return obs?.sources?.[sourceKey]?.metrics?.find(m => m.id === id) || null;
}

function buildDailySpreadSeries() {
  const usH = obs?.sources?.us_treasury_yield?.history || [];
  const cnH = obs?.sources?.cn_gov_yield?.history || [];
  if (!usH.length || !cnH.length) return [];
  const allDates = [...new Set([...usH.map(x => x.period), ...cnH.map(x => x.period)])].sort();
  let lastUs = null, lastCn = null;
  const usMap = new Map(usH.map(x => [x.period, x.y10]));
  const cnMap = new Map(cnH.map(x => [x.period, x.y10]));
  const out = [];
  for (const d of allDates) {
    if (usMap.has(d)) lastUs = usMap.get(d);
    if (cnMap.has(d)) lastCn = cnMap.get(d);
    if (Number.isFinite(lastUs) && Number.isFinite(lastCn)) {
      out.push({ period: d, us10: lastUs, cn10: lastCn, spreadBp: (lastCn - lastUs) * 100 });
    }
  }
  return out.slice(-60);
}

function getPresetSummaries() {
  if (presetCache) return presetCache;
  presetCache = Object.entries(PRESETS).map(([key, spec]) => {
    const p = config(key);
    const rs = simulate(p);
    const e = events(rs, p.confirm);
    const rEnd = rs.at(-1);
    const cnShare0 = (rs[0].w[2] + rs[0].w[3]) * 100;
    const cnShareEnd = (rEnd.w[2] + rEnd.w[3]) * 100;
    const usdShareEnd = (rEnd.w[0] + rEnd.w[1] + rEnd.w[6]) * 100;
    const p1 = classifyPhase(rs[1]), pEnd = classifyPhase(rEnd);
    const phaseArc = key === 'cash' ? `${p1} → 远期缓释` : pEnd;
    return { key, label: spec.label, brief: spec.brief, e, cnShare0, cnShareEnd, usdShareEnd, phase1: p1, phaseEnd: pEnd, phaseArc };
  });
  return presetCache;
}

function evaluateChecklist() {
  const us10 = getMetric('us_treasury_yield', 'us_10y')?.value;
  const cn10 = getMetric('cn_gov_yield', 'cn_10y')?.value;
  const spreadBp = (Number.isFinite(us10) && Number.isFinite(cn10)) ? (cn10 - us10) * 100 : null;
  const sofr = getMetric('nyfed_sofr', 'sofr')?.value;
  const fxH = obs?.sources?.ecb_fx?.history || [];
  const cnyNow = getMetric('ecb_fx', 'usd_cny')?.value;
  const cny60dAgo = fxH[0]?.usd_cny;
  const cnyApprecPct = (Number.isFinite(cnyNow) && Number.isFinite(cny60dAgo)) ? ((cny60dAgo - cnyNow) / cny60dAgo) * 100 : null;
  const dxy = getMetric('ecb_fx', 'usd_index')?.value;

  const holdH = obs?.sources?.tic_holdings?.history || [];
  const holdFirst = holdH[0], holdLast = holdH.at(-1);
  const cnHoldDelta12m = (holdFirst && holdLast) ? holdLast.cn - holdFirst.cn : null;
  const offDelta1m = holdH.length >= 2 && Number.isFinite(holdLast?.official) ? holdLast.official - holdH.at(-2).official : null;

  const worldTx = regionData('world').at(-1);
  const usDate = obs?.sources?.us_treasury_yield?.period || '—';
  const cnDate = obs?.sources?.cn_gov_yield?.period || '—';
  const sofrDate = obs?.sources?.nyfed_sofr?.period || '—';
  const fxDate = obs?.sources?.ecb_fx?.period || '—';
  const ticDate = obs?.sources?.tic_transactions?.period || '—';

  const items = [
    {
      name: '① 中美长端利差收窄',
      why: '利差倒挂过深时，机构换回人民币债券面临显著票息损失',
      reading: Number.isFinite(spreadBp) ? `${sgn(spreadBp, 1)} bp` : '—',
      sub: `中债 ${fmt(cn10, 2)}% (${cnDate}) vs 美债 ${fmt(us10, 2)}% (${usDate})`,
      target: '经验松动线：收窄至 -200 bp 以内',
      detail: Number.isFinite(spreadBp) ? (spreadBp >= -200 ? '已进入利差松动区间' : `距 -200 bp 观察线仍差 ${fmt(Math.abs(spreadBp + 200), 0)} bp`) : '待读取',
      state: !Number.isFinite(spreadBp) ? 'watch' : spreadBp >= -200 ? 'ok' : spreadBp >= -280 ? 'watch' : 'bad'
    },
    {
      name: '② 美元现金高息锚回落',
      why: '隔夜美元现金利率过高时，卖出美股的资金也会停在货币基金里不出池',
      reading: Number.isFinite(sofr) ? `${fmt(sofr, 2)}%` : '—',
      sub: `纽约联储 SOFR · ${sofrDate}`,
      target: '经验松动线：降至 3.00% 以下',
      detail: Number.isFinite(sofr) ? (sofr <= 3.0 ? '现金套息吸引力已显著消退' : sofr <= 4.1 ? '已较 5%+ 峰值回落，但仍高于中债收益率' : '高息现金虹吸强劲') : '待读取',
      state: !Number.isFinite(sofr) ? 'watch' : sofr <= 3.0 ? 'ok' : sofr <= 4.1 ? 'watch' : 'bad'
    },
    {
      name: '③ 人民币汇率定力与企稳',
      why: '汇率企稳升值可对冲名义利差劣势，消除跨境换仓的汇兑顾虑',
      reading: Number.isFinite(cnyNow) ? `${fmt(cnyNow, 4)}` : '—',
      sub: `欧央行参考价 · ${fxDate}${Number.isFinite(cnyApprecPct) ? `（近90日人民币 ${sgn(cnyApprecPct, 2)}%）` : ''}`,
      target: '经验松动线：稳于 7.00 内且近季不走弱',
      detail: Number.isFinite(cnyNow) ? (cnyNow < 7.0 && (cnyApprecPct ?? 0) >= -0.5 ? `汇率稳于 7.0 内，美元六币指数 ${fmt(dxy, 1)}` : '关注汇率波动对冲成本') : '待读取',
      state: !Number.isFinite(cnyNow) ? 'watch' : (cnyNow < 7.0 && (cnyApprecPct ?? 0) >= -0.5) ? 'ok' : cnyNow < 7.15 ? 'watch' : 'bad'
    },
    {
      name: '④ 官方主权储备先行降敞口',
      why: '历史周期中，官方储备与长线机构通常先于私人套息盘调整美元久期',
      reading: Number.isFinite(cnHoldDelta12m) ? `${sgn(cnHoldDelta12m, 0)} 亿美元` : '—',
      sub: `内地托管美债年变动 · 最新存量 ${fmt(holdLast?.cn, 0)} 亿 (${holdLast?.period || '—'})`,
      target: '观察标尺：官方与内地托管存量趋势性压降',
      detail: Number.isFinite(offDelta1m) ? `最新单月外国官方美债存量 ${sgn(offDelta1m, 0)} 亿美元` : '存量含价格重估与转托管',
      state: !Number.isFinite(cnHoldDelta12m) ? 'watch' : cnHoldDelta12m < -200 ? 'ok' : cnHoldDelta12m < 0 ? 'watch' : 'bad'
    },
    {
      name: '⑤ 全球私人买盘对美净流入降温',
      why: '只有私人套息盘不再大举净买入美股美债，广义美元池才会出现净释放',
      reading: worldTx ? `${sgn(worldTx.total, 0)} 亿美元/月` : '—',
      sub: `TIC 表 1 全球外资净买卖 · ${ticDate}`,
      target: '观察标尺：月净买入降至 +500 亿内或转净卖出',
      detail: worldTx ? `当月净买美股 ${sgn(worldTx.equity, 0)} 亿、美债 ${sgn(worldTx.bond, 0)} 亿` : '待读取',
      state: !worldTx ? 'watch' : worldTx.total <= 0 ? 'ok' : worldTx.total <= 500 ? 'watch' : 'bad'
    }
  ];

  const okCount = items.filter(x => x.state === 'ok').length;
  const watchCount = items.filter(x => x.state === 'watch').length;
  const badCount = items.filter(x => x.state === 'bad').length;
  return { items, okCount, watchCount, badCount, spreadBp, us10, cn10, sofr, cnyNow, dxy, worldTx, holdFirst, holdLast };
}

function renderOverviewAndBrief() {
  if (!obs) return;
  const tc = themeColors();
  const ck = evaluateChecklist();
  const worldHist = regionData('world');
  const worldLast = worldHist.at(-1), worldPrev = worldHist.at(-2);
  const cnLast = regionData('cn').at(-1), hkLast = regionData('hk').at(-1);
  const spreadSeries = buildDailySpreadSeries();
  const spreadPrev20 = spreadSeries.length > 20 ? spreadSeries.at(-21).spreadBp : spreadSeries[0]?.spreadBp;
  const spreadDelta20 = (Number.isFinite(ck.spreadBp) && Number.isFinite(spreadPrev20)) ? ck.spreadBp - spreadPrev20 : null;

  const vix = getMetric('cboe_vix', 'vix')?.value;
  const vixHist = (obs.sources.cboe_vix?.history || []).map(x => x.vix);
  const holdH = obs.sources.tic_holdings?.history || [];
  const holdLast = holdH.at(-1), holdPrev = holdH.at(-2);
  const dOff1m = (holdLast && holdPrev && Number.isFinite(holdLast.official)) ? holdLast.official - holdPrev.official : null;
  const dPriv1m = (holdLast && holdPrev && Number.isFinite(holdLast.private)) ? holdLast.private - holdPrev.private : null;

  // Regime banner & top pill
  const regimeLabel = ck.okCount >= 4
    ? '条件基本齐备 · 关注实质出池窗口'
    : (ck.worldTx?.total > 500 && (ck.spreadBp ?? -300) < -200)
      ? `高息套息锁定 · 逆转条件已现 ${ck.okCount}/5 项`
      : `拉锯过渡期 · 逆转条件已现 ${ck.okCount}/5 项`;
  $('#regime-text').textContent = regimeLabel;

  const dailyDate = obs.sources.us_treasury_yield?.period || obs.sources.ecb_fx?.period || '—';
  const ticDate = obs.sources.tic_transactions?.period || '—';
  $('#hero-dates').textContent = `日频市场截至 ${dailyDate} · 官方跨境交割截至 ${ticDate}`;
  $('#hero-title').textContent = `外资整体仍在净买入美股美债（${sgn(worldLast?.total, 0)} 亿美元/月），但“官方降敞口、私人追高息”明显分化；全面转向仍卡在 ${fmt(Math.abs(ck.spreadBp ?? 0), 0)} bp 利差倒挂。`;
  $('#hero-desc').textContent = `日频端：10Y 美债 ${fmt(ck.us10, 2)}%、中债 ${fmt(ck.cn10, 2)}%、隔夜美元现金 SOFR ${fmt(ck.sofr, 2)}%，高息套息锚仍在吸引私人资金留存美元池；结构端：人民币稳于 ${fmt(ck.cnyNow, 4)}，外国官方储备与内地托管美债存量已率先温和压降。`;

  $('#hero-side').innerHTML = [
    ['当前所处阶段', '美元高息虹吸 · 主体分化'],
    ['逆转五条件进度', `${ck.okCount} 项已具备 · ${ck.watchCount} 项半松动 · ${ck.badCount} 项未达`],
    ['中美 10Y 利差', `${sgn(ck.spreadBp, 1)} bp`],
    ['美元隔夜现金 SOFR', `${fmt(ck.sofr, 2)}%`],
    ['外资对美月净买', `${sgn(worldLast?.total, 1)} 亿美元`]
  ].map(([k, v]) => `<div class="hero-kv"><span>${k}</span><b>${esc(v)}</b></div>`).join('');

  // Section 1: Big 4 Cards
  const dTx = (worldLast && worldPrev) ? worldLast.total - worldPrev.total : null;
  $('#overview-cards').innerHTML = [
    {
      title: '跨境吸金总量（流量实测）',
      badge: `TIC 月报 · ${ticDate}`,
      num: sgn(worldLast?.total, 0),
      unit: '亿美元/月',
      color: tc.blue,
      sub: `美股 ${sgn(worldLast?.equity, 0)} 亿 · 美债 ${sgn(worldLast?.bond, 0)} 亿${Number.isFinite(dTx) ? `（较上月 ${sgn(dTx, 0)} 亿）` : ''}`,
      spark: sparkline(worldHist.slice(-24).map(x => x.total), tc.blue),
      verdict: '全球外国居民当月仍在净买入美国长期证券，尚未出现总量层面的集中撤出。'
    },
    {
      title: '中美 10Y 利差（流向核心阻力）',
      badge: `官方日频 · ${dailyDate}`,
      num: sgn(ck.spreadBp, 1),
      unit: 'bp',
      color: tc.red,
      sub: `中债 ${fmt(ck.cn10, 2)}% − 美债 ${fmt(ck.us10, 2)}%${Number.isFinite(spreadDelta20) ? `（近20交易日 ${sgn(spreadDelta20, 1)} bp）` : ''}`,
      spark: sparkline(spreadSeries.map(x => x.spreadBp), tc.red),
      verdict: '美债 5%+ 与美元隔夜现金 3.90% 构成套息高墙，是当前阻碍私人资金回流的头号阻力。'
    },
    {
      title: '换仓强度与市场恐慌度',
      badge: `月度代理 + VIX 日频`,
      num: sgn(worldLast?.intensity, 2) + '%',
      unit: '占持仓/月',
      color: tc.cyan,
      sub: `VIX 波动率 ${fmt(vix, 2)} 点 · 美元六币指数 ${fmt(ck.dxy, 2)}`,
      spark: sparkline(worldHist.slice(-24).map(x => x.intensity), tc.cyan),
      verdict: `VIX 处于 ${vix < 22 ? '常态区间（未触发流动性恐慌挤兑）' : '偏高区间'}，当前资金流向主要由利差驱动。`
    },
    {
      title: '主体分化：官方储备 vs 私人盘',
      badge: `TIC 表 5 · ${holdLast?.period || '—'}`,
      num: `${sgn(dOff1m, 0)} / ${sgn(dPriv1m, 0)}`,
      unit: '亿美元(单月存量变动)',
      color: tc.purple,
      sub: `内地托管存量 ${fmt(holdLast?.cn, 0)} 亿（年同比 ${sgn(holdLast && ck.holdFirst ? holdLast.cn - ck.holdFirst.cn : null, 0)} 亿）`,
      spark: sparkline(holdH.map(x => x.official && x.world ? (x.official / x.world) * 100 : null), tc.purple),
      verdict: '总量平稳背后：外国官方储备占比在下降，新增美债买盘主要来自追逐高息的私人与托管资金。'
    }
  ].map(c => `<article class="big-card" style="--c:${c.color}"><div class="big-card-top"><span>${c.title}</span><span class="big-card-badge">${esc(c.badge)}</span></div><div class="big-num">${c.num}<small>${c.unit}</small></div><div class="big-sub">${c.sub}</div><div class="spark-wrap">${c.spark}</div><div class="big-verdict">${c.verdict}</div></article>`).join('');

  // Section 2: 5-Condition Checklist
  const okPct = (ck.okCount / 5) * 100, watchPct = (ck.watchCount / 5) * 100, badPct = (ck.badCount / 5) * 100;
  $('#checklist-summary').innerHTML = `
    <div class="progress-box">
      <b>已满足 ${ck.okCount} / 5 项 · 半松动 ${ck.watchCount} 项</b>
      <div class="progress-track">
        <span style="width:${okPct}%;background:${tc.cyan}"></span>
        <span style="width:${watchPct}%;background:${tc.amber}"></span>
        <span style="width:${badPct}%;background:${tc.red}"></span>
      </div>
      <div class="progress-legend">
        <span>🟢 已具备 ${ck.okCount}</span>
        <span>🟡 半松动 ${ck.watchCount}</span>
        <span>🔴 未达标 ${ck.badCount}</span>
      </div>
    </div>
    <div class="bottleneck-box">
      <strong>一句话看懂当前卡在哪：</strong>人民币汇率定力（${fmt(ck.cnyNow, 4)}）与官方储备降久期已经先行到位；但<strong>中美 10Y 利差仍倒挂 ${fmt(Math.abs(ck.spreadBp ?? 0), 1)} bp</strong>、隔夜美元现金仍有 <strong>${fmt(ck.sofr, 2)}%</strong> 无风险套息，导致全球私人资金仍在顺差买入美元证券。只有看到「美债收益率/SOFR 下台阶」与「TIC 私人净买降温」共振，才会打开大规模实质回流窗口。
    </div>`;

  const stateTag = s => s === 'ok'
    ? '<span class="tag tag-ok">🟢 已具备</span>'
    : s === 'watch'
      ? '<span class="tag tag-warn">🟡 半松动 / 观察</span>'
      : '<span class="tag tag-bad">🔴 未达标（卡点）</span>';
  const briefTag = s => s === 'ok'
    ? '<span class="tag tag-ok">🟢 已具备</span>'
    : s === 'watch'
      ? '<span class="tag tag-warn">🟡 半松动</span>'
      : '<span class="tag tag-bad">🔴 未达标</span>';

  $('#checklist-rows').innerHTML = ck.items.map(it => `
    <div class="check-row">
      <div>${stateTag(it.state)}</div>
      <div class="check-title"><b>${esc(it.name)}</b><small>${esc(it.why)}</small></div>
      <div class="check-reading"><b>${esc(it.reading)}</b><small>${esc(it.sub)}</small></div>
      <div class="check-target">${esc(it.target)}<small>${esc(it.detail)}</small></div>
    </div>`).join('');

  // Section 3: 6 Daily Market Thermometer Cards + Spread Chart + Pool Bars
  const usH = obs.sources.us_treasury_yield?.history || [];
  const cnH = obs.sources.cn_gov_yield?.history || [];
  const sofrH = obs.sources.nyfed_sofr?.history || [];
  const fxH = obs.sources.ecb_fx?.history || [];
  const us2y = getMetric('us_treasury_yield', 'us_2y')?.value;
  const cn1y = getMetric('cn_gov_yield', 'cn_1y')?.value;

  const miniSpecs = [
    ['10Y 美债收益率', fmt(ck.us10, 2), '%', `2Y ${fmt(us2y, 2)}%`, obs.sources.us_treasury_yield?.period, usH.map(x => x.y10), tc.blue],
    ['10Y 中债收益率', fmt(ck.cn10, 2), '%', `1Y ${fmt(cn1y, 2)}%`, obs.sources.cn_gov_yield?.period, cnH.map(x => x.y10), tc.cyan],
    ['中美 10Y 利差', sgn(ck.spreadBp, 0), 'bp', '中债减美债', spreadSeries.at(-1)?.period, spreadSeries.map(x => x.spreadBp), tc.red],
    ['美元隔夜 SOFR', fmt(ck.sofr, 2), '%', '现金套息锚', obs.sources.nyfed_sofr?.period, sofrH.map(x => x.sofr), tc.amber],
    ['美元 / 人民币', fmt(ck.cnyNow, 4), '', `港币 ${fmt(getMetric('ecb_fx', 'usd_hkd')?.value, 4)}`, obs.sources.ecb_fx?.period, fxH.map(x => x.usd_cny), tc.cyan],
    ['VIX 恐慌 / 美元指数', fmt(vix, 2), '点', `美元指数 ${fmt(ck.dxy, 1)}`, obs.sources.cboe_vix?.period, vixHist, tc.purple]
  ];
  $('#market-cards').innerHTML = miniSpecs.map(([name, val, unit, sub, pd, arr, col]) =>
    `<div class="mini-card"><span>${esc(name)}</span><b>${val}<small>${esc(unit)}</small></b><div class="mini-spark">${sparkline(arr, col, 28)}</div><div class="mini-meta"><span>${esc(sub)}</span><span>${esc((pd || '').slice(5))}</span></div></div>`
  ).join('');

  if (spreadSeries.length) {
    $('#spread-badge').textContent = `截至 ${spreadSeries.at(-1).period} · 近 ${spreadSeries.length} 交易日`;
    chart('#overview-spread-chart', [
      { name: '中美 10Y 国债名义利差（bp）', color: tc.red, values: spreadSeries.map(x => x.spreadBp) }
    ], {
      includeZero: false,
      refLine: -200,
      unit: '基点 (bp) · 虚线为 -200 bp 经验观察线',
      labels: spreadSeries.map(x => x.period.slice(5)),
      height: 215
    });
    $('#overview-spread-caption').innerHTML = `<span style="--c:${tc.red};margin-right:16px">中美 10Y 利差（最新 ${sgn(ck.spreadBp, 1)} bp）</span><span style="--c:${tc.amber}">-200 bp 利差阻力松动观察线</span>`;
  }

  const totalLtTrillion = (worldLast?.position ?? 0) / 10000; // 亿美元 -> 万亿美元
  const worldTreas = holdLast?.world ?? 0, offTreas = holdLast?.official ?? 0, privTreas = holdLast?.private ?? 0;
  const offPct = worldTreas > 0 ? (offTreas / worldTreas) * 100 : 0;
  const privPct = Math.max(0, 100 - offPct);
  const cnShare = worldTreas > 0 ? ((holdLast?.cn ?? 0) / worldTreas) * 100 : 0;
  const hkShare = worldTreas > 0 ? ((holdLast?.hk ?? 0) / worldTreas) * 100 : 0;

  $('#overview-pool-bars').innerHTML = `
    <div class="pool-item">
      <div class="pool-head"><span>外国投资者持有美国长期证券总盘子（${esc(worldLast?.period || '—')}）</span><b>${fmt(totalLtTrillion, 2)} 万亿美元</b></div>
      <div class="pool-bar"><span style="width:100%;background:linear-gradient(90deg,${tc.blue},${tc.cyan})"></span></div>
      <div class="pool-note">最新单月净买入 ${sgn(worldLast?.total, 1)} 亿美元，价格重估变动 ${sgn(worldLast?.valuation, 1)} 亿美元（存量涨跌大头来自市值重估而非净买）。</div>
    </div>
    <div class="pool-item">
      <div class="pool-head"><span>外资持有美国国债主体拆分（合计 ${fmt(worldTreas / 10000, 2)} 万亿美元）</span><b>官方 ${fmt(offPct, 1)}% · 私人 ${fmt(privPct, 1)}%</b></div>
      <div class="pool-bar">
        <span style="width:${offPct}%;background:${tc.cyan}" title="外国官方储备"></span>
        <span style="width:${privPct}%;background:${tc.amber}" title="外国私人与托管部门"></span>
      </div>
      <div class="pool-note">🟢 外国官方机构 ${fmt(offTreas, 0)} 亿美元（单月 ${sgn(dOff1m, 0)} 亿） ｜ 🟠 外国私人部门 ${fmt(privTreas, 0)} 亿美元（单月 ${sgn(dPriv1m, 0)} 亿）。</div>
    </div>
    <div class="pool-item" style="margin-bottom:0">
      <div class="pool-head"><span>中国内地与香港名义托管美债对照</span><b>内地 ${fmt(holdLast?.cn, 0)} 亿 · 香港 ${fmt(holdLast?.hk, 0)} 亿</b></div>
      <div class="pool-bar">
        <span style="width:${cnShare}%;background:${tc.cyan}"></span>
        <span style="width:${hkShare}%;background:${tc.blue}"></span>
      </div>
      <div class="pool-note">合计占外资美债总盘 ${fmt(cnShare + hkShare, 1)}%；内地当月对美长期证券净交易 ${sgn(cnLast?.total, 1)} 亿，香港 ${sgn(hkLast?.total, 1)} 亿美元。</div>
    </div>`;

  // Section 4: 4 Scenario Plain-Language Cards
  const presets = getPresetSummaries();
  const fmtM = m => m === null ? '36个月内不触发' : m === 0 ? '起点即满足' : `约第 ${m} 个月`;
  $('#overview-scenarios').innerHTML = presets.map(s => `
    <article class="scen-card">
      <div>
        <span class="badge">${esc(s.phaseArc)}</span>
        <h3>${esc(s.label)}</h3>
        <p>${esc(s.brief)}</p>
      </div>
      <div class="scen-kpis">
        <div><span>初期阶段特征</span><b>${esc(s.phase1)}</b></div>
        <div><span>广义美元池转净流出</span><b>${fmtM(s.e.broadConfirm)}</b></div>
        <div><span>中美直连持续回流</span><b>${fmtM(s.e.confirm)}</b></div>
        <div><span>36月后中资池占比</span><b>${fmt(s.cnShare0, 0)}% → ${fmt(s.cnShareEnd, 1)}%</b></div>
      </div>
      <button class="scen-jump" data-jump-preset="${s.key}">在工作台中打开并细调 →</button>
    </article>`).join('');

  $$('[data-jump-preset]').forEach(btn => btn.addEventListener('click', () => {
    stop();
    state.preset = btn.dataset.jumpPreset;
    state.p = config(state.preset);
    state.month = 1;
    recompute();
    location.hash = 'model';
  }));

  // Render Page 2: Executive Briefing (#brief-content)
  $('#brief-content').innerHTML = `
    <article class="brief-card">
      <h2><span class="sec-num">1</span> 当期定论与核心实测读数</h2>
      <p style="font-size:13px;color:var(--text-2);line-height:1.65">截至日频 <b>${esc(dailyDate)}</b> 与跨境月报 <b>${esc(ticDate)}</b>：全球资金对美长期证券仍处<b>高息套息净流入期</b>，尚未进入全面撤离；但主权官方储备与私人套息盘呈反向分化。</p>
      <div class="brief-kpis">
        <div class="brief-kpi"><span>外资对美月净买</span><b style="color:${tc.blue}">${sgn(worldLast?.total, 0)} 亿</b><small>TIC 表1 (${esc(ticDate)})</small></div>
        <div class="brief-kpi"><span>中美 10Y 利差</span><b style="color:${tc.red}">${sgn(ck.spreadBp, 0)} bp</b><small>中 ${fmt(ck.cn10, 2)}% / 美 ${fmt(ck.us10, 2)}%</small></div>
        <div class="brief-kpi"><span>美元隔夜 SOFR</span><b style="color:${tc.amber}">${fmt(ck.sofr, 2)}%</b><small>汇率 ${fmt(ck.cnyNow, 4)} · VIX ${fmt(vix, 1)}</small></div>
      </div>
      <p class="micro">核心辨析：美股/美债波动时，若美元隔夜现金利率仍高达 ~4%，卖盘首先退入美元货币市场（留存美元池），不会自动变成新兴市场净流入。</p>
    </article>

    <article class="brief-card">
      <h2><span class="sec-num">2</span> 逆转五项条件进度表（${ck.okCount}/5 已具备）</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>条件项</th><th>最新实测</th><th>参考观察线</th><th>判定</th></tr></thead>
          <tbody>
            ${ck.items.map(it => `<tr><td>${esc(it.name)}</td><td>${esc(it.reading)}</td><td>${esc(it.target.replace('经验松动线：', '').replace('观察标尺：', ''))}</td><td>${briefTag(it.state)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </article>

    <article class="brief-card">
      <h2><span class="sec-num">3</span> 存量真相：官方降久期 vs 私人追高息</h2>
      <div class="driver"><span>外资持有美国长期证券总规模</span><b>${fmt(totalLtTrillion, 2)} 万亿美元</b></div>
      <div class="driver"><span>其中：外国官方机构持有美债（${fmt(offPct, 1)}%）</span><b>${fmt(offTreas, 0)} 亿美元（单月 ${sgn(dOff1m, 0)} 亿）</b></div>
      <div class="driver"><span>其中：外国私人部门持有美债（${fmt(privPct, 1)}%）</span><b>${fmt(privTreas, 0)} 亿美元（单月 ${sgn(dPriv1m, 0)} 亿）</b></div>
      <div class="driver"><span>中国内地 / 香港名义托管美债存量</span><b>${fmt(holdLast?.cn, 0)} 亿 / ${fmt(holdLast?.hk, 0)} 亿美元</b></div>
      <div class="driver"><span>内地 / 香港当月对美长期证券净买卖</span><b>${sgn(cnLast?.total, 1)} 亿 / ${sgn(hkLast?.total, 1)} 亿美元</b></div>
      <p class="micro" style="margin-top:8px">口径提示：月末存量变动同时包含净买卖、美债价格涨跌重估与离岸转托管，不可将存量增减直接等同于资金净进出。</p>
    </article>

    <article class="brief-card">
      <h2><span class="sec-num">4</span> 四种未来条件推演一表速查</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>假设情景</th><th>初期冲击表现</th><th>广义美元出池</th><th>中美直连持续回流</th></tr></thead>
          <tbody>
            ${presets.map(s => `<tr><td><b>${esc(s.label)}</b></td><td>${esc(s.phase1)}</td><td>${fmtM(s.e.broadConfirm)}</td><td>${fmtM(s.e.confirm)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="micro" style="margin-top:10px">由七资产二阶守恒耦合模型同源算出（初值 100 指数点，36 个月窗口）；点击顶部「03 模型工作台」可任意调整利差、汇率与摩擦参数复算。</p>
    </article>`;
}

$('#print-brief')?.addEventListener('click', () => window.print());

/* ==================== Interactive Simulator (#page-model) ==================== */
function scheduleSensitivity() {
  clearTimeout(sensTimer);
  if (state.page !== 'model') return;
  $('#sensitivity').textContent = '正在计算 27 组条件扰动…';
  sensTimer = setTimeout(() => { sens = sensitivity(state.p); renderSensitivity(); }, 60);
}

function recompute() {
  sens = null;
  rows = simulate(state.p);
  ev = events(rows, state.p.confirm);
  syncControls();
  if (state.page === 'model') renderModel();
  renderParams();
  scheduleSensitivity();
}

function renderModel() {
  if (!rows.length) return;
  const tc = themeColors();
  const r = rows[state.month], p = state.p, m = state.month;
  const phase = classifyPhase(r);
  $('#metrics').innerHTML =
    metric('跨资产换仓总流量', 'L', fmt(r.L), '指数点/月', `主动调仓 ${fmt(r.Lvol)} · 被迫换现 ${fmt(r.forced)}`, tc.cyan) +
    metric('中美证券直接净流', 'J', sgn(r.J), '指数点/月', `中资总净流 NC ${sgn(r.NC)} · 经现金/第三地中转 ${sgn(r.Jindirect)}`, tc.blue) +
    metric('当月资金换仓流速', 'v', fmt(r.v * 100), '%/月', `主动 ${fmt(r.vVol * 100, 1)}% · 强售 ${fmt(r.vForced * 100, 1)}%`, tc.amber) +
    metric('当月流向机制定性', 'STATE', phase, '', `广义美元池净流 ${sgn(r.NUSD)} · 推演第 ${m} 月`, tc.purple, 'state');

  $('#month').max = p.months;
  $('#month').value = m;
  $('#month-label').textContent = `第 ${m} / ${p.months} 月`;
  $('#selected-badge').textContent = `推演 +${m} 月`;
  $$('[data-chart]').forEach(b => b.classList.toggle('active', b.dataset.chart === state.chart));

  let series, unit;
  if (state.chart === 'J') {
    series = [
      { name: '中美直接换仓净流 J', color: tc.cyan, values: rows.map(r => r.J) },
      { name: '中国资产总净流入 NC（含现金/枢纽中转）', color: tc.blue, values: rows.map(r => r.NC) },
      { name: '广义美元池净吸收 N_USD（美股债+美元现金）', color: tc.amber, dash: true, values: rows.map(r => r.NUSD) }
    ];
    unit = '资本指数点/月（正值流入该池）';
  } else if (state.chart === 'split') {
    series = [
      { name: '股票直连 J_e', color: tc.cyan, values: rows.map(r => r.Je) },
      { name: '债券直连 J_b', color: tc.blue, values: rows.map(r => r.Jb) },
      { name: '跨类直连 J_cross', color: tc.purple, dash: true, values: rows.map(r => r.Jcross) },
      { name: '黄金+第三地净吸收', color: tc.amber, dash: true, values: rows.map(r => r.Nalt) }
    ];
    unit = '资本指数点/月';
  } else if (state.chart === 'L') {
    series = [
      { name: '总换仓流量 L', color: tc.blue, values: rows.map(r => r.L) },
      { name: '主动边际配置 L_vol', color: tc.cyan, values: rows.map(r => r.Lvol) },
      { name: '优先强制换现金 L_forced', color: tc.amber, dash: true, values: rows.map(r => r.forced) }
    ];
    unit = '资本指数点/月';
  } else {
    series = [
      { name: '总换仓流速 v', color: tc.amber, values: rows.map(r => r.v * 100) },
      { name: '主动调仓流速 v_vol（受流动性 H 约束）', color: tc.cyan, values: rows.map(r => r.vVol * 100) },
      { name: '被迫变现流速 v_forced（受现金缺口驱动）', color: tc.red, dash: true, values: rows.map(r => r.vForced * 100) }
    ];
    unit = '%/月';
  }

  chart('#main-chart', series, { unit, selection: m, windows: ev.windows, height: 260 });
  $('#main-legend').innerHTML = series.map(s => `<span style="--c:${s.color};margin-right:18px">${esc(s.name)}</span>`).join('');
  chart('#state-chart', [
    { name: 'H 通道流动性', color: tc.cyan, values: rows.map(r => r.H) },
    { name: 'P 融资压力（含外流反哺）', color: tc.amber, values: rows.map(r => r.P) },
    { name: 'R 政策宽松响应', color: tc.purple, values: rows.map(r => r.R) }
  ], { min: 0, max: 1, unit: '0 ~ 1 状态指数', height: 190, selection: m });

  $('#allocation').innerHTML =
    '<div class="allocation-bar">' + r.w.map((v, i) => `<span style="width:${v * 100}%;background:${COLORS[i]}"></span>`).join('') + '</div>' +
    ASSETS.map((a, i) => `<div class="allocation-row"><span><i style="--c:${COLORS[i]}"></i>${a}</span><span class="amount">${fmt(r.w[i] * 100, 1)}% <small class="${r.net[i] >= 0 ? 'positive' : 'negative'}">${sgn(r.net[i], 2)}</small></span></div>`).join('') +
    `<p class="micro">括号旁为当月净增减（点/月）· 当前池规模 ${fmt(r.W, 2)} 点 · 累计交易摩擦 ${fmt(r.cumCost, 3)} 点</p>`;

  const time = x => x === null ? '未触发' : x === 0 ? '起点已满足' : `第 ${x} 月`;
  $('#events').innerHTML = [
    ['01 / 边际吸引力转正', time(ev.anyTrigger), `股 ${time(ev.equityTrigger)} · 债 ${time(ev.bondTrigger)} · 现金池 ${time(ev.cashTrigger)}`, tc.cyan],
    ['02 / 中美直连由负转正', ev.initialPositive ? '起点已偏中' : time(ev.flip), '满足 T_S ≤ T_flip；J 跨过零轴', tc.blue],
    ['03 / 双边直连持续回流', time(ev.confirm), `连续 ${p.confirm} 月 J>0、NC>0 且美股债净出`, tc.purple],
    ['04 / 广义美元池净释放', time(ev.broadConfirm), `连续 ${p.confirm} 月中资净入且广义美元 N_USD<0`, tc.amber]
  ].map(([a, b, c, col]) => `<div class="event" style="--c:${col}"><small>${a}</small><b>${b}</b><p>${c}</p></div>`).join('');

  const directTxt = ev.windows.length
    ? ev.windows.map(w => `双边直连窗口：第 ${w.start} 月起，第 ${w.confirmed} 月确认，${w.censored ? `至第 ${p.months} 月仍持续` : `第 ${w.end} 月后结束`}。`).join(' ')
    : `在 ${p.months} 个月推演期内，未出现连续 ${p.confirm} 个月的直接双边“美股债出、中资股债入”。`;
  const broadTxt = ev.broadWindows.length
    ? `广义美元出池窗口：第 ${ev.broadWindows[0].start} 月起（第 ${ev.broadWindows[0].confirmed} 月确认），连同美元现金池一并向中国资产净再配置。`
    : '广义美元池（美股债＋美元现金）未形成持续向中国的净释放。';
  $('#window-detail').textContent = directTxt + ' ' + broadTxt;

  const edges = [];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i !== j && r.f[i][j] > 1e-5) edges.push({ i, j, value: r.f[i][j] });
  edges.sort((a, b) => b.value - a.value);
  $('#flow-edges').innerHTML = (edges.slice(0, 6).map(e => `<div class="edge"><span>${ASSETS[e.i]}<em>→</em>${ASSETS[e.j]}</span><strong>${fmt(e.value, 3)}</strong></div>`).join('') || '<p class="micro">本期没有达到显示量级的迁移。</p>') +
    `<div class="anchor-strip"><span>直连分项：股 <b>${sgn(r.Je, 2)}</b></span><span>债 <b>${sgn(r.Jb, 2)}</b></span><span>跨类 <b>${sgn(r.Jcross, 2)}</b></span><span>净位移效率 <b>${r.netEff !== null ? fmt(r.netEff * 100, 1) + '%' : '—'}</b></span></div>`;

  $('#flow-description').textContent = `主动配置 ${fmt(r.Lvol)}、被迫换现 ${fmt(r.forced)} 点/月；最低美元现金线 ${fmt(r.cashFloor * 100, 1)}%；当期摩擦 ${fmt(r.costDrag, 4)} 点。`;

  $('#driver-bars').innerHTML = [[0, 2, '股票', 'Se'], [1, 3, '债券', 'Sb']].map(([i, j, name, key]) => {
    const terms = [
      ['预期美元回报差', (r.mu[j] - r.mu[i]) * 10000],
      ['协方差与容量风险差', -(r.risk[j] - r.risk[i]) * 10000],
      ['退出折价差', -(r.chi[j] - r.chi[i]) * 10000],
      ['单次跨境准入成本', -p.costUC]
    ];
    return `<div class="driver total"><span>${name} · 扣成本边际净优势</span><b class="${r[key] > 0 ? 'positive' : 'negative'}">${sgn(r[key])} bp</b></div>` +
      terms.map(([n, v]) => `<div class="driver"><span>${n}</span><b>${sgn(v)} bp</b></div>`).join('');
  }).join('') +
  `<div class="anchor-strip"><span>美元现金年化锚 <b>${fmt(r.annual[6], 2)}%</b></span><span>黄金预期 <b>${fmt(r.annual[4], 2)}%</b></span><span>中资对美元现金优势 <b class="${r.ScashC > 0 ? 'positive' : 'negative'}">${sgn(r.ScashC, 1)} bp</b></span></div>`;
}

function renderSensitivity() {
  if (!sens) return;
  $('#sensitivity').innerHTML =
    `确定性参数扰动（27 组）：双边直连确认 <b>${sens.hit} / ${sens.n}</b> 组，广义美元出池确认 <b>${sens.broadHit} / ${sens.n}</b> 组，未触发双边直连 <b>${sens.miss}</b> 组。` +
    (sens.hit ? `触发组直连确认月份范围 <b>第 ${sens.early}—${sens.late} 月</b>。` : '') +
    '<br>扰动网格：远端股票回报差 ±1 pp、配置速率与跨境成本 ×0.7/1/1.3；触发组数代表参数稳健性而非现实发生概率。';
}

function renderParams() {
  const lookup = Object.fromEntries([...PARAMS, ...ADV].map(([k, label, , , , unit]) => [k, [label, unit]]));
  $('#parameter-table').innerHTML = Object.entries(state.p).map(([k, v]) =>
    `<tr><td>${esc(lookup[k]?.[0] || k)}</td><td>${fmt(v, 4)}</td><td>${esc(lookup[k]?.[1] || ({ months: '月 · 演算长度', step: '月 · RK2 步长' })[k] || '情景系数')}</td></tr>`
  ).join('');
  $('#fixed-params').textContent = JSON.stringify({
    site_version: '2.2.0',
    model_core: '2.1.0-coupled-rk2',
    integrator: '2nd-order positivity-preserving conservative Heun (RK2)',
    initial_capital_index: INITIAL,
    assets: ASSETS,
    factor_loadings_annual: FACTORS,
    idiosyncratic_volatility_annual: IDIO,
    covariance_monthly: COV,
    initial_states: { H: .72, P: .28, R: .08 },
    note: '全部为公开情景系数，未由真实资本流样本回归估计。'
  }, null, 2);
}

/* ==================== Partial Identification & Observed Page ==================== */
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
    box.innerHTML = `<span class="id-status neg">约束冲突 · 集合为空</span><div class="id-bounds">无可行双边网络</div><p>给定净流量超出了直连通道与第三地中转容量之和（|n_U + n_C| &gt; 2·capR 或单侧净额超通道总和），须放宽误差界 δ 或通道上限。</p>`;
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
    `<div class="id-bounds">J_UC ∈ [${sgn(res.minJ, 1)}, ${sgn(res.maxJ, 1)}] <small style="font-size:12px;color:var(--muted)">亿美元/月（区间宽 ${fmt(res.width, 1)}）</small></div>` +
    `<p>隐含第三地/现金池净吸收 n_R ≈ ${sgn(-(idState.nU + idState.nC), 1)} 亿美元/月。${res.status === 'unidentified_spans_zero' ? '由于离岸枢纽与现金池中转容量充足，同一组美中净额既可由正向直连生成，也可由反向绕道生成。' : '在当前通道上限与误差界下，绕道流量不足以翻转中美直接净迁移符号。'}</p>` +
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

function renderActiveCharts() {
  if (state.page === 'overview' && obs) renderOverviewAndBrief();
  if (state.page === 'brief' && obs) renderOverviewAndBrief();
  if (state.page === 'model') renderModel();
  if (state.page === 'observed' && obs) renderObserved();
}

function showPage() {
  const page = state.page;
  $$('.page').forEach(el => el.hidden = el.id !== 'page-' + page);
  $$('nav a').forEach(a => {
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const titles = {
    overview: '今日总览看板',
    brief: '一屏精简汇报',
    model: '模型推演工作台',
    observed: '真实资金账与识别',
    method: '原理与说明'
  };
  document.title = `${titles[page] || '今日看板'} · 中美资本三流看板 V2.2`;
  if (page !== 'model') stop();
  if ((page === 'overview' || page === 'brief') && obs) renderOverviewAndBrief();
  if (page === 'observed') { if (obs) renderObserved(); renderIdentification(); renderArchive(); }
  if (page === 'model') { renderModel(); if (!sens) scheduleSensitivity(); }
}

function readURL() {
  const raw = location.hash.slice(1);
  const [pagePart = '', query = ''] = raw.split('?');
  state.page = PAGES.includes(pagePart) ? pagePart : 'overview';
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
  if (state.page === 'model') {
    u.hash = 'model?' + new URLSearchParams({ preset: state.preset, p: JSON.stringify(state.p), m: state.month });
  } else {
    u.hash = state.page;
  }
  try {
    await navigator.clipboard.writeText(u.href);
    toast(state.page === 'model' ? '已复制可复算工作台链接（含当前参数）。' : '已复制当前看板页面分享链接。');
  } catch {
    location.hash = u.hash;
    toast('链接已写入地址栏，可直接复制分享。');
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
  download('\ufeff' + [head, ...lines].join('\r\n'), 'three-flow-v2.2-conditional-path.csv', 'text/csv;charset=utf-8');
  toast('逐月三流分解数据已导出 CSV。');
});

$('#export-json').addEventListener('click', () => download(JSON.stringify({
  model: 'capital-three-flow-v2.2',
  kind: 'conditional_coupled_not_fitted',
  units: 'capital index W0=100; month',
  initial: INITIAL,
  params: state.p,
  covariance_monthly: COV,
  rows,
  events: ev,
  sensitivity: sens
}, null, 2), 'three-flow-v2.2-reproducible.json', 'application/json'));

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
    const r = await fetch('data/observations.json', { cache: 'no-store', signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw Error(r.status);
    const d = await r.json();
    if (d.schema_version !== 1 || !d.sources) throw Error('schema');
    obs = d;
    renderSnapshot();
    renderOverviewAndBrief();
    if (state.page === 'observed') renderObserved();
    if (manual) toast('已同步最新快照；刷新页面不代表上游刚刚披露新一期数据。');
  } catch {
    $('#data-dot').classList.add('warn');
    $('#sync-status').textContent = obs ? '同步失败，保留原快照及原观测期。' : '无法获取观测快照；未以模拟值代替真实值。';
    if (manual) toast('快照暂不可读，已保留原快照或缺口。');
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
  const fx = getMetric('ecb_fx', 'usd_cny');
  const us10 = getMetric('us_treasury_yield', 'us_10y');
  const cn10 = getMetric('cn_gov_yield', 'cn_10y');
  const spread = (us10 && cn10) ? (cn10.value - us10.value) * 100 : null;
  const bad = Object.values(obs.sources).some(s => s.status !== 'ok');
  const aged = Date.now() - new Date(obs.generated_at) > 86400000;
  $('#data-dot').classList.toggle('warn', bad || aged);
  $('#obs-period').textContent = `日频 ${obs.sources.us_treasury_yield?.period || '—'} · 月频 ${src?.period || '—'}`;
  $('#tickers').innerHTML = [
    ['全球对美长期证券', sgn(world?.total, 2), '亿美元/月'],
    ['中美 10Y 利差', sgn(spread, 1), 'bp'],
    ['内地 / 香港对美净额', `${sgn(cn?.total, 0)} / ${sgn(hk?.total, 0)}`, '亿美元/月'],
    ['美元 / 人民币参考价', fmt(fx?.value, 4), '元/美元']
  ].map(([s, v, u]) => `<div class="tick"><span>${s}</span><b>${v}</b><small>${u}</small></div>`).join('');

  const okSrcCount = Object.values(obs.sources).filter(s => s.status === 'ok').length;
  const totalSrcCount = Object.keys(obs.sources).length;
  $('#sync-status').textContent = `${bad ? `注意：${totalSrcCount - okSrcCount} 个来源暂用旧值；` : `公开源 ${okSrcCount}/${totalSrcCount} 正常 · `}日频利率/汇率期 ${obs.sources.us_treasury_yield?.period || obs.sources.ecb_fx?.period || '—'} · TIC 跨境统计期 ${src?.period || '—'} · 快照生成 ${beijing(obs.generated_at)}`;
}

function renderHoldings() {
  const h = obs?.sources?.tic_holdings?.history || [];
  if (!h.length) {
    $('#holdings-chart').innerHTML = '<p class="chart-empty">TIC 表 5 持仓序列暂不可用。</p>';
    $('#holdings-summary').textContent = '';
    return;
  }
  const tc = themeColors();
  const labels = h.map(r => r.period.slice(2));
  const first = h[0], last = h.at(-1);
  if (state.htab === 'sector' && Number.isFinite(last.official)) {
    chart('#holdings-chart', [
      { name: '外国官方储备机构持有美债', color: tc.cyan, values: h.map(r => r.official) },
      { name: '外国私人与托管机构持有美债', color: tc.amber, values: h.map(r => r.private) }
    ], { unit: '亿美元 · 月末存量', labels, height: 220, includeZero: false });
    const dOff = last.official - first.official, dPriv = (last.private ?? 0) - (first.private ?? 0);
    $('#holdings-summary').innerHTML = `结构对照（${esc(first.period)} → ${esc(last.period)}）：外国官方机构存量 <b>${sgn(dOff, 1)}</b> 亿美元（月末 ${fmt(last.official, 1)} 亿），私人与托管部门 <b>${sgn(dPriv, 1)}</b> 亿美元（月末 ${fmt(last.private, 1)} 亿）。总量平稳掩盖了官方储备与私人套息盘的分化。`;
  } else {
    chart('#holdings-chart', [
      { name: '中国内地持有美债存量', color: tc.cyan, values: h.map(r => r.cn) },
      { name: '中国香港持有美债存量', color: tc.blue, values: h.map(r => r.hk) }
    ], { unit: '亿美元 · 月末存量', labels, height: 220, includeZero: false });
    const dCn = last.cn - first.cn, dHk = last.hk - first.hk;
    $('#holdings-summary').innerHTML = `存量对照（${esc(first.period)} → ${esc(last.period)}）：内地名义托管存量 <b>${sgn(dCn, 1)}</b> 亿美元（最新 ${fmt(last.cn, 1)} 亿），香港托管存量 <b>${sgn(dHk, 1)}</b> 亿美元（最新 ${fmt(last.hk, 1)} 亿）。月末存量含美债价格重估与离岸转托管，不能直接等同净卖出回流。`;
  }
}

function renderObserved() {
  if (!obs) return;
  const tc = themeColors();
  const key = $('#region').value, rs = regionData(key), r = rs.at(-1);
  const label = ({ world: '全球外国居民', cn: '中国内地居民', hk: '中国香港居民' })[key];
  $('#history-count').textContent = `${rs.length} 个月 · ${label}`;
  const world = regionData('world').at(-1), cn = regionData('cn').at(-1), hk = regionData('hk').at(-1);
  $('#observation-verdict').innerHTML = world
    ? `<strong>${esc(world.period)}：外国居民整体${world.total > 0 ? '仍在净买入' : '转为净卖出'}美国长期证券，但官方储备、私人套息与地区居民明显分化。</strong><p>当月全球对美长期证券净交易 ${sgn(world.total)} 亿美元；内地居民 ${sgn(cn?.total)}、香港居民 ${sgn(hk?.total)} 亿美元。单边吸收数据可证伪“美资全面溃逃”，但因缺少穿透对手方，须结合下方部分识别区间判断双边流向。</p>`
    : '官方序列尚不可用；不生成替代结论。';

  $('#observed-metrics').innerHTML =
    metric('对美长期证券净买卖', 'q', sgn(r?.total), '亿美元/月', `${r?.period || '—'} · ${label}`, tc.cyan) +
    metric('其中：美国股票', 'E', sgn(r?.equity), '亿美元/月', '直接使用官方净交易分项', tc.blue) +
    metric('其中：美国债券', 'B', sgn(r?.bond), '亿美元/月', '合计减股票（国债+机构债+公司债）', tc.amber) +
    metric('月度净配置强度', 'q/K', sgn(r?.intensity), '%/月', '净额占持仓比（非毛流速 v）', tc.purple);

  chart('#observed-chart', [
    { name: '长期证券合计', color: tc.cyan, values: rs.map(r => r.total) },
    { name: '股票', color: tc.blue, values: rs.map(r => r.equity) },
    { name: '债券', color: tc.amber, values: rs.map(r => r.bond) }
  ], { unit: '亿美元/月', labels: rs.map(r => r.period.slice(2)), height: 280 });

  chart('#intensity-chart', [{ name: '净配置强度', color: tc.purple, values: rs.map(r => r.intensity) }], { unit: '%/月 · 净额代理', labels: rs.map(r => r.period.slice(2)), height: 215 });

  $('#reconcile').innerHTML = r
    ? [['期末长期证券持仓', fmt(r.position) + ' 亿'], ['本月净买卖交易', sgn(r.total) + ' 亿'], ['官方资产价格重估', sgn(r.valuation) + ' 亿'], ['其他调整 / 对账残差', sgn(r.residual) + ' 亿']].map(([n, v]) => `<div class="driver"><span>${n}</span><b>${v}</b></div>`).join('') +
      '<p class="micro" style="margin-top:14px">残差 = 持仓增量 − 净买卖 − 价格重估。可能含样本重分类、托管迁移与统计调整，不冒充隐藏净买入。</p>'
    : '<p class="micro">缺少可比数据。</p>';

  renderHoldings();
  renderIdentification();
  renderArchive();

  $('#region-table').innerHTML = ['world', 'cn', 'hk'].map(k => {
    const v = regionData(k).at(-1);
    return v ? `<tr><td>${({ world: '全球外国居民', cn: '中国内地居民', hk: '中国香港居民' })[k]}</td>${['total', 'equity', 'treasury', 'agency', 'corporate'].map(x => `<td class="${v[x] >= 0 ? 'positive' : 'negative'}">${sgn(v[x])}</td>`).join('')}<td>${esc(v.period)}</td></tr>` : '';
  }).join('');

  $('#source-log').innerHTML = Object.values(obs.sources).map(s =>
    `<div class="source"><span class="badge">${s.status === 'ok' ? '🟢 成功读取' : s.status === 'stale' ? '🟡 暂败 · 保留旧值' : '🔴 暂不可用'}</span><b>${esc(s.name)}</b>观测期 ${esc(s.period || '—')} · ${esc(s.frequency)}<br>最近成功 ${beijing(s.last_success_at)}<br>最近尝试 ${beijing(s.last_attempt_at)}${s.error ? '<p>' + esc(s.error) + '</p>' : ''}<code>SHA-256 ${esc(s.sha256 || '—')}</code><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">原始官方来源 ↗</a></div>`
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
  resize = setTimeout(renderActiveCharts, 140);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });

recompute();
readURL();
sync();
loadArchive();
renderIdentification();
setInterval(() => { if (!document.hidden) sync(); }, 300000);
