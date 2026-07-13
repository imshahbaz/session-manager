package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type Config struct {
	BackendURL string
	Port       string
}

func loadConfig() Config {
	backendURL := os.Getenv("JAVA_BACKEND_URL")
	if backendURL == "" {
		backendURL = "http://127.0.0.1:8080"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	return Config{
		BackendURL: backendURL,
		Port:       port,
	}
}

func createTransport() *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          500,
		MaxIdleConnsPerHost:   200,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
}

func createReverseProxy(targetURL *url.URL) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(targetURL)
			pr.SetXForwarded() // Automatically sets X-Forwarded-For, X-Forwarded-Host, X-Forwarded-Proto

			// Extract Client IP
			clientIP, _, err := net.SplitHostPort(pr.In.RemoteAddr)
			if err == nil {
				if pr.In.Header.Get("X-Real-IP") == "" {
					pr.Out.Header.Set("X-Real-IP", clientIP)
				}
			} else {
				if pr.In.Header.Get("X-Real-IP") == "" {
					pr.Out.Header.Set("X-Real-IP", pr.In.RemoteAddr)
				}
			}
		},
		Transport: createTransport(),
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("[Proxy Error] %v", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)

			resp := map[string]interface{}{
				"success": false,
				"message": "Backend unavailable",
			}
			json.NewEncoder(w).Encode(resp)
		},
	}
	return proxy
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rw, r)

		duration := time.Since(start)
		clientIP, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			clientIP = r.RemoteAddr
		}

		log.Printf("timestamp=%s method=%s path=%s status=%d duration=%s client_ip=%s",
			time.Now().Format(time.RFC3339),
			r.Method,
			r.URL.Path,
			rw.status,
			duration,
			clientIP,
		)
	})
}

func RecoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				log.Printf("[Panic Recovered] %v", err)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"success":false,"message":"Internal Server Error"}`))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"UP"}`))
}

func main() {
	config := loadConfig()

	targetURL, err := url.Parse(config.BackendURL)
	if err != nil {
		log.Fatalf("Invalid JAVA_BACKEND_URL: %v", err)
	}

	proxy := createReverseProxy(targetURL)

	mux := http.NewServeMux()

	// Exact match for health endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" && r.Method == http.MethodGet {
			healthHandler(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})

	// Proxy all other requests
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	})

	handler := RecoveryMiddleware(LoggingMiddleware(mux))

	// WriteTimeout and ReadTimeout are set to 0 (no timeout) to allow >10GB uploads/downloads and streaming (SSE/WS).
	// ReadHeaderTimeout is set to prevent slowloris attacks.
	server := &http.Server{
		Addr:              ":" + config.Port,
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1 MB
	}

	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("Starting reverse proxy on port %s, forwarding to %s", config.Port, config.BackendURL)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-stopChan
	log.Println("Shutting down gracefully...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Graceful shutdown failed: %v", err)
	}

	log.Println("Server stopped")
}
