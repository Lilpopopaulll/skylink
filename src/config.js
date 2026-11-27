// SkyLink configuration: every tunable constant lives here. Env is read once in loadConfig().
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CALLSIGNS = Object.freeze([
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
]);

export const COLORS = Object.freeze([
  '#3ad1ff', '#a78bfa', '#fbbf24', '#f472b6', '#36d399', '#fb923c', '#94a3b8', '#e879f9',
]);

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number (0..65535), got "${raw}"`);
  return n;
}

function findEdge() {
  if (process.env.SKY_EDGE) return process.env.SKY_EDGE;
  return EDGE_PATHS.find((p) => fs.existsSync(p)) ?? EDGE_PATHS[0];
}

export function loadConfig(overrides = {}) {
  const base = {
    host: process.env.SKY_HOST || '127.0.0.1',
    tcpPort: envPort('SKY_TCP_PORT', 7400),
    udpPort: envPort('SKY_UDP_PORT', 7401),
    httpPort: envPort('SKY_HTTP_PORT', 8400),
    dataDir: process.env.SKY_DATA ? path.resolve(process.env.SKY_DATA) : path.join(ROOT, 'data'),
    maxFrameLen: 20000,
    maxJsonBody: 4096,
    logChunk: 16384,
    logWindow: 4,
    pingMs: 1000,
    idleMs: 5000,
    echoMs: 1000,
    telemetryHz: 10,
    sessionTtlMs: 120000,
    backoffMs: [1500, 3000, 5000], // last value repeated, unlimited attempts
    sseMs: 250,
    historyMs: 1000,
    area: { w: 1000, h: 1000 }, // metres
    edgePath: findEdge(),
  };
  const cfg = { ...base, ...overrides };
  cfg.backoffMs = Object.freeze([...cfg.backoffMs]);
  cfg.area = Object.freeze({ ...cfg.area });
  return Object.freeze(cfg);
}

export const CONFIG = loadConfig();

/** Home base of a drone (droneId is 1-based). Alpha..Delta in the corners, the rest on y=500. */
export function homeFor(droneId) {
  switch (droneId) {
    case 1: return { x: 150, y: 150 };
    case 2: return { x: 850, y: 150 };
    case 3: return { x: 150, y: 850 };
    case 4: return { x: 850, y: 850 };
    default: return { x: 150 + (droneId - 5) * 100, y: 500 };
  }
}
