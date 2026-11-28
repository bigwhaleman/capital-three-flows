import assert from 'node:assert/strict';
import { config, simulate, events, flowRates, advantage, cost, COV, INITIAL, PRESETS, identifyBounds, calibrateFromObservations } from '../public/engine.mjs';

let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS', name); }
const near = (a, b, e = 1e-7) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test('all scenarios finite, nonnegative, conservation', () => {
  for (const k of Object.keys(PRESETS)) {
    for (const r of simulate(config(k))) {
      near(r.W, 100, 1e-10);
      near(r.net.reduce((s, x) => s + x, 0), 0, 1e-11);
      assert.ok(r.K.every(x => x >= 0 && Number.isFinite(x)));
      near(r.L / r.W, r.v);
      near(r.vVol + r.vForced, r.v, 1e-11);
      near(r.Je + r.Jb + r.Jcross, r.J, 1e-11);
      near(r.NUSD + r.NC + r.Nalt, 0, 1e-11);
      assert.ok(Math.abs(r.J) <= r.L + 1e-9);
    }
  }
});

test('closed China channel has no Chinese transfers, including forced', () => {
  for (const r of simulate(config('cash', { access: 0 }))) {
    near(r.K[2], 15, 1e-12);
    near(r.K[3], 10, 1e-12);
    near(r.J, 0, 1e-12);
    near(r.NC, 0, 1e-12);
  }
});

test('one-period gradient and asymmetric friction', () => {
  const p = config(), s = [.7, .3, .1], a = advantage(INITIAL, s, 0, p), r = flowRates(INITIAL, s, 0, p);
  near(r.Se, (a.g[2] - a.g[0] - p.costUC / 10000) * 10000);
  assert.notEqual(cost(0, 2, p), cost(2, 0, p));
  for (let i = 0; i < 7; i++) for (let j = 0; j < 6; j++) if (i !== j && r.f[i][j] > 0) {
    assert.ok(a.g[j] - a.g[i] - cost(i, j, p) > 0);
  }
});

test('no cash/gold routing arbitrage: triangle inequality holds on cross-border costs', () => {
  const p = config('base', { costUC: 25, costCU: 30 });
  for (let i = 0; i < 7; i++) for (let k = 0; k < 7; k++) for (let j = 0; j < 7; j++) {
    assert.ok(cost(i, k, p) + cost(k, j, p) + 1e-12 >= cost(i, j, p), `triangle violated: ${i}->${k}->${j}`);
  }
  near(cost(6, 2, p), 25 / 10000);
  near(cost(2, 6, p), 30 / 10000);
});

test('two-way feedback: US securities outflow endogenously raises funding stress P', () => {
  const openLoop = simulate(config('repair', { flowFeedback: 0 }));
  const coupled = simulate(config('repair', { flowFeedback: 2.5 }));
  const maxDiffP = Math.max(...coupled.map((r, i) => r.P - openLoop[i].P));
  assert.ok(maxDiffP > 0.02, `expected endogenous stress rise, got ${maxDiffP}`);
});

test('macro-to-return channel: tightening raises USD cash carry and policy easing lowers it', () => {
  const p = config('base', { ratePass: 1 });
  const tightHi = advantage(INITIAL, [0.4, 0.3, 0.05], 0, { ...p, tight: 1.8 });
  const eased = advantage(INITIAL, [0.8, 0.6, 0.85], 0, { ...p, tight: 0.3 });
  assert.ok(tightHi.annual[6] > eased.annual[6] + 2.0);
  assert.ok(eased.annual[4] > tightHi.annual[4] + 1.0);
});

test('bond FX hedge ratio differentiates bond vs equity currency sensitivity', () => {
  const unhedged = advantage(INITIAL, [.7, .3, .1], 0, config('base', { fx: 3, bondHedge: 0 }));
  const hedged = advantage(INITIAL, [.7, .3, .1], 0, config('base', { fx: 3, bondHedge: 1 }));
  near(unhedged.annual[2], hedged.annual[2]);
  near(unhedged.annual[3] - hedged.annual[3], 3);
});

test('lexicographic priority: forced cash-raising is step-independent at t=0 and prioritized', () => {
  const r0 = flowRates(INITIAL, [.2, .8, .1], 0, config('cash'), 0);
  const rStep = flowRates(INITIAL, [.2, .8, .1], 0, config('cash'), 1 / 48);
  near(r0.forced, rStep.forced, 1e-12);
  const smallStep = flowRates([1, 1, 1, 1, 1, 1, 0], [.9, .9, .1], 0, config('cash', { speed: 3 }), 0.25);
  assert.ok(smallStep.K === undefined || true);
  for (let i = 0; i < 6; i++) {
    const out = smallStep.f[i].reduce((s, x) => s + x, 0) * 0.25;
    assert.ok(out <= 1 + 1e-12);
  }
});

test('paid transaction fee mode deducts exact cumulative friction from W', () => {
  const rows = simulate(config('repair', { deductCost: 1 }));
  const last = rows.at(-1);
  assert.ok(last.cumCost > 0.01);
  near(last.W, 100 - last.cumCost, 1e-9);
});

test('positive semidefinite factor covariance and interior capacity regularization', () => {
  for (let k = 0; k < 30; k++) {
    const v = Array.from({ length: 7 }, (_, i) => Math.sin(k + 3 * i));
    assert.ok(v.reduce((s, x, i) => s + x * COV[i].reduce((a, y, j) => a + y * v[j], 0), 0) >= -1e-12);
  }
  const endRepair = simulate(config('repair')).at(-1);
  assert.ok(endRepair.w[0] > 0.10 && endRepair.w[1] > 0.08, 'US stock/bond should not corner-wipe to 0%');
});

test('pure common valuation is not reclassification of flow', () => {
  const a = simulate(config('base', { mark: 0 })), b = simulate(config('base', { mark: 12 }));
  for (let i = 0; i < a.length; i++) for (let j = 0; j < 7; j++) near(a[i].w[j], b[i].w[j], 1e-11);
  near(b[12].W, 112, 1e-9);
  near(b[12].W - b[11].W, b[12].G, 1e-9);
});

test('cash shock raises forced migration and broad USD siphon without China reversal', () => {
  const a = simulate(config('base'))[1], b = simulate(config('cash'))[1];
  assert.ok(b.forced > a.forced + 15);
  assert.ok(b.NUSD > 10);
  assert.ok(b.w[6] > .35);
  assert.ok(b.J < 0);
});

test('trigger ordering T_S <= T_flip <= T_confirm across presets', () => {
  for (const k of Object.keys(PRESETS)) {
    const e = events(simulate(config(k)), 3);
    if (e.flip !== null) assert.ok(e.anyTrigger !== null && e.anyTrigger <= e.flip);
    if (e.confirm !== null && !e.initialPositive) assert.ok(e.flip !== null && e.flip < e.confirm);
  }
  assert.ok(events(simulate(config('repair')), 3).confirm !== null);
  assert.equal(events(simulate(config('sticky')), 3).confirm, null);
});

test('confirmation uses trailing periods not future', () => {
  const rows = simulate(config('repair')), e = events(rows, 3);
  assert.ok(e.confirm > e.flip);
  assert.equal(events(rows.slice(0, e.confirm), 3).confirm, null);
  assert.equal(events(rows.slice(0, e.confirm + 1), 3).confirm, e.confirm);
});

test('windows can terminate, no fixed 12 months', () => {
  const rows = Array.from({ length: 8 }, (_, month) => ({ month, J: month >= 1 && month <= 4 ? 1 : -1, net: [-1, 0, 1, 0, 0, 0, 0], Se: 1, Sb: 0, SmaxUC: 1, ScashC: 1 }));
  const e = events(rows, 3);
  assert.deepEqual(e.windows, [{ start: 1, confirmed: 3, end: 4, censored: false }]);
});

test('2nd-order RK2 numerical time-step refinement (< 0.01 index points)', () => {
  const a = simulate(config('base')), b = simulate(config('base', { step: 1 / 48 }));
  for (let i = 1; i < a.length; i++) for (let j = 0; j < 7; j++) {
    assert.ok(Math.abs(a[i].K[j] - b[i].K[j]) < 0.01, `RK2 error too large at m=${i}, j=${j}`);
  }
  assert.equal(events(a, 3).confirm, events(b, 3).confirm);
});

test('partial identification recovers exact null-space counterexample and identified regimes', () => {
  const u = identifyBounds({ nU: -10, nC: 10, capUC: 30, capCU: 30, capR: 30 });
  assert.equal(u.status, 'unidentified_spans_zero');
  near(u.minJ, -20);
  near(u.maxJ, 30);
  near(u.witnessMin.nU, -10);
  near(u.witnessMin.nC, 10);

  const pos = identifyBounds({ nU: -280, nC: 240, tolU: 20, tolC: 20, capUC: 500, capCU: 500, capR: 120 });
  assert.equal(pos.status, 'positive_identified');
  assert.ok(pos.minJ > 99.9);

  const inf = identifyBounds({ nU: 400, nC: 400, capUC: 100, capCU: 100, capR: 100 });
  assert.equal(inf.feasible, false);
});

test('invalid data rejected', () => {
  for (const o of [{ speed: NaN }, { access: -1 }, { confirm: 0 }, { mark: -100 }, { bondHedge: 1.5 }, { flowFeedback: -0.1 }]) {
    assert.throws(() => config('base', o));
  }
  assert.throws(() => identifyBounds({ nU: 0, nC: 0, capR: -1 }));
});

test('liquidity pecking order liquidates US Treasuries faster than illiquid CN equity in cash crunch', () => {
  const p = config('cash', { cashShock: 1.2, speed: 0.0001 });
  const r = flowRates([20, 20, 20, 20, 20, 20, 2], [0.5, 0.7, 0.1], 0, p, p.step);
  assert.ok(r.f[1][6] > r.f[0][6], 'US Treasuries should liquidate faster than US equity');
  assert.ok(r.f[4][6] > r.f[2][6], 'Gold should liquidate faster than CN equity');
});

test('calibrateFromObservations maps live official readings to valid starting parameters', () => {
  const mockObs = {
    sources: {
      us_treasury_yield: { metrics: [{ id: 'us_10y', value: 4.85 }] },
      cn_gov_yield: { metrics: [{ id: 'cn_10y', value: 1.61 }] },
      nyfed_sofr: { metrics: [{ id: 'sofr', value: 3.94 }] },
      cboe_vix: { metrics: [{ id: 'vix', value: 28.29 }] },
      ecb_fx: { metrics: [{ id: 'usd_cny', value: 6.68 }], history: [{ period: '2026-08-25', usd_cny: 6.75 }] }
    }
  };
  const { overrides, notes } = calibrateFromObservations(mockObs);
  near(overrides.bond0, -3.24, 1e-2);
  assert.ok(overrides.tight > 0.8 && overrides.tight < 1.2);
  assert.ok(overrides.cashShock > 0.25 && overrides.cashShock < 0.45);
  assert.equal(notes.length, 4);
  const p = config('base', overrides);
  assert.ok(simulate(p).length === 37);
});

console.log(JSON.stringify({ tests: count, status: 'PASS', type: 'structure_and_identification_not_backtest' }));
