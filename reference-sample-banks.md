# Strudel Sample Banks & Sound Sources Reference

## Drum Machine Banks (.bank("name"))

72 banks from tidal-drum-machines library. All use standardized sample names: bd, sd, hh, oh, cp, cr, rd, ht, mt, lt, rim, etc.

### Roland
- RolandTR808, RolandTR909, RolandTR505, RolandTR606, RolandTR626, RolandTR707, RolandTR727
- RolandCompurhythm78, RolandCompurhythm1000, RolandCompurhythm8000
- RolandR8, RolandMC202, RolandMC303, RolandDDR30
- RolandD110, RolandD70, RolandJD990, RolandMT32, RolandS50
- RolandSH09, RolandSystem100

### Linn
- LinnDrum, LinnLM1, LinnLM2, Linn9000

### Akai
- AkaiLinn, AkaiMPC60, AkaiXR10

### Boss
- BossDR55, BossDR110, BossDR220, BossDR550, BossDR660

### Korg
- KorgDDM110, KorgKPR77, KorgKR55, KorgKRZ, KorgM1, KorgMinipops, KorgPoly800, KorgT3

### Yamaha
- YamahaRM50, YamahaRX21, YamahaRX5, YamahaRY30, YamahaTG33

### Emu
- EmuDrumulator, EmuModular, EmuSP12

### Casio
- CasioRZ1, CasioSK1, CasioVL1

### Simmons
- SimmonsSDS400, SimmonsSDS5

### Others
- AlesisHR16, AlesisSR16
- DoepferMS404
- MFB512, MPC1000
- MoogConcertMateMG1
- OberheimDMX
- RhodesPolaris, RhythmAce
- SakataDPM48
- SequentialCircuitsDrumtracks, SequentialCircuitsTom
- SergeModular
- SoundmastersR88
- UnivoxMicroRhythmer12
- ViscoSpaceDrum
- XdrumLM8953

---

## Dirt-Samples Library (s("name"))

221 sample folders inherited from SuperDirt/Tidal Cycles.

### Kicks
bd, kicklinn, clubkick, hardkick, popkick, reverbkick, 808bd

### Snares/Claps
sd, cp, sn, realclaps

### Hi-hats
hh, hh27, linnhats, oh, hc

### 808 Family
808, 808bd, 808cy, 808hc, 808ht, 808lc, 808lt, 808mc, 808mt, 808oh, 808sd

### Bass
bass, bass0, bass1, bass2, bass3, bassdm, bassfoo, jvbass, jungbass

### Synth/Pads
pad, padlong, rave, rave2, ravemono

### Melodic/Tonal
arpy, arp, pluck, notes, newnotes, casio, juno, moog, sitar, sax

### Electronic/FX
glitch, glitch2, electro1, industrial, noise, noise2, bleep, blip, future, stab, hoover

### Rave/Dance
rave, rave2, ravemono, gabba, gabbaloud, gabbalouder, jungle, hardcore, techno, tech

### Breakbeats
breaks125, breaks152, breaks157, breaks165, amencutup

### Percussion
perc, tabla, tabla2, tablex, rim, cb (cowbell), cr (crash), rd (ride), ht, mt, lt, rs

### Vocal/Speech
speech, speechless, speakspell, numbers, alphabet

### Other Notable
metal, space, wind, fire, birds, birds3, coins, can, bottle, mouth, sid, simplesine, dr, dr2, dr55, drum, drumtraks, gretsch, hand, hit, tok, tink

---

## Synth Engines (s("name"))

### Basic Oscillators
sine, sawtooth, square, triangle

### Noise Generators
white, pink, brown, crackle

### ZZFX Micro Synth
z_sawtooth, z_sine, z_square, z_tan, z_noise

### Wavetable Synthesis (AKWF, 1000+ waveforms)
All prefixed with wt_ (e.g., wt_flute, wt_saw, wt_piano, etc.)

### Custom Synthesis
user (define custom waveforms via partials)

### Synthesis Parameters
- FM synthesis: fm, fmh, fmattack, fmdecay, fmsustain, fmenv
- Additive synthesis: partials, phases
- Vibrato: vib / vibrato

---

## GM (General MIDI) Instrument Samples

Prefixed with gm_, loaded from VCSL. NOTE: These may not produce audible output reliably in all Strudel configurations.

- gm_pad_sweep, gm_pad_halo, gm_pad_new_age, gm_pad_warm, gm_pad_poly, gm_pad_bowed, gm_pad_metallic, gm_pad_choir
- gm_synth_choir, gm_choir_aahs, gm_voice_oohs
- gm_fx_crystal, gm_fx_atmosphere, gm_fx_echoes, gm_fx_soundtrack, gm_fx_brightness, gm_fx_rain
- gm_string_ensemble_1, gm_string_ensemble_2, gm_tremolo_strings
- gm_lead_2_sawtooth, gm_lead_6_voice
- Plus full General MIDI 128 instrument set

---

## External Sound Sources

### Shabda / Freesound Integration
```
samples('shabda:choir:4,vocal:4,diva:2')
s("choir").slow(2)
```
NOTE: Search results are unpredictable - "diva" may return sound effects instead of vocals.

### Text-to-Speech
```
samples('shabda/speech:feel_the_music')
samples('shabda/speech/en-GB/f:take_me_higher')
```

### External URL Loading
```
samples({ diva: ['https://example.com/vocal.wav'] })
samples('github:username/my-samples')
```

### MIDI
- midi() for output to hardware synths
- midiin() for CC input from controllers

---

## Trance/Electronic Recommended Combos

- **Kicks:** RolandTR909 (standard), RolandTR808 (heavier sub), clubkick, hardkick
- **Hats/Cymbals:** RolandTR909, RolandTR707
- **Bass:** sawtooth oscillator + filter envelope (303 acid), jvbass
- **Pads:** sawtooth with long attack/release + reverb, padlong samples
- **Leads:** sawtooth stacked with superimpose for supersaw, wt_* wavetables
- **Vocal Texture:** .vowel("<a e i o>") on sawtooth (most reliable)
- **Rave Hits:** rave, stab, hoover
- **Risers:** white/pink noise with filter sweep
- **FX:** Space, delay feedback, room/size reverb
