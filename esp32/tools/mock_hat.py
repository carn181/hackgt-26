#!/usr/bin/env python3
"""Dev twin of the hat: serves esp32/aura4/page.h on :8080 and streams synthetic audio on :8081.

Why it exists: the phone app must be checkable before, during and after wiring four mics. This runs the
real page (parsed out of page.h, not a copy) against real WebSocket bytes in the frozen README 4.2
framing, so "the app hears four channels" is testable with no hardware, and a bad channel is visible
here first.

    .venv/bin/python esp32/tools/mock_hat.py                 # then open http://127.0.0.1:8080/
    .venv/bin/python esp32/tools/mock_hat.py --silent 2      # dead m2: the app must flag it
    .venv/bin/python esp32/tools/mock_hat.py --drop 7        # lose every 7th packet: gap counter

Each channel is a sine at its own frequency and level, so a channel swap or a silent input is audible
and measurable: --tone 440,880,1320,1760 are the defaults, one per mic.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from websockets.asyncio.server import serve

MAGIC = 0xA14D
VERSION = 1
NCH = 4
# The pin map the firmware really uses; mirrored so the app shows the same thing for the real hat.
PINS = {"bus0": [7, 8, 9], "bus1": [4, 5, 6]}


def load_page(path: Path) -> str:
    text = path.read_text()
    m = re.search(r'R"rawliteral\((.*)\)rawliteral"', text, re.S)
    if not m:
        raise SystemExit(f"{path}: no R\"rawliteral( ... )rawliteral\" block found")
    return m.group(1)


class Hat:
    """The synthetic hat: 4 channels of PCM, framed exactly like aura4.ino sends them."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.rate = args.rate
        self.block = args.block
        self.tones = [float(x) for x in args.tone.split(",")]
        self.levels = [float(x) for x in args.level.split(",")]
        self.dc = [int(x) for x in args.dc.split(",")]
        self.silent = {int(x) for x in args.silent.split(",") if x.strip()} if args.silent else set()
        self.drop = args.drop
        self.restartEvery = args.restart_every
        self.seq = 0
        self.blocks = 0
        self.t0 = time.monotonic()
        # One producer, many clients -- exactly like the hat, which broadcasts one packet to everyone.
        # Per-client generation would hand each client a different seq and look like 100% loss.
        self.subs: set[asyncio.Queue] = set()
        self.slowDrops = 0
        self.fw = "mock0000"

    @property
    def clients(self) -> int:
        return len(self.subs)

    def packet(self) -> bytes | None:
        """One README 4.2 packet: header + channel-major int16, wrapped by a phase-continuous sine."""
        self.blocks += 1
        seq = self.seq
        self.seq += 1  # advance even for a dropped packet, or the loss is invisible to the client
        if self.restartEvery and self.blocks % self.restartEvery == 0:
            # Fault injection for a reboot the client never saw close: seq jumps back to 0 in-band.
            # The app must read that as a restart, not as four billion lost packets.
            self.seq = 0
        if self.drop and self.blocks % self.drop == 0:
            return None  # a packet loss the app is supposed to notice
        n = self.block
        t = (self.blocks * n) / self.rate
        chans = []
        for c in range(NCH):
            if c in self.silent:
                chans.append(b"\x00\x00" * n)
                continue
            f = self.tones[c % len(self.tones)]
            a = self.levels[c % len(self.levels)]
            samples = []
            for i in range(n):
                tt = t + i / self.rate
                v = a * math.sin(2 * math.pi * f * tt)
                samples.append(max(-32768, min(32767, int(v * 32767) + self.dc[c % len(self.dc)])))
            chans.append(struct.pack(f"<{n}h", *samples))
        payload = b"".join(chans)
        t_us = int((self.t0 and (time.monotonic() - self.t0)) * 1e6)
        header = struct.pack("<HBBIQH", MAGIC, VERSION, NCH, seq & 0xFFFFFFFF, t_us, n)
        return header + payload

    def hello(self) -> str:
        return json.dumps(
            {
                "type": "hello",
                "fw": self.fw,
                "ver": "mock",
                "mode": "mock",
                "ip": "127.0.0.1",
                "rssi": -47,
                "uptime": int(time.monotonic() - self.t0),
                "rate": self.rate,
                "nch": NCH,
                "block": self.block,
                "seq": self.seq,
                "clients": self.clients,
                "overflows": 0,
                "short_reads": 0,
                "stalls": 0,
                "pins": PINS,
            }
        )

    async def producer(self) -> None:
        """Generate at the real 16 kHz block rate and fan out to every client, once per block."""
        period = self.block / self.rate
        next_t = time.monotonic() + period
        while True:
            pkt = self.packet()
            if pkt is not None:
                for q in list(self.subs):
                    try:
                        q.put_nowait(pkt)
                    except asyncio.QueueFull:
                        self.slowDrops += 1  # a client that cannot keep up loses packets, like UDP would
            now = time.monotonic()
            if next_t < now - 0.1:
                next_t = now + period  # never catch up in a burst: that would fake a growing buffer
            await asyncio.sleep(max(0.0, next_t - now))
            next_t += period

    def status(self) -> str:
        return json.dumps(
            {
                "ok": True,
                "fw": self.fw,
                "ver": "mock",
                "mode": "mock",
                "clients": self.clients,
                "seq": self.seq,
                "rate": self.rate,
                "nch": NCH,
                "block": self.block,
                "tones_hz": self.tones,
                "levels": self.levels,
                "silent": sorted(self.silent),
                "drop_every": self.drop,
                "restart_every": self.restartEvery,
                "slow_drops": self.slowDrops,
                "pins": PINS,
            }
        )


async def stream(ws, hat: Hat) -> None:
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    hat.subs.add(q)
    try:
        await ws.send(hat.hello())
        last_hello = time.monotonic()
        while True:
            try:
                await ws.send(await asyncio.wait_for(q.get(), timeout=1.0))
            except asyncio.TimeoutError:
                pass
            if time.monotonic() - last_hello >= 2.0:
                last_hello = time.monotonic()
                await ws.send(hat.hello())
    finally:
        hat.subs.discard(q)


def http_server(html: str, hat: Hat, port: int, ws_port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, body: bytes, ctype: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 (http.server API)
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                self._send(html.encode(), "text/html; charset=utf-8")
            elif path == "/status":
                self._send(hat.status().encode(), "application/json")
            else:
                self.send_error(404)

        def log_message(self, fmt: str, *args) -> None:
            if "/status" not in self.path:
                print(f"http {self.address_string()} {fmt % args}")

    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


async def amain(args: argparse.Namespace) -> None:
    page = load_page(Path(args.page))
    # Point the default socket at this mock's port; ?ws= on the URL still overrides it.
    page = page.replace('location.hostname + ":81/"', f'location.hostname + ":{args.ws_port}/"')
    hat = Hat(args)
    http_server(page, hat, args.http_port, args.ws_port)
    print(f"mock hat: http://0.0.0.0:{args.http_port}/  ws://0.0.0.0:{args.ws_port}/")
    print(f"tones {hat.tones} Hz, levels {hat.levels}, silent {sorted(hat.silent) or 'none'}, drop every {hat.drop or '-'}")
    asyncio.create_task(hat.producer())
    async with serve(lambda ws: stream(ws, hat), "0.0.0.0", args.ws_port):
        await asyncio.Future()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    default_page = Path(__file__).resolve().parent.parent / "aura4" / "page.h"
    ap.add_argument("--page", default=str(default_page))
    ap.add_argument("--http-port", type=int, default=8080)
    ap.add_argument("--ws-port", type=int, default=8081)
    ap.add_argument("--rate", type=int, default=16000)
    ap.add_argument("--block", type=int, default=320)
    ap.add_argument("--tone", default="440,880,1320,1760", help="Hz per channel")
    ap.add_argument("--level", default="0.25,0.18,0.12,0.08", help="linear amplitude per channel")
    ap.add_argument("--dc", default="0,0,0,0", help="LSB dc offset per channel")
    ap.add_argument("--silent", default="", help="channel indexes forced to digital silence, e.g. 2,3")
    ap.add_argument("--drop", type=int, default=0, help="drop 1 packet every N")
    ap.add_argument("--restart-every", type=int, default=0, help="reset seq every N packets (missed-reboot case)")
    args = ap.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
