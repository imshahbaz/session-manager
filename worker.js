// worker.js
import { chromium } from 'playwright-chromium';
import { TOTP } from 'totp-generator';
import axios from 'axios';

const [,, userid, username, password, totp_secret, api_key, java_url, expectedSource] = process.argv;

async function runWorker() {
    console.log(`🤖 [Child Process] Starting isolated login worker for user ${userid}...`);
    let browser = null;
    
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--disable-extensions',
                '--js-flags="--max-old-space-size=128"'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // Block heavy assets (images/media) to conserve data center RAM
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // Navigate to the developer client route
        await page.goto(`https://kite.trade/connect/login?v=3&api_key=${api_key}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForSelector('#userid', { timeout: 10000 });

        // Phase 1: Submit Credentials
        await page.fill('#userid', username);
        await page.fill('#password', password);
        await page.click('button[type="submit"]');

        // Wait until the web application renders the 2FA verification panel
        await page.waitForSelector('.twofa-form input', { timeout: 10000 });

        // Phase 2: Compute and input 2FA TOTP Layer
        let cleanSecret = totp_secret.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
        const { otp } = await TOTP.generate(cleanSecret);

        console.log(`⏳ Entering OTP for user ${userid}. Waiting for auto-submission...`);
        await page.fill('.twofa-form input', otp);

        // DO NOT click the submit button. Typing all 6 characters forces Kite's scripts to auto-submit.
        await page.waitForURL(/.*(\/connect\/authorize|request_token=).*/, { timeout: 20000 });

        // Phase 3: Handle the Interactive Authorization Button Click
        if (page.url().includes('/connect/authorize')) {
            console.log(`📥 [Child Process] App approval screen caught. Simulating authorization agreement click...`);
            await page.waitForSelector('.button-orange', { timeout: 10000 });
            
            // This button layout is stable and doesn't auto-submit, so clicking it is required
            await Promise.all([
                page.click('.button-orange'),
                page.waitForURL(/.*request_token=.*/, { timeout: 15000 })
            ]);
        }

        // Extract the request_token parameter out of the search route parameters
        const currentUrl = page.url();
        const urlParams = new URLSearchParams(new URL(currentUrl).search);
        const requestToken = urlParams.get('request_token');

        if (!requestToken) {
            throw new Error(`Failed to extract token parameter from final landing URL: ${currentUrl}`);
        }

        // Send token back to your Spring Boot Backend API
        console.log(`✅ [Child Process] Token found for user ${userid}. Dispatching callback payload...`);
        await axios.post(`${java_url}/api/session-manager/zerodha-callback`, {
            status: "SUCCESS",
            message: "Token generated successfully via single-use container execution",
            error: null,
            userid: Number(userid),
            request_token: requestToken
        }, { headers: { 'source': "session-manager" } });

    } catch (error) {
        console.error(`❌ [Child Process] Worker exception for user ${userid}:`, error.message);
        await axios.post(`${java_url}/api/session-manager/zerodha-callback`, {
            status: "ERROR",
            message: "Isolated process chain failed",
            error: error.message,
            userid: Number(userid),
            request_token: null
        }, { headers: { 'source': "session-manager" } }).catch(() => {});
    } finally {
        if (browser) {
            await browser.close();
        }
        process.exit(0); // Closes the OS thread cleanly, instantly reclaiming 100% of its RAM
    }
}

runWorker();