import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getDb, DbUser } from '../db/database';
import { config } from '../config';

export interface AuthedRequest extends Request {
  user?: DbUser;
  gitUser?: DbUser;
}

export function authMiddleware(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = req.cookies?.token as string | undefined;
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as { userId: number };
      const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(payload.userId) as DbUser | undefined;
      if (user) req.user = user;
    } catch {
      // invalid token — ignore
    }
  }
  next();
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Authentication required' });
    } else {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return;
  }
  next();
}

export async function resolveBasicAuth(req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Basic ')) return next();

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx < 0) return next();

  const username = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as DbUser | undefined;
  if (!user) return next();

  const passOk = await bcrypt.compare(password, user.password_hash);
  if (passOk) {
    req.gitUser = user;
    return next();
  }

  const tokenHash = crypto.createHash('sha256').update(password).digest('hex');
  const token = db.prepare('SELECT id FROM access_tokens WHERE user_id = ? AND token_hash = ?').get(user.id, tokenHash) as { id: number } | undefined;
  if (token) {
    db.prepare("UPDATE access_tokens SET last_used = datetime('now') WHERE id = ?").run(token.id);
    req.gitUser = user;
  }
  next();
}

export function makeToken(userId: number): string {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: '30d' });
}
