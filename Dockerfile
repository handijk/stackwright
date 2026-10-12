# the official node image from the Docker-maintained mirror on ECR Public: no pull limit for the build
FROM public.ecr.aws/docker/library/node:22-slim

# git and ssh for the clone and the pushes; gosu to drop to the node user once the mounts are owned.
# `script` (bsdutils, essential on Debian) gives `claude setup-token` the terminal it wants.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends git openssh-client ca-certificates gosu && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# The SDK brings the glibc and the musl build of Claude Code; this image runs the glibc one, and `claude`
# on the PATH is that binary, so `docker run --rm -it --entrypoint claude <image> setup-token` works.
RUN npm ci --omit=dev && npm cache clean --force && \
    rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl && \
    ln -s "$(ls -d /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude | head -1)" /usr/local/bin/claude
COPY index.js config.js entrypoint.sh ./
COPY lib/ ./lib/
RUN chmod +x /app/entrypoint.sh && su node -c 'git config --global --add safe.directory "*"'

ENV NODE_ENV=production \
    STACKWRIGHT_CONFIG=/config/stackwright.yaml \
    STACKWRIGHT_WORKSPACE=/workspace \
    STACKWRIGHT_DATA=/data \
    STACKWRIGHT_LISTEN=0.0.0.0:8091

EXPOSE 8091
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "/app/index.js"]
