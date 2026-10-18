"""Banana100 chain analysis: FFT of D = step100 - step1 per complete run, common 1504x1504 center crop.
Writes detailed per-peak data to DATA/chain_fft_local.json (local only); prints coarse summary."""
import json,sys,numpy as np,random
from PIL import Image
DATA=sys.argv[1] if len(sys.argv)>1 else '/workspace/hpf-data/synthid'
info=json.load(open(f'{DATA}/b100_info.json'))
by={}
for f,v in info.items(): by.setdefault((v['seed'],v['run']),{})[v['step']]=f
S=1504
def load(f):
    a=np.asarray(Image.open(f).convert('RGB'),np.float32)
    H,W=a.shape[:2]; y=(H-S)//2//16*16; x=(W-S)//2//16*16
    return a[y:y+S,x:x+S,1]
win=np.outer(np.hanning(S),np.hanning(S))
def spec(d):
    d=d-d.mean(); P=np.abs(np.fft.fftshift(np.fft.fft2(d*win)))**2
    # whiten by radial median
    c=S//2; yy,xx=np.indices(P.shape); r=np.hypot(yy-c,xx-c).astype(int)
    med=np.array([np.median(P[r==k]) if (r==k).any() else 1 for k in range(r.max()+1)])
    return P/(med[r]+1e-9)
specs={}
for (seed,run),st in by.items():
    if 1 in st and 100 in st:
        specs.setdefault(seed,[]).append(spec(load(st[100])-load(st[1])))
seeds=sorted(specs); print('seeds',len(seeds),'chains',sum(len(v) for v in specs.values()))
per={s:np.mean(v,0) for s,v in specs.items()}
c=S//2
def peaks(P,k=20):
    Q=P.copy(); Q[c-3:c+4,c-3:c+4]=0; Q[:, :c]=0  # half-plane
    out=[]
    for _ in range(k):
        i=np.unravel_index(np.argmax(Q),Q.shape); fy,fx=i[0]-c,i[1]-c
        f=np.hypot(fx,fy)/S; out.append(dict(fx=int(fx),fy=int(fy),snr=float(Q[i]),period_px=float(1/f),angle_deg=float(np.degrees(np.arctan2(-fy,fx)))))
        Q[max(0,i[0]-4):i[0]+5,max(0,i[1]-4):i[1]+5]=0
    return out
res={s:peaks(per[s]) for s in seeds}
for s in seeds:
    p=res[s][:3]; print(s,len(specs[s]),[(round(q['period_px'],1),round(q['angle_deg']),round(q['snr'])) for q in p])
allP=np.mean([per[s] for s in seeds],0); res['ALL']=peaks(allP,30)
print('ALL',[(round(q['period_px'],1),round(q['angle_deg']),round(q['snr'],1)) for q in res['ALL'][:10]])
# split-half replication over seeds: top-K bins overlap
def topk(P,K=50):
    Q=P.copy(); Q[c-3:c+4,c-3:c+4]=0; Q[:,:c]=0
    return set(np.argsort(Q.ravel())[-K:])
M=S*S//2; K=50; ov=[]
rng=random.Random(1)
for _ in range(50):
    sh=seeds[:]; rng.shuffle(sh); a,b=sh[:len(sh)//2],sh[len(sh)//2:]
    ov.append(len(topk(np.mean([per[s] for s in a],0),K)&topk(np.mean([per[s] for s in b],0),K)))
print('split-half topK=50 overlap mean',np.mean(ov),'min',min(ov),'chance',K*K/M)
# lead check: power near period 40px, angle +-45 deg
yy,xx=np.indices(allP.shape); fx=xx-c; fy=-(yy-c); f=np.hypot(fx,fy)/S
per_px=np.where(f>0,1/np.maximum(f,1e-9),0); ang=np.degrees(np.arctan2(fy,fx))
for a0 in (45,-45,135,-135):
    m=(abs(per_px-40)<6)&(abs(((ang-a0+180)%360)-180)<8)
    print('lead region',a0,'mean whitened power',float(allP[m].mean()),'max',float(allP[m].max()))
print('global whitened median',float(np.median(allP)),'p99.9',float(np.percentile(allP,99.9)))
json.dump(dict(split_overlap=ov,peaks=res),open(f'{DATA}/chain_fft_local.json','w'))
np.save(f'{DATA}/chain_allP.npy',allP.astype(np.float32))
