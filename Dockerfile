# syntax=docker/dockerfile:1

FROM oven/bun:1.2-debian AS build
WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
RUN bunx prisma generate

COPY index.ts ./
COPY src ./src
COPY uploads ./uploads

FROM oven/bun:1.2-debian AS release
WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4040

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/generated ./generated
COPY --from=build /app/index.ts ./
COPY --from=build /app/src ./src
COPY --from=build /app/uploads ./uploads
COPY --from=build /app/prisma ./prisma

RUN mkdir -p uploads/images uploads/recipes uploads/meditation uploads/videos

EXPOSE 4040

VOLUME ["/app/uploads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 4040) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "index.ts"]
