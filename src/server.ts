import express from 'express';
import http from 'http';
import https from 'https';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { authMiddleware } from './middleware/auth';
import { getDb } from './db/database';
import { config } from './config';
import { timeAgo, formatDate } from './lib/time';

import apiAuthRouter from './routes/api/auth';
import apiUsersRouter from './routes/api/users';
import apiReposRouter from './routes/api/repos';
import apiIssuesRouter from './routes/api/issues';
import apiPullsRouter from './routes/api/pulls';
import gitRouter from './routes/git';
import pagesRouter from './routes/pages';

fs.mkdirSync(config.reposDir, { recursive: true });

const app = express();

app.set('trust proxy', 1);
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src', 'views'));
app.use(express.static(path.join(process.cwd(), 'public')));

app.use(authMiddleware);

app.use((req, res, next) => {
  res.locals.user = (req as any).user ?? null;
  res.locals.timeAgo = timeAgo;
  res.locals.formatDate = formatDate;
  res.locals.config = { baseUrl: config.baseUrl, httpsPort: config.httpsPort };
  next();
});

app.use(gitRouter);

app.use('/api/auth', apiAuthRouter);
app.use('/api/users', apiUsersRouter);
app.use('/api/repos', apiReposRouter);
app.use('/api/repos/:owner/:repo/issues', apiIssuesRouter);
app.use('/api/repos/:owner/:repo/pulls', apiPullsRouter);

app.use(pagesRouter);

app.use((_req, res) => {
  res.status(404).render('error', { code: 404, message: 'Page not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).render('error', { code: 500, message: 'Internal server error' });
});

getDb();

// ── Start HTTP ────────────────────────────────────────────────────────────────
http.createServer(app).listen(config.port, config.host, () => {
  console.log(`\n  ForgeLite`);
  console.log(`  HTTP  → http://localhost:${config.port}`);
});

// ── Start HTTPS (auto self-signed cert) ───────────────────────────────────────
function startHTTPS(): void {
  const autoCert = path.join(config.dataDir, 'ssl.crt');
  const autoKey  = path.join(config.dataDir, 'ssl.key');

  const certPath = config.sslCert || autoCert;
  const keyPath  = config.sslKey  || autoKey;

  // Generate self-signed cert if no custom cert provided and none exists yet
  if (!config.sslCert && !fs.existsSync(autoCert)) {
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', autoKey,
        '-out',    autoCert,
        '-days',   '3650',
        '-nodes',
        '-subj',   '/CN=localhost/O=ForgeLite',
      ], { stdio: 'pipe' });
    } catch {
      console.log('  HTTPS → disabled (openssl not found; set SSL_CERT+SSL_KEY env vars to enable)');
      return;
    }
  }

  try {
    const opts = {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    };
    https.createServer(opts, app).listen(config.httpsPort, config.host, () => {
      console.log(`  HTTPS → https://localhost:${config.httpsPort}`);
      if (!config.sslCert) {
        console.log(`\n  ⚠  Self-signed cert — browser will show a warning.`);
        console.log(`     Click Advanced → Proceed to accept, or use mkcert for a trusted cert:`);
        console.log(`       brew install mkcert && mkcert -install && mkcert localhost`);
        console.log(`       SSL_CERT=localhost.pem SSL_KEY=localhost-key.pem npm run dev\n`);
      }
    });
  } catch (e) {
    console.error('  HTTPS failed to start:', (e as Error).message);
  }
}

startHTTPS();

export default app;
