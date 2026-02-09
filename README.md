# Discord File

A Discord-based image hosting platform where creators upload images via a Discord bot and viewers pay to unlock private content.

## Features

- **Discord Bot Integration**: Upload images by sending them to the bot (DM = private, channel = public)
- **Stripe Payments**: One-time payment to unlock a creator's private content
- **Dual Auth System**: Creators login with Discord, viewers login with email (after purchase)

## Quick Setup

[![Deploy on Hoston](https://hoston.ai/badge.svg)](https://hoston.ai/deploy?repo=discord-file)

Or follow the [setup guide](./AGENTS.md) for manual installation.

## How It Works

1. **Creators** sign up with Discord OAuth
2. **Upload images** by sending them to the Discord bot
   - DM to bot = private image
   - Post in channel = public image
   - Start message with "private" = private image
3. **Viewers** browse public profiles
4. **Pay** via Stripe to unlock private content
5. **Return** anytime using email login

## Environment Variables

See [.env.example](./.env.example) for required configuration.
