// SLTP server (UDP): telemetry statistics, periodic ECHO_REQ, RTT from ECHO_REP.
import dgram from 'node:dgram';
import { DT, ECHO_LEN, decodeDatagram, encodeEcho, nowUs } from '../protocol/sltp.js';

/** @returns {Promise<{port:number, close:Function}>} */
export function startUdp({ config, state, bus }) {
  void bus; // events for UDP (udp:echo) are emitted by FleetState.onEcho
  const socket = dgram.createSocket({ type: 'udp4' });
  let timer = null;
  let closed = false;

  socket.on('message', (msg, rinfo) => {
    const d = decodeDatagram(msg);
    if (!d) {
      state.totals.udpDropped++;
      return;
    }
    if (d.type === DT.TELEMETRY) {
      state.onTelemetry(d, rinfo);
    } else if (d.type === DT.ECHO_REP) {
      const rttMs = Math.round(((nowUs() - d.t0us) >>> 0) / 10) / 100; // us -> ms, 2 decimals
      if (state.onEcho(d.droneId, rttMs)) {
        state.inspect({
          proto: 'UDP', dir: 'rx', drone: state.nameOf(d.droneId), type: 'ECHO_REP', size: ECHO_LEN,
          info: `#${d.echoSeq} rtt=${rttMs.toFixed(2)} ms`,
        });
      }
    } else {
      state.totals.udpDropped++; // ECHO_REQ is server -> drone only
    }
  });
  socket.on('error', () => {}); // a failed send must never crash the station

  function sendEchoes() {
    if (closed) return;
    for (const rec of state.drones.values()) {
      if (!rec.udp.addr) continue;
      const seq = ++rec.udp.echoSeq;
      const buf = encodeEcho(DT.ECHO_REQ, rec.id, seq, nowUs());
      socket.send(buf, rec.udp.addr.port, rec.udp.addr.address, () => {});
      state.inspect({ proto: 'UDP', dir: 'tx', drone: rec.name, type: 'ECHO_REQ', size: ECHO_LEN, info: `#${seq}` });
    }
  }

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(config.udpPort, config.host, () => {
      socket.off('error', reject);
      timer = setInterval(sendEchoes, config.echoMs);
      timer.unref();
      resolve({
        port: socket.address().port,
        close() {
          closed = true;
          clearInterval(timer);
          return new Promise((done) => socket.close(() => done()));
        },
      });
    });
  });
}
