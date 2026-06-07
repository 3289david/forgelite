import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getDb } from '../db/database';
import { resolveBasicAuth, AuthedRequest } from '../middleware/auth';
import { config } from '../config';

const router = Router();

// Matches: /owner/repo.git/...
const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

function repoPath(owner: string, name: string): string {
  return path.join(config.reposDir, owner, name + '.git');
}

function getRepoForGit(owner: string, name: string) {
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) return null;
  return getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, name) as
    { id: number; is_private: number; owner_id: number } | undefined;
}

function serveGitBackend(req: Request, res: Response, rp: string, pathInfo: string): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: config.reposDir,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: (req.url.split('?')[1] ?? ''),
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: req.headers['content-length'] ?? '0',
    HTTP_GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
    REMOTE_ADDR: req.ip ?? '127.0.0.1',
    SERVER_NAME: req.hostname,
    SERVER_PORT: String(config.port),
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
    SERVER_SOFTWARE: 'ForgeLite/1.0',
  };

  const child = spawn('git', ['http-backend'], { env });

  req.pipe(child.stdin);
  child.stdin.on('error', () => {});

  let buf = Buffer.alloc(0);
  let headersDone = false;

  child.stdout.on('data', (chunk: Buffer) => {
    if (headersDone) { res.write(chunk); return; }
    buf = Buffer.concat([buf, chunk]);
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) return;

    headersDone = true;
    const headerText = buf.slice(0, sep).toString('utf8');
    const body = buf.slice(sep + 4);

    let status = 200;
    const lines = headerText.split('\r\n');
    for (const line of lines) {
      if (!line) continue;
      const colon = line.indexOf(': ');
      if (colon < 0) continue;
      const k = line.slice(0, colon);
      const v = line.slice(colon + 2);
      if (k.toLowerCase() === 'status') {
        status = parseInt(v.split(' ')[0] ?? '200', 10);
      } else {
        res.setHeader(k, v);
      }
    }
    res.status(status);
    if (body.length) res.write(body);
  });

  child.stdout.on('end', () => res.end());
  child.stderr.on('data', (d: Buffer) => process.stderr.write('[git] ' + d.toString()));
  child.on('error', (err) => {
    console.error('[git-backend]', err);
    if (!res.headersSent) res.status(500).end('Git error');
    else res.end();
  });
}

router.use(GIT_ROUTE, resolveBasicAuth);

router.all(GIT_ROUTE, async (req: AuthedRequest, res: Response): Promise<void> => {
  const match = req.path.match(GIT_ROUTE);
  if (!match) { res.status(404).end(); return; }

  const [, owner, repoName, suffix = ''] = match;
  const isUploadPack = suffix === '/git-upload-pack' || suffix === '/info/refs';
  const isReceivePack = suffix === '/git-receive-pack';

  const repoRow = getRepoForGit(owner, repoName);
  if (!repoRow) {
    res.status(404).end('Repository not found');
    return;
  }

  const authedUser = req.gitUser ?? req.user;

  // Private repo read requires auth
  if (repoRow.is_private && !authedUser) {
    res.setHeader('WWW-Authenticate', 'Basic realm="ForgeLite"');
    res.status(401).end('Authentication required');
    return;
  }

  // Write (push) requires auth + ownership
  // Always return 401 (not 403) so git re-prompts for correct credentials
  if (isReceivePack || (isUploadPack && req.query.service === 'git-receive-pack')) {
    if (!authedUser || authedUser.id !== repoRow.owner_id) {
      res.setHeader('WWW-Authenticate', `Basic realm="ForgeLite - ${owner}/${repoName}"`);
      res.status(401).end('Push access denied: authenticate as the repository owner');
      return;
    }
  }

  // Build PATH_INFO for git http-backend (relative to GIT_PROJECT_ROOT)
  const pathInfo = `/${owner}/${repoName}.git${suffix}`;
  const rp = repoPath(owner, repoName);

  serveGitBackend(req, res, rp, pathInfo);
});

export default router;
