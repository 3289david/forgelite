import { Router, Response } from 'express';
import path from 'path';
import { getDb, DbRepo } from '../../db/database';
import { requireAuth, AuthedRequest } from '../../middleware/auth';
import { config } from '../../config';
import { initRepo, forkRepo, deleteRepo, getTree, getFileContent, getCommits, getDefaultBranch, getBranches, isEmpty } from '../../lib/git';

const router = Router();

function repoPath(owner: string, name: string): string {
  return path.join(config.reposDir, owner, name + '.git');
}

function canRead(repo: DbRepo, userId?: number): boolean {
  return !repo.is_private || repo.owner_id === userId;
}

router.get('/', (req: AuthedRequest, res: Response) => {
  const repos = getDb().prepare(`
    SELECT r.*, u.username as owner_name,
      (SELECT COUNT(*) FROM stars WHERE repo_id = r.id) as star_count
    FROM repositories r JOIN users u ON u.id = r.owner_id
    WHERE r.is_private = 0
    ORDER BY r.updated_at DESC LIMIT 50
  `).all();
  res.json(repos);
});

router.post('/', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const name = body.name as string | undefined;
  const description = (body.description as string | undefined) ?? '';
  const is_private = Boolean(body.is_private);
  const website = (body.website as string | undefined) ?? '';
  if (!name || typeof name !== 'string') { res.status(400).json({ error: 'Repository name required' }); return; }
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name)) { res.status(400).json({ error: 'Invalid repo name' }); return; }

  const db = getDb();
  const exists = db.prepare('SELECT id FROM repositories WHERE owner_id = ? AND name = ?').get(req.user!.id, name);
  if (exists) { res.status(409).json({ error: 'Repository already exists' }); return; }

  const rp = repoPath(req.user!.username, name);
  await initRepo(rp);

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO repositories (owner_id, name, description, is_private, website) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user!.id, name, description, is_private ? 1 : 0, website);

  res.status(201).json({ id: Number(lastInsertRowid), owner: req.user!.username, name });
});

router.get('/:owner/:repo', (req: AuthedRequest, res: Response) => {
  const { owner, repo } = req.params;
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }

  const repoRow = getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, repo) as DbRepo | undefined;
  if (!repoRow || !canRead(repoRow, req.user?.id)) { res.status(404).json({ error: 'Not found' }); return; }

  const starCount = (getDb().prepare('SELECT COUNT(*) as c FROM stars WHERE repo_id = ?').get(repoRow.id) as { c: number }).c;
  const forksCount = (getDb().prepare('SELECT COUNT(*) as c FROM repositories WHERE fork_of = ?').get(repoRow.id) as { c: number }).c;
  const starred = req.user ? !!getDb().prepare('SELECT 1 FROM stars WHERE user_id = ? AND repo_id = ?').get(req.user.id, repoRow.id) : false;

  res.json({ ...repoRow, owner_name: owner, star_count: starCount, forks_count: forksCount, starred });
});

router.patch('/:owner/:repo', requireAuth, (req: AuthedRequest, res: Response) => {
  const { owner, repo } = req.params;
  if (owner !== req.user!.username) { res.status(403).json({ error: 'Forbidden' }); return; }

  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }

  const repoRow = getDb().prepare('SELECT id FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }

  const body2 = req.body as Record<string, unknown>;
  const descVal = body2.description !== undefined ? String(body2.description) : null;
  const siteVal = body2.website !== undefined ? String(body2.website) : null;
  const privVal = body2.is_private !== undefined ? (body2.is_private ? 1 : 0) : null;
  getDb().prepare(`
    UPDATE repositories SET
      description = COALESCE(?, description),
      website = COALESCE(?, website),
      is_private = COALESCE(?, is_private),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(descVal, siteVal, privVal, (repoRow as { id: number }).id);
  res.json({ ok: true });
});

router.delete('/:owner/:repo', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  if (owner !== req.user!.username) { res.status(403).json({ error: 'Forbidden' }); return; }

  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }

  const repoRow = getDb().prepare('SELECT id FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, repo) as { id: number } | undefined;
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }

  getDb().prepare('DELETE FROM repositories WHERE id = ?').run(repoRow.id);
  await deleteRepo(repoPath(owner, repo));
  res.json({ ok: true });
});

router.post('/:owner/:repo/fork', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }

  const repoRow = getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, repo) as DbRepo | undefined;
  if (!repoRow || !canRead(repoRow, req.user?.id)) { res.status(404).json({ error: 'Not found' }); return; }

  const db = getDb();
  const forkName = req.body.name || repo;
  const exists = db.prepare('SELECT id FROM repositories WHERE owner_id = ? AND name = ?').get(req.user!.id, forkName);
  if (exists) { res.status(409).json({ error: 'You already have a repository with that name' }); return; }

  const srcPath = repoPath(owner, repo);
  const destPath = repoPath(req.user!.username, forkName);

  await forkRepo(srcPath, destPath);

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO repositories (owner_id, name, description, is_private, fork_of) VALUES (?, ?, ?, 0, ?)'
  ).run(req.user!.id, forkName, repoRow.description, repoRow.id);

  res.status(201).json({ id: Number(lastInsertRowid), owner: req.user!.username, name: forkName });
});

router.post('/:owner/:repo/star', requireAuth, (req: AuthedRequest, res: Response) => {
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(req.params.owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }
  const repoRow = getDb().prepare('SELECT id FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, req.params.repo) as { id: number } | undefined;
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  getDb().prepare('INSERT OR IGNORE INTO stars (user_id, repo_id) VALUES (?, ?)').run(req.user!.id, repoRow.id);
  res.json({ ok: true });
});

router.delete('/:owner/:repo/star', requireAuth, (req: AuthedRequest, res: Response) => {
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(req.params.owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }
  const repoRow = getDb().prepare('SELECT id FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, req.params.repo) as { id: number } | undefined;
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  getDb().prepare('DELETE FROM stars WHERE user_id = ? AND repo_id = ?').run(req.user!.id, repoRow.id);
  res.json({ ok: true });
});

router.get('/:owner/:repo/tree/:branch', async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo, branch } = req.params;
  const treePath = (req.query.path as string) || '';
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }
  const repoRow = getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, repo) as DbRepo | undefined;
  if (!repoRow || !canRead(repoRow, req.user?.id)) { res.status(404).json({ error: 'Not found' }); return; }
  const rp = repoPath(owner, repo);
  const tree = await getTree(rp, branch, treePath);
  res.json(tree);
});

router.get('/:owner/:repo/commits/:branch', async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo, branch } = req.params;
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }
  const repoRow = getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, repo) as DbRepo | undefined;
  if (!repoRow || !canRead(repoRow, req.user?.id)) { res.status(404).json({ error: 'Not found' }); return; }
  const commits = await getCommits(repoPath(owner, repo), branch, 50);
  res.json(commits);
});

router.get('/:owner/:repo/branches', async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) { res.status(404).json({ error: 'Not found' }); return; }
  const repoRow = getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, repo) as DbRepo | undefined;
  if (!repoRow || !canRead(repoRow, req.user?.id)) { res.status(404).json({ error: 'Not found' }); return; }
  const branches = await getBranches(repoPath(owner, repo));
  const defaultBranch = await getDefaultBranch(repoPath(owner, repo));
  res.json({ branches, default: defaultBranch });
});

export default router;
