import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const port = parseInt(process.env.PORT ?? '3000', 10);

export const config = {
  port,
  host: process.env.HOST ?? '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
  dataDir,
  reposDir: path.join(dataDir, 'repos'),
  dbPath: path.join(dataDir, 'forgelite.db'),
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  // HTTPS — auto-generates self-signed cert; set SSL_CERT+SSL_KEY for trusted certs (mkcert)
  httpsPort: parseInt(process.env.HTTPS_PORT ?? String(port + 1), 10),
  sslCert: process.env.SSL_CERT ?? '',
  sslKey: process.env.SSL_KEY ?? '',
};
