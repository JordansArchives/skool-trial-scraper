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
    const maxScrollAttempts = 20; // Increased from 10
    let sameHeightCount = 0;

    while (scrollAttempts < maxScrollAttempts) {
        const currentHeight = await page.evaluate(() => document.body.scrollHeight);
        if (currentHeight === previousHeight) {
            sameHeightCount++;
            if (sameHeightCount >= 3) {
                console.log('  No new content after 3 attempts, stopping scroll');
                break; // No more content to load after 3 tries
            }
        } else {
            sameHeightCount = 0;
        }
        previousHeight = currentHeight;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2500); // Slightly longer wait
        scrollAttempts++;

        // Count members loaded so far
        const memberCount = await page.evaluate(() => document.querySelectorAll('a[href*="/u/"]').length);
        console.log(`  Scroll ${scrollAttempts}/${maxScrollAttempts}... (${memberCount} profile links loaded)`);
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // Step 5: Find members with "Trial declined" status and click their MEMBERSHIP button
    console.log('Scanning for trial-declined members...');

    // Find all MEMBERSHIP buttons that are near "Trial declined" text
    // Strategy: Find rows containing "Trial declined", then find MEMBERSHIP button in that row
    const declinedMemberButtons = await page.evaluate(() => {
        const buttons = [];

        // Find all elements containing "Trial declined"
        const allElements = [...document.querySelectorAll('*')];
        const declinedElements = allElements.filter(el => {
            const text = el.textContent || '';
            return text.includes('Trial declined') && !el.querySelector('[class*="Trial declined"]');
        });

        // For each declined element, find the nearest MEMBERSHIP button
        for (const el of declinedElements) {
            // Look for specific text node to avoid duplicates
            const hasDirectText = [...el.childNodes].some(
                n => n.nodeType === Node.TEXT_NODE && n.textContent.includes('Trial declined')
            );
            if (!hasDirectText) continue;

            // Traverse up to find the member row container
            let container = el;
            for (let i = 0; i < 15; i++) {
                if (!container.parentElement) break;
                container = container.parentElement;

                // Look for MEMBERSHIP button in this container
                const membershipBtns = container.querySelectorAll('button, [role="button"]');
                for (const btn of membershipBtns) {
                    if (btn.textContent.includes('MEMBERSHIP')) {
                        // Found it! Get some identifying info
                        const containerText = container.textContent;
                        const usernameMatch = containerText.match(/@([a-z0-9-]+)/i);
                        buttons.push({
                            username: usernameMatch ? usernameMatch[1] : null,
                            buttonIndex: [...document.querySelectorAll('button, [role="button"]')].indexOf(btn)
                        });
                        break;
                    }
                }
                if (buttons.length > 0 && buttons[buttons.length - 1].username) break;
            }
        }

        // Dedupe by username
        const seen = new Set();
        return buttons.filter(b => {
            if (!b.username || seen.has(b.username)) return false;
            seen.add(b.username);
            return true;
        });
    });

    console.log(`Found ${declinedMemberButtons.length} trial-declined members with MEMBERSHIP buttons`);

    const members = [];

    // For each declined member, click their MEMBERSHIP button and extract data
    for (let i = 0; i < declinedMemberButtons.length; i++) {
        const { username, buttonIndex } = declinedMemberButtons[i];
        console.log(`\nProcessing member ${i + 1}/${declinedMemberButtons.length}: @${username}`);

        try {
            // Find and click the MEMBERSHIP button
            const allButtons = await page.$$('button, [role="button"]');
            if (buttonIndex >= allButtons.length) {
                console.log('  Button index out of range, skipping');
                continue;
            }

            const membershipBtn = allButtons[buttonIndex];
            await membershipBtn.click();
            console.log('  Clicked MEMBERSHIP button');

            // Wait for modal to appear
            await page.waitForTimeout(1500);

            // Take screenshot of modal for debugging
            if (i === 0) {
                const modalScreenshot = await page.screenshot();
                await Actor.setValue('debug-membership-modal', modalScreenshot, { contentType: 'image/png' });
            }

            // Extract data from the modal
            const memberData = await page.evaluate(() => {
                const modalText = document.body.innerText;

                // Extract email
                const emailMatch = modalText.match(/Email:\s*([^\s\n]+@[^\s\n]+)/i);
                const email = emailMatch ? emailMatch[1] : null;

                // Extract name from modal header (usually at top)
                // Look for "Membership settings" text and get name above it
                const nameMatch = modalText.match(/^([A-Z][a-zA-Z\s]+)\nMembership settings/m);
                const name = nameMatch ? nameMatch[1].trim() : null;

                // Extract role
                const roleMatch = modalText.match(/Role:\s*(\w+)/i);
                const role = roleMatch ? roleMatch[1] : null;

                // Extract tier
                const tierMatch = modalText.match(/Tier:\s*(\w+)/i);
                const tier = tierMatch ? tierMatch[1] : null;

                // Extract price
                const priceMatch = modalText.match(/\$(\d+)\/(month|year)/i);
                const price = priceMatch ? `$${priceMatch[1]}/${priceMatch[2]}` : null;

                // Extract trial status and days remaining
                const trialMatch = modalText.match(/Trial declined \(removing in (\d+) days?\)/i);
                const daysRemaining = trialMatch ? parseInt(trialMatch[1]) : null;

                // Extract join date
                const joinMatch = modalText.match(/Joined\s+([A-Za-z]+\s+\d+,?\s*\d*)/i);
                const joinDate = joinMatch ? joinMatch[1] : null;

                // Extract LTV
                const ltvMatch = modalText.match(/\$(\d+)\s*lifetime value/i);
                const ltv = ltvMatch ? `$${ltvMatch[1]}` : null;

                // Extract invited by
                const invitedMatch = modalText.match(/Invited by\s+([A-Za-z\s]+)/i);
                const invitedBy = invitedMatch ? invitedMatch[1].trim() : null;

                return { email, name, role, tier, price, daysRemaining, joinDate, ltv, invitedBy };
            });

            console.log(`  Name: ${memberData.name}`);
            console.log(`  Email: ${memberData.email}`);
            console.log(`  Days remaining: ${memberData.daysRemaining}`);
            console.log(`  Price: ${memberData.price}`);

            members.push({
                name: memberData.name || 'Unknown',
                username,
                email: memberData.email,
                role: memberData.role,
                tier: memberData.tier,
                status: 'Trial declined',
                daysRemaining: memberData.daysRemaining,
                price: memberData.price,
                joinDate: memberData.joinDate,
                ltv: memberData.ltv,
                invitedBy: memberData.invitedBy,
                scrapedAt: new Date().toISOString()
            });

            // Close the modal by pressing Escape
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);

        } catch (err) {
            console.log(`  Error processing member: ${err.message}`);
        }
    }

    console.log(`Found ${members.length} members who declined their trial`);

    if (members.length > 0) {
        console.log('\nTrial-declined members:');
        console.log('------------------------');
        members.forEach(m => {
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
    if (members.length > 0) {
        await Actor.pushData(members);
    }

    // Also save a summary to key-value store
    await Actor.setValue('summary', {
        community: communityName,
        scrapedAt: new Date().toISOString(),
        totalFound: members.length,
        members: members
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
