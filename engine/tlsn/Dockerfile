# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f engine/tlsn/Dockerfile .
FROM docker.io/library/rust:1.99.1-slim-bookworm@sha256:f2c004e3d2d8b547e8cf7ffbc29205385f4e71d23e53e4e383065db5e9f822cd AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY engine ./engine
RUN cargo build --release --locked -p keelson-tlsn --features prover --bin keelson-prover \
    && cp target/release/keelson-prover /keelson-prover

FROM docker.io/library/debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
COPY --from=build /keelson-prover /keelson-prover
USER 65534:65534
EXPOSE 10000
ENTRYPOINT ["/keelson-prover"]
