"""Backend selftest: what is *verified* rather than assumed (README §0 B3, B6, B7).

Four independent checks:

  `--doa`    synthetic plane waves at known angles → recovered bearing + error table
  `--model`  the §8.2 YAMNet reproduction (runs `server.classify`'s own checks)
  `--udp`    the §4.2 ESP32 framing over a real socket, with no ESP32 present
  `--e2e`    a synthetic stereo wav through the *real* pipeline — file source,
             ring buffer, onset detector, scheduled classification, DOA, fusion —
             asserting the class and the bearing sign, and printing the
             onset→event latency the same way the live pipeline reports it.

Nothing here touches the microphone, so it runs on a machine with no audio device
and it cannot pass by accident of a lucky room. Exit code is non-zero on failure.
"""

from __future__ import annotations

import argparse
import runpy
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

from .config import load_profile
from .doa import estimate_bearing
from .synth import plane_wave, two_burst_wav

# README §0 B7: ±8° at −60/−30/0/+30/+60.
SWEEP = (-60.0, -30.0, 0.0, 30.0, 60.0)
TOLERANCE_DEG = 8.0


def check_doa(profile_name: str, seconds: float = 0.25) -> tuple[bool, list[str]]:
    prof = load_profile(profile_name)
    lines = [f"DOA sweep — profile {prof.name} ({prof.nch} mic, layout={prof.layout}), window {seconds * 1e3:.0f} ms"]
    lines.append(f"{'true°':>7} {'measured°':>10} {'err°':>7} {'±σ°':>7} {'method':<16} {'conf':>5} {'lag':>8} {'mirror°':>8}")
    ok = True
    for angle in SWEEP:
        x = plane_wave(prof, angle, seconds=seconds, kind="noise", seed=int(abs(angle)) + 1)
        est = estimate_bearing(x, prof)
        if est is None:
            lines.append(f"{angle:>7.0f} {'—':>10}   rejected by the coherence gate")
            ok = False
            continue
        err = est.bearing_deg - angle
        mirror = 180.0 - est.bearing_deg
        if mirror > 180.0:
            mirror -= 360.0
        flag = "" if abs(err) <= TOLERANCE_DEG else "  <-- FAIL"
        lines.append(
            f"{angle:>7.0f} {est.bearing_deg:>10.2f} {err:>+7.2f} {est.accuracy_deg:>7.1f} "
            f"{est.method:<16} {est.confidence:>5.2f} {est.delay_samples:>8.2f} {mirror:>8.1f}{flag}"
        )
        if abs(err) > TOLERANCE_DEG:
            ok = False
    return ok, lines


def check_e2e(profile_name: str, timeout: float = 25.0) -> tuple[bool, list[str]]:
    """Run the real service objects over a synthetic wav, no mic, no browser."""
    from .main import Backend, build_parser

    prof = load_profile(profile_name)
    lines = [f"end-to-end — profile {prof.name}, synthetic tone bursts at +40° then −40°"]
    tmp = Path(tempfile.mkdtemp(prefix="hackgt-selftest-"))
    wav = tmp / "bursts.wav"
    two_burst_wav(wav, prof, prof.rate_hz)

    args = build_parser().parse_args(
        ["--profile", profile_name, "--source", "file", "--source-file", str(wav),
         "--no-asr", "--log-level", "WARNING", "--no-print-events"]
    )
    backend = Backend(args)
    collected: list[dict] = []
    backend.hub.publish = collected.append  # skip the loop: we are the only client
    backend.start()
    try:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if len([m for m in collected if m.get("type") == "sound_event"]) >= 2:
                break
            time.sleep(0.1)
    finally:
        backend.stop()

    raw_events = [m for m in collected if m.get("type") == "sound_event"]
    # The backend may re-send an event with the same id (a re-classification on the
    # segment's loudest window, or a name-spotting escalation). The HUD merges by
    # id, so the check does too: keep the first appearance's order, the last payload.
    merged: dict[str, dict] = {}
    for m in raw_events:
        merged[m["id"]] = m
    events = list(merged.values())
    if not events:
        lines.append("FAIL: no sound_event was produced from the synthetic bursts")
        return False, lines
    ok = True
    for msg in events:
        lat = (msg["t"] - msg["t_onset"]) * 1e3
        lines.append(
            f"  {msg['id']}: class={msg['class']!r} conf={msg['confidence']:.2f} "
            f"bearing={msg['bearing_deg']:+.1f}° ±{msg['accuracy_deg']:.0f}° "
            f"source={msg['source']} onset→msg={lat:.0f} ms"
        )
    # Ground truth is the generator's own geometry: the DOA must recover the sign
    # and land within the same tolerance the synthetic sweep is held to.
    truths = (40.0, -40.0)
    for msg, truth in zip(events, truths):
        err = msg["bearing_deg"] - truth
        if abs(err) > TOLERANCE_DEG:
            lines.append(f"  FAIL: {msg['id']} bearing {msg['bearing_deg']:+.1f}° vs truth {truth:+.0f}° ({err:+.1f}°)")
            ok = False
    if len(events) < 2:
        lines.append(f"  FAIL: expected two events (one per burst), got {len(events)}")
        ok = False
    elif np.sign(events[0]["bearing_deg"]) == np.sign(events[1]["bearing_deg"]):
        lines.append("  FAIL: bearing sign did not flip between bursts — convention bug")
        ok = False
    if not all(m["confidence"] > 0.5 and m["class"] not in ("", "unknown") for m in events[:2]):
        lines.append("  FAIL: classifier produced no usable label for a 440 Hz tone")
        ok = False
    return ok, lines


def check_model() -> tuple[bool, list[str]]:
    """Delegate to the module's own §8.2 checks so there is one source of truth."""
    lines = ["model — running `python -m server.classify` (README §8.2 reproduction)"]
    try:
        runpy.run_module("server.classify", run_name="__main__")
        return True, lines + ["  (all checks printed above)"]
    except SystemExit as exc:
        return (exc.code or 0) == 0, lines


def check_udp(rate: int = 16000, nch: int = 4, nsamp: int = 320, packets: int = 5) -> tuple[bool, list[str]]:
    """The §4.2 hat path over a real socket, with no hat (README §0 B6).

    Verifies the exact framing the ESP32 will send: magic, version, channel count,
    sample count, sequence continuity, and that per-channel samples survive the
    round trip. The serial path shares this parser, so a green here means the
    Expo/USB insurance path is one `--source serial` away from working.
    """
    import socket

    from .ingest import PKT_HDR, PKT_MAGIC, PKT_VERSION, UdpSource

    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    src = UdpSource(rate, nch, nsamp, port=port, host="127.0.0.1")
    src.start()
    lines = [f"§4.2 over UDP — {nch} ch, {nsamp} samples, port {port}"]
    ok = True
    try:
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for seq in range(packets):
            # channel k carries a distinct constant level, so a channel swap or a
            # scale error cannot pass unnoticed.
            x = np.zeros((nch, nsamp), dtype="<i2")
            for ch in range(nch):
                x[ch, :] = int(1000 * (ch + 1))
            payload = PKT_HDR.pack(PKT_MAGIC, PKT_VERSION, nch, seq, 1_000_000 + seq * 20000, nsamp) + x.tobytes()
            tx.sendto(payload, ("127.0.0.1", port))
        tx.close()

        got = []
        deadline = time.monotonic() + 5.0
        for blk in src.blocks():
            got.append(blk)
            if len(got) >= packets or time.monotonic() > deadline:
                break
        if len(got) != packets:
            return False, lines + [f"FAIL: received {len(got)}/{packets} packets"]
        for i, blk in enumerate(got):
            exp = np.array([1000 * (c + 1) for c in range(nch)], dtype=np.float32) / 32768.0
            if blk.x.shape != (nch, nsamp):
                lines.append(f"FAIL: packet {i} shape {blk.x.shape}")
                ok = False
            elif not np.allclose(blk.x.mean(axis=1), exp, atol=1e-4):
                lines.append(f"FAIL: packet {i} per-channel levels {blk.x.mean(axis=1)} != {exp}")
                ok = False
            elif blk.seq != i:
                lines.append(f"FAIL: packet {i} seq {blk.seq}")
                ok = False
        lines.append(f"  {len(got)} packets, seq 0..{got[-1].seq}, per-channel levels {np.round(got[-1].x.mean(axis=1), 4)}")
        lines.append(f"  stats {src.stats.as_dict()}")
    finally:
        src.stop()
    return ok, lines


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="server.selftest")
    p.add_argument("--profile", default="laptop_dmic")
    p.add_argument("--only", choices=["doa", "model", "e2e", "udp"], default=None)
    p.add_argument("--window-ms", type=float, default=250.0)
    args = p.parse_args(argv)

    results: list[tuple[str, bool, list[str]]] = []
    if args.only in (None, "doa"):
        results.append(("doa", *check_doa(args.profile, args.window_ms / 1000.0)))
    if args.only in (None, "model"):
        results.append(("model", *check_model()))
    if args.only in (None, "udp"):
        results.append(("udp", *check_udp()))
    if args.only in (None, "e2e"):
        results.append(("e2e", *check_e2e(args.profile)))

    failed = 0
    for name, ok, lines in results:
        print(f"\n=== {name}: {'PASS' if ok else 'FAIL'} ===")
        for ln in lines:
            print(ln)
        failed += 0 if ok else 1
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
