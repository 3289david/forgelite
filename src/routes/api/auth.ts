import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { getDb } from '../../db/database';
import { makeToken, requireAuth, AuthedRequest } from '../../middleware/auth';
import { config } from '../../config';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, email, password } = req.body as Record<string, string>;
  if (!username || !email || !password) { res.status(400).json({ error: 'All fields required' }); return; }
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) { res.status(400).json({ error: 'Username must be 3-32 chars, letters/numbers/- only' }); return; }
  if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) { res.status(409).json({ error: 'Username or email already taken' }); return; }

  const hash = await bcrypt.hash(password, 12);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
  ).run(username, email, hash);

  const token = makeToken(Number(lastInsertRowid));
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, secure: config.baseUrl.startsWith('https') });
  res.json({ ok: true, username });
});

router.post('/login', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as Record<string, string>;
  if (!username || !password) { res.status(400).json({ error: 'Username and password required' }); return; }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { id: number; password_hash: string } | undefined;
  if (!user) { res.status(401).json({ error: 'Invalid credentials' }); return; }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) { res.status(401).json({ error: 'Invalid credentials' }); return; }

  const token = makeToken(user.id);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, secure: config.baseUrl.startsWith('https') });
  res.json({ ok: true });
});

router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req: AuthedRequest, res: Response) => {
  const u = req.user!;
  res.json({ id: u.id, username: u.username, email: u.email, bio: u.bio, website: u.website, location: u.location, created_at: u.created_at });
});

router.patch('/me', requireAuth, (req: AuthedRequest, res: Response) => {
  const { bio, website, location } = req.body as Record<string, string>;
  getDb().prepare('UPDATE users SET bio = COALESCE(?, bio), website = COALESCE(?, website), location = COALESCE(?, location) WHERE id = ?')
    .run(bio ?? null, website ?? null, location ?? null, req.user!.id);
  res.json({ ok: true });
});

router.get('/tokens', requireAuth, (req: AuthedRequest, res: Response) => {
  const tokens = getDb().prepare('SELECT id, name, token_prefix, created_at, last_used FROM access_tokens WHERE user_id = ?').all(req.user!.id);
  res.json(tokens);
});

router.post('/tokens', requireAuth, (req: AuthedRequest, res: Response) => {
  const { name } = req.body as { name: string };
  if (!name?.trim()) { res.status(400).json({ error: 'Token name required' }); return; }

  const rawToken = 'flt_' + crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const tokenPrefix = rawToken.slice(0, 12) + '...';

  getDb().prepare('INSERT INTO access_tokens (user_id, token_hash, name, token_prefix) VALUES (?, ?, ?, ?)')
    .run(req.user!.id, tokenHash, name.trim(), tokenPrefix);

  res.json({ ok: true, token: rawToken, name: name.trim() });
});

router.delete('/tokens/:id', requireAuth, (req: AuthedRequest, res: Response) => {
  getDb().prepare('DELETE FROM access_tokens WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id);
  res.json({ ok: true });
});

export default router;
