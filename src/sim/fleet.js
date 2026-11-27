// Fleet launcher: N simulated drones, each with its own TCP and UDP sockets.
//   node src/sim/fleet.js --count 4 --host 127.0.0.1 --loss 0
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.js';
import { Drone } from './drone.js';

/**
 * @param {object} [o]  count, host, tcpPort, udpPort, rateHz, seed; any other key goes to every Drone
 *                      (udpLossPct, backoffMs, logChunkIntervalMs, timeScale...).
 * @returns {{drones: Drone[], stop: () => Promise<void>}}
 */
export function startFleet({ count = 4, host = CONFIG.host, tcpPort = CONFIG.tcpPort, udpPort = CONFIG.udpPort, rateHz, seed = 1, ...rest } = {}) {
  const drones = [];
  for (let i = 0; i < count; i++) {
    const opts = {
      droneId: i + 1, host, tcpPort, udpPort, seed: seed + i, ...rest,
    };
    if (rateHz !== undefined) opts.rateHz = rateHz;
    drones.push(new Drone(opts));
  }
  for (const d of drones) d.start();
  return {
    drones,
    async stop() {
      await Promise.all(drones.map((d) => d.stop()));
    },
  };
}

// ---- CLI ---------------------------------------------------------------------------------------

const USAGE = 'Usage: node src/sim/fleet.js [--count N] [--host IP] [--loss PCT] [--tcp-port P] [--udp-port P] [--rate HZ]';

function parseArgs(argv) {
  const out = {};
  const num = (name, v, min, max) => {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isFinite(n) || n < min || n > max) {
      throw new Error(`Invalid value for ${name}: ${v}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case '--count': out.count = Math.trunc(num(a, v, 1, 8)); i++; break;
      case '--host': if (!v) throw new Error('Missing value for --host'); out.host = v; i++; break;
      case '--loss': out.udpLossPct = num(a, v, 0, 100); i++; break;
      case '--tcp-port': out.tcpPort = Math.trunc(num(a, v, 1, 65535)); i++; break;
      case '--udp-port': out.udpPort = Math.trunc(num(a, v, 1, 65535)); i++; break;
      case '--rate': out.rateHz = num(a, v, 1, 200); i++; break;
      default: throw new Error(`Unknown option: ${a}`);
    }
  }
  return out;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const fleet = startFleet(opts);
  const host = opts.host ?? CONFIG.host;
  const tcpPort = opts.tcpPort ?? CONFIG.tcpPort;
  console.log(`SkyLink fleet: ${fleet.drones.length} drones -> ${host}:${tcpPort} (TCP), UDP ${opts.udpPort ?? CONFIG.udpPort}`);
  for (const d of fleet.drones) {
    d.on('connected', ({ resumed }) => {
      const kind = d.stats.reconnects > 0 ? 'reconnected' : 'connected';
      console.log(`${d.name} ${kind} (${resumed ? 'session resumed' : 'new session'} ${d.sessionId})`);
    });
    d.on('disconnected', ({ reason }) => console.log(`${d.name} disconnected (${reason}), retrying`));
  }
  const shutdown = async () => {
    await fleet.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
