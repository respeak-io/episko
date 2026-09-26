# Built from the repo root, since the server compiles against ../episko-proto:
#   docker build -f episko-server/Dockerfile -t episko-server .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY episko-proto episko-proto
COPY episko-server episko-server
RUN cd episko-server && cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=build /src/episko-server/target/release/episko-server /usr/local/bin/episko-server
VOLUME /data
ENV EPISKO_DB=/data/episko.db EPISKO_BIND=0.0.0.0:7878
EXPOSE 7878
ENTRYPOINT ["episko-server"]
CMD ["serve"]
