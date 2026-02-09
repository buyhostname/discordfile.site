require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { Client, GatewayIntentBits, Partials, OAuth2Scopes, PermissionFlagsBits } = require('discord.js');
const Stripe = require('stripe');
const { Resend } = require('resend');

const prisma = new PrismaClient();
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// JWT secret for magic links (use SESSION_SECRET as fallback)
const JWT_SECRET = process.env.SESSION_SECRET || 'change-me';

app.set('trust proxy', true);
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

// Stripe webhook needs raw body
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.PRODUCTION === 'true',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
}));

// Make user, viewer, and stripe key available to all templates
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.viewer = req.session.viewer || null;
    res.locals.stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    res.locals.botInviteLink = process.env.DISCORD_BOT_INVITE || null;
    next();
});

const PORT = process.env.PORT || 3000;

// Discord OAuth config
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

// Serve bridge.js dynamically
app.get('/bridge.js', (req, res) => {
    const host = req.hostname;
    const adminHost = host.startsWith('admin.') ? host : 'admin.' + host;
    
    res.type('application/javascript');
    res.send(`
(function() {
    const ADMIN_URL = 'wss://${adminHost}/bridge';
    
    let ws;
    let reconnectTimer;
    let clientId = null;
    
    const handlers = {
        navigate: async (action) => {
            const url = action.url;
            setTimeout(() => { window.location.href = url; }, 50);
            return { navigating: url };
        },
        
        fill: async (action) => {
            const el = document.querySelector(action.selector);
            if (!el) throw new Error('Element not found: ' + action.selector);
            el.value = action.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { filled: action.selector, value: action.value };
        },
        
        click: async (action) => {
            const el = document.querySelector(action.selector);
            if (!el) throw new Error('Element not found: ' + action.selector);
            el.click();
            return { clicked: action.selector };
        },
        
        type: async (action) => {
            const el = document.querySelector(action.selector);
            if (!el) throw new Error('Element not found: ' + action.selector);
            el.focus();
            for (const char of action.text) {
                el.value += char;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, action.delay || 20));
            }
            return { typed: action.text.length + ' chars' };
        },
        
        wait: async (action) => {
            if (action.selector) {
                const start = Date.now();
                const timeout = action.timeout || 10000;
                while (Date.now() - start < timeout) {
                    if (document.querySelector(action.selector)) {
                        return { found: action.selector };
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                throw new Error('Timeout waiting for: ' + action.selector);
            } else if (action.ms) {
                await new Promise(r => setTimeout(r, action.ms));
                return { waited: action.ms };
            }
        },
        
        eval: async (action) => {
            const result = await eval(action.code);
            if (result instanceof Element) return result.outerHTML;
            if (result instanceof NodeList || Array.isArray(result)) {
                return Array.from(result).map(el => el instanceof Element ? el.outerHTML : el);
            }
            return result;
        },
        
        get: async (action) => {
            const el = document.querySelector(action.selector);
            if (!el) throw new Error('Element not found: ' + action.selector);
            return {
                text: el.innerText,
                value: el.value,
                html: action.html ? el.innerHTML : undefined
            };
        }
    };
    
    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;
        
        try {
            ws = new WebSocket(ADMIN_URL);
            
            ws.onopen = () => {
                console.log('[bridge] connected to', ADMIN_URL);
                ws.send(JSON.stringify({ type: 'hello', url: location.href }));
            };
            
            ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    
                    if (msg.type === 'welcome') {
                        clientId = msg.clientId;
                        console.log('[bridge] assigned client ID:', clientId);
                        return;
                    }
                    
                    if (msg.type === 'task') {
                        let result, error;
                        try {
                            if (msg.action && handlers[msg.action.type]) {
                                result = await handlers[msg.action.type](msg.action);
                            } else if (msg.code) {
                                result = await eval(msg.code);
                                if (result instanceof Element) result = result.outerHTML;
                                if (result instanceof NodeList || Array.isArray(result)) {
                                    result = Array.from(result).map(el => el instanceof Element ? el.outerHTML : el);
                                }
                            }
                        } catch (e) {
                            error = e.message;
                        }
                        ws.send(JSON.stringify({ type: 'result', taskId: msg.taskId, result, error }));
                    }
                } catch (e) {
                    console.error('[bridge] message error:', e);
                }
            };
            
            ws.onclose = () => {
                console.log('[bridge] disconnected, reconnecting in 3s...');
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(connect, 3000);
            };
            
            ws.onerror = (e) => {
                console.error('[bridge] error:', e);
            };
        } catch (e) {
            console.error('[bridge] connection error:', e);
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 3000);
        }
    }
    
    connect();
})();
`);
});

// Discord OAuth routes
app.get('/auth/discord', (req, res) => {
    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        redirect_uri: DISCORD_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify email'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.redirect('/?error=no_code');
    }
    
    try {
        // Exchange code for token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: DISCORD_REDIRECT_URI
            })
        });
        
        const tokenData = await tokenRes.json();
        
        if (!tokenData.access_token) {
            console.error('Token error:', tokenData);
            return res.redirect('/?error=token_failed');
        }
        
        // Get user info
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`
            }
        });
        
        const discordUser = await userRes.json();
        
        // Upsert user in database
        const user = await prisma.user.upsert({
            where: { discordId: discordUser.id },
            update: {
                username: discordUser.username,
                discriminator: discordUser.discriminator || null,
                email: discordUser.email || null,
                avatar: discordUser.avatar
            },
            create: {
                discordId: discordUser.id,
                username: discordUser.username,
                discriminator: discordUser.discriminator || null,
                email: discordUser.email || null,
                avatar: discordUser.avatar
            }
        });
        
        // Store user in session
        req.session.user = {
            id: user.id,
            discordId: user.discordId,
            username: user.username,
            avatar: user.avatar
        };
        
        res.redirect('/my');
    } catch (err) {
        console.error('OAuth error:', err);
        res.redirect('/?error=oauth_failed');
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Home page - shows all users
app.get('/', async (req, res) => {
    const users = await prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
            _count: {
                select: { 
                    images: true
                }
            }
        }
    });
    
    // Get public and private counts for each user
    const usersWithCounts = await Promise.all(users.map(async (u) => {
        const [publicCount, privateCount] = await Promise.all([
            prisma.image.count({ where: { userId: u.id, isPrivate: false } }),
            prisma.image.count({ where: { userId: u.id, isPrivate: true } })
        ]);
        return { ...u, publicCount, privateCount };
    }));
    
    res.render('index', {
        title: 'Discord File',
        users: usersWithCounts
    });
});

// My images page (private dashboard)
app.get('/my', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/auth/discord');
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;
    
    const [images, totalImages, userData] = await Promise.all([
        prisma.image.findMany({
            where: { userId: req.session.user.id },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit
        }),
        prisma.image.count({ where: { userId: req.session.user.id } }),
        prisma.user.findUnique({ where: { id: req.session.user.id } })
    ]);
    
    const totalPages = Math.ceil(totalImages / limit);
    
    res.render('my', {
        title: 'My Images',
        images,
        page,
        totalPages,
        totalImages,
        userData
    });
});

// User profile page (public)
app.get('/u/:username', async (req, res) => {
    const profileUser = await prisma.user.findFirst({
        where: { username: req.params.username },
        include: {
            _count: {
                select: { 
                    images: { where: { isPrivate: false } },
                }
            }
        }
    });
    
    if (!profileUser) {
        return res.status(404).render('error', {
            title: 'User Not Found',
            status: 404,
            message: 'This user does not exist.'
        });
    }
    
    // Get public images
    const publicImages = await prisma.image.findMany({
        where: { userId: profileUser.id, isPrivate: false },
        orderBy: { createdAt: 'desc' },
        take: 50
    });
    
    // Count private images
    const privateCount = await prisma.image.count({
        where: { userId: profileUser.id, isPrivate: true }
    });
    
    // Check if current user has paid for access
    let hasAccess = false;
    let isOwner = false;
    
    // Check for creator (Discord user) access
    if (req.session.user) {
        isOwner = req.session.user.id === profileUser.id;
    }
    
    // Check for viewer (email user) or creator access to private content
    if (!isOwner && privateCount > 0) {
        if (req.session.viewer) {
            // Check by viewer email
            const payment = await prisma.payment.findFirst({
                where: {
                    email: req.session.viewer.email,
                    toUserId: profileUser.id,
                    status: 'completed'
                }
            });
            hasAccess = !!payment;
        } else if (req.session.user && req.session.user.email) {
            // Check by creator's email (if they also paid)
            const payment = await prisma.payment.findFirst({
                where: {
                    email: req.session.user.email,
                    toUserId: profileUser.id,
                    status: 'completed'
                }
            });
            hasAccess = !!payment;
        }
    }
    
    // Get private images if has access or is owner
    let privateImages = [];
    if (isOwner || hasAccess) {
        privateImages = await prisma.image.findMany({
            where: { userId: profileUser.id, isPrivate: true },
            orderBy: { createdAt: 'desc' },
            take: 50
        });
    }
    
    res.render('profile', {
        title: `${profileUser.username}'s Profile`,
        profileUser,
        publicImages,
        privateImages,
        privateCount,
        hasAccess,
        isOwner
    });
});

// Toggle image privacy
app.post('/api/images/:id/toggle-private', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const image = await prisma.image.findUnique({
        where: { id: req.params.id }
    });
    
    if (!image || image.userId !== req.session.user.id) {
        return res.status(404).json({ error: 'Image not found' });
    }
    
    const updated = await prisma.image.update({
        where: { id: req.params.id },
        data: { isPrivate: !image.isPrivate }
    });
    
    res.json({ success: true, isPrivate: updated.isPrivate });
});

// Update profile settings
app.post('/api/settings', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { bio, privatePrice } = req.body;
    
    const updated = await prisma.user.update({
        where: { id: req.session.user.id },
        data: {
            bio: bio || null,
            privatePrice: Math.max(100, Math.min(10000, parseInt(privatePrice) || 500)) // $1-$100
        }
    });
    
    res.json({ success: true, user: updated });
});

// Create Stripe checkout session (no login required)
app.post('/api/pay/:userId', async (req, res) => {
    const targetUser = await prisma.user.findUnique({
        where: { id: req.params.userId }
    });
    
    if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    // If logged in as creator, can't pay yourself
    if (req.session.user && targetUser.id === req.session.user.id) {
        return res.status(400).json({ error: 'Cannot pay yourself' });
    }
    
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `Private Access - ${targetUser.username}`,
                        description: `Unlock private images from ${targetUser.username}`
                    },
                    unit_amount: targetUser.privatePrice
                },
                quantity: 1
            }],
            mode: 'payment',
            customer_email: req.session.viewer?.email || undefined,
            success_url: `https://${req.hostname}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://${req.hostname}/u/${targetUser.username}?paid=cancelled`,
            metadata: {
                toUserId: targetUser.id,
                toUsername: targetUser.username
            }
        });
        
        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe error:', err);
        res.status(500).json({ error: 'Payment failed' });
    }
});

// Stripe webhook
app.post('/webhook/stripe', async (req, res) => {
    let event;
    
    try {
        // Verify webhook signature if secret is configured
        if (process.env.STRIPE_WEBHOOK_SECRET) {
            const sig = req.headers['stripe-signature'];
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } else {
            event = JSON.parse(req.body.toString());
        }
    } catch (err) {
        console.error('Webhook error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log('Webhook received:', event.type);
    
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const toUserId = session.metadata?.toUserId;
        
        console.log('Payment completed:', { email, toUserId });
        
        if (email && toUserId) {
            // Create or get viewer
            const viewer = await prisma.viewer.upsert({
                where: { email },
                update: {},
                create: { email }
            });
            
            // Create payment record
            await prisma.payment.create({
                data: {
                    stripePaymentId: session.payment_intent || session.id,
                    stripeSessionId: session.id,
                    email,
                    amount: session.amount_total,
                    status: 'completed',
                    viewerId: viewer.id,
                    toUserId
                }
            });
            
            console.log(`Payment recorded: ${email} unlocked ${toUserId}`);
        }
    }
    
    res.json({ received: true });
});

// Payment success - show success page and prompt login
app.get('/payment/success', async (req, res) => {
    const { session_id } = req.query;
    
    if (!session_id) {
        return res.redirect('/?error=no_session');
    }
    
    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        const email = session.customer_details?.email || session.customer_email;
        const toUsername = session.metadata?.toUsername;
        
        if (!email) {
            return res.redirect('/?error=no_email');
        }
        
        // Render success page with login prompt
        res.render('payment-success', {
            title: 'Payment Successful',
            email,
            toUsername
        });
    } catch (err) {
        console.error('Payment success error:', err);
        res.redirect('/?error=payment_retrieval_failed');
    }
});

// Email login - request magic link
app.get('/auth/email', (req, res) => {
    res.render('email-login', {
        title: 'Login with Email',
        error: req.query.error,
        success: req.query.success,
        prefill: req.query.prefill || ''
    });
});

app.post('/auth/email', async (req, res) => {
    const { email } = req.body;
    
    if (!email || !email.includes('@')) {
        return res.redirect('/auth/email?error=invalid_email');
    }
    
    const normalizedEmail = email.toLowerCase();
    
    // Check if this email has any payments (is a viewer)
    const viewer = await prisma.viewer.findUnique({
        where: { email: normalizedEmail }
    });
    
    if (!viewer) {
        return res.redirect('/auth/email?error=no_account');
    }
    
    // Generate a unique token ID for one-time use
    const jti = crypto.randomBytes(16).toString('hex');
    
    // Generate 6-character OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    
    // Create JWT with 15 min expiry
    const token = jwt.sign(
        { email: normalizedEmail, jti },
        JWT_SECRET,
        { expiresIn: '15m' }
    );
    
    // Store token ID and OTP in database
    await prisma.loginToken.create({
        data: {
            email: normalizedEmail,
            token: jti,
            otp,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000)
        }
    });
    
    // Generate login URL
    const loginUrl = `https://${req.hostname}/auth/email/verify?token=${token}`;
    
    // Log it for debugging
    console.log(`Login link for ${email}: ${loginUrl}`);
    console.log(`OTP for ${email}: ${otp}`);
    
    // Send email if Resend is configured
    if (resend && process.env.EMAIL_FROM) {
        try {
            await resend.emails.send({
                from: process.env.EMAIL_FROM,
                to: normalizedEmail,
                subject: 'Your login code',
                html: `
                    <h2>Login to Discord File</h2>
                    <p>Your one-time login code is:</p>
                    <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6366f1; margin: 20px 0;">${otp}</p>
                    <p style="color: #666;">This code expires in 15 minutes. You have 2 attempts to enter it correctly.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #666; font-size: 12px;">Or click this link to login instantly:</p>
                    <p><a href="${loginUrl}" style="color: #6366f1;">${loginUrl}</a></p>
                `
            });
            console.log(`Login email sent to ${email}`);
        } catch (err) {
            console.error('Failed to send email:', err);
        }
    }
    
    // Redirect to OTP entry page
    res.redirect(`/auth/email/code?t=${jti}`);
});

// OTP code entry page
app.get('/auth/email/code', async (req, res) => {
    const { t, error } = req.query;
    
    if (!t) {
        return res.redirect('/auth/email?error=invalid_token');
    }
    
    // Check if token exists and is valid
    const loginToken = await prisma.loginToken.findUnique({
        where: { token: t }
    });
    
    if (!loginToken || loginToken.used || loginToken.expiresAt < new Date() || loginToken.attempts >= 2) {
        return res.redirect('/auth/email?error=expired_token');
    }
    
    res.render('email-code', {
        title: 'Enter Code',
        tokenId: t,
        email: loginToken.email,
        attemptsLeft: 2 - loginToken.attempts,
        error
    });
});

// Verify OTP code
app.post('/auth/email/code', async (req, res) => {
    const { t, code } = req.body;
    
    if (!t || !code) {
        return res.redirect('/auth/email?error=invalid_token');
    }
    
    const loginToken = await prisma.loginToken.findUnique({
        where: { token: t }
    });
    
    if (!loginToken || loginToken.used || loginToken.expiresAt < new Date()) {
        return res.redirect('/auth/email?error=expired_token');
    }
    
    // Check attempts
    if (loginToken.attempts >= 2) {
        await prisma.loginToken.update({
            where: { token: t },
            data: { used: true }
        });
        return res.redirect('/auth/email?error=too_many_attempts');
    }
    
    // Verify OTP
    if (code.trim() !== loginToken.otp) {
        await prisma.loginToken.update({
            where: { token: t },
            data: { attempts: loginToken.attempts + 1 }
        });
        const attemptsLeft = 2 - (loginToken.attempts + 1);
        if (attemptsLeft <= 0) {
            return res.redirect('/auth/email?error=too_many_attempts');
        }
        return res.redirect(`/auth/email/code?t=${t}&error=wrong_code`);
    }
    
    // Mark token as used
    await prisma.loginToken.update({
        where: { token: t },
        data: { used: true }
    });
    
    // Find viewer
    const viewer = await prisma.viewer.findUnique({
        where: { email: loginToken.email }
    });
    
    if (!viewer) {
        return res.redirect('/auth/email?error=no_account');
    }
    
    // Log in
    req.session.viewer = {
        id: viewer.id,
        email: viewer.email
    };
    
    res.redirect('/?logged_in=true');
});

// Verify email login token (JWT-based magic link)
app.get('/auth/email/verify', async (req, res) => {
    const { token } = req.query;
    
    if (!token) {
        return res.redirect('/auth/email?error=invalid_token');
    }
    
    try {
        // Verify and decode JWT
        const decoded = jwt.verify(token, JWT_SECRET);
        const { email, jti } = decoded;
        
        // Check if token has been used (one-time use)
        const loginToken = await prisma.loginToken.findUnique({
            where: { token: jti }
        });
        
        if (!loginToken || loginToken.used) {
            return res.redirect('/auth/email?error=expired_token');
        }
        
        // Mark token as used
        await prisma.loginToken.update({
            where: { token: jti },
            data: { used: true }
        });
        
        // Find viewer
        const viewer = await prisma.viewer.findUnique({
            where: { email }
        });
        
        if (!viewer) {
            return res.redirect('/auth/email?error=no_account');
        }
        
        // Log in
        req.session.viewer = {
            id: viewer.id,
            email: viewer.email
        };
        
        res.redirect('/?logged_in=true');
    } catch (err) {
        console.error('Token verification failed:', err.message);
        if (err.name === 'TokenExpiredError') {
            return res.redirect('/auth/email?error=expired_token');
        }
        return res.redirect('/auth/email?error=invalid_token');
    }
});

// Viewer logout
app.get('/auth/email/logout', (req, res) => {
    delete req.session.viewer;
    res.redirect('/');
});

// Delete image
app.delete('/api/images/:id', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const image = await prisma.image.findUnique({
        where: { id: req.params.id }
    });
    
    if (!image || image.userId !== req.session.user.id) {
        return res.status(404).json({ error: 'Image not found' });
    }
    
    await prisma.image.delete({ where: { id: req.params.id } });
    
    res.json({ success: true });
});

// 404 handler
app.use((req, res, next) => {
    res.status(404).render('error', {
        title: 'Page Not Found',
        status: 404,
        message: 'The page you are looking for does not exist.'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(err.status || 500).render('error', {
        title: 'Error',
        status: err.status || 500,
        message: process.env.PRODUCTION === 'true' ? 'Something went wrong.' : err.message
    });
});

// Discord Bot Setup
const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
});

bot.once('ready', () => {
    console.log(`Discord bot logged in as ${bot.user.tag}`);
    
    // Generate and save bot invite link if not already set
    if (!process.env.DISCORD_BOT_INVITE) {
        const inviteLink = bot.generateInvite({
            scopes: [OAuth2Scopes.Bot],
            permissions: [
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.ViewChannel
            ]
        });
        
        // Append to .env file
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            fs.appendFileSync(envPath, `\n# Auto-generated bot invite link\nDISCORD_BOT_INVITE=${inviteLink}\n`);
            console.log(`Bot invite link saved to .env: ${inviteLink}`);
        }
        
        // Set in current process
        process.env.DISCORD_BOT_INVITE = inviteLink;
    }
});

bot.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Check if message has attachments
    if (message.attachments.size === 0) return;
    
    // Filter for images
    const imageAttachments = message.attachments.filter(att => 
        att.contentType && att.contentType.startsWith('image/')
    );
    
    if (imageAttachments.size === 0) return;
    
    // Find user in database
    const user = await prisma.user.findUnique({
        where: { discordId: message.author.id }
    });
    
    if (!user) {
        // User not registered - optionally reply
        return;
    }
    
    // DM = private, or if message starts with "private"
    const startsWithPrivate = message.content.toLowerCase().startsWith('private');
    const isPrivate = !message.guildId || startsWithPrivate;
    
    // Get description from message content (strip "private" prefix if present)
    let description = message.content.trim();
    if (startsWithPrivate) {
        description = description.slice(7).trim(); // Remove "private" prefix
    }
    description = description || null;
    
    // Save each image
    const savedImages = [];
    for (const [, attachment] of imageAttachments) {
        try {
            const image = await prisma.image.create({
                data: {
                    url: attachment.url,
                    proxyUrl: attachment.proxyURL,
                    filename: attachment.name,
                    description,
                    contentType: attachment.contentType,
                    width: attachment.width,
                    height: attachment.height,
                    size: attachment.size,
                    messageId: message.id,
                    channelId: message.channelId,
                    guildId: message.guildId || null,
                    isPrivate,
                    userId: user.id
                }
            });
            savedImages.push(image);
        } catch (err) {
            console.error('Error saving image:', err);
        }
    }
    
    if (savedImages.length > 0) {
        // React to confirm image was saved
        await message.react(isPrivate ? '🔒' : '✅').catch(() => {});
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Main app running on port ${PORT}`);
});

// Start bot
if (process.env.DISCORD_BOT_TOKEN) {
    bot.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
        console.error('Failed to login bot:', err);
    });
} else {
    console.warn('No DISCORD_BOT_TOKEN set, bot will not start');
}
