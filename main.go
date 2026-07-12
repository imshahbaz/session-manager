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
	javaBackendURL *url.URL
	excludedLogURIs = map[string]bool{
		"/api/health": true,
	}
)

func main() {
	// 1. Load configuration from Environment Variables
	backendStr := os.Getenv("JAVA_BACKEND_URL")
	if backendStr == "" {
		backendStr = "http://127.0.0.1:8080"
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

	// Fix header routing issues across modern cloud platforms
	proxy.Director = func(req *http.Request) {
		req.Header.Add("X-Forwarded-Host", req.Host)
		req.Header.Add("X-Origin-Host", req.Host)
		req.URL.Scheme = javaBackendURL.Scheme
		req.URL.Host = javaBackendURL.Host
		req.Host = javaBackendURL.Host
	}

	// 🌟 THE BULLETPROOF MOBILE FIX: Strip explicit domain declarations.
	// This forces the phone's native OS layer to lock the session cookie
	// cleanly to your Koyeb domain, preventing the client app from discarding it.
	proxy.ModifyResponse = func(res *http.Response) error {
		cookies := res.Header["Set-Cookie"]
		if len(cookies) > 0 {
			var cleanedCookies []string
			for _, cookie := range cookies {
				parts := strings.Split(cookie, ";")
				var cleanedParts []string
				for _, part := range parts {
					trimmed := strings.TrimSpace(part)
					// Remove any Domain target (e.g., Domain=123.45.67.89)
					if !strings.HasPrefix(strings.ToLower(trimmed), "domain=") {
						cleanedParts = append(cleanedParts, part)
					}
				}
				cleanedCookies = append(cleanedCookies, strings.Join(cleanedParts, ";"))
			}
			res.Header["Set-Cookie"] = cleanedCookies
		}
		return nil
	}

	// 3. Set up custom routing and logging middleware
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Passthrough reverse routing check
		if strings.HasPrefix(r.URL.Path, "/api") {
			startTime := time.Now()

			// Handle JSON payloads safely without breaking high-speed streams
			if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodDelete {
				bodyBytes, err := io.ReadAll(r.Body)
				if err == nil && len(bodyBytes) > 0 {
					var js json.RawMessage
					if json.Unmarshal(bodyBytes, &js) == nil {
						r.Header.Set("Content-Type", "application/json")
					}
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