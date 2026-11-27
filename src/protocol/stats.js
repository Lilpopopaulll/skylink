// UDP quality statistics: sequence loss / reordering / duplicates, RFC 3550 jitter, packet rate, RTT.
const WINDOW = 100; // "recent" loss window, in sequence numbers
const U32 = 2 ** 32;

export class SeqStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.received = 0; // unique packets (duplicates excluded)
    this.firstSeq = null;
    this.maxSeq = null; // extended (unwrapped) sequence numbers: may exceed 2^32
    this.seen = new Set(); // extended seqs in [maxSeq - WINDOW + 1, maxSeq]
    this.outOfOrder = 0;
    this.duplicates = 0;
    this.jitter = 0;
    this.prevTransit = null;
    this.prevTsExt = null;
    this.arrivals = []; // arrival times (ms) of the last second
    this.lastArrival = null;
    this.realClock = true; // false once arrivalMs was injected explicitly
  }

  /** `arrivalMs` defaults to performance.now(); tsMs is the sender's u32 ms clock. */
  onPacket(seq, tsMs, arrivalMs) {
    if (arrivalMs === undefined) arrivalMs = performance.now();
    else this.realClock = false;

    // Unwrap the u32 sequence relative to the highest one seen.
    let ext;
    if (this.maxSeq === null) ext = seq;
    else ext = this.maxSeq + ((seq - this.maxSeq) | 0);

    if (this.maxSeq !== null && ext <= this.maxSeq && ext > this.maxSeq - WINDOW && this.seen.has(ext)) {
      this.duplicates++;
      return;
    }

    this.received++;
    if (this.maxSeq === null) {
      this.firstSeq = this.maxSeq = ext;
      this.seen.add(ext);
    } else if (ext > this.maxSeq) {
      const jump = ext - this.maxSeq;
      if (jump >= WINDOW) this.seen.clear();
      else for (let s = this.maxSeq - WINDOW + 1; s <= ext - WINDOW; s++) this.seen.delete(s);
      this.maxSeq = ext;
      this.seen.add(ext);
    } else {
      this.outOfOrder++; // ext < maxSeq (ext == maxSeq is always caught as duplicate above)
      if (ext > this.maxSeq - WINDOW) this.seen.add(ext);
      if (ext < this.firstSeq) this.firstSeq = ext;
    }

    // RFC 3550 interarrival jitter, with the sender timestamp unwrapped across 2^32.
    const tsExt = this.prevTsExt === null ? tsMs : this.prevTsExt + ((tsMs - this.prevTsExt) | 0);
    this.prevTsExt = tsExt;
    const transit = arrivalMs - tsExt;
    if (this.prevTransit !== null) {
      const d = Math.abs(transit - this.prevTransit);
      this.jitter += (d - this.jitter) / 16;
    }
    this.prevTransit = transit;

    // Rate window
    this.arrivals.push(arrivalMs);
    while (this.arrivals.length > 0 && this.arrivals[0] <= arrivalMs - 1000) this.arrivals.shift();
    this.lastArrival = arrivalMs;
  }

  /** `nowMs` only matters for pps; defaults to the real clock, or to the last injected arrival. */
  snapshot(nowMs) {
    if (nowMs === undefined) nowMs = this.realClock ? performance.now() : (this.lastArrival ?? 0);
    if (this.maxSeq === null) {
      return { received: 0, expected: 0, lost: 0, lossPct: 0, recentLossPct: 0, outOfOrder: 0, duplicates: 0, jitterMs: 0, pps: 0 };
    }
    const expected = this.maxSeq - this.firstSeq + 1;
    const lost = Math.max(0, expected - this.received);
    const lo = Math.max(this.firstSeq, this.maxSeq - WINDOW + 1);
    const span = this.maxSeq - lo + 1;
    let recv = 0;
    for (const s of this.seen) if (s >= lo) recv++;
    const pps = this.arrivals.filter((t) => t > nowMs - 1000 && t <= nowMs).length;
    return {
      received: this.received,
      expected,
      lost,
      lossPct: expected > 0 ? (100 * lost) / expected : 0,
      recentLossPct: span > 0 ? (100 * Math.max(0, span - recv)) / span : 0,
      outOfOrder: this.outOfOrder,
      duplicates: this.duplicates,
      jitterMs: this.jitter,
      pps,
    };
  }
}

export class RttTracker {
  constructor() {
    this.values = [];
  }

  add(ms) {
    this.values.push(ms);
    if (this.values.length > 20) this.values.shift();
  }

  get last() {
    return this.values.length ? this.values[this.values.length - 1] : null;
  }

  get avg() {
    if (!this.values.length) return null;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
}
