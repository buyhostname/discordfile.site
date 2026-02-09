require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const prisma = new PrismaClient();
const app = express();

app.set('trust proxy', true);
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

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

// Make user available to all templates
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
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
        
        res.redirect('/');
    } catch (err) {
        console.error('OAuth error:', err);
        res.redirect('/?error=oauth_failed');
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Home page - shows image feed
app.get('/', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;
    
    let images = [];
    let totalImages = 0;
    
    if (req.session.user) {
        [images, totalImages] = await Promise.all([
            prisma.image.findMany({
                where: { userId: req.session.user.id },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: { user: true }
            }),
            prisma.image.count({ where: { userId: req.session.user.id } })
        ]);
    }
    
    const totalPages = Math.ceil(totalImages / limit);
    
    res.render('index', {
        title: 'Discord File',
        images,
        page,
        totalPages,
        totalImages
    });
});

// API endpoint to get images (for infinite scroll)
app.get('/api/images', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;
    
    const images = await prisma.image.findMany({
        where: { userId: req.session.user.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
    });
    
    res.json({ images, page });
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
    
    // Save each image
    const savedImages = [];
    for (const [, attachment] of imageAttachments) {
        try {
            const image = await prisma.image.create({
                data: {
                    url: attachment.url,
                    proxyUrl: attachment.proxyURL,
                    filename: attachment.name,
                    contentType: attachment.contentType,
                    width: attachment.width,
                    height: attachment.height,
                    size: attachment.size,
                    messageId: message.id,
                    channelId: message.channelId,
                    guildId: message.guildId || null,
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
        await message.react('✅').catch(() => {});
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
