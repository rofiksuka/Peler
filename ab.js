console.log('Memulai bot...');

const { Telegraf, Markup } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const FormData = require('form-data');
const config = require('./config');

// --- PENGATURAN DIREKTORI GLOBAL ---
const SESSIONS_DIR = './sessions'; 
const BOT_DATA_DIR = './bot_data'; 
const USER_SESSIONS_PATH = './user_sessions.json'; 
const SUB_BOTS_PATH = './sub_bots.json'; 

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);
if (!fs.existsSync(BOT_DATA_DIR)) fs.mkdirSync(BOT_DATA_DIR);

// --- FUNGSI HELPERS JSON ---

const getDataPath = (fileName, ownerId = null) => {
    if (ownerId) {
        const userBotDir = path.join(BOT_DATA_DIR, String(ownerId));
        if (!fs.existsSync(userBotDir)) fs.mkdirSync(userBotDir, { recursive: true });
        return path.join(userBotDir, fileName);
    }
    return `./${fileName}`; 
};

const readJSON = (filePath, defaultValue) => {
    try {
        if (!fs.existsSync(filePath)) {
             writeJSON(filePath, defaultValue);
             return defaultValue;
        }
        return JSON.parse(fs.readFileSync(filePath));
    } catch (e) {
        writeJSON(filePath, defaultValue);
        return defaultValue;
    }
};
const writeJSON = (filePath, data) => {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Gagal menulis ke ${filePath}:`, e);
    }
};

// --- FUNGSI DATA GLOBAL (WA & Sub-bots) ---
const getUserSessions = () => readJSON(USER_SESSIONS_PATH, {});
const saveUserSessions = (sessions) => writeJSON(USER_SESSIONS_PATH, sessions);
const getSubBots = () => readJSON(SUB_BOTS_PATH, {});
const saveSubBots = (bots) => writeJSON(SUB_BOTS_PATH, bots);

// Helper ini khusus untuk data bot utama (ownerId = null)
const getMainBotPremiumUsers = () => readJSON(getDataPath('premium.json', null), []);
const saveMainBotPremiumUsers = (users) => writeJSON(getDataPath('premium.json', null), users);
const getMainBotRedeemedRewards = () => readJSON(getDataPath('redeemed_rewards.json', null), {});
const saveMainBotRedeemedRewards = (rewards) => writeJSON(getDataPath('redeemed_rewards.json', null), rewards);

// --- MANAJEMEN KONEKSI WA (GLOBAL) ---
const userCooldowns = new Map();
const pendingBioChecks = new Map(); 
const pendingChecks = new Map(); 
const pendingReward = new Map(); 
const waClients = new Map();
const pendingJadibot = new Map(); 
const pendingJadibotDuration = new Map(); 
const activeSubBots = new Map(); 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startWhatsAppClient(sessionId, ownerUserId) {
    console.log(`Mencoba memulai koneksi WA untuk sesi: ${sessionId} (Owner: ${ownerUserId || 'Global'})...`);
    const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, sessionId));

    const waClient = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Safari')
    });

    waClients.set(sessionId, { client: waClient, status: 'connecting', ownerId: ownerUserId });

    waClient.ev.on('creds.update', saveCreds);

    waClient.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        const clientData = waClients.get(sessionId);
        if (!clientData) return;

        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            clientData.status = 'closed';
            console.log(`Koneksi WA [${sessionId}] tertutup. Alasan: ${new Boom(lastDisconnect?.error)?.message}. Coba sambung ulang: ${shouldReconnect}`);
            
            if (clientData.ownerId) {
                let uSessions = getUserSessions();
                if (uSessions[clientData.ownerId] && uSessions[clientData.ownerId].sessions[sessionId]) {
                    uSessions[clientData.ownerId].sessions[sessionId].status = 'closed';
                    saveUserSessions(uSessions);
                }
            } else {
                 const mainSettingsPath = getDataPath('settings.json', null);
                 let mainSettings = readJSON(mainSettingsPath, config.defaultSettings);
                 if (mainSettings.activeSender === sessionId) {
                     mainSettings.activeSender = null;
                     writeJSON(mainSettingsPath, mainSettings);
                 }
            }
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsAppClient(sessionId, ownerUserId), 5000);
            } else {
                console.log(`Tidak bisa menyambung ulang [${sessionId}] (logged out). Menghapus sesi...`);
                waClients.delete(sessionId);
                fs.rmSync(path.join(SESSIONS_DIR, sessionId), { recursive: true, force: true });
                
                if (clientData.ownerId) {
                    let uSessions = getUserSessions();
                    if (uSessions[clientData.ownerId] && uSessions[clientData.ownerId].sessions[sessionId]) {
                        delete uSessions[clientData.ownerId].sessions[sessionId];
                        if (uSessions[clientData.ownerId].activeSessionId === sessionId) {
                            uSessions[clientData.ownerId].activeSessionId = null;
                        }
                        saveUserSessions(uSessions);
                    }
                }
            }
        } else if (connection === 'open') {
            clientData.status = 'open';
            console.log(`Berhasil tersambung ke WhatsApp [${sessionId}]!`);
            
            try {
                if (clientData.ownerId) {
                    bot.telegram.sendMessage(clientData.ownerId, `✅ Sender Pribadi \`${sessionId}\` berhasil tersambung!`, { parse_mode: 'Markdown' });
                } else {
                    bot.telegram.sendMessage(config.ownerId, `✅ Sender Global \`${sessionId}\` berhasil tersambung!`, { parse_mode: 'Markdown' });
                }
            } catch (e) {
                console.log("Gagal kirim notif WA tersambung:", e.message);
            }
            
            if (clientData.ownerId) {
                 let uSessions = getUserSessions();
                 if (uSessions[clientData.ownerId] && uSessions[clientData.ownerId].sessions[sessionId]) {
                     uSessions[clientData.ownerId].sessions[sessionId].status = 'open';
                     saveUserSessions(uSessions);
                 }
            }
        }
    });
}

function getActiveWhatsAppClient(userId) {
    const userSessions = getUserSessions();
    const userSessionData = userSessions[userId];
    const activeId = userSessionData?.activeSessionId;

    if (activeId) {
        const clientData = waClients.get(activeId);
        if (clientData && clientData.status === 'open') {
            return clientData.client;
        }
    }
    
    const mainSettingsPath = getDataPath('settings.json', null);
    const mainSettings = readJSON(mainSettingsPath, config.defaultSettings);
    if (!mainSettings.activeSender) return null;
    
    const globalClientData = waClients.get(mainSettings.activeSender);
    return (globalClientData && globalClientData.status === 'open') ? globalClientData.client : null;
}

function getPersonalActiveClient(userId) {
    const userSessions = getUserSessions();
    const userSessionData = userSessions[userId];
    const activeId = userSessionData?.activeSessionId;

    if (!activeId) return null; 

    const clientData = waClients.get(activeId);
    if (!clientData) return null; 

    const mainSettingsPath = getDataPath('settings.json', null);
    const mainSettings = readJSON(mainSettingsPath, config.defaultSettings);
    if (activeId === mainSettings.activeSender) return null; 

    if (clientData.ownerId == userId && clientData.status === 'open') {
         return clientData.client;
    }
    
    return null; 
}


async function startAllWaClients() {
    const sessionFiles = fs.readdirSync(SESSIONS_DIR);
    const userSessions = getUserSessions();
    const allUserSessionIds = new Set();

    for (const userId in userSessions) {
        for (const sessionId in userSessions[userId].sessions) {
            allUserSessionIds.add(sessionId);
        }
    }

    for (const session of sessionFiles) {
        if (fs.statSync(path.join(SESSIONS_DIR, session)).isDirectory()) {
            if (!allUserSessionIds.has(session)) {
                await startWhatsAppClient(session, null);
            }
        }
    }
    
    for (const userId in userSessions) {
        for (const sessionId in userSessions[userId].sessions) {
             await startWhatsAppClient(sessionId, userId);
        }
    }
}

// --- FUNGSI UTAMA CEK BIO UPDATE (INCLUDE BUSINESS PROFILE) ---
async function handleBioCheck(userId, numbersToCheck, updateCallback) {
    const waClient = getPersonalActiveClient(userId);
    if (!waClient) throw new Error('WhatsApp pribadi tidak tersambung. Cek /listsender dan /setsender.');
    
    let withBio = [], noBio = [], notRegistered = [];

    const jidsToCheck = numbersToCheck.map(num => num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const existingJids = new Set();

    // Cek existence dulu agar efisien
    const existenceResults = await waClient.onWhatsApp(...jidsToCheck);
    existenceResults.forEach(res => {
        if (res.exists) existingJids.add(res.jid);
    });

    jidsToCheck.forEach(jid => {
        if (!existingJids.has(jid)) {
            notRegistered.push(jid.split('@')[0]);
        }
    });

    const registeredJids = Array.from(existingJids);

    const mainSettingsPath = getDataPath('settings.json', null);
    const mainSettings = readJSON(mainSettingsPath, config.defaultSettings);
    const batchSize = mainSettings.cekBioBatchSize || 20;

    if (registeredJids.length > 0) {
        for (let i = 0; i < registeredJids.length; i += batchSize) {
            const batch = registeredJids.slice(i, i + batchSize);

            // Callback untuk animasi loading
            if (updateCallback) {
                const currentNum = batch[0]?.split('@')[0] || '';
                const processedCount = i + batch.length;
                await updateCallback(currentNum, processedCount, registeredJids.length);
            }

            const promises = batch.map(async (jid) => {
                const nomor = jid.split('@')[0];
                try {
                    // Fetch Status dan Profil Bisnis secara paralel
                    const [statusResult, businessProfile] = await Promise.all([
                        waClient.fetchStatus(jid).catch(() => null),
                        waClient.getBusinessProfile(jid).catch(() => null),
                    ]);

                    let bioText = null;
                    let setAtTimestamp = null;
                    let pushName = nomor; // Default ke nomor jika nama tidak ada

                    // Parse Bio (Status)
                    if (Array.isArray(statusResult) && statusResult.length > 0) {
                        const data = statusResult[0];
                        if (data) {
                           if (typeof data.status === 'string') bioText = data.status;
                           else if (typeof data.status === 'object' && data.status !== null) bioText = data.status.text || data.status.status;
                           
                           setAtTimestamp = data.setAt || (data.status && data.status.setAt);
                        }
                    } else if (statusResult && (typeof statusResult.status === 'string' || typeof statusResult.status === 'object')) {
                         bioText = (typeof statusResult.status === 'object') ? statusResult.status.status : statusResult.status;
                         setAtTimestamp = statusResult.setAt;
                    }

                    // Parse Business Data
                    const isBusiness = businessProfile && Object.keys(businessProfile).length > 0;
                    const businessCategory = businessProfile?.category || "Tidak Terdaftar";

                    // Format Business Info persis format teman
                    const businessInfo = {
                        business: isBusiness ? `💼 Business: Terdaftar (${businessCategory})` : "🙎‍♂️ Business: Tidak Terdaftar",
                        email: (businessProfile?.email) ? businessProfile.email : "-",
                        website: (businessProfile?.website && businessProfile.website.length > 0) ? businessProfile.website[0] : "-",
                        description: (businessProfile?.description) ? businessProfile.description.replace(/\n/g, ' ') : "-"
                    };

                    const data = {
                        nomor,
                        bio: bioText,
                        setAt: setAtTimestamp,
                        pushName,
                        ...businessInfo
                    };

                    if (bioText && bioText.trim() !== "") {
                        withBio.push(data);
                    } else {
                        noBio.push(data);
                    }

                } catch (e) {
                    noBio.push({ nomor });
                }
            });

            await Promise.allSettled(promises);

            if (i + batchSize < registeredJids.length) await sleep(1000);
        }
    }

    return { withBio, noBio, notRegistered, total: numbersToCheck.length };
}


// --- FUNGSI FORMAT OUTPUT UPDATE (TREE STRUCTURE) ---
function formatBioResult(resultData) {
    let fileContent = "HASIL CEK BIO SEMUA USER\n\n";
    fileContent += `✅ Total nomor dicek : ${resultData.total}\n`;
    fileContent += `📳 Dengan Bio       : ${resultData.withBio.length}\n`;
    fileContent += `📵 Tanpa Bio        : ${resultData.noBio.length}\n`;
    fileContent += `🚫 Tidak Terdaftar  : ${resultData.notRegistered.length}\n\n`;

    if (resultData.withBio.length > 0) {
        fileContent += `----------------------------------------\n\n`;
        fileContent += `✅ NOMOR DENGAN BIO (${resultData.withBio.length})\n\n`;
        
        const groupedByYear = resultData.withBio.reduce((acc, item) => {
            const date = item.setAt ? new Date(item.setAt) : null;
            const year = date ? date.getFullYear() : "Tahun Tidak Diketahui";
            if (!acc[year]) acc[year] = [];
            acc[year].push(item);
            return acc;
        }, {});

        const sortedYears = Object.keys(groupedByYear).sort((a, b) => a - b);

        for (const year of sortedYears) {
            fileContent += `Tahun ${year}\n\n`;
            groupedByYear[year]
                .sort((a, b) => (a.setAt && b.setAt) ? new Date(a.setAt) - new Date(b.setAt) : 0)
                .forEach(item => {
                    const date = item.setAt ? new Date(item.setAt) : null;
                    let formattedDate = 'Tidak diketahui';
                    if (date && !isNaN(date)) {
                        const datePart = date.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
                        // Menggunakan titik (.) pengganti titik dua (:)
                        const timePart = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                        formattedDate = `${datePart}, ${timePart.replace(/:/g, '.')}`;
                    }
                    fileContent += `└─ 📅 ${item.nomor}\n`;
                    fileContent += `   └─ 🙎‍♂️ Nama: ${item.pushName}\n`;
                    fileContent += `   └─ 📝 Bio: "${item.bio}"\n`;
                    fileContent += `   └─ ⏰ ${formattedDate}\n`;
                    fileContent += `   └─ ${item.business}\n`;
                    fileContent += `   └─ 📧 Email: ${item.email}\n`;
                    fileContent += `   └─ 🌐 Website: ${item.website}\n`;
                    fileContent += `   └─ 📝 Deskripsi: ${item.description}\n\n`;
                });
        }
    }

    fileContent += `----------------------------------------\n\n`;
    fileContent += `📵 NOMOR TANPA BIO (${resultData.noBio.length})\n\n`;

    resultData.noBio.forEach(item => {
        fileContent += `└─ 📅 ${item.nomor}\n`;
        fileContent += `   └─ 🙎‍♂️ Nama: ${item.pushName || item.nomor}\n`;
        fileContent += `   └─ ${item.business || '-'}\n`;
        fileContent += `   └─ 📧 Email: ${item.email || '-'}\n`;
        fileContent += `   └─ 🌐 Website: ${item.website || '-'}\n`;
        fileContent += `   └─ 📝 Deskripsi: ${item.description || '-'}\n\n`;
    });

    fileContent += `----------------------------------------\n\n`;
    fileContent += `🚫 NOMOR TIDAK TERDAFTAR (${resultData.notRegistered.length})\n\n`;
    fileContent += resultData.notRegistered.length > 0 ? resultData.notRegistered.join('\n') : `(Kosong)`;

    return fileContent;
}


async function showLoadingAnimation(ctx, operationText = "Memproses") {
    const frames = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
    let frame = 0;
    const message = await ctx.reply(`${frames[frame]} ${operationText}...`);
    const interval = setInterval(() => {
        ctx.telegram.editMessageText(ctx.chat.id, message.message_id, undefined, `${frames[frame]} ${operationText}...`).catch(() => {});
        frame = (frame + 1) % frames.length;
    }, 800);
    return { interval, messageId: message.message_id };
}

const escapeMarkdownV2 = (text) => {
    if (!text) return '';
    return text.replace(/([_\*[\]()~`>#+=|{}.!-])/g, '\\$1');
};

const escapeMarkdownV1 = (text) => {
    if (!text) return '';
    return text.replace(/([_*`\[])/g, '\\$1');
};

function registerBotLogic(botInstance, botOwnerId = null) {

    const IS_MAIN_BOT = botOwnerId === null;
    const BOT_OWNER_ID = botOwnerId || config.ownerId; 
    const MAIN_OWNER_ID = config.ownerId; 

    const getPremiumUsers = () => readJSON(getDataPath('premium.json', botOwnerId), []);
    const savePremiumUsers = (users) => writeJSON(getDataPath('premium.json', botOwnerId), users);
    const getUsers = () => readJSON(getDataPath('users.json', botOwnerId), []);
    const saveUsers = (users) => writeJSON(getDataPath('users.json', botOwnerId), users);
    
    let settings = readJSON(getDataPath('settings.json', botOwnerId), config.defaultSettings);
    
    const getSettings = () => settings;
    const saveSettings = (newSettings) => { 
        settings = newSettings; 
        writeJSON(getDataPath('settings.json', botOwnerId), newSettings); 
    };

    if (!settings.accessLevel) {
        settings.accessLevel = {};
        saveSettings(settings); 
    }
    
    const getEmails = () => readJSON(getDataPath('emails.json', botOwnerId), []);
    const saveEmails = (emails) => writeJSON(getDataPath('emails.json', botOwnerId), emails);
    const getTemplates = () => readJSON(getDataPath('message_templates.json', botOwnerId), []);
    const saveTemplates = (templates) => writeJSON(getDataPath('message_templates.json', botOwnerId), templates);
    const getWhitelistedGroups = () => readJSON(getDataPath('whitelisted_groups.json', botOwnerId), []);
    const saveWhitelistedGroups = (groups) => writeJSON(getDataPath('whitelisted_groups.json', botOwnerId), groups);

    const getPremiumEmails = () => readJSON(getDataPath('emails_premium.json', botOwnerId), []);
    const savePremiumEmails = (emails) => writeJSON(getDataPath('emails_premium.json', botOwnerId), emails);
    const getPoints = () => readJSON(getDataPath('points.json', botOwnerId), {});
    const savePoints = (points) => writeJSON(getDataPath('points.json', botOwnerId), points);
    const getReferrals = () => readJSON(getDataPath('referrals.json', botOwnerId), {});
    const saveReferrals = (referrals) => writeJSON(getDataPath('referrals.json', botOwnerId), referrals);
    const getRedeemedRewards = () => readJSON(getDataPath('redeemed_rewards.json', botOwnerId), {});
    const saveRedeemedRewards = (rewards) => writeJSON(getDataPath('redeemed_rewards.json', botOwnerId), rewards);
    const getForcedJoins = () => readJSON(getDataPath('forced_joins.json', botOwnerId), { channels: [], groups: [] });
    const saveForcedJoins = (joins) => writeJSON(getDataPath('forced_joins.json', botOwnerId), joins);


    const notifyOwner = (ctx, message) => {
        try {
            ctx.telegram.sendMessage(BOT_OWNER_ID, message, { parse_mode: 'Markdown' });
        } catch (e) {
            console.log(`[Bot ${BOT_OWNER_ID}] Gagal mengirim notifikasi ke owner:`, e.message);
        }
    };
    
    const notifyMainOwner = (message) => {
        try {
            bot.telegram.sendMessage(MAIN_OWNER_ID, message, { parse_mode: 'Markdown' });
        } catch (e) {
             console.log(`[MAIN BOT] Gagal mengirim notifikasi ke owner utama:`, e.message);
        }
    };

    const addUser = (ctx) => {
        const users = getUsers();
        const userId = ctx.from.id;
        if (!users.includes(userId)) {
            users.push(userId);
            saveUsers(users);
            const joinMessage = `👋 *User Baru Bergabung!*\n\nNama: ${ctx.from.first_name}\nID: \`${userId}\`\nUsername: @${ctx.from.username || 'Tidak ada'}`;
            notifyOwner(ctx, joinMessage);
        }
    };

    const checkGroupAccess = (ctx) => {
        if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
            return true;
        }
        const groups = getWhitelistedGroups();
        const groupId = ctx.chat.id;
        return groups.includes(groupId);
    };

    const checkForcedJoin = async (ctx) => {
        const userId = ctx.from.id;
        if (userId === BOT_OWNER_ID) return { joined: true }; 

        const forcedJoins = getForcedJoins();
        const allJoins = [...forcedJoins.channels, ...forcedJoins.groups];

        if (allJoins.length === 0) return { joined: true };

        let notJoined = [];

        for (const chat of allJoins) {
            const chatId = chat.id; 
            try {
                const member = await ctx.telegram.getChatMember(chatId, userId);
                const status = member.status;
                if (status !== 'member' && status !== 'administrator' && status !== 'creator') {
                    notJoined.push(chat);
                }
            } catch (e) {
                console.error(`Gagal cek member di chat ${chatId}: ${e.message}`);
                notJoined.push(chat);
            }
        }

        if (notJoined.length > 0) {
            let message = "🚫 *Akses Ditolak*\n\nKamu harus bergabung ke semua channel/grup di bawah ini untuk menggunakan bot:\n\n";
            let buttons = [];
            notJoined.forEach(chat => {
                message += `➡️ ${chat.username || chat.id}\n`;
                if (chat.username) {
                    buttons.push([Markup.button.url(`Join ${chat.username}`, `https://t.me/${chat.username}`)]);
                }
            });
            message += "\nSilakan join dan coba /start lagi.";
            
            return { joined: false, message: message, buttons: Markup.inlineKeyboard(buttons) };
        }

        return { joined: true };
    };
    
    const checkAccess = (commandName, defaultAccessLevel = 'public', requiresPersonalSender = false) => async (ctx, next) => {
        const userId = ctx.from.id;
        addUser(ctx);

        if (commandName !== '/start') {
            const joinCheck = await checkForcedJoin(ctx);
            if (!joinCheck.joined) {
                return ctx.reply(joinCheck.message, { reply_markup: joinCheck.buttons.reply_markup });
            }
        }
        
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            if (!checkGroupAccess(ctx)) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('Hubungi Owner', `https.t.me/${config.ownerUsername}`)] 
                ]);
                return ctx.reply(config.message.groupNotAllowed, { 
                    parse_mode: 'Markdown', 
                    reply_markup: keyboard.reply_markup 
                });
            }
        }

        if (userId === BOT_OWNER_ID) return next();
        if (settings.botMode === 'self') return ctx.reply(config.message.selfMode, { parse_mode: 'Markdown' });
        if (settings.maintenance) return ctx.reply(config.message.maintenance, { parse_mode: 'Markdown' });
        
        const baseCommandName = commandName.startsWith('/') ? commandName.slice(1) : commandName;
        if (settings.commands && settings.commands[baseCommandName] === false) {
            return ctx.reply(config.message.commandOff, { parse_mode: 'Markdown' });
        }

        const currentAccessLevel = settings.accessLevel[baseCommandName] || defaultAccessLevel;

        if (currentAccessLevel === 'premium') {
            const isPremium = getPremiumUsers().includes(userId);
            if (!isPremium) return ctx.reply(config.message.premium, { parse_mode: 'Markdown' });
        }

        if (requiresPersonalSender) {
            const personalClient = getPersonalActiveClient(userId);
            if (!personalClient) {
                 return ctx.reply("❌ *Sender Pribadi Dibutuhkan*\n\nCommand ini wajib menggunakan sender WA pribadimu.\n\n1. Tambah sendermu: `/pairingsender <nomor>`\n2. Cek status: `/listsender`\n3. Aktifkan: `/setsender <ID_Sender_Pribadimu>`", { parse_mode: 'Markdown' });
            }
        }

        const isPremiumUser = getPremiumUsers().includes(userId);
        const cooldownDuration = isPremiumUser ? settings.cooldowns.premium : settings.cooldowns.default;
        const lastUsage = userCooldowns.get(userId) || 0;
        const now = Date.now();
        const timeSinceLastUsage = (now - lastUsage) / 1000;

        if (timeSinceLastUsage < cooldownDuration) {
            const remaining = Math.ceil(cooldownDuration - timeSinceLastUsage);
            return ctx.reply(config.message.cooldown(remaining), { parse_mode: 'Markdown' });
        }
        await next();
    };

    const checkToolsAccess = (commandName) => async (ctx, next) => {
        const userId = ctx.from.id;
        addUser(ctx);

        const joinCheck = await checkForcedJoin(ctx);
        if (!joinCheck.joined) {
            return ctx.reply(joinCheck.message, { reply_markup: joinCheck.buttons.reply_markup });
        }
        
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            if (!checkGroupAccess(ctx)) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('Hubungi Owner', `https://t.me/${config.ownerUsername}`)]
                ]);
                return ctx.reply(config.message.groupNotAllowed, { 
                    parse_mode: 'Markdown', 
                    reply_markup: keyboard.reply_markup 
                });
            }
        }
        
        if (userId === BOT_OWNER_ID) return next();
        if (settings.botMode === 'self') return ctx.reply(config.message.selfMode, { parse_mode: 'Markdown' });
        if (settings.maintenance) return ctx.reply(config.message.maintenance, { parse_mode: 'Markdown' });
        
        const baseCommandName = commandName.startsWith('/') ? commandName.slice(1) : commandName;
        if (settings.commands && settings.commands[baseCommandName] === false) {
            return ctx.reply(config.message.commandOff, { parse_mode: 'Markdown' });
        }
        await next();
    };

    const mainMenu = Markup.inlineKeyboard([
        [Markup.button.callback('👑 Menu Owner', 'owner_menu')],
        [Markup.button.callback('🔬 Cek WhatsApp', 'cek_menu')],
        [Markup.button.callback('🛠️ Tools', 'tools_menu')],
        [Markup.button.callback('🆘 Fix Merah', 'fix_merah_menu')],
        [Markup.button.callback('🌟 Menu Premium', 'premium_menu')], 
        [Markup.button.callback('🤝 Menu Referal', 'referral_menu')], 
        [Markup.button.callback('🎁 Tukar Poin', 'redeem_menu')], 
        [Markup.button.callback('ℹ️ Info', 'info_menu')],
        [Markup.button.url('Owner', `https://t.me/${config.ownerUsername}`), Markup.button.url('Channel', `https://t.me/${config.channelUsername}`)]
    ]);
    
    const ownerMenuPage1 = (ctx) => {
        let textRaw = `👑 Menu Khusus Owner (Halaman 1/3)

Sesi & Bot:
${IS_MAIN_BOT ? '/pairingmulti <nomor> - Pairing sesi WA baru (Global)\n/setsenderglobal <id_sesi> - Set sesi WA aktif (Global)\n/clearsesi - Hapus semua folder sesi WA\n/restart - Restart bot (butuh PM2)\n/jadibotlist - Lihat daftar sub-bot\n/delbot <id> - Hapus sub-bot' : '(Fitur Sesi Global & Manajemen Bot hanya ada di Bot Utama)'}

Manajemen Grup:
/addgroup <id/username> - Tambah grup ke whitelist
/delgroup <id> - Hapus grup dari whitelist
/listgroup - Daftar grup yang diizinkan

Manajemen User:
/addakses <id> - Nambahin akses premium
/delakses <id> - Ngabisin akses premium
/listusers - Lihat semua ID pengguna
/listpremium - Lihat ID premium
`;
        const textEscaped = escapeMarkdownV2(textRaw);
        const text = textEscaped
            .replace(escapeMarkdownV2(`👑 Menu Khusus Owner (Halaman 1/3)`), '👑 *Menu Khusus Owner \\(Halaman 1/3\\)*')
            .replace(escapeMarkdownV2(`Manajemen Grup:`), '*Manajemen Grup:*');

        const keyboard = Markup.inlineKeyboard([
            [{ text: '➡️ Halaman 2', callback_data: 'owner_menu_page_2' }],
            [{ text: '⬅️ Kembali ke Utama', callback_data: 'main_menu' }]
        ]);
        return { text, keyboard };
    };
    
    const ownerMenuPage2 = (ctx) => {
        const cdDefault = settings.cooldowns.default;
        const cdPremium = settings.cooldowns.premium;
        const mainSettings = readJSON(getDataPath('settings.json', null), config.defaultSettings);
        const batchSize = mainSettings.cekBioBatchSize; 
        const maintenanceStatus = settings.maintenance ? 'AKTIF' : 'NONAKTIF';
        const cekNumLimit = settings.cekNumberLimit || 10; 
        
        let textRaw = `👑 Menu Khusus Owner (Halaman 2/3)

Pengaturan Bot Dasar:
/broadcast <pesan> - Kirim pesan ke semua user
/maintenance <on/off> - Mode perbaikan
/addch <user/link> - Tambah Channel Wajib Join
/addgb <user/link> - Tambah Grup Wajib Join

Status Bot Saat Ini:
├ Maintenance: ${maintenanceStatus}
├ Cooldown Biasa: ${cdDefault}s
├ Cooldown Premium: ${cdPremium}s
├ Limit Cek Nomor: ${cekNumLimit} nomor
${IS_MAIN_BOT ? `└ Batch Cek Bio: ${batchSize} nomor (Global)` : ''}

Pengaturan Bot Lanjutan:
/setcd <d> - Set cooldown biasa (detik)
/setcdprem <d> - Set cooldown premium (detik)
/setnm <d> - Set limit /ceknumber (BARU)
${IS_MAIN_BOT ? '/setbatch <jumlah> - Set batch cek bio (Global)' : ''}
/off <cmd> - Nonaktifkan command
/on <cmd> - Aktifkan command
/pm <cmd> - Set command jadi Premium Only
/us <cmd> - Set command jadi Universal (All User)
`;
        const textEscaped = escapeMarkdownV2(textRaw);
        const text = textEscaped
            .replace(escapeMarkdownV2(`👑 Menu Khusus Owner (Halaman 2/3)`), '👑 *Menu Khusus Owner \\(Halaman 2/3\\)*')
            .replace(escapeMarkdownV2(`: ${maintenanceStatus}`), `: *${maintenanceStatus}*`)
            .replace(escapeMarkdownV2(`: ${cdDefault}s`), `: *${cdDefault}s*`)
            .replace(escapeMarkdownV2(`: ${cdPremium}s`), `: *${cdPremium}s*`)
            .replace(escapeMarkdownV2(`: ${cekNumLimit} nomor`), `: *${cekNumLimit} nomor*`) 
            .replace(escapeMarkdownV2(`: ${batchSize} nomor (Global)`), `: *${batchSize} nomor \\(Global\\)*`);

        const keyboard = Markup.inlineKeyboard([
            [{ text: '➡️ Halaman 3', callback_data: 'owner_menu_page_3' }],
            [{ text: '⬅️ Kembali ke Utama', callback_data: 'main_menu' }]
        ]);
        return { text, keyboard };
    };
    
    const ownerMenuPage3 = (ctx) => {
        let textRaw = `👑 Menu Khusus Owner (Halaman 3/3) - Fix Merah & Banding

Pengaturan Fix Merah (Biasa):
/listemail - Daftar email sender
/addemail <email>,<pass> - Tambah email
/delemail <id> - Hapus email
/setaktifemail <id> - Set email aktif

Pengaturan Banding (Premium):
/listemailprem - Daftar email premium
/addemailprem <email>,<pass> - Tambah email premium
/delemailprem <id> - Hapus email premium
/setaktifemailprem <id> - Set email premium aktif

Pengaturan Template (Global):
/listmt - Daftar template MT
/setmt <tujuan,subjek,isi> - Tambah template
/delmt <id> - Hapus template
/setaktifmt <id> - Set template aktif
`;
        const textEscaped = escapeMarkdownV2(textRaw);
        const text = textEscaped
            .replace(
                escapeMarkdownV2(`👑 Menu Khusus Owner (Halaman 3/3) - Fix Merah & Banding`), 
                '👑 *Menu Khusus Owner \\(Halaman 3/3\\) \\- Fix Merah & Banding*'
            );

        const keyboard = Markup.inlineKeyboard([
            [{ text: '⬅️ Halaman 2', callback_data: 'owner_menu_page_2' }],
            [{ text: '⬅️ Kembali ke Utama', callback_data: 'main_menu' }]
        ]);
        return { text, keyboard };
    };

    botInstance.action(['owner_menu', 'owner_menu_page_1'], async (ctx) => {
        if (ctx.from.id !== BOT_OWNER_ID) {
            return ctx.answerCbQuery('Menu ini khusus Owner!', { show_alert: true });
        }
        await ctx.answerCbQuery();
        const { text, keyboard } = ownerMenuPage1(ctx);
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup })
                .catch(() => ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }));
        } catch (e) {
            console.log("Gagal mengedit pesan menu owner page 1:", e.message);
        }
    });

    botInstance.action('owner_menu_page_2', async (ctx) => {
        if (ctx.from.id !== BOT_OWNER_ID) {
            return ctx.answerCbQuery('Menu ini khusus Owner!', { show_alert: true });
        }
        await ctx.answerCbQuery();
        const { text, keyboard } = ownerMenuPage2(ctx);
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup })
                .catch(() => ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }));
        } catch (e) {
            console.log("Gagal mengedit pesan menu owner page 2:", e.message);
        }
    });

    botInstance.action('owner_menu_page_3', async (ctx) => {
        if (ctx.from.id !== BOT_OWNER_ID) {
            return ctx.answerCbQuery('Menu ini khusus Owner!', { show_alert: true });
        }
        await ctx.answerCbQuery();
        const { text, keyboard } = ownerMenuPage3(ctx);
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup })
                .catch(() => ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }));
        } catch (e) {
            console.log("Gagal mengedit pesan menu owner page 3:", e.message);
        }
    });

    botInstance.start(checkAccess('/start'), async (ctx) => {
        const userId = ctx.from.id;
        addUser(ctx);
        
        const args = ctx.message.text.split(' ');
        if (args.length > 1 && args[1].startsWith('ref_')) {
            const refCode = args[1].split('_')[1];
            const referrals = getReferrals();
            let referrerId = null;

            for (const id in referrals) {
                if (referrals[id].code === refCode) {
                    referrerId = parseInt(id);
                    break;
                }
            }

            if (referrerId && referrerId !== userId) {
                const users = getUsers();
                
                if (!referrals[userId]) { 
                    if (!referrals[referrerId].referred) {
                        referrals[referrerId].referred = [];
                    }
                    
                    if (!referrals[referrerId].referred.includes(userId)) {
                        referrals[referrerId].referred.push(userId);
                        
                        referrals[userId] = { code: generateReferralCode(userId), referred: [] };
                        saveReferrals(referrals);

                        const points = getPoints();
                        const pointsPerRef = config.pointsPerReferral || 10;
                        points[referrerId] = (points[referrerId] || 0) + pointsPerRef;
                        savePoints(points);

                        await ctx.reply(`🎉 Kamu berhasil di-refer oleh user lain!`);
                        try {
                            await botInstance.telegram.sendMessage(referrerId, `✅ Selamat! User *${ctx.from.first_name}* (@${ctx.from.username || 'N/A'}) berhasil join menggunakan link referalmu.\nKamu mendapatkan *${pointsPerRef} Poin*!`, { parse_mode: 'Markdown' });
                        } catch (e) {
                            console.log("Gagal notif referrer:", e.message);
                        }
                    }
                }
            }
        }
        
        let referrals = getReferrals();
        if (!referrals[userId]) {
            referrals[userId] = { code: generateReferralCode(userId), referred: [] };
            saveReferrals(referrals);
        }

        const joinCheck = await checkForcedJoin(ctx);
        if (!joinCheck.joined) {
            return ctx.reply(joinCheck.message, { reply_markup: joinCheck.buttons.reply_markup });
        }
        
        const userName = ctx.from.first_name;
        let caption = `✨ *Wih, halo ${userName}!*
Gw siap bantu lu cek bio, download, dan berbagai tools lainnya. Pilih menu di bawah ini ya!`;
        
        if (IS_MAIN_BOT) {
            caption += `\n\nIngin bot ini ada di grupmu dengan token bot-mu sendiri? Pakai /jadibot`;
        }
        
        await ctx.replyWithPhoto({ url: config.photoStart }, { caption: caption, parse_mode: 'Markdown', reply_markup: mainMenu.reply_markup });
    });

    botInstance.action('main_menu', async (ctx) => {
        await ctx.answerCbQuery();
        
        const joinCheck = await checkForcedJoin(ctx);
        if (!joinCheck.joined) {
            return ctx.reply(joinCheck.message, { reply_markup: joinCheck.buttons.reply_markup });
        }
        
        const userName = ctx.from.first_name;
        let caption = `✨ *Wih, halo ${userName}!*
Ini menu utamanya. Mau ngapain kita hari ini?`;
        
        if (IS_MAIN_BOT) {
            caption += `\n\nIngin bot ini ada di grupmu dengan token bot-mu sendiri? Pakai /jadibot`;
        }
        
        try {
            await ctx.editMessageCaption(caption, { parse_mode: 'Markdown', reply_markup: mainMenu.reply_markup });
        } catch (e) {
            await ctx.reply(caption, { parse_mode: 'Markdown', reply_markup: mainMenu.reply_markup });
        }
    });

    botInstance.action('cek_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `🔬 *Menu Cek WhatsApp*

Fitur di bawah ini *WAJIB* menggunakan sender WA pribadimu.

/cekbio <nomor>... - Cek bio (Wajib Sender Pribadi)
/cekbiotxt (reply file .txt) - Cek bio dari file (Wajib Sender Pribadi)
/ceknumber <nomor>... - Cek nomor terdaftar (Wajib Sender Pribadi)
/cekbiru <nomor>... - Cek centang biru/hijau (Wajib Sender Pribadi)

*Pengaturan Sender (Wajib):*
/pairingsender <nomor> - Set sender WA pribadi
/setsender <id> - Pilih sender aktif (Pribadi/Global)
/listsender - Lihat daftar sender yang bisa kamu gunakan.`;
                     
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', 'main_menu')]).reply_markup });
        } catch (e) {
            console.log("Gagal edit pesan menu cek:", e.message);
        }
    });


    botInstance.action('tools_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `🛠️ *Menu Tools Lainnya*

/tiktok <url> - Download video TikTok tanpa watermark.
/tourl (reply media) - Upload gambar/video/audio ke web.
/stiker (reply gambar) - Buat stiker dari gambar.`;
                     
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', 'main_menu')]).reply_markup });
        } catch (e) {
            console.log("Gagal edit pesan menu tools:", e.message);
        }
    });

    botInstance.action('fix_merah_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `🆘 *Menu Bantuan "Fix Merah"*

Fitur ini akan mengirimkan email permohonan ke pihak WhatsApp untuk meninjau kembali nomor kamu. Fitur ini diatur oleh Owner bot.

Gunakan command:
/fixmerah <nomor>

Gunakan /banding <nomor> untuk versi premium (jika tersedia).

*Disclaimer:* Fitur ini hanya alat bantu untuk mengirim email. Tidak ada jaminan 100% nomor akan pulih.`;
                     
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', 'main_menu')]).reply_markup });
        } catch (e) {
            console.log("Gagal edit pesan menu fix merah:", e.message);
        }
    });

    botInstance.action('info_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `ℹ️ *Info Bot*

Bot multifungsi untuk kebutuhan WhatsApp dan tools lainnya. Dibuat untuk mempermudah pekerjaan sehari-hari.`;
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', 'main_menu')]).reply_markup });
        } catch (e) {
            console.log("Gagal edit pesan menu info:", e.message);
        }
    });

    botInstance.action('premium_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `🌟 *Menu Premium* 🌟

Fitur khusus untuk pengguna premium.

/cek <nomor> - Cek WA (Nomor, Bio, File) - (Premium)
/banding <nomor> - Kirim email banding (Premium)

Keuntungan Premium:
- Cooldown lebih cepat
- Akses command khusus premium`;
                     
        try {
            await ctx.editMessageCaption(text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', 'main_menu')]).reply_markup });
        } catch (e) {
            console.log("Gagal edit pesan menu premium:", e.message);
        }
    });

    const generateReferralCode = (userId) => {
        return Buffer.from(String(userId)).toString('base64').replace(/=/g, '');
    };

    botInstance.action('referral_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        
        let referrals = getReferrals();
        if (!referrals[userId]) {
            referrals[userId] = { code: generateReferralCode(userId), referred: [] };
            saveReferrals(referrals);
        }

        const myCode = referrals[userId].code;
        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=ref_${myCode}`;
        const totalReferred = referrals[userId].referred ? referrals[userId].referred.length : 0;
        const totalPoints = (getPoints()[userId] || 0);

        const text = `🤝 *Menu Referal* 🤝

Ajak temanmu menggunakan bot ini dan dapatkan poin!
Bagikan link di bawah ini ke temanmu.

🔗 *Link Anda:*
\`${refLink}\`

Setiap teman yang join menggunakan link-mu, kamu akan mendapatkan *${config.pointsPerReferral || 10} Poin*.

*Statistik Anda:*
- Total Referal: *${totalReferred} orang*
- Total Poin: *${totalPoints} Poin*

Gunakan poinmu di menu /tukarpoin.`;
                     
        try {
            await ctx.editMessageCaption(text, { 
                parse_mode: 'Markdown', 
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('Salin Manual', `manual_ref_link_${myCode}`)],
                    [Markup.button.callback('⬅️ Kembali', 'main_menu')]
                ]).reply_markup 
            });
        } catch (e) {
            console.log("Gagal edit pesan menu referral:", e.message);
        }
    });

    botInstance.action(/manual_ref_link_(.+)/, async (ctx) => {
        const refCode = ctx.match[1];
        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=ref_${refCode}`;
        await ctx.reply(refLink);
        await ctx.answerCbQuery("Link dikirim manual.");
    });
    
    const rewards = {
        '50': { name: 'Akses Premium 2 Hari', cost: 50, auto: true },
        '100': { name: 'Free Add Channel (5 Hari)', cost: 100, auto: false },
        '500': { name: 'Free Whitelist Grup (Permanen)', cost: 500, auto: false },
        '1000': { name: 'Free Jadibot (7 Hari)', cost: 1000, auto: false },
        '1500': { name: 'Free Nomor WhatsApp', cost: 1500, auto: false },
    };

    const showRedeemMenu = async (ctx) => {
        const userId = ctx.from.id;
        const userPoints = (getPoints()[userId] || 0);

        let text = `🎁 *Tukar Poin* 🎁\n\nPoin Anda saat ini: *${userPoints} Poin*\n\nPilih hadiah yang ingin kamu tukar:\n`;
        
        let buttons = [];
        Object.keys(rewards).forEach(cost => {
            const reward = rewards[cost];
            if (userPoints >= reward.cost) {
                buttons.push([Markup.button.callback(`✅ ${reward.name} (${reward.cost} Poin)`, `redeem_confirm_${cost}`)]);
            } else {
                buttons.push([Markup.button.callback(`🔒 ${reward.name} (${reward.cost} Poin)`, 'locked_reward')]);
            }
        });
        
        buttons.push([Markup.button.callback('⬅️ Kembali', 'main_menu')]);
        
        return { text, keyboard: Markup.inlineKeyboard(buttons) };
    };

    botInstance.action('redeem_menu', async (ctx) => {
        await ctx.answerCbQuery();
        
        const { text, keyboard } = await showRedeemMenu(ctx);
        
        try {
            await ctx.editMessageCaption(text, { 
                parse_mode: 'Markdown', 
                reply_markup: keyboard.reply_markup 
            });
        } catch (e) {
            try {
                await ctx.editMessageText(text, { 
                    parse_mode: 'Markdown', 
                    reply_markup: keyboard.reply_markup 
                });
            } catch (e2) {
                await ctx.reply(text, { 
                    parse_mode: 'Markdown', 
                    reply_markup: keyboard.reply_markup 
                });
            }
        }
    });
    
    botInstance.action('locked_reward', (ctx) => {
        ctx.answerCbQuery('Poin kamu tidak cukup untuk hadiah ini.', { show_alert: true });
    });
    
    botInstance.action(/redeem_confirm_(\d+)/, async (ctx) => {
        const cost = ctx.match[1];
        const reward = rewards[cost];
        if (!reward) return ctx.answerCbQuery('Hadiah tidak valid.');
        
        const userPoints = (getPoints()[ctx.from.id] || 0);
        if (userPoints < reward.cost) return ctx.answerCbQuery('Poin tidak cukup.', { show_alert: true });
        
        const text = `❓ *Konfirmasi Penukaran* ❓

Kamu akan menukar *${reward.cost} Poin* dengan *${reward.name}*.

Yakin mau lanjut?`;
        
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('✅ Ya, Konfirmasi', `redeem_do_${cost}`), Markup.button.callback('❌ Batal', 'redeem_menu')]
            ]).reply_markup
        });
    });

    botInstance.action(/redeem_do_(\d+)/, async (ctx) => {
        const cost = parseInt(ctx.match[1]);
        const reward = rewards[cost];
        const userId = ctx.from.id;
        
        if (!reward) return ctx.answerCbQuery('Hadiah tidak valid.');
        
        let points = getPoints();
        const userPoints = (points[userId] || 0);
        
        if (userPoints < cost) return ctx.answerCbQuery('Poin tidak cukup.', { show_alert: true });
        
        points[userId] = userPoints - cost;
        savePoints(points);
        
        let redeemed = getRedeemedRewards();
        if (!redeemed[userId]) redeemed[userId] = [];
        
        let replyMessage = '';

        if (reward.auto) {
            if (cost === 50) {
                let premiumUsers = getPremiumUsers();
                if (!premiumUsers.includes(userId)) {
                    premiumUsers.push(userId);
                    savePremiumUsers(premiumUsers);
                }
                const expiry = Date.now() + (2 * 24 * 60 * 60 * 1000);
                redeemed[userId].push({ reward: reward.name, expiry: expiry });
                saveRedeemedRewards(redeemed);
                
                replyMessage = `🎉 *Berhasil!* 🎉\n\nKamu berhasil menukar *${cost} Poin*.\nAkunmu sekarang *Premium* selama 2 Hari.`;
            }
        } else {
            redeemed[userId].push({ reward: reward.name, claimedAt: Date.now() });
            saveRedeemedRewards(redeemed);
            
            replyMessage = `🎉 *Berhasil Klaim!* 🎉\n\nKamu berhasil klaim *${reward.name}*.\n\nSilakan *SCREENSHOT* pesan ini dan kirim ke Owner (@${config.ownerUsername}) untuk proses klaim hadiah manual.`;
            
            notifyOwner(ctx, `🎁 *Klaim Hadiah Manual*\n\nUser: ${ctx.from.first_name} (\`${userId}\`)\nHadiah: *${reward.name}*\nMohon tunggu konfirmasi dari user.`);
        }
        
        await ctx.editMessageText(replyMessage, { parse_mode: 'Markdown' });
    });


    botInstance.on('new_chat_members', async (ctx) => {
        const botMember = ctx.message.new_chat_members.find(member => member.id === ctx.botInfo.id);
        if (botMember) {
            const adderId = ctx.message.from.id;
            if (adderId !== BOT_OWNER_ID) {
                const inviterName = ctx.message.from.first_name;
                const groupTitle = ctx.chat.title;
                const message = `Halo ${inviterName}, bot ini hanya dapat di-add oleh Owner (@${(await ctx.telegram.getChat(BOT_OWNER_ID)).username}). Mohon maaf, bot akan keluar dari grup *${groupTitle}*.\n\nHubungi Owner untuk akses grup.`;
                await ctx.reply(message, { 
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.url('Hubungi Owner', `tg://user?id=${BOT_OWNER_ID}`)]
                    ]).reply_markup
                });
                await ctx.leaveChat();
                
                notifyOwner(ctx, `🚨 *Bot Ditolak Otomatis*\n\nBot ditambahkan ke grup: ${groupTitle} (\`${ctx.chat.id}\`)\nOleh: ${inviterName} (\`${adderId}\`)\nBot telah keluar karena non-Owner yang menambahkan.`);
            } else {
                const groupTitle = ctx.chat.title;
                const groupId = ctx.chat.id;
                const link = ctx.chat.invite_link ? `[${groupTitle}](${ctx.chat.invite_link})` : groupTitle;
                const members = await ctx.getChatMembersCount();
                
                const message = `✅ *Bot Berhasil Di-add oleh Owner!*\n\n*Grup:* ${link}\n*ID:* \`${groupId}\`\n*Member:* ${members}`;
                notifyOwner(ctx, message);
            }
        }
    });

    const addJoinable = async (ctx, type) => {
        const input = ctx.message.text.split(' ')[1];
        if (!input) return ctx.reply(`Format salah. Contoh: /${type} @username`);

        let chat;
        try {
            chat = await ctx.telegram.getChat(input);
        } catch (e) {
            return ctx.reply(`Gagal mendapatkan info chat untuk ${input}. Pastikan username/link benar dan bot adalah admin di channel/grup (jika private).`);
        }

        const chatData = { id: chat.id, username: chat.username };
        const forcedJoins = getForcedJoins();
        
        const list = (type === 'addch') ? forcedJoins.channels : forcedJoins.groups;
        
        if (list.some(c => c.id === chatData.id)) {
            return ctx.reply(`${type === 'addch' ? 'Channel' : 'Grup'} @${chatData.username} sudah ada di daftar.`);
        }

        list.push(chatData);
        saveForcedJoins(forcedJoins);
        ctx.reply(`✅ ${type === 'addch' ? 'Channel' : 'Grup'} @${chatData.username} berhasil ditambahkan ke daftar wajib join.`);
    };

    botInstance.command('addch', checkAccess('addch', 'owner'), (ctx) => addJoinable(ctx, 'addch'));
    botInstance.command('addgb', checkAccess('addgb', 'owner'), (ctx) => addJoinable(ctx, 'addgb'));


    botInstance.command('addgroup', checkAccess('addgroup', 'owner'), async (ctx) => {
        const input = ctx.message.text.split(' ')[1];
        if (!input) return ctx.reply("Format salah. Contoh:\n`/addgroup 123456789` (ID)\n`/addgroup @usernamegroup` (Username)");
        
        let groupId;
        let groupUsername;
        
        if (input.startsWith('@')) {
            groupUsername = input.slice(1);
        } else {
            groupId = parseInt(input);
            if (isNaN(groupId)) return ctx.reply("Input harus berupa ID angka atau Username grup.");
        }

        try {
            const chat = await ctx.telegram.getChat(groupId || groupUsername);
            groupId = chat.id;
            
            let groups = getWhitelistedGroups();
            if (groups.includes(groupId)) return ctx.reply(`Grup *${chat.title}* (\`${groupId}\`) sudah ada di whitelist.`);
            
            groups.push(groupId);
            saveWhitelistedGroups(groups);
            
            ctx.reply(`✅ Grup *${chat.title}* (\`${groupId}\`) berhasil ditambahkan ke whitelist.`);
            
        } catch (e) {
            ctx.reply(`❌ Gagal menambahkan grup. Pastikan bot ada di grup tersebut dan ID/Username benar.`);
        }
    });

    botInstance.command('delgroup', checkAccess('delgroup', 'owner'), (ctx) => {
        const id = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(id)) return ctx.reply('ID grup harus angka.');
        
        let groups = getWhitelistedGroups();
        const initialLength = groups.length;
        groups = groups.filter(gId => gId !== id);
        
        if (groups.length === initialLength) return ctx.reply(`ID grup ${id} tidak ditemukan di whitelist.`);
        
        saveWhitelistedGroups(groups);
        ctx.reply(`✅ Grup dengan ID \`${id}\` berhasil dihapus dari whitelist.`);
    });

    botInstance.command('listgroup', checkAccess('listgroup', 'owner'), async (ctx) => {
        const groups = getWhitelistedGroups();
        if (groups.length === 0) return ctx.reply('Belum ada grup yang terdaftar di whitelist.');
        
        let message = `👥 *Daftar Grup yang Diizinkan:* (${groups.length} Grup)\n\n`;
        
        for (const groupId of groups) {
            try {
                const chat = await ctx.telegram.getChat(groupId);
                message += `- *${chat.title}* (\`${groupId}\`)\n`;
            } catch (e) {
                message += `- ID Tidak Dikenal: \`${groupId}\` (Bot mungkin sudah keluar)\n`;
            }
        }
        
        ctx.reply(message, { parse_mode: 'Markdown' });
    });
    
    if (IS_MAIN_BOT) {
        botInstance.command('pairingmulti', checkAccess('pairingmulti', 'owner'), async (ctx) => {
            const phoneNumber = ctx.message.text.split(' ')[1]?.replace(/[^0-9]/g, '');
            if (!phoneNumber) return ctx.reply("Formatnya salah bos.\nContoh: /pairingmulti 62812...");
            if (waClients.has(phoneNumber)) return ctx.reply(`Sesi untuk nomor ${phoneNumber} sudah ada.`);

            await ctx.reply('Memulai sesi pairing baru (Global)...');
            await startWhatsAppClient(phoneNumber, null); 
            
            setTimeout(async () => {
                const clientData = waClients.get(phoneNumber);
                if (!clientData || !clientData.client) return ctx.reply(`Gagal memulai client untuk ${phoneNumber}.`);
                
                try {
                    const code = await clientData.client.requestPairingCode(phoneNumber);
                    await ctx.reply(`📲 Nih kodenya untuk nomor *${phoneNumber}* (Global Sender): \`${code}\`\n\nMasukin di WA lu:\n*Tautkan Perangkat > Tautkan dengan nomor telepon*`, { parse_mode: 'Markdown' });
                } catch (e) {
                    console.error("Gagal pairing:", e);
                    await ctx.reply(`Gagal minta pairing code, bos. Coba lagi ntar.`);
                }
            }, 3000);
        });

        botInstance.command('setsenderglobal', checkAccess('setsenderglobal', 'owner'), async (ctx) => {
            const inputId = ctx.message.text.split(' ')[1];
            if (!inputId) return ctx.reply('Sebutkan ID sesi global yang mau diset.');
            
            const clientData = waClients.get(inputId);
            if (!clientData || clientData.ownerId !== null) {
                return ctx.reply("❌ ID Sender tidak valid atau bukan Sender Global.");
            }

            const newSettings = getSettings(); 
            newSettings.activeSender = inputId;
            saveSettings(newSettings);
            ctx.reply(`✅ Sender Global aktif diatur ke *${inputId}*.`, { parse_mode: 'Markdown' });
        });
        
        botInstance.command('restart', checkAccess('restart', 'owner'), async (ctx) => {
            await ctx.reply('🤖 Merestart bot...');
            process.exit(1);
        });

        botInstance.command('clearsesi', checkAccess('clearsesi', 'owner'), async (ctx) => {
            try {
                waClients.forEach(clientData => clientData.client.logout());
                waClients.clear();
                fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
                fs.mkdirSync(SESSIONS_DIR);
                saveUserSessions({}); 
                await ctx.reply('✅ Semua sesi WhatsApp (Global & Pribadi) telah dihapus dan koneksi dihentikan.');
            } catch (e) {
                console.error(e);
                await ctx.reply(`❌ Gagal membersihkan sesi: ${e.message}`);
            }
        });
        
        botInstance.command('setbatch', checkAccess('setbatch', 'owner'), (ctx) => {
            const batchSize = parseInt(ctx.message.text.split(' ')[1]);
            if (isNaN(batchSize) || batchSize <= 0) return ctx.reply("Batch size harus angka positif.");
            const newSettings = getSettings(); 
            newSettings.cekBioBatchSize = batchSize;
            saveSettings(newSettings);
            ctx.reply(`✅ Batch size cek bio (Global) diatur ke *${batchSize} nomor*.`, { parse_mode: 'Markdown' });
        });
        
        botInstance.command('jadibotlist', checkAccess('jadibotlist', 'owner'), (ctx) => {
            const subBots = getSubBots();
            const botIds = Object.keys(subBots);
            if (botIds.length === 0) return ctx.reply("Belum ada sub-bot yang aktif.");
            
            let message = `🤖 *Daftar Sub-Bot Aktif:*\n\n`;
            botIds.forEach(userId => {
                const botData = subBots[userId];
                const expiryDate = new Date(botData.expiry).toLocaleString('id-ID');
                const botStatus = activeSubBots.has(parseInt(userId)) ? '🟢 Aktif' : '🔴 Mati';
                
                message += `*User:* \`${userId}\`\n*Bot:* \`@${botData.botUsername}\`\n*Status:* ${botStatus}\n*Kedaluwarsa:* \`${expiryDate}\`\n\n`;
            });
            ctx.reply(message, { parse_mode: 'Markdown' });
        });

        
        botInstance.command('delbot', checkAccess('delbot', 'owner'), async (ctx) => {
            const targetId = parseInt(ctx.message.text.split(' ')[1]);
            if (isNaN(targetId)) return ctx.reply("ID User sub-bot harus angka.");
            
            const subBots = getSubBots();
            if (!subBots[targetId]) return ctx.reply(`Sub-bot dengan ID User \`${targetId}\` tidak ditemukan.`);
            
            const botUsername = subBots[targetId].botUsername;
            
            if (activeSubBots.has(targetId)) {
                activeSubBots.get(targetId).stop('SIGINT');
                activeSubBots.delete(targetId);
            }
            
            delete subBots[targetId];
            saveSubBots(subBots);
            
            await ctx.reply(`✅ Sub-bot *@${botUsername}* (\`${targetId}\`) berhasil dihentikan dan dihapus dari database.`);
            try {
                await bot.telegram.sendMessage(targetId, `🚨 *Bot Kamu Dihentikan Owner*\n\nBot *@${botUsername}* kamu telah dihentikan oleh Owner utama. Silahkan hubungi Owner untuk informasi lebih lanjut.`, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error(`Gagal notif user ${targetId} soal delbot:`, e.message);
            }
        });
    }

    botInstance.command('setnm', checkAccess('setnm', 'owner'), (ctx) => {
        const limit = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(limit) || limit <= 0) return ctx.reply("Limit harus angka positif.");
        const newSettings = getSettings();
        newSettings.cekNumberLimit = limit;
        saveSettings(newSettings);
        ctx.reply(`✅ Limit /ceknumber diatur ke *${limit} nomor*.`, { parse_mode: 'Markdown' });
    });

    botInstance.command(['pm', 'us'], checkAccess('manageaccess', 'owner'), (ctx) => {
        const commandType = ctx.message.text.split(' ')[0].slice(1);
        const targetCmd = ctx.message.text.split(' ')[1]?.toLowerCase();
        
        if (!targetCmd) return ctx.reply('Sebutkan command yang mau diatur. Contoh: `/pm cekbio`');
        const ownerCommands = ['pm', 'us', 'addakses', 'delakses', 'listusers', 'listpremium', 'broadcast', 'maintenance', 'setcd', 'setcdprem', 'off', 'on', 'listemail', 'addemail', 'delemail', 'setaktifemail', 'listmt', 'setmt', 'delmt', 'setaktifmt', 'addemailprem', 'listemailprem', 'delemailprem', 'setaktifemailprem', 'setnm', 'addch', 'addgb'];
        if (ownerCommands.includes(targetCmd)) return ctx.reply(`Command \`${targetCmd}\` adalah command owner, tidak bisa diatur aksesnya.`);

        const newAccessLevel = (commandType === 'pm') ? 'premium' : 'public';
        const newSettings = getSettings();
        newSettings.accessLevel = newSettings.accessLevel || {};
        newSettings.accessLevel[targetCmd] = newAccessLevel;
        saveSettings(newSettings);
        
        const statusText = (newAccessLevel === 'premium') ? 'PREMIUM ONLY 👑' : 'UNIVERSAL (Semua User) 🌍';
        ctx.reply(`✅ Akses command \`${targetCmd}\` sekarang diatur ke: *${statusText}*`, { parse_mode: 'Markdown' });
    });


    botInstance.command(['addakses', 'delakses'], checkAccess('akses', 'owner'), (ctx) => {
        const command = ctx.message.text.split(' ')[0].slice(1);
        const targetId = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(targetId)) return ctx.reply("ID-nya angka, bos.");
        let premiumUsers = getPremiumUsers(); 
        if (command === 'addakses') {
            if (premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} udah premium dari kapan tau.`);
            premiumUsers.push(targetId);
            savePremiumUsers(premiumUsers);
            ctx.reply(`✅ Siap! ID ${targetId} sekarang jadi member premium di bot ini.`);
            ctx.telegram.sendMessage(targetId, "Selamat! Akunmu telah diupgrade menjadi premium.").catch(() => {});
        } else {
            if (!premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} emang bukan premium, bos.`);
            const newUsers = premiumUsers.filter(id => id !== targetId);
            savePremiumUsers(newUsers);
            ctx.reply(`✅ Oke, ID ${targetId} udah gw cabut premiumnya di bot ini.`);
            ctx.telegram.sendMessage(targetId, "Akses premium kamu telah dicabut.").catch(() => {});
        }
    });

    botInstance.command('listusers', checkAccess('listusers', 'owner'), async (ctx) => {
        const users = getUsers(); 
        let message = `👥 *Total User di Bot Ini:* ${users.length}\n\n`;
        message += users.map(id => `\`${id}\``).join('\n');
        await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    botInstance.command('listpremium', checkAccess('listpremium', 'owner'), async (ctx) => {
        const users = getPremiumUsers(); 
        let message = `👑 *Total Premium User di Bot Ini:* ${users.length}\n\n`;
        message += users.map(id => `\`${id}\``).join('\n');
        await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    botInstance.command('broadcast', checkAccess('broadcast', 'owner'), async (ctx) => {
        const message = ctx.message.text.split(' ').slice(1).join(' ');
        if (!message) return ctx.reply("Pesan broadcastnya mana, bos?");
        const users = getUsers(); 
        await ctx.reply(`Otw broadcast ke ${users.length} pengguna bot ini...`);
        let success = 0, failed = 0;
        for (const userId of users) {
            try {
                await botInstance.telegram.sendMessage(userId, message);
                success++;
            } catch (error) {
                failed++;
            }
            await sleep(100);
        }
        await ctx.reply(`Broadcast selesai!\n✅ Berhasil: ${success}\n❌ Gagal: ${failed}`);
    });

    botInstance.command('maintenance', checkAccess('maintenance', 'owner'), (ctx) => {
        const state = ctx.message.text.split(' ')[1]?.toLowerCase();
        const newSettings = getSettings();
        if (state === 'on') {
            newSettings.maintenance = true;
            saveSettings(newSettings);
            ctx.reply('🔧 Mode maintenance *AKTIF*. Semua user kecuali Owner tidak bisa menggunakan bot ini.');
        } else if (state === 'off') {
            newSettings.maintenance = false;
            saveSettings(newSettings);
            ctx.reply('✅ Mode maintenance *NONAKTIF*. Bot ini kembali normal.');
        } else {
            ctx.reply('Gunakan `/maintenance on` atau `/maintenance off`.');
        }
    });

    botInstance.command('setcd', checkAccess('setcd', 'owner'), (ctx) => {
        const duration = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(duration) || duration < 0) return ctx.reply("Durasi cooldown harus angka positif.");
        const newSettings = getSettings();
        newSettings.cooldowns.default = duration;
        saveSettings(newSettings);
        ctx.reply(`✅ Cooldown biasa diatur ke *${duration} detik*.`, { parse_mode: 'Markdown' });
    });

    botInstance.command('setcdprem', checkAccess('setcdprem', 'owner'), (ctx) => {
        const duration = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(duration) || duration < 0) return ctx.reply("Durasi cooldown harus angka positif.");
        const newSettings = getSettings();
        newSettings.cooldowns.premium = duration;
        saveSettings(newSettings);
        ctx.reply(`✅ Cooldown premium diatur ke *${duration} detik*.`, { parse_mode: 'Markdown' });
    });

    botInstance.command(['on', 'off'], checkAccess('togglecommand', 'owner'), (ctx) => {
        const command = ctx.message.text.split(' ')[0].slice(1);
        const targetCmd = ctx.message.text.split(' ')[1]?.toLowerCase();
        
        if (!targetCmd) return ctx.reply('Sebutkan command yang mau diatur. Contoh: `/on cekbio`');

        const status = (command === 'on');
        const newSettings = getSettings();
        newSettings.commands = newSettings.commands || {};
        newSettings.commands[targetCmd] = status;
        saveSettings(newSettings);
        
        const statusText = status ? 'AKTIF' : 'NONAKTIF';
        ctx.reply(`✅ Command \`${targetCmd}\` sekarang *${statusText}* untuk pengguna.`, { parse_mode: 'Markdown' });
    });

    botInstance.command('listemail', checkAccess('listemail', 'owner'), (ctx) => {
        const emails = getEmails();
        const activeId = getSettings().activeEmailId;
        if (emails.length === 0) return ctx.reply('Belum ada email sender (biasa) yang terdaftar.');
        
        let message = '📧 *Daftar Email Sender (Biasa):*\n\n';
        emails.forEach(e => {
            const status = e.id === activeId ? ' (AKTIF)' : '';
            message += `ID: \`${e.id}\`\nEmail: \`${e.email}\`${status}\n\n`;
        });
        ctx.reply(message, { parse_mode: 'Markdown' });
    });

    botInstance.command('addemail', checkAccess('addemail', 'owner'), (ctx) => {
        const args = ctx.message.text.split(' ').slice(1).join(' ').split(',');
        if (args.length !== 2) return ctx.reply('Format salah. Gunakan: /addemail email,app_password');
        const [email, pass] = args.map(arg => arg.trim());
        const emails = getEmails();
        const newEmail = { id: Date.now(), email, pass };
        emails.push(newEmail);
        saveEmails(emails);
        ctx.reply(`✅ Email (biasa) ${email} berhasil ditambahkan dengan ID: ${newEmail.id}`);
    });

    botInstance.command('delemail', checkAccess('delemail', 'owner'), (ctx) => {
        const id = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(id)) return ctx.reply('ID tidak valid.');
        let emails = getEmails();
        const initialLength = emails.length;
        emails = emails.filter(e => e.id !== id);
        if (emails.length === initialLength) return ctx.reply('Email (biasa) dengan ID tersebut tidak ditemukan.');
        saveEmails(emails);
        ctx.reply(`✅ Email (biasa) dengan ID ${id} berhasil dihapus.`);
    });

    botInstance.command('setaktifemail', checkAccess('setaktifemail', 'owner'), (ctx) => {
        const id = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(id)) return ctx.reply('ID tidak valid.');
        const emails = getEmails();
        if (!emails.some(e => e.id === id)) return ctx.reply('Email (biasa) dengan ID tersebut tidak ditemukan.');
        const newSettings = getSettings();
        newSettings.activeEmailId = id;
        saveSettings(newSettings);
        ctx.reply(`✅ Email (biasa) aktif diatur ke ID ${id}.`);
    });

    botInstance.command('listemailprem', checkAccess('listemailprem', 'owner'), (ctx) => {
        const emails = getPremiumEmails();
        const activeId = getSettings().activePremiumEmailId;
        if (emails.length === 0) return ctx.reply('Belum ada email sender (premium) yang terdaftar.');
        
        let message = '📧 *Daftar Email Sender (Premium):*\n\n';
        emails.forEach(e => {
            const status = e.id === activeId ? ' (AKTIF)' : '';
            message += `ID: \`${e.id}\`\nEmail: \`${e.email}\`${status}\n\n`;
        });
        ctx.reply(message, { parse_mode: 'Markdown' });
    });

    botInstance.command('addemailprem', checkAccess('addemailprem', 'owner'), (ctx) => {
        const args = ctx.message.text.split(' ').slice(1).join(' ').split(',');
        if (args.length !== 2) return ctx.reply('Format salah. Gunakan: /addemailprem email,app_password');
        const [email, pass] = args.map(arg => arg.trim());
        const emails = getPremiumEmails();
        const newEmail = { id: Date.now(), email, pass };
        emails.push(newEmail);
        savePremiumEmails(emails);
        ctx.reply(`✅ Email (premium) ${email} berhasil ditambahkan dengan ID: ${newEmail.id}`);
    });

    botInstance.command('delemailprem', checkAccess('delemailprem', 'owner'), (ctx) => {
        const id = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(id)) return ctx.reply('ID tidak valid.');
        let emails = getPremiumEmails();
        const initialLength = emails.length;
        emails = emails.filter(e => e.id !== id);
        if (emails.length === initialLength) return ctx.reply('Email (premium) dengan ID tersebut tidak ditemukan.');
        savePremiumEmails(emails);
        ctx.reply(`✅ Email (premium) dengan ID ${id} berhasil dihapus.`);
    });

    botInstance.command('setaktifemailprem', checkAccess('setaktifemailprem', 'owner'), (ctx) => {
        const id = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(id)) return ctx.reply('ID tidak valid.');
        const emails = getPremiumEmails();
        if (!emails.some(e => e.id === id)) return ctx.reply('Email (premium) dengan ID tersebut tidak ditemukan.');
        const newSettings = getSettings();
        newSettings.activePremiumEmailId = id;
        saveSettings(newSettings);
        ctx.reply(`✅ Email (premium) aktif diatur ke ID ${id}.`);
    });

    botInstance.command('listmt', checkAccess('listmt', 'owner'), (ctx) => {
        const templates = getTemplates();
        const activeId = getSettings().activeTemplateId;
        if (templates.length === 0) return ctx.reply('Belum ada template MT yang terdaftar.');
        
        let message = '📝 *Daftar Template Fix Merah:*\n\n';
        templates.forEach(t => {
            const status = t.id === activeId ? ' (AKTIF)' : '';
            const bodySnippet = t.body.substring(0, 50).replace(/\n/g, ' ') + '...';
            message += `ID: \`${t.id}\`${status}\nSubjek: \`${t.subject}\`\nTo: \`${t.to}\`\nBody: \`${bodySnippet}\`\n\n`;
        });
        ctx.reply(message, { parse_mode: 'Markdown' });
    });

    botInstance.command('setmt', checkAccess('setmt', 'owner'), (ctx) => {
        const args = ctx.message.text.split(' ').slice(1).join(' ').split(',');
        if (args.length < 3) return ctx.reply('Format salah. Gunakan: /setmt email_tujuan, subjek, isi_pesan');
        const [to, subject] = args.slice(0, 2).map(arg => arg.trim());
        const body = args.slice(2).join(',').trim();
        if (!body.includes('{nomor}')) return ctx.reply('Isi pesan harus mengandung placeholder `{nomor}`.');
        
        const templates = getTemplates();
        const newTemplate = { id: Date.now(), to, subject, body };
        templates.push(newTemplate);
        saveTemplates(templates);
        ctx.reply(`✅ Template MT berhasil ditambahkan dengan ID: ${newTemplate.id}`);
    });

    botInstance.command('delmt', checkAccess('delmt', 'owner'), (ctx) => {
        const id = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(id)) return ctx.reply('ID tidak valid.');
        let templates = getTemplates();
        const initialLength = templates.length;
        templates = templates.filter(t => t.id !== id);
        if (templates.length === initialLength) return ctx.reply('Template dengan ID tersebut tidak ditemukan.');
        saveTemplates(templates);
        ctx.reply(`✅ Template dengan ID ${id} berhasil dihapus.`);
    });

    botInstance.command('setaktifmt', checkAccess('setaktifmt', 'owner'), (ctx) => {
        const id = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(id)) return ctx.reply('ID tidak valid.');
        const templates = getTemplates();
        if (!templates.some(t => t.id === id)) return ctx.reply('Template dengan ID tersebut tidak ditemukan.');
        const newSettings = getSettings();
        newSettings.activeTemplateId = id;
        saveSettings(newSettings);
        ctx.reply(`✅ Template MT aktif diatur ke ID ${id}.`);
    });
    
    botInstance.command('pairingsender', checkAccess('pairingsender', 'public'), async (ctx) => {
        const userId = ctx.from.id;
        const phoneNumber = ctx.message.text.split(' ')[1]?.replace(/[^0-9]/g, '');
        if (!phoneNumber) return ctx.reply("Format salah. Contoh: /pairingsender 62812...");

        const uSessions = getUserSessions();
        if (uSessions[userId] && uSessions[userId].sessions && uSessions[userId].sessions[phoneNumber]) {
            return ctx.reply(`Kamu sudah memiliki Sender Pribadi dengan nomor ini (\`${phoneNumber}\`).`);
        }
        
        const sessionId = phoneNumber; 
        if (waClients.has(sessionId)) return ctx.reply(`Sesi untuk nomor ${phoneNumber} sudah digunakan oleh user lain.`);

        await ctx.reply('Memulai sesi pairing baru (Pribadi)...');
        await startWhatsAppClient(sessionId, userId); 
        
        setTimeout(async () => {
            const clientData = waClients.get(sessionId);
            if (!clientData || !clientData.client) return ctx.reply(`Gagal memulai client untuk ${sessionId}.`);
            
            try {
                const code = await clientData.client.requestPairingCode(phoneNumber);
                
                if (!uSessions[userId]) {
                    uSessions[userId] = { sessions: {}, activeSessionId: null };
                }
                if (!uSessions[userId].sessions) {
                    uSessions[userId].sessions = {};
                }
                
                uSessions[userId].sessions[sessionId] = {
                    phoneNumber: phoneNumber,
                    status: 'connecting'
                };
                uSessions[userId].activeSessionId = sessionId; 
                saveUserSessions(uSessions);
                
                await ctx.reply(`📲 Nih kodenya untuk nomor *${phoneNumber}* (Pribadi/ID: \`${sessionId}\`): \`${code}\`\n\nMasukin di WA lu:\n*Tautkan Perangkat > Tautkan dengan nomor telepon*\n\nSender ini otomatis diatur sebagai sender aktifmu.`, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error("Gagal pairing:", e);
                await ctx.reply(`Gagal minta pairing code, coba lagi ntar.`);
            }
        }, 3000);
    });

    botInstance.command('listsender', checkAccess('listsender', 'public'), async (ctx) => {
        const userId = ctx.from.id;
        let message = '⚡ *Daftar Sender yang Bisa Kamu Gunakan:*\n\n';
        
        const mainSettings = readJSON(getDataPath('settings.json', null), config.defaultSettings);
        const globalActive = mainSettings.activeSender;
        const uSessions = getUserSessions();
        const userSessionData = uSessions[userId];
        const userActiveId = userSessionData?.activeSessionId;

        message += `*Pribadi (Sender-mu)*:\n`;
        let hasPersonal = false;
        if (userSessionData && userSessionData.sessions) {
            for (const sessionId in userSessionData.sessions) {
                hasPersonal = true;
                const session = userSessionData.sessions[sessionId];
                const statusData = waClients.get(sessionId);
                const statusIcon = statusData?.status === 'open' ? '🟢' : (statusData?.status === 'connecting' ? '🟡' : '🔴');
                const isActive = sessionId === userActiveId ? ' (Aktif)' : '';
                message += `- ID: \`${sessionId}\`\n`;
                message += `  Nomor: \`${session.phoneNumber}\`\n`;
                message += `  Status: ${statusIcon} ${statusData?.status || 'closed'}${isActive}\n\n`;
            }
        }
        if (!hasPersonal) {
             message += `(Belum di-set. Gunakan /pairingsender)\n\n`;
        }
        
        const globalStatusData = waClients.get(globalActive);
        const globalStatusIcon = globalStatusData?.status === 'open' ? '🟢' : (globalStatusData?.status === 'connecting' ? '🟡' : '🔴');
        const globalIsActive = globalActive === userActiveId ? ' (Aktif)' : '';
        
        message += `*Global (Sender Owner)*:\n`;
        if (globalActive) {
            message += `- ID: \`GLOBAL_${globalActive}\`\n`;
            message += `- Status: ${globalStatusIcon} ${globalStatusData?.status || 'closed'}${globalIsActive}\n\n`;
        } else {
            message += `(Owner belum set sender global)\n\n`;
        }
        
        message += `Gunakan \`/setsender <ID>\` untuk memilih sender aktif.\nCommand /cekbio, /ceknumber, /cekbiotxt, /cek *wajib* menggunakan sender Pribadi.`;
        
        if (userId === MAIN_OWNER_ID) {
            message += `\n\n------------------------------\n👑 *Panel Owner Utama:*\nTotal Sesi Aktif di Bot: ${waClients.size}\n`;
             message += `\n*Semua Sesi User:*\n`;
             let count = 0;
             for (const uId in uSessions) {
                 for (const sId in uSessions[uId].sessions) {
                     count++;
                     message += `  - \`${sId}\` (User: \`${uId}\`)\n`;
                 }
             }
             if (count === 0) message += `(Belum ada sesi user)\n`;
             
             message += `\n*Semua Sesi Global:*\n`;
             count = 0;
             waClients.forEach((client, sId) => {
                 if (client.ownerId === null) {
                     count++;
                     const isActive = sId === globalActive ? ' (GLOBAL AKTIF)' : '';
                     message += `  - \`${sId}\`${isActive}\n`;
                 }
             });
             if (count === 0) message += `(Belum ada sesi global)\n`;
        }
        
        ctx.reply(message, { parse_mode: 'Markdown' });
    });

    botInstance.command('setsender', checkAccess('setsender', 'public'), async (ctx) => {
        const userId = ctx.from.id;
        const inputId = ctx.message.text.split(' ')[1];
        if (!inputId) return ctx.reply('Sebutkan ID sender yang mau diset. Cek di /listsender.');

        let uSessions = getUserSessions();
        const mainSettings = readJSON(getDataPath('settings.json', null), config.defaultSettings);

        let targetSessionId = null;
        let type = null;

        const userSessionData = uSessions[userId];
        if (userSessionData && userSessionData.sessions && userSessionData.sessions[inputId]) {
            targetSessionId = inputId;
            type = 'Pribadi';
        } 
        
        if (inputId === `GLOBAL_${mainSettings.activeSender}`) {
            targetSessionId = mainSettings.activeSender;
            type = 'Global';
        } 
        
        if (!targetSessionId) {
            return ctx.reply("❌ ID Sender tidak valid atau bukan milikmu. Cek ID di /listsender.");
        }
        
        if (!uSessions[userId]) {
            uSessions[userId] = { sessions: {}, activeSessionId: null };
        }
        
        uSessions[userId].activeSessionId = targetSessionId;
        saveUserSessions(uSessions);
        ctx.reply(`✅ Sender aktif kamu diatur ke *${type}* (\`${targetSessionId}\`).`, { parse_mode: 'Markdown' });
    });

    botInstance.command('cekbio', checkAccess('cekbio', 'public', true), (ctx) => {
        const numbersToCheck = ctx.message.text.split(' ').slice(1).join(' ').match(/\d+/g) || [];
        bioCheckHandler(ctx, numbersToCheck);
    });

    botInstance.command('cekbiotxt', checkAccess('cekbiotxt', 'public', true), async (ctx) => {
        if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.document) return ctx.reply("Reply file .txt nya dulu, bos.");
        const doc = ctx.message.reply_to_message.document;
        if (doc.mime_type !== 'text/plain') return ctx.reply("Filenya harus .txt, jangan yang lain.");
        
        userCooldowns.set(ctx.from.id, Date.now());

        try {
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const response = await axios.get(fileLink.href);
            const numbersToCheck = response.data.match(/\d+/g) || [];
            bioCheckHandler(ctx, numbersToCheck);
        } catch (error) {
            console.error("Gagal proses file:", error);
            ctx.reply("Gagal ngambil nomor dari file, coba lagi.");
        }
    });
    
    const bioCheckHandler = async (ctx, numbersToCheck, file_id = null) => {
        let finalNumbers = numbersToCheck;

        if (file_id) {
             try {
                const fileLink = await ctx.telegram.getFileLink(file_id);
                const response = await axios.get(fileLink.href);
                finalNumbers = response.data.match(/\d+/g) || [];
            } catch (error) {
                console.error("Gagal proses file:", error);
                return ctx.reply("Gagal ngambil nomor dari file, coba lagi.");
            }
        }
        
        if (finalNumbers.length === 0) return ctx.reply("Nomornya mana, bos? Contoh: /cekbio 62812...");

        userCooldowns.set(ctx.from.id, Date.now()); 

        const { interval, messageId } = await showLoadingAnimation(ctx, "Mempersiapkan Cek Bio");
        notifyOwner(ctx, `📝 User *${ctx.from.first_name}* (\`${ctx.from.id}\`) menggunakan \`cek bio\` untuk *${finalNumbers.length} nomor*.`);
        
        const updateCallback = async (currentNum, processed, total) => {
            const frames = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
            const frame = frames[Math.floor((processed / 5) % frames.length)]; 
            const text = `${frame} Mengecek Bio... *${processed}/${total}*\nNomor saat ini: \`${currentNum}...\``;
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, { parse_mode: 'Markdown' });
            } catch (e) {
                
            }
        };

        try {
            const resultData = await handleBioCheck(ctx.from.id, finalNumbers, updateCallback);
            const formattedResult = formatBioResult(resultData);
            pendingChecks.set(ctx.from.id, { type: 'bio_result', data: formattedResult }); 

            clearInterval(interval);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, '✅ Pengecekan selesai! Pilih format hasil:', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📄 Kirim File (.txt)', callback_data: 'send_file_bio' }, { text: '✍️ Kirim Teks', callback_data: 'send_direct_bio' }]
                    ]
                }
            });
        } catch (error) {
            clearInterval(interval);
            console.error(error);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `❌ Gagal: ${error.message}` || config.message.error);
        }
    };
    
    botInstance.action('send_file_bio', async (ctx) => {
        await ctx.answerCbQuery();
        const result = pendingChecks.get(ctx.from.id);
        if (!result || result.type !== 'bio_result') return ctx.answerCbQuery('Hasil tidak ditemukan atau sudah kadaluwarsa.', { show_alert: true });
        
        const resultText = result.data;
        const filePath = `./hasil_cekbio_${ctx.from.id}.txt`;
        fs.writeFileSync(filePath, resultText);
        await ctx.replyWithDocument({ source: filePath }, { caption: "Nih hasilnya boskuu." });
        fs.unlinkSync(filePath);
        pendingChecks.delete(ctx.from.id);
        await ctx.deleteMessage().catch(() => {});
    });

    botInstance.action('send_direct_bio', async (ctx) => {
        await ctx.answerCbQuery();
        const result = pendingChecks.get(ctx.from.id);
        if (!result || result.type !== 'bio_result') return ctx.answerCbQuery('Hasil tidak ditemukan atau sudah kadaluwarsa.', { show_alert: true });
        
        const resultText = result.data;
        if (resultText.length > 4096) {
            await ctx.answerCbQuery('Hasil terlalu panjang, silakan pilih format file.', { show_alert: true });
        } else {
            await ctx.reply(resultText);
            pendingChecks.delete(ctx.from.id);
            await ctx.deleteMessage().catch(() => {});
        }
    });
    
    const cekNumberLogic = async (ctx, numbersToCheck) => {
        const waClient = getPersonalActiveClient(ctx.from.id);
        if (!waClient) return ctx.reply(config.message.waNotConnected, { parse_mode: 'Markdown' }); 

        if (numbersToCheck.length === 0) return ctx.reply("Nomornya mana, bos? Contoh: /ceknumber 62812...");
        
        userCooldowns.set(ctx.from.id, Date.now());

        const limit = getSettings().cekNumberLimit || 10; 
        if (numbersToCheck.length > limit) {
            ctx.reply(`Maksimal ${limit} nomor sekali cek ya bos. (Diatur via /setnm oleh Owner)`);
            numbersToCheck = numbersToCheck.slice(0, limit);
        }
        
        const { interval, messageId } = await showLoadingAnimation(ctx, "Mengecek Nomor");
        notifyOwner(ctx, `📱 User *${ctx.from.first_name}* (\`${ctx.from.id}\`) menggunakan \`/ceknumber\` untuk *${numbersToCheck.length} nomor*.`);
        
        try {
            const jids = numbersToCheck.map(num => num.trim() + '@s.whatsapp.net');
            const results = await waClient.onWhatsApp(...jids);
            const registeredJids = new Set(results.map(res => res.jid));
            
            let replyText = '🔬 *Hasil Pengecekan Nomor:*\n\n';
            numbersToCheck.forEach(num => {
                replyText += registeredJids.has(num.trim() + '@s.whatsapp.net') ? `✅ \`${num}\` - Terdaftar\n` : `❌ \`${num}\` - Tidak Terdaftar\n`;
            });
            
            clearInterval(interval);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, replyText, { parse_mode: 'Markdown' });
        } catch (e) {
            clearInterval(interval);
            console.error(e);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, config.message.error);
        }
    };

    botInstance.command('ceknumber', checkAccess('ceknumber', 'public', true), (ctx) => {
        const numbersToCheck = ctx.message.text.split(' ').slice(1).join(' ').match(/\d+/g) || [];
        cekNumberLogic(ctx, numbersToCheck);
    });

    botInstance.command('cekbiru', checkAccess('cekbiru', 'public', true), async (ctx) => {
        const waClient = getPersonalActiveClient(ctx.from.id);
        if (!waClient) return ctx.reply(config.message.waNotConnected, { parse_mode: 'Markdown' }); 

        let numbersToCheck = ctx.message.text.split(' ').slice(1).join(' ').match(/\d+/g) || [];
        if (numbersToCheck.length === 0) return ctx.reply("Nomornya mana, bos? Contoh: /cekbiru 62812...");
        
        userCooldowns.set(ctx.from.id, Date.now());

        const limit = getSettings().cekNumberLimit || 10; 
        if (numbersToCheck.length > limit) {
            ctx.reply(`Maksimal ${limit} nomor sekali cek ya bos.`);
            numbersToCheck = numbersToCheck.slice(0, limit);
        }
        
        const { interval, messageId } = await showLoadingAnimation(ctx, "Mengecek Status Verifikasi");
        notifyOwner(ctx, `🔵 User *${ctx.from.first_name}* (\`${ctx.from.id}\`) menggunakan \`/cekbiru\` untuk *${numbersToCheck.length} nomor*.`);
        
        try {
            // INI PENTING: Fix typo regex dari [^0-G] ke [^0-9]
            const jids = numbersToCheck.map(num => num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net');
            
            // 1. Cek dulu nomornya ada apa enggak (ini cepat)
            const existenceResults = await waClient.onWhatsApp(...jids); 
            const existenceMap = new Map();
            existenceResults.forEach(res => {
                existenceMap.set(res.jid, res);
            });
            
            let replyText = '🔵 *Hasil Pengecekan Verifikasi:*\n\n';

            // 2. Loop setiap nomor untuk dicek statusnya (lebih akurat)
            for (const num of numbersToCheck) {
                // Pastikan regex di sini juga bener
                const jid = num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                const existenceData = existenceMap.get(jid);
                
                if (existenceData && existenceData.exists) {
                    try {
                        // Ambil status lengkapnya, sama kayak di /cekbio
                        const statusResult = await waClient.fetchStatus(jid);
                        
                        let isVerified = false;
                        
                        // Cek 'isVerified' dari fetchStatus (lebih akurat)
                        if (statusResult && statusResult.isVerified) {
                            isVerified = true;
                        // Fallback ke 'isVerified' dari onWhatsApp (buat centang hijau)
                        } else if (existenceData.isVerified) { 
                            isVerified = true;
                        }

                        if (isVerified) {
                            replyText += `✅ \`${num}\` - *Terverifikasi* (Centang Biru/Hijau)\n`;
                        } else {
                            replyText += `🔘 \`${num}\` - Terdaftar (Tidak Terverifikasi)\n`;
                        }
                    } catch (e) {
                        // Gagal fetchStatus (mungkin akun private), pakai data seadanya
                        if (existenceData.isVerified) {
                            replyText += `✅ \`${num}\` - *Terverifikasi* (Centang Biru/Hijau)\n`;
                        } else {
                            replyText += `🔘 \`${num}\` - Terdaftar (Tidak Terverifikasi - Gagal Cek Detail)\n`;
                        }
                    }
                } else {
                    replyText += `❌ \`${num}\` - Tidak Terdaftar\n`;
                }
            }
            
            clearInterval(interval);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, replyText, { parse_mode: 'Markdown' });
        } catch (e) {
            clearInterval(interval);
            console.error(e);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, config.message.error);
        }
    });


    botInstance.command('cek', checkAccess('cek', 'premium', true), async (ctx) => {
        const userId = ctx.from.id;
        const replied = ctx.message.reply_to_message;
        const textArgs = ctx.message.text.split(' ').slice(1).join(' ').match(/\d+/g) || [];

        if (replied && replied.document && replied.document.mime_type === 'text/plain') {
            const doc = replied.document;
            pendingChecks.set(userId, { type: 'file', data: doc.file_id });
            
            await ctx.reply('File terdeteksi. Pilih Tipe Cek:', Markup.inlineKeyboard([
                [Markup.button.callback('Cek Bio dari File', 'cek_handler_bio_file')]
            ]));

        } else if (textArgs.length > 0) {
            pendingChecks.set(userId, { type: 'text', data: textArgs });
            
            await ctx.reply('Nomor terdeteksi. Pilih Tipe Cek:', Markup.inlineKeyboard([
                [Markup.button.callback('Cek Nomor', 'cek_handler_number')],
                [Markup.button.callback('Cek Bio', 'cek_handler_bio_text')]
            ]));
            
        } else {
            ctx.reply('Format salah.\nGunakan `/cek <nomor>...` atau reply file .txt dengan `/cek`.');
        }
    });

    botInstance.action('cek_handler_number', async (ctx) => {
        const pending = pendingChecks.get(ctx.from.id);
        if (!pending || pending.type !== 'text') return ctx.answerCbQuery('Data nomor tidak ditemukan.', { show_alert: true });
        
        await ctx.deleteMessage().catch(() => {});
        cekNumberLogic(ctx, pending.data); 
        pendingChecks.delete(ctx.from.id);
    });

    botInstance.action('cek_handler_bio_text', async (ctx) => {
        const pending = pendingChecks.get(ctx.from.id);
        if (!pending || pending.type !== 'text') return ctx.answerCbQuery('Data nomor tidak ditemukan.', { show_alert: true });
        
        await ctx.deleteMessage().catch(() => {});
        bioCheckHandler(ctx, pending.data, null); 
        pendingChecks.delete(ctx.from.id);
    });

    botInstance.action('cek_handler_bio_file', async (ctx) => {
        const pending = pendingChecks.get(ctx.from.id);
        if (!pending || pending.type !== 'file') return ctx.answerCbQuery('Data file tidak ditemukan.', { show_alert: true });
        
        await ctx.deleteMessage().catch(() => {});
        bioCheckHandler(ctx, [], pending.data); 
        pendingChecks.delete(ctx.from.id);
    });

    const sendEmailBanding = async (ctx, nomor, isPremium = false) => {
        const settings = getSettings();
        const activeEmailId = isPremium ? settings.activePremiumEmailId : settings.activeEmailId;
        const activeTemplateId = settings.activeTemplateId; 

        if (!activeEmailId || !activeTemplateId) return ctx.reply('Fitur ini belum dikonfigurasi oleh owner bot ini.');

        const emailConfig = (isPremium ? getPremiumEmails() : getEmails()).find(e => e.id === activeEmailId);
        const template = getTemplates().find(t => t.id === activeTemplateId);
        
        if (!emailConfig || !template) return ctx.reply('Konfigurasi email atau template tidak ditemukan.');
        
        userCooldowns.set(ctx.from.id, Date.now());

        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false, 
            auth: {
                user: emailConfig.email,
                pass: emailConfig.pass
            },
            connectionTimeout: 15000, 
            socketTimeout: 15000,     
            tls: {
                rejectUnauthorized: false
            }
        });

        const mailOptions = {
            from: `"${emailConfig.email}" <${emailConfig.email}>`,
            to: template.to,
            subject: template.subject,
            text: template.body.replace('{nomor}', nomor),
        };

        const { interval, messageId } = await showLoadingAnimation(ctx, "Mengirim Email Banding");
        try {
            await transporter.sendMail(mailOptions);
            clearInterval(interval);
            
            const userSuccessMessage = `Done ${isPremium ? 'Banding' : 'Fix Merah'} Dengan Nomor ${nomor}. Harap Tunggu 1-2 Menit Lalu Coba Lagi.`;
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, userSuccessMessage);
            
            notifyOwner(ctx, `[LOG] ${isPremium ? 'Banding' : 'Fix Merah'} Berhasil:\nUser: ${ctx.from.first_name} (\`${ctx.from.id}\`)\nNomor: \`${nomor}\`\nEmail Sender: \`${emailConfig.email}\``);

        } catch (error) {
            clearInterval(interval);
            console.error("Gagal mengirim email:", error);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `❌ Gagal mengirim email. Pastikan App Password benar dan IMAP aktif di akun ${emailConfig.email}.\n\n*Error:* \`${error.message}\``, { parse_mode: 'Markdown'});
            notifyOwner(ctx, `❌ *Gagal ${isPremium ? 'Banding' : 'Fix Merah'} Log*\n\nUser: ${ctx.from.first_name} (\`${ctx.from.id}\`)\nNomor: \`${nomor}\`\nError: ${error.message}`);
        }
    };

    botInstance.command('fixmerah', checkAccess('fixmerah', 'premium'), (ctx) => {
        const nomor = ctx.message.text.split(' ')[1];
        if (!nomor) return ctx.reply('Format salah. Gunakan: /fixmerah +628...');
        sendEmailBanding(ctx, nomor, false); 
    });

    botInstance.command('banding', checkAccess('banding', 'premium'), (ctx) => {
        const nomor = ctx.message.text.split(' ')[1];
        if (!nomor) return ctx.reply('Format salah. Gunakan: /banding +628...');
        sendEmailBanding(ctx, nomor, true); 
    });


    botInstance.command('tiktok', checkToolsAccess('tiktok'), async (ctx) => {
        const url = ctx.message.text.split(' ')[1];
        if (!url) return ctx.reply('URL TikToknya mana bos?');

        const { interval, messageId } = await showLoadingAnimation(ctx, "Mendownload TikTok");
        try {
            const response = await axios.post('https://www.tikwm.com/api/', {}, { params: { url, count: 12, cursor: 0, web: 1, hd: 1 } });
            const data = response.data;

            if (data.code === 0 && data.data.play) {
                clearInterval(interval);
                await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
                await ctx.replyWithVideo(data.data.play, { caption: data.data.title || 'Video dari TikTok' });
            } else {
                throw new Error(data.msg || 'Gagal mendapatkan video');
            }
        } catch (error) {
            clearInterval(interval);
            console.error(error);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, 'Gagal mendownload video. URL mungkin tidak valid atau video bersifat privat.');
        }
    });

    botInstance.command('tourl', checkToolsAccess('tourl'), async (ctx) => {
        const replied = ctx.message.reply_to_message;
        if (!replied || (!replied.photo && !replied.video && !replied.audio && !replied.document)) {
            return ctx.reply('Reply ke gambar, video, atau audio dulu bos.');
        }
        
        let fileId;
        if (replied.photo) fileId = replied.photo[replied.photo.length - 1].file_id;
        else if (replied.video) fileId = replied.video.file_id;
        else if (replied.audio) fileId = replied.audio.file_id;
        else if (replied.document) fileId = replied.document.file_id;
        
        const { interval, messageId } = await showLoadingAnimation(ctx, "Mengupload File");
        try {
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const response = await axios.get(fileLink.href, { responseType: 'stream' });

            const formData = new FormData();
            formData.append('reqtype', 'fileupload');
            formData.append('fileToUpload', response.data);

            const uploadResponse = await axios.post('https://catbox.moe/user/api.php', formData, { headers: formData.getHeaders() });

            if (uploadResponse.status === 200 && uploadResponse.data) {
                clearInterval(interval);
                await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `✅ Berhasil! Ini linknya:\n${uploadResponse.data}`);
            } else {
                throw new Error('Gagal mengupload file.');
            }
        } catch (error) {
            clearInterval(interval);
            console.error(error);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, 'Gagal mengupload file. Coba lagi nanti.');
        }
    });

    botInstance.command('stiker', checkToolsAccess('stiker'), async (ctx) => {
        const replied = ctx.message.reply_to_message;
        if (!replied || (!replied.photo && !replied.sticker)) {
            return ctx.reply('Reply ke gambar dulu bos.');
        }
        
        const fileId = replied.sticker ? replied.sticker.file_id : replied.photo[replied.photo.length - 1].file_id;

        const { interval, messageId } = await showLoadingAnimation(ctx, "Membuat Stiker");
        try {
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

            

            clearInterval(interval);
            await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
            await ctx.replyWithSticker({ source: webpBuffer });
        } catch (error) {
            clearInterval(interval);
            console.error(error);
            await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, 'Gagal membuat stiker. Pastikan format gambarnya didukung.');
        }
    });

    botInstance.command('cekpoin', checkAccess('cekpoin', 'public'), (ctx) => {
        const points = (getPoints()[ctx.from.id] || 0);
        ctx.reply(`💰 Poin kamu saat ini adalah: *${points} Poin*`, { parse_mode: 'Markdown' });
    });
    
    botInstance.command('tukarpoin', checkAccess('tukarpoin', 'public'), async (ctx) => {
        ctx.deleteMessage().catch(() => {}); 
        
        const { text, keyboard } = await showRedeemMenu(ctx);
        
        await ctx.reply(text, { 
            parse_mode: 'Markdown', 
            reply_markup: keyboard.reply_markup 
        });
    });

}

// --- FUNGSI MANAJEMEN SUB-BOT (GLOBAL) ---

function parseDuration(durationStr) {
    const match = durationStr.toLowerCase().match(/^(\d+)([dhms])$/);
    if (!match) return null;

    const amount = parseInt(match[1]);
    const unit = match[2];
    let ms = 0;

    if (unit === 's') ms = amount * 1000;
    else if (unit === 'm') ms = amount * 60 * 1000;
    else if (unit === 'h') ms = amount * 60 * 60 * 1000;
    else if (unit === 'd') ms = amount * 24 * 60 * 60 * 1000;
    else return null;

    return Date.now() + ms;
}

async function startSubBot(userId, token) {
    if (activeSubBots.has(userId)) {
        console.log(`Menghentikan instance sub-bot lama untuk ${userId}...`);
        activeSubBots.get(userId).stop('SIGINT');
        activeSubBots.delete(userId);
    }
    
    console.log(`Memulai sub-bot untuk user ${userId}...`);
    
    try {
        const subBot = new Telegraf(token);
        registerBotLogic(subBot, userId);

        const me = await subBot.telegram.getMe();
        console.log(`Token valid untuk @${me.username}. Meluncurkan...`);
        
        activeSubBots.set(userId, subBot);

        subBot.launch().catch(e => {
            console.error(`Sub-bot @${me.username} (User: ${userId}) crash:`, e.message);
            activeSubBots.delete(userId);
        });
        
        console.log(`Sub-bot untuk ${userId} (@${me.username}) berhasil diluncurkan.`);

    } catch (e) {
        console.error(`Gagal memulai sub-bot untuk ${userId} (Token: ${token}):`, e.message);
        
        const subBots = getSubBots();
        if (subBots[userId]) {
            delete subBots[userId];
            saveSubBots(subBots);
        }
        try {
            bot.telegram.sendMessage(config.ownerId, `❌ Gagal total memulai sub-bot untuk User \`${userId}\`.\nToken mungkin dicabut atau salah.\n\nError: ${e.message}`, { parse_mode: 'Markdown' });
        } catch (notifyError) {
            console.error("Gagal notif owner utama soal sub-bot error:", notifyError);
        }
    }
}

async function checkBotExpiry() {
    const subBots = getSubBots();
    const now = Date.now();
    let changed = false;

    for (const userId in subBots) {
        if (subBots[userId].expiry <= now) {
            console.log(`Sub-bot untuk user ${userId} telah kedaluwarsa.`);
            const { token, botUsername } = subBots[userId];
            
            if (activeSubBots.has(parseInt(userId))) {
                activeSubBots.get(parseInt(userId)).stop('SIGINT');
                activeSubBots.delete(parseInt(userId));
            }
            
            delete subBots[userId];
            changed = true;
            
            try {
                const expiryBot = new Telegraf(token);
                await expiryBot.telegram.sendMessage(parseInt(userId), 
                    `⏳ *Masa Aktif Bot Habis*\n\nMasa aktif @${botUsername} kamu sudah selesai.\nSilahkan hubungi owner untuk mengaktifkannya lagi.`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.url('Hubungi Owner', `https://t.me/${config.ownerUsername}`)]
                        ]).reply_markup
                    }
                );
            } catch (e) {
                console.error(`Gagal mengirim pesan kedaluwarsa ke user ${userId}:`, e.message);
            }
        }
    }

    if (changed) {
        saveSubBots(subBots);
    }
}

async function checkExpiries() {
    await checkBotExpiry();

    const premiumUsers = getMainBotPremiumUsers();
    const redeemed = getMainBotRedeemedRewards();
    const now = Date.now();
    let premiumChanged = false;
    let redeemedChanged = false;

    let newPremiumUsers = [...premiumUsers];

    for (const userId of premiumUsers) {
        const userRewards = redeemed[String(userId)]; 
        if (userRewards) {
            const premiumReward = userRewards.find(r => 
                (r.reward === 'Akses Premium 2 Hari') && 
                r.expiry && 
                r.expiry <= now
            );
            
            if (premiumReward) {
                newPremiumUsers = newPremiumUsers.filter(id => id !== userId);
                premiumChanged = true;
                
                redeemed[String(userId)] = userRewards.filter(r => r !== premiumReward);
                redeemedChanged = true;

                try {
                    bot.telegram.sendMessage(userId, "⏳ Masa aktif premium kamu dari tukar poin telah berakhir.");
                } catch (e) {
                    console.log("Gagal notif premium expiry ke", userId, e.message);
                }
            }
        }
    }

    if (premiumChanged) {
        saveMainBotPremiumUsers(newPremiumUsers);
    }
    if (redeemedChanged) {
        saveMainBotRedeemedRewards(redeemed);
    }
}

// --- BOT UTAMA ---
const bot = new Telegraf(config.telegramBotToken);
registerBotLogic(bot, null); 

// --- Command & Handler Khusus /jadibot (HANYA DI BOT UTAMA) ---

bot.command('jadibot', async (ctx) => {
    const token = ctx.message.text.split(' ')[1];
    if (!token) return ctx.reply("Format salah. Gunakan: /jadibot <BOT_TOKEN>");
    
    const userId = ctx.from.id;
    if (getSubBots()[userId]) {
        return ctx.reply("Kamu sudah memiliki sub-bot yang aktif.");
    }
    if (pendingJadibot.has(userId) || pendingJadibotDuration.has(config.ownerId)) {
        return ctx.reply("Permintaan sebelumnya masih diproses. Harap tunggu.");
    }

    const { interval, messageId } = await showLoadingAnimation(ctx, "Memvalidasi Token");
    try {
        const tempBot = new Telegraf(token);
        const me = await tempBot.telegram.getMe();
        const botUsername = me.username;

        pendingJadibot.set(userId, { token, botUsername });
        
        const safeFirstName = escapeMarkdownV1(ctx.from.first_name);
        const safeUsername = escapeMarkdownV1(ctx.from.username || 'N/A');
        const safeBotUsername = escapeMarkdownV1(botUsername);
        
        const approvalMessage = `📮 *Permintaan Jadibot Baru*\n\n*Dari:* ${safeFirstName} (@${safeUsername})\n*ID:* \`${userId}\`\n*Bot:* @${safeBotUsername}\n\nHalo bos, ada yang mau jadi bot nih. Terima kagak?`;
        
        await bot.telegram.sendMessage(config.ownerId, approvalMessage, {
            parse_mode: 'Markdown', 
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('✅ Terima', `accept_jadibot_${userId}`), Markup.button.callback('❌ Tolak', `decline_jadibot_${userId}`)]
            ]).reply_markup
        });

        clearInterval(interval);
        await ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
        await ctx.reply(`✅ Permintaanmu untuk bot @${botUsername} telah dikirim ke Owner. Harap tunggu persetujuan.`);

    } catch (e) {
        clearInterval(interval);
        console.error("Gagal validasi token:", e);
        
        const errorMessage = e.message ? (e.message.split(': ')[2] || e.message) : 'Error tidak diketahui';
        await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `❌ Token tidak valid.\nPastikan token benar dan bot belum berjalan.\n\n*Error:* \`${errorMessage}\``, { parse_mode: 'Markdown' }).catch(() => {});
    }
});

bot.action(/accept_jadibot_(.+)/, async (ctx) => {
    if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery('Hanya Owner Utama!', { show_alert: true });
    
    const userId = parseInt(ctx.match[1]);
    const request = pendingJadibot.get(userId);
    
    if (!request) {
        await ctx.answerCbQuery("Request sudah tidak valid.", { show_alert: true });
        return ctx.editMessageText("Request kadaluwarsa atau sudah diproses.");
    }

    pendingJadibotDuration.set(config.ownerId, { userId, ...request });
    pendingJadibot.delete(userId); 
    
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Permintaan dari \`${userId}\` (@${request.botUsername}) diterima.\n\nSekarang, masukkan jangka waktu (cth: 30d, 2h, 15m):`);
});

bot.action(/decline_jadibot_(.+)/, async (ctx) => {
    if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery('Hanya Owner Utama!', { show_alert: true });
    
    const userId = parseInt(ctx.match[1]);
    const request = pendingJadibot.get(userId);
    
    if (!request) {
        await ctx.answerCbQuery("Request sudah tidak valid.", { show_alert: true });
        return ctx.editMessageText("Request kadaluwarsa atau sudah diproses.");
    }

    pendingJadibot.delete(userId);
    
    await ctx.answerCbQuery();
    await ctx.editMessageText(`❌ Permintaan dari \`${userId}\` (@${request.botUsername}) ditolak.`);
    
    try {
        await bot.telegram.sendMessage(userId, `Mohon maaf, permintaan /jadibot kamu untuk @${request.botUsername} ditolak oleh Owner.`);
    } catch (e) {
        console.error(`Gagal notif user ${userId} soal penolakan jadibot:`, e);
    }
});

bot.on('text', async (ctx, next) => {
    if (ctx.from.id === config.ownerId) {
        const pending = pendingJadibotDuration.get(config.ownerId);
        if (pending) {
            const durationStr = ctx.message.text;
            const expiry = parseDuration(durationStr);
            
            if (!expiry) {
                return ctx.reply("Format durasi salah. Coba lagi (cth: 30d, 2h, 15m).");
            }

            const { userId, token, botUsername } = pending;
            
            const subBots = getSubBots();
            subBots[userId] = { token, expiry, botUsername };
            saveSubBots(subBots);
            
            await startSubBot(userId, token); 
            
            pendingJadibotDuration.delete(config.ownerId);
            
            await ctx.reply(`✅ Siap! Bot @${botUsername} untuk user \`${userId}\` aktif sampai ${new Date(expiry).toLocaleString('id-ID')}.`);
            
            try {
                await bot.telegram.sendMessage(userId, `🎉 Selamat! Bot kamu @${botUsername} sudah diaktifkan oleh Owner selama *${durationStr}*!`, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error(`Gagal notif user ${userId} soal aktivasi jadibot:`, e);
            }
            return; 
        }
        
        const pendingRewardData = pendingReward.get(ctx.from.id);
        if (pendingRewardData) {
            pendingReward.delete(ctx.from.id);
        }
    }
    return next(); 
});


// --- MAIN EXECUTION ---
(async () => {
    await startAllWaClients();
    
    const subBots = getSubBots();
    const now = Date.now();
    for (const userId in subBots) {
        if (subBots[userId].expiry > now) {
            await startSubBot(parseInt(userId), subBots[userId].token);
        }
    }
    
    setInterval(checkExpiries, 60000); 
    
    bot.launch();
    console.log('Bot Telegram Utama OTW!');
})();

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    activeSubBots.forEach(subBot => subBot.stop('SIGINT'));
    waClients.forEach(clientData => clientData.client.end());
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    activeSubBots.forEach(subBot => subBot.stop('SIGTERM'));
    waClients.forEach(clientData => clientData.client.end());
});
