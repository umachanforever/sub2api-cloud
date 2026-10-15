FROM node:24-bookworm-slim AS frontend
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /build/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
COPY docs/legal/ /build/docs/legal/
RUN pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json LICENSE COPYING NOTICE ./
COPY scripts/console.mjs scripts/static.mjs scripts/oauth-callback.mjs scripts/console-ws.mjs ./scripts/
COPY supabase/functions/sub2api/public_settings.json supabase/functions/sub2api/request_limits.ts ./supabase/functions/sub2api/
COPY --from=frontend /build/frontend/dist ./frontend/dist
ENV CONSOLE_HOST=0.0.0.0 CONSOLE_STATIC_DIR=/app/frontend/dist
EXPOSE 4173 1455
USER node
CMD ["node", "scripts/console.mjs"]
