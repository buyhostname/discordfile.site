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

## Step 5: Stripe Webhook Setup

After receiving the Stripe secret key, set up the webhook automatically using the Stripe CLI.

**Install Stripe CLI (if not installed):**
```bash
curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" | sudo tee /etc/apt/sources.list.d/stripe.list > /dev/null
sudo apt update && sudo apt install -y stripe
```

**Create the webhook using the domain from Step 3:**
```bash
stripe webhook_endpoints create \
  --api-key "{STRIPE_SECRET_KEY}" \
  --url "https://{domain}/webhook/stripe" \
  --enabled-events checkout.session.completed
```

**Save the webhook secret** from the response (the `secret` field starting with `whsec_`) to `.env`:
```env
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
```

---

## Step 6: Email Setup (Resend)

**Ask the user:**

> For sending login emails, I need a Resend API key.
>
> **Option 1: On hoston.ai**
> Go to Domains > DNS > Email to get your API key and configure email automatically.
>
> **Option 2: Manual setup**
> 1. Go to https://resend.com and create an account
> 2. Add and verify your domain at https://resend.com/domains
> 3. Create an API key at https://resend.com/api-keys
>
> Please provide:
> - **API Key** (starts with `re_`)
> - **From Email** (e.g., `Discord File <noreply@yourdomain.com>`)

**Note:** Setting up email on hoston.ai will automatically make the Resend API key work for sending emails, as long as the domain is entered in `.env`.

**If user skips this step:**

Email sending will be disabled. Login links will only be logged to the console for debugging.

---

## Step 7: Session Secret

**Generate automatically or ask:**

> I'll generate a secure session secret for you, or you can provide your own.
>
> Generated secret: `{random 64-char hex string}`
>
> Would you like to use this or provide your own?

---

## Step 8: Database Setup

**Ask the user:**

> Which database would you like to use?
>
> 1. **SQLite** (default, simple, no setup required)
> 2. **MySQL** (recommended for production)

**If SQLite (default):**

The default configuration uses SQLite. No additional setup needed:
```env
DATABASE_URL="file:./dev.db"
```

**If MySQL:**

> Please provide your MySQL connection details:
> - Host (e.g., `localhost` or `db.example.com`)
> - Port (default: `3306`)
> - Database name
> - Username
> - Password

Then update the Prisma schema and `.env`:

1. Update `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```

2. Set the DATABASE_URL in `.env`:
```env
DATABASE_URL="mysql://username:password@host:port/database"
```

**Creating a MySQL database (if needed):**

```bash
# Connect to MySQL as root
mysql -u root -p

# Create database and user
CREATE DATABASE discordfile;
CREATE USER 'discordfile'@'localhost' IDENTIFIED BY 'your_secure_password';
GRANT ALL PRIVILEGES ON discordfile.* TO 'discordfile'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

---

## Step 9: Write Configuration

Once all values are collected, update the `.env` file:

```env
PORT=3000
PRODUCTION=true

DISCORD_CLIENT_ID={collected_client_id}
DISCORD_CLIENT_SECRET={collected_client_secret}
DISCORD_REDIRECT_URI=https://{domain}/auth/discord/callback
DISCORD_BOT_TOKEN={collected_bot_token}

SESSION_SECRET={generated_or_provided_secret}

# SQLite (default)
DATABASE_URL="file:./dev.db"

# Or MySQL
# DATABASE_URL="mysql://username:password@localhost:3306/discordfile"

STRIPE_PUBLISHABLE_KEY={collected_publishable_key}
STRIPE_SECRET_KEY={collected_secret_key}
STRIPE_WEBHOOK_SECRET={webhook_secret_from_step_5}

# Email (optional - if not set, login links are logged to console)
RESEND_API_KEY={resend_api_key}
EMAIL_FROM=Discord File <noreply@{domain}>
```

---

## Step 10: Install Dependencies & Initialize Database

Run:
```bash
npm install
npx prisma generate
npx prisma db push
```

---

## Step 11: Start the Application

**Using PM2 (recommended for production):**
```bash
pm2 start npm --name "main-3000" -- start
pm2 save
```

**Or restart if already configured:**
```bash
pm2 restart main-3000 --update-env
```

**For development:**
```bash
npm start
```

---

## Step 12: Verify Setup

**Tell the user:**

> Setup complete! Here's what to verify:
>
> 1. Visit https://{domain} - you should see the homepage
> 2. Click "Login with Discord" - should redirect to Discord OAuth
> 3. After login, DM an image to the bot - should react with a lock icon
> 4. Post an image in a server channel - should react with a checkmark
> 5. Visit your profile to see the images
>
> The bot invite link will be auto-generated and saved to `.env` on first startup.

### Bot not responding to messages
- Ensure "Message Content Intent" is enabled in Discord Bot settings
- Check PM2 logs: `pm2 logs main-3000`

### OAuth redirect error
- Verify the redirect URI matches exactly in Discord settings
- Check that the domain has HTTPS configured

### Stripe payments not working
- Ensure you're using the correct key type (test vs live)
- Verify the webhook was created: `stripe webhook_endpoints list --api-key "$STRIPE_SECRET_KEY"`
- Check that `STRIPE_WEBHOOK_SECRET` is set in `.env`
- Test webhook manually: Check PM2 logs for "Webhook received" messages after a payment

### Database connection errors
- **SQLite**: Ensure the app has write permissions to the directory
- **MySQL**: Verify credentials and that the MySQL server is running
  ```bash
  # Test MySQL connection
  mysql -u username -p -h host database
  ```
- Run `npx prisma db push` after any schema changes

### Prisma errors after changing database provider
If switching between SQLite and MySQL:
```bash
rm -rf node_modules/.prisma
npx prisma generate
npx prisma db push
```

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
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | Created via Stripe CLI |
| `SESSION_SECRET` | Session encryption key | Generate with `openssl rand -hex 32` |
| `DATABASE_URL` | Database connection string | See database setup section |
| `PORT` | Server port | Default: `3000` |
| `PRODUCTION` | Enable production mode | Set to `true` for production |

## Database URL Formats

| Database | Format |
|----------|--------|
| SQLite | `file:./dev.db` |
| MySQL | `mysql://USER:PASSWORD@HOST:PORT/DATABASE` |
| PostgreSQL | `postgresql://USER:PASSWORD@HOST:PORT/DATABASE` |
