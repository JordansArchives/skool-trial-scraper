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

    // Step 5: Scrape members with "Trial declined" status
    console.log('Scanning for trial-declined members...');

    // First, let's get debug info about what's on the page
    const debugInfo = await page.evaluate(() => {
        const pageText = document.body.innerText;
        const hasDeclined = pageText.toLowerCase().includes('declined');
        const declinedMatches = pageText.match(/declined/gi) || [];

        // Find a snippet around "declined" text
        const declinedIndex = pageText.toLowerCase().indexOf('declined');
        const snippet = declinedIndex >= 0
            ? pageText.substring(Math.max(0, declinedIndex - 100), declinedIndex + 100)
            : 'not found';

        // Count profile links
        const profileLinks = document.querySelectorAll('a[href*="/u/"]');

        return {
            hasDeclined,
            declinedCount: declinedMatches.length,
            snippet,
            profileLinksCount: profileLinks.length,
            pageTextLength: pageText.length
        };
    });

    console.log('Debug info:');
    console.log(`  - Page contains "declined": ${debugInfo.hasDeclined}`);
    console.log(`  - Number of "declined" matches: ${debugInfo.declinedCount}`);
    console.log(`  - Profile links found: ${debugInfo.profileLinksCount}`);
    console.log(`  - Page text length: ${debugInfo.pageTextLength}`);
    if (debugInfo.hasDeclined) {
        console.log(`  - Text snippet around "declined": ${debugInfo.snippet}`);
    }

    const trialDeclinedMembers = await page.evaluate(() => {
        const members = [];
        const processedUsernames = new Set();
        const debugLog = [];

        // Get all text content
        const pageText = document.body.innerText;

        // Try multiple link selectors
        const linkSelectors = [
            'a[href*="/u/"]',           // Original
            'a[href*="members"]',        // Members links
            'a[data-testid]',            // Test IDs
            'a[href*="@"]',              // Username links
        ];

        let allLinks = [];
        for (const selector of linkSelectors) {
            const links = document.querySelectorAll(selector);
            debugLog.push(`Selector "${selector}": ${links.length} links`);
            allLinks.push(...links);
        }

        // Also try finding all links and filtering
        const allPageLinks = document.querySelectorAll('a');
        debugLog.push(`Total links on page: ${allPageLinks.length}`);

        // Extract from text content using regex since links aren't working
        // Look for pattern: name followed by @username
        const usernamePattern = /@([a-z0-9-]+)/gi;
        const usernameMatches = pageText.match(usernamePattern) || [];
        debugLog.push(`Found ${usernameMatches.length} @username patterns`);

        // Find all occurrences of "Trial declined" and look BACKWARD to find the member
        // The page structure is: Name, @username, info, then "Trial declined"
        // So we need to find Trial declined and look at the text BEFORE it

        const declinedRegex = /Trial declined \(removing in (\d+) days?\)/gi;
        let match;
        let lastIndex = 0;

        while ((match = declinedRegex.exec(pageText)) !== null) {
            const declinedIndex = match.index;
            const daysRemaining = parseInt(match[1]);

            // Get text BEFORE this "Trial declined" (look back ~500 chars for member info)
            const textBefore = pageText.substring(Math.max(0, declinedIndex - 800), declinedIndex);

            debugLog.push(`Found "Trial declined" at index ${declinedIndex}, looking back...`);

            // Find the LAST @username in the text before (that's the member who declined)
            const usernameMatches = [...textBefore.matchAll(/@([a-z0-9-]+)/gi)];
            if (usernameMatches.length === 0) {
                debugLog.push('No username found before Trial declined');
                continue;
            }

            // Get the last username match (closest to "Trial declined")
            const lastUsernameMatch = usernameMatches[usernameMatches.length - 1];
            const username = lastUsernameMatch[1];

            if (processedUsernames.has(username)) continue;
            processedUsernames.add(username);

            // Get text between this username and "Trial declined" for extracting other info
            const usernameIndex = textBefore.lastIndexOf('@' + username);
            const memberSection = textBefore.substring(usernameIndex) + match[0];

            // Also get text before the username for the name
            const textBeforeUsername = textBefore.substring(0, usernameIndex);
            const linesBeforeUsername = textBeforeUsername.split('\n').filter(l => l.trim());

            // Find the name - it's usually the line right before @username
            let name = null;
            for (let i = linesBeforeUsername.length - 1; i >= 0; i--) {
                const line = linesBeforeUsername[i].trim();
                // Skip common labels, status text, and short strings
                if (/^(Active|Joined|CHAT|ME|MESSAGE|\d+|Invited by|Admin|Moderator|\$|Trial|Removed|Member)/i.test(line)) continue;
                // Skip lines that look like trial status
                if (/trial\s*\(|ends in|removing in/i.test(line)) continue;
                // Skip URLs
                if (/^https?:\/\//i.test(line)) continue;
                // Name should be capitalized words, reasonable length
                if (line.length > 2 && line.length < 60 && /^[A-Z][a-z]/.test(line)) {
                    name = line;
                    break;
                }
            }

            // Price - look in the member section
            const priceMatch = memberSection.match(/\$(\d+)\/(month|year)/i);
            const price = priceMatch ? `$${priceMatch[1]}/${priceMatch[2]}` : null;

            // Join date
            const joinMatch = memberSection.match(/Joined\s+([A-Za-z]+\s+\d+,?\s*\d*)/i);
            const joinDate = joinMatch ? joinMatch[1] : null;

            // Last active - also check text before username
            const fullSection = textBeforeUsername.slice(-200) + memberSection;
            const activeMatch = fullSection.match(/Active\s+(\d+[hmd]\s*ago|\d+\s*(?:days?|hours?|minutes?)\s*ago)/i);
            const lastActive = activeMatch ? activeMatch[1] : null;

            debugLog.push(`Extracted: ${name} (@${username}), ${daysRemaining} days, ${price}, joined ${joinDate}`);

            members.push({
                name: name || 'Unknown',
                username,
                status: 'Trial declined',
                daysRemaining,
                price,
                joinDate,
                lastActive,
                scrapedAt: new Date().toISOString()
            });
        }

        return { members, debugLog };
    });

    // Log the debug info from the browser
    console.log('Browser debug log:');
    trialDeclinedMembers.debugLog.forEach(log => console.log(`  - ${log}`));

    const members = trialDeclinedMembers.members;

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
