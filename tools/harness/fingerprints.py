"""Averaged noise-residual spectra per source (Corvi et al. 2023 style). Local data only."""
from PIL import Image as _I; _I.MAX_IMAGE_PIXELS=None
import glob,random,json,numpy as np
from PIL import Image,ImageDraw
from PIL import ImageFilter
D='/workspace/hpf-data'; S=512; random.seed(0)
b100=sorted(glob.glob(f'{D}/synthid/b100/*.png'))
info=json.load(open(f'{D}/synthid/b100_info.json'))
src={
 'Camera (Commons JPEG)':glob.glob(f'{D}/synthid/commons/*.jpg'),
 'Camera (photos set)':glob.glob(f'{D}/photos/*.jpg'),
 'NB Pro step1 (B100 PNG)':[f for f in b100 if info.get('b100/'+f.split('/')[-1],info.get(f,{})).get('step')==1],
 'NB Pro all steps (B100)':random.sample(b100,min(200,len(b100))),
 'NB2 via X (JPEG q85)':[f for f in glob.glob(f'{D}/synthid/raw/*') if f.endswith(('.jpg','.jpeg','.png'))],
 'Photo + SD1 dwtDct mark':glob.glob(f'{D}/sets/g*/dwtdct_sd1/*'),
}
def res(f):
    im=Image.open(f)
    if im.size[0]*im.size[1]>8e7: return None
    a=np.asarray(im.convert('RGB'),np.float32)[...,1]
    H,W=a.shape
    if min(H,W)<S: return None
    y=(H-S)//2//8*8; x=(W-S)//2//8*8; a=a[y:y+S,x:x+S]
    F=np.fft.fft2(a-a.mean()); f=np.fft.fftfreq(S); g=np.exp(-2*(np.pi*1.5)**2*(f[:,None]**2+f[None,:]**2))
    return np.abs(np.fft.fftshift(F*(1-g)))**2  # residual = a - gaussian_blur(sigma=1.5)
tiles=[];stats={}
for name,fs in src.items():
    acc=[r for r in map(res,fs) if r is not None]
    stats[name]=len(acc)
    if not acc: continue
    P=np.log(np.mean(acc,0)+1e-6); P=(P-np.percentile(P,1))/(np.percentile(P,99.8)-np.percentile(P,1))
    t=Image.fromarray((255*P.clip(0,1)).astype('uint8')).convert('RGB')
    ImageDraw.Draw(t).text((6,6),f'{name}  N={len(acc)}',fill=(255,255,0)); tiles.append(t)
W=Image.new('RGB',(S*3,S*((len(tiles)+2)//3)))
for i,t in enumerate(tiles): W.paste(t,((i%3)*S,(i//3)*S))
W.save('shots/fingerprints.png'); print(stats)
