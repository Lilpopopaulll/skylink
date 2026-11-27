// `npm start`: run the ground station until Ctrl+C.
import { startServer } from './index.js';

try {
  const server = await startServer();
  const { host } = server.config;
  const { tcp, udp, http } = server.ports;
  console.log(`SkyLink ground station  TCP ${host}:${tcp}  UDP ${host}:${udp}  UI http://${host}:${http}`);
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${err.port ?? ''} is already in use. Is another SkyLink station running? Stop it, or set SKY_TCP_PORT / SKY_UDP_PORT / SKY_HTTP_PORT.`);
  } else {
    console.error(`Could not start SkyLink: ${err.message}`);
  }
  process.exit(1);
}
