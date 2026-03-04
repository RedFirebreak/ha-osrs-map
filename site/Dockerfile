###############################################
# Frontend Image
###############################################
FROM node:18-alpine AS build

WORKDIR /app

COPY ["./package.json", "./package-lock.json*", "./"]
RUN npm install

COPY . .
RUN npm run bundle

FROM node:18-alpine
WORKDIR /app

COPY --from=build /app/public ./public
COPY --from=build /app/scripts/server.js ./scripts/server.js
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

EXPOSE 4000
CMD ["node", "scripts/server.js"]
