import express from 'express';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
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
  res.locals.config = { baseUrl: config.baseUrl };
  next();
});

// Git HTTP protocol — must come before general routes
app.use(gitRouter);

// REST API
app.use('/api/auth', apiAuthRouter);
app.use('/api/users', apiUsersRouter);
app.use('/api/repos', apiReposRouter);
app.use('/api/repos/:owner/:repo/issues', apiIssuesRouter);
app.use('/api/repos/:owner/:repo/pulls', apiPullsRouter);

// HTML pages
app.use(pagesRouter);

// 404
app.use((_req, res) => {
  res.status(404).render('error', { code: 404, message: 'Page not found' });
});

// 500
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).render('error', { code: 500, message: 'Internal server error' });
});

getDb(); // Initialize DB

app.listen(config.port, config.host, () => {
  console.log(`\n  ForgeLite running at ${config.baseUrl}\n`);
});

export default app;
