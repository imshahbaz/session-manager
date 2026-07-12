// server.js
import 'dotenv/config';
import express, { json } from 'express';
import { fork } from 'child_process';
import httpProxy from 'http-proxy';
import http from 'http';
import https from 'https';
import async from 'async'; // 🎯 Handled via npm install async

const EXCLUDED_LOG_URIS = new Set([
    "/api/user/fcm-token",
    "/api/auth/me",
    "/health",
    "/api/angelone/ltp"
]);

const app = express();
const PORT = process.env.PORT || 3000;
const JAVA_BACKEND_URL = process.env.JAVA_BACKEND_URL;
const expectedSource = process.env.SOURCE || process.env.source;
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });

const targetAgent = JAVA_BACKEND_URL.startsWith('https')
    ? keepAliveHttpsAgent
    : keepAliveHttpAgent;

const proxy = httpProxy.createProxyServer({
    secure: false,
    changeOrigin: true,
    agent: targetAgent
});

app.use(json());

// 🎯 Reverted to your original tracking Set
const activeWorkers = new Set();
const MAX_CONCURRENT_BROWSERS = 1;

// 🎯 Cleaned Queue Engine: Removed deferred response logic to prevent header crashes
const loginQueue = async.queue(async (task) => {
    const { userid, args } = task;

    console.log(`🚀 [Queue Engine] Spawning isolated browser worker for user ${userid}. Current Queue Depth: ${loginQueue.length()}`);

    return new Promise((resolve) => {
        const child = fork('./worker.js', args);

        child.on('exit', (code) => {
            // Remove the user from the active duplicate tracker map once the worker completely exits
            activeWorkers.delete(String(userid));
            console.log(`🧹 [Queue Engine] Host kernel reclaimed memory structures for user ${userid} (Exit code: ${code})`);

            // Notify queue engine that the hardware slot is clear for the next task
            resolve();
        });
    });
}, MAX_CONCURRENT_BROWSERS);

const authMiddleware = (req, res, next) => {
    const requestSource = req.headers['source'];
    if (!expectedSource || requestSource !== expectedSource) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
};

app.get('/health', (req, res) => res.status(200).send("OK"));

app.post('/api/zerodha/login-token', authMiddleware, (req, res) => {
    const { userid, username, password, totp_secret, api_key } = req.body;

    if (!userid || !username || !password || !totp_secret || !api_key) {
        return res.status(400).json({ error: "Missing required properties" });
    }

    const userKey = String(userid);

    // 🎯 Checks if automation is already running or queued for this exact user
    if (activeWorkers.has(userKey)) {
        console.log(`⚠️ Request dropped: Automation already running for user ${userid}`);
        return res.status(202).json({ message: "Token generation already in progress", status: "PENDING" });
    }

    activeWorkers.add(userKey);

    // 🎯 Instantly send back your exact original response to Spring Boot
    res.status(202).json({ message: "Task passed to decoupled child process engine", status: "PENDING" });

    const task = {
        userid: userid,
        args: [
            userid,
            username,
            password,
            totp_secret,
            api_key,
            JAVA_BACKEND_URL,
            expectedSource
        ]
    };

    // Push into memory-safe queue line execution array
    loginQueue.push(task, (err) => {
        if (err) {
            console.error(`❌ Queue pipeline failure handling task for user ${userid}:`, err);
            activeWorkers.delete(userKey);
        }
    });

    console.log(`📥 [Queue Engine] Task queued for user ${userid}. Position in queue line: ${loginQueue.length()}`);
});

// Passthrough reverse routing engine configuration
app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
        const startTime = Date.now();
        const { method, url: rawUrl } = req;
        const cleanPath = rawUrl.split('?')[0];

        let proxyOptions = {
            target: JAVA_BACKEND_URL,
            changeOrigin: true
        };

        // 🌟 Re-stream parsed JSON without calling dest.end() prematurely
        if (req.body && Object.keys(req.body).length > 0) {
            const bodyData = JSON.stringify(req.body);
            req.headers['content-length'] = Buffer.byteLength(bodyData);
            req.headers['content-type'] = 'application/json';

            proxyOptions.buffer = {
                pipe: (dest) => {
                    dest.write(bodyData);
                }
            };
        }

        res.once('finish', () => {
            const duration = Date.now() - startTime;
            const isExcluded = EXCLUDED_LOG_URIS.has(cleanPath) ||
                cleanPath.startsWith("/static/") ||
                cleanPath.endsWith(".ico");

            if (!isExcluded) {
                console.log(`[${method}] ${res.statusCode} | ${duration} ms | ${rawUrl}`);
            }
        });

        return proxy.web(req, res, proxyOptions, (error) => {
            console.error('❌ Passthrough Proxy Error:', error.message);
            if (!res.headersSent) {
                res.status(502).send('VPS backend target is currently unreachable.');
            }
        });
    }
    next();
});

proxy.on('proxyReq', function (proxyReq, req, res, options) {
    if (req.body && Object.keys(req.body).length > 0) {
        proxyReq.setHeader('Content-Type', 'application/json');
    }
});

proxy.on('proxyRes', function (proxyRes, req, res) {
    if (proxyRes.headers['set-cookie']) {
        res.setHeader('Set-Cookie', proxyRes.headers['set-cookie']);
    }
});

app.use((req, res) => {
    res.status(404).json({ error: "Route not found on Render Gateway" });
});

app.listen(PORT, () => console.log(`Session manager active on port ${PORT} with MAX_CONCURRENT_BROWSERS=${MAX_CONCURRENT_BROWSERS}`));