import express, { json } from 'express';
import { chromium } from 'playwright-chromium';
import { default as PQueue } from 'p-queue';
import { TOTP } from 'totp-generator';

const app = express();
app.use(json());

const PORT = process.env.PORT || 3000;

// Hard concurrency cap to prevent exceeding 500MB RAM.
// Max 2 browser contexts will run in parallel; others wait gracefully in queue.
const queue = new PQueue({ concurrency: 2 });

let browser;

// Initialize global browser instance on startup
async function initBrowser() {
    console.log("Launching optimized shared Chromium instance...");
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    });
}

// Microservice Route
app.post('/api/zerodha/login-token', async (req, res) => {
    const { username, password, totp_secret, api_key } = req.body;

    if (!username || !password || !totp_secret || !api_key) {
        return res.status(400).json({ error: "Missing username, password, totp_secret, or api_key" });
    }

    // Enqueue the automation task
    try {
        const result = await queue.add(() => executeZerodhaLogin(username, password, totp_secret, api_key));
        return res.json(result);
    } catch (error) {
        console.error("Login automation failed:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// Core Playwright Automation Function
async function executeZerodhaLogin(username, password, totpSecret, apiKey) {
    // Create a lightweight, isolated browser context (NOT a new browser window instance)
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // Optimizing Memory: Abort media and images (allow stylesheets and fonts so Vue.js doesn't break)
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

        // 2. Input Credentials
        try {
            await page.waitForSelector('#userid', { timeout: 10000 });
        } catch (e) {
            throw new Error(`Could not find login fields. URL: ${page.url()}. Is your API key valid?`);
        }

        await page.fill('#userid', username);
        await page.fill('#password', password);
        await page.click('button[type="submit"]');

        try {
            // Race between the TOTP field appearing or an error message appearing
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

        // Generate TOTP token
        const totpToken = await generateTOTP(totpSecret);
        await page.fill('.twofa-form input', totpToken);
        // Kite often auto-submits when the 6th digit is typed. 
        // We fire a click asynchronously so it doesn't block if the page navigates away instantly.
        page.click('.twofa-form button[type="submit"]').catch(() => { });

        // Wait for redirect to the authorize page OR the final callback URL with request_token
        await page.waitForURL(/.*(\/connect\/authorize|request_token=).*/, { timeout: 15000 });

        // If it lands on the /connect/authorize page, click the authorize button
        if (page.url().includes('/connect/authorize')) {
            try {
                await page.waitForSelector('.button-orange', { timeout: 5000 });
                page.click('.button-orange').catch(() => {});
                // Wait for the final redirect
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
        // Crucial: Clean up context immediately to release memory back to the system
        await page.close();
        await context.close();
    }
}

// Generate TOTP using totp-generator
async function generateTOTP(secret) {
    const cleanSecret = secret.replace(/\s+/g, '');
    const { otp } = await TOTP.generate(cleanSecret);
    return otp;
}

// Clean shutdown handler
process.on('SIGTERM', async () => {
    console.log("Shutting down microservice...");
    if (browser) await browser.close();
    process.exit(0);
});

// Start Microservice
initBrowser().then(() => {
    app.listen(PORT, () => {
        console.log(`Zerodha login service listening on port ${PORT}`);
    });
}).catch(err => {
    console.error("Failed to start browser instance:", err);
    process.exit(1);
});