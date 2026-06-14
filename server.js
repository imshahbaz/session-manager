// server.js
import 'dotenv/config';
import express, { json } from 'express';
import { fork } from 'child_process'; // Native Node module to fork independent engine threads

const app = express();
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

    // Reply instantly to free the Spring Boot HTTP pipeline
    res.status(202).json({ message: "Task passed to decoupled child process engine", status: "PENDING" });

    // Fork an independent OS child thread (Allocated outside the primary Node heap)
    const child = fork('./worker.js', [
        userid, 
        username, 
        password, 
        totp_secret, 
        api_key, 
        JAVA_BACKEND_URL, 
        expectedSource
    ]);

    // Cleanup reference keys when child process exits
    child.on('exit', () => {
        activeWorkers.delete(userKey);
        console.log(`🧹 Host kernel completely reclaimed memory structures for user ${userid}`);
    });
});

app.listen(PORT, () => console.log(`Decoupled Process Automation Router active on port ${PORT}`));