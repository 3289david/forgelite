import { Router, Response } from 'express';
import { getDb, DbIssue } from '../../db/database';
import { requireAuth, AuthedRequest } from '../../middleware/auth';

const router = Router({ mergeParams: true });

function getRepo(owner: string, name: string) {
  const ownerRow = getDb().prepare('SELECT id FROM users WHERE username = ?').get(owner) as { id: number } | undefined;
  if (!ownerRow) return null;
  return getDb().prepare('SELECT * FROM repositories WHERE owner_id = ? AND name = ?').get(ownerRow.id, name) as { id: number; is_private: number; owner_id: number } | undefined;
}

router.get('/', (req: AuthedRequest, res: Response) => {
  const { owner, repo } = req.params;
  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  if (repoRow.is_private && repoRow.owner_id !== req.user?.id) { res.status(404).json({ error: 'Not found' }); return; }

  const status = (req.query.status as string) || 'open';
  const issues = getDb().prepare(`
    SELECT i.*, u.username as author_name,
      (SELECT COUNT(*) FROM issue_comments WHERE issue_id = i.id) as comment_count
    FROM issues i JOIN users u ON u.id = i.author_id
    WHERE i.repo_id = ? AND i.status = ?
    ORDER BY i.created_at DESC
  `).all(repoRow.id, status);
  res.json(issues);
});

router.post('/', requireAuth, (req: AuthedRequest, res: Response) => {
  const { owner, repo } = req.params;
  const { title, body = '' } = req.body as { title: string; body?: string };
  if (!title?.trim()) { res.status(400).json({ error: 'Title required' }); return; }

  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  if (repoRow.is_private && repoRow.owner_id !== req.user!.id) { res.status(404).json({ error: 'Not found' }); return; }

  const db = getDb();
  const nextNum = ((db.prepare('SELECT MAX(number) as n FROM issues WHERE repo_id = ?').get(repoRow.id) as { n: number | null }).n ?? 0) + 1;
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO issues (repo_id, number, title, body, author_id) VALUES (?, ?, ?, ?, ?)'
  ).run(repoRow.id, nextNum, title.trim(), body, req.user!.id);

  db.prepare("UPDATE repositories SET updated_at = datetime('now') WHERE id = ?").run(repoRow.id);
  res.status(201).json({ id: Number(lastInsertRowid), number: nextNum });
});

router.get('/:number', (req: AuthedRequest, res: Response) => {
  const { owner, repo, number } = req.params;
  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }
  if (repoRow.is_private && repoRow.owner_id !== req.user?.id) { res.status(404).json({ error: 'Not found' }); return; }

  const issue = getDb().prepare(`
    SELECT i.*, u.username as author_name
    FROM issues i JOIN users u ON u.id = i.author_id
    WHERE i.repo_id = ? AND i.number = ?
  `).get(repoRow.id, parseInt(number, 10)) as (DbIssue & { author_name: string }) | undefined;
  if (!issue) { res.status(404).json({ error: 'Not found' }); return; }

  const comments = getDb().prepare(`
    SELECT c.*, u.username as author_name
    FROM issue_comments c JOIN users u ON u.id = c.author_id
    WHERE c.issue_id = ? ORDER BY c.created_at ASC
  `).all(issue.id);

  res.json({ issue, comments });
});

router.post('/:number/comments', requireAuth, (req: AuthedRequest, res: Response) => {
  const { owner, repo, number } = req.params;
  const { body } = req.body as { body: string };
  if (!body?.trim()) { res.status(400).json({ error: 'Comment body required' }); return; }

  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }

  const issue = getDb().prepare('SELECT id FROM issues WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(number, 10)) as { id: number } | undefined;
  if (!issue) { res.status(404).json({ error: 'Not found' }); return; }

  const { lastInsertRowid } = getDb().prepare(
    'INSERT INTO issue_comments (issue_id, author_id, body) VALUES (?, ?, ?)'
  ).run(issue.id, req.user!.id, body.trim());

  res.status(201).json({ id: Number(lastInsertRowid) });
});

router.patch('/:number', requireAuth, (req: AuthedRequest, res: Response) => {
  const { owner, repo, number } = req.params;
  const repoRow = getRepo(owner, repo);
  if (!repoRow) { res.status(404).json({ error: 'Not found' }); return; }

  const issue = getDb().prepare('SELECT * FROM issues WHERE repo_id = ? AND number = ?').get(repoRow.id, parseInt(number, 10)) as DbIssue | undefined;
  if (!issue) { res.status(404).json({ error: 'Not found' }); return; }
  if (issue.author_id !== req.user!.id && repoRow.owner_id !== req.user!.id) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { status, title, body } = req.body as Partial<{ status: string; title: string; body: string }>;
  getDb().prepare(`
    UPDATE issues SET
      status = COALESCE(?, status),
      title = COALESCE(?, title),
      body = COALESCE(?, body),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status ?? null, title ?? null, body ?? null, issue.id);

  res.json({ ok: true });
});

export default router;
