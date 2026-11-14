/** Original conditional model v2. K: capital-index points, t: months.
 * annual % /1200; one-off bp /10000; covariance annual /12. NOT fitted data. */
export const ASSETS=['美国股票','美国债券','中国风险股票','中国风险债券','黄金','第三地资产','美元现金'];
export const COLORS=['#5590ff','#98b6ee','#33c5ac','#91ded0','#edbb63','#ae99e0','#ccd5df'];
export const INITIAL=[30,20,15,10,5,10,10];
export const DEFAULT={gap0:-3.5,gapEnd:3,bond0:-2.4,bondEnd:1.8,tau:12,fx:0,friction:.6,costUC:8,costCU:12,speed:.65,access:1,tight:1.1,tightEnd:.35,cashShock:0,policy:1,threshold:.5,gamma:2.5,confirm:3,months:36,mark:0,step:1/24};
export const PRESETS={base:{label:'缓慢再平衡',brief:'相对回报渐修复，融资压力逐步缓解',params:{}},repair:{label:'回报修复加快',brief:'回报优势更快扩大，通道保持开放',params:{gapEnd:5,bondEnd:3,tau:6,tightEnd:.15}},sticky:{label:'美国优势延续',brief:'中国回报差未转正，融资压力持续',params:{gapEnd:-1.5,bondEnd:-1,tau:18,tightEnd:1.1}},cash:{label:'美元现金挤兑',brief:'现金需求上升，自愿迁移与强制出售分离',params:{cashShock:1,tight:1.8,tightEnd:.7,tau:18,gapEnd:1.5,bondEnd:.9}}};
export const FACTORS=[[.14,.05,0],[.01,-.055,0],[.16,0,.075],[.015,-.03,.018],[-.02,-.045,.025],[.12,.025,.025],[0,0,0]];
export const IDIO=[.09,.025,.12,.025,.12,.085,0];
export const COV=FACTORS.map((a,i)=>FACTORS.map((b,j)=>(a.reduce((s,x,k)=>s+x*b[k],0)+(i===j?IDIO[i]**2:0))/12));
const sum=a=>a.reduce((s,x)=>s+x,0),clip=(x,a=0,b=1)=>Math.max(a,Math.min(b,x)),cn=i=>i===2||i===3,us=i=>i===0||i===1;
const sigmoid=x=>1/(1+Math.exp(-clip(x,-35,35)));
export function config(preset='base',overrides={}){const p={...DEFAULT,...(PRESETS[preset]?.params||{}),...overrides};validate(p);return p;}
export function validate(p){for(const k of Object.keys(DEFAULT))if(!Number.isFinite(p[k]))throw Error('非有限参数：'+k);for(const k of ['tau','speed','threshold','gamma','months','step'])if(p[k]<=0)throw Error('参数须为正：'+k);if(p.step>.25||p.months>60||p.months<3||!Number.isInteger(p.months)||p.confirm<1||p.confirm>12||!Number.isInteger(p.confirm)||p.access<0||p.access>1||p.policy<0||p.policy>1||p.speed>3||p.friction<0||p.costUC<0||p.costCU<0||p.tight<0||p.tightEnd<0||p.cashShock<0||p.cashShock>2||p.mark<=-100)throw Error('参数超出可计算范围');if(Math.abs(1/p.step-Math.round(1/p.step))>1e-8)throw Error('时间步必须整分一个月');}
export function drivers(t,p){const e=Math.exp(-t/p.tau);return {gap:p.gapEnd+(p.gap0-p.gapEnd)*e,bondGap:p.bondEnd+(p.bond0-p.bondEnd)*e,I:p.tightEnd+(p.tight-p.tightEnd)*e,Z:p.cashShock*Math.exp(-t/(p.tau*1.4))};}
export function stateDerivative(s,d,p){const [H,P,R]=s;return [(.22+.40*R)*(1-H)-.65*d.I*H,(.22*(1-H)+.32*d.Z)*(1-P)-(.12+.28*R)*P,.45*(p.policy*sigmoid((P-p.threshold)/.09)-R)];}
export function advantage(K,s,t,p){const W=sum(K),w=K.map(x=>x/W),d=drivers(t,p),P=s[1];const annual=[8,4.5,8+d.gap+p.fx,4.5+d.bondGap+p.fx,4.5,6.5,3];const exit=[2*P,.25*P,p.friction+3*P,p.friction*.5+.5*P,.2*P,2*P,0];const mu=annual.map(x=>x/1200),chi=exit.map(x=>x/1200),risk=COV.map(r=>p.gamma*r.reduce((a,x,i)=>a+x*w[i],0));return {g:mu.map((x,i)=>x-chi[i]-risk[i]),mu,chi,risk,d,w,W};}
export function cost(i,j,p){if(us(i)&&cn(j))return p.costUC/10000;if(cn(i)&&us(j))return p.costCU/10000;return 3/10000;}
export function flowRates(K,s,t,p,dt=p.step){
 const a=advantage(K,s,t,p),[H,P]=s,{W,g,d}=a;const floor=clip(.08+.08*P+.40*d.Z,.05,.75),gap=Math.max(0,floor*W-K[6]);
 const f=Array.from({length:7},()=>Array(7).fill(0)),forced=f.map(r=>r.slice()),phi=H/(H+.30),nu=p.speed*phi;
 for(let i=0;i<7;i++){const q=Array(7).fill(0);for(let j=0;j<7;j++)if(i!==j){const access=(cn(i)||cn(j))?p.access:1;q[j]=access*Math.max(0,g[j]-g[i]-cost(i,j,p))/.001;}const denom=1+sum(q),available=i===6?Math.max(0,K[6]-floor*W):K[i];for(let j=0;j<7;j++)f[i][j]=nu*available*q[j]/denom;}
 const eligible=K.map((k,i)=>i===6?0:k*(cn(i)?p.access:1)),E=sum(eligible);if(E>0&&gap>0)for(let i=0;i<6;i++){forced[i][6]=1.4*gap*eligible[i]/E;f[i][6]+=forced[i][6];}
 for(let i=0;i<7;i++){const outgoing=sum(f[i]);if(outgoing*dt>K[i]){const scale=K[i]/(outgoing*dt);f[i]=f[i].map(x=>x*scale);forced[i]=forced[i].map(x=>x*scale);}}
 const net=Array(7).fill(0);let L=0,J=0;for(let i=0;i<7;i++)for(let j=0;j<7;j++){const x=f[i][j];net[i]-=x;net[j]+=x;L+=x;if(us(i)&&cn(j))J+=x;if(cn(i)&&us(j))J-=x;}
 return {...a,f,net,L,J,v:L/W,D:L>1e-12?J/L:null,forced:sum(forced.flat()),cashFloor:floor,Se:(g[2]-g[0]-cost(0,2,p))*10000,Sb:(g[3]-g[1]-cost(1,3,p))*10000};
}
export function summarize(K,s,t,p,f,Wavg,forced=0,G=0){const a=flowRates(K,s,t,p),net=Array(7).fill(0);let L=0,J=0;for(let i=0;i<7;i++)for(let j=0;j<7;j++){const x=f[i][j];net[i]-=x;net[j]+=x;L+=x;if(us(i)&&cn(j))J+=x;if(cn(i)&&us(j))J-=x;}return {month:t,K:K.slice(),W:sum(K),w:K.map(x=>x/sum(K)),H:s[0],P:s[1],R:s[2],L,J,v:L/Wavg,D:L>1e-12?J/L:null,net,f,forced,G,Se:a.Se,Sb:a.Sb,cashFloor:a.cashFloor,g:a.g,mu:a.mu,chi:a.chi,risk:a.risk,gap:a.d.gap};}
export function simulate(p,initial=INITIAL){
 validate(p);if(initial.length!==7||initial.some(x=>!Number.isFinite(x)||x<0)||sum(initial)<=0)throw Error('初始配置非法');let K=initial.slice(),s=[.72,.28,.08],t=0;const a=flowRates(K,s,0,p),rows=[summarize(K,s,0,p,a.f,sum(K),a.forced)];
 for(let m=1;m<=p.months;m++){const oldW=sum(K),acc=Array.from({length:7},()=>Array(7).fill(0));let forced=0,G=0;for(let k=0;k<Math.round(1/p.step);k++){const dt=p.step,r=flowRates(K,s,t,p,dt);for(let i=0;i<7;i++)for(let j=0;j<7;j++)acc[i][j]+=r.f[i][j]*dt;forced+=r.forced*dt;K=K.map((x,i)=>Math.max(0,x+dt*r.net[i]));const q=Math.expm1(Math.log1p(p.mark/100)*dt/12);G+=sum(K)*q;K=K.map(x=>x*(1+q));const ds=stateDerivative(s,r.d,p);s=s.map((x,i)=>clip(x+dt*ds[i]));t=(m-1)+(k+1)*dt;}rows.push(summarize(K,s,m,p,acc,(oldW+sum(K))/2,forced,G));}return rows;
}
export function events(rows,m=3){
 const eps=1e-7;let negative=false,flip=null,run=0,confirm=null,start=null,windows=[];const initialPositive=rows[0].J>eps;
 for(const r of rows){if(r.J< -eps)negative=true;if(negative&&r.J>eps&&flip===null)flip=r.month;if(r.month===0)continue;const yes=r.J>eps&&r.net[2]+r.net[3]>eps&&r.net[0]+r.net[1]<-eps;if(yes){run++;if(run===1)start=r.month;if(run===m){if(confirm===null)confirm=r.month;windows.push({start,confirmed:r.month,end:null,censored:true});}}else{if(run>=m){windows.at(-1).end=r.month-1;windows.at(-1).censored=false;}run=0;start=null;}}
 const triggered=key=>{if(rows[0][key]>0)return 0;const x=rows.find(r=>r[key]>0);return x?.month??null;};return {flip,confirm,windows,initialPositive,equityTrigger:triggered('Se'),bondTrigger:triggered('Sb')};
}
export function sensitivity(p){const outcomes=[];for(const dg of [-1,0,1])for(const speed of [.7,1,1.3])for(const c of [.7,1,1.3]){const q={...p,gapEnd:p.gapEnd+dg,speed:p.speed*speed,costUC:p.costUC*c,costCU:p.costCU*c};const e=events(simulate(q),p.confirm);outcomes.push({gapEnd:q.gapEnd,speed:q.speed,costUC:q.costUC,confirmed:e.confirm});}const hit=outcomes.filter(x=>x.confirmed!==null).map(x=>x.confirmed);return {n:outcomes.length,hit:hit.length,miss:outcomes.length-hit.length,early:hit.length?Math.min(...hit):null,late:hit.length?Math.max(...hit):null,outcomes};}
