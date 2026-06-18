// server.js
import 'dotenv/config';
import express, { json } from 'express';
import { fork } from 'child_process';
import httpProxy from 'http-proxy';
import http from 'http';
import https from 'https';

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

const activeWorkers = new Set();

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

    if (activeWorkers.has(userKey)) {
        console.log(`⚠️ Request dropped: Automation already running for user ${userid}`);
        return res.status(202).json({ message: "Token generation already in progress", status: "PENDING" });
    }

    activeWorkers.add(userKey);

    res.status(202).json({ message: "Task passed to decoupled child process engine", status: "PENDING" });

    const child = fork('./worker.js', [
        userid, 
        username, 
        password, 
        totp_secret, 
        api_key, 
        JAVA_BACKEND_URL, 
        expectedSource
    ]);

    child.on('exit', () => {
        activeWorkers.delete(userKey);
        console.log(`🧹 Host kernel completely reclaimed memory structures for user ${userid}`);
    });
});

app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
        const startTime = Date.now();
        const { method, url: rawUrl } = req;
        const cleanPath = rawUrl.split('?')[0];
        let proxyOptions = { target: JAVA_BACKEND_URL };
        
        if (req.body && Object.keys(req.body).length > 0) {
            const bodyData = JSON.stringify(req.body);
            req.headers['content-length'] = Buffer.byteLength(bodyData);
            proxyOptions.buffer = {
                pipe: (dest) => {
                    dest.write(bodyData);
                    dest.end();
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

app.use((req, res) => {
    res.status(404).json({ error: "Route not found on Render Gateway" });
});

app.listen(PORT, () => console.log(`Session manager active on port ${PORT}`));