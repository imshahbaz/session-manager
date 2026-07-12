package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

var (
	javaBackendURL  *url.URL
	excludedLogURIs = map[string]bool{
		"/api/health": true, // Add any other endpoints you want to skip logging for
	}
)

func main() {
	// 1. Load configuration from Environment Variables
	backendStr := os.Getenv("JAVA_BACKEND_URL")
	if backendStr == "" {
		backendStr = "http://127.0.0.1:8080" // Fallback local default
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	var err error
	javaBackendURL, err = url.Parse(strings.TrimSuffix(backendStr, "/"))
	if err != nil {
		log.Fatalf("❌ Invalid JAVA_BACKEND_URL configuration: %v", err)
	}

	// 2. Build the Reverse Proxy engine
	proxy := httputil.NewSingleHostReverseProxy(javaBackendURL)

	// Fix header issues across cloud platforms (Like Koyeb changing domains)
	proxy.Director = func(req *http.Request) {
		req.Header.Add("X-Forwarded-Host", req.Host)
		req.Header.Add("X-Origin-Host", req.Host)
		req.URL.Scheme = javaBackendURL.Scheme
		req.URL.Host = javaBackendURL.Host
		req.Host = javaBackendURL.Host // Equivalent to changeOrigin: true
	}

	// 3. Set up custom routing and logging middleware
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Passthrough reverse routing check
		if strings.HasPrefix(r.URL.Path, "/api") {
			startTime := time.Now()

			// 🌟 FIX: Handle JSON payloads cleanly without breaking network streams
			if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodDelete {
				bodyBytes, err := io.ReadAll(r.Body)
				if err == nil && len(bodyBytes) > 0 {
					// Verify it is JSON structure (optional, but prevents structural drops)
					var js json.RawMessage
					if json.Unmarshal(bodyBytes, &js) == nil {
						r.Header.Set("Content-Type", "application/json")
					}
					// Re-populate the read closer stream smoothly
					r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
				}
			}

			// Capture status logging via a custom interceptor wrapper
			lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			// Forward request down the wire to the Spring Boot VPS
			proxy.ServeHTTP(lrw, r)

			// Clean, fast logging console printout
			duration := time.Since(startTime)
			cleanPath := strings.Split(r.URL.Path, "?")[0]
			if !excludedLogURIs[cleanPath] && !strings.HasPrefix(cleanPath, "/static/") && !strings.HasSuffix(cleanPath, ".ico") {
				log.Printf("[%s] %d | %v | %s", r.Method, lrw.statusCode, duration, r.URL.String())
			}
			return
		}

		// Fallback route handler (404)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Route not found on Go Gateway"})
	})

	log.Printf("Session manager active on port %s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}

// Custom wrapper to catch status codes out of the proxy worker loop
type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}
