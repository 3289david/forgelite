import { Router, Response, Request } from 'express';
import path from 'path';
import { getDb, DbRepo } from '../db/database';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { config } from '../config';
import {
  isEmpty, getDefaultBranch, getBranches, getTree, getFileContent,
  getCommits, getCommit, getDiff, parseDiff, getLastCommitForPath,
  refExists, getMimeType, webCommit,
} from '../lib/git';
import { renderMarkdown } from '../lib/markdown';
import hljs from 'highlight.js';

const router = Router();

// ── File display type detection ───────────────────────────────────────────────
const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.ico','.bmp','.avif','.tiff','.tif']);

// Extensions that are always unrenderable binary blobs
const BLOB_EXTS = new Set([
  '.zip','.gz','.tar','.bz2','.xz','.7z','.rar','.zst',
  '.jar','.war','.ear','.class',
  '.exe','.dll','.so','.dylib','.bin','.out','.obj','.a','.lib',
  '.iso','.img','.dmg','.deb','.rpm','.pkg','.msi','.apk','.ipa','.aab',
  '.pdf',
  '.doc','.docx','.xls','.xlsx','.ppt','.pptx','.odt','.ods','.odp',
  '.mp3','.mp4','.avi','.mov','.mkv','.flv','.wmv','.webm','.m4v','.m4a',
  '.wav','.ogg','.flac','.aac','.opus',
  '.wasm','.pyc','.pyo','.pyd','.rbc',
  '.ttf','.otf','.woff','.woff2','.eot',
  '.db','.sqlite','.sqlite3',
]);

// Well-known text filenames with no extension
const TEXT_NAMES = new Set([
  'makefile','dockerfile','gemfile','rakefile','procfile','pipfile','brewfile',
  'license','licence','readme','changelog','contributing','notice','authors',
  'copying','todo','fixme','credits','history','install','news','thanks',
  'vagrantfile','justfile','caddyfile','containerfile',
  '.gitignore','.gitattributes','.gitmodules','.gitkeep',
  '.env','.env.example','.env.local','.env.development','.env.production',
  '.editorconfig','.eslintrc','.prettierrc','.babelrc','.browserslistrc',
  '.stylelintrc','.npmrc','.nvmrc','.ruby-version','.python-version',
  '.tool-versions','.travis.yml','.htaccess',
]);

function getFileDisplayType(basename: string, ext: string, buf: Buffer): 'text' | 'image' | 'binary' {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (BLOB_EXTS.has(ext)) return 'binary';
  if (TEXT_NAMES.has(basename.toLowerCase())) return 'text';

  // Heuristic: scan first 8 KB for null bytes (reliable binary indicator)
  const sample = buf.slice(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return 'binary';
  }
  return 'text'; // no null bytes → treat as text
}

function rp(owner: string, name: string) {
  return path.join(config.reposDir, owner, name + '.git');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getRepoAndOwner(owner: string, name: string, userId?: number) {
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) return null;
  const repoRow = getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, name) as DbRepo | undefined;
  if (!repoRow) return null;
  if (repoRow.is_private && repoRow.owner_id !== userId) return null;
  return repoRow;
}

function diffToHtml(diff: ReturnType<typeof parseDiff>): string {
  let html = '';
  for (const file of diff.files) {
    html += `<div class="diff-file">
      <div class="diff-file-header">
        <span class="diff-filename">${esc(file.to || file.from)}</span>
        <span class="diff-stat"><span class="add-stat">+${file.additions}</span> <span class="del-stat">-${file.deletions}</span></span>
      </div>
      <div class="diff-body">`;
    for (const hunk of file.hunks) {
      html += `<div class="diff-hunk-header">${esc(hunk.header)}</div>`;
      for (const line of hunk.lines) {
        const cls = line.type === '+' ? 'diff-add' : line.type === '-' ? 'diff-del' : 'diff-ctx';
        const sign = line.type === '+' ? '+' : line.type === '-' ? '-' : ' ';
        html += `<div class="diff-line ${cls}"><span class="diff-sign">${sign}</span><span class="diff-content">${esc(line.content)}</span></div>`;
      }
    }
    html += `</div></div>`;
  }
  return html || '<div class="empty-diff">No changes</div>';
}

// ── Docs ─────────────────────────────────────────────────────────────────────
router.get('/docs', (_req: Request, res: Response) => {
  res.render('docs');
});

// ── Explore ───────────────────────────────────────────────────────────────────
router.get('/explore', (_req: Request, res: Response) => {
  const repos = getDb().prepare(`
    SELECT r.*, u.username as owner_name,
      (SELECT COUNT(*) FROM stars WHERE repo_id = r.id) as star_count
    FROM repositories r JOIN users u ON u.id = r.owner_id
    WHERE r.is_private = 0 ORDER BY r.updated_at DESC LIMIT 100
  `).all();
  res.render('explore', { repos });
});

// ── Landing ──────────────────────────────────────────────────────────────────
router.get('/', (req: AuthedRequest, res: Response) => {
  if (req.user) { res.redirect(`/${req.user.username}`); return; }
  const recentRepos = getDb().prepare(`
    SELECT r.*, u.username as owner_name,
      (SELECT COUNT(*) FROM stars WHERE repo_id = r.id) as star_count
    FROM repositories r JOIN users u ON u.id = r.owner_id
    WHERE r.is_private = 0 ORDER BY r.updated_at DESC LIMIT 6
  `).all();
  res.render('index', { recentRepos });
});

// ── Auth pages ────────────────────────────────────────────────────────────────
router.get('/login', (req: AuthedRequest, res: Response) => {
  if (req.user) { res.redirect('/'); return; }
  res.render('login', { next: req.query.next || '/', error: null });
});

router.post('/login', async (req: AuthedRequest, res: Response): Promise<void> => {
  const { username, password, next = '/' } = req.body as Record<string, string>;
  const bcrypt = await import('bcrypt');
  const { makeToken } = await import('../middleware/auth');
  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as { id: number; password_hash: string } | undefined;
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.render('login', { next, error: 'Invalid username or password' });
    return;
  }
  const token = makeToken(user.id);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.redirect(next as string);
});

router.get('/register', (req: AuthedRequest, res: Response) => {
  if (req.user) { res.redirect('/'); return; }
  res.render('register', { error: null });
});

router.post('/register', async (req: AuthedRequest, res: Response): Promise<void> => {
  const { username, email, password } = req.body as Record<string, string>;
  const errors: string[] = [];
  if (!username || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) errors.push('Username must be 3-32 chars (letters, numbers, - _)');
  if (!email || !email.includes('@')) errors.push('Valid email required');
  if (!password || password.length < 8) errors.push('Password must be at least 8 characters');
  if (errors.length) { res.render('register', { error: errors[0] }); return; }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) { res.render('register', { error: 'Username or email already taken' }); return; }

  const bcrypt = await import('bcrypt');
  const { makeToken } = await import('../middleware/auth');
  const hash = await bcrypt.hash(password, 12);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(username, email, hash);
  const token = makeToken(Number(lastInsertRowid));
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.redirect(`/${username}`);
});

router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token');
  res.redirect('/');
});

// ── New repo ──────────────────────────────────────────────────────────────────
router.get('/new', requireAuth, (_req: Request, res: Response) => {
  res.render('new-repo', { error: null });
});

router.post('/new', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const { name, description = '', is_private = '', website = '' } = req.body as Record<string, string>;
  if (!name || !/^[a-zA-Z0-9_.-]{1,100}$/.test(name)) {
    res.render('new-repo', { error: 'Invalid repository name' }); return;
  }
  const db = getDb();
  const exists = db.prepare('SELECT id FROM repositories WHERE owner_id = ? AND name = ?').get(req.user!.id, name);
  if (exists) { res.render('new-repo', { error: 'You already have a repository with that name' }); return; }

  const { initRepo } = await import('../lib/git');
  const repoPath = rp(req.user!.username, name);
  await initRepo(repoPath);
  db.prepare('INSERT INTO repositories (owner_id, name, description, is_private, website) VALUES (?, ?, ?, ?, ?)')
    .run(req.user!.id, name, description, is_private === 'on' ? 1 : 0, website);
  res.redirect(`/${req.user!.username}/${name}`);
});

// ── User profile ──────────────────────────────────────────────────────────────
router.get('/settings', requireAuth, (req: AuthedRequest, res: Response) => {
  res.render('settings', { success: null, error: null });
});

router.post('/settings', requireAuth, (req: AuthedRequest, res: Response) => {
  const { bio, website, location } = req.body as Record<string, string>;
  getDb().prepare('UPDATE users SET bio = ?, website = ?, location = ? WHERE id = ?')
    .run(bio ?? '', website ?? '', location ?? '', req.user!.id);
  res.render('settings', { success: 'Profile updated', error: null });
});

router.get('/:username', (req: AuthedRequest, res: Response) => {
  const { username } = req.params;
  const profileUser = getDb().prepare('SELECT id, username, bio, website, location, created_at FROM users WHERE username = ?').get(username);
  if (!profileUser) { res.status(404).render('error', { code: 404, message: 'User not found' }); return; }

  const u = profileUser as { id: number; username: string; bio: string; website: string; location: string; created_at: string };
  const repos = getDb().prepare(`
    SELECT r.*, u.username as owner_name,
      (SELECT COUNT(*) FROM stars WHERE repo_id = r.id) as star_count
    FROM repositories r JOIN users u ON u.id = r.owner_id
    WHERE r.owner_id = ? AND (r.is_private = 0 OR ? = ?)
    ORDER BY r.updated_at DESC
  `).all(u.id, req.user?.id ?? -1, u.id);

  const followers = (getDb().prepare('SELECT COUNT(*) as c FROM follows WHERE following_id = ?').get(u.id) as { c: number }).c;
  const following = (getDb().prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?').get(u.id) as { c: number }).c;
  const isFollowing = req.user ? !!getDb().prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, u.id) : false;

  res.render('profile', { profileUser: u, repos, followers, following, isFollowing, isSelf: req.user?.id === u.id });
});

// ── Repo pages ────────────────────────────────────────────────────────────────
async function withRepo(req: AuthedRequest, res: Response, fn: (repoRow: DbRepo, owner: string, repoName: string) => Promise<void>) {
  const { owner, repo } = req.params;
  const repoRow = getRepoAndOwner(owner, repo, req.user?.id);
  if (!repoRow) { res.status(404).render('error', { code: 404, message: 'Repository not found' }); return; }
  await fn(repoRow, owner, repo);
}

router.get('/:owner/:repo', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const repoGitPath = rp(owner, repoName);
    const empty = await isEmpty(repoGitPath);
    const defaultBranch = await getDefaultBranch(repoGitPath);
    const branches = empty ? [] : await getBranches(repoGitPath);
    const currentBranch = (req.query.branch as string) || defaultBranch;

    let tree: Awaited<ReturnType<typeof getTree>> = [];
    let commits: Awaited<ReturnType<typeof getCommits>> = [];
    let readme: string | null = null;
    let lastCommits: Record<string, Awaited<ReturnType<typeof getLastCommitForPath>>> = {};

    if (!empty && branches.length) {
      tree = await getTree(repoGitPath, currentBranch, '');
      commits = await getCommits(repoGitPath, currentBranch, 5);

      // last commit per entry
      await Promise.all(tree.map(async entry => {
        lastCommits[entry.name] = await getLastCommitForPath(repoGitPath, currentBranch, entry.name);
      }));

      // README
      const readmeEntry = tree.find(e => e.type === 'blob' && /^readme(\.(md|txt|rst))?$/i.test(e.name));
      if (readmeEntry) {
        try {
          const buf = await getFileContent(repoGitPath, currentBranch, readmeEntry.name);
          const text = buf.toString('utf8');
          readme = /\.md$/i.test(readmeEntry.name) ? renderMarkdown(text) : `<pre>${esc(text)}</pre>`;
        } catch {}
      }
    }

    const ownerRow = getDb().prepare('SELECT * FROM users WHERE id = ?').get(repoRow.owner_id) as { username: string };
    const starCount = (getDb().prepare('SELECT COUNT(*) as c FROM stars WHERE repo_id = ?').get(repoRow.id) as { c: number }).c;
    const forksCount = (getDb().prepare('SELECT COUNT(*) as c FROM repositories WHERE fork_of = ?').get(repoRow.id) as { c: number }).c;
    const openIssues = (getDb().prepare("SELECT COUNT(*) as c FROM issues WHERE repo_id = ? AND status = 'open'").get(repoRow.id) as { c: number }).c;
    const openPrs = (getDb().prepare("SELECT COUNT(*) as c FROM pull_requests WHERE repo_id = ? AND status = 'open'").get(repoRow.id) as { c: number }).c;
    const starred = req.user ? !!getDb().prepare('SELECT 1 FROM stars WHERE user_id = ? AND repo_id = ?').get(req.user.id, repoRow.id) : false;
    const cloneUrl = `${config.baseUrl}/${owner}/${repoName}.git`;
    const hasPagesDeployment = branches.includes('gh-pages');
    const pagesHttpUrl = `${config.baseUrl}/${owner}/${repoName}/pages/`;
    const pagesHttpsUrl = config.baseUrl.replace(/^http:/, 'https:')
      .replace(/:(\d+)/, `:${config.httpsPort}`)
      + `/${owner}/${repoName}/pages/`;

    let forkSource: { owner_name: string; name: string } | null = null;
    if (repoRow.fork_of) {
      forkSource = getDb().prepare(`
        SELECT u.username as owner_name, r.name FROM repositories r JOIN users u ON u.id = r.owner_id WHERE r.id = ?
      `).get(repoRow.fork_of) as { owner_name: string; name: string } | null;
    }

    res.render('repo/index', {
      repoRow, owner, repoName, ownerRow, tree, branches, currentBranch,
      defaultBranch, commits, readme, lastCommits, starCount, forksCount,
      openIssues, openPrs, starred, cloneUrl, empty, forkSource,
      hasPagesDeployment, pagesHttpUrl, pagesHttpsUrl,
    });
  });
});

router.get('/:owner/:repo/tree/:branch', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { branch } = req.params;
    const dirPath = '';
    const repoGitPath = rp(owner, repoName);
    const tree = await getTree(repoGitPath, branch, dirPath);
    const branches = await getBranches(repoGitPath);
    const lastCommit = await getCommit(repoGitPath, branch);
    res.render('repo/tree', { repoRow, owner, repoName, branch, branches, dirPath, tree, lastCommit, breadcrumbs: [] });
  });
});

router.get('/:owner/:repo/tree/:branch/*', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { branch } = req.params;
    const dirPath = (req.params as Record<string, string>)[0] ?? '';
    const repoGitPath = rp(owner, repoName);
    const tree = await getTree(repoGitPath, branch, dirPath);
    const branches = await getBranches(repoGitPath);
    const lastCommit = await getCommit(repoGitPath, branch);
    const breadcrumbs = dirPath.split('/').filter(Boolean).map((part, i, arr) => ({
      name: part, path: arr.slice(0, i + 1).join('/'),
    }));
    res.render('repo/tree', { repoRow, owner, repoName, branch, branches, dirPath, tree, lastCommit, breadcrumbs });
  });
});

router.get('/:owner/:repo/blob/:branch/*', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { branch } = req.params;
    const filePath = (req.params as Record<string, string>)[0] ?? '';
    const repoGitPath = rp(owner, repoName);

    let content = '';
    let isBinary = false;
    let highlighted = '';

    try {
      const buf = await getFileContent(repoGitPath, branch, filePath);
      const ext = path.extname(filePath).toLowerCase();
      const basename = path.basename(filePath);
      const displayType = getFileDisplayType(basename, ext, buf);

      if (displayType === 'image') {
        isBinary = true;
        const mime = getMimeType(ext);
        content = `data:${mime};base64,${buf.toString('base64')}`;
      } else if (displayType === 'binary') {
        isBinary = true;
        content = '';
      } else {
        content = buf.toString('utf8');
        // Pick syntax highlighting language: ext, then basename (e.g. "Makefile"), then auto
        const lang = ext.slice(1) || basename.toLowerCase();
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(content, { language: lang }).value;
        } else {
          highlighted = hljs.highlightAuto(content).value;
        }
      }
    } catch { res.status(404).render('error', { code: 404, message: 'File not found' }); return; }

    const branches = await getBranches(repoGitPath);
    const parts = filePath.split('/');
    const breadcrumbs = parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join('/') }));
    const fileCommit = await getLastCommitForPath(repoGitPath, branch, filePath);
    const lines = content.split('\n');

    res.render('repo/blob', { repoRow, owner, repoName, branch, branches, filePath, content, highlighted, isBinary, breadcrumbs, fileCommit, lineCount: lines.length });
  });
});

router.get('/:owner/:repo/commits/:branch', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { branch } = req.params;
    const repoGitPath = rp(owner, repoName);
    const commits = await getCommits(repoGitPath, branch, 50);
    const branches = await getBranches(repoGitPath);
    res.render('repo/commits', { repoRow, owner, repoName, branch, branches, commits });
  });
});

// ── Issues ────────────────────────────────────────────────────────────────────
router.get('/:owner/:repo/issues', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const status = (req.query.status as string) || 'open';
    const issues = getDb().prepare(`
      SELECT i.*, u.username as author_name,
        (SELECT COUNT(*) FROM issue_comments WHERE issue_id = i.id) as comment_count
      FROM issues i JOIN users u ON u.id = i.author_id
      WHERE i.repo_id = ? AND i.status = ?
      ORDER BY i.created_at DESC
    `).all(repoRow.id, status);
    const openCount = (getDb().prepare("SELECT COUNT(*) as c FROM issues WHERE repo_id = ? AND status = 'open'").get(repoRow.id) as { c: number }).c;
    const closedCount = (getDb().prepare("SELECT COUNT(*) as c FROM issues WHERE repo_id = ? AND status = 'closed'").get(repoRow.id) as { c: number }).c;
    res.render('repo/issues', { repoRow, owner, repoName, issues, status, openCount, closedCount });
  });
});

router.get('/:owner/:repo/issues/new', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    res.render('repo/issue-new', { repoRow, owner, repoName, error: null });
  });
});

router.post('/:owner/:repo/issues/new', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { title, body = '' } = req.body as { title: string; body?: string };
    if (!title?.trim()) { res.render('repo/issue-new', { repoRow, owner, repoName, error: 'Title required' }); return; }
    const db = getDb();
    const nextNum = ((db.prepare('SELECT MAX(number) as n FROM issues WHERE repo_id = ?').get(repoRow.id) as { n: number | null }).n ?? 0) + 1;
    db.prepare('INSERT INTO issues (repo_id, number, title, body, author_id) VALUES (?, ?, ?, ?, ?)').run(repoRow.id, nextNum, title.trim(), body, req.user!.id);
    db.prepare("UPDATE repositories SET updated_at = datetime('now') WHERE id = ?").run(repoRow.id);
    res.redirect(`/${owner}/${repoName}/issues/${nextNum}`);
  });
});

router.get('/:owner/:repo/issues/:number', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const issue = getDb().prepare(`
      SELECT i.*, u.username as author_name FROM issues i JOIN users u ON u.id = i.author_id
      WHERE i.repo_id = ? AND i.number = ?
    `).get(repoRow.id, parseInt(req.params.number, 10)) as any;
    if (!issue) { res.status(404).render('error', { code: 404, message: 'Issue not found' }); return; }
    const comments = getDb().prepare(`
      SELECT c.*, u.username as author_name FROM issue_comments c JOIN users u ON u.id = c.author_id
      WHERE c.issue_id = ? ORDER BY c.created_at ASC
    `).all(issue.id);
    const isOwner = req.user?.id === repoRow.owner_id;
    const isAuthor = req.user?.id === issue.author_id;
    res.render('repo/issue', { repoRow, owner, repoName, issue, comments, isOwner, isAuthor, renderMarkdown });
  });
});

router.post('/:owner/:repo/issues/:number/comment', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { body } = req.body as { body: string };
    const issue = getDb().prepare('SELECT id FROM issues WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(req.params.number, 10)) as { id: number } | undefined;
    if (!issue) { res.status(404).end(); return; }
    if (body?.trim()) {
      getDb().prepare('INSERT INTO issue_comments (issue_id, author_id, body) VALUES (?, ?, ?)').run(issue.id, req.user!.id, body.trim());
    }
    res.redirect(`/${owner}/${repoName}/issues/${req.params.number}`);
  });
});

router.post('/:owner/:repo/issues/:number/toggle', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const issue = getDb().prepare('SELECT * FROM issues WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(req.params.number, 10)) as { id: number; status: string; author_id: number } | undefined;
    if (!issue) { res.status(404).end(); return; }
    if (req.user!.id !== repoRow.owner_id && req.user!.id !== issue.author_id) { res.status(403).end(); return; }
    const newStatus = issue.status === 'open' ? 'closed' : 'open';
    getDb().prepare("UPDATE issues SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, issue.id);
    res.redirect(`/${owner}/${repoName}/issues/${req.params.number}`);
  });
});

// ── Pull Requests ─────────────────────────────────────────────────────────────
router.get('/:owner/:repo/pulls', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const status = (req.query.status as string) || 'open';
    const prs = getDb().prepare(`
      SELECT pr.*, u.username as author_name,
        (SELECT COUNT(*) FROM pr_comments WHERE pr_id = pr.id) as comment_count
      FROM pull_requests pr JOIN users u ON u.id = pr.author_id
      WHERE pr.repo_id = ? AND pr.status = ?
      ORDER BY pr.created_at DESC
    `).all(repoRow.id, status);
    const openCount = (getDb().prepare("SELECT COUNT(*) as c FROM pull_requests WHERE repo_id = ? AND status = 'open'").get(repoRow.id) as { c: number }).c;
    const closedCount = (getDb().prepare("SELECT COUNT(*) as c FROM pull_requests WHERE repo_id = ? AND (status = 'closed' OR status = 'merged')").get(repoRow.id) as { c: number }).c;
    res.render('repo/pulls', { repoRow, owner, repoName, prs, status, openCount, closedCount });
  });
});

router.get('/:owner/:repo/pulls/new', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const branches = await getBranches(rp(owner, repoName));
    const defaultBranch = await getDefaultBranch(rp(owner, repoName));
    res.render('repo/pull-new', { repoRow, owner, repoName, branches, defaultBranch, error: null });
  });
});

router.post('/:owner/:repo/pulls/new', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { title, body = '', head_branch, base_branch } = req.body as Record<string, string>;
    if (!title?.trim() || !head_branch || !base_branch) {
      const branches = await getBranches(rp(owner, repoName));
      const defaultBranch = await getDefaultBranch(rp(owner, repoName));
      res.render('repo/pull-new', { repoRow, owner, repoName, branches, defaultBranch, error: 'All fields required' }); return;
    }
    const db = getDb();
    const nextNum = ((db.prepare('SELECT MAX(number) as n FROM pull_requests WHERE repo_id = ?').get(repoRow.id) as { n: number | null }).n ?? 0) + 1;
    db.prepare('INSERT INTO pull_requests (repo_id, number, title, body, author_id, head_repo_id, head_branch, base_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(repoRow.id, nextNum, title.trim(), body, req.user!.id, repoRow.id, head_branch, base_branch);
    db.prepare("UPDATE repositories SET updated_at = datetime('now') WHERE id = ?").run(repoRow.id);
    res.redirect(`/${owner}/${repoName}/pulls/${nextNum}`);
  });
});

router.get('/:owner/:repo/pulls/:number', async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const pr = getDb().prepare(`
      SELECT pr.*, u.username as author_name FROM pull_requests pr JOIN users u ON u.id = pr.author_id
      WHERE pr.repo_id = ? AND pr.number = ?
    `).get(repoRow.id, parseInt(req.params.number, 10)) as any;
    if (!pr) { res.status(404).render('error', { code: 404, message: 'Pull request not found' }); return; }

    const comments = getDb().prepare(`
      SELECT c.*, u.username as author_name FROM pr_comments c JOIN users u ON u.id = c.author_id
      WHERE c.pr_id = ? ORDER BY c.created_at ASC
    `).all(pr.id);

    let diffHtml = '';
    let diffStats = { additions: 0, deletions: 0, files: 0 };
    if (pr.status === 'open') {
      try {
        const repoGitPath = rp(owner, repoName);
        const rawDiff = await getDiff(repoGitPath, pr.base_branch, pr.head_branch);
        const parsed = parseDiff(rawDiff);
        diffHtml = diffToHtml(parsed);
        diffStats = parsed.stats;
      } catch {}
    }

    const isOwner = req.user?.id === repoRow.owner_id;
    const isAuthor = req.user?.id === pr.author_id;
    res.render('repo/pull', { repoRow, owner, repoName, pr, comments, diffHtml, diffStats, isOwner, isAuthor, renderMarkdown });
  });
});

router.post('/:owner/:repo/pulls/:number/merge', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).end('Forbidden'); return; }
    const pr = getDb().prepare('SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(req.params.number, 10)) as any;
    if (!pr || pr.status !== 'open') { res.redirect(`/${owner}/${repoName}/pulls/${req.params.number}`); return; }

    const { mergeBranch } = await import('../lib/git');
    const ok = await mergeBranch(rp(owner, repoName), pr.base_branch, pr.head_branch);
    if (!ok) { res.redirect(`/${owner}/${repoName}/pulls/${req.params.number}?merge_failed=1`); return; }

    getDb().prepare("UPDATE pull_requests SET status = 'merged', merged_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(pr.id);
    getDb().prepare("UPDATE repositories SET updated_at = datetime('now') WHERE id = ?").run(repoRow.id);
    res.redirect(`/${owner}/${repoName}/pulls/${req.params.number}`);
  });
});

router.post('/:owner/:repo/pulls/:number/comment', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const { body } = req.body as { body: string };
    const pr = getDb().prepare('SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(req.params.number, 10)) as { id: number } | undefined;
    if (!pr) { res.status(404).end(); return; }
    if (body?.trim()) {
      getDb().prepare('INSERT INTO pr_comments (pr_id, author_id, body) VALUES (?, ?, ?)').run(pr.id, req.user!.id, body.trim());
    }
    res.redirect(`/${owner}/${repoName}/pulls/${req.params.number}`);
  });
});

router.post('/:owner/:repo/pulls/:number/close', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    const pr = getDb().prepare('SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(req.params.number, 10)) as any;
    if (!pr) { res.status(404).end(); return; }
    if (req.user!.id !== repoRow.owner_id && req.user!.id !== pr.author_id) { res.status(403).end(); return; }
    getDb().prepare("UPDATE pull_requests SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(pr.id);
    res.redirect(`/${owner}/${repoName}/pulls/${req.params.number}`);
  });
});

// ── Repo settings ─────────────────────────────────────────────────────────────
router.get('/:owner/:repo/settings', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).render('error', { code: 403, message: 'Forbidden' }); return; }
    const tokens = getDb().prepare('SELECT id, name, token_prefix, created_at, last_used FROM access_tokens WHERE user_id = ?').all(req.user!.id);
    res.render('repo/settings', { repoRow, owner, repoName, success: null, error: null, tokens });
  });
});

router.post('/:owner/:repo/settings', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).end(); return; }
    const { description, website, is_private } = req.body as Record<string, string>;
    getDb().prepare("UPDATE repositories SET description = ?, website = ?, is_private = ?, updated_at = datetime('now') WHERE id = ?")
      .run(description ?? '', website ?? '', is_private === 'on' ? 1 : 0, repoRow.id);
    const tokens = getDb().prepare('SELECT id, name, token_prefix, created_at, last_used FROM access_tokens WHERE user_id = ?').all(req.user!.id);
    res.render('repo/settings', { repoRow: { ...repoRow, description: description ?? '', website: website ?? '', is_private: is_private === 'on' ? 1 : 0 }, owner, repoName, success: 'Settings saved', error: null, tokens });
  });
});

router.post('/:owner/:repo/delete', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).end(); return; }
    const { confirm } = req.body as { confirm: string };
    if (confirm !== repoName) { res.redirect(`/${owner}/${repoName}/settings?error=name_mismatch`); return; }
    getDb().prepare('DELETE FROM repositories WHERE id = ?').run(repoRow.id);
    const { deleteRepo } = await import('../lib/git');
    await deleteRepo(rp(owner, repoName));
    res.redirect(`/${owner}`);
  });
});

// ── Web file editor ───────────────────────────────────────────────────────────
// New file
router.get('/:owner/:repo/new-file/:branch', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).render('error', { code: 403, message: 'Forbidden' }); return; }
    const { branch } = req.params;
    const dirPath = (req.query.dir as string) || '';
    res.render('repo/editor', { repoRow, owner, repoName, branch, mode: 'new', filePath: '', fileContent: '', dirPath, error: null });
  });
});

router.post('/:owner/:repo/new-file/:branch', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).end(); return; }
    const { branch } = req.params;
    const { file_name, dir_path = '', content = '', commit_message = 'Create file' } = req.body as Record<string, string>;

    if (!file_name?.trim()) {
      res.render('repo/editor', { repoRow, owner, repoName, branch, mode: 'new', filePath: '', fileContent: content, dirPath: dir_path, error: 'File name is required' });
      return;
    }

    const filePath = dir_path ? `${dir_path}/${file_name}` : file_name;
    const repoGitPath = rp(owner, repoName);

    try {
      await webCommit(repoGitPath, {
        branch,
        filePath,
        content,
        message: commit_message,
        authorName: req.user!.username,
        authorEmail: req.user!.email,
      });
      res.redirect(`/${owner}/${repoName}/blob/${branch}/${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Commit failed';
      res.render('repo/editor', { repoRow, owner, repoName, branch, mode: 'new', filePath, fileContent: content, dirPath: dir_path, error: msg });
    }
  });
});

// Edit existing file
router.get('/:owner/:repo/edit/:branch/*', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).render('error', { code: 403, message: 'Forbidden' }); return; }
    const { branch } = req.params;
    const filePath = (req.params as Record<string, string>)[0] ?? '';
    const repoGitPath = rp(owner, repoName);
    try {
      const buf = await getFileContent(repoGitPath, branch, filePath);
      const fileContent = buf.toString('utf8');
      res.render('repo/editor', { repoRow, owner, repoName, branch, mode: 'edit', filePath, fileContent, dirPath: '', error: null });
    } catch { res.status(404).render('error', { code: 404, message: 'File not found' }); }
  });
});

router.post('/:owner/:repo/edit/:branch/*', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).end(); return; }
    const { branch } = req.params;
    const originalPath = (req.params as Record<string, string>)[0] ?? '';
    const { content = '', commit_message = 'Update file', file_path } = req.body as Record<string, string>;
    const filePath = file_path || originalPath;
    const repoGitPath = rp(owner, repoName);

    try {
      await webCommit(repoGitPath, {
        branch,
        filePath,
        content,
        message: commit_message,
        authorName: req.user!.username,
        authorEmail: req.user!.email,
      });
      res.redirect(`/${owner}/${repoName}/blob/${branch}/${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Commit failed';
      res.render('repo/editor', { repoRow, owner, repoName, branch, mode: 'edit', filePath: originalPath, fileContent: content, dirPath: '', error: msg });
    }
  });
});

// Delete file
router.post('/:owner/:repo/delete-file/:branch/*', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await withRepo(req, res, async (repoRow, owner, repoName) => {
    if (req.user!.id !== repoRow.owner_id) { res.status(403).end(); return; }
    const { branch } = req.params;
    const filePath = (req.params as Record<string, string>)[0] ?? '';
    const { commit_message = `Delete ${filePath}` } = req.body as Record<string, string>;
    const repoGitPath = rp(owner, repoName);

    try {
      await webCommit(repoGitPath, {
        branch,
        filePath,
        content: null,
        message: commit_message,
        authorName: req.user!.username,
        authorEmail: req.user!.email,
      });
      const parentDir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '';
      res.redirect(`/${owner}/${repoName}${parentDir ? '/tree/' + branch + '/' + parentDir : ''}`);
    } catch (err) {
      res.redirect(`/${owner}/${repoName}/blob/${branch}/${filePath}?error=delete_failed`);
    }
  });
});

// ── Static site hosting ────────────────────────────────────────────────────────
// Single regex route avoids Express non-strict routing redirect loops.
// Matches /owner/repo/pages and /owner/repo/pages/... exactly.
router.get(/^\/([^/]+)\/([^/]+)\/pages(\/.*)?$/, async (req: AuthedRequest, res: Response): Promise<void> => {
  const params = req.params as unknown as string[];
  const owner = params[0];
  const repo  = params[1];
  const suffix = params[2]; // undefined → no trailing slash; '/' → root; '/foo' → file

  if (!suffix) {
    res.redirect(`/${owner}/${repo}/pages/`);
    return;
  }

  const repoRow = getRepoAndOwner(owner, repo, req.user?.id);
  if (!repoRow) { res.status(404).end('Not found'); return; }

  const repoGitPath = rp(owner, repo);
  const branch = 'gh-pages';
  const filePath = suffix.replace(/^\//, '') || 'index.html';

  const tryFile = async (fp: string): Promise<boolean> => {
    try {
      const buf = await getFileContent(repoGitPath, branch, fp);
      const ext = path.extname(fp).toLowerCase();
      res.type(getMimeType(ext)).send(buf);
      return true;
    } catch { return false; }
  };

  if (await tryFile(filePath)) return;
  if (!path.extname(filePath) && await tryFile(filePath + '/index.html')) return;
  if (!path.extname(filePath) && await tryFile(filePath + '.html')) return;
  res.status(404).type('text/plain').end('404 Not Found');
});

export default router;
