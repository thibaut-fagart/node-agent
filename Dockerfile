FROM node:6.11-alpine
WORKDIR /app
RUN apk add --no-cache git
ENV AGENT_CONFIG_PATH /config/config.js
ENV DOCKER true
ADD package.json /app
RUN yarn install
ADD app.js .
ADD config.js /app/config.js
CMD ["yarn","start"]
