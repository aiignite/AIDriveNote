FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline
COPY . .
ARG VITE_BASE_PATH=/
ARG VITE_API_URL=/api/v1
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_API_URL=$VITE_API_URL
# 目标服务器内存较小（约 3.7G），Node 默认 2G 堆上限会让 vite 构建 OOM
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN npm run build

FROM nginx:alpine
ARG NGINX_SUBPATH=0
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /tmp/nginx.root.conf
COPY nginx.subpath.conf /tmp/nginx.subpath.conf
RUN if [ "$NGINX_SUBPATH" = "1" ]; then cp /tmp/nginx.subpath.conf /etc/nginx/conf.d/default.conf; else cp /tmp/nginx.root.conf /etc/nginx/conf.d/default.conf; fi
EXPOSE 80
