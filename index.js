require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { encode } = require('blurhash');
const { PrismaClient } = require('@prisma/client');
const { Client, GatewayIntentBits, Partials, OAuth2Scopes, PermissionFlagsBits } = require('discord.js');
const Stripe = require('stripe');
const { Resend } = require('resend');

const prisma = new PrismaClient();
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Session database
const sessionsDb = new Database(path.join(__dirname, 'sessions.db'));

// JWT secret for magic links (use SESSION_SECRET as fallback)
const JWT_SECRET = process.env.SESSION_SECRET || 'change-me';

const PORT = process.env.PORT || 3000;

// Uploads directory
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Helper function to download file from URL
async function downloadFile(url, filepath) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filepath, buffer);
    return filepath;
}

// Helper function to convert video to MP4 using ffmpeg
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function convertToMp4(inputPath, outputPath) {
    // -y: overwrite output, -i: input, -c:v libx264: H.264 codec, -c:a aac: AAC audio
    // -movflags +faststart: optimize for web streaming
    const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -c:a aac -movflags +faststart "${outputPath}"`;
    await execPromise(cmd);
    return outputPath;
}

// Strip audio from video using ffmpeg
async function stripAudio(inputPath, outputPath) {
    // -an: no audio, -c:v copy: copy video stream without re-encoding
    const cmd = `ffmpeg -y -i "${inputPath}" -an -c:v copy "${outputPath}"`;
    await execPromise(cmd);
    return outputPath;
}

// Video formats that need conversion to MP4
const VIDEO_FORMATS_TO_CONVERT = ['.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.mpeg', '.mpg'];

// Image formats that can have EXIF stripped
const IMAGE_FORMATS_WITH_EXIF = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif'];

// Strip EXIF/metadata from images (removes GPS, camera info, timestamps, etc.)
async function stripExifData(inputPath, outputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    
    // Only process supported image formats
    if (!IMAGE_FORMATS_WITH_EXIF.includes(ext)) {
        return false;
    }
    
    try {
        // Read image and strip all metadata, then save
        await sharp(inputPath)
            .rotate() // Auto-rotate based on EXIF orientation before stripping
            .withMetadata({ orientation: undefined }) // Remove all metadata
            .toFile(outputPath);
        
        return true;
    } catch (err) {
        console.error(`[EXIF] Failed to strip metadata: ${err.message}`);
        return false;
    }
}

app.set('trust proxy', true);
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

// Stripe webhook needs raw body
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware with persistent SQLite store
app.use(session({
    store: new SqliteStore({
        client: sessionsDb,
        expired: {
            clear: true,
            intervalMs: 900000 // Clear expired sessions every 15 min
        }
    }),
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.PRODUCTION === 'true',
        sameSite: 'lax',
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

// Discord OAuth config
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

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
    
    // Get the viewer's email for checking unlocked creators
    const viewerEmail = req.session.viewer?.email || req.session.user?.email;
    
    // Get list of creator IDs the viewer has unlocked
    let unlockedCreatorIds = [];
    if (viewerEmail) {
        const payments = await prisma.payment.findMany({
            where: {
                email: viewerEmail,
                status: 'completed'
            },
            select: { toUserId: true }
        });
        unlockedCreatorIds = payments.map(p => p.toUserId);
    }
    
    // Get public and private counts for each user
    const usersWithCounts = await Promise.all(users.map(async (u) => {
        const [publicCount, privateCount] = await Promise.all([
            prisma.image.count({ where: { userId: u.id, isPrivate: false } }),
            prisma.image.count({ where: { userId: u.id, isPrivate: true } })
        ]);
        const hasUnlocked = unlockedCreatorIds.includes(u.id);
        return { ...u, publicCount, privateCount, hasUnlocked };
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
    
    // Check if current user has paid for access
    let hasAccess = false;
    let isOwner = false;
    
    // Check for creator (Discord user) access
    if (req.session.user) {
        isOwner = req.session.user.id === profileUser.id;
    }
    
    // Count private images
    const privateCount = await prisma.image.count({
        where: { userId: profileUser.id, isPrivate: true }
    });
    
    // Check for viewer (email user) or creator access to private content
    if (!isOwner && privateCount > 0) {
        if (req.session.viewer) {
            const payment = await prisma.payment.findFirst({
                where: {
                    email: req.session.viewer.email,
                    toUserId: profileUser.id,
                    status: 'completed'
                }
            });
            hasAccess = !!payment;
        } else if (req.session.user && req.session.user.email) {
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
    
    // Get ALL content sorted by date (mixed timeline)
    const allContent = await prisma.image.findMany({
        where: { userId: profileUser.id },
        orderBy: { createdAt: 'desc' },
        take: 100
    });
    
    res.render('profile', {
        title: `${profileUser.username}'s Profile`,
        profileUser,
        allContent,
        privateCount,
        hasAccess,
        isOwner
    });
});

// TikTok-style fullscreen viewer page
app.get('/view/:username', async (req, res) => {
    const profileUser = await prisma.user.findFirst({
        where: { username: req.params.username }
    });
    
    if (!profileUser) {
        return res.status(404).render('error', {
            title: 'User Not Found',
            status: 404,
            message: 'This user does not exist.'
        });
    }
    
    // Check access for private content
    let hasAccess = false;
    let isOwner = false;
    
    if (req.session.user) {
        isOwner = req.session.user.id === profileUser.id;
    }
    
    if (!isOwner) {
        if (req.session.viewer) {
            const payment = await prisma.payment.findFirst({
                where: {
                    email: req.session.viewer.email,
                    toUserId: profileUser.id,
                    status: 'completed'
                }
            });
            hasAccess = !!payment;
        } else if (req.session.user && req.session.user.email) {
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
    
    // Get ALL content sorted by date (including locked items)
    const allContent = await prisma.image.findMany({
        where: { userId: profileUser.id },
        orderBy: { createdAt: 'desc' },
        take: 100
    });
    
    // Map all content - SECURE: locked content only gets minimal info for blurhash
    const allMedia = allContent.map(img => {
        const isLocked = img.isPrivate && !isOwner && !hasAccess;
        
        if (isLocked) {
            // Only send what's needed for blurhash preview - NO file access info
            return {
                id: img.id,  // Only used for blurhash fetch
                isVideo: img.contentType?.startsWith('video/'),
                isImage: img.contentType?.startsWith('image/'),
                isAudio: img.contentType?.startsWith('audio/'),
                isPrivate: true,
                isLocked: true,
                createdAt: img.createdAt.toISOString(),
                // NO url, NO filename, NO description for locked content
            };
        }
        
        // Unlocked content gets full info
        return {
            id: img.id,
            url: `/file/${img.id}`,
            previewUrl: `/preview/${img.id}`,
            isVideo: img.contentType?.startsWith('video/'),
            isImage: img.contentType?.startsWith('image/'),
            isAudio: img.contentType?.startsWith('audio/'),
            contentType: img.contentType,
            filename: img.filename,
            description: img.description || '',
            isPrivate: img.isPrivate,
            isLocked: false,
            createdAt: img.createdAt.toISOString()
        };
    });
    
    // Get starting index from query param
    const startIndex = parseInt(req.query.start) || 0;
    
    res.render('viewer', {
        title: `${profileUser.username}'s Content`,
        profileUser,
        allMedia,
        startIndex,
        hasAccess,
        isOwner
    });
});

// Secure file serving route
app.get('/file/:id', async (req, res) => {
    const image = await prisma.image.findUnique({
        where: { id: req.params.id },
        include: { user: true }
    });
    
    if (!image) {
        return res.status(404).send('File not found');
    }
    
    // Check access for private files
    if (image.isPrivate) {
        let hasAccess = false;
        
        // Owner always has access
        if (req.session.user && req.session.user.id === image.userId) {
            hasAccess = true;
        }
        
        // Check if viewer has paid
        if (!hasAccess && req.session.viewer) {
            const payment = await prisma.payment.findFirst({
                where: {
                    email: req.session.viewer.email,
                    toUserId: image.userId,
                    status: 'completed'
                }
            });
            hasAccess = !!payment;
        }
        
        // Check if logged-in creator has paid (using their email)
        if (!hasAccess && req.session.user && req.session.user.email) {
            const payment = await prisma.payment.findFirst({
                where: {
                    email: req.session.user.email,
                    toUserId: image.userId,
                    status: 'completed'
                }
            });
            hasAccess = !!payment;
        }
        
        if (!hasAccess) {
            return res.status(403).send('Access denied');
        }
    }
    
    // Serve the file
    if (image.localPath) {
        const filePath = path.join(__dirname, image.localPath);
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', image.contentType || 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${image.filename}"`);
            return res.sendFile(filePath);
        }
    }
    
    // Fallback to Discord URL (may be expired)
    res.redirect(image.url);
});

// Blurhash preview for premium content - returns JSON with blurhash string
app.get('/preview/:id', async (req, res) => {
    const image = await prisma.image.findUnique({
        where: { id: req.params.id }
    });
    
    if (!image) {
        return res.status(404).json({ error: 'Not found' });
    }
    
    // Only generate previews for images
    if (!image.contentType?.startsWith('image/')) {
        // Return a purple/pink gradient blurhash for videos/other files
        return res.json({ 
            blurhash: 'L9A]$k~qR*~q_3xuWBof%MRjRjWB',  // Purple/pink gradient
            width: 4,
            height: 3
        });
    }
    
    try {
        let filePath;
        if (image.localPath) {
            filePath = path.join(__dirname, image.localPath);
        }
        
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Preview not available' });
        }
        
        // Resize for blurhash encoding
        const { data, info } = await sharp(filePath)
            .resize(128, 128, { fit: 'cover' })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        
        // Generate blurhash - 4x4 components for smooth blur effect
        const blurhash = encode(
            new Uint8ClampedArray(data),
            info.width,
            info.height,
            4,  // x components
            4   // y components
        );
        
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.json({ 
            blurhash,
            width: info.width,
            height: info.height
        });
    } catch (err) {
        console.error('Blurhash generation error:', err);
        res.status(500).json({ error: 'Preview failed' });
    }
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
    
    // Explicitly save session before redirect to ensure it persists
    req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/?logged_in=true');
    });
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
        
        // Explicitly save session before redirect to ensure it persists
        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.redirect('/?logged_in=true');
        });
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
    
    // Delete local file if exists
    if (image.localPath) {
        const filePath = path.join(__dirname, image.localPath);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
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
    
    console.log(`[Bot] Message from ${message.author.username} with ${message.attachments.size} attachment(s)`);
    
    // Log all attachments for debugging
    for (const [id, att] of message.attachments) {
        console.log(`  - ${att.name}: ${att.contentType || 'NO CONTENT TYPE'} (${att.size} bytes)`);
    }
    
    // Accept all file types (must have contentType)
    const mediaAttachments = message.attachments.filter(att => att.contentType);
    
    if (mediaAttachments.size === 0) {
        console.log(`[Bot] No attachments with contentType, skipping`);
        return;
    }
    
    console.log(`[Bot] Processing ${mediaAttachments.size} valid attachment(s)`);
    
    // Find user in database
    const user = await prisma.user.findUnique({
        where: { discordId: message.author.id }
    });
    
    if (!user) {
        console.log(`[Bot] User ${message.author.username} (${message.author.id}) not registered, skipping`);
        return;
    }
    
    // DM = private, or if message starts with "private"
    const startsWithPrivate = message.content.toLowerCase().startsWith('private');
    const messagePrivate = !message.guildId || startsWithPrivate;
    
    // Check if user wants to mute video (strip audio)
    const wantsMute = /\bmute\b/i.test(message.content);
    
    // Get description from message content (strip "private" and "mute" keywords if present)
    let description = message.content.trim();
    if (startsWithPrivate) {
        description = description.slice(7).trim(); // Remove "private" prefix
    }
    // Remove "mute" keyword from description
    description = description.replace(/\bmute\b/gi, '').replace(/\s+/g, ' ').trim();
    description = description || null;
    
    // Save each media file
    const savedImages = [];
    for (const [, attachment] of mediaAttachments) {
        try {
            // Check if file is a spoiler (private)
            const isSpoiler = attachment.spoiler || attachment.name.startsWith('SPOILER_');
            const isPrivate = messagePrivate || isSpoiler;
            
            // Generate unique filename (strip SPOILER_ prefix if present)
            let originalName = attachment.name;
            if (originalName.startsWith('SPOILER_')) {
                originalName = originalName.slice(8); // Remove "SPOILER_" prefix
            }
            const ext = path.extname(originalName).toLowerCase() || '.bin';
            const uniqueId = crypto.randomBytes(16).toString('hex');
            let localFilename = `${uniqueId}${ext}`;
            let localPath = path.join(UPLOADS_DIR, localFilename);
            let finalContentType = attachment.contentType;
            let finalFilename = originalName;
            
            console.log(`[Bot] Downloading ${attachment.name} (${attachment.contentType})${isSpoiler ? ' [SPOILER]' : ''}...`);
            
            // Download the file from Discord
            await downloadFile(attachment.url, localPath);
            
            console.log(`[Bot] Saved to ${localFilename}`);
            
            // Convert video formats to MP4 for browser compatibility
            if (VIDEO_FORMATS_TO_CONVERT.includes(ext)) {
                console.log(`[Bot] Converting ${ext} to MP4...`);
                const mp4Filename = `${uniqueId}.mp4`;
                const mp4Path = path.join(UPLOADS_DIR, mp4Filename);
                
                try {
                    await convertToMp4(localPath, mp4Path);
                    // Delete original file
                    fs.unlinkSync(localPath);
                    // Update to use MP4
                    localFilename = mp4Filename;
                    localPath = mp4Path;
                    finalContentType = 'video/mp4';
                    finalFilename = originalName.replace(/\.[^.]+$/, '.mp4');
                    console.log(`[Bot] Converted to ${mp4Filename}`);
                } catch (convErr) {
                    console.error(`[Bot] Conversion failed, keeping original:`, convErr.message);
                }
            }
            
            // Strip EXIF/metadata from images (removes GPS, camera info, etc.)
            if (IMAGE_FORMATS_WITH_EXIF.includes(ext)) {
                console.log(`[Bot] Stripping EXIF metadata...`);
                const cleanFilename = `${uniqueId}_clean${ext}`;
                const cleanPath = path.join(UPLOADS_DIR, cleanFilename);
                
                const stripped = await stripExifData(localPath, cleanPath);
                if (stripped) {
                    // Delete original, use cleaned version
                    fs.unlinkSync(localPath);
                    // Rename clean file to original name
                    fs.renameSync(cleanPath, localPath);
                    console.log(`[Bot] EXIF metadata stripped`);
                }
            }
            
            // Strip audio from video if "mute" was in the message
            const isVideo = finalContentType?.startsWith('video/');
            if (isVideo && wantsMute) {
                console.log(`[Bot] Stripping audio from video...`);
                const mutedFilename = `${uniqueId}_muted${path.extname(localFilename)}`;
                const mutedPath = path.join(UPLOADS_DIR, mutedFilename);
                
                try {
                    await stripAudio(localPath, mutedPath);
                    // Delete original, use muted version
                    fs.unlinkSync(localPath);
                    // Rename muted file to original name
                    fs.renameSync(mutedPath, localPath);
                    console.log(`[Bot] Audio stripped from video`);
                } catch (muteErr) {
                    console.error(`[Bot] Failed to strip audio:`, muteErr.message);
                }
            }
            
            const image = await prisma.image.create({
                data: {
                    url: attachment.url,
                    proxyUrl: attachment.proxyURL,
                    localPath: `uploads/${localFilename}`,
                    filename: finalFilename,
                    description,
                    contentType: finalContentType,
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
            console.log(`[Bot] Created DB record for ${finalFilename} (${isPrivate ? 'private' : 'public'})`);
        } catch (err) {
            console.error(`[Bot] Error saving ${attachment.name}:`, err.message);
        }
    }
    
    const hasPrivate = savedImages.some(img => img.isPrivate);
    const hasPublic = savedImages.some(img => !img.isPrivate);
    console.log(`[Bot] Saved ${savedImages.length}/${mediaAttachments.size} files (${hasPrivate ? 'has private' : ''}${hasPrivate && hasPublic ? ', ' : ''}${hasPublic ? 'has public' : ''})`);
    
    if (savedImages.length > 0) {
        // React to confirm file was saved
        // Use lock if any private, checkmark if all public
        await message.react(hasPrivate ? '🔒' : '✅').catch(() => {});
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
