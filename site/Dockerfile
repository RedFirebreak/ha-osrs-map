###############################################
# Frontend Image
###############################################
FROM node:18-alpine as production-frontend

WORKDIR /app

COPY ["./package.json", "./package-lock.json*", "./"]
RUN npm install --ignore-scripts

COPY . .
RUN chmod +x /app/scripts/docker-entrypoint.sh

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["npm","run","serve"]
