# syntax=docker/dockerfile:1
FROM golang:1.27.4@sha256:08bcb99a38f85a265f9a93d1d3323e2440eec333380f3ea26ee0dec9264bb41c AS build
ENV CGO_ENABLED=0 GOBIN=/out
RUN go install -trimpath -ldflags="-s -w" \
    filippo.io/torchwood/cmd/litewitness@v0.10.0 \
    filippo.io/torchwood/cmd/witnessctl@v0.10.0

FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/litewitness /out/witnessctl /usr/local/bin/
COPY services/witness/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY services/witness/logs /etc/litewitness/logs
ENV DB=/data/litewitness.db PORT=7380
EXPOSE 7380
VOLUME /data
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
