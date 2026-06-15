// server.js
import 'dotenv/config';
import express, { json } from 'express';
import { fork } from 'child_process';
import httpProxy from 'http-proxy';

const app = express();
const proxy = httpProxy.createProxyServer({});
const VPS_URL = process.env.VPS_URL || 'http://YOUR_WEBEYESOFT_VPS_IP:80';
app.use(json());

const PORT = process.env.PORT || 3000;
const JAVA_BACKEND_URL = process.env.JAVA_BACKEND_URL;
const expectedSource = process.env.SOURCE || process.env.source;

// Track active users to prevent multi-trigger floods
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

app.use((req, res) => {
    console.log(`🔀 No local match on Render. Mirroring ${req.method} ${req.url} to VPS...`);
    
    let proxyOptions = { target: VPS_URL };
    
    if (req.body && Object.keys(req.body).length > 0) {
        proxyOptions.buffer = {
            pipe: (dest) => {
                dest.write(JSON.stringify(req.body));
                dest.end();
            }
        };
    }

    proxy.web(req, res, proxyOptions, (error) => {
        console.error('❌ Passthrough Proxy Error:', error.message);
        res.status(502).send('VPS backend target is currently unreachable.');
    });
});

app.listen(PORT, () => console.log(`Session manager active on port ${PORT}`));