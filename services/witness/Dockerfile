# syntax=docker/dockerfile:1
FROM golang:1.27.3@sha256:e519d3b0a5b285e5aa53ab9eef02bc6bbb9cb04608389b743a136a9ce75f0d1e AS build
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
ENV DB=/data/litewitness.db PORT=7380
EXPOSE 7380
VOLUME /data
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
