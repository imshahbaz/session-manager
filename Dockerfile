# --- Step 1: Compile the fast Go binary using a modern Go release ---
FROM golang:alpine AS builder
WORKDIR /app

# Copy dependency records first to leverage Docker caching layers
COPY go.mod ./
RUN go mod download

# Copy the source code and build a highly optimized stripped binary
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o gateway main.go

# --- Step 2: Package into a tiny, secure runtime container ---
FROM alpine:latest
WORKDIR /app

# Install basic security certificates so the proxy can talk to HTTPS backends safely
RUN apk --no-cache add ca-certificates

# Copy only the compiled execution binary from the builder layer
COPY --from=builder /app/gateway .

# Expose port and run
EXPOSE 8080
CMD ["./gateway"]