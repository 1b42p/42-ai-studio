FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash curl git procps ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace && chmod 0777 /workspace
WORKDIR /workspace
