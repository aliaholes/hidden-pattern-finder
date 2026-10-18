"""Write the file lists used by fp_shots.js (same sources as fingerprints.py) and the Python reference spectra
(log mean residual power, fftshifted, float32) for the JS-vs-Python check. Local data only."""
import glob,json,sys,numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
D=sys.argv[1] if len(sys.argv)>1 else '/workspace/hpf-data'; OUT=f'{D}/fp_check'; S=512
import os; os.makedirs(OUT,exist_ok=True)
info=json.load(open(f'{D}/synthid/b100_info.json'))
step1=sorted(f'{D}/synthid/b100/'+k.split('/')[-1] for k,v in info.items() if v['step']==1)
sets={'nbpro_step1':step1,
 'commons':sorted(glob.glob(f'{D}/synthid/commons/*.jpg')),
 'nb2_x':sorted(f for f in glob.glob(f'{D}/synthid/raw/*') if f.lower().endswith(('.jpg','.jpeg','.png'))),
 'sd_marked':sorted(glob.glob(f'{D}/sets/g*/dwtdct_sd1/*.png')),
 'photos':sorted(glob.glob(f'{D}/photos/*.jpg'))}
json.dump(sets,open(f'{OUT}/lists.json','w'),indent=0)
f=np.fft.fftfreq(S); g=np.exp(-2*(np.pi*1.5)**2*(f[:,None]**2+f[None,:]**2))
def ref(fs):
    acc=np.zeros((S,S)); n=0
    for p in fs:
        im=Image.open(p)
        if min(im.size)<S: continue
        a=np.asarray(im.convert('RGB'),np.float64)[...,1]; H,W=a.shape
        y=(H-S)//2//8*8; x=(W-S)//2//8*8; a=a[y:y+S,x:x+S]
        F=np.fft.fft2(a-a.mean()); acc+=np.abs(F*(1-g))**2; n+=1
    return np.fft.fftshift(np.log(acc/n+1e-6)).astype(np.float32),n
for k in (sys.argv[2:] or ['nbpro_step1','sd_marked']):
    L,n=ref(sets[k]); L.tofile(f'{OUT}/py_{k}.f32'); print(k,n)
print({k:len(v) for k,v in sets.items()})
