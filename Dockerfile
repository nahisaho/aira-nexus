# syntax=docker/dockerfile:1
FROM quay.io/jupyter/r-notebook@sha256:95282ae540ecb3260014841ff2f6edafe8543e9c3816a52988a08eab7d53bb39 AS notebook-kernel
USER root
COPY src/server/notebook/guard.c /opt/notebook/guard.c
RUN cc -shared -fPIC -O2 -Wall -Wextra -Werror -o /opt/notebook/guard.so /opt/notebook/guard.c \
    && chmod 0555 /opt/notebook /opt/notebook/guard.so \
    && rm /opt/notebook/guard.c
USER 1000

FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM registry.k8s.io/kubectl:v1.37.0 AS kubectl
FROM node:24.22.1-bookworm-slim AS api
WORKDIR /app
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY db/migrations ./db/migrations
USER node
ENV NODE_ENV=production
CMD ["node", "dist/server/index.js"]
