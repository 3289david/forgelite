import { Router, Response } from 'express';
import path from 'path';
import { getDb, DbPullRequest } from '../../db/database';
import { requireAuth, AuthedRequest } from '../../middleware/auth';
import { config } from '../../config';
import { getDiff, parseDiff, mergeBranch, getBranches, refExists } from '../../lib/git';

const router = Router({ mergeParams: true });

function getRepo(owner: string, name: string) {
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) return null;
  return getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, name) as { id: number; is_private: number; owner_id: number; name: string; default_branch: string } | undefined;
}

function repoPath(owner: string, name: string): string {
  return path.join(config.reposDir, owner, name + '.git');
}

router.get('/', (req: AuthedRequest, res: Response) => {
  const { owner, repo } = req.params;
  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  if (repoRow.is_private && repoRow.owner_id !== req.user?.id) { res.status(404).json({ error: 'Not found' }); return; }

  const status = (req.query.status as string) || 'open';
  const prs = getDb().prepare(`
    SELECT pr.*, u.username as author_name,
      (SELECT COUNT(*) FROM pr_comments WHERE pr_id = pr.id) as comment_count
    FROM pull_requests pr JOIN users u ON u.id = pr.author_id
    WHERE pr.repo_id = ? AND pr.status = ?
    ORDER BY pr.created_at DESC
  `).all(repoRow.id, status);
  res.json(prs);
});

router.post('/', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const { title, body = '', head_branch, base_branch, head_repo } = req.body as {
    title: string; body?: string; head_branch: string; base_branch: string; head_repo?: string;
  };

  if (!title?.trim() || !head_branch || !base_branch) {
    res.status(400).json({ error: 'Title, head_branch, and base_branch are required' }); return;
  }

  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  if (repoRow.is_private && repoRow.owner_id !== req.user!.id) { res.status(404).json({ error: 'Not found' }); return; }

  const db = getDb();
  let headRepoId = repoRow.id;
  if (head_repo && head_repo !== `${owner}/${repo}`) {
    const [ho, hn] = head_repo.split('/');
    const hr = getRepo(ho, hn);
    if (hr) headRepoId = hr.id;
  }

  const nextNum = ((db.prepare('SELECT MAX(number) as n FROM pull_requests WHERE repo_id = ?').get(repoRow.id) as { n: number | null }).n ?? 0) + 1;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO pull_requests (repo_id, number, title, body, author_id, head_repo_id, head_branch, base_branch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoRow.id, nextNum, title.trim(), body, req.user!.id, headRepoId, head_branch, base_branch);

  db.prepare("UPDATE repositories SET updated_at = datetime('now') WHERE id = ?").run(repoRow.id);
  res.status(201).json({ id: Number(lastInsertRowid), number: nextNum });
});

router.get('/:number', async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;
  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  if (repoRow.is_private && repoRow.owner_id !== req.user?.id) { res.status(404).json({ error: 'Not found' }); return; }

  const pr = getDb().prepare(`
    SELECT pr.*, u.username as author_name
    FROM pull_requests pr JOIN users u ON u.id = pr.author_id
    WHERE pr.repo_id = ? AND pr.number = ?
  `).get(repoRow.id, parseInt(number, 10)) as (DbPullRequest & { author_name: string }) | undefined;
  if (!pr) { res.status(404).json({ error: 'Not found' }); return; }

  const comments = getDb().prepare(`
    SELECT c.*, u.username as author_name
    FROM pr_comments c JOIN users u ON u.id = c.author_id
    WHERE c.pr_id = ? ORDER BY c.created_at ASC
  `).all(pr.id);

  let diff: ReturnType<typeof parseDiff> | null = null;
  if (pr.status === 'open') {
    try {
      const rp = repoPath(owner, repo);
      const rawDiff = await getDiff(rp, pr.base_branch, pr.head_branch);
      diff = parseDiff(rawDiff);
    } catch {}
  }

  res.json({ pr, comments, diff });
});

router.post('/:number/merge', requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;
  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  if (repoRow.owner_id !== req.user!.id) { res.status(403).json({ error: 'Only repo owner can merge' }); return; }

  const pr = getDb().prepare('SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(number, 10)) as DbPullRequest | undefined;
  if (!pr || pr.status !== 'open') { res.status(400).json({ error: 'PR is not open' }); return; }

  const rp = repoPath(owner, repo);
  const success = await mergeBranch(rp, pr.base_branch, pr.head_branch);
  if (!success) { res.status(409).json({ error: 'Merge conflict — resolve conflicts manually' }); return; }

  getDb().prepare(`
    UPDATE pull_requests SET status = 'merged', merged_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).run(pr.id);
  getDb().prepare("UPDATE repositories SET updated_at = datetime('now') WHERE id = ?").run(repoRow.id);

  res.json({ ok: true });
});

router.post('/:number/comments', requireAuth, (req: AuthedRequest, res: Response) => {
  const { owner, repo, number } = req.params;
  const { body, file_path, line_number } = req.body as { body: string; file_path?: string; line_number?: number };
  if (!body?.trim()) { res.status(400).json({ error: 'Comment body required' }); return; }

  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }

  const pr = getDb().prepare('SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(number, 10)) as { id: number } | undefined;
  if (!pr) { res.status(404).json({ error: 'Not found' }); return; }

  const { lastInsertRowid } = getDb().prepare(
    'INSERT INTO pr_comments (pr_id, author_id, body, file_path, line_number) VALUES (?, ?, ?, ?, ?)'
  ).run(pr.id, req.user!.id, body.trim(), file_path ?? null, line_number ?? null);

  res.status(201).json({ id: Number(lastInsertRowid) });
});

router.patch('/:number', requireAuth, (req: AuthedRequest, res: Response) => {
  const { owner, repo, number } = req.params;
  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }

  const pr = getDb().prepare('SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(number, 10)) as DbPullRequest | undefined;
  if (!pr) { res.status(404).json({ error: 'Not found' }); return; }
  if (pr.author_id !== req.user!.id && repoRow.owner_id !== req.user!.id) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { status, title, body } = req.body as Partial<{ status: string; title: string; body: string }>;
  if (status === 'merged') { res.status(400).json({ error: 'Use /merge endpoint to merge' }); return; }

  getDb().prepare(`
    UPDATE pull_requests SET
      status = COALESCE(?, status),
      title = COALESCE(?, title),
      body = COALESCE(?, body),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status ?? null, title ?? null, body ?? null, pr.id);

  res.json({ ok: true });
});

export default router;
