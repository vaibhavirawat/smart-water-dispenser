FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 3000
# Create schema/seed/admin if needed, then start the API + dashboard
CMD ["sh", "-c", "node scripts/init-db.js && node server.js"]
