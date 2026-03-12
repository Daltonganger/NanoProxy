FROM node:22-alpine

WORKDIR /app

COPY . /app
RUN chmod +x /app/entrypoint-native-first.sh

ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=8787
ENV INTERNAL_PROXY_HOST=127.0.0.1
ENV INTERNAL_PROXY_PORT=8788

EXPOSE 8787

CMD ["/app/entrypoint-native-first.sh"]
