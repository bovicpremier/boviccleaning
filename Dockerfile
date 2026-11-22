FROM node:22-alpine

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    TRUST_PROXY=1

EXPOSE 3000

CMD ["node", "backend/server.js"]
