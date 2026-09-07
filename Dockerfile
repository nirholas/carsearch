# Cloud Run image for carsearch.
#
# Built on Playwright's own image rather than a slim Node base. Five of the six
# working adapters need a real Chromium with its system libraries, and
# reproducing that dependency set by hand on a slim image is a long tail of
# missing shared objects that only shows up at runtime, in production, as a
# source that silently returns nothing.
#
# The version here MUST track the playwright version in package.json. A
# mismatch between the bundled browsers and the client library fails at launch.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first so a source-only change reuses the layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

# tsx runs TypeScript directly, so there is no build step whose output could
# drift from the source that was committed.
RUN npm install --no-save tsx@^4.19.0

# Cloud Run supplies PORT and the container must honour it.
ENV PORT=8080
EXPOSE 8080

# Runs as a non-root user, which the Playwright image already provides.
USER pwuser

CMD ["npx", "tsx", "src/api/server.ts"]
