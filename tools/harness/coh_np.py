"""coh_np.py -- a numpy port of meter.js's Many-images test (Coh.evaluate / cohCompare), for big local experiments
where the JS harness is too slow. Same statistic: per-channel high-pass residual (Gaussian sigma 1.5, numpy 'reflect'
edges, 13 taps), unit phasors per rfft bin summed over images, Rayleigh test with Bonferroni over 6 channels x valid
bins at alpha, grid bins (within 1 bin of multiples of H/16, W/16) at a 100x stricter floor, random-shift null
('anchored' = significant and NOT significant after a random per-image circular shift). The shift draws use numpy's
RNG, not meter.js's PCG, so counts can differ slightly from the page; validated against RESULTS.md's sets.
Also: split-half replication by group and cross-set overlap of the top-K bins vs chance. Counts / coarse bands only
go to summary.json; per-bin detail stays in bins_local.json (LOCAL ONLY)."""
import json,math,sys,os,numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
COEF={'R':(1,0,0),'G':(0,1,0),'B':(0,0,1),'Y':(0.299,0.587,0.114),'Cb':(-0.168736,-0.331264,0.5),'Cr':(0.5,-0.418688,-0.081312)}
CH=list(COEF); GRID_STRICT=100
_r=6; _k=np.exp(-0.5*(np.arange(-_r,_r+1)/1.5)**2); _k/=_k.sum()
def blur(a):
    p=np.pad(a,((_r,_r),(0,0)),mode='reflect'); t=sum(_k[j]*p[j:j+a.shape[0]] for j in range(2*_r+1))
    p=np.pad(t,((0,0),(_r,_r)),mode='reflect'); return sum(_k[j]*p[:,j:j+a.shape[1]] for j in range(2*_r+1))
class Acc:
    def __init__(s,H,W,ch=CH,seed=1729):
        s.H,s.W,s.ch=H,W,list(ch); s.N=0; s.U=np.zeros((len(ch),H,W//2+1),np.complex128); s.S=np.zeros_like(s.U); s.rng=np.random.default_rng(seed)
        s.fy=np.fft.fftfreq(H)[:,None]; s.fx=np.fft.rfftfreq(W)[None,:]
    def phasors(s,rgb):
        F=[np.fft.rfft2(rgb[...,c]-blur(rgb[...,c])) for c in range(3)]
        out=[]
        for c in s.ch:
            a,b,d=COEF[c]; g=a*F[0]+b*F[1]+d*F[2]; m=np.abs(g); out.append(np.where(m>1e-6,g/np.maximum(m,1e-300),0))
        return np.stack(out)
    def feed(s,rgb,P=None):
        P=s.phasors(rgb) if P is None else P
        while True:
            dy,dx=s.rng.integers(s.H),s.rng.integers(s.W)
            if dy or dx: break
        ramp=np.exp(-2j*np.pi*(dy*s.fy+dx*s.fx))
        s.U+=P; s.S+=P*ramp; s.N+=1; return P
def masks(H,W):
    y=np.arange(H); fy=np.where(y<=H//2,y,y-H)[:,None]; fx=np.arange(W//2+1)[None,:]
    valid=np.sqrt(fy**2+fx**2)>2.0
    sy,sx=H/16,W/16
    grid=(np.abs(fy-np.round(fy/sy)*sy)<=1+1e-9)|(np.abs(fx-np.round(fx/sx)*sx)<=1+1e-9)
    canon=~(((fx==0)|((W%2==0)&(fx==W//2)))&(y[:,None]>H//2))
    return valid,grid&valid,canon&valid,fy,fx
def evaluate(A,alpha=0.01):
    H,W,N=A.H,A.W,A.N; valid,grid,canon,fy,fx=masks(H,W)
    tests=len(A.ch)*int(valid.sum()); apt=alpha/tests; aptG=apt/GRID_STRICT
    C=np.abs(A.U)/N; Cs=np.abs(A.S)/N
    sig=np.exp(-N*C**2)<apt; sigs=np.exp(-N*Cs**2)<apt; sigG=np.exp(-N*C**2)<aptG
    anch=sig&~sigs&~grid&canon; gs=sigG&~sigs&grid&canon; shared=sig&sigs&~grid&canon
    return dict(N=N,H=H,W=W,tests=tests,cstar=math.sqrt(math.log(1/apt)/N),underpowered=math.sqrt(math.log(1/apt)/N)>=1,
        n_anch=int(anch.any(0).sum()),n_grid_strict=int(gs.any(0).sum()),n_shared=int(shared.any(0).sum()),_anch=anch,_gs=gs,_C=C)
def compare(A,B,alpha=0.01):
    H,W=A.H,A.W; valid,grid,canon,fy,fx=masks(H,W)
    tests=len(A.ch)*int(valid.sum()); apt=alpha/tests; aptG=apt/GRID_STRICT
    a=A.U/A.N; b=B.U/B.N; Ca=np.abs(a); Cs=np.abs(A.S)/A.N
    th=np.where(grid,aptG,apt)
    z=np.abs(a-b)**2/(1/A.N+1/B.N)
    keep=(np.exp(-A.N*Ca**2)<th)&~(np.exp(-A.N*Cs**2)<apt)&(np.exp(-z)<th)&canon
    return dict(n_set_only=int((keep&~grid).any(0).sum()),n_set_only_grid=int((keep&grid).any(0).sum()),_keep=keep,_z=z)
def coarse(fy,fx,H,W):
    p=1/math.hypot(fy/H,fx/W); a=round(math.degrees(math.atan2(fy/H,fx/W))/15)*15
    band='<3 px' if p<3 else '3-6 px' if p<6 else '6-12 px' if p<12 else '12-32 px' if p<32 else '32-100 px' if p<100 else '>100 px'
    return f'{band} @ ~{a}\u00b0'
def where(mask,H,W,top=6):
    idx=np.argwhere(mask.any(0)); c={}
    for y,x in idx:
        fy=y if y<=H//2 else y-H; k=coarse(fy,x,H,W); c[k]=c.get(k,0)+1
    return [f'{k} ({v})' for k,v in sorted(c.items(),key=lambda t:-t[1])[:top]]
def load(f): return np.asarray(Image.open(f).convert('RGB'),np.float64)
def topk(C2,okflat,K):
    v=np.where(okflat,C2.ravel(),-1); return set(np.argpartition(-v,K)[:K].tolist())
def hyper_p(k,K,M):  # P(overlap >= k) for two random K-subsets of M
    from math import comb
    tot=comb(M,K); return sum(comb(K,i)*comb(M-K,K-i) for i in range(k,K+1))/tot if k>0 else 1.0
if __name__=='__main__':
    cfg=json.load(open(sys.argv[1])); OUT=sys.argv[2]; os.makedirs(OUT,exist_ok=True)
    K=cfg.get('topK',200); SPL=cfg.get('splits',20); summ={'sets':{},'vs':[],'split':{},'cross':[]}; loc={'sets':{},'vs':[]}
    full={}; groups={}
    need=set(cfg.get('split',[]))|{n for p in cfg.get('cross',[]) for n in p}
    for name,S in cfg['sets'].items():
        fs=S['files']; g=S.get('groups') or [str(i) for i in range(len(fs))]
        first=load(fs[0]); H,W=first.shape[:2]; A=Acc(H,W); G={}
        for i,f in enumerate(fs):
            im=first if i==0 else load(f)
            if im.shape[:2]!=(H,W): raise SystemExit(f'{f} size mismatch')
            P=A.feed(im)
            if name in need:
                if g[i] not in G: G[g[i]]=np.zeros((2,H,W//2+1),np.complex64),[0]
                G[g[i]][0][:]+=P[[1,3]]; G[g[i]][1][0]+=1   # G and Y channels
            print(f'\r{name} {i+1}/{len(fs)}',end='',file=sys.stderr,flush=True)
        print(file=sys.stderr)
        full[name]=A; groups[name]=G
        ev=evaluate(A); summ['sets'][name]={k:v for k,v in ev.items() if not k.startswith('_')}
        summ['sets'][name].update(groups=len(set(g)),anchored_where=where(ev['_anch'],H,W),grid_where=where(ev['_gs'],H,W))
        loc['sets'][name]={'anch':[[A.ch[c],int(y if y<=H//2 else y-H),int(x),round(float(ev['_C'][c,y,x]),4)] for c,y,x in np.argwhere(ev['_anch'])[:300]]}
    for a,b in cfg.get('vs',[]):
        cm=compare(full[a],full[b]); H,W=full[a].H,full[a].W; valid,grid,canon,_,_=masks(H,W)
        summ['vs'].append(dict(set=a,control=b,n_set_only=cm['n_set_only'],n_set_only_grid=cm['n_set_only_grid'],where=where(cm['_keep']&~grid,H,W),where_grid=where(cm['_keep']&grid,H,W)))
        loc['vs'].append(dict(set=a,control=b,bins=[[full[a].ch[c],int(y if y<=H//2 else y-H),int(x)] for c,y,x in np.argwhere(cm['_keep'])[:300]]))
    def Cgroup(name,keys):
        Usum=sum(groups[name][k][0] for k in keys); n=sum(groups[name][k][1][0] for k in keys); return (np.abs(Usum)/n).max(0)
    for name in cfg.get('split',[]):
        A=full[name]; H,W=A.H,A.W; valid,grid,canon,_,_=masks(H,W); ok=(valid&~grid&canon).ravel(); M=int(ok.sum())
        keys=sorted(groups[name]); rng=np.random.default_rng(11); ov=[]
        for s in range(SPL):
            p=rng.permutation(keys); h=len(p)//2
            ov.append(len(topk(Cgroup(name,p[:h]),ok,K)&topk(Cgroup(name,p[h:]),ok,K)))
        med=int(np.median(ov)); summ['split'][name]=dict(groups=len(keys),K=K,M=M,overlap_mean=float(np.mean(ov)),overlap_min=int(min(ov)),overlap_max=int(max(ov)),chance=K*K/M,p_median_split=hyper_p(med,K,M))
    for a,b in cfg.get('cross',[]):
        A=full[a]; H,W=A.H,A.W
        if (full[b].H,full[b].W)!=(H,W): continue
        valid,grid,canon,_,_=masks(H,W); ok=(valid&~grid&canon).ravel(); M=int(ok.sum())
        ca=Cgroup(a,list(groups[a])); cb=Cgroup(b,list(groups[b])); o=len(topk(ca,ok,K)&topk(cb,ok,K))
        summ['cross'].append(dict(a=a,b=b,K=K,M=M,overlap=o,chance=K*K/M,p=hyper_p(o,K,M)))
    json.dump(summ,open(f'{OUT}/summary.json','w'),indent=1); json.dump(loc,open(f'{OUT}/bins_local.json','w'))
    print(json.dumps(summ,indent=1))
