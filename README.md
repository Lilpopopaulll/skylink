# SkyLink
**Paul DROCHON- 26040192**

SkyLink is a drone-fleet control center. A ground station talks to four simulated drones over two protocols built from scratch: **SLCP** on TCP for commands and reliable flight-log upload, and **SLTP** on UDP for 10 Hz telemetry.
It shows what each transport is good at: commands queue during a disconnection and are delivered after reconnection, an interrupted 1 MiB upload resumes where the server's disk says it stopped, and UDP loss, reordering and jitter are measured instead of hidden. Drones also report incidents (low battery, motor failure, geofence breach...) with acknowledged, queued **ALERT** messages, and the station applies an automatic failsafe by severity (`rth` or `land`).
A live web dashboard, a Wireshark dissector and a scripted demo make all of it visible. Zero dependencies: Node's standard library only.

## Assignment mapping

| Requirement | Where |
|---|---|
| TCP backend | `src/server/tcp.js` (sessions, command outbox, resumable log upload, PING/PONG), framing in `src/protocol/slcp.js` |
| UDP backend | `src/server/udp.js` (telemetry statistics, echo probes), datagrams in `src/protocol/sltp.js`, statistics in `src/protocol/stats.js` |
| Client side (drones) | `src/sim/drone.js`, `src/sim/fleet.js` |
| Protocol demonstrated in the UI | `public/` (map, per-drone TCP/UDP figures, protocol inspector, chaos buttons) served by `src/server/http.js` |
| Protocol demonstrated in Wireshark | `tools/wireshark/skylink.lua`, `scripts/demo.js`, `captures/demo.pcapng`, `captures/demo-timeline.txt` |
| Real-world feature | Incident reporting and automatic failsafe: `ALERT` / `ALERT_ACK` in `src/protocol/slcp.js`, detection in `src/sim/incidents.js` and `src/sim/drone.js`, failsafe in `src/server/tcp.js`, "Incidents" panel in `public/` |
| Protocol specification | `docs/protocol.md` |

## Requirements

- Node.js 22 or newer.
- Microsoft Edge (Windows paths are searched; set `SKY_EDGE` otherwise): only for `npm run shots` and `npm run report:pdf`.
- Wireshark with Npcap and "Support loopback traffic" enabled: only to capture the demo.

## Quick start

```
npm start          # ground station: TCP 7400, UDP 7401, UI on http://127.0.0.1:8400
npm run fleet      # in a second terminal: 4 simulated drones (--count N up to 8, --loss PCT)
```

Open http://127.0.0.1:8400. `/?static=1` renders one snapshot without live updates.

## The demo

```
npm run demo        # 60 s scripted scenario, prints a summary and RESULT: OK or RESULT: FAIL <reasons>
npm run demo:hold   # same, then leaves the station and its UI open until Ctrl+C
```

Station and four drones run in one process but use real sockets on 127.0.0.1, so everything is visible in Wireshark. Scenario: all drones take off (T+3 s) and fly a mission (T+8 s); Delta's UDP loss is set to 15 % (T+12 s); Charlie starts uploading a 1 MiB flight log (T+16 s); at 40 % the station resets Charlie's TCP link and queues a `goto`; Charlie reconnects, the session resumes, the command is delivered, the upload resumes and its SHA-256 is verified. While the link is down Charlie detects `gps_degraded` (info): the alert waits on the drone and is delivered after the resume, with its age. At T+36 s Bravo gets `battery_low` (warning, the station sends `rth`) and Alpha gets `motor_failure` (critical, the station sends `land`); then the other drones return home (T+44 s) and land. The run folder `data/demo-YYYYMMDD-HHmmss/` holds the received log and `summary.json`. Options: `--duration N` (at least 10 s, compressed run), `--ephemeral` (free ports).

Result of the run recorded in `captures/demo-timeline.txt` (the full 60 s scenario; the drones were all landed at T+88.3 s): `RESULT: OK`. Charlie's link was reset at T+18.8 s with 425,984 bytes on disk, reconnected at T+20.4 s with the session resumed and 1 queued command delivered, the upload resumed at byte 425,984, SHA-256 verified at T+24.5 s. Delta's loss measured since the order: 15.4 % (set: 15 %). See `docs/protocol.md` for why the resume point was 425,984 although the last ACK the drone had seen was 409,600.

`captures/demo-timeline.txt` and `captures/demo.pcapng` were recorded before the incident feature: they contain no ALERT / ALERT_ACK frames. The dissector also decodes ALERT (0x40) and ALERT_ACK (0x41) in a new capture.

## Ports and configuration

| Port | Protocol | Variable |
|---|---|---|
| 7400 TCP | SLCP | `SKY_TCP_PORT` |
| 7401 UDP | SLTP | `SKY_UDP_PORT` |
| 8400 HTTP | UI, API, SSE | `SKY_HTTP_PORT` |

Other variables: `SKY_HOST` (default `127.0.0.1`; use `0.0.0.0` for a real LAN, which may trigger the Windows firewall prompt), `SKY_DATA` (folder for received logs, default `data/`), `SKY_EDGE` (path to `msedge.exe`). The code uses `127.0.0.1` rather than `localhost` on purpose, so that nothing resolves to IPv6 `::1`. A fleet on another machine: `node src/sim/fleet.js --host <station-ip>`.

## HTTP API

| Route | Description |
|---|---|
| `GET /api/state` | Full JSON snapshot: ports, totals, drones (TCP/UDP figures, telemetry, trail, history, log), protocol inspector, events |
| `GET /events` | Server-sent events: one `state` event (full snapshot) every 250 ms |
| `POST /api/command` | `{"droneId":1,"action":"takeoff","params":{}}` returns 202 `{cmdId, status}` with `status` `sent` or `queued`. Actions: `takeoff`, `goto`, `mission`, `rth`, `land`, `set_udp_loss`, `inject_fault` |
| `POST /api/chaos` | `{"droneId":1,"kind":"udp_loss","pct":15}` or `{"droneId":1,"kind":"cut_tcp"}` returns `{ok}`; `{"droneId":1,"kind":"fault","fault":"motor_failure"}` returns `{ok, cmdId, status}` (`sent` or `queued`; `fault` is one of `battery_low`, `battery_critical`, `motor_failure`, `geofence_breach`, `gps_degraded`) |

Errors: 400 for bad JSON, action or parameters, 404 for an unknown drone, 413 above 4096 bytes. Static files come from `public/`.

## Tests

```
npm test    # node --test test/*.test.js
```

93 tests: codecs, statistics, the TCP server (framing errors, session resume, command queue, resumable upload, SHA-256 mismatch, incident alerts), UDP statistics, HTTP API, drone physics and behaviour, UI file checks, report builder, and a compressed demo run.

## Layout

```
src/config.js            constants and environment variables
src/protocol/            slcp.js, sltp.js, stats.js
src/server/              tcp.js, udp.js, http.js, state.js, bus.js, missions.js, index.js, cli.js
src/sim/                 drone.js, fleet.js, physics.js, incidents.js, flightlog.js, rng.js
public/                  index.html, app.js, map.js, charts.js, style.css, phone.html
tools/wireshark/         skylink.lua (dissectors for SLCP and SLTP)
scripts/                 demo.js, shots.js, build-report.js
report/                  report.src.html, img/
docs/                    protocol.md
captures/                demo.pcapng, demo-timeline.txt
test/                    *.test.js, helpers/net.js
```

## License

MIT, see `LICENSE`.
