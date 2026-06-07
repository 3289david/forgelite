import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
  dataDir,
  reposDir: path.join(dataDir, 'repos'),
  dbPath: path.join(dataDir, 'forgelite.db'),
  baseUrl: process.env.BASE_URL ?? 'http://localhost:3000',
};
