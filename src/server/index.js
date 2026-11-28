// SkyLink ground station: TCP (SLCP) + UDP (SLTP) + HTTP in one process, one shared fleet state.
import path from 'node:path';
import { loadConfig, ROOT } from '../config.js';
import { Bus } from './bus.js';
import { FleetState } from './state.js';
import { startTcp } from './tcp.js';
import { startUdp } from './udp.js';
import { startHttp } from './http.js';

/**
 * @param {object} [overrides]  any loadConfig() key (tcpPort/udpPort/httpPort 0 = ephemeral, dataDir,
 *                              pingMs, idleMs, echoMs, sseMs, historyMs, kaMs...) plus `publicDir`.
 */
export async function startServer(overrides = {}) {
  const { publicDir = path.join(ROOT, 'public'), ...cfg } = overrides;
  const config = loadConfig(cfg);
  const bus = new Bus();
  const state = new FleetState({ bus, config });
  const started = [];
  let tcp;
  let udp;
  let httpServer;
  try {
    tcp = await startTcp({ config, state, bus });
    started.push(tcp);
    udp = await startUdp({ config, state, bus });
    started.push(udp);
    httpServer = await startHttp({ config, state, tcp, publicDir });
    started.push(httpServer);
  } catch (err) {
    await Promise.allSettled(started.map((s) => s.close()));
    throw err;
  }
  state.ports = { tcp: tcp.port, udp: udp.port, http: httpServer.port };

  const historyTimer = setInterval(() => state.sampleHistory(), config.historyMs);
  historyTimer.unref();

  let closing = null;
  const sendCommand = (droneId, action, params) => tcp.sendCommand(droneId, action, params);
  return {
    config,
    ports: { ...state.ports },
    state,
    bus,
    sendCommand,
    setUdpLoss: (droneId, pct) => sendCommand(droneId, 'set_udp_loss', { pct }),
    injectFault: (droneId, fault) => sendCommand(droneId, 'inject_fault', { fault }),
    cutTcp: (droneId) => tcp.cutTcp(droneId),
    close() {
      closing ??= (async () => {
        clearInterval(historyTimer);
        await Promise.allSettled([httpServer.close(), udp.close(), tcp.close()]);
      })();
      return closing;
    },
  };
}
