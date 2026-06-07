#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it before running in production."
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

npm run dev
