FROM node:24-bookworm-slim
WORKDIR /app
COPY proxy.ts /app/proxy.ts
USER node
EXPOSE 3128
ENTRYPOINT ["node", "/app/proxy.ts"]
