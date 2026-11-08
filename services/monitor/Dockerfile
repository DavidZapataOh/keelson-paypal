# syntax=docker/dockerfile:1
# Built from the repository root: docker build -f services/monitor/Dockerfile .
# The browser verifier is built with TinyGo, whose output is a quarter the size
# of the Go toolchain's. TinyGo runs wasm-opt from Binaryen.
FROM --platform=linux/amd64 tinygo/tinygo:0.44.0@sha256:98126534a0653966913b803d26805ea79250a244217d921d74044cfedc1d24a2 AS wasm
USER root
ADD --checksum=sha256:2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489 \
    https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz /tmp/binaryen.tar.gz
RUN tar -xzf /tmp/binaryen.tar.gz -C /opt
ENV WASMOPT=/opt/binaryen-version_133/bin/wasm-opt
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY services/monitor ./services/monitor
RUN mkdir /out \
    && tinygo build -target wasm -no-debug -opt z -stack-size=256KB -o /out/verifier.wasm ./services/monitor/wasm \
    && cp "$(tinygo env TINYGOROOT)/targets/wasm_exec.js" /out/

FROM golang:1.27.3@sha256:e519d3b0a5b285e5aa53ab9eef02bc6bbb9cb04608389b743a136a9ce75f0d1e AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY services/monitor ./services/monitor
COPY --from=wasm /out/ services/monitor/web/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/monitor ./services/monitor \
    && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/monitor /monitor
# Owned by the nonroot user, so a named volume mounted here is writable.
COPY --from=build --chown=65532:65532 /out/data /data
ENV MONITOR_DATA_DIR=/data PORT=8080
EXPOSE 8080
ENTRYPOINT ["/monitor"]
