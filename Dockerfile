FROM grafana/k6:0.54.0 AS k6
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p data generated && chown -R node:node data generated
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/server.js"]
