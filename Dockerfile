# Builder stage
FROM golang:1.24 AS builder
WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o gateway .

# Runtime stage
FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/gateway .

ENV PORT=8080
ENV JAVA_BACKEND_URL=http://127.0.0.1:8080

EXPOSE ${PORT}
CMD ["./gateway"]
