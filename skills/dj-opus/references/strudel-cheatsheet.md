# Strudel Syntax Cheatsheet & Critical Rules
## Verified against source code (packages/core, superdough, mini, webaudio, tonal)

## Table of Contents
1. [Critical Bugs](#critical-bugs)
2. [MCP Tool Sequence](#mcp-tool-sequence)
3. [Tempo & Timing](#tempo--timing)
4. [Drums & Samples](#drums--samples)
5. [Synths & Oscillators](#synths--oscillators)
6. [Envelopes](#envelopes)
7. [Filters (LP/HP/BP)](#filters)
8. [Effects](#effects)
9. [Modulation Sources (Signals)](#modulation-sources)
10. [Slider Controls](#slider-controls)
11. [Pattern Composition](#pattern-composition)
12. [Mini Notation](#mini-notation)
13. [Pattern Methods](#pattern-methods)
14. [Music Theory (tonal)](#music-theory)
15. [Vocal Textures](#vocal-textures)
16. [Visuals (draw / hydra)](#visuals)

---

## Critical Bugs

| Rule | What Happens If Broken |
|------|----------------------|
| NO EMOJI in pattern code | Crashes the connection. Use plain text comments only. |
| NO `.mul()` or `.add()` on slider values chained with other patterns | "Can't do arithmetic on control pattern" error. Each element needs its own dedicated slider. |
| `write` with `auto_play: true` = hard cut | No crossfade exists. Build ONE mega-pattern with sliders instead of swapping patterns. |
| GM instruments (soundfonts package) are unreliable | `gm_voice_oohs`, `gm_choir_aahs`, etc. may not produce sound. Use synthesis + `.vowel()` instead. |
| Use `setcps(bpm/60/4)`, NOT `setcpm` | `setcpm` does not exist. Always use `setcps()`. |
| `load` replaces current pattern | The `load` function replaces the current browser pattern. Save first if needed. |

---

## MCP Tool Sequence (DJ Opus MCP at djopus.moore.nyc)

No init needed -- the user's browser connects via WebSocket. Just start writing.

```
1. write         — send pattern code (auto_play: true to play immediately)
2. play / stop   — control playback
3. set_tempo     — adjust BPM without rewriting
4. get_code      — read current pattern from the editor
5. save          — persist pattern with name + tags
6. undo / redo   — history navigation
```

### Quick editing tools (no full rewrite needed):
- `replace_code(search, replace)` — surgical find-and-replace in the pattern
- `append_code(code)` — add code to the end of the pattern
- `add_effect(effect, params?)` — layer an effect onto the pattern

### AI generation tools:
- `compose(style, bpm?, key?)` — fastest path: generate + write + play in one call
- `generate_pattern(style, bpm?, key?)` — generate pattern code
- `generate_drums(style, complexity?)` — generate drum patterns
- `generate_bassline(key, style)` — generate basslines
- `validate(pattern)` — check pattern for errors without playing

### Pattern library:
- `save(name, tags?)` / `load(name, auto_play?)` / `list(tag?)` / `delete(name)`

### State:
- `get_state` — playback status and connected clients
- `get_code` — current pattern code

---

## Tempo & Timing

```javascript
setcps(BPM / 60 / 4)   // Convert BPM to cycles-per-second
// 120 BPM = setcps(0.5)
// 128 BPM = setcps(0.533)
// 140 BPM = setcps(0.583)

.slow(2)   // half speed (stretch over 2 cycles)
.fast(2)   // double speed (compress into half cycle)
.early(0.25)  // shift earlier by quarter cycle
.late(0.25)   // shift later by quarter cycle
```

---

## Drums & Samples

### Drum Machine Banks (72+ available)
```javascript
s("bd").bank("RolandTR909")     // 909 — punchy, classic trance
s("bd").bank("RolandTR808")     // 808 — heavier sub kick
s("bd").bank("RolandTR707")     // 707 — cleaner 90s hats/cymbals
s("bd").bank("LinnDrum")        // LinnDrum — great snares
s("bd").bank("OberheimDMX")     // DMX — classic electro
// Samples: bd, sd, cp, hh, oh, lt, mt, ht, rim, cb, cy, cr, rd

.struct("x x x x")              // rhythm: x = hit, ~ = rest
.gain(0.8)                       // volume 0-1
.speed(1.5)                      // playback speed (pitch shift)
.begin(0).end(0.5)               // sample slice points (0-1)
.loop(1)                         // enable looping
.clip(1)                         // clip at note end
```

### Built-in Samples (no bank needed)
```javascript
s("rave")          // rave stabs — classic 90s
s("rave2")         // more rave stabs
s("hoover")        // the hoover sound
s("stab")          // stab hits
s("pluck")         // plucked sounds
s("pad")           // pad samples
s("padlong")       // long pad samples
s("arpy")          // arp sounds
s("jvbass")        // Juno bass
s("breaks125")     // breakbeat loop @ 125 BPM
s("breaks152")     // breakbeat loop @ 152 BPM
s("gabba")         // gabba kicks
s("jungle")        // jungle breaks
s("techno")        // techno elements
// 808 family: s("808bd"), s("808sd"), s("808cy"), etc.
// Noise: s("white"), s("pink"), s("brown"), s("crackle")
```

### Sample Loading
```javascript
samples('shabda:choir:4,vocal:4')  // Freesound via shabda
samples('shabda/speech/en-GB/f:feel the music')  // text-to-speech
samples('github:user/repo')        // GitHub-hosted samples
samples({ name: ['https://url/sample.wav'] })  // direct URL
```

---

## Synths & Oscillators

### Basic Oscillators (via webaudio OscillatorNode)
```javascript
note("a4").s("sawtooth")   // bright, harmonically rich
note("a4").s("triangle")   // mellow, piano-like
note("a4").s("sine")       // pure, sub-bass
note("a4").s("square")     // hollow, reedy
```

### Supersaw (dedicated AudioWorklet — NOT just superimpose)
```javascript
note("a4").s("supersaw")   // built-in unison sawtooth oscillator
// For manual detuning control, superimpose still works:
.superimpose(x => x.add(0.08))
.superimpose(x => x.add(-0.08))
```

### Pulse / PWM Synthesis (dedicated AudioWorklet)
```javascript
note("a4").s("pulse")
  .pw(0.3)                 // pulse width (0-1), 0.5 = square
  .pwrate(2)               // PWM LFO rate
  .pwsweep(0.4)            // PWM sweep depth
// Great for evolving trance pads — the width modulation adds movement
```

### Wavetable Synthesis (AKWF, 1000+ waveforms)
```javascript
note("a4").s("wt_flute")          // select wavetable by name
  .wt(0.5)                         // wavetable position (0-1)
  .warp(0.3)                       // waveform warping amount
  .warpmode("fold")                // warp algorithm
// Warp modes: asym, bendp, bendm, sync, quant, fold, pwm,
//   orbit, spin, chaos, primes, binary, brownian, reciprocal,
//   wormhole, logistic, sigmoid, fractal, flip
// Position can be modulated with envelope or LFO:
  .wtattack(0.1).wtdecay(0.5).wtsustain(0.3).wtrelease(1)
  .wtenv(1)                         // position envelope amount
// Or LFO:
  .wtrate(0.5).wtdepth(0.3)        // position LFO
```

### FM Synthesis (up to 8 operators)
```javascript
note("a4").s("sine")
  .fm(2)                   // operator 1 modulation depth
  .fmh(3)                  // operator 1 harmonicity ratio
  .fmi(1.5)                // operator 1 modulation index
// Multi-operator:
  .fm2(1.5).fmh2(2)       // operator 2
  .fm3(0.5).fmh3(5)       // operator 3
// ...up to fm8, fmh8, fmi8
// FM envelope per operator:
  .fmattack(0.01).fmdecay(0.3).fmsustain(0).fmrelease(0.1)
// Great for: bells, metallic textures, electric piano, bass
```

### Synth Bass Drum
```javascript
s("sbd")   // dedicated synth bass drum
```

---

## Envelopes

### Amplitude ADSR
```javascript
.attack(0.01)      // onset time (aliases: att)
.decay(0.3)        // fall to sustain (aliases: dec)
.sustain(0.1)      // held level (aliases: sus)
.release(0.5)      // fade after release (aliases: rel)
// Shorthands:
.ad(0.01, 0.3)     // attack + decay only
.ds(0.3, 0.1)      // decay + sustain
.ar(0.01, 0.5)     // attack + release
```

### Pitch Envelope
```javascript
.pitch(1200)        // pitch sweep amount (cents)
.pitchJump(2400)    // pitch jump amount
.pitchJumpTime(0.1) // time for pitch jump
```

---

## Filters

Strudel has three filter types, each with its own ADSR envelope and LFO modulation.
Source: packages/superdough/filter.mjs

### Low-Pass Filter
```javascript
.cutoff(2000)          // cutoff frequency (aliases: lpf, lp)
.resonance(10)         // Q / emphasis
// Filter envelope (per-filter ADSR!):
.lpattack(0.01).lpdecay(0.3).lpsustain(0.2).lprelease(0.5)
.lpenv(4000)           // envelope depth in Hz
// Filter LFO:
.lprate(2)             // LFO rate in Hz
.lpdepth(1000)         // LFO depth in Hz
.lpshape("sine")       // LFO shape
// Or use signal modulation:
.cutoff(sine.range(200, 4000).slow(8))      // smooth sweep
.cutoff(perlin.range(200, 4000).slow(16))   // organic drift
```

### High-Pass Filter
```javascript
.hcutoff(200)          // HPF cutoff (aliases: hpf, hp)
.hresonance(5)         // HPF Q
// Same envelope/LFO system: hpattack, hpdecay, hpsustain, hprelease, hpenv
// Same LFO: hprate, hpdepth, hpshape
```

### Band-Pass Filter
```javascript
.bandf(1000)           // BPF center frequency (aliases: bpf, bp)
.bandq(5)              // BPF Q (aliases: bpq)
// Same envelope/LFO system: bpattack, bpdecay, etc.
```

### DJ Filter (combined LP/HP in one param)
```javascript
.djf(0.5)             // 0=full LP, 0.5=bypass, 1=full HP
// Great for quick filter sweeps without separate LP/HP setup
```

### Filter Options
```javascript
.ftype("24db")         // dual 24dB slope (steeper)
.fanchor(0.5)          // filter anchor point
```

---

## Effects

All confirmed in packages/superdough/ source.

### Reverb
```javascript
.room(0.8)             // reverb wet mix (0-1)
.roomsize(0.9)         // room size (aliases: size)
.roomlp(8000)          // reverb lowpass
.roomdim(4000)         // reverb dampening
.roomfade(0.1)         // reverb fade time
// Impulse response reverb:
.ir("path/to/impulse")
```

### Delay (orbit-level, shared per orbit)
```javascript
.delay(0.4)            // delay wet mix
.delaytime(3/8)        // delay time (in cycles)
.delayfeedback(0.4)    // feedback amount (aliases: delayfb)
```

### Distortion (WaveShaperNode)
```javascript
.distort(0.5)          // distortion amount
.distortvol(0.8)       // post-distortion gain
```

### Bit Crush (AudioWorklet)
```javascript
.crush(8)              // bit depth reduction (lower = crunchier)
```

### Coarse (AudioWorklet)
```javascript
.coarse(4)             // sample rate reduction / quantization
```

### Waveshape (AudioWorklet)
```javascript
.shape(0.5)            // waveshaping distortion
.shapevol(0.8)         // post-shape gain
```

### Phaser
```javascript
.phaser(1)             // enable phaser
.phaserrate(0.5)       // phaser LFO rate
.phaserdepth(0.8)      // phaser depth
.phasercenter(1000)    // center frequency
.phasersweep(2000)     // sweep range
```

### Tremolo
```javascript
.tremolo(1)            // enable tremolo
.tremolodepth(0.5)     // depth
.tremolorate(4)        // LFO rate (via tremoloshape/tremoloskew)
.tremolophase(0)       // LFO phase
```

### Compressor
```javascript
.compressor(-20)       // threshold in dB
.compressorRatio(4)    // ratio
.compressorKnee(5)     // knee in dB
.compressorAttack(0.003)  // attack time
.compressorRelease(0.25)  // release time
```

### Stereo & Panning
```javascript
.pan(0.3)              // stereo position (0=left, 0.5=center, 1=right)
.jux(rev)              // stereo split: original left, function applied right
.juxBy(0.5, rev)       // partial stereo split (0.5 = half-width)
```

### Transient Shaping
```javascript
.transient(0.5)        // transient emphasis
.transsustain(0.3)     // sustain portion
```

---

## Modulation Sources

Signal generators from packages/core/signal.mjs. All output continuous patterns.

### Oscillators (0 to 1)
```javascript
saw       // sawtooth 0->1
isaw      // inverted sawtooth 1->0
sine      // sine wave
cosine    // cosine wave
square    // square wave
tri       // triangle wave
```

### Bipolar (-1 to 1)
```javascript
saw2, isaw2, sine2, cosine2, square2, tri2
```

### Random / Noise
```javascript
rand      // random 0->1
rand2     // random -1->1
perlin    // Perlin noise (smooth random)
irand(n)  // integer random 0 to n-1
brand     // byte random
```

### Usage Pattern
```javascript
// .range(min, max) maps 0-1 to your range
// .slow(n) slows the cycle
sine.range(200, 4000).slow(8)      // smooth 8-cycle sweep
perlin.range(200, 4000).slow(16)   // organic drift, never repeats
rand.range(0.5, 1)                 // random gain variation
```

### Input Signals
```javascript
mousex    // mouse X position (0-1)
mousey    // mouse Y position (0-1)
```

---

## Slider Controls

```javascript
// SAFE: one slider per element
let kickVol = slider(0.8, 0, 1, 0.01, "Kick")
let bassVol = slider(0.5, 0, 1, 0.01, "Bass")
let filterCtrl = slider(2000, 200, 8000, 10, "Filter")

// UNSAFE — DO NOT DO THIS:
// hatVol.mul(0.6)  <-- BREAKS: arithmetic on control pattern
```

Keep slider count to 6-8 max for usability.

---

## Pattern Composition

```javascript
stack(kick, bass, lead, pad)   // layer simultaneously
cat(intro, verse, chorus)      // concatenate (one cycle each)
fastcat(a, b, c)               // concatenate into one cycle
sequence(a, b, c)              // alias for fastcat
arrange([4, intro], [8, verse], [4, chorus])  // timed arrangement
```

---

## Mini Notation

The `"quoted string"` pattern language (parsed by packages/mini/).

```javascript
"x ~ x x ~ x x ~"     // rhythm: x=hit, ~=rest (- also works for rest)
"<a2 e2 f2 d2>"        // sequence: one per cycle (slowcat)
"[a2,e3]"              // chord: simultaneous notes
"a2 [e2,b2] f2 d2"     // mixed: subdivide + chord
"bd*4"                  // multiply: 4 hits in one slot
"bd/2"                  // divide: stretch over 2 cycles
"[bd sd | cp hh]"       // random choice: pick one per cycle
"bd?"                   // degrade: 50% chance of silence
"bd?0.3"                // degrade with probability
"bd@2 sd"               // elongate: bd gets 2x time weight
"bd!2 sd"               // replicate: bd plays twice (no speedup)
```

---

## Pattern Methods

Key methods from packages/core/pattern.mjs:

### Time
```javascript
.slow(2)    .fast(2)     .early(0.25)  .late(0.25)
.stretch(2)  .compress(0.5, 1)
```

### Structure
```javascript
.struct("x x ~ x")      // impose rhythm
.mask("x ~ x ~")        // mask with pattern
.euclid(5, 8)           // euclidean rhythm (5 hits in 8 steps)
.euclidRot(5, 8, 2)     // euclidean with rotation
```

### Layering
```javascript
.superimpose(fn)         // layer original + transformed
.off(0.125, fn)          // layer with time offset
.layer(fn1, fn2)         // apply multiple transforms
.ply(2)                  // duplicate each event
.stut(3, 0.5, 0.125)    // stutter (count, gain decay, time)
```

### Transformation
```javascript
.rev()                   // reverse
.palindrome()            // forward then backward
.iter(4)                 // shift start each cycle
.iterBack(4)             // shift back each cycle
.jux(rev)                // stereo L/R split
.juxBy(0.5, rev)         // partial stereo split
```

### Selection
```javascript
.pick()                  // pick from list
.choose()                // random selection
.shuffle()               // randomize order
.segment(8)              // quantize to N steps
```

---

## Music Theory

From packages/tonal/:

```javascript
// Scale quantization
note("0 2 4 5 7").scale("C:minor")
note("0 1 2 3 4 5 6 7").scale("D:dorian")

// Scale transpose (in scale steps)
.scaleTranspose(2)    // up 2 scale degrees (alias: strans)

// Chromatic transpose
.transpose(7)         // up 7 semitones (alias: trans)

// Interval notation
.transpose("3M")      // major third
.transpose("5P")      // perfect fifth
```

---

## Vocal Textures

Working options (reliability order):
1. `.vowel("<a e i o>")` on sawtooth pads — most reliable
2. Wavetable: `.s("wt_voice")` or similar vocal wavetables
3. `samples('shabda:vocal:4,choir:4')` — Freesound integration
4. `samples('shabda/speech/en-GB/f:feel the music')` — text-to-speech

GM voice instruments (from soundfonts package) are unreliable. Stick with synthesis.

---

## Visuals

### Draw Package (pianoroll, spiral, pitchwheel)
Source: packages/draw/

#### Pianoroll / Punchcard (scrolling note visualization)
```javascript
.pianoroll()   // synonym: .punchcard()
// Options (all optional):
.pianoroll({
  cycles: 4,           // number of visible cycles (default 4)
  playhead: 0.5,       // playhead position 0-1 (default 0.5)
  vertical: 0,         // vertical layout (default 0)
  labels: 0,           // show note labels (default 0)
  flipTime: 0,         // reverse scroll direction (default 0)
  flipValues: 0,       // flip pitch axis (default 0)
  overscan: 1,         // lookahead cycles (default 1)
  hideNegative: 0,     // hide pre-start notes (default 0)
  smear: 0,            // notes leave trails (default 0)
  fold: 0,             // notes fill full width (default 0)
  active: '#FFCA28',   // active note color
  inactive: '#7491D2', // inactive note color
  background: 'transparent',
  playheadColor: 'white'
})
```

#### Spiral (circular time)
```javascript
.spiral()
// Notes plotted on an expanding spiral — good for seeing cyclic structure
```

#### Pitchwheel (circular pitch)
```javascript
.pitchwheel()
.pitchwheel({ mode: 'flake' })    // center lines (default)
.pitchwheel({ mode: 'polygon' })  // connect dots
.pitchwheel({ circle: 1 })        // show reference circle
.pitchwheel({ edo: 12 })          // divisions per octave
```

#### Color
```javascript
.color("red")          // CSS color name or hex
.color("#FF6B35")      // hex color
// Full CSS color map available (140+ named colors)
```

#### Usage with stack()
```javascript
// Add visualization to the whole pattern:
stack(kick, bass, lead, pad).pianoroll({cycles: 8})
// Or use all() for global viz:
// all(pianoroll)
```

### Hydra Integration (VJ visuals)
The `hydra` package provides integration with Hydra visual synth for
reactive VJ-style visuals driven by audio. Potential for live visual
performance alongside audio — research if the user asks for visuals.
