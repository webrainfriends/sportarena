# Synthesises the ad's upbeat 124 BPM soundtrack (no samples, no licensing). Usage: python3 music.py out.wav
import numpy as np, sys, wave
SR=48000; DUR=33.0; BPM=124; beat=60/BPM
n=int(SR*DUR); out=np.zeros(n)
def put(t,sig,g=1.0):
    i=int(t*SR); j=min(n,i+len(sig))
    if i<n: out[i:j]+=sig[:j-i]*g
def env(L,a=.005,r=.1):
    t=np.arange(L)/SR; return np.minimum(t/a,1)*np.exp(-t/r)
def kick():
    L=int(.3*SR);t=np.arange(L)/SR;f=120*np.exp(-t*25)+45
    return np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-t*9)
def hat():
    L=int(.05*SR);return np.random.RandomState(1).randn(L)*np.exp(-np.arange(L)/SR*90)
def clap():
    L=int(.18*SR);return np.random.RandomState(2).randn(L)*np.exp(-np.arange(L)/SR*28)
def tone(f,d,k=.25):
    L=int(d*SR);t=np.arange(L)/SR
    w=np.sign(np.sin(2*np.pi*f*t))*.4+np.sin(2*np.pi*f*t)*.6
    return w*env(L,.01,k)
prog=[(57,60,64),(53,57,60),(48,52,55),(55,59,62)]  # Am F C G
mf=lambda m:440*2**((m-69)/12)
intro=3.6
for b in range(int(DUR/beat)+1):
    t=b*beat
    if t>=DUR-.3:break
    full=t>=intro
    if full and b%1==0: put(t,kick(),.9)
    if full and b%2==1: put(t,clap(),.35)
    if full: put(t+beat/2,hat(),.25)
    bar=(b//4)%4; root=prog[bar][0]-12
    if full:
        for k in range(2): put(t+k*beat/2,tone(mf(root),beat/2*.9,.12),.35)
        for k,m in enumerate(prog[bar]): put(t+(k%3)*beat/3,tone(mf(m+12),beat/3*.9,.1),.14)
    elif b%4==0: put(t,kick(),.6)
# riser into logo
L=int(intro*SR);t=np.arange(L)/SR;out[:L]+=np.sin(2*np.pi*np.cumsum(200+t**2*220)/SR)*(t/intro)**2*.18
fade=np.minimum(1,(DUR-np.arange(n)/SR)/1.5);out*=fade
out=np.tanh(out*1.2)*.8
w=wave.open(sys.argv[1],'wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(SR)
w.writeframes((out*32767).astype(np.int16).tobytes());w.close()
