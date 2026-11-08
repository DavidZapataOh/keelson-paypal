# syntax=docker/dockerfile:1
# Built from the repository root: docker build -f services/monitor/Dockerfile .
FROM golang:1.27.3@sha256:e519d3b0a5b285e5aa53ab9eef02bc6bbb9cb04608389b743a136a9ce75f0d1e AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY services/monitor ./services/monitor
RUN GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o services/monitor/web/verifier.wasm ./services/monitor/wasm \
    && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" services/monitor/web/ \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/monitor ./services/monitor \
    && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/monitor /monitor
# Owned by the nonroot user, so a named volume mounted here is writable.
COPY --from=build --chown=65532:65532 /out/data /data
ENV MONITOR_DATA_DIR=/data PORT=8080
EXPOSE 8080
ENTRYPOINT ["/monitor"]
