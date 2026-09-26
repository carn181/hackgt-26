"""Fixed-capacity multichannel ring buffer.

The capture path runs continuously at 50 blocks/s/channel; the analysis path
grabs windows out of history. Both allocate nothing per call: the storage and
the snapshot scratch are sized once, so a 20 ms deadline never waits on a GC.

Time model: the newest sample always sits at the end of a snapshot. Callers
that know the wall time of the newest sample (`RingBuffer.latest_t_us`) can put
the window's first sample on the same clock, which is what the latency numbers
depend on.
"""

from __future__ import annotations

import numpy as np


class RingBuffer:
    def __init__(self, nch: int, capacity: int, dtype: np.dtype = np.float32):
        if nch < 1 or capacity < 1:
            raise ValueError("nch and capacity must be positive")
        self.nch = int(nch)
        self.capacity = int(capacity)
        self.dtype = dtype
        self._buf = np.zeros((self.nch, self.capacity), dtype=dtype)
        self._pos = 0          # next write index in the ring
        self.written = 0       # total samples per channel ever written
        self.latest_t_us = 0   # capture clock of the newest sample

    def write(self, x: np.ndarray, t_us: int | None = None) -> None:
        """Append `x` (shape (nch, n)); keeps the newest `capacity` samples."""
        if x.ndim != 2 or x.shape[0] != self.nch:
            raise ValueError(f"expected ({self.nch}, n), got {x.shape}")
        n = x.shape[1]
        if n == 0:
            return
        if n >= self.capacity:  # a block longer than the ring: keep its tail
            self._buf[:] = x[:, -self.capacity :]
            self._pos = 0
        else:
            first = min(n, self.capacity - self._pos)
            self._buf[:, self._pos : self._pos + first] = x[:, :first]
            if n > first:
                self._buf[:, : n - first] = x[:, first:]
            self._pos = (self._pos + n) % self.capacity
        self.written += n
        if t_us is not None:
            self.latest_t_us = int(t_us)

    def snapshot(self, n: int, out: np.ndarray | None = None) -> np.ndarray:
        """Newest `n` samples as a contiguous (nch, n) array.

        Zero-pads at the front when less history exists, so the last column is
        always the latest sample and index arithmetic stays simple.
        """
        n = int(n)
        if n > self.capacity:
            raise ValueError(f"snapshot {n} > capacity {self.capacity}")
        dst = out if out is not None and out.shape == (self.nch, n) else np.zeros(
            (self.nch, n), dtype=self.dtype
        )
        avail = min(n, self.written, self.capacity)
        if avail:
            start = (self._pos - avail) % self.capacity
            dst[:, n - avail :] = self._buf[:, start : start + avail] if start + avail <= self.capacity else np.concatenate(
                (self._buf[:, start:], self._buf[:, : start + avail - self.capacity]), axis=1
            )
        if avail < n:
            dst[:, : n - avail] = 0
        return dst
