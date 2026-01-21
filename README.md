# Skool Trial Declined Scraper

Apify actor that scrapes your Skool community's admin member view to find members who **declined their trial**. This lets you reach out before they're automatically removed.

## What It Does

1. Logs into Skool with your admin credentials
2. Navigates to your community's member list
3. Finds all members with "Trial declined" status
4. Extracts: name, username, days remaining, price tier, join date, last active
5. Outputs to Apify dataset (downloadable as CSV/JSON)

## Output Format

```json
{
  "name": "John Doe",
  "username": "john-doe-1234",
  "status": "Trial declined",
  "daysRemaining": 3,
  "price": "$49/month",
  "joinDate": "Jan 15, 2026",
  "lastActive": "2h ago",
  "scrapedAt": "2026-01-21T10:30:00Z"
}
```

## Deployment to Apify

### Option 1: Using Apify CLI (Recommended)

1. Install Apify CLI:
   ```bash
   npm install -g apify-cli
   ```

2. Login to Apify:
   ```bash
   apify login
   ```

3. Deploy the actor:
   ```bash
   cd tools/skool-trial-scraper
   apify push
   ```

### Option 2: Using GitHub Integration

1. Push this folder to a GitHub repo
2. In Apify Console, create new Actor
3. Set source to Git repository
4. Point to this folder's path

## Scheduling

After deployment:

1. Go to your Actor in Apify Console
2. Click **Schedules** tab
3. Click **Create new schedule**
4. Set frequency (e.g., daily at 9am)
5. Configure input with your credentials
6. Save

## Input Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `email` | Yes | Your Skool admin email |
| `password` | Yes | Your Skool password |
| `communityUrl` | Yes | Full URL to your community |

## Security Notes

- Credentials are encrypted in Apify
- Use Apify's secret input feature for password
- Consider using a dedicated admin account

## Troubleshooting

**Login fails:**
- Verify credentials work on skool.com manually
- Check if 2FA is enabled (not supported)

**No members found:**
- Ensure you have admin access
- Check the error screenshot in key-value store

**Selector errors:**
- Skool may have updated their UI
- Contact developer for updates
