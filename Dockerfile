FROM nginx:1.27-alpine

# Render injects PORT (default 10000). Bind to 0.0.0.0 via nginx listen.
ENV PORT=10000

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY main.html /usr/share/nginx/html/index.html
COPY main.html /usr/share/nginx/html/main.html
COPY style.css /usr/share/nginx/html/style.css

EXPOSE 10000
