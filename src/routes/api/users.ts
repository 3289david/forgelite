import { Router, Response } from 'express';
import { getDb, DbUser } from '../../db/database';
import { requireAuth, AuthedRequest } from '../../middleware/auth';

const router = Router();

router.get('/:username', (req, res: Response) => {
  const user = getDb().prepare('SELECT id, username, bio, website, location, created_at FROM users WHERE username = ?').get(req.params.username) as Omit<DbUser, 'email' | 'password_hash'> | undefined;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const repos = getDb().prepare(`
    SELECT r.*, u.username as owner_name,
      (SELECT COUNT(*) FROM stars WHERE repo_id = r.id) as star_count
    FROM repositories r
    JOIN users u ON u.id = r.owner_id
    WHERE r.owner_id = ? AND r.is_private = 0
    ORDER BY r.updated_at DESC
  `).all(user.id);

  res.json({ user, repos });
});

router.post('/:username/follow', requireAuth, (req: AuthedRequest, res: Response) => {
  const target = getDb().prepare('SELECT id FROM users WHERE username = ?').get(req.params.username) as { id: number } | undefined;
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }
  if (target.id === req.user!.id) { res.status(400).json({ error: 'Cannot follow yourself' }); return; }

  try {
    getDb().prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user!.id, target.id);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Already following' }); }
});

router.delete('/:username/follow', requireAuth, (req: AuthedRequest, res: Response) => {
  const target = getDb().prepare('SELECT id FROM users WHERE username = ?').get(req.params.username) as { id: number } | undefined;
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }
  getDb().prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user!.id, target.id);
  res.json({ ok: true });
});

export default router;
