# Synthesises a warm, modern "uplifting cinematic pop" bed for the Reel (no samples, no licensing): felt-piano arpeggios,
# a slow string-like pad, soft kick/clap/shaker, a sub bass and a room reverb. 100 BPM, C-G-Am-F.
# Usage: python3 -I music-cinematic.py out.wav [duration=44] [logo_at=2.5] [cta_at=39.25]
import sys, wave
import numpy as np

SR = 44100
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 44.0
LOGO = float(sys.argv[3]) if len(sys.argv) > 3 else 2.5
CTA = float(sys.argv[4]) if len(sys.argv) > 4 else 39.25
BPM = 100; BEAT = 60 / BPM; BAR = 4 * BEAT
N = int(SR * DUR)
rng = np.random.default_rng(11)
dry = np.zeros((2, N))   # drums/bass stay out of the reverb
wet = np.zeros((2, N))   # melodic parts go through the room

def put(buf, t, sig, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= N or i < 0: return
    j = min(N, i + sig.shape[-1])
    if sig.ndim == 2:                       # already stereo (the pad)
        buf[:, i:j] += sig[:, : j - i] * gain
    else:                                   # mono, placed with an equal-power-ish pan
        buf[0, i:j] += sig[: j - i] * gain * (0.5 + 0.5 * (1 - pan)) * 0.7071
        buf[1, i:j] += sig[: j - i] * gain * (0.5 + 0.5 * (1 + pan)) * 0.7071

mf = lambda m: 440 * 2 ** ((m - 69) / 12)

def piano(f, d=1.8):
    L = int(d * SR); t = np.arange(L) / SR; y = np.zeros(L)
    for k in range(1, 8):
        fk = f * k * (1 + 0.0004 * k * k)        # slight inharmonicity, like a real string
        y += (1 / k ** 1.25) * np.sin(2 * np.pi * fk * t + k) * np.exp(-t * (1.6 + 1.7 * k))
    y *= np.minimum(t / 0.004, 1)
    hammer = rng.standard_normal(L) * np.exp(-t * 400) * 0.03   # felt thump
    return (y + hammer) * 0.55

def lowpass(x, fc):
    X = np.fft.rfft(x); fr = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / (1 + (fr / fc) ** 4); return np.fft.irfft(X, len(x))

def pad(notes, d):
    L = int(d * SR); t = np.arange(L) / SR; y = np.zeros((2, L))
    for n_i, m in enumerate(notes):
        for c, det in enumerate((-0.0035, 0.0035)):
            for dd in (-0.006, 0, 0.006):
                f = mf(m) * (1 + det + dd)
                y[c] += 2 * ((f * t) % 1) - 1          # saw
    y = np.stack([lowpass(y[0], 1300), lowpass(y[1], 1300)]) / (len(notes) * 5)
    env = np.minimum(t / 0.9, 1) * np.minimum((d - t) / 0.9, 1)
    return y * env

def kick():
    L = int(0.32 * SR); t = np.arange(L) / SR
    ph = 2 * np.pi * np.cumsum(46 + 90 * np.exp(-t * 28)) / SR
    return np.sin(ph) * np.exp(-t * 9) * np.minimum(t / 0.002, 1)

def clap():
    L = int(0.25 * SR); t = np.arange(L) / SR
    n = rng.standard_normal(L)
    n = n - lowpass(n, 900)                                  # high-passed
    env = np.exp(-t * 22) + 0.6 * np.exp(-((t - 0.012) ** 2) * 30000) + 0.5 * np.exp(-((t - 0.024) ** 2) * 30000)
    return lowpass(n, 6500) * env * 0.5

def shaker(accent=1.0):
    L = int(0.09 * SR); t = np.arange(L) / SR
    n = rng.standard_normal(L); n = n - lowpass(n, 5000)
    return n * np.exp(-t * 55) * np.minimum(t / 0.01, 1) * 0.28 * accent

def bass(f, d):
    L = int(d * SR); t = np.arange(L) / SR
    y = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
    return y * np.minimum(t / 0.01, 1) * np.exp(-t * 2.2) * 0.7

PROG = [(48, 52, 55), (43, 47, 50), (45, 48, 52), (41, 45, 48)]   # C  G  Am  F  (root-position triads, octave 3)
PATTERN = [0, 1, 2, 3, 2, 1, 2, 1]                                 # eighth-note arpeggio over [r,3,5,8]
MELODY = [76, 74, 72, 69]                                          # E5 D5 C5 A4: one top note per bar

nbars = int(np.ceil(DUR / BAR))
for b in range(nbars):
    t0 = b * BAR
    if t0 >= DUR: break
    ch = PROG[b % 4]; tri = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[0] + 24]
    intro = t0 < LOGO
    big = t0 >= CTA - 0.01
    # arpeggio: quiet in the hook, fuller after the logo, brightest in the finale
    amp = 0.55 if intro else (1.0 if not big else 1.2)
    for k, idx in enumerate(PATTERN):
        tt = t0 + k * BEAT / 2
        if tt >= DUR: continue
        vel = amp * (1.0 if k % 4 == 0 else 0.78 if k % 2 == 0 else 0.62)
        put(wet, tt, piano(mf(tri[idx])), 0.55 * vel, pan=-0.25 if k % 2 else 0.25)
    if not intro:
        put(wet, t0, piano(mf(MELODY[b % 4]), 2.4), 0.5 * amp, pan=0.1)                   # singing top note
        if big: put(wet, t0, piano(mf(MELODY[b % 4] + 12), 2.4), 0.3, pan=-0.1)
        put(wet, t0, pad([m + 12 for m in ch], BAR + 0.5), 0.55 if not big else 0.75)      # string-like pad under the bar
        # drums: kick on 1 & 3, clap on 2 & 4, shaker on the off-beats (16ths in the finale)
        for beat in range(4):
            tb = t0 + beat * BEAT
            if beat in (0, 2): put(dry, tb, kick(), 0.62)
            if beat in (1, 3): put(dry, tb, clap(), 0.5)
            put(dry, tb + BEAT / 2, shaker(1.0), 0.8)
            if big: put(dry, tb + BEAT / 4, shaker(0.5), 0.8); put(dry, tb + 3 * BEAT / 4, shaker(0.5), 0.8)
        put(dry, t0, bass(mf(ch[0] - 12), BEAT * 1.9), 0.55)
        put(dry, t0 + 2 * BEAT, bass(mf(ch[0] - 12), BEAT * 1.9), 0.45)
        put(dry, t0 + 3.5 * BEAT, bass(mf(ch[2] - 12), BEAT * 0.5), 0.3)
    else:
        put(wet, t0, pad([m + 12 for m in ch], BAR + 0.5), 0.25)

# rise into the logo, then an impact on the downbeat
L = int(LOGO * SR); t = np.arange(L) / SR
rise = np.sin(2 * np.pi * np.cumsum(180 + 900 * (t / LOGO) ** 2) / SR) * (t / LOGO) ** 2 * 0.10
noise = rng.standard_normal(L); noise = noise - lowpass(noise, 2000)
rise += noise * (t / LOGO) ** 3 * 0.09
put(wet, 0, rise, 1.0)
L = int(2.0 * SR); t = np.arange(L) / SR
boom = (np.sin(2 * np.pi * 55 * t) * np.exp(-t * 2.4) + 0.4 * np.sin(2 * np.pi * 110 * t) * np.exp(-t * 4)) * 0.8
put(dry, LOGO, boom, 0.9)
put(wet, LOGO, piano(mf(48), 3.0) + piano(mf(64), 3.0) * 0.7, 0.5)
# final chord rings out
put(wet, DUR - 3.4, piano(mf(48), 3.4) + piano(mf(55), 3.4) * 0.8 + piano(mf(64), 3.4) * 0.7 + piano(mf(72), 3.4) * 0.5, 0.6)

# room reverb on the melodic bus
IRL = int(2.2 * SR); ti = np.arange(IRL) / SR
ir = np.stack([rng.standard_normal(IRL), rng.standard_normal(IRL)]) * np.exp(-ti * 2.6)
ir = np.stack([lowpass(ir[0], 5500), lowpass(ir[1], 5500)]) * (np.minimum(ti / 0.02, 1))
ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
size = 1 << int(np.ceil(np.log2(N + IRL)))
rev = np.stack([np.fft.irfft(np.fft.rfft(wet[c], size) * np.fft.rfft(ir[c], size), size)[:N] for c in range(2)])
mix = dry + 0.72 * wet + 0.5 * rev
mix *= np.minimum(1, (DUR - np.arange(N) / SR) / 1.8)                        # fade the tail
mix = np.tanh(mix * 1.15) / np.tanh(1.15)
mix *= 0.89 / max(np.abs(mix).max(), 1e-6)
w = wave.open(sys.argv[1], 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((mix.T * 32767).astype(np.int16).tobytes()); w.close()
print('wrote', sys.argv[1], f'{DUR:.1f}s peak', round(float(np.abs(mix).max()), 3))
