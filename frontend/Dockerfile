FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ARG VITE_BASE_PATH=/
ARG VITE_API_URL=/api/v1
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine
ARG NGINX_SUBPATH=0
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /tmp/nginx.root.conf
COPY nginx.subpath.conf /tmp/nginx.subpath.conf
RUN if [ "$NGINX_SUBPATH" = "1" ]; then cp /tmp/nginx.subpath.conf /etc/nginx/conf.d/default.conf; else cp /tmp/nginx.root.conf /etc/nginx/conf.d/default.conf; fi
EXPOSE 80
