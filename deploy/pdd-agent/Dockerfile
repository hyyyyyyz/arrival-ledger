FROM mcr.microsoft.com/playwright:v1.62.1-noble

ARG PDD_AGENT_UID=10002
ARG PDD_AGENT_GID=10002

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    TZ=Asia/Shanghai

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        dbus-x11 \
        fonts-noto-cjk \
        novnc \
        openbox \
        websockify \
        x11-utils \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${PDD_AGENT_GID}" pddagent \
    && useradd --create-home --uid "${PDD_AGENT_UID}" --gid "${PDD_AGENT_GID}" --shell /usr/sbin/nologin pddagent \
    && install -d -o pddagent -g pddagent -m 0700 \
        /data/config /data/logs /data/profiles /data/state

WORKDIR /opt/arrival-ledger/sync-agent

# Copy only build inputs. In particular, never copy sync-agent/.env.local,
# profiles, state, logs, reports, or browser storage into the image layer.
COPY sync-agent/package.json sync-agent/package-lock.json ./
RUN npm ci --include=dev

COPY sync-agent/tsconfig.json sync-agent/tsconfig.build.json ./
COPY sync-agent/src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

COPY --chmod=0755 deploy/pdd-agent/entrypoint.sh /usr/local/bin/pdd-agent-entrypoint

USER pddagent:pddagent
WORKDIR /data/config

EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/pdd-agent-entrypoint"]
