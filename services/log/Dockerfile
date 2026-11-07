# syntax=docker/dockerfile:1
FROM golang:1.27.3@sha256:e519d3b0a5b285e5aa53ab9eef02bc6bbb9cb04608389b743a136a9ce75f0d1e AS build
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
