# syntax=docker/dockerfile:1.7
FROM node:22-trixie-slim AS builder
ENV DEBIAN_FRONTEND=noninteractive
ARG APT_PROXY
RUN if [ -n "$APT_PROXY" ]; then echo "Acquire::http::Proxy \"$APT_PROXY\";" > /etc/apt/apt.conf.d/01-proxy; fi && \
    apt-get update && apt-get install -y --no-install-recommends make ca-certificates git && \
    rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/01-proxy

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy
ARG HOLOSO_VERSION

WORKDIR /src/holoso-web
COPY . .

RUN make dist HOLOSO_VERSION="${HOLOSO_VERSION}"

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /src/holoso-web/dist /usr/share/nginx/html
EXPOSE 8080
