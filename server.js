import 'dotenv/config';
import express, { json } from 'express';
import { chromium } from 'playwright-chromium';
import { default as PQueue } from 'p-queue';
import { TOTP } from 'totp-generator';
import axios from 'axios';

const app = express();
app.use(json());

const PORT = process.env.PORT || 3000;
const JAVA_BACKEND_URL = process.env.JAVA_BACKEND_URL;
const expectedSource = process.env.SOURCE || process.env.source;

const queue = new PQueue({ concurrency: 1 });
const inFlightRequests = new Set();
let browser = null;

// Optimize shared Chromium launch flags to minimize footprint and bot detection
async function getBrowserInstance() {
    if (!browser) {
        console.log("🚀 Launching optimized shared Chromium instance on-demand...");
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--disable-extensions'
            ]
        });
    }
    return browser;
}

// Authentication middleware for inbound requests to secure the endpoint
const authMiddleware = (req, res, next) => {
    const requestSource = req.headers['source'];
    if (!expectedSource || requestSource !== expectedSource) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
};

// Simple Health Check for Render's uptime monitors
app.get('/health', (req, res) => res.status(200).send("OK"));

// Trigger Automation Login Endpoint
app.post('/api/zerodha/login-token', authMiddleware, (req, res) => {
    const { userid, username, password, totp_secret, api_key } = req.body;

    if (!userid || userid < 1 || !username || !password || !totp_secret || !api_key) {
        return res.status(400).json({ error: "Missing userid, username, password, totp_secret, or api_key" });
    }

    const cacheKey = String(userid);

    if (inFlightRequests.has(cacheKey)) {
        console.log(`⚠️ Request blocked: Automation is already running for user ${userid}`);
        return res.status(202).json({
            message: "Token generation already in progress",
            status: "PENDING"
        });
    }

    inFlightRequests.add(cacheKey);

    res.status(202).json({ message: "Token generation task queued successfully", status: "PENDING" });

    queue.add(async () => {
        try {
            const activeBrowser = await getBrowserInstance();
            const result = await executeZerodhaLogin(activeBrowser, username, password, totp_secret, api_key);

            if (result && result.success && result.request_token) {
                console.log(`✅ Automation succeeded for user ${userid}. Dispatching callback payload...`);

                await axios.post(`${JAVA_BACKEND_URL}/api/session-manager/zerodha-callback`, {
                    status: "SUCCESS",
                    message: "Token generated successfully via automation",
                    error: null,
                    userid: Number(userid),
                    request_token: result.request_token
                }, {
                    headers: { 'source': "session-manager" }
                });
            }
        } catch (error) {
            const errMsg = error.message || "";
            console.error(`❌ Login automation failed for user ${userid}:`, errMsg);

            await axios.post(`${JAVA_BACKEND_URL}/api/session-manager/zerodha-callback`, {
                status: "ERROR",
                message: "Automation workflow encountered an exception",
                error: errMsg,
                userid: Number(userid),
                request_token: null
            }, {
                headers: { 'source': "session-manager" }
            }).catch((err) => {
                console.error(`Failed to deliver failure callback payload to Java app:`, err.message);
            });
        }
        finally {
            if (activeBrowser) {
                try {
                    await activeBrowser.close();
                    console.log(`🧹 Cleanly closed Chromium process space for user ${userid}`);
                } catch (closeError) {
                    console.error("Error closing browser process:", closeError.message);
                }
            }
            inFlightRequests.delete(cacheKey);
            console.log(`🔓 Released lock for user ${userid}. Ready for next request.`);
        }
    });
});

async function executeZerodhaLogin(activeBrowser, username, password, totpSecret, apiKey) {
    const context = await activeBrowser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        const response = await page.goto(`https://kite.trade/connect/login?v=3&api_key=${apiKey}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (response && response.status() >= 400) {
            const bodyText = await page.locator('body').innerText();
            throw new Error(`Failed to load Kite login page. Status: ${response.status()}. Message: ${bodyText.slice(0, 100)}`);
        }

        try {
            await page.waitForSelector('#userid', { timeout: 10000 });
        } catch (e) {
            throw new Error(`Could not locate login elements. Is your API key correct?`);
        }

        await page.fill('#userid', username);
        await page.fill('#password', password);
        await page.click('button[type="submit"]');

        try {
            const result = await Promise.race([
                page.waitForSelector('.twofa-form input', { timeout: 10000 }).then(() => 'totp'),
                page.waitForSelector('p.error', { timeout: 10000 }).then(async (el) => {
                    const text = await el.innerText();
                    return `error: ${text}`;
                })
            ]);
            if (result.startsWith('error:')) {
                throw new Error(`Invalid credentials: ${result.replace('error: ', '').trim()}`);
            }
        } catch (e) {
            if (e.message.includes('Invalid credentials')) throw e;
            throw new Error(`Failed passing step one credentials layer. Error: ${e.message}`);
        }

        const totpToken = await generateTOTP(totpSecret);
        await page.fill('.twofa-form input', totpToken);
        page.click('.twofa-form button[type="submit"]').catch(() => { });
        await page.waitForURL(/.*(\/connect\/authorize|request_token=).*/, { timeout: 15000 });

        if (page.url().includes('/connect/authorize')) {
            try {
                await page.waitForSelector('.button-orange', { timeout: 5000 });
                page.click('.button-orange').catch(() => { });
                await page.waitForURL(/.*request_token=.*/, { timeout: 10000 });
            } catch (err) {
                console.log("Authorization screen redirect skipped or timed out.");
            }
        }

        const currentUrl = page.url();
        const urlParams = new URLSearchParams(new URL(currentUrl).search);
        const requestToken = urlParams.get('request_token');
        if (!requestToken) {
            throw new Error("Kite login flow finished but request_token was omitted during parameter parsing.");
        }

        return { success: true, request_token: requestToken };
    } finally {
        await page.close();
        await context.close();
    }
}

async function generateTOTP(secret) {
    const cleanSecret = secret.replace(/\s+/g, '');
    const { otp } = await TOTP.generate(cleanSecret);
    return otp;
}

process.on('SIGTERM', async () => {
    console.log("Received termination signal. Closing engine instances...");
    if (browser) await browser.close();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Zerodha webhook login adapter active on port ${PORT}`);
});