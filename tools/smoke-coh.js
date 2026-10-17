global.self=global; require('/workspace/hpf/meter.js'); const M=global.HPMeter;
function rng(s){return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296}}
function run(amp,N,seed){const H=128,W=128,r=rng(seed);const c=new M.Coh(H,W,M.CH_ALL.slice());
for(let k=0;k<N;k++){const a=new Uint8Array(H*W*3);for(let y=0;y<H;y++)for(let x=0;x<W;x++){
 const base=128+40*Math.sin((x+k*13)/(7+k%5))+30*(r()-.5)*2; const m=amp*Math.cos(2*Math.PI*(11*x/W+5*y/H)+0.7);
 for(let ch=0;ch<3;ch++)a[3*(y*W+x)+ch]=Math.max(0,Math.min(255,Math.round(base+m+10*(r()-.5))));}
 c.feed(a,W,H);}
const e=c.evaluate(0.01);return [amp,N,e.verdict,e.cstar.toFixed(3),e.bins.slice(0,2).map(b=>b.fy+','+b.fx+' C='+b.C.toFixed(2)).join(' ')];}
for(const [a,n] of [[0,40],[0.5,40],[1,40],[2,40],[1,100]])console.log(run(a,n,7).join(' | '));
