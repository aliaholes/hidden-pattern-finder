"""Build same-size RGB PNG sets from the reverse-SynthID HF dataset (aoxo/reverse-synthid, downloaded locally) and
matched controls (Commons camera crops, DALL-E 3 crops). Centre crops aligned to 16 px; never resized. Local data only.
usage: python prep_rsid.py [DATA]   -> DATA/rsid/sets/<name>/*.png and DATA/rsid/config.json for synthid_analyze.js"""
import glob,json,os,sys
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
D=sys.argv[1] if len(sys.argv)>1 else '/workspace/hpf-data'; R=f'{D}/rsid'; F=f'{R}/files'; OUT=f'{R}/sets'
def crop(im,W,H):
    w,h=im.size; x=(w-W)//2//16*16; y=(h-H)//2//16*16; return im.crop((x,y,x+W,y+H))
def build(name,files,W,H,limit=None):
    d=f'{OUT}/{name}'; os.makedirs(d,exist_ok=True); out=[]
    for f in files:
        im=Image.open(f)
        if im.size[0]<W or im.size[1]<H: continue
        p=f'{d}/{len(out):04d}.png'
        if not os.path.exists(p): crop(im.convert('RGB'),W,H).save(p)
        out.append(p)
        if limit and len(out)>=limit: break
    print(name,len(out)); return out
g=lambda pat: sorted(glob.glob(f'{F}/{pat}'))
colors=['black','blue','gray','green','red','white']
commons=sorted(glob.glob(f'{D}/synthid/commons/*.jpg'))
S={}
S['nbpro_solid1024']=build('nbpro_solid1024',sum([g(f'nano-banana-pro-preview/{c}/1024x1024/*') for c in colors],[]),1024,1024)
S['g31_solid1024']=build('g31_solid1024',sum([g(f'gemini-3.1-flash-image-preview/{c}/1024x1024/*') for c in colors],[]),1024,1024)
S['dalle_solid1024']=build('dalle_solid1024',sum([g(f'dall-e-3/{c}/1024x1024/*') for c in colors],[]),1024,1024)
S['g_white1024']=build('g_white1024',[f for f in g('gemini_white/*') if Image.open(f).size==(1024,1024) and f.lower().endswith('.png')],1024,1024)
S['g_black1024']=build('g_black1024',[f for f in g('gemini_black/*') if Image.open(f).size==(1024,1024)],1024,1024)
S['commons_1024']=build('commons_1024',commons,1024,1024,120)
import numpy as np
def synth(name,levels,n,W,H):  # synthetic blank control: flat level + Gaussian noise (sigma 1.5), quantised, same PNG encoder path
    d=f'{OUT}/{name}'; os.makedirs(d,exist_ok=True); out=[]; rng=np.random.default_rng(7)
    for i in range(n):
        p=f'{d}/{i:04d}.png'
        if not os.path.exists(p):
            a=np.clip(np.round(levels[i%len(levels)]+rng.normal(0,1.5,(H,W,3))),0,255).astype(np.uint8); Image.fromarray(a).save(p)
        out.append(p)
    print(name,len(out)); return out
S['synth_blank1024']=synth('synth_blank1024',[3,252,128,60,190],100,1024,1024)
S['nbpro_div']=build('nbpro_div',g('nano-banana-pro-preview/diverse/1408x768/*'),1408,768)
S['g31_div']=build('g31_div',g('gemini-3.1-flash-image-preview/diverse/1408x768/*'),1408,768)
S['dalle_div_crop']=build('dalle_div_crop',g('dall-e-3/diverse/1792x1024/*'),1408,768)
S['commons_1408']=build('commons_1408',commons,1408,768,120)
S['g_random']=build('g_random',g('gemini_random/*'),2816,1536)
S['commons_2816']=build('commons_2816',commons,2816,1536,120)
cfg={'sets':{k:{'files':v} for k,v in S.items()},
 'vs':[['nbpro_div','commons_1408'],['nbpro_div','dalle_div_crop'],['g31_div','commons_1408'],['g31_div','dalle_div_crop'],
       ['dalle_div_crop','commons_1408'],['commons_1408','dalle_div_crop'],
       ['g_random','commons_2816'],['commons_2816','g_random'],
       ['nbpro_solid1024','dalle_solid1024'],['g31_solid1024','dalle_solid1024'],['g_white1024','commons_1024'],['g_black1024','commons_1024'],['dalle_solid1024','commons_1024'],['nbpro_solid1024','synth_blank1024'],['g31_solid1024','synth_blank1024'],['g_white1024','synth_blank1024'],['g_black1024','synth_blank1024'],['dalle_solid1024','synth_blank1024']],
 'split':['nbpro_solid1024','g31_solid1024','dalle_solid1024','synth_blank1024','nbpro_div','g31_div','g_random','g_white1024','g_black1024','commons_1408','dalle_div_crop'],
 'cross':[['nbpro_div','g31_div'],['nbpro_div','dalle_div_crop'],['g31_div','dalle_div_crop'],['g_white1024','g_black1024'],['nbpro_solid1024','g31_solid1024']],
 'topK':200,'splits':20}
json.dump(cfg,open(f'{R}/config.json','w'),indent=0)
