import assert from 'node:assert/strict';
import{config,simulate,events,flowRates,advantage,cost,COV,INITIAL,PRESETS}from'../public/engine.mjs';
let count=0;function test(name,fn){fn();count++;console.log('PASS',name)}
const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
test('all scenarios finite, nonnegative, conservation',()=>{for(const k of Object.keys(PRESETS)){for(const r of simulate(config(k))){near(r.W,100);near(r.net.reduce((s,x)=>s+x,0),0);assert.ok(r.K.every(x=>x>=0&&Number.isFinite(x)));near(r.L/r.W,r.v);assert.ok(Math.abs(r.J)<=r.L+1e-9);}}});
test('closed China channel has no Chinese transfers, including forced',()=>{for(const r of simulate(config('cash',{access:0}))){near(r.K[2],15);near(r.K[3],10);near(r.J,0);}});
test('one-period gradient and asymmetric friction',()=>{const p=config(),s=[.7,.3,.1],a=advantage(INITIAL,s,0,p),r=flowRates(INITIAL,s,0,p);near(r.Se,(a.g[2]-a.g[0]-p.costUC/10000)*10000);assert.notEqual(cost(0,2,p),cost(2,0,p));for(let i=0;i<7;i++)for(let j=0;j<6;j++)if(r.f[i][j]>0)assert.ok(a.g[j]-a.g[i]-cost(i,j,p)>0);});
test('positive semidefinite factor covariance',()=>{for(let k=0;k<30;k++){const v=Array.from({length:7},(_,i)=>Math.sin(k+3*i));assert.ok(v.reduce((s,x,i)=>s+x*COV[i].reduce((a,y,j)=>a+y*v[j],0),0)>=-1e-12);}});
test('pure common valuation is not reclassification of flow',()=>{const a=simulate(config('base',{mark:0})),b=simulate(config('base',{mark:12}));for(let i=0;i<a.length;i++){for(let j=0;j<7;j++)near(a[i].w[j],b[i].w[j]);}near(b[12].W,112,1e-6);near(b[12].W-b[11].W,b[12].G,1e-7);});
test('cash shock raises forced migration without China reversal',()=>{const a=simulate(config('base'))[1],b=simulate(config('cash'))[1];assert.ok(b.forced>a.forced+10);assert.ok(b.w[6]>.35);assert.ok(b.J<0);});
test('different scenarios may reverse or never reverse',()=>{assert.ok(events(simulate(config('repair')),3).confirm!==null);assert.equal(events(simulate(config('sticky')),3).confirm,null);});
test('confirmation uses trailing periods not future',()=>{const rows=simulate(config('repair')),e=events(rows,3);assert.ok(e.confirm>e.flip);assert.equal(events(rows.slice(0,e.confirm),3).confirm,null);assert.equal(events(rows.slice(0,e.confirm+1),3).confirm,e.confirm);});
test('windows can terminate, no fixed 12 months',()=>{const rows=Array.from({length:8},(_,month)=>({month,J:month>=1&&month<=4?1:-1,net:[-1,0,1,0,0,0,0],Se:1,Sb:0}));const e=events(rows,3);assert.deepEqual(e.windows,[{start:1,confirmed:3,end:4,censored:false}]);});
test('numerical time-step refinement',()=>{const a=simulate(config('base')),b=simulate(config('base',{step:1/48}));for(let i=1;i<a.length;i++)for(let j=0;j<7;j++)assert.ok(Math.abs(a[i].K[j]-b[i].K[j])<.25);assert.ok(Math.abs(events(a,3).confirm-events(b,3).confirm)<=1);});
test('invalid data rejected',()=>{for(const o of [{speed:NaN},{access:-1},{confirm:0},{mark:-100}])assert.throws(()=>config('base',o));});
console.log(JSON.stringify({tests:count,status:'PASS',type:'structure_not_backtest'}));
