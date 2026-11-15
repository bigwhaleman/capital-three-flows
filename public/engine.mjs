/** Coupled Capital Three-Flows Model v2.1
 * K: capital-index points (W0=100), t: months.
 * Annual % -> /1200 monthly; one-off bp -> /10000; annual covariance -> /12.
 * Structural conditional dynamics + exact LP partial-identification bounds; NOT fitted forecast.
 */
export const ASSETS = ['美国股票', '美国债券', '中国风险股票', '中国风险债券', '黄金', '第三地资产', '美元现金'];
export const COLORS = ['#5590ff', '#98b6ee', '#33c5ac', '#91ded0', '#edbb63', '#ae99e0', '#ccd5df'];
export const INITIAL = [30, 20, 15, 10, 5, 10, 10];
const W0_REF = INITIAL.map(x => x / 100);

export const DEFAULT = {
  gap0: -3.5, gapEnd: 3, bond0: -2.4, bondEnd: 1.8, tau: 12,
  fx: 0, bondHedge: 0.5, friction: 0.6,
  costUC: 8, costCU: 12, speed: 0.65, access: 1,
  tight: 1.1, tightEnd: 0.35, cashShock: 0,
  policy: 1, threshold: 0.5,
  flowFeedback: 1.2, ratePass: 1, conc: 8,
  gamma: 2.5, confirm: 3, months: 36, mark: 0, deductCost: 0, step: 1 / 24
};

export const PRESETS = {
  base: { label: '缓慢再平衡', brief: '相对回报渐修复，高息虹吸随融资压力缓释而消退', params: {} },
  repair: { label: '回报修复加快', brief: '回报优势更快扩大，美元现金与美股债同步向外再配置', params: { gapEnd: 5, bondEnd: 3, tau: 6, tightEnd: 0.15 } },
  sticky: { label: '美国优势延续', brief: '中国回报差未转正且高息紧缩持续，不发生持续逆转', params: { gapEnd: -1.5, bondEnd: -1, tau: 18, tightEnd: 1.1 } },
  cash: { label: '美元现金挤兑', brief: '现金短缺触发优先强售，自愿流速塌缩而广义美元体系净虹吸', params: { cashShock: 1, tight: 1.8, tightEnd: 0.7, tau: 18, gapEnd: 1.5, bondEnd: 0.9 } }
};

export const FACTORS = [[.14, .05, 0], [.01, -.055, 0], [.16, 0, .075], [.015, -.03, .018], [-.02, -.045, .025], [.12, .025, .025], [0, 0, 0]];
export const IDIO = [.09, .025, .12, .025, .12, .085, 0];
export const COV = FACTORS.map((a, i) => FACTORS.map((b, j) => (a.reduce((s, x, k) => s + x * b[k], 0) + (i === j ? IDIO[i] ** 2 : 0)) / 12));

const sum = a => a.reduce((s, x) => s + x, 0);
const clip = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const cn = i => i === 2 || i === 3;
const us = i => i === 0 || i === 1;
const sigmoid = x => 1 / (1 + Math.exp(-clip(x, -35, 35)));

export function config(preset = 'base', overrides = {}) {
  const p = { ...DEFAULT, ...(PRESETS[preset]?.params || {}), ...overrides };
  validate(p);
  return p;
}

export function validate(p) {
  for (const k of Object.keys(DEFAULT)) if (!Number.isFinite(p[k])) throw Error('非有限参数：' + k);
  for (const k of ['tau', 'speed', 'threshold', 'gamma', 'months', 'step']) if (p[k] <= 0) throw Error('参数须为正：' + k);
  if (
    p.step > 0.25 || p.months > 60 || p.months < 3 || !Number.isInteger(p.months) ||
    p.confirm < 1 || p.confirm > 12 || !Number.isInteger(p.confirm) ||
    p.access < 0 || p.access > 1 || p.policy < 0 || p.policy > 1 ||
    p.bondHedge < 0 || p.bondHedge > 1 || p.deductCost < 0 || p.deductCost > 1 ||
    p.flowFeedback < 0 || p.flowFeedback > 4 || p.ratePass < 0 || p.ratePass > 3 ||
    p.conc < 0 || p.conc > 25 ||
    p.speed > 3 || p.friction < 0 || p.costUC < 0 || p.costCU < 0 ||
    p.tight < 0 || p.tightEnd < 0 || p.cashShock < 0 || p.cashShock > 2 || p.mark <= -100
  ) throw Error('参数超出可计算范围');
  if (Math.abs(1 / p.step - Math.round(1 / p.step)) > 1e-8) throw Error('时间步必须整分一个月');
}

export function drivers(t, p) {
  const e = Math.exp(-t / p.tau);
  return {
    gap: p.gapEnd + (p.gap0 - p.gapEnd) * e,
    bondGap: p.bondEnd + (p.bond0 - p.bondEnd) * e,
    I: p.tightEnd + (p.tight - p.tightEnd) * e,
    Z: p.cashShock * Math.exp(-t / (p.tau * 1.4))
  };
}

export function stateDerivative(s, d, p, usOutflowRatio = 0) {
  const [H, P, R] = s;
  const endoStress = p.flowFeedback * Math.max(0, usOutflowRatio);
  return [
    (0.22 + 0.40 * R) * (1 - H) - 0.65 * d.I * H,
    (0.22 * (1 - H) + 0.32 * d.Z + endoStress) * (1 - P) - (0.12 + 0.28 * R) * P,
    0.45 * (p.policy * sigmoid((P - p.threshold) / 0.09) - R)
  ];
}

export function advantage(K, s, t, p) {
  const W = sum(K), w = K.map(x => x / W), d = drivers(t, p), [, P, R] = s, rp = p.ratePass;
  const ue = 8 - 1.2 * P + 0.8 * rp * R;
  const ub = 4.5 + 0.35 * rp * d.I + 0.9 * rp * R - 0.6 * P;
  const ce = ue + d.gap + p.fx;
  const cb = ub + d.bondGap + (1 - p.bondHedge) * p.fx;
  const gold = 3.2 + 2.6 * Math.max(0, P - 0.25) + 1.1 * rp * R - 0.4 * rp * Math.max(0, d.I - 0.5);
  const other = 6.5 - 0.8 * P + 0.5 * rp * R;
  const cash = 3 + 1.4 * rp * d.I - 1.8 * rp * R;
  const annual = [ue, ub, ce, cb, gold, other, cash];
  const exit = [2 * P, 0.25 * P, p.friction + 3 * P, p.friction * 0.5 + 0.5 * P, 0.2 * P, 2 * P, 0];
  const mu = annual.map(x => x / 1200), chi = exit.map(x => x / 1200);
  const covRisk = COV.map(r => p.gamma * r.reduce((a, x, i) => a + x * w[i], 0));
  const capRisk = w.map((wi, i) => i === 6 ? 0 : p.conc * (wi - W0_REF[i]) / 1200);
  const risk = covRisk.map((x, i) => x + capRisk[i]);
  return { g: mu.map((x, i) => x - chi[i] - risk[i]), annual, mu, chi, risk, covRisk, capRisk, d, w, W };
}

export function cost(i, j, p) {
  if (i === j) return 0;
  if (!cn(i) && cn(j)) return p.costUC / 10000;
  if (cn(i) && !cn(j)) return p.costCU / 10000;
  if ((i === 1 && j === 6) || (i === 6 && j === 1)) return 1 / 10000;
  if ((us(i) && us(j)) || (cn(i) && cn(j))) return 2 / 10000;
  return 3 / 10000;
}

function decomposeMatrix(f, Wavg, forcedAmt = 0) {
  const net = Array(7).fill(0);
  let L = 0;
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i !== j) {
    const x = f[i][j];
    net[i] -= x;
    net[j] += x;
    L += x;
  }
  const Je = f[0][2] - f[2][0];
  const Jb = f[1][3] - f[3][1];
  const Jcross = (f[0][3] - f[3][0]) + (f[1][2] - f[2][1]);
  const J = Je + Jb + Jcross;
  const NC = net[2] + net[3];
  const NU = net[0] + net[1];
  const NUSD = NU + net[6];
  const Nalt = net[4] + net[5];
  const Jindirect = NC - J;
  const Lvol = Math.max(0, L - forcedAmt);
  const v = L / Wavg;
  const vVol = Lvol / Wavg;
  const vForced = forcedAmt / Wavg;
  const D = L > 1e-12 ? J / L : null;
  const netEff = L > 1e-12 ? sum(net.map(Math.abs)) / (2 * L) : null;
  return { net, L, Lvol, Je, Jb, Jcross, J, NC, NU, NUSD, Nalt, Jindirect, v, vVol, vForced, D, netEff };
}

export function flowRates(K, s, t, p, dt = 0) {
  const a = advantage(K, s, t, p), [H, P] = s, { W, g, d } = a;
  const floor = clip(0.08 + 0.08 * P + 0.40 * d.Z, 0.05, 0.75);
  const gap = Math.max(0, floor * W - K[6]);
  const f = Array.from({ length: 7 }, () => Array(7).fill(0));
  const forced = f.map(r => r.slice());

  // 1. Lexicographic priority: satisfy forced cash-raising first within accessible holdings.
  const eligible = K.map((k, i) => i === 6 ? 0 : k * (cn(i) ? p.access : 1));
  const E = sum(eligible);
  if (E > 0 && gap > 0) {
    for (let i = 0; i < 6; i++) {
      const raw = 1.4 * gap * eligible[i] / E;
      forced[i][6] = dt > 0 ? Math.min(raw, eligible[i] / dt) : raw;
      f[i][6] = forced[i][6];
    }
  }

  // 2. Voluntary margin-driven allocation from remaining unencumbered capital.
  const phi = H / (H + 0.30), nu = p.speed * phi;
  for (let i = 0; i < 7; i++) {
    const q = Array(7).fill(0);
    for (let j = 0; j < 7; j++) if (i !== j) {
      const access = (cn(i) || cn(j)) ? p.access : 1;
      q[j] = access * Math.max(0, g[j] - g[i] - cost(i, j, p)) / 0.001;
    }
    const denom = 1 + sum(q);
    const rem = i === 6 ? Math.max(0, K[6] - floor * W) : (dt > 0 ? Math.max(0, K[i] - forced[i][6] * dt) : K[i]);
    const volRow = q.map(qj => nu * rem * qj / denom);
    const volOut = sum(volRow);
    const scale = (dt > 0 && volOut * dt > rem && volOut > 0) ? rem / (volOut * dt) : 1;
    for (let j = 0; j < 7; j++) f[i][j] += volRow[j] * scale;
  }

  const forcedTotal = sum(forced.flat());
  let costRate = 0;
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i !== j) costRate += f[i][j] * cost(i, j, p);
  const dec = decomposeMatrix(f, W, forcedTotal);
  const Se = (g[2] - g[0] - cost(0, 2, p)) * 10000;
  const Sb = (g[3] - g[1] - cost(1, 3, p)) * 10000;
  const Scross = Math.max(g[2] - g[1] - cost(1, 2, p), g[3] - g[0] - cost(0, 3, p)) * 10000;
  const SmaxUC = Math.max(Se, Sb, Scross);
  const ScashC = Math.max(g[2] - g[6] - cost(6, 2, p), g[3] - g[6] - cost(6, 3, p)) * 10000;
  return {
    ...a, f, ...dec, forced: forcedTotal, costRate, cashFloor: floor,
    Se, Sb, Scross, SmaxUC, ScashC
  };
}

export function summarize(K, s, t, p, f, Wavg, forced = 0, G = 0, costDrag = 0, cumCost = 0) {
  const a = flowRates(K, s, t, p, 0);
  const dec = decomposeMatrix(f, Wavg, forced);
  const W = sum(K);
  return {
    month: t, K: K.slice(), W, w: K.map(x => x / W),
    H: s[0], P: s[1], R: s[2],
    ...dec, f, forced, G, costDrag, cumCost,
    Se: a.Se, Sb: a.Sb, Scross: a.Scross, SmaxUC: a.SmaxUC, ScashC: a.ScashC, cashFloor: a.cashFloor,
    g: a.g, annual: a.annual, mu: a.mu, chi: a.chi, risk: a.risk, covRisk: a.covRisk, capRisk: a.capRisk,
    gap: a.d.gap, bondGap: a.d.bondGap, I: a.d.I, Z: a.d.Z
  };
}

function stepHoldings(K, f, dt, p) {
  const next = K.slice();
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i !== j) {
    const x = f[i][j] * dt;
    next[i] -= x;
    next[j] += x * (1 - p.deductCost * cost(i, j, p));
  }
  return next;
}

export function simulate(p, initial = INITIAL) {
  validate(p);
  if (initial.length !== 7 || initial.some(x => !Number.isFinite(x) || x < 0) || sum(initial) <= 0) throw Error('初始配置非法');
  let K = initial.slice(), s = [0.72, 0.28, 0.08], t = 0, cumCost = 0;
  const a0 = flowRates(K, s, 0, p, 0);
  const rows = [summarize(K, s, 0, p, a0.f, sum(K), a0.forced, 0, a0.costRate, 0)];
  const substeps = Math.round(1 / p.step);

  for (let m = 1; m <= p.months; m++) {
    const oldW = sum(K), acc = Array.from({ length: 7 }, () => Array(7).fill(0));
    let forced = 0, G = 0, costDrag = 0;
    for (let k = 0; k < substeps; k++) {
      const dt = p.step;
      const r1 = flowRates(K, s, t, p, dt);
      const K1 = stepHoldings(K, r1.f, dt, p);
      const ds1 = stateDerivative(s, r1.d, p, -r1.NU / r1.W);
      const s1 = s.map((x, i) => clip(x + dt * ds1[i]));

      const r2 = flowRates(K1, s1, t + dt, p, dt);
      const ds2 = stateDerivative(s1, r2.d, p, -r2.NU / r2.W);
      const fMid = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (__, j) => 0.5 * (r1.f[i][j] + r2.f[i][j])));
      const forcedMid = 0.5 * (r1.forced + r2.forced);

      K = stepHoldings(K, fMid, dt, p);
      s = s.map((x, i) => clip(x + 0.5 * dt * (ds1[i] + ds2[i])));

      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i !== j) {
        const vol = fMid[i][j] * dt;
        acc[i][j] += vol;
        costDrag += vol * cost(i, j, p);
      }
      forced += forcedMid * dt;

      if (p.mark !== 0) {
        const q = Math.expm1(Math.log1p(p.mark / 100) * dt / 12);
        G += sum(K) * q;
        K = K.map(x => x * (1 + q));
      }
      t = (m - 1) + (k + 1) * dt;
    }
    cumCost += costDrag;
    rows.push(summarize(K, s, m, p, acc, (oldW + sum(K)) / 2, forced, G, costDrag, cumCost));
  }
  return rows;
}

function scanWindows(rows, m, predicate) {
  let run = 0, confirm = null, start = null;
  const windows = [];
  for (const r of rows) {
    if (r.month === 0) continue;
    if (predicate(r)) {
      run++;
      if (run === 1) start = r.month;
      if (run === m) {
        if (confirm === null) confirm = r.month;
        windows.push({ start, confirmed: r.month, end: null, censored: true });
      }
    } else {
      if (run >= m) {
        windows.at(-1).end = r.month - 1;
        windows.at(-1).censored = false;
      }
      run = 0;
      start = null;
    }
  }
  return { confirm, windows };
}

export function events(rows, m = 3) {
  const eps = 1e-7;
  let negative = false, flip = null;
  const initialPositive = rows[0].J > eps;
  for (const r of rows) {
    if (r.J < -eps) negative = true;
    if (negative && r.J > eps && flip === null) flip = r.month;
  }
  const direct = scanWindows(rows, m, r => {
    const nc = r.NC ?? (r.net[2] + r.net[3]);
    const nu = r.NU ?? (r.net[0] + r.net[1]);
    return r.J > eps && nc > eps && nu < -eps;
  });
  const broad = scanWindows(rows, m, r => {
    const nc = r.NC ?? (r.net[2] + r.net[3]);
    const nusd = r.NUSD ?? ((r.net[0] + r.net[1]) + (r.net[6] ?? 0));
    return nc > eps && nusd < -eps;
  });
  const triggered = key => {
    if (rows[0][key] > 0) return 0;
    const x = rows.find(r => r[key] > 0);
    return x?.month ?? null;
  };
  const eqT = triggered('Se'), bdT = triggered('Sb');
  const directCandidates = [eqT, bdT, triggered('SmaxUC')].filter(v => v !== null);
  return {
    flip,
    confirm: direct.confirm,
    windows: direct.windows,
    broadConfirm: broad.confirm,
    broadWindows: broad.windows,
    initialPositive,
    anyTrigger: directCandidates.length ? Math.min(...directCandidates) : null,
    equityTrigger: eqT,
    bondTrigger: bdT,
    cashTrigger: triggered('ScashC')
  };
}

export function sensitivity(p) {
  const outcomes = [];
  for (const dg of [-1, 0, 1]) for (const speed of [.7, 1, 1.3]) for (const c of [.7, 1, 1.3]) {
    const q = { ...p, gapEnd: p.gapEnd + dg, speed: Math.min(3, p.speed * speed), costUC: p.costUC * c, costCU: p.costCU * c };
    const e = events(simulate(q), p.confirm);
    outcomes.push({ gapEnd: q.gapEnd, speed: q.speed, costUC: q.costUC, confirmed: e.confirm, broadConfirmed: e.broadConfirm });
  }
  const hit = outcomes.filter(x => x.confirmed !== null).map(x => x.confirmed);
  const broadHit = outcomes.filter(x => x.broadConfirmed !== null).map(x => x.broadConfirmed);
  return {
    n: outcomes.length, hit: hit.length, miss: outcomes.length - hit.length,
    early: hit.length ? Math.min(...hit) : null, late: hit.length ? Math.max(...hit) : null,
    broadHit: broadHit.length,
    outcomes
  };
}

/** Exact analytical solver for 3-region (US, CN, Rest/Cash hub R) bilateral partial identification.
 * Given observed net inflows nU in [nU-tolU, nU+tolU] and nC in [nC-tolC, nC+tolC],
 * bilateral channel caps capUC, capCU, hub routing cap capR, and optional total gross cap capGross,
 * returns exact [minJ, maxJ] of J_UC = f_UC - f_CU and constructive witness flow networks.
 */
export function identifyBounds({ nU, nC, tolU = 0, tolC = 0, capUC = 5000, capCU = 5000, capR = 5000, capGross = Infinity }) {
  for (const v of [nU, nC, tolU, tolC, capUC, capCU, capR]) if (!Number.isFinite(v)) throw Error('识别参数须为有限数值');
  if (tolU < 0 || tolC < 0 || capUC < 0 || capCU < 0 || capR < 0 || capGross <= 0) throw Error('误差界与通道上限须非负');
  const uLo = nU - tolU, uHi = nU + tolU, cLo = nC - tolC, cHi = nC + tolC;
  const jLo = Math.max(-capCU, -uHi - capR, cLo - capR);
  const jHi = Math.min(capUC, -uLo + capR, cHi + capR);
  if (jLo > jHi + 1e-11) {
    return { feasible: false, status: 'infeasible', minJ: null, maxJ: null, width: null, witnessMin: null, witnessMax: null };
  }
  const lo0 = Math.min(jLo, jHi), hi0 = Math.max(jLo, jHi);
  const witnessAt = J => {
    const iuLo = Math.max(uLo, -J - capR), iuHi = Math.min(uHi, -J + capR);
    const icLo = Math.max(cLo, J - capR), icHi = Math.min(cHi, J + capR);
    const uStar = clip(-J, iuLo, iuHi);
    const cStar = clip(J, icLo, icHi);
    const jRU = uStar + J, jRC = cStar - J;
    const fUC = Math.max(0, J), fCU = Math.max(0, -J);
    const fRU = Math.max(0, jRU), fUR = Math.max(0, -jRU);
    const fRC = Math.max(0, jRC), fCR = Math.max(0, -jRC);
    const L = fUC + fCU + fRU + fUR + fRC + fCR;
    return { J, nU: uStar, nC: cStar, nR: -(uStar + cStar), L, flows: { fUC, fCU, fUR, fRU, fCR, fRC } };
  };

  let minJ = lo0, maxJ = hi0;
  if (Number.isFinite(capGross)) {
    const pts = new Set([lo0, hi0, 0, -uLo, -uHi, cLo, cHi, -uLo - capR, -uHi + capR, cLo - capR, cHi + capR]);
    const knots = [...pts].filter(x => x >= lo0 - 1e-11 && x <= hi0 + 1e-11).map(x => clip(x, lo0, hi0)).sort((a, b) => a - b);
    const uniq = knots.filter((x, i) => i === 0 || x - knots[i - 1] > 1e-12);
    let bestLo = Infinity, bestHi = -Infinity;
    const minGross = J => witnessAt(J).L;
    if (uniq.length === 1) {
      if (minGross(uniq[0]) <= capGross + 1e-11) bestLo = bestHi = uniq[0];
    } else {
      for (let i = 0; i < uniq.length - 1; i++) {
        const a = uniq[i], b = uniq[i + 1], ga = minGross(a), gb = minGross(b);
        if (ga <= capGross + 1e-11 && gb <= capGross + 1e-11) {
          bestLo = Math.min(bestLo, a); bestHi = Math.max(bestHi, b);
        } else if (ga <= capGross + 1e-11 && gb > capGross + 1e-11) {
          const r = a + (b - a) * (capGross - ga) / (gb - ga);
          bestLo = Math.min(bestLo, a); bestHi = Math.max(bestHi, r);
        } else if (ga > capGross + 1e-11 && gb <= capGross + 1e-11) {
          const r = a + (b - a) * (capGross - ga) / (gb - ga);
          bestLo = Math.min(bestLo, r); bestHi = Math.max(bestHi, b);
        }
      }
    }
    if (!Number.isFinite(bestLo) || bestLo > bestHi + 1e-11) {
      return { feasible: false, status: 'infeasible', minJ: null, maxJ: null, width: null, witnessMin: null, witnessMax: null };
    }
    minJ = bestLo; maxJ = bestHi;
  }

  const eps = 1e-9;
  const status = minJ > eps ? 'positive_identified' : maxJ < -eps ? 'negative_identified' : 'unidentified_spans_zero';
  return {
    feasible: true, status, minJ, maxJ, width: maxJ - minJ,
    witnessMin: witnessAt(minJ), witnessMax: witnessAt(maxJ)
  };
}
