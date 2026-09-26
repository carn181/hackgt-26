"""Urgency tier for a YAMNet class -- the `urgency` enum of README 4.5.

Why this is its own module: both the fusion loop and the HUD need one answer to
"does this sound deserve to interrupt the wearer", and that answer is policy,
not DSP. Kept here as a pure function of the class name, it can be eyeballed and
edited without touching the audio path.

Tiers: `urgent` immediate danger, `high` worth interrupting for, `low` constant
ambient noise (suppressed in important mode), `normal` everything else.
"""

from __future__ import annotations

import csv
import logging
import re
from pathlib import Path

log = logging.getLogger("server.urgency")

CLASS_MAP = Path("models/yamnet_class_map.csv")

LOW = "low"
NORMAL = "normal"
HIGH = "high"
URGENT = "urgent"

_TIERS = (LOW, NORMAL, HIGH, URGENT)
_LOW_CONFIDENCE = 0.35

# Exact display_names from yamnet_class_map.csv -- danger sounds plus the siren
# classes, which are the same emergency arriving with wheels.
URGENT_SET = frozenset(
    {
        "Alarm",
        "Ambulance (siren)",
        "Civil defense siren",
        "Emergency vehicle",
        "Explosion",
        "Fire alarm",
        "Fire engine, fire truck (siren)",
        "Gunshot, gunfire",
        "Police car (siren)",
        "Screaming",
        "Siren",
        "Smoke detector, smoke alarm",
    }
)

# Substrings, matched on whole words (see _matches). Horn is spelled out per
# class so that "French horn", a musical instrument, is not swept up.
HIGH_PATTERNS: tuple[str, ...] = (
    "speech",
    "conversation",
    "narration",
    "babbling",
    "shout",
    "shouting",
    "whispering",
    "glass",
    "vehicle",
    "car",
    "motorcycle",
    "tire squeal",
    "vehicle horn",
    "air horn",
    "train horn",
    "baby cry",
    "doorbell",
    "knock",
    "thump",
    "crash",
    "shatter",
    "breaking",
)

# Continuous ambient, weather, vegetation and machine noise. "wind" also covers
# "Wind chime" and "Wind instrument, woodwind instrument"; both are non-urgent,
# so the low tier is a tolerable answer for them.
LOW_PATTERNS: tuple[str, ...] = (
    "wind",
    "rain",
    "water",
    "rustle",
    "rustling leaves",
    "footsteps",
    "vacuum cleaner",
    "idling",
    "traffic noise",
    "static",
    "noise",
    "hum",
    "air conditioning",
)

_lookup: dict[str, str] | None = None


def _lookup_table() -> dict[str, str]:
    """lowercased name -> class-map row, including comma-separated alternatives.

    YAMNet spells alternatives in one cell ("Smoke detector, smoke alarm") and
    either half names the same sound, so both halves resolve.
    """
    global _lookup
    if _lookup is None:
        rows: list[str] = []
        try:
            with open(CLASS_MAP, newline="", encoding="utf-8") as f:
                rows = [row["display_name"] for row in csv.DictReader(f)]
        except OSError as exc:
            log.warning("class map %s unreadable (%s); urgency falls back to raw names", CLASS_MAP, exc)
        table: dict[str, str] = {}
        for row in rows:
            table.setdefault(row.lower(), row)
            for alternative in row.split(","):
                table.setdefault(alternative.strip().lower(), row)
        _lookup = table
    return _lookup


def _canonical(class_name: str) -> str | None:
    """The class-map row named by `class_name`, or None if it is not a class."""
    name = class_name.strip()
    if not name:
        return None
    table = _lookup_table()
    if not table:  # class map missing; the warning was already logged
        return name
    return table.get(name.lower())


def _matches(name: str, patterns: tuple[str, ...]) -> bool:
    """Case-insensitive whole-word containment.

    Word boundaries keep short patterns honest: "car" must not match "Carnatic
    music" or "Scary music", nor "hum" match "Humming".
    """
    low = name.lower()
    return any(re.search(rf"\b{re.escape(p)}\b", low) is not None for p in patterns)


def urgency_for(class_name: str, confidence: float = 1.0) -> str:
    """Tier for a YAMNet `display_name`.

    Names outside the class map are `normal` as given. Everything else is
    urgency-first: urgent (exact set) beats high beats low. A confidence below
    0.35 drops one tier, never below `low`; `urgent` is never downgraded -- an
    uncertain alarm still deserves the wearer's attention.
    """
    name = _canonical(class_name)
    if name is None:
        return NORMAL
    if name in URGENT_SET:
        tier = URGENT
    elif _matches(name, HIGH_PATTERNS):
        tier = HIGH
    elif _matches(name, LOW_PATTERNS):
        tier = LOW
    else:
        tier = NORMAL
    if tier != URGENT and confidence < _LOW_CONFIDENCE:
        tier = _TIERS[max(0, _TIERS.index(tier) - 1)]
    return tier


# --- selftest: every rule, with the real class-map names ---------------------

_CASES: tuple[tuple[str, float, str], ...] = (
    ("Smoke detector, smoke alarm", 0.90, URGENT),
    ("Smoke alarm", 0.90, URGENT),  # comma alternative of the row above
    ("Siren", 0.10, URGENT),  # urgent is never downgraded
    ("Speech", 0.80, HIGH),
    ("Speech", 0.20, NORMAL),  # low confidence drops one tier
    ("Wind", 0.80, LOW),
    ("Rustling leaves", 0.80, LOW),
    ("Banjo", 0.80, NORMAL),
    ("Blender", 0.80, NORMAL),
    ("Qwerty zzz", 0.80, NORMAL),  # not a YAMNet class
)


def _selftest() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    print(f"{'class':32s} {'conf':>4s}  {'tier':6s}  expected")
    bad = 0
    for name, conf, expected in _CASES:
        tier = urgency_for(name, conf)
        mark = "ok " if tier == expected else "BAD"
        bad += tier != expected
        print(f"{name:32s} {conf:4.2f}  {tier:6s}  {expected:6s} {mark}")
    if bad:
        print(f"\n{bad} mismatch(es)")
        return 1
    print("\nall tiers as expected")
    return 0


if __name__ == "__main__":
    raise SystemExit(_selftest())
