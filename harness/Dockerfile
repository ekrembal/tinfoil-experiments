FROM node:24.22.2-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40 AS build
RUN npm install -g pnpm@10.11.0
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY verifier/vendor verifier/vendor
RUN npx tsc -p verifier/vendor
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) SUM=637e9bf47ce16aff96dcff72ed2294ed380e50e8fa6fbf846bf9565e3f71afc6;; arm64) SUM=19bc493bf3872e2e2052020190e52d2fa84c81551da407d5d1fafbc2ca9b1ef8;; *) exit 1;; esac && curl -fsSL "https://github.com/tinfoilsh/tinfoil-proxy/releases/download/v0.2.9/tinfoil-proxy-linux-$TARGETARCH" -o /usr/local/bin/tinfoil-proxy && echo "$SUM  /usr/local/bin/tinfoil-proxy" | sha256sum -c - && chmod 755 /usr/local/bin/tinfoil-proxy
COPY templates/react /opt/app/templates/react
WORKDIR /opt/app/templates/react
RUN pnpm fetch --store-dir=/opt/store && pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir=/opt/store
RUN pnpm build && rm -rf node_modules dist tsconfig.tsbuildinfo

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep fd-find && rm -rf /var/lib/apt/lists/* && ln -s /usr/bin/fdfind /usr/local/bin/fd
RUN npm install -g pnpm@10.11.0
COPY --from=build /usr/local/bin/tinfoil-proxy /usr/local/bin/tinfoil-proxy
COPY --from=build /opt/store /opt/store
COPY --from=build /opt/app /opt/app
COPY harness /opt/app/harness
COPY verifier/cli.mjs /opt/app/verifier/cli.mjs
RUN mkdir -p /data /workspaces && chmod 700 /data && chmod 711 /workspaces
WORKDIR /opt/app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","harness/start.mjs"]
