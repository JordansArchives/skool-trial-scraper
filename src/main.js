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
    await page.goto('https://www.skool.com/login', { waitUntil: 'networkidle' });

    // Step 2: Login
    console.log('Logging in...');
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);

    // Click login button
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    console.log('Login successful!');

    // Step 3: Navigate to community members page (admin view)
    const membersUrl = `https://www.skool.com/${communityName}/members`;
    console.log(`Navigating to members page: ${membersUrl}`);
    await page.goto(membersUrl, { waitUntil: 'networkidle' });

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

    // Step 4: Scrape members with "Trial declined" status
    console.log('Scanning for trial-declined members...');

    const trialDeclinedMembers = await page.evaluate(() => {
        const members = [];
        const processedMembers = new Set();

        // Find all text that contains "Trial declined"
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        let node;
        while (node = walker.nextNode()) {
            if (node.textContent.includes('Trial declined')) {
                // Found a trial declined element - find the parent container
                let container = node.parentElement;
                for (let i = 0; i < 15; i++) {
                    if (!container) break;
                    container = container.parentElement;

                    // Look for member name
                    const nameEl = container.querySelector('a[href*="/u/"]');
                    if (nameEl) {
                        const name = nameEl.textContent?.trim();
                        if (name && !processedMembers.has(name)) {
                            processedMembers.add(name);

                            // Extract days remaining
                            const trialText = node.textContent;
                            const parentText = node.parentElement?.textContent || '';
                            const fullText = trialText + ' ' + parentText;
                            const daysMatch = fullText.match(/removing in (\d+) days?/i);
                            const daysRemaining = daysMatch ? parseInt(daysMatch[1]) : null;

                            // Get username from href
                            const href = nameEl.getAttribute('href');
                            const username = href ? href.split('/u/')[1] : null;

                            // Try to find price tier in container
                            const containerText = container.textContent || '';
                            const priceMatch = containerText.match(/\$(\d+)\/(month|year)/i);
                            const price = priceMatch ? `$${priceMatch[1]}/${priceMatch[2]}` : null;

                            // Try to find join date
                            const joinMatch = containerText.match(/Joined\s+([A-Za-z]+\s+\d+,?\s*\d*)/i);
                            const joinDate = joinMatch ? joinMatch[1] : null;

                            // Try to find last active
                            const activeMatch = containerText.match(/Active\s+(\d+[hmd]\s*ago|\d+\s+days?\s+ago)/i);
                            const lastActive = activeMatch ? activeMatch[1] : null;

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

                            break;
                        }
                    }
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
