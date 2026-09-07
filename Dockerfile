# Cloud Run image for the carsearch web service.
#
# Built on Playwright's own image rather than a slim Node base. Five of the six
# working adapters need a real Chromium with its system libraries, and
# reproducing that dependency set by hand is a long tail of missing shared
# objects that only shows up at runtime, in production, as a source that
# silently returns nothing.
#
# The tag here MUST match the playwright version pinned in package.json;
# `npm run check:pins` fails the build when they drift.

# ---- build stage: compile TypeScript, then throw the toolchain away ----------
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# Dev dependencies are needed here and only here, for the compiler.
# --omit=optional skips better-sqlite3, the only native module, so this stage
# needs no compiler toolchain and cannot fail on node-gyp.
RUN npm ci --omit=optional
COPY src ./src
RUN npx tsc -p tsconfig.json
# tsc emits only JavaScript, so the SQL the store reads at runtime is copied by
# hand. Missing it fails at first connection, not at build.
RUN cp src/store/*.sql dist/store/

# ---- runtime stage ----------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY web ./web

# Plain node against compiled output. Running the TypeScript directly would put
# a transpiler in the serving path, and resolving it through npx re-fetches it
# from the registry on every cold start, which fails wherever egress is closed.
ENV PORT=8080
EXPOSE 8080
USER pwuser

CMD ["node", "dist/api/server.js"]
