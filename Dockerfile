FROM node:22-alpine
WORKDIR /app
COPY server.js .
COPY services.json .
EXPOSE 3000
CMD ["node", "server.js"]
