import 'dotenv/config';
import express, { json } from 'express';
import { chromium } from 'playwright-chromium';
import { default as PQueue } from 'p-queue';
import { TOTP } from 'totp-generator';

const app = express();
app.use(json());
const PORT = process.env.PORT || 3000;
const queue = new PQueue({ concurrency: 2 });
let browser = null;
const expectedSource = process.env.SOURCE || process.env.source;

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
                '--single-process'
            ]
        });
    }
    return browser;
}

const authMiddleware = (req, res, next) => {
    const requestSource = req.headers['source'];

    if (!expectedSource || requestSource !== expectedSource) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
};

const tokenCache = new Map();
const TOKEN_TTL_MS = 10 * 60 * 1000;

app.get('/health', (req, res) => res.status(200).send("OK"));

app.post('/api/zerodha/login-token', authMiddleware, (req, res) => {
    const { userid, username, password, totp_secret, api_key } = req.body;
    if (!userid || userid < 1 || !username || !password || !totp_secret || !api_key) {
        return res.status(400).json({ error: "Missing userid, username, password, totp_secret, or api_key" });
    }

    const cacheKey = String(userid);
    const existingData = tokenCache.get(cacheKey);
    if (existingData && Date.now() <= existingData.expiresAt) {
        if (existingData.status === "PENDING") {
            return res.status(202).json({ message: "Token generation already in progress", status: "PENDING" });
        } else if (existingData.status === "SUCCESS") {
            return res.status(200).json({ message: "Token already generated", status: "SUCCESS" });
        }
    }

    tokenCache.set(cacheKey, {
        status: "PENDING",
        expiresAt: Date.now() + TOKEN_TTL_MS
    });

    queue.add(async () => {
        try {
            const activeBrowser = await getBrowserInstance();
            const result = await executeZerodhaLogin(activeBrowser, username, password, totp_secret, api_key);

            if (result && result.success && result.request_token) {
                tokenCache.set(cacheKey, {
                    status: "SUCCESS",
                    request_token: result.request_token,
                    expiresAt: Date.now() + TOKEN_TTL_MS
                });
            }
        } catch (error) {
            console.error(`Login automation failed for user ${userid}:`, error.message);
            tokenCache.set(cacheKey, {
                status: "ERROR",
                error: error.message,
                expiresAt: Date.now() + TOKEN_TTL_MS
            });
        }
    });

    return res.status(202).json({ message: "Token generation in progress", status: "PENDING" });
});

app.get('/api/zerodha/login-token', authMiddleware, (req, res) => {
    const { userid } = req.query;

    if (!userid || userid < 1) {
        return res.status(400).json({ error: "Missing userid parameter" });
    }

    const cacheKey = String(userid);
    const tokenData = tokenCache.get(cacheKey);

    if (!tokenData) {
        return res.status(404).json({ error: "Token not found" });
    }

    if (Date.now() > tokenData.expiresAt) {
        tokenCache.delete(cacheKey);
        return res.status(404).json({ error: "Token expired" });
    }

    if (tokenData.status === "PENDING") {
        return res.json({ status: "PENDING", message: "Token generation is still in progress" });
    } else if (tokenData.status === "ERROR") {
        return res.status(500).json({ status: "ERROR", error: tokenData.error });
    }

    return res.json({ status: "SUCCESS", userid: userid, request_token: tokenData.request_token });
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
            throw new Error(`Failed to load Kite login. Status: ${response.status()}. Message: ${bodyText.slice(0, 100)}`);
        }

        try {
            await page.waitForSelector('#userid', { timeout: 10000 });
        } catch (e) {
            throw new Error(`Could not find login fields. URL: ${page.url()}. Is your API key valid?`);
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
            throw new Error(`Could not reach TOTP step. URL: ${page.url()}. Error: ${e.message}`);
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
                console.log("No authorize button found or click failed on authorize page.");
            }
        }

        const currentUrl = page.url();
        const urlParams = new URLSearchParams(new URL(currentUrl).search);
        const requestToken = urlParams.get('request_token');
        if (!requestToken) {
            throw new Error("Login completed but request_token not found in URL redirection.");
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
    console.log("Shutting down microservice...");
    if (browser) await browser.close();
    process.exit(0);
});


app.listen(PORT, () => {
    console.log(`Zerodha login service listening on port ${PORT}`);
})