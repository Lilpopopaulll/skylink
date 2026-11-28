# SkyLink
**Paul DROCHON- 26040192**

SkyLink is a drone-fleet control center. A ground station talks to simulated drones over two protocols built from scratch: **SLCP** on TCP for commands, incident alerts and reliable flight-log upload, and **SLTP** on UDP for 10 Hz telemetry. A live web dashboard and a Wireshark dissector make every exchange visible.

Zero dependencies: Node's standard library only.

## Features

- **Fleet control over TCP (SLCP).** Take off, go to a point, fly a mission, return home, land. Each command gets a `cmdId` and a `COMMAND_ACK`. If a drone's link is down, its commands are queued and delivered as soon as it reconnects; the TCP session resumes instead of starting over.
- **Resumable flight-log upload.** A drone uploads a 1 MiB flight log in chunks. If the connection drops mid-upload, the upload restarts from the byte the station actually has on disk, and the file is checked with SHA-256 at the end.
- **Telemetry over UDP (SLTP).** Position, altitude, speed and battery at 10 Hz. The station measures what UDP does not hide: loss, reordering, duplicates, jitter and round-trip time (echo probes). Loss can be injected per drone to watch the figures move.
- **Incident alerts and automatic failsafe (real-world feature).** See the next section.
- **Live dashboard.** Map with trails, per-drone TCP and UDP figures, a protocol inspector showing each frame, an Incidents panel, and chaos buttons (cut TCP, set UDP loss, inject a fault).
- **Wireshark dissector.** `tools/wireshark/skylink.lua` decodes every SLCP and SLTP message, including ALERT and ALERT_ACK.

## Real-world feature: incident alerts and automatic failsafe

In a real fleet, the dangerous moment is when a drone has a problem and nobody reacts in time. SkyLink lets each drone report its incidents to the station, and the station reacts on its own.

**Incidents a drone can report**

| Incident | Severity | Station's automatic action |
|---|---|---|
| `gps_degraded` | info | logged only |
| `battery_low` (30 % or less) | warning | `rth` (return to home) |
| `geofence_breach` (outside the flight area) | warning | `rth` |
| `battery_critical` (10 % or less) | critical | `land` immediately |
| `motor_failure` | critical | `land` immediately |

Battery and geofence incidents are detected by the drone itself from its physical state (`src/sim/incidents.js`). Motor failure and degraded GPS only happen when you inject them.

**How it travels**

1. The drone sends an `ALERT` frame over TCP (`alertId`, `kind`, `severity`).
2. The station answers with `ALERT_ACK`, which tells the drone which action it took and the `cmdId` of the failsafe command, if any.
3. The failsafe command (`rth` or `land`) is sent like any other command.
4. If the TCP link is down when the incident happens, the alert waits on the drone and is sent right after the session resumes. The station records its age, so you can see how late it arrived.
5. A retransmitted alert (same `alertId`) is acknowledged again but the failsafe is never applied twice.
6. The severity comes from the station's own table, not from the drone, so a faulty drone cannot downgrade a critical incident.

Code: `ALERT` / `ALERT_ACK` in `src/protocol/slcp.js`, detection in `src/sim/incidents.js` and `src/sim/drone.js`, failsafe in `src/server/tcp.js`, Incidents panel in `public/`. Protocol details in `docs/protocol.md`.

## Requirements

- Node.js 22 or newer. Nothing to install: `npm install` is not needed.
- Optional: Wireshark with Npcap and "Support loopback traffic" enabled, to look at the frames.

## Try it yourself

**1. Start the station and the fleet** (two terminals, from the project folder):

```
npm start          # ground station: TCP 7400, UDP 7401, dashboard on http://127.0.0.1:8400
npm run fleet      # 4 simulated drones: Alpha, Bravo, Charlie, Delta
```

`npm run fleet -- --count 6` starts up to 8 drones; `npm run fleet -- --loss 10` adds 10 % UDP loss to all of them.

**2. Open the dashboard:** http://127.0.0.1:8400. The four drones appear on the map, landed.

**3. Fly them.** On a drone's card, click *Take off*, then *Mission*. Watch the commands and their ACKs appear in the protocol inspector, and the UDP figures (loss, jitter, RTT) update live.

**4. Trigger an incident.** On a flying drone's card, open *Inject fault…* and pick:
- *Motor failure*: the drone is circled in red on the map, a critical line appears in the Incidents panel with action `land` and its ACK, and the drone lands where it is.
- *Battery low*: a warning badge, action `rth`; the drone flies back to its base.
- *GPS degraded*: an info line, no action; the drone keeps flying.

**5. Cut the link.** Click *Cut TCP (RST)* on a flying drone, then *Land* right away: the command shows as queued, the drone reconnects on its own (the *Reconnects* counter goes up), the session resumes and the queued command is delivered. Alerts raised while the link is down follow the same path: they wait on the drone and are sent after the resume, with their age (covered by `test/drone.test.js` and `test/tcp.test.js`).

**6. Play with UDP.** The *UDP loss* selector sets a loss rate on one drone (0, 5, 15 or 30 %): the *Loss (recent)* figure in its card converges to that value, and jitter and RTT are plotted live.

**Same thing from a terminal** (station running, PowerShell or any shell with curl):

```
curl -X POST http://127.0.0.1:8400/api/command -H "Content-Type: application/json" -d "{\"droneId\":1,\"action\":\"takeoff\",\"params\":{}}"
curl -X POST http://127.0.0.1:8400/api/chaos   -H "Content-Type: application/json" -d "{\"droneId\":1,\"kind\":\"fault\",\"fault\":\"motor_failure\"}"
curl http://127.0.0.1:8400/api/state
```

In `/api/state`, the `incidents` list holds every alert with its severity, action and ACK.

**See it in Wireshark.** Capture on the loopback adapter, load `tools/wireshark/skylink.lua` (Help > About > Folders > Personal Lua Plugins, then Analyze > Reload Lua Plugins) and filter with `slcp || sltp`. A recorded capture is in `captures/demo.pcapng`, with its timeline in `captures/demo-timeline.txt` (recorded before the incident feature, so it has no ALERT frames). Example runs, each with the received log and a `summary.json`, are in `data/`.

## Tests

```
npm test    # node --test test/*.test.js
```

Covers the codecs, statistics, the TCP server (framing errors, session resume, command queue, resumable upload, SHA-256 mismatch, incident alerts and failsafe), UDP statistics, the HTTP API, drone physics and behaviour, incident detection and the UI files.

## Ports and configuration

| Port | Protocol | Variable |
|---|---|---|
| 7400 TCP | SLCP | `SKY_TCP_PORT` |
| 7401 UDP | SLTP | `SKY_UDP_PORT` |
| 8400 HTTP | UI, API, SSE | `SKY_HTTP_PORT` |

Other variables: `SKY_HOST` (default `127.0.0.1`; use `0.0.0.0` for a real LAN, which may trigger the Windows firewall prompt), `SKY_DATA` (folder for received logs, default `data/`). The code uses `127.0.0.1` rather than `localhost` on purpose, so that nothing resolves to IPv6 `::1`. A fleet on another machine: `node src/sim/fleet.js --host <station-ip>`.

## HTTP API

| Route | Description |
|---|---|
| `GET /api/state` | Full JSON snapshot: ports, totals, drones (TCP/UDP figures, telemetry, trail, history, log), incidents, protocol inspector, events |
| `GET /events` | Server-sent events: one `state` event (full snapshot) every 250 ms |
| `POST /api/command` | `{"droneId":1,"action":"takeoff","params":{}}` returns 202 `{cmdId, status}` with `status` `sent` or `queued`. Actions: `takeoff`, `goto`, `mission`, `rth`, `land`, `set_udp_loss`, `inject_fault` |
| `POST /api/chaos` | `{"droneId":1,"kind":"udp_loss","pct":15}` or `{"droneId":1,"kind":"cut_tcp"}` returns `{ok}`; `{"droneId":1,"kind":"fault","fault":"motor_failure"}` returns `{ok, cmdId, status}` (`fault` is one of `battery_low`, `battery_critical`, `motor_failure`, `geofence_breach`, `gps_degraded`) |

Errors: 400 for bad JSON, action or parameters, 404 for an unknown drone, 413 above 4096 bytes. Static files come from `public/`.

## Assignment mapping

| Requirement | Where |
|---|---|
| TCP backend | `src/server/tcp.js` (sessions, command outbox, resumable log upload, alerts and failsafe, PING/PONG), framing in `src/protocol/slcp.js` |
| UDP backend | `src/server/udp.js` (telemetry statistics, echo probes), datagrams in `src/protocol/sltp.js`, statistics in `src/protocol/stats.js` |
| Client side (drones) | `src/sim/drone.js`, `src/sim/fleet.js`, `src/sim/incidents.js` |
| Protocol demonstrated in the UI | `public/` (map, per-drone TCP/UDP figures, protocol inspector, Incidents panel, chaos buttons) served by `src/server/http.js` |
| Protocol demonstrated in Wireshark | `tools/wireshark/skylink.lua`, `captures/demo.pcapng`, `captures/demo-timeline.txt` |
| Real-world feature | Incident alerts and automatic failsafe (section above) |
| Protocol specification | `docs/protocol.md` |

## Layout

```
src/config.js            constants and environment variables
src/protocol/            slcp.js, sltp.js, stats.js
src/server/              tcp.js, udp.js, http.js, state.js, bus.js, missions.js, index.js, cli.js
src/sim/                 drone.js, fleet.js, physics.js, incidents.js, flightlog.js, rng.js
public/                  index.html, app.js, map.js, charts.js, style.css
tools/wireshark/         skylink.lua (dissectors for SLCP and SLTP)
docs/                    protocol.md
captures/                demo.pcapng, demo-timeline.txt
data/                    example runs (received flight logs, summary.json)
test/                    *.test.js, helpers/net.js
```

## License

MIT, see `LICENSE`.
