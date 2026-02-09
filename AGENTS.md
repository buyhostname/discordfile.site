# Discord File - Setup Guide for AI Agents

This guide walks through the interactive setup process for Discord File. Follow each step and wait for user responses where indicated.

## Prerequisites

Before starting, ensure the user has:
- A Discord account
- A Stripe account (for payments)
- A domain pointed to this server

---

## Step 1: Discord Application Setup

**Ask the user:**

> To set up Discord login and the bot, I need you to create a Discord application.
>
> 1. Go to https://discord.com/developers/applications
> 2. Click "New Application" and give it a name (e.g., "Discord File")
> 3. Once created, go to the **OAuth2** tab
>
> Please provide:
> - **Client ID** (found under OAuth2 > General)
> - **Client Secret** (click "Reset Secret" if needed)

**Wait for response with Client ID and Client Secret.**

---

## Step 2: Discord Bot Token

**Ask the user:**

> Now I need the bot token:
>
> 1. In your Discord application, go to the **Bot** tab
> 2. Click "Add Bot" if you haven't already
> 3. Under "Privileged Gateway Intents", enable **Message Content Intent**
> 4. Click "Reset Token" to generate a new token
>
> Please provide the **Bot Token**.

**Wait for response with Bot Token.**

---

## Step 3: OAuth Redirect URI

**Ask the user:**

> What is your domain? I'll configure the OAuth redirect URI.
>
> For example: `discordfile.site` or `mysite.com`

**Wait for response with domain.**

**Then instruct:**

> Please add this redirect URI in Discord (OAuth2 > Redirects):
> ```
> https://{domain}/auth/discord/callback
> ```

---

## Step 4: Stripe API Keys

**Ask the user:**

> For payment processing, I need your Stripe API keys.
>
> 1. Go to https://dashboard.stripe.com/apikeys
> 2. Use **test keys** for development or **live keys** for production
>
> Please provide:
> - **Publishable key** (starts with `pk_`)
> - **Secret key** (starts with `sk_`)

**Wait for response with both Stripe keys.**

---

## Step 5: Session Secret

**Generate automatically or ask:**

> I'll generate a secure session secret for you, or you can provide your own.
>
> Generated secret: `{random 64-char hex string}`
>
> Would you like to use this or provide your own?

---

## Step 6: Write Configuration

Once all values are collected, update the `.env` file:

```env
PORT=3000
PRODUCTION=true

DISCORD_CLIENT_ID={collected_client_id}
DISCORD_CLIENT_SECRET={collected_client_secret}
DISCORD_REDIRECT_URI=https://{domain}/auth/discord/callback
DISCORD_BOT_TOKEN={collected_bot_token}

SESSION_SECRET={generated_or_provided_secret}

DATABASE_URL="file:./dev.db"

STRIPE_PUBLISHABLE_KEY={collected_publishable_key}
STRIPE_SECRET_KEY={collected_secret_key}
```

---

## Step 7: Initialize Database & Start

Run:
```bash
npx prisma db push
pm2 restart main-3000 --update-env
```

---

## Step 8: Verify Setup

**Tell the user:**

> Setup complete! Here's what to verify:
>
> 1. Visit https://{domain} - you should see the homepage
> 2. Click "Login with Discord" - should redirect to Discord OAuth
> 3. After login, DM an image to the bot - should react with a lock icon
> 4. Post an image in a server channel - should react with a checkmark
> 5. Visit your profile to see the images
>
> The bot invite link will be auto-generated and shown in the footer.

---

## Troubleshooting

### Bot not responding to messages
- Ensure "Message Content Intent" is enabled in Discord Bot settings
- Check PM2 logs: `pm2 logs main-3000`

### OAuth redirect error
- Verify the redirect URI matches exactly in Discord settings
- Check that the domain has HTTPS configured

### Stripe payments not working
- Ensure you're using the correct key type (test vs live)
- For production, set up the Stripe webhook at `/webhook/stripe`

---

## Environment Variables Reference

| Variable | Description | Where to get |
|----------|-------------|--------------|
| `DISCORD_CLIENT_ID` | OAuth client identifier | Discord Developer Portal > OAuth2 |
| `DISCORD_CLIENT_SECRET` | OAuth client secret | Discord Developer Portal > OAuth2 |
| `DISCORD_BOT_TOKEN` | Bot authentication token | Discord Developer Portal > Bot |
| `DISCORD_REDIRECT_URI` | OAuth callback URL | Set to `https://yourdomain/auth/discord/callback` |
| `STRIPE_PUBLISHABLE_KEY` | Public Stripe key | Stripe Dashboard > API keys |
| `STRIPE_SECRET_KEY` | Private Stripe key | Stripe Dashboard > API keys |
| `SESSION_SECRET` | Session encryption key | Generate with `openssl rand -hex 32` |
| `DATABASE_URL` | SQLite database path | Default: `file:./dev.db` |
