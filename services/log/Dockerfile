# syntax=docker/dockerfile:1
FROM golang:1.27.4@sha256:08bcb99a38f85a265f9a93d1d3323e2440eec333380f3ea26ee0dec9264bb41c AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY services/log ./services/log
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/log ./services/log

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/log /log
COPY services/log/policy /etc/keelson-log/policy
ENV LOG_POLICY_DIR=/etc/keelson-log/policy
EXPOSE 10000 8081
ENTRYPOINT ["/log"]
