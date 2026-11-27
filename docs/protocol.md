# SkyLink protocols

SkyLink uses two small application protocols, both defined in `src/protocol/`:

- **SLCP** (SkyLink Control Protocol) over **TCP 7400**: commands, flight-log upload, liveness. Everything that must arrive, in order.
- **SLTP** (SkyLink Telemetry Protocol) over **UDP 7401**: telemetry at 10 Hz and echo probes. Everything where the freshest value matters more than every value.

All multi-byte integers and floats are **big-endian**. Codecs: `src/protocol/slcp.js`, `src/protocol/sltp.js`. Statistics: `src/protocol/stats.js`. Defaults come from `src/config.js`.

## Why TCP for control, why UDP for telemetry

**Control needs reliability and order.** A `takeoff` must not be lost, and `goto` must not overtake the `takeoff` before it. A flight log must arrive byte for byte. TCP gives an ordered, retransmitted byte stream, so SLCP only has to add message boundaries (the length prefix) and the guarantees TCP cannot give on its own (below).

**Telemetry needs freshness.** A position is sent 10 times per second; a position that is 300 ms old is useless because the next one is already on its way. If TCP carried it, one lost segment would stall every later sample behind the retransmission (head-of-line blocking) and the station would then receive a burst of stale positions. With UDP a lost datagram is just a gap: the next datagram carries the current state. The station measures the gap instead of hiding it (sequence numbers, see Statistics).

**Kernel ACK is not application ACK.** A TCP ACK only says "the remote kernel received these bytes". It says nothing about the application having read or stored them (the process can crash, or the link can be reset right after). That is the end-to-end argument: only the application can confirm what the application cares about. SLCP therefore has its own acknowledgements: `COMMAND_ACK` (the drone took the command) and `LOG_ACK` (the bytes are **on the server's disk**).

## SLCP frame (TCP 7400)

```
+----------------+---------+---------------------------+
| len  u32 BE    | type u8 | body (len - 1 bytes)      |
+----------------+---------+---------------------------+
```

`len` counts the type byte plus the body. `len == 0` is rejected (`EMPTY_FRAME`); `len > 20000` is rejected (`FRAME_TOO_BIG`) as soon as the 4 header bytes are read, before any body is buffered. `FrameDecoder` handles frames split across several TCP reads and several frames in one read.

Bodies are compact JSON (`JSON.stringify`, no spaces, at most 4096 bytes), except `LOG_CHUNK`, which is binary. JSON keeps the traffic readable in Wireshark; binary avoids base64 overhead on 16 KiB chunks.

| Type | Name | Direction | Body |
|---|---|---|---|
| 0x01 | HELLO | drone -> station | `{"droneId":3,"name":"Charlie","model":"SL-Quad","fw":"1.0","sessionId":"a1b2c3d4"}` (`sessionId` absent on first contact) |
| 0x02 | WELCOME | station -> drone | `{"sessionId":"a1b2c3d4","resumed":true,"queued":1}` |
| 0x10 | COMMAND | station -> drone | `{"cmdId":7,"action":"goto","params":{"x":500,"y":500,"alt":40}}` |
| 0x11 | COMMAND_ACK | drone -> station | `{"cmdId":7,"status":"accepted"}`; `status` is `accepted`, `done` or `rejected` (with `"reason"`) |
| 0x20 | LOG_BEGIN | drone -> station | `{"logId":"flight-003","size":1048576,"sha256":"<64 hex>"}` |
| 0x21 | LOG_CHUNK | drone -> station | **binary**: `u32 BE offset` then 1..16384 data bytes |
| 0x22 | LOG_ACK | station -> drone | `{"logId":"flight-003","offset":49152}` (bytes written to disk) |
| 0x23 | LOG_DONE | station -> drone | `{"logId":"flight-003","size":1048576,"sha256":"<hex>","ok":true}` |
| 0x30 | PING | station -> drone | `{"n":12,"t":123456.789}` (`t` = station `performance.now()` in ms) |
| 0x31 | PONG | drone -> station | exact copy of the PING body |
| 0x7F | ERROR | station -> drone | `{"code":"FRAME_TOO_BIG","message":"..."}`, then the station closes the connection (`socket.end()`) |

LOG_CHUNK body layout:

```
byte 0..3   u32 BE offset of the first data byte in the log
byte 4..    data, 1..16384 bytes
```

### Commands

| action | params | Notes |
|---|---|---|
| `takeoff` | `{alt}` (default 40) | rejected by the drone if battery < 10 % (`battery`) or if not on the ground (`airborne`) |
| `goto` | `{x, y, alt}` | rejected if on the ground or landing (`not airborne`) |
| `mission` | `{waypoints:[{x,y,alt}]}` | up to 16 waypoints; without `waypoints` the station fills in `defaultMission(droneId)` (`src/server/missions.js`) |
| `rth` | `{}` | return to the base, then land there |
| `land` | `{}` | land where the drone is |
| `set_udp_loss` | `{pct}` 0..100 | chaos knob: the drone drops that share of its own UDP datagrams (telemetry and echo replies) |

`cmdId` is a station-wide increasing integer. `accepted` means "received and understood"; `done` is sent when the physical action ends (takeoff reached altitude, goto arrived, mission finished, landed).

### Error codes

`BAD_FRAME` (malformed frame, duplicate HELLO), `FRAME_TOO_BIG`, `EMPTY_FRAME`, `BAD_JSON`, `NOT_HELLO` (first frame was not HELLO), `UNKNOWN_TYPE` (a frame type a drone must not send), `BAD_OFFSET` (chunk offset beyond the acknowledged offset), `BAD_LOG` (invalid `logId`/size/sha256, chunk without LOG_BEGIN, chunk past the declared size, storage error). `logId` must match `^[A-Za-z0-9_-]{1,40}$`.

## Session handshake and liveness

```
Drone                                   Station
  |  TCP connect  ----------------------->|
  |  HELLO {droneId, name, model, fw}  --->|
  |<------  WELCOME {sessionId, resumed:false, queued:0}
  |<------  PING {n:1, t}                  |   every 1 s
  |  PONG {n:1, t}  --------------------->|   station: TCP RTT = now - t
  |<------  COMMAND {cmdId, ...}           |
  |  COMMAND_ACK {cmdId, accepted}  ------>|
  |  COMMAND_ACK {cmdId, done}  ---------->|   when the action ends
```

- The first frame of a connection must be HELLO, otherwise `ERROR NOT_HELLO` and the connection is closed.
- `sessionId` is 4 random bytes in hex, created by the station. A HELLO carrying the current `sessionId` of that drone, received less than `sessionTtlMs` (120 s) after the last frame (or disconnection) of that drone, gives `resumed: true`. Anything else starts a new session.
- A new connection for the same `droneId` destroys the previous socket.
- The station sends PING every `pingMs` (1 s) and closes a connection that sent nothing for `idleMs` (5 s). The drone applies the same 5 s silence rule to the station and reconnects.
- Reconnection: the drone retries after 1.5 s, 3 s, then 5 s (repeated, unlimited), and resets the sequence once a WELCOME arrives.

## Reliability on top of TCP

### Command outbox and deduplication

- Every command is stored in a per-drone **outbox** on the station before being written. It leaves the outbox when a `COMMAND_ACK` for that `cmdId` arrives (`accepted`, `done` or `rejected` all end the retransmission).
- If the drone is disconnected, `sendCommand` returns `status: "queued"` and nothing is written. After the next HELLO/WELCOME, the station writes the whole outbox again, in `cmdId` order. The `queued` field of WELCOME is the size of the outbox.
- This is **at-least-once** delivery: after a cut, a command whose ACK was lost is sent again. The drone therefore remembers the result of every `cmdId` it has handled (in memory, for the life of the process). A duplicate gets the stored ACK again and is **not executed twice**. At-least-once plus deduplication gives the effect of exactly-once.
- Limit, by design: the `done` ACK is sent once. If the link is down at that moment it is lost and not retransmitted; the outbox is already empty because `accepted` was acknowledged earlier.

### Resumable log upload

The log is a binary file of `size` bytes. The drone sends it as chunks of at most 16384 bytes, with at most 4 chunks in flight (`logWindow`), one chunk at most every `logChunkIntervalMs` (100 ms by default in the simulator).

Station rules:

- File: `<dataDir>/logs/<name>/<logId>.part`.
- `LOG_BEGIN` answers with `LOG_ACK {offset}`, where `offset` is **the size of the `.part` file on disk** (0 if absent). The disk is the single source of truth for resuming; the station does not keep a separate counter.
- `LOG_CHUNK` with `offset == acked`: append to the file with `fs.appendFileSync`, then send `LOG_ACK`. The ACK is only sent after the write.
- `offset < acked` (duplicate): ignored, `LOG_ACK` repeated. `offset > acked`: `ERROR BAD_OFFSET`.
- When `acked == size`: SHA-256 of the whole file; rename to `.bin` if it matches the declared digest and size, otherwise `.bad`; send `LOG_DONE {ok}`.
- If `LOG_BEGIN` arrives for a log whose `.bin` already exists with the right size and digest (the LOG_DONE was lost), the station answers `LOG_ACK` and `LOG_DONE ok:true` again.

Drone rules: on every WELCOME, if an upload is pending, send `LOG_BEGIN` again, wait for the `LOG_ACK`, and restart sending at that offset. The same path serves the first upload and every resume.

### Resume sequence (as exercised by `npm run demo`)

```
Drone                          Station
HELLO{no session} ───────────▶
               ◀────────────── WELCOME{sessionId:s1,resumed:false}
LOG_BEGIN{size:1048576} ─────▶
               ◀────────────── LOG_ACK{offset:0}
LOG_CHUNK off=0.. (window 4) ▶ ◀── LOG_ACK{offset:16384} ...
               ◀────────────── RST (chaos: resetAndDestroy)   [command goto #10 -> queued]
… back-off 1.5 s, new TCP handshake …
HELLO{sessionId:s1} ─────────▶
               ◀────────────── WELCOME{resumed:true,queued:1}
               ◀────────────── COMMAND #10 goto
COMMAND_ACK #10 accepted ────▶
LOG_BEGIN{same logId} ───────▶
               ◀────────────── LOG_ACK{offset:425984}   (resume point = bytes on disk)
LOG_CHUNK off=425984.. ──────▶ ... ◀── LOG_ACK ... LOG_DONE{ok:true}
```

The cut is made by the station (`socket.resetAndDestroy()`), which sends a TCP RST that is visible in Wireshark (`tcp.flags.reset == 1`). The drone sees the connection close, waits for its back-off and reconnects.

#### Measured example (full `npm run demo`, 1 MiB log)

From `captures/demo-timeline.txt`: Charlie's link was reset at T+18.8 s with 425,984 bytes on disk; Charlie reconnected at T+20.4 s, the session was resumed and the 1 queued command was delivered; the upload resumed at byte 425,984; the SHA-256 was verified at T+24.5 s.

One detail worth noting: the `LOG_ACK` for 425,984 was **never sent**. The link was reset right after the chunk reached the disk and before the ACK was written, so the drone's last received ACK was for 409,600. The station still answered the new `LOG_BEGIN` with 425,984, because the resume point is the size of the `.part` file, not the last ACK that left. Resuming from the last ACK the drone had seen would only have re-sent 16,384 bytes, which the station would have ignored as duplicates; but resuming from the receiver's disk needs no assumption about which ACKs made it.

## SLTP datagrams (UDP 7401)

Common header, 6 bytes:

| Offset | Size | Field |
|---|---|---|
| 0 | u16 | magic `0x534C` ("SL") |
| 2 | u8 | version = 1 |
| 3 | u8 | type: 1 TELEMETRY, 2 ECHO_REQ, 3 ECHO_REP |
| 4 | u8 | droneId |
| 5 | u8 | flags = 0 |

**TELEMETRY** (type 1, drone -> station, 36 bytes, 10 Hz):

| Offset | Size | Field |
|---|---|---|
| 6 | u32 | seq (increments for every datagram, sent or not) |
| 10 | u32 | tsMs: ms since the drone started, modulo 2^32 |
| 14 | f32 | x (m) |
| 18 | f32 | y (m) |
| 22 | f32 | alt (m) |
| 26 | f32 | speed (m/s) |
| 30 | f32 | heading (degrees) |
| 34 | u8 | battery (%) |
| 35 | u8 | state: 0 LANDED, 1 TAKEOFF, 2 HOVER, 3 GOTO, 4 MISSION, 5 RTH, 6 LANDING |

**ECHO_REQ** (type 2, station -> drone) and **ECHO_REP** (type 3, drone -> station), 14 bytes:

| Offset | Size | Field |
|---|---|---|
| 6 | u32 | echoSeq |
| 10 | u32 | t0us: station clock in microseconds, truncated to u32 |

The drone copies `echoSeq` and `t0us` unchanged into the reply. The station computes RTT = `(nowUs - t0us) >>> 0` microseconds, so the measurement uses one clock only. The station sends one ECHO_REQ per second to each drone whose UDP address it knows.

Rules:

- The station learns a drone's UDP address from the source address of its first TELEMETRY datagram.
- A datagram with a wrong length, magic, version or type, or from a `droneId` that never sent a HELLO on TCP, is ignored and counted in `totals.udpDropped`.
- The drone only starts sending telemetry after its first WELCOME (the station would drop it otherwise). After that it keeps sending even while TCP is down.
- Simulated loss happens **at the sender**: the drone increments `seq` and does not send. The loopback interface never loses packets, so this is how loss is injected. The instruction travels over TCP (`COMMAND set_udp_loss`), which makes it work whichever process runs the drones. Echo replies are subject to the same loss.

## Statistics (`SeqStats`)

Computed by the station per drone, from `seq` and `tsMs`:

- `received`: unique datagrams received (duplicates excluded).
- `expected = maxSeq - firstSeq + 1`. `lost = max(0, expected - received)`. `lossPct = 100 * lost / expected`.
- `recentLossPct`: the same computation over the last 100 sequence numbers (`maxSeq - 99 .. maxSeq`, fewer at the start).
- `outOfOrder`: +1 for each datagram whose `seq` is lower than the highest seen. `duplicates`: +1 for a `seq` already seen in the last 100.
- Sequence numbers are unwrapped across 2^32 before comparison.
- `jitterMs`, RFC 3550 interarrival jitter: `transit = arrivalMs - tsMs`, `D = |transit - previousTransit|`, `J = J + (D - J) / 16`. The unknown offset between the two clocks cancels out in the difference.
- `pps`: datagrams received during the last second.
- RTT values shown in the UI and the demo summary are the latest sample of each tracker (`RttTracker.last`); `RttTracker` also keeps the average of the last 20 samples (`avg`).
- TCP RTT comes from PING/PONG (station clock, ms with decimals). UDP RTT comes from ECHO.

Note that `lossPct` is cumulative since the first datagram. In the demo, Delta's loss was set to 15 % at T+12 s, so its whole-run figure (13.4 %) is lower than the setting; measured since the order it was 15.4 %.
