import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// Get input
const input = await Actor.getInput();
const { email, password, communityUrl } = input;

if (!email || !password || !communityUrl) {
    throw new Error('Missing required input: email, password, or communityUrl');
}

// Extract community name from URL
const communityName = communityUrl.split('/').pop().split('?')[0];
console.log(`Scraping trial-declined members from: ${communityName}`);

// Launch browser with Playwright
const browser = await chromium.launch({
    headless: true,
});

const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

try {
    // Step 1: Go to Skool login page
    console.log('Navigating to Skool login...');
    await page.goto('https://www.skool.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 2: Login
    console.log('Logging in...');

    // Take screenshot of login page
    const loginScreenshot = await page.screenshot();
    await Actor.setValue('debug-login-page', loginScreenshot, { contentType: 'image/png' });

    // Find and fill email field
    const emailField = await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await emailField.fill(email);
    console.log('Email entered');

    // Find and fill password field
    const passwordField = await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await passwordField.fill(password);
    console.log('Password entered');

    // Take screenshot before clicking login
    const preLoginScreenshot = await page.screenshot();
    await Actor.setValue('debug-pre-login', preLoginScreenshot, { contentType: 'image/png' });

    // Click login button
    await page.click('button[type="submit"]');

    // Wait for URL to change (indicating successful login redirect)
    await page.waitForURL(/skool\.com(?!\/login)/, { timeout: 30000 });
    console.log('Login redirect detected');

    // Wait for page to stabilize
    await page.waitForTimeout(5000);

    // Take screenshot after login
    const postLoginScreenshot = await page.screenshot();
    await Actor.setValue('debug-post-login', postLoginScreenshot, { contentType: 'image/png' });

    // Check if we're actually logged in by looking at the URL or page content
    const currentUrl = page.url();
    console.log(`Current URL after login: ${currentUrl}`);

    // Check for any error messages on page
    const pageContent = await page.content();
    if (pageContent.includes('Invalid') || pageContent.includes('incorrect') || pageContent.includes('error')) {
        console.log('WARNING: Login may have failed - error text detected on page');
    }

    console.log('Login completed - check debug screenshots to verify');

    // Step 3: First navigate to the community homepage to "switch" to it
    const communityUrl = `https://www.skool.com/${communityName}`;
    console.log(`Navigating to community: ${communityUrl}`);
    await page.goto(communityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Take screenshot of community page
    const communityScreenshot = await page.screenshot();
    await Actor.setValue('debug-community-page', communityScreenshot, { contentType: 'image/png' });
    console.log('Community page screenshot saved');

    // Step 4: Now navigate to the admin members page
    const membersUrl = `https://www.skool.com/${communityName}/-/members`;
    console.log(`Navigating to members page: ${membersUrl}`);
    await page.goto(membersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000); // Let page fully render

    // Wait for page to load
    await page.waitForTimeout(3000);

    // Take a debug screenshot of what we see
    const debugScreenshot = await page.screenshot({ fullPage: true });
    await Actor.setValue('debug-members-page', debugScreenshot, { contentType: 'image/png' });
    console.log('Debug screenshot saved to key-value store');

    // Scroll down to load more members (Skool uses infinite scroll)
    console.log('Scrolling to load all members...');
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 10;

    while (scrollAttempts < maxScrollAttempts) {
        const currentHeight = await page.evaluate(() => document.body.scrollHeight);
        if (currentHeight === previousHeight) {
            break; // No more content to load
        }
        previousHeight = currentHeight;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);
        scrollAttempts++;
        console.log(`  Scroll ${scrollAttempts}/${maxScrollAttempts}...`);
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // Step 5: Scrape members with "Trial declined" status
    console.log('Scanning for trial-declined members...');

    const trialDeclinedMembers = await page.evaluate(() => {
        const members = [];
        const processedUsernames = new Set();

        // Debug: Log page content summary
        const pageText = document.body.innerText;
        const hasDeclined = pageText.toLowerCase().includes('declined');
        console.log('Page contains "declined":', hasDeclined);

        // Find all elements containing "declined" (case insensitive)
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
            // Check direct text content (not children)
            const directText = Array.from(el.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent)
                .join('');

            // Also check the element's full text
            const fullText = el.textContent || '';

            if (fullText.toLowerCase().includes('declined')) {
                // Found an element with "declined" - traverse up to find the member row
                let container = el;

                // Go up to find a container that has member info
                for (let i = 0; i < 20; i++) {
                    if (!container || container === document.body) break;

                    // Look for member profile link
                    const profileLinks = container.querySelectorAll('a[href*="/u/"]');

                    if (profileLinks.length > 0) {
                        const nameEl = profileLinks[0];
                        const href = nameEl.getAttribute('href') || '';
                        const username = href.split('/u/')[1]?.split('?')[0];

                        if (username && !processedUsernames.has(username)) {
                            processedUsernames.add(username);

                            const name = nameEl.textContent?.trim();
                            const containerText = container.textContent || '';

                            // Extract days remaining from "removing in X days"
                            const daysMatch = containerText.match(/removing in (\d+) days?/i);
                            const daysRemaining = daysMatch ? parseInt(daysMatch[1]) : null;

                            // Try to find price tier
                            const priceMatch = containerText.match(/\$(\d+)\/(month|year)/i);
                            const price = priceMatch ? `$${priceMatch[1]}/${priceMatch[2]}` : null;

                            // Try to find join date
                            const joinMatch = containerText.match(/Joined\s+([A-Za-z]+\s+\d+,?\s*\d*)/i);
                            const joinDate = joinMatch ? joinMatch[1] : null;

                            // Try to find last active
                            const activeMatch = containerText.match(/Active\s+(\d+[hmd]\s*ago|\d+\s+days?\s+ago)/i);
                            const lastActive = activeMatch ? activeMatch[1] : null;

                            console.log(`Found declined member: ${name} (@${username}), removing in ${daysRemaining} days`);

                            members.push({
                                name,
                                username,
                                status: 'Trial declined',
                                daysRemaining,
                                price,
                                joinDate,
                                lastActive,
                                scrapedAt: new Date().toISOString()
                            });

                            break; // Found this member, stop traversing up
                        }
                    }

                    container = container.parentElement;
                }
            }
        }

        return members;
    });

    console.log(`Found ${trialDeclinedMembers.length} members who declined their trial`);

    if (trialDeclinedMembers.length > 0) {
        console.log('\nTrial-declined members:');
        console.log('------------------------');
        trialDeclinedMembers.forEach(m => {
            console.log(`  ${m.name}`);
            console.log(`    Username: @${m.username || 'unknown'}`);
            console.log(`    Days remaining: ${m.daysRemaining || 'unknown'}`);
            console.log(`    Price: ${m.price || 'unknown'}`);
            console.log(`    Joined: ${m.joinDate || 'unknown'}`);
            console.log(`    Last active: ${m.lastActive || 'unknown'}`);
            console.log('');
        });
    } else {
        console.log('\nNo trial-declined members found. This could mean:');
        console.log('  1. No one has declined their trial currently');
        console.log('  2. The page structure may have changed');
        console.log('  3. You may not have admin access to see trial status');
    }

    // Save results to dataset
    if (trialDeclinedMembers.length > 0) {
        await Actor.pushData(trialDeclinedMembers);
    }

    // Also save a summary to key-value store
    await Actor.setValue('summary', {
        community: communityName,
        scrapedAt: new Date().toISOString(),
        totalFound: trialDeclinedMembers.length,
        members: trialDeclinedMembers
    });

    console.log('\nResults saved!');

} catch (error) {
    console.error('Error during scraping:', error.message);

    // Take a screenshot for debugging
    try {
        const screenshot = await page.screenshot();
        await Actor.setValue('error-screenshot', screenshot, { contentType: 'image/png' });
        console.log('Error screenshot saved to key-value store');
    } catch (e) {
        console.log('Could not save screenshot');
    }

    throw error;
} finally {
    await browser.close();
}

await Actor.exit();
