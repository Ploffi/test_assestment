FROM node:22-alpine

WORKDIR /app

COPY engine ./engine
COPY demo ./demo

RUN npm --prefix engine ci \
  && npm --prefix demo ci \
  && npm --prefix engine run build

ENV HOST=0.0.0.0
ENV PORT=3300

EXPOSE 3300

CMD ["npm", "--prefix", "demo", "run", "start"]
