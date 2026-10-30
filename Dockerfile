# DriveProof: one container running the Licence Authority, the Car Rental verifier and the demo wallet.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# ca-certificates: the Askar native library is downloaded over HTTPS during npm install.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]
