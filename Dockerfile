FROM node:24.16.0-trixie-slim@sha256:45fbb3ca3b6c7e6646cd2889d0ac7bf314bb180036da792221fc2f48fe4d43fb AS build
WORKDIR /lab
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY src/editor.mjs src/editor.mjs
RUN npm run build:editor && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
RUN node -e "require('sqlite3')"

FROM node:24.16.0-trixie-slim@sha256:45fbb3ca3b6c7e6646cd2889d0ac7bf314bb180036da792221fc2f48fe4d43fb
WORKDIR /lab
COPY package*.json ./
COPY --from=build /lab/node_modules node_modules
COPY src src
COPY db db
COPY public public
COPY --from=build /lab/public/editor.js public/editor.js
COPY test test
USER node
