# ForgeLite

> Git hosting, stripped to the essentials.

A minimal, self-hostable Git platform with real `git push/pull/clone` support, a clean web UI, REST API, and static site hosting. Built with Node.js 22+ built-in SQLite — no native compilation needed.

## Features

- **Repositories** — public/private, fork, star, file browser, README rendering, commit history
- **Issues** — open, comment, close, Markdown body
- **Pull Requests** — real git diffs, code review comments, merge via git
- **Git CLI** — full HTTP smart protocol (`git clone/push/pull` works out of the box)
- **Web Hosting** — push to `gh-pages` branch, served at `/:user/:repo/pages/`
- **Auth** — JWT cookies (web) + HTTP Basic Auth / Personal Access Tokens (git CLI)
- **REST API** — full JSON API for all resources

## Requirements

- Node.js 22+ (uses built-in `node:sqlite` — no native deps)
- Git installed on server

## Quick Start

```bash
git clone https://github.com/danwoo/forgelite.git
cd forgelite
npm install
cp .env.example .env
# Edit .env — set a long random JWT_SECRET
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Git CLI Usage

```bash
# Clone
git clone http://username:password@localhost:3000/owner/repo.git

# Push (password or personal access token)
git push http://username:TOKEN@localhost:3000/owner/repo.git main
```

## Web Hosting (gh-pages)

```bash
git checkout -b gh-pages
echo "<h1>My Site</h1>" > index.html
git add . && git commit -m "Deploy"
git push origin gh-pages
# Live at: http://localhost:3000/username/repo/pages/
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | _(change in prod)_ | JWT signing secret |
| `DATA_DIR` | `./data` | DB + bare repos directory |
| `BASE_URL` | `http://localhost:3000` | Public base URL |

## Tech Stack

- **Node.js 22+** with built-in `node:sqlite` (no native compilation)
- **Express 4 + TypeScript** + EJS templates
- **Git HTTP smart protocol** via `git http-backend` CGI
- **bcrypt** passwords + JWT sessions + Personal Access Tokens
- **marked + highlight.js** for Markdown and syntax highlighting

---

*Less platform. More code.*
