FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js questions.json ./
COPY public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/poll.sqlite
EXPOSE 3000
CMD ["node", "server.js"]
