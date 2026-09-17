# syntax=docker/dockerfile:1
#
# The worker is the same image as the API with a different entrypoint — same DI
# container, same domain services, no HTTP listener
# (docs/adr/0001-modular-monolith.md). Building it separately would let the two
# drift apart, which is exactly what the shared-codebase decision avoids.

FROM bizbot-api:latest
ENV BIZBOT_ROLE=worker
HEALTHCHECK NONE
CMD ["node", "dist/main.worker.js"]
