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

    // Debug: Check what's on the page - look at HTML structure
    const pageDebug = await page.evaluate(() => {
        const pageText = document.body.innerText;
        const pageHTML = document.body.innerHTML;
        const hasDeclined = pageText.includes('Trial declined');

        // Look for MEMBERSHIP in different ways
        const hasMembershipText = pageText.toUpperCase().includes('MEMBERSHIP');
        const hasMembershipHTML = pageHTML.toUpperCase().includes('MEMBERSHIP');

        // Find all clickable elements (buttons, links, divs with click handlers)
        const clickables = document.querySelectorAll('button, a, [role="button"], [onclick], [class*="btn"], [class*="button"]');

        // Sample of clickable elements' HTML
        const clickableSamples = [...clickables].slice(0, 30).map(el => ({
            tag: el.tagName,
            text: el.textContent.trim().substring(0, 40),
            classes: el.className.substring(0, 50)
        }));

        // Find Trial declined elements and their nearby structure
        const declinedInfo = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
            if (node.textContent.includes('Trial declined')) {
                // Get parent structure
                let parent = node.parentElement;
                let structure = [];
                for (let i = 0; i < 5 && parent; i++) {
                    structure.push(parent.tagName + (parent.className ? '.' + parent.className.split(' ')[0] : ''));
                    parent = parent.parentElement;
                }
                declinedInfo.push({
                    text: node.textContent.substring(0, 50),
                    structure: structure.join(' > ')
                });
            }
        }

        return {
            hasDeclined,
            hasMembershipText,
            hasMembershipHTML,
            totalClickables: clickables.length,
            clickableSamples,
            declinedInfo
        };
    });

    console.log('Page debug info:');
    console.log(`  - Has "Trial declined" in text: ${pageDebug.hasDeclined}`);
    console.log(`  - Has "MEMBERSHIP" in text: ${pageDebug.hasMembershipText}`);
    console.log(`  - Has "MEMBERSHIP" in HTML: ${pageDebug.hasMembershipHTML}`);
    console.log(`  - Total clickable elements: ${pageDebug.totalClickables}`);
    console.log(`  - Declined elements found: ${pageDebug.declinedInfo.length}`);
    pageDebug.declinedInfo.forEach((info, i) => {
        console.log(`    ${i + 1}. "${info.text}" - structure: ${info.structure}`);
    });

    // Find the member rows that contain "Trial declined" and extract their info
    const declinedMemberInfo = await page.evaluate(() => {
        const results = [];

        // Find all elements with class containing "MemberItemWrapper" - these are member rows
        const memberRows = document.querySelectorAll('[class*="MemberItem"], [class*="memberItem"]');
        console.log('Found ' + memberRows.length + ' member row elements');

        // If no member rows found by class, try finding by structure
        let rows = [...memberRows];
        if (rows.length === 0) {
            // Find elements that contain both a username (@) and either CHAT or MEMBERSHIP
            const allDivs = document.querySelectorAll('div');
            rows = [...allDivs].filter(div => {
                const text = div.textContent || '';
                return text.includes('@') &&
                       (text.includes('CHAT') || text.includes('MEMBERSHIP')) &&
                       text.includes('Joined') &&
                       text.length < 3000;
            });
        }

        console.log('Checking ' + rows.length + ' potential member rows');

        for (const row of rows) {
            const rowText = row.textContent || '';

            // Check if this row has "Trial declined"
            if (!rowText.includes('Trial declined')) continue;

            // Extract username from this row - stop at first non-username char
            // Username format: @lowercase-letters-numbers-with-dashes
            const usernameMatch = rowText.match(/@([a-z0-9-]+)(?=[^a-z0-9-]|$)/i);
            if (!usernameMatch) continue;

            const username = usernameMatch[1].toLowerCase();

            // Extract name - usually the first significant text in the row
            // Look for text that looks like a name (capitalized, 2-50 chars)
            const lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
            let name = null;
            for (const line of lines) {
                // Skip common non-name text
                if (/^(Active|Joined|CHAT|MEMBERSHIP|Trial|@|Online|\$|\d+)/i.test(line)) continue;
                if (line.length > 2 && line.length < 50 && /^[A-Z]/.test(line)) {
                    name = line;
                    break;
                }
            }

            // Get days remaining
            const daysMatch = rowText.match(/removing in (\d+) days?/i);
            const daysRemaining = daysMatch ? parseInt(daysMatch[1]) : null;

            results.push({ username, name, daysRemaining, rowIndex: rows.indexOf(row) });
        }

        // Deduplicate by username
        const seen = new Set();
        const unique = results.filter(r => {
            if (seen.has(r.username)) return false;
            seen.add(r.username);
            return true;
        });

        return unique;
    });

    console.log(`\nFound ${declinedMemberInfo.length} declined members:`);
    declinedMemberInfo.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.name} (@${m.username}) - ${m.daysRemaining} days remaining`);
    });

    const memberButtonsList = declinedMemberInfo;

    console.log(`Found ${memberButtonsList.length} trial-declined members with MEMBERSHIP buttons`);

    const members = [];

    // For each declined member, click their MEMBERSHIP button and extract data
    for (let i = 0; i < memberButtonsList.length; i++) {
        const { username, name: previewName, daysRemaining: previewDays } = memberButtonsList[i];
        console.log(`\nProcessing member ${i + 1}/${memberButtonsList.length}: ${previewName} (@${username})`);

        try {
            // Strategy 1: Use Playwright's getByText to find MEMBERSHIP near this user
            // First scroll the user into view
            await page.evaluate((uname) => {
                const els = [...document.querySelectorAll('*')];
                for (const el of els) {
                    if (el.textContent.includes('@' + uname) && el.textContent.length < 500) {
                        el.scrollIntoView({ behavior: 'instant', block: 'center' });
                        break;
                    }
                }
            }, username);
            await page.waitForTimeout(500);

            // Try multiple approaches to find and click MEMBERSHIP button
            let clicked = false;

            // Approach 1: Find the specific member row, then click its MEMBERSHIP button
            try {
                clicked = await page.evaluate((uname) => {
                    // Find the member row containing this username AND "Trial declined"
                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        const text = div.textContent || '';
                        // Must contain: username, Trial declined, MEMBERSHIP
                        if (text.includes('@' + uname) &&
                            text.includes('Trial declined') &&
                            text.length < 3000) {

                            // Find MEMBERSHIP button within this div
                            const buttons = div.querySelectorAll('button');
                            for (const btn of buttons) {
                                if (btn.textContent.toUpperCase().includes('MEMBERSHIP')) {
                                    // Scroll into view and click
                                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                                    btn.click();
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                }, username);

                if (clicked) console.log('  Clicked via row-specific search');
            } catch (e) {
                console.log(`  Row search error: ${e.message}`);
            }

            // Approach 2: Find button with ButtonWrapper class containing MEMBERSHIP
            if (!clicked) {
                try {
                    clicked = await page.evaluate((uname) => {
                        // First find all buttons with ButtonWrapper class (Skool's button style)
                        const allButtons = document.querySelectorAll('button[class*="ButtonWrapper"], button[class*="buttonWrapper"]');
                        console.log('Found ' + allButtons.length + ' ButtonWrapper buttons');

                        for (const btn of allButtons) {
                            const btnText = btn.textContent.toUpperCase();
                            if (btnText.includes('MEMBERSHIP')) {
                                // Check if this button is in a row with our username
                                let parent = btn.parentElement;
                                for (let i = 0; i < 15 && parent; i++) {
                                    if (parent.textContent.includes('@' + uname)) {
                                        btn.click();
                                        return true;
                                    }
                                    parent = parent.parentElement;
                                }
                            }
                        }

                        // Fallback: Find any button with MEMBERSHIP text near our user
                        const allBtns = document.querySelectorAll('button');
                        for (const btn of allBtns) {
                            if (btn.textContent.toUpperCase().includes('MEMBERSHIP')) {
                                let parent = btn.parentElement;
                                for (let i = 0; i < 15 && parent; i++) {
                                    if (parent.textContent.includes('@' + uname)) {
                                        btn.click();
                                        return true;
                                    }
                                    parent = parent.parentElement;
                                }
                            }
                        }

                        return false;
                    }, username);

                    if (clicked) console.log('  Clicked via ButtonWrapper/button search');
                } catch (e) {
                    console.log(`  Button search error: ${e.message}`);
                }
            }

            // Approach 3: Use keyboard navigation - focus on the row and tab to MEMBERSHIP
            if (!clicked) {
                console.log('  Could not find MEMBERSHIP button with standard approaches');
                console.log('  Trying text-based click...');

                // Try clicking any element containing MEMBERSHIP text near this user
                try {
                    await page.evaluate((uname) => {
                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                        let node;
                        while (node = walker.nextNode()) {
                            if (node.textContent.toUpperCase().includes('MEMBERSHIP')) {
                                // Check if this is near our user
                                let parent = node.parentElement;
                                for (let i = 0; i < 15 && parent; i++) {
                                    if (parent.textContent.includes('@' + uname)) {
                                        // Click the immediate parent of the text node
                                        node.parentElement.click();
                                        return true;
                                    }
                                    parent = parent.parentElement;
                                }
                            }
                        }
                        return false;
                    }, username);
                    clicked = true;
                    console.log('  Clicked via text walker');
                } catch (e) {
                    console.log(`  Text walker error: ${e.message}`);
                }
            }

            if (!clicked) {
                console.log('  All approaches failed, skipping this member');
                continue;
            }
            console.log('  Clicked MEMBERSHIP button');

            // Wait for modal to appear
            await page.waitForTimeout(1500);

            // Take screenshot of modal for debugging
            if (i === 0) {
                const modalScreenshot = await page.screenshot();
                await Actor.setValue('debug-membership-modal', modalScreenshot, { contentType: 'image/png' });
            }

            // Extract data from the modal
            // The modal should be a popup/overlay - look for it specifically
            const memberData = await page.evaluate(() => {
                // Find the modal - usually has a specific class or is a dialog
                // Look for elements that appeared recently and contain "Email:" and "Membership"
                const possibleModals = document.querySelectorAll('[class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [class*="popup"], [class*="Popup"], [role="dialog"]');

                let modalText = '';
                let modalElement = null;

                // If we found modal elements, use the one with membership content
                for (const modal of possibleModals) {
                    const text = modal.textContent || '';
                    if (text.includes('Email:') && text.includes('Membership')) {
                        modalText = text;
                        modalElement = modal;
                        break;
                    }
                }

                // Fallback: look for any element containing "Email:" and membership-related text
                if (!modalText) {
                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        const text = div.textContent || '';
                        if (text.includes('Email:') &&
                            text.includes('Membership') &&
                            text.includes('Role:') &&
                            text.length < 2000) {
                            modalText = text;
                            modalElement = div;
                            break;
                        }
                    }
                }

                if (!modalText) {
                    return { error: 'Could not find modal' };
                }

                // Extract email - format is "Email: email@domain.com"
                // Stop at first non-email character (letter after TLD, colon, etc)
                const emailMatch = modalText.match(/Email:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
                const email = emailMatch ? emailMatch[1] : null;

                // Extract name - it's at the top of the modal, before "Membership settings"
                // The modal structure is: Name\nMembership settings\n...
                const lines = modalText.split('\n').map(l => l.trim()).filter(l => l);
                let name = null;

                // Look for the pattern: Name followed by "Membership settings"
                for (let i = 0; i < lines.length - 1; i++) {
                    if (lines[i + 1] === 'Membership settings' || lines[i + 1].includes('Membership settings')) {
                        const candidate = lines[i];
                        // Validate it looks like a name (not a label or button text)
                        if (candidate.length > 2 &&
                            candidate.length < 60 &&
                            !candidate.includes(':') &&
                            !candidate.includes('CHAT') &&
                            !candidate.includes('MEMBERSHIP') &&
                            /^[A-ZÀ-ÿ]/.test(candidate)) {
                            name = candidate;
                            break;
                        }
                    }
                }

                // Fallback: look for a name pattern (First Last) near the top
                if (!name) {
                    for (let i = 0; i < Math.min(10, lines.length); i++) {
                        const line = lines[i];
                        // Match "First Last" or "First Middle Last" pattern
                        if (/^[A-ZÀ-ÿ][a-zà-ÿ]+\s+[A-ZÀ-ÿ][a-zà-ÿ]+/.test(line) &&
                            !line.includes(':') &&
                            line.length < 50) {
                            name = line;
                            break;
                        }
                    }
                }

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

                return { email, name, role, tier, price, daysRemaining, joinDate, ltv, invitedBy, modalFound: true };
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
