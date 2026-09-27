# C-HUD Vision — the 2-minute demo script

Shoot sheet for the HackGT 26 video, written against **what actually runs on `main` today** (see the README
status table). Supersedes `docs/SPEC.md` §10, whose strip shot and speaker-attribution beats are not shootable —
the strip isn't wired, and "who said it" needs a face in frame and a working transcript.

Assumptions this script is built on, stated so nobody re-litigates them at 06:00:

- **No headset, no glasses, no LED strip.** The cap is the sensor, the phone is the display.
- **No transcription in this cut.** `Speech` appears as a class label, never as text. Run the backend with
  `--no-asr`: no Whisper, no quiet-room requirement, one fewer thing to break on stage.
- Direction is demonstrated two ways, both real: **camera-anchored bearings** for a source the phone can see,
  and the **hat's own coarse quadrant** (`LEFT/RIGHT/FRONT/BACK`, gated by `active`) for a source it can't.

**Spine:** one microphone can't tell you *where*. The cap has four. And not every sound deserves your attention.

**What the edit has to prove, in order:** (1) a sound you didn't hear gets a *place*; (2) it gets a *name* and an
*urgency*; (3) the wearer controls what is allowed to interrupt them.

---

## Beat sheet — 2:00

| # | Time | Shot | Action | VO |
|---|---|---|---|---|
| B1 | 0:00–0:12 | Someone at a desk, absorbed. A knock/doorbell happens off-frame. They don't react. Caption: `this happened — they didn't hear it` | none | "A phone can tell you a sound happened. It has one microphone, so it can't tell you where." |
| B2 | 0:12–0:22 | Cap goes on. Phone up in hand, HUD live. Logo flash, 1 s | wearer looks at the room, not the lens | "Four microphones on a cap. Your phone is the display." |
| B3 | 0:22–0:36 | Phone at chest height, aimed at the group; **one person clearly in frame** | they knock on the table → marker lands on them: `Knocking 0.9` with the `accuracy ±N°` label as printed | "A knock. There it is — with the sound's name on it." |
| B4 | 0:36–0:50 | Cut to the laptop mirror, same HUD page, hat chip zoomed: `hat: REAR · active` | same knock, this time **from behind, off-camera** | "Behind you, where the camera can't see — the cap's own four mics still say which side." |
| B5 | 0:50–1:02 | Smoke-alarm sample from a laptop. Everything else on screen dims; `URGENT` takes the screen | hold still, let it land | "This one doesn't get filtered." |
| B6 | 1:02–1:16 | Three live events at once: `Dog`, `Knocking`, `Speech`, different tiers | press **important** (the `low` tier drops out), then **quiet** (only `high` and `urgent` survive) | "Everything else, you decide. That's the knob a hearing person has — and the thing no phone app gives you." |
| B7 | 1:16–1:30 | Wearer sweeps the phone across the room; markers stay pinned to their true directions, no snapping | slow pan | "Turn, and the bearings hold — the map is in your frame, not the phone's." |
| B8 | 1:30–1:48 | Terminal PiP (`class · bearing · urgency · onset→ws 378 ms`) beside the stack diagram | — | "378 milliseconds from sound to screen — and every number ships with the command that produced it." |
| B9 | 1:48–2:00 | Logo, tagline, repo URL, `next: LED strip on the brim` | — | "C-HUD Vision. Sound, with an address." |

VO is short on purpose: ~8–12 words a beat, read over the action, no music under B1–B7. Record it separately.

---

## Sound menu — pick sounds that hit the tier you want

Tiers come from `server/urgency.py` (`URGENT_SET`, `HIGH_PATTERNS`, everything else normal, `low` for
continuous ambience). Check the class the backend actually prints before you rely on one.

| Play / do | Expected YAMNet class | Tier | Why it's in the script |
|---|---|---|---|
| Smoke-alarm sample (laptop speaker) | `Smoke detector, smoke alarm` | urgent | B5, the one sound that outranks everything |
| Siren or fire-engine sample | `Siren` / `Fire engine, fire truck (siren)` | urgent | spare for B5 |
| Knock on the table (real) | `Knock` | high | B3 + B4, the direction beats |
| Doorbell sample | `Doorbell` | high | B6 filler that survives `quiet` |
| Car-horn sample | `Vehicle horn` | high | B6 |
| Dog bark | `Dog` | normal | B6, the one that disappears in `quiet` |
| Applause / laughter | `Applause` / `Laughter` | normal | B6, optional |

**Ten-minute pre-shoot test** — run every candidate once and read what comes back:

```bash
tools/run_backend.sh --profile browser_mono --source browser --no-asr --print-events
```

Play each sound on the laptop speakers, note `class` + `urgency` in the printed line. If a sound lands on an
unexpected class (speaker colour and room EQ do this), **swap the sound, not the code.** Keep only the ones that
come back with the class you want — that list is the video's entire vocabulary.

---

## Pre-roll checklist

1. Backend: `tools/run_backend.sh --profile browser_mono --source browser --no-asr --print-events`
   (add `--log-classes 3` if you want the runner-up classes visible in the PiP).
2. Phone: `cd web && npm run phone` → open the printed `https://<lan-ip>:5173/`, install the CA **once**, grant
   camera + mic. The dev server proxies `wss://` to the backend, so no `?ws=` needed.
3. Tap **connect** in the HUD so the hat chip reads `hat: listening`, then verify it flips to a direction on a
   test knock. If it doesn't, retune `RISE_RATIO` / `HANG_MS` in `esp32/hackgt_hat/hackgt_hat.ino`
   (esp32/README.md: err on the loud side) or cut B4 — do not fake it.
4. Mode starts on **all**; confirm the three buttons work before rolling.
5. Terminal font ~18 pt and a clean prompt — the `onset→ws 378 ms` line is the credibility shot.
6. Capture the HUD **off the device**, not off a camera pointed at the device: Android
   `adb shell screenrecord /sdcard/hud.mp4`, or QuickTime Movie Recording with the iPhone as the source. Shoot
   one 2-second physical phone-in-hand clip as proof it's a real phone, then use the clean capture for B3–B7.
7. Room: blinds down, phone volume up for the sample playback, nobody speaking while a beat records.
8. One clip per beat, slate the beat id (B1…B9) at the top of each take. Assemble later; never one take.

---

## The beat that needs care (B4)

On the browser-microphone path there is no array bearing, so an **off-camera** sound arrives as `source: none`
with `accuracy_deg: 180` and the HUD deliberately fades it to nothing rather than point somewhere false. B4 is
therefore carried by the **hat's own quadrant chip**, not by a bearing marker:

- Shoot it on the laptop mirror (same page, bigger pixels) and zoom the chip in the edit.
- The claim is "coarse quadrant, on-device" — say *which side*, never a number.
- Fallback if the knock doesn't flip the chip: cut B4 and keep B3 + B7 as the direction evidence.

---

## Expo: 15-second loop + 30-second patter

**Loop** (silent, captioned — the hall is too loud for VO): `knock → which way` · `alarm → urgent` ·
`filter what may interrupt you` · `sound, with an address`.

**Patter:**

> "Noise is invisible. Your phone can name a sound — it can't tell you where it is, because it has one
> microphone and it's sitting on the table. We put four on this cap: knock behind me… rear-left. Alarms take
> over the screen; everything else you filter. Want to try it — clap anywhere and watch it land on you."

Then hand them the phone and keep the cap on someone's head. Judges who get to trigger an event remember it.

---

## Do not claim

| Never say / show | Why |
|---|---|
| transcripts, "who said it", caption quality | not the focus in this cut; `Speech` is a label here |
| hands-free, eyes-up, heads-up display, headset | the phone is the display; the cap is the sensor |
| the LED strip | not wired — end card, as `next` |
| live TDOA accuracy | selftest only (laptop pair ±1.7°, synthetic hat geometry ±6.0°); the hat's live output is a coarse quadrant |
| 60 fps / < 50 ms HUD overhead | unmeasured (C8 open) |
| a bearing the system didn't produce | `source: none` + `accuracy_deg: 180` means "we don't know where", and the HUD says so |

## If it breaks

- Keep `npm run mock` on a second tab: it replays `Clapping −40°`, `Speech +10°`, playback speech and an
  `urgent Alarm +120°` on the frozen message shapes. Use it as B-roll only, captioned `scripted feed`.
- If the phone's camera path misbehaves, the laptop browser runs the identical page — shoot there and caption
  `same page, phone browser` for the hand-held shots.
- If nothing classifies (dead room, bad speaker), the DOA/classifier selftest output is a legitimate
  replacement for B8: `python -m server.selftest`, shown as *verification*, not as a live demo.
