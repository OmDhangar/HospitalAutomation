#!/usr/bin/env bash
#
# Production Deployment Script for Qurio (Hospital Automation)
# Usage: ./deploy.sh [branch_name] (defaults to main)
#
set -euo pipefail

BRANCH="${1:-main}"

echo "=================================================="
echo "🚀 Deploying Qurio [branch: ${BRANCH}]"
echo "=================================================="

# 1. Pull latest code from Git
echo "📥 [1/6] Pulling latest code..."
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull origin "${BRANCH}"

# 2. Run Database Migrations
echo "📦 [2/6] Running Database Migrations..."
docker run --rm --network hospital-net \
  --env-file .env.production \
  -v "$(pwd):/app" -w /app \
  node:20-alpine npx tsx scripts/migrate.ts

# 3. Build the new Next.js standalone container
echo "🔨 [3/6] Building new Next.js Docker image..."
docker build -t hospital-app:new .

# 4. Swap the Web Application Container
echo "🔄 [4/6] Swapping Web Container..."
docker stop hospital-app 2>/dev/null || true
docker rm hospital-app 2>/dev/null || true

docker run -d --name hospital-app \
  --restart unless-stopped \
  --network hospital-net \
  -p 127.0.0.1:3001:3000 \
  --memory="1g" --memory-swap="1.5g" \
  --env-file .env.production \
  hospital-app:new

# 5. Restart Background Worker Daemon
echo "⚡ [5/6] Restarting Background Worker..."
docker restart hospital-worker 2>/dev/null || {
  echo "⚠️ Worker container not running, starting it..."
  docker run -d --name hospital-worker \
    --restart unless-stopped \
    --network hospital-net \
    --memory="256m" \
    --env-file .env.production \
    -v "$(pwd):/app" -w /app \
    node:20-alpine npx tsx scripts/worker-daemon.ts
}

# 6. Verify Health & Clean up
echo "🧹 [6/6] Checking health & cleaning up..."
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001 || echo "000")

if [[ "$HTTP_CODE" =~ ^(200|307|308|404)$ ]]; then
  echo "  ✅ App container responding (HTTP ${HTTP_CODE})"
else
  echo "  ⚠️ Warning: Health check returned HTTP ${HTTP_CODE}. Check 'docker logs hospital-app'"
fi

# Clean up dangling images
docker image prune -f >/dev/null 2>&1 || true

echo "=================================================="
echo "🎉 Deployment successfully finished!"
echo "🌐 URL: https://quriiohq.com"
echo "=================================================="
