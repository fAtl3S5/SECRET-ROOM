FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY bot.js ./
RUN mkdir -p /app/data
ENV PORT=3000
ENV DATA_FILE=/app/data/subscriptions.json
EXPOSE 3000
CMD ["node", "bot.js"]
