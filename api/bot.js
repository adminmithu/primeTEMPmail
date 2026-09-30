require('dotenv').config();
const { Telegraf, Markup, Telegram } = require('telegraf');
const db = require('./db');

// Robust Markdown-to-HTML converter for premium rendering in Telegram
function mdToHtml(md) {
    if (!md) return '';
    let str = md.toString();

    // 0. Stash all valid HTML tags before escaping
    const htmlBlocks = [];
    str = str.replace(/<\/?(b|i|u|s|strong|em|ins|strike|del|code|pre|blockquote|a|tg-emoji)(\s+[^>]*?)?>/gi, (match) => {
        const placeholder = `___HTMLBLOCK_${htmlBlocks.length}___`;
        htmlBlocks.push(match);
        return placeholder;
    });

    // 1. Escape HTML special characters
    str = str.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;');

    // 2. Stash code blocks (`...`) to prevent formatting inside them
    const codeBlocks = [];
    str = str.replace(/`(.*?)`/g, (match, code) => {
        const placeholder = `___CODEBLOCK_${codeBlocks.length}___`;
        codeBlocks.push(code);
        return placeholder;
    });

    // 3. Parse blockquotes (lines starting with &gt;)
    let lines = str.split('\n');
    let inBlockquote = false;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let trimmed = line.trim();
        if (trimmed.startsWith('&gt;')) {
            let content = trimmed.substring(4);
            if (content.startsWith(' ')) {
                content = content.substring(1);
            }
            if (!inBlockquote) {
                lines[i] = '<blockquote>' + content;
                inBlockquote = true;
            } else {
                lines[i] = content;
            }
        } else {
            if (inBlockquote) {
                lines[i - 1] = lines[i - 1] + '</blockquote>';
                inBlockquote = false;
            }
        }
    }
    if (inBlockquote) {
        lines[lines.length - 1] = lines[lines.length - 1] + '</blockquote>';
    }
    str = lines.join('\n');

    // 4. Bold: **text** and *text*
    str = str.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    str = str.replace(/\*(.*?)\*/g, '<b>$1</b>');

    // 5. Italic: __text__ and _text_
    str = str.replace(/__(.*?)__/g, '<i>$1</i>');
    str = str.replace(/_(.*?)_/g, '<i>$1</i>');

    // 6. Links: [text](url)
    str = str.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');

    // 7. Restore code blocks wrapped in <code>
    codeBlocks.forEach((code, index) => {
        str = str.replace(`___CODEBLOCK_${index}___`, `<code>${code}</code>`);
    });

    // 8. Restore all stashed HTML tags
    htmlBlocks.forEach((tag, index) => {
        str = str.replace(`___HTMLBLOCK_${index}___`, tag);
    });

    return str;
}

function telegramEntitiesToHtml(message) {
    if (!message || (!message.text && !message.caption)) return message ? (message.text || message.caption || '') : '';
    const text = message.text || message.caption || '';
    const entities = message.entities || message.caption_entities;

    if (!entities || entities.length === 0) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    const openTags = Array.from({ length: text.length + 1 }, () => []);
    const closeTags = Array.from({ length: text.length + 1 }, () => []);

    for (const e of entities) {
        const start = e.offset;
        const end = e.offset + e.length;

        if (start < 0 || end > text.length || start >= end) continue;

        let openTag = '';
        let closeTag = '';

        switch (e.type) {
            case 'bold':
                openTag = '<b>'; closeTag = '</b>';
                break;
            case 'italic':
                openTag = '<i>'; closeTag = '</i>';
                break;
            case 'underline':
                openTag = '<u>'; closeTag = '</u>';
                break;
            case 'strikethrough':
                openTag = '<s>'; closeTag = '</s>';
                break;
            case 'code':
                openTag = '<code>'; closeTag = '</code>';
                break;
            case 'pre':
                openTag = '<pre>'; closeTag = '</pre>';
                break;
            case 'blockquote':
                openTag = '<blockquote>'; closeTag = '</blockquote>';
                break;
            case 'expandable_blockquote':
                openTag = '<blockquote expandable>'; closeTag = '</blockquote>';
                break;
            case 'text_link':
                if (e.url) {
                    const safeUrl = e.url.replace(/"/g, '&quot;');
                    openTag = `<a href="${safeUrl}">`; closeTag = '</a>';
                }
                break;
            case 'custom_emoji':
                if (e.custom_emoji_id && /^\d+$/.test(e.custom_emoji_id.toString().trim())) {
                    openTag = `<tg-emoji emoji-id="${e.custom_emoji_id.toString().trim()}">`; closeTag = '</tg-emoji>';
                }
                break;
        }

        if (openTag && closeTag) {
            openTags[start].push({ tag: openTag, length: e.length });
            closeTags[end].push({ tag: closeTag, length: e.length });
        }
    }

    let result = '';
    for (let i = 0; i <= text.length; i++) {
        // Closing tags: shorter length first for proper HTML nesting
        if (closeTags[i].length > 0) {
            closeTags[i].sort((a, b) => a.length - b.length);
            for (const c of closeTags[i]) {
                result += c.tag;
            }
        }

        // Opening tags: longer length first for proper HTML nesting
        if (openTags[i].length > 0) {
            openTags[i].sort((a, b) => b.length - a.length);
            for (const o of openTags[i]) {
                result += o.tag;
            }
        }

        // Output character at index i with HTML escaping
        if (i < text.length) {
            const ch = text[i];
            if (ch === '&') result += '&amp;';
            else if (ch === '<') result += '&lt;';
            else if (ch === '>') result += '&gt;';
            else result += ch;
        }
    }

    return result;
}

function parseMessageWithEntities(message) {
    return telegramEntitiesToHtml(message);
}

function extractFirstCustomEmojiId(message) {
    if (!message) return null;
    const entities = message.entities || message.caption_entities;
    if (!entities) return null;
    const customEmoji = entities.find(e => e.type === 'custom_emoji' && e.custom_emoji_id);
    return customEmoji ? customEmoji.custom_emoji_id : null;
}

function styledBtn(text, callbackData, style = null, iconEmojiId = null) {
    const btn = { text: text, callback_data: callbackData };
    if (style) btn.style = style; // 'primary', 'success', 'danger'
    if (iconEmojiId) btn.icon_custom_emoji_id = iconEmojiId;
    return btn;
}

function styledUrlBtn(text, url, style = null, iconEmojiId = null) {
    const btn = { text: text, url: url };
    if (style) btn.style = style; // 'primary', 'success', 'danger'
    if (iconEmojiId) btn.icon_custom_emoji_id = iconEmojiId;
    return btn;
}

// Hook into Telegraf Telegram methods to apply custom mdToHtml translation
const originalSendMessage = Telegram.prototype.sendMessage;
Telegram.prototype.sendMessage = function (chatId, text, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    let processedText = text;
    if (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2') {
        if (typeof text === 'string') {
            processedText = mdToHtml(text);
            cleanExtra.parse_mode = 'HTML';
        }
    }
    return originalSendMessage.call(this, chatId, processedText, cleanExtra);
};

const originalEditMessageText = Telegram.prototype.editMessageText;
Telegram.prototype.editMessageText = function (chatId, messageId, inlineMessageId, text, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    let processedText = text;
    if (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2') {
        if (typeof text === 'string') {
            processedText = mdToHtml(text);
            cleanExtra.parse_mode = 'HTML';
        }
    }
    return originalEditMessageText.call(this, chatId, messageId, inlineMessageId, processedText, cleanExtra);
};

const originalSendPhoto = Telegram.prototype.sendPhoto;
Telegram.prototype.sendPhoto = function (chatId, photo, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    if (cleanExtra.caption && (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2')) {
        cleanExtra.caption = mdToHtml(cleanExtra.caption);
        cleanExtra.parse_mode = 'HTML';
    }
    return originalSendPhoto.call(this, chatId, photo, cleanExtra);
};

const originalSendDocument = Telegram.prototype.sendDocument;
Telegram.prototype.sendDocument = function (chatId, doc, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    if (cleanExtra.caption && (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2')) {
        cleanExtra.caption = mdToHtml(cleanExtra.caption);
        cleanExtra.parse_mode = 'HTML';
    }
    return originalSendDocument.call(this, chatId, doc, cleanExtra);
};

const originalSendVideo = Telegram.prototype.sendVideo;
Telegram.prototype.sendVideo = function (chatId, video, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    if (cleanExtra.caption && (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2')) {
        cleanExtra.caption = mdToHtml(cleanExtra.caption);
        cleanExtra.parse_mode = 'HTML';
    }
    return originalSendVideo.call(this, chatId, video, cleanExtra);
};

const BOT_TOKEN = process.env.BOT_TOKEN || '8810183896:AAEtcbK-z19BkACmoUBTJiTYzvxCUVLHKzc';
const ADMIN_ID = (process.env.ADMIN_ID || '8929349073').toString();
const GROUP_ID = process.env.GROUP_ID || '-5569242233';

const bot = new Telegraf(BOT_TOKEN);

// In-memory fallback for maintenance mode (just in case)
let memoryMaintenanceMode = false;
let memoryFakeSalesEnabled = true; // in-memory fallback for fake sales loop
let memoryForceJoinEnabled = true;
let memoryReferRewardAmount = 3;
let memorySellingHoursEnabled = true;

async function getForceJoinStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_FORCE_JOIN_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return true; // default enabled
    }
    return memoryForceJoinEnabled;
}

async function setForceJoinStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_FORCE_JOIN_ENABLED', val);
    } else {
        memoryForceJoinEnabled = enabled;
    }
}

async function getReferRewardAmount() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_REFER_REWARD_AMOUNT');
        if (coupon) {
            return coupon.discount_amount;
        }
        return 3; // default 3 TK
    }
    return memoryReferRewardAmount;
}

async function setReferRewardAmount(amount) {
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_REFER_REWARD_AMOUNT', amount);
    } else {
        memoryReferRewardAmount = amount;
    }
}

async function getSellingHoursStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_SELLING_HOURS_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return true; // default enabled (has 11am-11pm limits)
    }
    return memorySellingHoursEnabled;
}

async function setSellingHoursStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_SELLING_HOURS_ENABLED', val);
    } else {
        memorySellingHoursEnabled = enabled;
    }
}

const memoryStock = {};

async function getPackageStockStatus(pkgKey) {
    const dbKey = `STOCK_${pkgKey.toUpperCase()}`;
    if (db.isConfigured()) {
        const coupon = await db.getCoupon(dbKey);
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return true; // default in stock
    }
    if (memoryStock[pkgKey] !== undefined) {
        return memoryStock[pkgKey];
    }
    return true; // default in stock
}

async function setPackageStockStatus(pkgKey, inStock) {
    const dbKey = `STOCK_${pkgKey.toUpperCase()}`;
    const val = inStock ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon(dbKey, val);
    } else {
        memoryStock[pkgKey] = inStock;
    }
}

async function getFakeSalesStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_FAKE_SALES_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return true; // default enabled
    }
    return memoryFakeSalesEnabled;
}

async function setFakeSalesStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_FAKE_SALES_ENABLED', val);
    } else {
        memoryFakeSalesEnabled = enabled;
    }
}

async function getMaintenanceMode() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_MAINTENANCE_MODE');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return false;
    }
    return memoryMaintenanceMode;
}

async function setMaintenanceMode(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_MAINTENANCE_MODE', val);
    } else {
        memoryMaintenanceMode = enabled;
    }
}

// In-memory fallback for notice mode
let memoryNoticeEnabled = false;
let memoryNoticeText = "Welcome to AdsPower Seller BD!";

async function getNoticeStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_NOTICE_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return false;
    }
    return memoryNoticeEnabled;
}

async function setNoticeStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_NOTICE_ENABLED', val);
    } else {
        memoryNoticeEnabled = enabled;
    }
}

async function getNoticeText() {
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const noticeCoupon = coupons.find(cp => cp.code.startsWith('NOTICE_TEXT|'));
            if (noticeCoupon) {
                return noticeCoupon.code.split('NOTICE_TEXT|')[1];
            }
        }
    }
    return memoryNoticeText;
}

async function setNoticeText(text) {
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const oldNotices = coupons.filter(cp => cp.code.startsWith('NOTICE_TEXT|'));
            for (const old of oldNotices) {
                await db.deleteCoupon(old.code);
            }
        }
        await db.createCoupon('NOTICE_TEXT|' + text, 0);
    } else {
        memoryNoticeText = text;
    }
}

async function checkAndSendNotice(ctx) {
    const isNoticeEnabled = await getNoticeStatus();
    if (isNoticeEnabled) {
        const noticeText = await getNoticeText();
        const formattedNotice = `🔔 *SPECIAL ANNOUNCEMENT / ঘোষণা* 🔔\n` +
                                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                                `${noticeText}\n` +
                                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
        await ctx.reply(formattedNotice, { parse_mode: 'Markdown' });
    }
}

// Dynamic wallet values (Bkash/Nagad/Binance/Payoneer)
let memoryWallets = {
    bkash: '01864339154',
    nagad: '01864339154',
    binance: '955102483',
    payoneer: 'mithuchandra647@gmail.com'
};

async function getWallet(type) {
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const walletPrefix = `WALLET_${type.toUpperCase()}|`;
            const coupon = coupons.find(cp => cp.code.startsWith(walletPrefix));
            if (coupon) {
                return coupon.code.split(walletPrefix)[1];
            }
        }
    }
    return memoryWallets[type];
}

async function setWallet(type, value) {
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const walletPrefix = `WALLET_${type.toUpperCase()}|`;
            const oldWallets = coupons.filter(cp => cp.code.startsWith(walletPrefix));
            for (const old of oldWallets) {
                await db.deleteCoupon(old.code);
            }
        }
        await db.createCoupon(`WALLET_${type.toUpperCase()}|` + value, 0);
    } else {
        memoryWallets[type] = value;
    }
}

async function getCustomText(key, defaultVal) {
    const val = await getWallet(`TEXT_${key.toUpperCase()}`);
    return (val && !['01864339154', '955102483', 'mithuchandra647@gmail.com'].includes(val)) ? val : defaultVal;
}

async function setCustomText(key, value) {
    await setWallet(`TEXT_${key.toUpperCase()}`, value);
}

async function getItemEmojiTag(itemKey, defaultFallback = '⭐') {
    const emojiId = await getCustomText(`EMOJIID_${itemKey}`, '');
    const cleanId = (emojiId || '').toString().trim();
    if (cleanId && /^\d+$/.test(cleanId)) {
        return `<tg-emoji emoji-id="${cleanId}">${defaultFallback}</tg-emoji>`;
    }
    return defaultFallback;
}

// Referral Systems Config & Helpers
let memoryReferrals = {};
let memoryRewardedReferrals = {}; // in-memory history of successful referrals

async function checkIfUserIsNew(userId) {
    if (db.isConfigured()) {
        const users = await db.getAllUsers();
        if (users) {
            return !users.some(u => String(u.user_id) === userId);
        }
    }
    return !memoryAllStartedUsers.has(userId);
}

async function saveReferral(newUserId, referrerId) {
    if (db.isConfigured()) {
        await db.createCoupon(`REFERRAL|${newUserId}|${referrerId}`, 0);
    } else {
        memoryReferrals[newUserId] = referrerId;
    }
}

async function checkAndRewardReferral(newUserId, ctx) {
    try {
        let referrerId = null;
        if (db.isConfigured()) {
            const coupons = await db.getAllCoupons();
            if (coupons) {
                const refCoupon = coupons.find(cp => cp.code.startsWith(`REFERRAL|${newUserId}|`));
                if (refCoupon) {
                    referrerId = refCoupon.code.split('|')[2];
                    await db.deleteCoupon(refCoupon.code);
                }
            }
        } else {
            referrerId = memoryReferrals[newUserId];
            delete memoryReferrals[newUserId];
        }

        if (referrerId) {
            const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
            const rewardCouponCode = `REF_${randomSuffix}`;
            const rewardAmount = await getReferRewardAmount();

            if (db.isConfigured()) {
                await db.createCoupon(rewardCouponCode, rewardAmount);
                await db.createCoupon(`REWARDED_REF|${referrerId}|${newUserId}|${Date.now()}`, 0);
            } else {
                memoryCoupons[rewardCouponCode] = rewardAmount;
                if (!memoryRewardedReferrals[referrerId]) {
                    memoryRewardedReferrals[referrerId] = [];
                }
                memoryRewardedReferrals[referrerId].push(newUserId);
            }

            try {
                await ctx.telegram.sendMessage(
                    referrerId,
                    `🎉 *Referral Reward!* 💎\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `আপনার রেফারেল লিংক ব্যবহার করে একজন কাস্টমার প্রথম কেনাকাটা সম্পন্ন করেছেন!\n\n` +
                    `উপহার হিসেবে আপনি একটি কুপন পেয়েছেন:\n` +
                    `🎟️ Coupon: \`${rewardCouponCode}\` (-${rewardAmount} TK)\n\n` +
                    `🛒 আপনার পরবর্তী কেনাকাটায় এটি ব্যবহার করতে পারবেন!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                console.error(`Failed to send referral reward message to ${referrerId}:`, err.message);
            }
        }
    } catch (e) {
        console.error("Error rewarding referral:", e.message);
    }
}

async function getReferralLeaderboard() {
    let list = [];
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const counts = {};
            coupons.forEach(cp => {
                if (cp.code.startsWith('REWARDED_REF|')) {
                    const parts = cp.code.split('|');
                    const referrerId = parts[1];
                    counts[referrerId] = (counts[referrerId] || 0) + 1;
                }
            });
            list = Object.keys(counts).map(referrerId => ({
                referrerId,
                count: counts[referrerId]
            }));
        }
    } else {
        list = Object.keys(memoryRewardedReferrals).map(referrerId => ({
            referrerId,
            count: memoryRewardedReferrals[referrerId].length
        }));
    }

    list.sort((a, b) => b.count - a.count);
    return list.slice(0, 10);
}

async function getLeaderboardText() {
    const leaderboard = await getReferralLeaderboard();
    let text = `🏆 *Referral Leaderboard / রেফারে চ্যাম্পিয়ন* 🏆\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `সবচেয়ে বেশি সফল রেফার করা টপ রেফারারদের তালিকা:\n\n`;

    if (leaderboard.length === 0) {
        text += `> ❌ বর্তমানে কোনো সফল রেফারেলের তথ্য নেই। রেফারেল শুরু করতে আপনার লিংক শেয়ার করুন!`;
        return text;
    }

    let users = [];
    if (db.isConfigured()) {
        users = await db.getAllUsers();
    }

    leaderboard.forEach((item, index) => {
        const user = users ? users.find(u => String(u.user_id) === item.referrerId) : null;
        const displayName = user ? (user.first_name || 'User') : `User ID: ${item.referrerId}`;
        const username = user && user.username ? ` (@${user.username})` : '';

        let medal = "👤";
        if (index === 0) medal = "🥇";
        else if (index === 1) medal = "🥈";
        else if (index === 2) medal = "🥉";

        text += `${medal} *#${index + 1}* - ${displayName}${username}\n` +
                `   └─ Successful Refers: *${item.count}* \n\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━\n` +
            `🎁 প্রতি সফল রেফারে ৩ টাকা সরাসরি ডিসকাউন্ট কুপন পান!`;
    return text;
}

async function getReferralStats(referrerId) {
    let pending = 0;
    let successful = 0;

    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            coupons.forEach(cp => {
                if (cp.code.startsWith('REFERRAL|')) {
                    const parts = cp.code.split('|');
                    if (parts[2] === referrerId) {
                        pending++;
                    }
                } else if (cp.code.startsWith('REWARDED_REF|')) {
                    const parts = cp.code.split('|');
                    if (parts[1] === referrerId) {
                        successful++;
                    }
                }
            });
        }
    } else {
        successful = memoryRewardedReferrals[referrerId] ? memoryRewardedReferrals[referrerId].length : 0;
        pending = Object.values(memoryReferrals).filter(rId => rId === referrerId).length;
    }
    return { pending, successful };
}

const groupMemberCache = new Map(); // userId -> expiry timestamp

async function checkUserJoinedGroup(ctx, userId, forceCheck = false) {
    if (userId.toString() === ADMIN_ID) return true;

    // Check if Force Join is enabled in Bot Control
    const isForceJoinEnabled = await getForceJoinStatus();
    if (!isForceJoinEnabled) return true; // auto pass membership check!

    const strId = userId.toString();
    if (!forceCheck) {
        const cachedExpiry = groupMemberCache.get(strId);
        if (cachedExpiry && Date.now() < cachedExpiry) {
            return true;
        }
    }

    try {
        const member = await ctx.telegram.getChatMember(parseInt(GROUP_ID), parseInt(userId));
        const status = member.status;
        const isMember = (status === 'creator' || status === 'administrator' || status === 'member' || status === 'restricted');
        if (isMember) {
            // Cache verified membership for 5 minutes (300,000ms)
            groupMemberCache.set(strId, Date.now() + 300000);
        } else {
            groupMemberCache.delete(strId);
        }
        return isMember;
    } catch (err) {
        console.error("Failed to check group membership:", err.message);
        return true;
    }
}

async function isOutsideSellingHours() {
    // Check if selling hours constraint is enabled
    const enabled = await getSellingHoursStatus();
    if (!enabled) return false; // bypassed, so not outside selling hours

    try {
        const now = new Date();
        // Calculate Asia/Dhaka time (GMT+6)
        const bdTime = new Date(now.getTime() + (6 * 3600 * 1000));
        const hours = bdTime.getUTCHours();
        return (hours < 11 || hours >= 23);
    } catch (e) {
        return false;
    }
}

async function getLatestCompletedEmail(userId) {
    const orders = await getUserOrders(userId);
    if (orders && orders.length > 0) {
        const completedOrder = orders.find(ord => ord.status === 'Completed');
        if (completedOrder) {
            return completedOrder.customEmail || 'N/A';
        }
    }
    return 'N/A';
}

const fakeNames = ["Hasan", "Robin", "Fahim", "Mim", "Rashed", "Nipa", "Arif", "Sumon", "Sazzad", "Anik", "Mithu", "Liton", "Sujon", "Tarek", "Raju", "Hassan", "Apu", "Joy", "Rony", "Faisal"];
const fakeReviews = [
    "অসাধারণ সার্ভিস! খুব দ্রুত ডেলিভারি পেলাম।",
    "অ্যাকাউন্ট পারফেক্টলি কাজ করছে। ধন্যবাদ!",
    "খুব কম সময়ে ডেলিভারি দেওয়ার জন্য ধন্যবাদ।",
    "সেরা সার্ভিস! রেটিং ৫/৫।",
    "খুবই ভালো এবং বিশ্বস্ত সেলার।",
    "ডেলিভারি স্পিড অসাধারণ ছিল!",
    "প্যাকেজ একটিভ হতে মাত্র ২ মিনিট লেগেছে!",
    "রেকমেন্ডেড সেলার, ধন্যবাদ ভাই!",
    "১০০% রিয়েল এবং সিকিউর। কাজ করছে সুন্দর।"
];

function escapeMarkdownV2(str, isCode = false) {
    if (!str) return '';
    if (isCode) {
        return str.toString().replace(/[\\`]/g, '\\$&');
    }
    return str.toString().replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function sendFakeSaleToGroup(force = false) {
    try {
        let enabled = true; // default enabled
        if (db.isConfigured()) {
            const coupon = await db.getCoupon('SYSTEM_FAKE_SALES_ENABLED');
            if (coupon) {
                enabled = coupon.discount_amount === 1;
            }
        } else {
            enabled = memoryFakeSalesEnabled;
        }

        if (!enabled && !force) return;

        const orderId = Math.floor(10000 + Math.random() * 90000);
        const name = fakeNames[Math.floor(Math.random() * fakeNames.length)];
        const review = fakeReviews[Math.floor(Math.random() * fakeReviews.length)];

        const packages = [
            { name: "1 Account AdsPower", price: 30 },
            { name: "3 Accounts AdsPower", price: 80 },
            { name: "5 Accounts AdsPower", price: 135 },
            { name: "10 Accounts AdsPower", price: 250 }
        ];
        const selectedPkg = packages[Math.floor(Math.random() * packages.length)];
        const methods = ["bKash Personal", "Nagad Personal", "Binance Pay ID"];
        const method = methods[Math.floor(Math.random() * methods.length)];

        // Construct masked email with fixed @emalupe.com domain
        const firstLetter = name.substring(0, 2).toLowerCase();
        const maskedEmail = `${firstLetter}***@emalupe.com`;

        // 4 or 5 stars
        const rating = Math.random() > 0.3 ? 5 : 4;
        const ratingStars = '⭐'.repeat(rating);
        const ratingNum = rating.toFixed(1);
        const accountsCount = selectedPkg.name.split(' ')[0];

        const fakeSalesMsg = `💎 *PREMIUM ORDER RECEIPT*\n\n` +
                             `╔════════════════════════╗\n` +
                             `      🛒 *ADSPOWER*\n` +
                             `       \`ORDER #${orderId}\`\n` +
                             `╚════════════════════════╝\n\n` +
                             `📦 *PACKAGE*\n` +
                             `\`ADSPOWER × ${accountsCount}\`\n\n` +
                             `💰 *TOTAL*\n` +
                             `\`${selectedPkg.price} TK\`\n\n` +
                             `💳 *PAYMENT METHOD*\n` +
                             `\`${method.toUpperCase()}\`\n\n` +
                             `━━━━━━━━━━━━━━━━━━━━\n\n` +
                             `👤 *CUSTOMER*\n` +
                             `\`${name}\`\n\n` +
                             `📧 *EMAIL*\n` +
                             `\`${maskedEmail}\`\n\n` +
                             `🔑 *PASSWORD*\n` +
                             `\`••••••••\`\n\n` +
                             `━━━━━━━━━━━━━━━━━━━━\n\n` +
                             `🟢 *DELIVERED SUCCESSFULLY*\n\n` +
                             `⭐️ *CUSTOMER RATING*\n` +
                             `${ratingStars} \`${ratingNum} / 5\`\n\n` +
                             `💬 *CUSTOMER REVIEW*\n\n` +
                             `> ${review}\n\n` +
                             `👑 *ADSPOWER SELLER BD* 🚀`;

        const chatId = GROUP_ID.toString().startsWith('-') ? parseInt(GROUP_ID) : GROUP_ID;
        await bot.telegram.sendMessage(chatId, fakeSalesMsg, {
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error("Error sending fake sale:", err.message);
    }
}

// Reaction Counts Storage System (Default: ❤️ 25, 👌 14, 🫡 67, ⭐ 4.9, 🐷 12)
let memoryReactionCounts = { heart: 25, ok: 14, salute: 67, star: '4.9', pig: 12 };

async function getReactionCounts() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_REACTION_COUNTS');
        if (coupon && coupon.code) {
            const parts = coupon.code.split('|');
            if (parts.length >= 6) {
                return {
                    heart: parseInt(parts[1]) || 25,
                    ok: parseInt(parts[2]) || 14,
                    salute: parseInt(parts[3]) || 67,
                    star: parts[4] || '4.9',
                    pig: parseInt(parts[5]) || 12
                };
            }
        }
    }
    return memoryReactionCounts;
}

async function setReactionCounts(counts) {
    memoryReactionCounts = { ...counts };
    const code = `SYSTEM_REACTION_COUNTS|${counts.heart}|${counts.ok}|${counts.salute}|${counts.star}|${counts.pig}`;
    if (db.isConfigured()) {
        const existing = await db.getCoupon('SYSTEM_REACTION_COUNTS');
        if (existing) {
            await db.deleteCoupon(existing.code);
        }
        await db.createCoupon(code, 0);
    }
}

async function getGroupReactionButtons(countsOverride = null) {
    const counts = countsOverride || await getReactionCounts();
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(`❤️ ${counts.heart}`, `react_heart_${counts.heart}`),
            Markup.button.callback(`👌 ${counts.ok}`, `react_ok_${counts.ok}`),
            Markup.button.callback(`🫡 ${counts.salute}`, `react_salute_${counts.salute}`),
            Markup.button.callback(`⭐ ${counts.star}`, `react_star_${counts.star}`),
            Markup.button.callback(`🐷 ${counts.pig}`, `react_pig_${counts.pig}`)
        ]
    ]);
}

async function addAutoReactions(telegramObj, chatId, messageId) {
    // Disabled: Do not add any auto reactions to group messages
}

// Maintenance Mode & Scheduling Middleware
bot.use(async (ctx, next) => {
    // Only apply maintenance mode & selling hours restrictions to private direct chats with the bot
    if (ctx.chat && ctx.chat.type !== 'private') {
        return next();
    }
    if (ctx.from) {
        const userId = ctx.from.id.toString();
        if (userId !== ADMIN_ID) {
            // 1. Check manual maintenance mode first
            const isMaintenance = await getMaintenanceMode();
            if (isMaintenance) {
                if (ctx.callbackQuery) {
                    return ctx.answerCbQuery("⚠️ Bot is currently under maintenance. Please try again later.", { show_alert: true });
                }
                return ctx.reply("⚠️ *দুঃখিত! বটটি বর্তমানে রক্ষণাবেক্ষণ (Maintenance) মোডে রয়েছে।*\n\nখুব শীঘ্রই এটি আবার সচল করা হবে। যেকোনো জরুরি প্রয়োজনে যোগাযোগ করুন: @prime8088", { parse_mode: 'Markdown' });
            }

            // 2. Check scheduled selling hours (11:00 AM - 11:00 PM BD Time)
            const outside = await isOutsideSellingHours();
            if (outside) {
                const offHoursMsg = 
                    `✨ *SELLING TIME* ✨\n` +
                    `🕚 সকাল ১১:০০টা — রাত ১১:০০টা\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🛒 এই সময়ের মধ্যে নিয়মিত Selling চলবে।\n` +
                    `🤖 বট OFF হয়ে যাওয়ার পরেও\n` +
                    `যদি কারও কোনো অ্যাকাউন্টের প্রয়োজন হয়,\n` +
                    `তাহলে সরাসরি 👨‍💻 Admin-কে Message করুন।\n` +
                    `💎 আপনার প্রয়োজন অনুযায়ী\n` +
                    `কাঙ্ক্ষিত Account নিতে পারবেন।\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📲 *WhatsApp Support*\n` +
                    `👉 \`01864339154\`\n` +
                    `🔗 [WhatsApp Link](https://wa.me/8801864339154)\n` +
                    `⚡ Fast Service • Trusted • Easy\n` +
                    `📩 Need an Account? → Contact Admin: @prime8088`;

                if (ctx.callbackQuery) {
                    return ctx.answerCbQuery("⚠️ Selling is currently closed (11 PM - 11 AM).", { show_alert: true });
                }
                return ctx.reply(offHoursMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
            }
        }
    }
    return next();
});


// Fallback in-memory objects in case Supabase is not configured
const memoryUserSession = {};
const memoryPendingOrders = {}; 
const memoryAllStartedUsers = new Set(); 
const memoryUserOrderHistory = {}; 
const memoryAdminSession = {};
const memoryCoupons = {
    'WELCOME10': 10,
    'SPECIAL20': 20
};

function isAdmin(ctx) {
    if (!ctx.from) return false;
    const userId = ctx.from.id.toString();
    return userId === ADMIN_ID;
}

const lastUserSaveMap = new Map(); // userId -> timestamp

async function saveUser(ctx, force = false) {
    if (!ctx.from) return;
    const userId = ctx.from.id.toString();
    const now = Date.now();
    const lastSave = lastUserSaveMap.get(userId);
    if (!force && lastSave && (now - lastSave < 300000)) {
        return; // throttled (saved within last 5 minutes)
    }
    lastUserSaveMap.set(userId, now);

    const firstName = ctx.from.first_name || 'User';
    const username = ctx.from.username || '';

    if (db.isConfigured()) {
        const result = await db.saveUser(userId, firstName, username);
        if (result !== null) return;
    }
    memoryAllStartedUsers.add(userId);
}

async function getUserSession(userId) {
    if (db.isConfigured()) {
        const session = await db.getUserSession(userId);
        if (session !== null) {
            // Parse custom encoded method: "methodName|packageName|price|appliedCoupon|discount"
            const parts = session.method ? session.method.split('|') : [];
            const method = parts[0] || null;
            const packageName = parts[1] || '1 Account AdsPower';
            const price = parseInt(parts[2]) || 30;
            const appliedCoupon = parts[3] || null;
            const discount = parseInt(parts[4]) || 0;
            return {
                userId: session.user_id,
                method: method,
                packageName: packageName,
                price: price,
                appliedCoupon: appliedCoupon,
                discount: discount,
                waitingFor: session.waiting_for,
                proof: session.proof
            };
        }
    }
    if (!memoryUserSession[userId]) {
        memoryUserSession[userId] = { userId, method: null, packageName: '1 Account AdsPower', price: 30, appliedCoupon: null, discount: 0, waitingFor: null, proof: null };
    }
    return memoryUserSession[userId];
}

async function updateUserSession(userId, updateData) {
    const current = await getUserSession(userId);
    const merged = { ...current, ...updateData };

    if (db.isConfigured()) {
        // Encode method, packageName, price, appliedCoupon, and discount together into the "method" column
        const encodedMethod = `${merged.method || ''}|${merged.packageName || '1 Account AdsPower'}|${merged.price || 30}|${merged.appliedCoupon || ''}|${merged.discount || 0}`;
        const dbUpdate = {
            method: encodedMethod,
            waitingFor: merged.waitingFor,
            proof: merged.proof
        };
        const result = await db.updateUserSession(userId, dbUpdate);
        if (result !== null) return;
    }
    
    if (!memoryUserSession[userId]) {
        memoryUserSession[userId] = { userId, method: null, packageName: '1 Account AdsPower', price: 30, appliedCoupon: null, discount: 0, waitingFor: null, proof: null };
    }
    Object.assign(memoryUserSession[userId], updateData);
}

async function getAdminSession(userId) {
    if (db.isConfigured()) {
        const session = await db.getAdminSession(userId);
        if (session !== null) {
            const parts = session.step ? session.step.split('|') : [];
            const step = parts[0] || null;
            const extraData = parts[1] || null;
            return {
                userId: session.user_id,
                step: step,
                extraData: extraData,
                targetUserId: session.target_user_id,
                customEmail: session.custom_email
            };
        }
    }
    return memoryAdminSession[userId] || null;
}

async function updateAdminSession(userId, updateData) {
    if (db.isConfigured()) {
        let stepVal = updateData.step || '';
        if (updateData.extraData) {
            stepVal = `${stepVal}|${updateData.extraData}`;
        }
        const dbUpdate = {
            step: stepVal,
            targetUserId: updateData.targetUserId,
            customEmail: updateData.customEmail
        };
        const result = await db.updateAdminSession(userId, dbUpdate);
        if (result !== null) return;
    }
    if (!memoryAdminSession[userId]) {
        memoryAdminSession[userId] = { userId, step: null, extraData: null, targetUserId: null, customEmail: null };
    }
    Object.assign(memoryAdminSession[userId], updateData);
}

async function clearAdminSession(userId) {
    if (db.isConfigured()) {
        const result = await db.clearAdminSession(userId);
        if (result !== null) return;
    }
    delete memoryAdminSession[userId];
}

async function getUserOrders(userId) {
    if (db.isConfigured()) {
        const orders = await db.getUserOrders(userId);
        if (orders !== null) {
            return orders.map(ord => ({
                packageName: ord.package_name,
                method: ord.method,
                status: ord.status,
                customEmail: ord.custom_email,
                customPass: ord.custom_pass,
                loginCode: ord.login_code,
                createdAt: ord.created_at
            }));
        }
    }
    return memoryUserOrderHistory[userId] || [];
}

async function clearUserOrders(userId) {
    if (db.isConfigured()) {
        const result = await db.clearUserOrders(userId);
        if (result !== null) return;
    }
    memoryUserOrderHistory[userId] = [];
}

async function getPendingOrders() {
    if (db.isConfigured()) {
        const orders = await db.getPendingOrders();
        if (orders !== null) {
            return orders.map(ord => ({
                name: ord.name,
                method: ord.method ? ord.method.split('|')[0] : 'Unknown', // decode method
                userId: ord.user_id,
                packageName: ord.package_name
            }));
        }
    }
    return Object.values(memoryPendingOrders).filter(o => o.status === 'Pending Verification');
}

async function getOrderForUser(userId) {
    if (db.isConfigured()) {
        const ord = await db.getOrderForUser(userId);
        if (ord !== null) {
            return {
                name: ord.name,
                username: ord.username,
                userId: ord.user_id,
                method: ord.method ? ord.method.split('|')[0] : 'Unknown', // decode method
                proof: ord.proof,
                status: ord.status,
                packageName: ord.package_name
            };
        }
    }
    return memoryPendingOrders[userId] || null;
}

async function rejectOrderDB(userId) {
    if (db.isConfigured()) {
        const result = await db.updateOrderStatus(userId, 'Rejected', null, null);
        if (result !== null) return;
    }
    if (memoryPendingOrders[userId]) {
        memoryPendingOrders[userId].status = 'Rejected';
        delete memoryPendingOrders[userId];
    }
}

async function getSalesReportStats() {
    if (db.isConfigured()) {
        const stats = await db.getSalesReport();
        if (stats !== null) return stats;
    }
    
    // Memory fallback calculation
    let totalCount = 0;
    let totalRevenue = 0;
    let todayRevenue = 0;
    let monthRevenue = 0;
    
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const allMemoryOrders = [];
    Object.keys(memoryUserOrderHistory).forEach(uid => {
        memoryUserOrderHistory[uid].forEach(ord => {
            if (ord.status === 'Completed') {
                allMemoryOrders.push(ord);
            }
        });
    });
    
    allMemoryOrders.forEach(ord => {
        totalCount++;
        totalRevenue += 30; // default 30 TK
        const orderDate = new Date(ord.createdAt || now);
        if (orderDate >= startOfToday) {
            todayRevenue += 30;
        }
        if (orderDate >= startOfMonth) {
            monthRevenue += 30;
        }
    });
    
    return { totalCount, totalRevenue, todayRevenue, monthRevenue };
}

async function getUserIdsForBroadcast() {
    if (db.isConfigured()) {
        const users = await db.getAllUsers();
        if (users !== null) {
            return users.map(u => u.user_id);
        }
    }
    return Array.from(memoryAllStartedUsers);
}

// Reusable menu component with FAQ integrated
async function getMainMenu(userName) {
    const defaultText = `👋 *স্বাগতম {name}! আমাদের শপে আপনাকে অভিনন্দন!* \n\n> 🔒 *Unlock Ultimate Multi-Accounting Security & Speed!*\n\n📌 অনুগ্রহ করে নিচের বাটনগুলো থেকে আপনার প্রয়োজনীয় অপশনটি সিলেক্ট করুন:`;
    const customMsg = await getCustomText('MSG_WELCOME', defaultText);
    const welcomeEmojiTag = await getItemEmojiTag('WELCOME', '💎');
    
    let msgContent = customMsg.includes('{name}') ? customMsg.replace('{name}', userName) : customMsg;
    const text = `${welcomeEmojiTag} *AdsPower Seller BD* ${welcomeEmojiTag}\n\n${msgContent}`;

    const detailsLabel = await getCustomText('LABEL_DETAILS', 'AdsPower Details');
    const buyLabel = await getCustomText('LABEL_BUY_NOW', 'Buy Now');
    const profileLabel = await getCustomText('LABEL_PROFILE', 'My Profile');
    const orderLabel = await getCustomText('LABEL_MY_ORDER', 'My Order');
    const noticeLabel = await getCustomText('LABEL_NOTICE', 'Offers & Notice');
    const faqLabel = await getCustomText('LABEL_FAQ', 'FAQ & Help Guide');
    const leaderLabel = await getCustomText('LABEL_LEADERBOARD', 'Leaderboard');
    const supportLabel = await getCustomText('LABEL_SUPPORT', 'Contact Support');

    return {
        text: text,
        extra: {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [styledBtn(`📦 ${detailsLabel}`, 'details', 'primary')],
                [styledBtn(`🛒 ${buyLabel}`, 'buy_options', 'success')],
                [styledBtn(`👤 ${profileLabel}`, 'profile', 'primary'), styledBtn(`🛍 ${orderLabel}`, 'my_order', 'primary')],
                [styledBtn(`📢 ${noticeLabel}`, 'notice_board', 'primary'), styledBtn(`❓ ${faqLabel}`, 'faq_menu', 'primary')],
                [styledBtn(`🏆 ${leaderLabel}`, 'leaderboard', 'primary'), styledBtn(`📞 ${supportLabel}`, 'support', 'primary')]
            ])
        }
    };
}

const adminReplyKeyboard = Markup.keyboard([
    ['⭐ 📦 Pending Orders ⭐', '⭐ 👥 Total Bot Users ⭐'],
    ['📢 Broadcast 📢', '📊 Sales Report 📊'],
    ['🎟️ Coupons 🎟️', '⚙️ Bot Control ⚙️'],
    ['👑 Close Admin Panel 👑']
]).resize();

// Force Join & Ban Verification Middleware
bot.use(async (ctx, next) => {
    const userId = ctx.from ? ctx.from.id.toString() : null;
    if (!userId || userId === ADMIN_ID) return next();

    // Check if user is banned
    const isBanned = await db.isUserBanned(userId);
    if (isBanned) {
        const banMsg = "⛔ *আপনার অ্যাকাউন্টটি এডমিন কর্তৃক স্থগিত/ব্যান করা হয়েছে।*\n\nসহায়তার জন্য এডমিনের সাথে যোগাযোগ করুন।";
        if (ctx.callbackQuery) {
            return ctx.answerCbQuery("আপনার অ্যাকাউন্টটি স্থগিত/ব্যান করা হয়েছে!", { show_alert: true });
        } else {
            return ctx.reply(banMsg, { parse_mode: 'Markdown' });
        }
    }

    // Skip checks for verifying join
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'verify_join') {
        return next();
    }

    const joined = await checkUserJoinedGroup(ctx, userId);
    if (!joined) {
        // Run referral command capture in middleware in case they started via ref link
        if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start ref_')) {
            const text = ctx.message.text;
            const refMatch = text.match(/^\/start ref_(\d+)$/);
            if (refMatch) {
                const referrerId = refMatch[1];
                const newUserId = ctx.from.id.toString();
                const isNew = await checkIfUserIsNew(newUserId);
                if (isNew && referrerId !== newUserId) {
                    await saveReferral(newUserId, referrerId);
                    try {
                        await ctx.telegram.sendMessage(referrerId, `👥 একজন কাস্টমার আপনার রেফারেল লিংকের মাধ্যমে বটে প্রবেশ করেছেন! তিনি প্রথম অর্ডার সম্পন্ন করলেই আপনি ৩ টাকা ডিসকাউন্ট কুপন পাবেন।`);
                    } catch (err) {}
                }
            }
        }

        let inviteLink = "https://t.me/AdsPowerSellerBDGroup";
        try {
            const chat = await ctx.telegram.getChat(parseInt(GROUP_ID));
            if (chat.invite_link) {
                inviteLink = chat.invite_link;
            } else if (chat.username) {
                inviteLink = `https://t.me/${chat.username}`;
            }
        } catch (err) {}

        const msg = `📢 *অফিসিয়াল গ্রুপে জয়েন করুন!* 📢\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `বটের সকল সার্ভিস সচল করতে প্রথমে আমাদের অফিসিয়াল গ্রুপে জয়েন করুন।\n\n` +
                    `👇 নিচে জয়েন করে ভেরিফাই বাটনে ক্লিক করুন:`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('👥 Join Group', inviteLink)],
            [Markup.button.callback('🟢 Verify / Check Join', 'verify_join')]
        ]);

        if (ctx.callbackQuery) {
            await ctx.answerCbQuery("গ্রুপে জয়েন করা বাধ্যতামূলক!", { show_alert: true });
            try {
                return await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
            } catch (e) {
                return await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
            }
        } else {
            return await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
        }
    }

    return next();
});

// /start কমান্ড
bot.start(async (ctx) => {
    try {
        const text = ctx.message ? ctx.message.text : '';
        const refMatch = text.match(/^\/start ref_(\d+)$/);
        let referredByMsg = '';
        if (refMatch) {
            const referrerId = refMatch[1];
            const newUserId = ctx.from.id.toString();
            const isNew = await checkIfUserIsNew(newUserId);
            if (isNew && referrerId !== newUserId) {
                await saveReferral(newUserId, referrerId);
                referredByMsg = `🎉 *আপনি আপনার বন্ধুর রেফারেল লিংকের মাধ্যমে প্রবেশ করেছেন!*\n\nআপনার প্রথম কেনাকাটা সফলভাবে সম্পন্ন হলে আপনার বন্ধু ৩ টাকা ডিসকাউন্ট কুপন কমিশন পাবেন। ❤️\n\n`;
                try {
                    await ctx.telegram.sendMessage(referrerId, `👥 একজন কাস্টমার আপনার রেফারেল লিংকের মাধ্যমে বটে প্রবেশ করেছেন! তিনি প্রথম অর্ডার সম্পন্ন করলেই আপনি ৩ টাকা ডিসকাউন্ট কুপন পাবেন।`);
                } catch (err) {}
            }
        }

        const userId = ctx.from.id.toString();
        try { await saveUser(ctx, true); } catch (e) {}
        try { await updateUserSession(userId, { waitingFor: null, tempRating: null }); } catch (e) {}
        try { await checkAndSendNotice(ctx); } catch (e) {}
        const userName = ctx.from.first_name || "User";
        const menu = await getMainMenu(userName);
        if (referredByMsg) {
            try { await ctx.reply(referredByMsg, { parse_mode: 'Markdown' }); } catch (e) {}
        }
        return await ctx.reply(menu.text, menu.extra);
    } catch (err) {
        console.error("Error in /start command:", err.message);
        const userName = (ctx.from && ctx.from.first_name) || "User";
        const fallbackMenu = await getMainMenu(userName);
        return ctx.reply(fallbackMenu.text, fallbackMenu.extra);
    }
});

// Instant answer to all callback queries to prevent button loading delays / spinning
bot.on('callback_query', async (ctx, next) => {
    ctx.answerCbQuery().catch(() => {});
    return next();
});

// Inline Action: Main Menu (Back navigation handler)
bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    const userName = ctx.from.first_name || "User";
    const menu = await getMainMenu(userName);
    try {
        await ctx.editMessageText(menu.text, menu.extra);
    } catch (e) {
        await ctx.reply(menu.text, menu.extra);
    }
});

// AdsPower Details with Close/OK button & Back button
bot.action('details', async (ctx) => {
    await ctx.answerCbQuery();
    const detailsText = 
        `💎 *AdsPower Browser Premium Pass* 💎\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *Unlock Ultimate Multi-Accounting Security & Speed!*\n\n` +
        `আপনি কি Facebook, TikTok, E-commerce, or Airdrop-এর একাধিক অ্যাকাউন্ট ম্যানেজ করতে গিয়ে ব্যান বা রেস্ট্রিকশনের সমস্যায় পড়ছেন? আজই নিন AdsPower Premium Access এবং অ্যাকাউন্ট ব্যান হওয়া চিরতরে বন্ধ করুন!\n\n` +
        `✨ *Package Benefits & Features:* ✨\n` +
        `• 🔒 *Canvas & WebGL Fingerprint Protection:* প্রতিটি প্রোফাইলের জন্য আলাদা Real Canvas, WebGL, এবং Hardware Fingerprint যাতে সাইটগুলো ট্র্যাক করতে না পারে।\n` +
        `• 🌐 *Unlimited Proxy Integration:* HTTP, HTTPS, SOCKS5 প্রক্সি খুব সহজেই সেটআপ করার সুবিধা। আইপি লিক হওয়ার কোনো ঝুঁকি নেই।\n` +
        `• 👥 *Team Collaboration & Sync:* আপনার টিম মেম্বারদের নির্দিষ্ট ব্রাউজার প্রোফাইলের অ্যাক্সেস দিতে পারবেন পাসওয়ার্ড শেয়ার না করেই।\n` +
        `• 🤖 *RPA Automation & Synchronizer:* এক ব্রাউজারে কাজ করলেই বাকি ব্রাউজারগুলোতে অটোমেটিক একই কাজ হয়ে যাবে (Multi-window sync)।\n\n` +
        `💸 *Premium Package Pricing:* 💸\n` +
        `• 💳 1 Account AdsPower = *30 TK*\n` +
        `• 💳 3 Accounts AdsPower = *80 TK*\n` +
        `• 💳 5 Accounts AdsPower = *135 TK*\n\n` +
        `⏳ *Duration:* 10 Days Full Access\n` +
        `🛡 *Uptime Guarantee:* ২৪ ঘণ্টার ফুল সাপোর্ট বা অ্যাকাউন্ট রিপ্লেসমেন্ট গ্যারান্টি।\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 নিচে ক্লিক করে সরাসরি পেমেন্ট গেটওয়েতে চলে যান:`;

    const closeDetailsLabel = await getCustomText('LABEL_CLOSE_DETAILS', 'Close Details');
    const backMenuLabel = await getCustomText('LABEL_BACK_MENU', 'Back to Menu');

    try {
        await ctx.editMessageText(detailsText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`❌ ${closeDetailsLabel}`, 'close_details')],
                [Markup.button.callback(`⬅️ ${backMenuLabel}`, 'main_menu')]
            ])
        });
    } catch(e) {
        return ctx.reply(detailsText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`❌ ${closeDetailsLabel}`, 'close_details')],
                [Markup.button.callback(`⬅️ ${backMenuLabel}`, 'main_menu')]
            ])
        });
    }
});

bot.action('close_details', async (ctx) => {
    try {
        await ctx.deleteMessage();
    } catch (e) {
        await ctx.answerCbQuery("Closed!");
    }
});

// Update buy_options to show Package Selection first
bot.action('buy_options', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.from;

    await checkAndSendNotice(ctx);

    // Optional admin trace alert when checkout starts
    try {
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `🛒 *User checked packages!*\n\n` +
            `• Name: ${user.first_name || 'User'}\n` +
            `• Username: @${user.username ? user.username : 'N/A'}\n` +
            `• User ID: \`${user.id}\``,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {}

    // Reset applied coupon when user selects a new package
    await updateUserSession(user.id.toString(), { appliedCoupon: '', discount: 0 });

    const stock1 = await getPackageStockStatus('pkg_1');
    const stock3 = await getPackageStockStatus('pkg_3');
    const stock5 = await getPackageStockStatus('pkg_5');

    const pkg1Label = await getCustomText('LABEL_PKG_1', '1 Account AdsPower = 30 TK');
    const pkg3Label = await getCustomText('LABEL_PKG_3', '3 Accounts AdsPower = 80 TK');
    const pkg5Label = await getCustomText('LABEL_PKG_5', '5 Accounts AdsPower = 135 TK');
    const backMenuLabel = await getCustomText('LABEL_BACK_MENU', 'Back to Menu');

    const pkgText = `⭐️ *AdsPower Seller BD* ⭐️\n` +
                    `📦 *Select Packages / প্যাকেজ সিলেক্ট করুন*:\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `📌 নিচের অপশনগুলো থেকে আপনার প্রয়োজনীয় প্যাকেজটি সিলেক্ট করুন:`;
    const pkgExtra = {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`⚡ ${pkg1Label} ${stock1 ? '🟢' : '🔴 (Out of stock)'}`, 'pkg_1_30')],
            [Markup.button.callback(`🔥 ${pkg3Label} ${stock3 ? '🟢' : '🔴 (Out of stock)'}`, 'pkg_3_80')],
            [Markup.button.callback(`👑 ${pkg5Label} ${stock5 ? '🟢' : '🔴 (Out of stock)'}`, 'pkg_5_135')],
            [Markup.button.callback(`⬅️ ${backMenuLabel}`, 'main_menu')]
        ])
    };

    try {
        await ctx.editMessageText(pkgText, pkgExtra);
    } catch(e) {
        return ctx.reply(pkgText, pkgExtra);
    }
});

// Helper function to render payment selection screen with dynamic coupon status
async function showPaymentSelectionScreen(ctx, userId) {
    const session = await getUserSession(userId);
    const price = session.price || 30;
    const discount = session.discount || 0;
    const finalPrice = Math.max(0, price - discount);

    let couponInfo = "";
    if (session.appliedCoupon) {
        couponInfo = `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${discount} TK)\n`;
    }

    const buyNowEmojiTag = await getItemEmojiTag('BUY_NOW', '🛒');
    const bkashLabel = await getCustomText('LABEL_BKASH', 'bKash');
    const nagadLabel = await getCustomText('LABEL_NAGAD', 'Nagad');
    const binanceLabel = await getCustomText('LABEL_BINANCE', 'Binance (USDT)');
    const payoneerLabel = await getCustomText('LABEL_PAYONEER', 'Payoneer');

    const bkashEmojiTag = await getItemEmojiTag('BKASH', '🌸');
    const nagadEmojiTag = await getItemEmojiTag('NAGAD', '🍑');
    const binanceEmojiTag = await getItemEmojiTag('BINANCE', '🟡');
    const payoneerEmojiTag = await getItemEmojiTag('PAYONEER', '🔷');

    const buyText = `${buyNowEmojiTag} *Checkout Summary* ${buyNowEmojiTag}\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📦 *Package:* \`${session.packageName}\` (${price} TK)\n` +
                    couponInfo +
                    `💰 *Total Payable:* *${finalPrice} TK*\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `✨ *Select Payment Method / পেমেন্ট মেথড সিলেক্ট করুন:*`;
    
    const applyCouponLabel = await getCustomText('LABEL_APPLY_COUPON', 'Apply Coupon Code');
    const backMenuLabel = await getCustomText('LABEL_BACK_MENU', 'Back');

    const buyExtra = {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`🇧🇩 ${bkashLabel}`, 'pay_bkash'), Markup.button.callback(`🇧🇩 ${nagadLabel}`, 'pay_nagad')],
            [Markup.button.callback(`🌐 ${binanceLabel}`, 'pay_binance'), Markup.button.callback(`🌐 ${payoneerLabel}`, 'pay_payoneer')],
            [Markup.button.callback(`🎟️ ${applyCouponLabel}`, 'apply_coupon_prompt')],
            [Markup.button.callback(`⬅️ ${backMenuLabel}`, 'buy_options')]
        ])
    };

    try {
        await ctx.editMessageText(buyText, buyExtra);
    } catch(e) {
        return ctx.reply(buyText, buyExtra);
    }
}

// Callback handler for package selection
bot.action(/^pkg_(\d+)_(\d+)$/, async (ctx) => {
    const count = ctx.match[1];
    const price = ctx.match[2];
    const userId = ctx.from.id.toString();

    // Check Stock first
    const isAvailable = await getPackageStockStatus(`pkg_${count}`);
    if (!isAvailable) {
        return ctx.answerCbQuery("❌ দুঃখিত! এই প্যাকেজটি বর্তমানে আউট অব স্টক।", { show_alert: true });
    }

    await ctx.answerCbQuery();
    const packageName = `${count} Account${count > 1 ? 's' : ''} AdsPower`;
    
    // Save package selection in user session
    await updateUserSession(userId, { packageName, price: parseInt(price), appliedCoupon: '', discount: 0 });

    const isCustomEmailAllowed = await db.getAllowCustomEmailStatus();
    if (!isCustomEmailAllowed) {
        await updateUserSession(userId, { customEmail: 'Stock Account' });
        return showPaymentSelectionScreen(ctx, userId);
    }

    const stockAccLabel = await getCustomText('LABEL_ACCOUNT_STOCK', 'Get Account from Stock Pool');
    const ownEmailLabel = await getCustomText('LABEL_ACCOUNT_OWN_EMAIL', 'Provide My Own Email');
    const backMenuLabel = await getCustomText('LABEL_BACK_MENU', 'Back to Menu');

    return ctx.reply(
        "📦 *অ্যাকাউন্ট টাইপ সিলেক্ট করুন / Select Account Mode:* \n" +
        "━━━━━━━━━━━━━━━━━━\n\n" +
        "> 1. **Get Account from Stock:** আমাদের তৈরি করা রেডিমেড স্টক থেকে ইন্সট্যান্ট অ্যাকাউন্ট পাবেন।\n" +
        "> 2. **Provide My Own Email:** আপনার নিজের জিমেইল/ইমেইলে ১০ দিনের প্রিমিয়াম সুবিধা একটিভ করে নিবেন।\n\n" +
        "👇 নিচের বাটন থেকে আপনার সুবিধাজনক অপশনটি বেছে নিন:",
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`📦 ${stockAccLabel}`, 'choose_account_stock')],
                [Markup.button.callback(`📧 ${ownEmailLabel}`, 'choose_account_own_email')],
                [Markup.button.callback(`⬅️ ${backMenuLabel}`, 'buy_options')]
            ])
        }
    );
});

bot.action('choose_account_stock', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { customEmail: 'Stock Account' });
    return showPaymentSelectionScreen(ctx, userId);
});

bot.action('choose_account_own_email', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'user_custom_email_input' });
    return ctx.reply("📧 অনুগ্রহ করে আপনার ইমেইল এড্রেসটি লিখে পাঠান (যেটিতে AdsPower প্রিমিয়াম সেটআপ পাবেন):");
});

// Callback to trigger Coupon Input prompt
bot.action('apply_coupon_prompt', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'coupon_code' });
    return ctx.reply("🎟️ অনুগ্রহ করে আপনার কুপন কোডটি লিখে পাঠান (যেমন: WELCOME10):");
});

bot.action('profile', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.from;
    const botUsername = ctx.botInfo ? ctx.botInfo.username : 'AdsPowerSellerBDBot';
    const refLink = `https://t.me/${botUsername}?start=ref_${user.id}`;

    let inviteLink = "https://t.me/AdsPowerSellerBDGroup";
    try {
        const chat = await ctx.telegram.getChat(parseInt(GROUP_ID));
        if (chat.invite_link) {
            inviteLink = chat.invite_link;
        } else if (chat.username) {
            inviteLink = `https://t.me/${chat.username}`;
        }
    } catch (err) {}

    const stats = await getReferralStats(user.id.toString());
    const totalEarnings = stats.successful * 3;
    
    const profileText = `👤 *My Profile Info / আমার প্রোফাইল* 👤\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `• *Name:* \`${user.first_name}\`\n` +
                        `• *Username:* @${user.username || 'N/A'}\n` +
                        `• *User ID:* \`${user.id}\` (ক্লিক করে কপি করুন)\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `👥 *Referral Statistics / রেফার ড্যাশবোর্ড:*\n` +
                        `• *Successful Refers (সফল রেফার):* \`${stats.successful}\` জন\n` +
                        `• *Pending Refers (পেন্ডিং রেফার):* \`${stats.pending}\` জন\n` +
                        `• *Total Earnings (মোট কমিশন আয়):* \`${totalEarnings} TK\`\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `👥 *Refer & Earn (রেফারেল লিংক):*\n` +
                        `• \`${refLink}\` (ক্লিক করে কপি করুন)\n` +
                        `> এই লিংকটি বন্ধুদের সাথে শেয়ার করুন। আপনার লিংকের মাধ্যমে কেউ এসে প্রথম কেনাকাটা সম্পূর্ণ করলে আপনি পাবেন *৩ টাকা* ডিসকাউন্ট কুপন! 🎁\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💎 *AdsPower Seller BD* এর সাথে থাকার জন্য ধন্যবাদ!`;
    return ctx.reply(profileText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('👥 Join Our Group', inviteLink)],
            [Markup.button.callback('⬅️ Back to Menu', 'main_menu')]
        ])
    });
});

bot.action('my_order', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const history = await getUserOrders(userId);

    if (!history || history.length === 0) {
        return ctx.reply(
            `🛍 *Your Orders / আপনার অর্ডার* 🛍\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `> ❌ আপনার কোনো পূর্ববর্তী অর্ডার পাওয়া যায়নি।`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
        });
    }

    let text = `🛍 *Your Order History / লাইভ ট্র্যাকিং* 🛍\n` +
               `━━━━━━━━━━━━━━━━━━\n\n`;
    history.forEach((ord, index) => {
        const dateStr = ord.createdAt ? new Date(ord.createdAt).toLocaleString() : 'N/A';
        
        let statusEmoji = "⏳";
        let statusTextBengali = "অ্যাডমিন ভেরিফাই করছেন...";
        let progressBar = "";
        
        if (ord.status === 'Completed') {
            statusEmoji = "✅";
            statusTextBengali = "সম্পন্ন হয়েছে (Delivered)";
            progressBar = "`✅ Verified ➔ ⚙️ Delivered ➔ 📦 Completed`";
        } else if (ord.status === 'Rejected') {
            statusEmoji = "❌";
            statusTextBengali = "প্রত্যাখ্যান করা হয়েছে (Rejected)";
            progressBar = "`❌ Order Rejected`";
        } else if (ord.status === 'Cancelled') {
            statusEmoji = "❌";
            statusTextBengali = "বাতিল করা হয়েছে (Cancelled)";
            progressBar = "`❌ Order Cancelled`";
        } else {
            // Pending Verification
            progressBar = "`⏳ Pending Verification ➔ ⚙️ Processing ➔ 📦 Completed`";
        }

        text += `📦 *Order #${index + 1}:* \`${ord.packageName}\`\n` +
                `   💳 *Method:* \`${ord.method ? ord.method.split('|')[0] : 'Unknown'}\`\n` +
                `   ${statusEmoji} *Status:* *${ord.status}* (${statusTextBengali})\n` +
                `   📈 *Progress:* ${progressBar}\n` +
                `   📅 *Date:* \`${dateStr}\`\n`;
                
        if (ord.status === 'Completed') {
            text += `   ━━━━━━━━━━━━━━━━━━\n`;
            if (ord.customEmail && ord.customEmail.includes(':')) {
                const lines = ord.customEmail.split('\n');
                lines.forEach((line, idx) => {
                    const parts = line.split(':');
                    if (parts.length >= 2) {
                        text += `   *Account #${idx + 1}:*\n` +
                                `   📧 Email: \`${parts[0].trim()}\`\n` +
                                `   🔑 Pass: \`${parts[1].trim()}\`\n`;
                    }
                });
            } else {
                if (ord.customEmail || ord.customPass) {
                    text += `   📧 *Email:* \`${ord.customEmail || 'N/A'}\`\n` +
                            `   🔑 *Password:* \`${ord.customPass || 'N/A'}\`\n`;
                }
            }
            if (ord.loginCode) {
                text += `   ⏳ *Login Code:* \`${ord.loginCode}\`\n`;
            }
            text += `   ━━━━━━━━━━━━━━━━━━\n`;
        }
        text += `\n`;
    });

    const cancelOrderLabel = await getCustomText('LABEL_CANCEL_ORDER', 'Cancel Pending Order');
    const clearOrderLabel = await getCustomText('LABEL_CLEAR_ORDER', 'Clear History');
    const backMenuLabel = await getCustomText('LABEL_BACK_MENU', 'Back to Menu');

    const hasPendingOrder = history.some(ord => ord.status === 'Pending Verification');
    const inlineButtons = [];
    if (hasPendingOrder) {
        inlineButtons.push([Markup.button.callback(`❌ ${cancelOrderLabel}`, 'cancel_my_pending_order')]);
    }
    inlineButtons.push([
        Markup.button.callback(`🗑 ${clearOrderLabel}`, 'clear_my_order'),
        Markup.button.callback(`⬅️ ${backMenuLabel}`, 'main_menu')
    ]);

    try {
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(inlineButtons)
        });
    } catch(e) {
        return ctx.reply(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(inlineButtons)
        });
    }
});

bot.action('clear_my_order', async (ctx) => {
    await ctx.answerCbQuery("Order history cleared!");
    const userId = ctx.from.id.toString();
    await clearUserOrders(userId);
    return ctx.reply(
        `🗑 *History Cleared / হিস্ট্রি ডিলিট* 🗑\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `> ✅ আপনার অর্ডার হিস্ট্রি সফলভাবে মুছে ফেলা হয়েছে।`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action('cancel_my_pending_order', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    let result = false;
    if (db.isConfigured()) {
        result = await db.cancelOrder(userId);
    } else {
        if (memoryPendingOrders[userId] && memoryPendingOrders[userId].status === 'Pending Verification') {
            memoryPendingOrders[userId].status = 'Cancelled';
            result = true;
        }
    }
    
    if (result) {
        if (memoryUserOrderHistory[userId]) {
            const pendingOrdIdx = memoryUserOrderHistory[userId].findIndex(o => o.status === 'Pending Verification');
            if (pendingOrdIdx !== -1) {
                memoryUserOrderHistory[userId][pendingOrdIdx].status = 'Cancelled';
            }
        }
        
        await ctx.answerCbQuery("Pending order cancelled!");
        
        try {
            await ctx.telegram.sendMessage(
                ADMIN_ID,
                `❌ *Order Cancelled by User!*\n\n` +
                `• Name: ${ctx.from.first_name || 'User'}\n` +
                `• Username: @${ctx.from.username || 'N/A'}\n` +
                `• User ID: \`${userId}\`\n` +
                `• Status: Cancelled`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}

        return ctx.reply(
            `❌ *অর্ডার বাতিল করা হয়েছে!* ❌\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `> আপনার পেন্ডিং অর্ডারটি সফলভাবে বাতিল করা হয়েছে। আপনি চাইলে এখন আবার নতুন করে অর্ডার করতে পারবেন।`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
        });
    } else {
        return ctx.answerCbQuery("কোনো পেন্ডিং অর্ডার পাওয়া যায়নি!", { show_alert: true });
    }
});

bot.action('transaction', async (ctx) => {
    await ctx.answerCbQuery();
    const txText = `🧾 *Transaction Status / লেনদেন* 🧾\n` +
                   `━━━━━━━━━━━━━━━━━━\n` +
                   `> 🟢 **Verified Account Profile**\n\n` +
                   `🔒 আপনার সকল লেনদেন এবং অ্যাকাউন্ট তথ্য আমাদের সিস্টেমে সম্পূর্ণ নিরাপদ ও সুরক্ষিত রয়েছে।`;
    return ctx.reply(txText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action('notice_board', async (ctx) => {
    await ctx.answerCbQuery();
    const noticeText = await getNoticeText();
    const text = `📢 *AdsPower Seller BD - Notice Board* 📢\n` +
                 `━━━━━━━━━━━━━━━━━━\n\n` +
                 `${noticeText}\n\n` +
                 `━━━━━━━━━━━━━━━━━━\n` +
                 `🔔 নতুন আপডেট ও ডিসকাউন্ট অফার পেতে গ্রুপে একটিভ থাকুন!`;
    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action(/^react_(star|heart|ok|salute|pig)_(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    let currentVal = parseInt(ctx.match[2]) || 1;
    let newCount = currentVal + 1;

    let alertMessage = "ধন্যবাদ! আপনার রিয়্যাকশন যুক্ত হয়েছে! ❤️";
    if (type === 'star') alertMessage = "ধন্যবাদ! আপনার ⭐ রিয়্যাকশন যুক্ত হয়েছে!";
    if (type === 'ok') alertMessage = "ধন্যবাদ! আপনার 👌 রিয়্যাকশন যুক্ত হয়েছে!";
    if (type === 'salute') alertMessage = "ধন্যবাদ! আপনার 🫡 রিয়্যাকশন যুক্ত হয়েছে!";
    if (type === 'pig') alertMessage = "ধন্যবাদ! আপনার 🐷 রিয়্যাকশন যুক্ত হয়েছে!";

    await ctx.answerCbQuery(alertMessage, { show_alert: true });

    try {
        if (ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup) {
            const keyboard = ctx.callbackQuery.message.reply_markup.inline_keyboard;
            const updatedKeyboard = keyboard.map(row => {
                return row.map(btn => {
                    if (btn.callback_data === ctx.callbackQuery.data) {
                        let label = btn.text;
                        if (type === 'star') label = `⭐ ${newCount}`;
                        if (type === 'heart') label = `❤️ ${newCount}`;
                        if (type === 'ok') label = `👌 ${newCount}`;
                        if (type === 'salute') label = `🫡 ${newCount}`;
                        if (type === 'pig') label = `🐷 ${newCount}`;
                        return Markup.button.callback(label, `react_${type}_${newCount}`);
                    }
                    return btn;
                });
            });
            await ctx.editMessageReplyMarkup({ inline_keyboard: updatedKeyboard });
        }
    } catch (err) {}
});

bot.action('leaderboard', async (ctx) => {
    await ctx.answerCbQuery();
    const text = await getLeaderboardText();
    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action('verify_join', async (ctx) => {
    const userId = ctx.from.id.toString();
    groupMemberCache.delete(userId);
    const joined = await checkUserJoinedGroup(ctx, userId, true);
    if (joined) {
        await ctx.answerCbQuery("সফলভাবে ভেরিফাই হয়েছে! ❤️", { show_alert: true });
        try { await ctx.deleteMessage(); } catch(e) {}
        const userName = ctx.from.first_name || "User";
        const menu = await getMainMenu(userName);
        return ctx.reply(menu.text, menu.extra);
    } else {
        return ctx.answerCbQuery("❌ আপনি এখনো গ্রুপে জয়েন করেননি! অনুগ্রহ করে জয়েন করে আবার ট্রাই করুন।", { show_alert: true });
    }
});

bot.action('support', async (ctx) => {
    await ctx.answerCbQuery();
    const supportUser = await getCustomText('SUPPORT_USER', '@prime8088');
    const rawWaNumber = await getCustomText('WHATSAPP_NUMBER', '01864339154');
    
    const cleanUsername = supportUser.replace(/^@/, '').trim();
    const adminUrl = `https://t.me/${cleanUsername}`;
    
    const cleanWaNumber = rawWaNumber.replace(/[^0-9]/g, '');
    const formattedWaNumber = cleanWaNumber.startsWith('88') ? cleanWaNumber : (cleanWaNumber.startsWith('0') ? `88${cleanWaNumber}` : `880${cleanWaNumber}`);
    const waUrl = `https://wa.me/${formattedWaNumber}`;

    const supportText = `📞 *Contact Support / সাহায্য কেন্দ্র* 📞\n` +
                        `━━━━━━━━━━━━━━━━━━\n\n` +
                        `💬 যেকোনো ধরনের সমস্যা বা সাহায্যের জন্য সরাসরি এডমিনের সাথে যোগাযোগ করুন।\n\n` +
                        `👇 নিচের বাটনগুলোতে ক্লিক করে মেসেজ পাঠান:`;
                        
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('👨‍💻 Admin Telegram', adminUrl)],
        [Markup.button.url('📲 WhatsApp Support', waUrl)],
        [Markup.button.callback('✉️ Send Message in Bot', 'open_support_ticket')],
        [Markup.button.callback('⬅️ Back to Menu', 'main_menu')]
    ]);

    try {
        return await ctx.editMessageText(supportText, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        return await ctx.reply(supportText, { parse_mode: 'Markdown', ...keyboard });
    }
});

bot.action('open_support_ticket', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'support_message' });
    return ctx.reply("✍️ অনুগ্রহ করে আপনার প্রশ্ন বা বার্তাটি এখানে লিখে পাঠান (অ্যাডমিন এটি দেখে সরাসরি বটের মাধ্যমে উত্তর দেবেন):");
});

bot.action(/^reply_support_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];
    const adminId = ctx.from.id.toString();
    
    await updateAdminSession(adminId, { step: `waiting_for_support_reply`, targetUserId: targetUserId });
    return ctx.reply(`✍️ ইউজারকে (ID: \`${targetUserId}\`) উত্তর দেওয়ার জন্য আপনার মেসেজটি লিখে পাঠান:`, { parse_mode: 'Markdown' });
});

// FAQ Section Actions
bot.action('faq_menu', async (ctx) => {
    await ctx.answerCbQuery();
    const faqText = `❓ *AdsPower Help Center & FAQ Guide* ❓\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `📌 আপনার প্রয়োজনীয় প্রশ্নের সমাধান পেতে নিচের যেকোনো একটি টপিক সিলেক্ট করুন:`;
    const faqExtra = {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🛠 1. How to Setup Proxy (প্রক্সি সেটআপ)', 'faq_proxy')],
            [Markup.button.callback('🔑 2. Login Code Issue (লগইন কোড সমস্যা)', 'faq_logincode')],
            [Markup.button.callback('🛡 3. Replacement Policy (রিপ্লেসমেন্ট পলিসি)', 'faq_replacement')],
            [Markup.button.callback('⬅️ Back to Main Menu', 'main_menu')]
        ])
    };
    try {
        await ctx.editMessageText(faqText, faqExtra);
    } catch(e) {
        return ctx.reply(faqText, faqExtra);
    }
});

bot.action('faq_proxy', async (ctx) => {
    await ctx.answerCbQuery();
    const text = 
        `🛠 *AdsPower - Proxy Setup Guide* 🛠\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *একাধিক অ্যাকাউন্ট সুরক্ষিত রাখতে প্রক্সি সেটআপ করা অত্যন্ত জরুরি।*\n\n` +
        `১. *AdsPower Browser* ওপেন করে **"Profiles"** সেকশনে যান এবং **"Single Import"**-এ ক্লিক করুন।\n` +
        `২. **"Proxy Information"** সেকশনে গিয়ে **"Proxy Type"** সিলেক্ট করুন (Socks5/HTTP/HTTPS)।\n` +
        `৩. আপনার প্রক্সি প্রভাইডারের দেওয়া আইপি ও পোর্ট ইনপুট করুন। ফরম্যাট: \`IP:Port\` অথবা ইউজারনেম-পাসওয়ার্ড থাকলে \`IP:Port:Username:Password\`।\n` +
        `৪. **"Check Proxy"** বাটনে ক্লিক করে কানেকশন টেস্ট করুন। সবুজ সংকেত আসলে আপনার প্রক্সি সফলভাবে কাজ করছে।\n\n` +
        `⚠️ *পরামর্শ:* লিক এড়াতে সর্বদা প্রিমিয়াম ডেডিকেটেড আইপি ব্যবহার করবেন। ফ্রি প্রক্সি ব্যবহার করলে অ্যাকাউন্ট ব্যান হওয়ার ঝুঁকি থাকে।`;
    
    try {
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to FAQ', 'faq_menu')]])
        });
    } catch (e) {
        return ctx.reply(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to FAQ', 'faq_menu')]])
        });
    }
});

bot.action('faq_logincode', async (ctx) => {
    await ctx.answerCbQuery();
    const text = 
        `🔑 *How to Get Login Code* 🔑\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *অ্যাকাউন্টে লগইন করার জন্য কোড নেওয়ার নিয়ম:*\n\n` +
        `১. ব্রাউজারে কোড চাওয়ার পেজটি ওপেন রাখুন।\n` +
        `২. আমাদের টেলিগ্রাম বটের **"🛍 My Order"** এ যান এবং আপনার একটিভ অর্ডারের নিচে থাকা **"🔑 Get Login Code"** বাটনে ক্লিক করুন।\n` +
        `৩. সাথে সাথে অ্যাডমিনের কাছে আপনার কোড রিকোয়েস্ট চলে যাবে।\n` +
        `৪. অ্যাডমিন কোডটি দেওয়ার সাথে সাথে আপনার চ্যাটে ওয়ান-ক্লিক কপি বাটনসহ কোডটি চলে আসবে। কোডটি কপি করে ব্রাউজারে বসিয়ে লগইন সম্পূর্ণ করুন।`;
    
    try {
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to FAQ', 'faq_menu')]])
        });
    } catch (e) {
        return ctx.reply(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to FAQ', 'faq_menu')]])
        });
    }
});

bot.action('faq_replacement', async (ctx) => {
    await ctx.answerCbQuery();
    const text = 
        `🛡 *Warranty & Replacement Policy* 🛡\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *রিপ্লেসমেন্ট পেতে নিচের নিয়মগুলো মনোযোগ দিয়ে পড়ুন:*\n\n` +
        `• 🟢 *২৪ ঘণ্টার গ্যারান্টি:* অ্যাকাউন্ট ডেলিভারি নেওয়ার পর প্রথম ২৪ ঘণ্টার মধ্যে কোনো মেজর লগইন এরর বা টেকনিক্যাল সমস্যা হলে সম্পূর্ণ ফ্রিতে অ্যাকাউন্ট রিপ্লেস করে দেওয়া হবে।\n\n` +
        `• 🔴 *কখন রিপ্লেসমেন্ট পাবেন না:*\n` +
        `  ১. ফ্রি বা নিম্নমানের আইপি/প্রক্সি ব্যবহারের কারণে যদি অ্যাকাউন্ট রেস্ট্রিক্ট হয়।\n` +
        `  ২. ফেসবুক বা সোশ্যাল মিডিয়ার নিজস্ব সিকিউরিটি পলিসি ভঙ্গ করলে (যেমন: অতিরিক্ত স্প্যামিং করা)।\n\n` +
        `💬 যেকোনো জরুরি তথ্যের জন্য অ্যাডমিনের সাথে যোগাযোগ করুন: @prime8088`;
    
    try {
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to FAQ', 'faq_menu')]])
        });
    } catch (e) {
        return ctx.reply(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to FAQ', 'faq_menu')]])
        });
    }
});

// Payment Flows with Dynamic Prices & Coupons
bot.action('pay_bkash', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'bKash' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const bkashNum = await getWallet('bkash');
    const bkashEmojiTag = await getItemEmojiTag('BKASH', '🌸');
    
    return ctx.reply(
        `${bkashEmojiTag} *bKash Payment Details* ${bkashEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📞 *Send Money Number:* \`${bkashNum}\` (Personal)\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে *TrxID* দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✍️ TrxID দিন', 'input_trx')],
                [Markup.button.callback('⬅️ Back', 'buy_options')]
            ])
        }
    );
});

bot.action('pay_nagad', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'Nagad' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const nagadNum = await getWallet('nagad');
    const nagadEmojiTag = await getItemEmojiTag('NAGAD', '🍑');
    
    return ctx.reply(
        `${nagadEmojiTag} *Nagad Payment Details* ${nagadEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📞 *Send Money Number:* \`${nagadNum}\` (Personal)\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে *TrxID* দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✍️ TrxID দিন', 'input_trx')],
                [Markup.button.callback('⬅️ Back', 'buy_options')]
            ])
        }
    );
});

bot.action('pay_binance', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'Binance' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const binanceId = await getWallet('binance');
    const binanceEmojiTag = await getItemEmojiTag('BINANCE', '🟡');
    
    return ctx.reply(
        `${binanceEmojiTag} *Binance Payment Details* ${binanceEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Pay ID:* \`${binanceId}\`\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK* (or USDT equivalent)\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে স্ক্রিনশট বা TxID দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📤 স্ক্রিনশট বা TxID দিন', 'input_screenshot')],
                [Markup.button.callback('⬅️ Back', 'buy_options')]
            ])
        }
    );
});

bot.action('pay_payoneer', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'Payoneer' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const payoneerEmail = await getWallet('payoneer');
    const payoneerEmojiTag = await getItemEmojiTag('PAYONEER', '🔷');
    
    return ctx.reply(
        `${payoneerEmojiTag} *Payoneer Payment Details* ${payoneerEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📧 *Email:* \`${payoneerEmail}\`\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK* (or USD equivalent)\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে Details দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✍️ Details দিন', 'input_payoneer_details')],
                [Markup.button.callback('⬅️ Back', 'buy_options')]
            ])
        }
    );
});

bot.action('input_trx', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'trx' });
    return ctx.reply("আপনার পেমেন্টের TrxID কোডটি লিখে পাঠান:");
});

bot.action('input_screenshot', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'screenshot' });
    return ctx.reply("আপনার বাইন্যান্স পেমেন্টের স্ক্রিনশট বা TxID ছবি আকারে পাঠান:");
});

bot.action('input_payoneer_details', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'payoneer_details' });
    return ctx.reply("আপনার Payoneer Email এবং Customer ID লিখে পাঠান:");
});

async function checkLowStockAlert(ctx) {
    try {
        const allStock = await db.getAllStockAccounts();
        const availableCount = allStock.filter(i => i.available).length;
        if (availableCount <= 3) {
            const alertMsg = `⚠️ *LOW STOCK WARNING ALERT!* ⚠️\n` +
                             `━━━━━━━━━━━━━━━━━━\n` +
                             `স্টকে বর্তমানে মাত্র *${availableCount}* টি অব্যবহৃত AdsPower অ্যাকাউন্ট বাকি আছে!\n\n` +
                             `👉 কাস্টমারদের অর্ডারের নিরবচ্ছিন্ন সেবার জন্য অনুগ্রহ করে দ্রুত স্টক রিফিল করুন।`;
            await ctx.telegram.sendMessage(ADMIN_ID, alertMsg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('➕ Add Accounts to Stock', 'add_stock_prompt')]])
            });
        }
    } catch (e) {
        console.error("Low stock alert error:", e.message);
    }
}

async function showAdminManagementMenu(ctx) {
    if (!isAdmin(ctx)) {
        if (ctx.callbackQuery) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
        return;
    }

    const searchLabel = await getCustomText('LABEL_ADMIN_SEARCH', 'SEARCH ORDER / USER');
    const vipLabel = await getCustomText('LABEL_ADMIN_VIP', 'TOP VIP BUYERS');
    const backupLabel = await getCustomText('LABEL_ADMIN_BACKUP', 'FULL DB BACKUP (JSON)');
    const todayLabel = await getCustomText('LABEL_ADMIN_TODAY_STATUS', 'TODAY ALL STATUS');
    const userStatusLabel = await getCustomText('LABEL_ADMIN_USER_STATUS', 'USER STATUS CHECK');
    const updateJoinsLabel = await getCustomText('LABEL_ADMIN_UPDATE_JOINS', 'UPDATE JOINS');
    const liveServicesLabel = await getCustomText('LABEL_ADMIN_LIVE_SERVICES', 'LIVE SERVICES');
    const customizeLabel = await getCustomText('LABEL_ADMIN_CUSTOMIZE', 'CUSTOMIZE TEXTS & BUTTONS');
    const banLabel = await getCustomText('LABEL_ADMIN_BAN_USER', 'BAN USER');
    const unbanLabel = await getCustomText('LABEL_ADMIN_UNBAN_USER', 'UNBAN USER');
    const banListLabel = await getCustomText('LABEL_ADMIN_BAN_LIST', 'BAN USER LIST');
    const removeBalLabel = await getCustomText('LABEL_ADMIN_REMOVE_BALANCE', 'REMOVE BALANCE');
    const addBalLabel = await getCustomText('LABEL_ADMIN_ADD_BALANCE', 'ADD BALANCE');
    const pendingOrdersLabel = await getCustomText('LABEL_ADMIN_PENDING_ORDERS', 'PENDING ORDERS');
    const totalUsersLabel = await getCustomText('LABEL_ADMIN_TOTAL_USERS', 'TOTAL BOT USERS');
    const broadcastLabel = await getCustomText('LABEL_ADMIN_BROADCAST', 'BROADCAST');
    const couponsLabel = await getCustomText('LABEL_ADMIN_COUPONS', 'COUPONS');
    const salesReportLabel = await getCustomText('LABEL_ADMIN_SALES_REPORT', 'SALES REPORT');
    const botControlLabel = await getCustomText('LABEL_ADMIN_BOT_CONTROL', 'BOT CONTROL');
    const closeLabel = await getCustomText('LABEL_ADMIN_CLOSE', 'CLOSE ADMIN PANEL');

    const msgText = `🎛️ *Golden Admin Control Panel*\n\n` +
                    `শুধুমাত্র এডমিন আইডি দিয়ে অ্যাক্সেসযোগ্য। নিচের বাটনগুলো দিয়ে বটের অর্ডারিং, স্ট্যাটাস, ইউজার ব্যান/আনব্যান, ব্যালেন্স এবং কাস্টমাইজেশন নিয়ন্ত্রণ করুন:`;

    const inlineKeyboard = Markup.inlineKeyboard([
        [
            styledBtn(searchLabel, 'admin_search_prompt', 'primary'),
            styledBtn(vipLabel, 'admin_top_vip_buyers', 'primary')
        ],
        [
            styledBtn(backupLabel, 'admin_full_db_backup', 'primary')
        ],
        [
            styledBtn(todayLabel, 'admin_today_status', 'primary'),
            styledBtn(userStatusLabel, 'admin_user_status', 'primary')
        ],
        [
            styledBtn(updateJoinsLabel, 'admin_update_joins', 'primary'),
            styledBtn(liveServicesLabel, 'admin_live_services', 'primary')
        ],
        [
            styledBtn(customizeLabel, 'admin_customize_texts', 'primary')
        ],
        [
            styledBtn(banLabel, 'admin_ban_user', 'danger'),
            styledBtn(unbanLabel, 'admin_unban_user', 'success')
        ],
        [
            styledBtn(banListLabel, 'admin_ban_list', 'danger')
        ],
        [
            styledBtn(removeBalLabel, 'admin_remove_balance', 'danger'),
            styledBtn(addBalLabel, 'admin_add_balance', 'success')
        ],
        [
            styledBtn(pendingOrdersLabel, 'admin_pending_orders', 'success'),
            styledBtn(totalUsersLabel, 'admin_total_users', 'primary')
        ],
        [
            styledBtn(broadcastLabel, 'admin_broadcast_prompt', 'primary'),
            styledBtn(couponsLabel, 'admin_coupons_menu', 'primary')
        ],
        [
            styledBtn(salesReportLabel, 'admin_sales_report', 'primary'),
            styledBtn(botControlLabel, 'bot_control_back', 'primary')
        ],
        [
            styledBtn(closeLabel, 'admin_close', 'danger')
        ]
    ]);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(msgText, { parse_mode: 'Markdown', ...inlineKeyboard });
        } catch(e) {
            await ctx.reply(msgText, { parse_mode: 'Markdown', ...inlineKeyboard });
        }
    } else {
        await ctx.reply(msgText, { parse_mode: 'Markdown', ...inlineKeyboard });
    }
}

async function showBotControlPanel(ctx) {
    const isMaintenance = await getMaintenanceMode();
    const isNoticeEnabled = await getNoticeStatus();
    const noticeText = await getNoticeText();
    const isFakeSalesEnabled = await getFakeSalesStatus();
    const isForceJoinEnabled = await getForceJoinStatus();
    const isSellingHoursEnabled = await getSellingHoursStatus();
    const referRewardAmount = await getReferRewardAmount();
    const reactionCounts = await getReactionCounts();

    const isAllowCustomEmail = await db.getAllowCustomEmailStatus();

    const botStatusText = isMaintenance ? '🔴 **OFF (Maintenance Mode is ON)**' : '🟢 **ON (Normal Mode is ON)**';
    const noticeStatusText = isNoticeEnabled ? '🟢 **ENABLED (Active)**' : '🔴 **DISABLED (Inactive)**';
    const fakeSalesStatusText = isFakeSalesEnabled ? '🟢 **ENABLED (Sending Fake Sales)**' : '🔴 **DISABLED (Stopped)**';
    const forceJoinStatusText = isForceJoinEnabled ? '🟢 **ENABLED (Force Join is ON)**' : '🔴 **DISABLED (Everyone can access)**';
    const sellingHoursStatusText = isSellingHoursEnabled ? '🟢 **ENABLED (Selling limits: 11am-11pm)**' : '🔴 **DISABLED (24-Hour Selling is ON)**';
    const emailChoiceStatusText = isAllowCustomEmail ? '🟢 **ENABLED (User can choose Stock vs Own Email)**' : '🔴 **DISABLED (Stock Only Mode)**';

    const bkashNum = await getWallet('bkash');
    const nagadNum = await getWallet('nagad');
    const binanceId = await getWallet('binance');
    const payoneerEmail = await getWallet('payoneer');

    const panelMsg = `⚙️ *AdsPower Bot Golden Control Panel*\n\n` +
                     `• **Bot Status:** ${botStatusText}\n` +
                     `• **Highlight Notice:** ${noticeStatusText}\n` +
                     `• **Fake Sales Loop:** ${fakeSalesStatusText}\n` +
                     `• **Force Group Join:** ${forceJoinStatusText}\n` +
                     `• **Selling Time Limit:** ${sellingHoursStatusText}\n` +
                     `• **User Email Choice:** ${emailChoiceStatusText}\n` +
                     `• **Refer Reward Amount:** \`${referRewardAmount} TK\`\n` +
                     `• **Group Reactions:** ❤️ \`${reactionCounts.heart}\` | 👌 \`${reactionCounts.ok}\` | 🫡 \`${reactionCounts.salute}\` | ⭐ \`${reactionCounts.star}\`\n\n` +
                     `📢 **Notice Text:**\n` +
                     `> ${noticeText}\n\n` +
                     `💳 **Wallet Numbers / IDs:**\n` +
                     `• bKash: \`${bkashNum}\`\n` +
                     `• Nagad: \`${nagadNum}\`\n` +
                     `• Binance Pay ID: \`${binanceId}\`\n` +
                     `• Payoneer Email: \`${payoneerEmail}\`\n\n` +
                     `নিচের বাটনগুলো ক্লিক করে কন্ট্রোল করুন:`;

    const inlineKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🎛️ Advanced Admin Management Panel', 'open_admin_mgmt_menu')
        ],
        [
            Markup.button.callback(isMaintenance ? '🟢 Turn Bot ON' : '🔴 Turn Bot OFF (Maintenance)', 'maintenance_toggle'),
        ],
        [
            Markup.button.callback(isNoticeEnabled ? '🔕 Disable Notice' : '🔔 Enable Notice', 'notice_toggle'),
            Markup.button.callback('✍️ Edit Notice Text', 'notice_edit_prompt')
        ],
        [
            Markup.button.callback(isFakeSalesEnabled ? '🔕 Disable Fake Sales' : '🔔 Enable Fake Sales', 'fake_sales_toggle'),
            Markup.button.callback('💳 Update Wallets', 'wallets_menu')
        ],
        [
            Markup.button.callback(isForceJoinEnabled ? '🔕 Disable Force Join' : '🔔 Enable Force Join', 'force_join_toggle'),
            Markup.button.callback(isSellingHoursEnabled ? '🔕 Disable Time Limits (24h)' : '🔔 Enable Time Limits (11am-11pm)', 'selling_hours_toggle')
        ],
        [
            Markup.button.callback(isAllowCustomEmail ? '🟢 Email Choice: ON' : '🔴 Email Choice: OFF (Stock)', 'toggle_allow_custom_email'),
            Markup.button.callback('💰 Edit Refer Bonus', 'edit_refer_reward')
        ],
        [
            Markup.button.callback('📦 Manage Stock Pool', 'stock_menu'),
            Markup.button.callback('🎭 Reaction Counts', 'edit_reaction_counts_prompt')
        ],
        [
            Markup.button.callback('⚡ Trigger Fake Sale Now (Test)', 'trigger_fake_sale_now')
        ]
    ]);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(panelMsg, { parse_mode: 'Markdown', ...inlineKeyboard });
        } catch(e) {}
    } else {
        await ctx.reply(panelMsg, { parse_mode: 'Markdown', ...inlineKeyboard });
    }
}

bot.action('stock_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const allStock = await db.getAllStockAccounts();
    const availableCount = allStock.filter(i => i.available).length;
    const usedCount = allStock.filter(i => !i.available).length;

    const stockText = `📦 *AdsPower ID Stock Pool Manager* 📦\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `• **Available Stock (অব্যবহৃত):** *${availableCount}* টি\n` +
                      `• **Reserved / Delivered:** *${usedCount}* টি\n` +
                      `• **Total Stock Items:** *${allStock.length}* টি\n` +
                      `━━━━━━━━━━━━━━━━━━\n\n` +
                      `এডমিন স্টক পুলে একাধিক AdsPower আইডি/ইমেইল একসাথে জমা করে রাখতে পারেন। পেমেন্ট কনফার্মেশনের সময় এখান থেকে অটো আইডি রিজার্ভ হবে।`;

    return ctx.editMessageText(stockText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add Accounts to Stock', 'add_stock_prompt')],
            [Markup.button.callback('📋 View Available Stock', 'view_stock_accounts')],
            [Markup.button.callback('🗑 Clear Available Stock', 'clear_stock_prompt')],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

bot.action('add_stock_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_stock_bulk_add' });

    return ctx.reply(
        "📦 *AdsPower স্টক অ্যাকাউন্ট যুক্ত করুন:*\n\n" +
        "এক সাথে এক বা একাধিক AdsPower আইডি/ইমেইল চ্যাটে মেসেজ আকারে **অথবা একটি `.txt` ফাইল আপলোড করে** পাঠান (প্রতি লাইনে একটি করে):\n\n" +
        "**উদাহরণ:**\n" +
        "`email1@gmail.com:pass123`\n" +
        "`email2@gmail.com:pass456`",
        { parse_mode: 'Markdown' }
    );
});

bot.action('view_stock_accounts', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const allStock = await db.getAllStockAccounts();
    const available = allStock.filter(i => i.available);

    if (available.length === 0) {
        return ctx.reply("📦 *Stock Status:* বর্তমানে কোনো অব্যবহৃত স্টক খালি নেই।", { parse_mode: 'Markdown' });
    }

    const previewLimit = 25;
    const previewList = available.slice(0, previewLimit);

    let text = `📦 *Available Stock Accounts (Total: ${available.length} টি)* 📦\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               (available.length > previewLimit ? `*(প্রথম ${previewLimit} টি প্রদর্শন করা হলো, বাকিগুলো দেখতে নিচে .txt ডাউনলোড বাটন ব্যবহার করুন)*\n\n` : `\n`);

    previewList.forEach((item, index) => {
        text += `${index + 1}. \`${item.data}\`\n`;
    });

    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📥 Download Full Stock List (.txt)', 'download_stock_txt')],
            [Markup.button.callback('⬅️ Back to Stock Manager', 'stock_menu')]
        ])
    });
});

bot.action('download_stock_txt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Generating stock file...");

    const allStock = await db.getAllStockAccounts();
    const available = allStock.filter(i => i.available);

    if (available.length === 0) {
        return ctx.reply("❌ ডাউনলোডের জন্য কোনো অব্যবহৃত স্টক খালি নেই।");
    }

    let fileContent = available.map(i => i.data).join('\n');
    const buffer = Buffer.from(fileContent, 'utf-8');

    return await ctx.replyWithDocument(
        { source: buffer, filename: `available_stock_${available.length}_items.txt` },
        { caption: `📦 *AdsPower Available Stock Backup (${available.length} items)*`, parse_mode: 'Markdown' }
    );
});

bot.action('admin_search_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_search_query' });

    return ctx.reply(
        "🔍 *Search Order or User Profile:*\n\n" +
        "অনুগ্রহ করে কাস্টমারের **User ID**, **Username** (@username), অথবা **Order ID** লিখে পাঠান:",
        { parse_mode: 'Markdown' }
    );
});

bot.action('admin_top_vip_buyers', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const vipList = await db.getTopVIPBuyers();

    let text = `👑 *Top VIP Customers Leaderboard* 👑\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `সবচেয়ে বেশি টাকার কেনাকাটা করা সেরা ১০ জন ভিআইপি গ্রাহকদের তালিকা:\n\n`;

    if (vipList.length === 0) {
        text += `> ❌ বর্তমানে কোনো ডেলিভারড অর্ডারের রেকর্ড পাওয়া যায়নি।`;
    } else {
        vipList.forEach((item, index) => {
            let medal = "👤";
            if (index === 0) medal = "🥇";
            else if (index === 1) medal = "🥈";
            else if (index === 2) medal = "🥉";

            text += `${medal} *#${index + 1}* - ${item.name} (@${item.username})\n` +
                    `   ├─ User ID: \`${item.userId}\`\n` +
                    `   ├─ Total Orders: *${item.count}* টি\n` +
                    `   └─ Total Spent: *${item.totalSpent} TK*\n\n`;
        });
    }

    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Control Panel', 'open_admin_mgmt_menu')]])
    });
});

bot.action('admin_full_db_backup', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Generating full database backup...");

    const backupData = await db.getFullDatabaseBackupData();
    const jsonString = JSON.stringify(backupData, null, 2);
    const buffer = Buffer.from(jsonString, 'utf-8');

    const dateStr = new Date().toISOString().split('T')[0];

    return await ctx.replyWithDocument(
        { source: buffer, filename: `full_bot_backup_${dateStr}.json` },
        {
            caption: `💾 *AdsPower Seller BD Bot - Full System Backup*\n\n` +
                     `• Date: \`${dateStr}\`\n` +
                     `• Total Users: *${backupData.totalUsersCount || 0}*\n` +
                     `• Total Orders: *${backupData.totalOrdersCount || 0}*\n\n` +
                     `আপনার ডাটাবেজের সম্পূর্ণ ব্যাকআপ জেনারেট করে পাঠানো হয়েছে।`,
            parse_mode: 'Markdown'
        }
    );
});

bot.action('clear_stock_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const allStock = await db.getAllStockAccounts();
    const available = allStock.filter(i => i.available);

    for (const item of available) {
        await db.deleteStockAccount(item.code);
    }

    await ctx.reply("✅ সকল অব্যবহৃত স্টক অ্যাকাউন্ট সফলভাবে মুছে ফেলা হয়েছে!");
    return showBotControlPanel(ctx);
});

bot.action('edit_reaction_counts_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const counts = await getReactionCounts();
    await updateAdminSession(userId, { step: 'waiting_for_reaction_counts' });
    const msg = `🎭 *Set Custom Group Reaction Counts*\n\n` +
                `বর্তমান কনফিগারেশন:\n` +
                `• ❤️ Heart: \`${counts.heart}\`\n` +
                `• 👌 OK: \`${counts.ok}\`\n` +
                `• 🫡 Salute: \`${counts.salute}\`\n` +
                `• ⭐ Star Rating: \`${counts.star}\`\n\n` +
                `📝 কমা (,) দিয়ে নতুন সংখ্যাসমূহ লিখে পাঠান:\n` +
                `উদাহরণ: \`25, 14, 67, 4.9\`\n` +
                `(ক্রম অনুযায়ী: ❤️ Heart, 👌 OK, 🫡 Salute, ⭐ Rating)`;
    return ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.action('wallets_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    
    const walletsText = `💳 *Wallet Numbers Update Panel* 💳\n\n` +
                        `নিচের বাটনগুলো থেকে পেমেন্ট মেথড সিলেক্ট করে নতুন নাম্বার/আইডি দিন:`;
                        
    return ctx.editMessageText(walletsText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🇧🇩 Edit bKash', 'edit_wallet_bkash'), Markup.button.callback('🇧🇩 Edit Nagad', 'edit_wallet_nagad')],
            [Markup.button.callback('🌐 Edit Binance', 'edit_wallet_binance'), Markup.button.callback('🌐 Edit Payoneer', 'edit_wallet_payoneer')],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

bot.action('bot_control_back', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showBotControlPanel(ctx);
});

bot.action(/^edit_wallet_(bkash|nagad|binance|payoneer)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    
    const type = ctx.match[1];
    const adminId = ctx.from.id.toString();
    
    await updateAdminSession(adminId, { step: `waiting_for_wallet_${type}` });
    
    return ctx.reply(`✍️ অনুগ্রহ করে নতুন *${type.toUpperCase()}* নাম্বার বা আইডিটি লিখে পাঠান:`, { parse_mode: 'Markdown' });
});

bot.action('maintenance_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getMaintenanceMode();
    await setMaintenanceMode(!current);
    await ctx.answerCbQuery(`Bot status changed to ${!current ? 'OFF' : 'ON'}!`);
    return showBotControlPanel(ctx);
});

bot.action('notice_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getNoticeStatus();
    await setNoticeStatus(!current);
    await ctx.answerCbQuery(`Highlight notice changed to ${!current ? 'ENABLED' : 'DISABLED'}!`);
    return showBotControlPanel(ctx);
});

bot.action('notice_edit_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_notice_text' });
    return ctx.reply("📢 অনুগ্রহ করে নতুন নোটিশ/ঘোষণা মেসেজটি লিখে পাঠান (Markdown ফরম্যাট সাপোর্ট করবে):");
});

bot.action('fake_sales_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getFakeSalesStatus();
    await setFakeSalesStatus(!current);
    await ctx.answerCbQuery(`Fake sales posting changed to ${!current ? 'ENABLED' : 'DISABLED'}!`);
    return showBotControlPanel(ctx);
});

bot.action('trigger_fake_sale_now', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Posting fake sale to group now...");
    try {
        await sendFakeSaleToGroup(true);
        return ctx.reply(`✅ *গ্রুপে (ID: \`${GROUP_ID}\`) টেস্ট ফেইক সেলস সফলভাবে পাঠানো হয়েছে!*`, { parse_mode: 'Markdown' });
    } catch (err) {
        return ctx.reply(`❌ *গ্রুপে মেসেজ পাঠানো ব্যর্থ হয়েছে:*\n\`${err.message}\``, { parse_mode: 'Markdown' });
    }
});

bot.action('toggle_allow_custom_email', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await db.getAllowCustomEmailStatus();
    await db.setAllowCustomEmailStatus(!current);
    await ctx.answerCbQuery(`User email choice mode changed to ${!current ? 'ENABLED' : 'DISABLED'}!`);
    return showBotControlPanel(ctx);
});

// Text / Input Handler / Document Handler
bot.on(['text', 'photo', 'document'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message ? ctx.message.text : null;

    if (isAdmin(ctx)) {
        if (text) {
            if (text === '/admin') {
                return showAdminManagementMenu(ctx);
            }
            if (text.includes('Pending Orders')) {
                return showPendingOrdersMenu(ctx);
            } 
            if (text.includes('Total Bot Users')) {
                return showTotalUsersStats(ctx);
            }
            if (text.includes('Close Admin Panel')) {
                return ctx.reply("👑 Admin Panel Closed.", Markup.removeKeyboard());
            }
            if (text.includes('Broadcast')) {
                await updateAdminSession(userId, { step: 'waiting_for_broadcast' });
                return ctx.reply("📢 আপনার ব্রডকাস্ট মেসেজটি (লেখা বা ছবি) পাঠান যা সকল বটের ইউজারের কাছে পাঠানো হবে:");
            }
            if (text.includes('Sales Report')) {
                const stats = await getSalesReportStats();
                const reportText = 
                    `📊 *AdsPower Bot Sales Report* 📊\n\n` +
                    `• Total Completed Sales: *${stats.totalCount}*\n` +
                    `• Total Revenue: *${stats.totalRevenue} TK*\n\n` +
                    `• Today's Sales: *${stats.todayRevenue} TK*\n` +
                    `• This Month's Sales: *${stats.monthRevenue} TK*\n\n` +
                    `❤️ Keep hustling! Keep selling! 🚀`;
                return ctx.reply(reportText, { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📥 Download CSV Report', 'download_sales_csv')]
                    ])
                });
            }
            if (text.includes('Coupons')) {
                return showCouponsMenu(ctx);
            }
            if (text.includes('Bot Control')) {
                return showBotControlPanel(ctx);
            }
        }

        const adminSession = await getAdminSession(userId);
        if (adminSession && adminSession.step) {
            const state = adminSession.step;
            const targetUser = adminSession.targetUserId;
            const extraData = adminSession.extraData;

            if (state === 'waiting_for_reaction_counts' && text) {
                await clearAdminSession(userId);
                const parts = text.split(',').map(p => p.trim());
                if (parts.length >= 3) {
                    const heart = parseInt(parts[0]) || 25;
                    const ok = parseInt(parts[1]) || 14;
                    const salute = parseInt(parts[2]) || 67;
                    const star = parts[3] ? parts[3] : '4.9';

                    await setReactionCounts({ heart, ok, salute, star });
                    await ctx.reply(`✅ *গ্রুপ রিয়্যাকশন সংখ্যা সফলভাবে আপডেট করা হয়েছে!*\n\n` +
                                    `• ❤️ Heart: \`${heart}\`\n` +
                                    `• 👌 OK: \`${ok}\`\n` +
                                    `• 🫡 Salute: \`${salute}\`\n` +
                                    `• ⭐ Rating: \`${star}\``, { parse_mode: 'Markdown' });
                    return showBotControlPanel(ctx);
                } else {
                    return ctx.reply("❌ ভুল ফরম্যাট! উদাহরণ অনুযায়ী কমা (,) দিয়ে লিখুন: `25, 14, 67, 4.9`", { parse_mode: 'Markdown' });
                }
            }

            if (state === 'waiting_for_broadcast') {
                await clearAdminSession(userId);
                const userList = await getUserIdsForBroadcast();
                
                if (userList.length === 0) {
                    return ctx.reply("❌ ব্রডকাস্ট করার জন্য কোনো ইউজার পাওয়া যায়নি।");
                }

                await ctx.reply(`📢 ব্রডকাস্ট পাঠানো শুরু হয়েছে... মোট ইউজার: ${userList.length} জন।`);
                let success = 0;
                let fail = 0;

                for (const uId of userList) {
                    try {
                        await ctx.telegram.copyMessage(uId, ctx.chat.id, ctx.message.message_id);
                        success++;
                    } catch (err) {
                        fail++;
                    }
                }
                
                return ctx.reply(
                    `📢 *Broadcast Completed!* \n\n` +
                    `✅ সফলভাবে পাঠানো হয়েছে: *${success}* জনের কাছে\n` +
                    `❌ ব্যর্থ হয়েছে: *${fail}* জনের কাছে (বট ব্লক করার কারণে হতে পারে)`,
                    { parse_mode: 'Markdown' }
                );
            }

            if (state === 'waiting_for_search_query' && text) {
                await clearAdminSession(userId);
                const query = text.trim().replace('@', '');
                
                let foundUser = null;
                let userOrders = [];

                if (db.isConfigured()) {
                    const allUsers = (await db.getAllUsers()) || [];
                    foundUser = allUsers.find(u => u.user_id.toString() === query || (u.username && u.username.toLowerCase() === query.toLowerCase()));
                    const targetId = foundUser ? foundUser.user_id.toString() : query;
                    userOrders = (await db.getUserOrders(targetId)) || [];

                    if (!foundUser && userOrders.length === 0) {
                        const allOrders = (await db.getAllOrders()) || [];
                        const matchOrder = allOrders.find(o => String(o.id) === query);
                        if (matchOrder) {
                            userOrders = [matchOrder];
                            foundUser = allUsers.find(u => u.user_id.toString() === matchOrder.user_id.toString());
                        }
                    }
                }

                const targetId = foundUser ? foundUser.user_id.toString() : query;
                const isBanned = await db.isUserBanned(targetId);
                const balance = await db.getUserBalance(targetId);

                let resultMsg = `🔍 *Search Results for "${query}"*\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `👤 *Name:* ${foundUser ? foundUser.first_name : 'N/A'}\n` +
                                `🔗 *Username:* @${foundUser && foundUser.username ? foundUser.username : 'N/A'}\n` +
                                `🆔 *User ID:* \`${targetId}\`\n` +
                                ` Status: ${isBanned ? '⛔ **Banned**' : '🟢 **Active**'}\n` +
                                `💰 *Balance:* \`${balance} TK\`\n` +
                                `🛍 *Total Orders Found:* *${userOrders.length}*\n` +
                                `━━━━━━━━━━━━━━━━━━\n\n`;

                if (userOrders.length > 0) {
                    resultMsg += `📋 *Delivered Orders / Account Records:*\n`;
                    userOrders.slice(0, 10).forEach((ord, index) => {
                        resultMsg += `${index + 1}. Package: *${ord.package_name || ord.packageName}* | Status: *${ord.status}*\n`;
                        if (ord.custom_email || ord.customEmail) {
                            resultMsg += `   └─ 📧 Email: \`${ord.custom_email || ord.customEmail}\`\n`;
                        }
                        if (ord.custom_pass || ord.customPass) {
                            resultMsg += `   └─ 🔑 Pass: \`${ord.custom_pass || ord.customPass}\`\n`;
                        }
                    });
                } else {
                    resultMsg += `> ❌ কোনো পূর্বাভিজ্ঞ অর্ডারের তথ্য পাওয়া যায়নি।`;
                }

                return ctx.reply(resultMsg, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Control Panel', 'open_admin_mgmt_menu')]])
                });
            }

            if (state === 'waiting_for_stock_bulk_add') {
                let rawContent = text;
                if (ctx.message && ctx.message.document) {
                    try {
                        const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
                        const response = await fetch(fileLink.href);
                        rawContent = await response.text();
                    } catch (e) {
                        return ctx.reply(`❌ .txt ফাইল পড়তে সমস্যা হয়েছে: ${e.message}`);
                    }
                }

                if (rawContent && rawContent.trim()) {
                    await clearAdminSession(userId);
                    const lines = rawContent.trim().split(/\r?\n/);
                    let count = 0;
                    for (const line of lines) {
                        if (line.trim()) {
                            await db.addStockAccount(line.trim());
                            count++;
                        }
                    }
                    await ctx.reply(`✅ সফলভাবে *${count}* টি অ্যাকাউন্ট স্টকে যোগ করা হয়েছে!`, { parse_mode: 'Markdown' });
                    return showBotControlPanel(ctx);
                }
            }

            if (state === 'waiting_for_notice_text' && text) {
                await clearAdminSession(userId);
                await setNoticeText(text.trim());
                await ctx.reply("✅ নতুন নোটিশ মেসেজ সফলভাবে সংরক্ষণ করা হয়েছে!");
                return showBotControlPanel(ctx);
            }

            if (state === 'waiting_for_user_status_id' && text) {
                await clearAdminSession(userId);
                const query = text.trim();
                const allUsers = (await db.getAllUsers()) || [];
                const userObj = allUsers.find(u => u.user_id.toString() === query || (u.username && u.username.toLowerCase() === query.replace('@', '').toLowerCase()));
                const targetId = userObj ? userObj.user_id.toString() : query;
                
                const balance = await db.getUserBalance(targetId);
                const isBanned = await db.isUserBanned(targetId);
                const orders = (await db.getUserOrders(targetId)) || [];

                const userText = 
                    `👤 *User Status Details*\n\n` +
                    `• **User ID:** \`${targetId}\`\n` +
                    `• **First Name:** ${userObj ? userObj.first_name : 'N/A'}\n` +
                    `• **Username:** ${userObj && userObj.username ? '@' + userObj.username : 'N/A'}\n` +
                    `• **Account Status:** ${isBanned ? '⛔ **Banned**' : '🟢 **Active**'}\n` +
                    `• **Current Balance:** \`${balance} TK\`\n` +
                    `• **Total Orders Placed:** *${orders.length}*\n\n` +
                    `নিচের বাটন চেপে কুইক অ্যাকশন নিন:`;

                const keyboard = Markup.inlineKeyboard([
                    [
                        isBanned 
                            ? Markup.button.callback('🔓 Unban User', `unban_id_${targetId}`)
                            : Markup.button.callback('⛔ Ban User', `ban_id_${targetId}`)
                    ],
                    [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
                ]);

                return ctx.reply(userText, { parse_mode: 'Markdown', ...keyboard });
            }

            if (state.startsWith('waiting_for_card_') && text) {
                const raw = state.replace('waiting_for_card_', '');
                let field = '';
                let itemKey = '';

                if (raw.startsWith('label_')) {
                    field = 'label';
                    itemKey = raw.replace('label_', '');
                } else if (raw.startsWith('msg_')) {
                    field = 'msg';
                    itemKey = raw.replace('msg_', '');
                } else if (raw.startsWith('emojiid_')) {
                    field = 'emojiid';
                    itemKey = raw.replace('emojiid_', '');
                }

                await clearAdminSession(userId);

                const formattedText = parseMessageWithEntities(ctx.message);
                const extractedEmojiId = extractFirstCustomEmojiId(ctx.message);

                if (extractedEmojiId) {
                    await setCustomText(`EMOJIID_${itemKey}`, extractedEmojiId);
                }

                if (field === 'label') {
                    await setCustomText(`LABEL_${itemKey}`, formattedText.trim());
                    await ctx.reply(`✅ *Label for ${itemKey} Updated with Premium Emoji!*`, { parse_mode: 'Markdown' });
                } else if (field === 'msg') {
                    await setCustomText(`MSG_${itemKey}`, formattedText.trim());
                    if (['BKASH', 'NAGAD', 'BINANCE', 'PAYONEER'].includes(itemKey)) {
                        await setWallet(itemKey.toLowerCase(), text.trim());
                    }
                    await ctx.reply(`✅ *Message for ${itemKey} Updated with Premium Emoji!*`, { parse_mode: 'Markdown' });
                } else if (field === 'emojiid') {
                    const finalEmojiId = extractedEmojiId || text.trim();
                    await setCustomText(`EMOJIID_${itemKey}`, finalEmojiId);
                    await ctx.reply(`✨ *Premium Emoji ID (${finalEmojiId}) for ${itemKey} Updated!*`, { parse_mode: 'Markdown' });
                }

                return showCustomizeItemCard(ctx, itemKey);
            }

            if (state.startsWith('waiting_for_emoji_') && text) {
                const type = state.replace('waiting_for_emoji_', '');
                await clearAdminSession(userId);
                await setCustomText(`EMOJI_${type.toUpperCase()}`, text.trim());
                await ctx.reply(`✨ *${type.toUpperCase()} Button Emoji Updated to:* ${text.trim()}`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_new_join_link' && text) {
                await clearAdminSession(userId);
                const newLink = text.trim();
                await setWallet('join_link', newLink);
                await ctx.reply(`📡 *Force Join Link/Username Updated!*\n\nনতুন লিংক: \`${newLink}\``, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_welcome_msg' && text) {
                await clearAdminSession(userId);
                await setCustomText('WELCOME', text.trim());
                await ctx.reply("💎 *Welcome Message Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_buy_now_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('BUY_NOW', text.trim());
                await ctx.reply("🛒 *Buy Now Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_profile_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('PROFILE', text.trim());
                await ctx.reply("👤 *Profile Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_my_order_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('MY_ORDER', text.trim());
                await ctx.reply("🛍 *My Order Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_faq_text' && text) {
                await clearAdminSession(userId);
                await setCustomText('FAQ', text.trim());
                await ctx.reply("❓ *FAQ & Help Guide Text Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_leaderboard_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('LEADERBOARD', text.trim());
                await ctx.reply("🏆 *Leaderboard Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_support_username' && text) {
                await clearAdminSession(userId);
                const username = text.trim().startsWith('@') ? text.trim() : '@' + text.trim();
                await setCustomText('SUPPORT_USER', username);
                await ctx.reply(`📞 *Support Admin Username Updated to ${username}!*`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_ban_user_id' && text) {
                await clearAdminSession(userId);
                const targetId = text.trim();
                await db.banUser(targetId);
                await ctx.reply(`⛔ ইউজার ID \`${targetId}\` কে সফলভাবে **ব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_unban_user_id' && text) {
                await clearAdminSession(userId);
                const targetId = text.trim();
                await db.unbanUser(targetId);
                await ctx.reply(`🔓 ইউজার ID \`${targetId}\` কে সফলভাবে **আনব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_add_balance' && text) {
                await clearAdminSession(userId);
                const parts = text.trim().split(/\s+/);
                if (parts.length < 2) {
                    return ctx.reply("❌ ভুল ফরম্যাট! উদাহরণ: `8929349073 100` (User_ID টাকার_পরিমাণ)", { parse_mode: 'Markdown' });
                }
                const targetId = parts[0];
                const amount = parseInt(parts[1]);
                if (isNaN(amount) || amount <= 0) {
                    return ctx.reply("❌ টাকার পরিমাণ সঠিক সংখ্যা হতে হবে।");
                }
                const curr = await db.getUserBalance(targetId);
                const newBal = curr + amount;
                await db.setUserBalance(targetId, newBal);
                await ctx.reply(`➕ ইউজার \`${targetId}\` এর অ্যাকাউন্টে *${amount} TK* যোগ করা হয়েছে!\n\nবর্তমান ব্যালেন্স: *${newBal} TK*`, { parse_mode: 'Markdown' });
                try {
                    await ctx.telegram.sendMessage(targetId, `🎉 *Balance Updated!*\n\nএডমিন আপনার অ্যাকাউন্টে *${amount} TK* যোগ করেছেন।\nবর্তমান ব্যালেন্স: *${newBal} TK*`, { parse_mode: 'Markdown' });
                } catch(e) {}
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_remove_balance' && text) {
                await clearAdminSession(userId);
                const parts = text.trim().split(/\s+/);
                if (parts.length < 2) {
                    return ctx.reply("❌ ভুল ফরম্যাট! উদাহরণ: `8929349073 50` (User_ID টাকার_পরিমাণ)", { parse_mode: 'Markdown' });
                }
                const targetId = parts[0];
                const amount = parseInt(parts[1]);
                if (isNaN(amount) || amount <= 0) {
                    return ctx.reply("❌ টাকার পরিমাণ সঠিক সংখ্যা হতে হবে।");
                }
                const curr = await db.getUserBalance(targetId);
                const newBal = Math.max(0, curr - amount);
                await db.setUserBalance(targetId, newBal);
                await ctx.reply(`➖ ইউজার \`${targetId}\` এর অ্যাকাউন্ট থেকে *${amount} TK* কেটে নেওয়া হয়েছে!\n\nবর্তমান ব্যালেন্স: *${newBal} TK*`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_refer_reward' && text) {
                const amount = parseInt(text.trim());
                await clearAdminSession(userId);
                if (isNaN(amount) || amount < 0) {
                    return ctx.reply("❌ ভুল ইনপুট! বোনাস মূল্য অবশ্যই একটি পজিটিভ সংখ্যা হতে হবে।");
                }
                await setReferRewardAmount(amount);
                await ctx.reply(`✅ রেফারেল বোনাস সফলভাবে আপডেট করা হয়েছে! নতুন মূল্য: *${amount} TK*`, { parse_mode: 'Markdown' });
                return showBotControlPanel(ctx);
            }

            if (state.startsWith('waiting_for_wallet_') && text) {
                const type = state.replace('waiting_for_wallet_', '');
                await clearAdminSession(userId);
                await setWallet(type, text.trim());
                await ctx.reply(`✅ *${type.toUpperCase()}* ওয়ালেট সফলভাবে আপডেট করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showBotControlPanel(ctx);
            }

            if (state === 'waiting_for_coupon_code' && text) {
                const couponCode = text.trim().toUpperCase();
                await updateAdminSession(userId, {
                    step: 'waiting_for_coupon_discount',
                    extraData: couponCode
                });
                return ctx.reply(`🎟️ কুপন *${couponCode}* এর জন্য ডিসকাউন্ট মূল্য (টাকায়) লিখে পাঠান (যেমন: 10):`);
            }

            if (state === 'waiting_for_coupon_discount' && text) {
                const discount = parseInt(text.trim());
                const couponCode = extraData;

                if (isNaN(discount)) {
                    await clearAdminSession(userId);
                    return ctx.reply("❌ ভুল ইনপুট! ডিসকাউন্ট সংখ্যায় হতে হবে। কুপন তৈরি বাতিল করা হয়েছে।");
                }

                await updateAdminSession(userId, {
                    step: 'waiting_for_coupon_limit',
                    extraData: JSON.stringify({ code: couponCode, discount })
                });

                return ctx.reply("🎟️ এই কুপনটির জন্য ব্যবহারের সর্বোচ্চ সীমা (Limit) লিখে পাঠান (যেমন: 10 দিলে সর্বোচ্চ ১০ বার ব্যবহার করা যাবে; আনলিমিটেড করতে 0 লিখে পাঠান):");
            }

            if (state === 'waiting_for_coupon_limit' && text) {
                const limit = parseInt(text.trim());
                const data = JSON.parse(extraData);
                const couponCode = data.code;
                const discount = data.discount;
                await clearAdminSession(userId);

                if (isNaN(limit) || limit < 0) {
                    return ctx.reply("❌ ভুল ইনপুট! লিমিট অবশ্যই ০ বা পজিটিভ সংখ্যা হতে হবে। কুপন তৈরি বাতিল করা হয়েছে।");
                }

                const finalCouponCode = limit > 0 ? `LIMIT|${couponCode}|${limit}|0` : couponCode;

                if (db.isConfigured()) {
                    await db.createCoupon(finalCouponCode, discount);
                } else {
                    memoryCoupons[finalCouponCode] = discount;
                }

                await ctx.reply(`✅ কুপন কোড সফলভাবে যুক্ত হয়েছে!\n• Code: *${couponCode}*\n• Discount: *${discount} TK*\n• Limit: *${limit > 0 ? limit + ' uses' : 'Unlimited'}*\n\n📢 কাস্টমারদের কাছে কুপনটির নোটিফিকেশন ব্রডকাস্ট করা হচ্ছে...`, { parse_mode: 'Markdown' });

                // Auto Coupon Announcement Broadcast
                const userList = await getUserIdsForBroadcast();
                const announceMsg = `🎟️ *NEW DISCOUNT COUPON RELEASED!* 🎟️\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `নতুন প্রোমো কোড ব্যবহার করে আকর্ষণীয় ডিসকাউন্ট পান!\n\n` +
                                    `• Coupon Code: *${couponCode}*\n` +
                                    `• Discount Amount: *${discount} TK*\n` +
                                    (limit > 0 ? `• Limit: *First ${limit} customers only!* ⏳\n\n` : `\n`) +
                                    `🛒 এখনই কেনাকাটা করতে /start এ যান! 🚀`;

                let successCount = 0;
                for (const uId of userList) {
                    try {
                        await ctx.telegram.sendMessage(uId, announceMsg, { parse_mode: 'Markdown' });
                        successCount++;
                    } catch (err) {}
                }

                return ctx.reply(`📢 *Coupon Broadcast Completed!* \n\n✅ সফলভাবে পাঠানো হয়েছে: *${successCount}* জনের কাছে।`, { parse_mode: 'Markdown' });
            }

            if (state === 'waiting_for_reject_reason' && text) {
                const reason = text.trim();
                await clearAdminSession(userId);

                // Update order to Rejected in DB / memory
                await rejectOrderDB(targetUser);

                try {
                    await ctx.telegram.sendMessage(
                        targetUser,
                        `❌ *আপনার অর্ডারটি রিজেক্ট করা হয়েছে!*\n\n` +
                        `আপনার AdsPower অর্ডারের পেমেন্টটি অ্যাডমিন ভেরিফাই করতে পারেননি।\n\n` +
                        `• *কারণ:* ${reason}\n\n` +
                        `দয়া করে সঠিক ট্রানজেকশন প্রুফ দিয়ে আবার অর্ডার করুন অথবা অ্যাডমিনের সাথে যোগাযোগ করুন।`,
                        { parse_mode: 'Markdown' }
                    );
                    return ctx.reply(`✅ Successfully Rejected Order & Sent Reason to User!`);
                } catch (err) {
                    return ctx.reply(`❌ ইউজারকে রিজেক্ট মেসেজ পাঠানো যায়নি।`);
                }
            }

            if (state === 'waiting_for_support_reply' && text) {
                await clearAdminSession(userId);

                try {
                    await ctx.telegram.sendMessage(
                        targetUser,
                        `💬 *Support Team Reply* 💬\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `> ${text}\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `যেকোনো প্রয়োজনে আবার মেসেজ পাঠাতে পারেন। ধন্যবাদ!`,
                        { parse_mode: 'Markdown' }
                    );
                    return ctx.reply(`✅ উত্তরটি সফলভাবে ইউজারের কাছে পাঠানো হয়েছে!`);
                } catch (err) {
                    return ctx.reply(`❌ ইউজারকে উত্তর পাঠানো যায়নি (ইউজার হয়তো বটটি ব্লক করেছেন)।`);
                }
            }

            if (state === 'waiting_for_accounts' && text) {
                const lines = text.trim().split('\n');
                const parsedAccounts = [];

                lines.forEach(line => {
                    if (line.includes(':')) {
                        const parts = line.split(':');
                        if (parts.length >= 2) {
                            parsedAccounts.push({
                                email: parts[0].trim(),
                                pass: parts[1].trim()
                            });
                        }
                    }
                });

                if (parsedAccounts.length === 0) {
                    return ctx.reply("❌ ভুল ফরম্যাট! অনুগ্রহ করে প্রতি লাইনে `email:password` ফরম্যাটে লিখে পাঠান:");
                }

                await clearAdminSession(userId);

                // For 1 account, store raw fields as normal. For multiple, store list in custom_email.
                const rawCustomEmail = text.trim();
                const customPassValue = parsedAccounts.length === 1 ? parsedAccounts[0].pass : 'Multi-Account';
                const customEmailValue = parsedAccounts.length === 1 ? parsedAccounts[0].email : rawCustomEmail;

                if (db.isConfigured()) {
                    const orderObj = await db.getOrderForUser(targetUser);
                    await db.updateOrderStatus(targetUser, 'Completed', customEmailValue, customPassValue);
                    
                    if (orderObj && orderObj.method) {
                        const parts = orderObj.method.split('|');
                        const appliedCoupon = parts[3];
                        if (appliedCoupon) {
                            const allCoupons = await db.getAllCoupons();
                            if (allCoupons) {
                                const match = allCoupons.find(cp => cp.code.startsWith(`LIMIT|${appliedCoupon.toUpperCase()}|`));
                                if (match) {
                                    const limitParts = match.code.split('|');
                                    const code = limitParts[1];
                                    const maxUses = parseInt(limitParts[2]);
                                    const newUses = parseInt(limitParts[3]) + 1;
                                    
                                    await db.deleteCoupon(match.code);
                                    
                                    if (newUses < maxUses) {
                                        await db.createCoupon(`LIMIT|${code}|${maxUses}|${newUses}`, match.discount_amount);
                                    }
                                }
                            }
                        }
                    }
                } else {
                    const sessionObj = await getUserSession(targetUser);
                    if (sessionObj && sessionObj.appliedCoupon) {
                        const matchKey = Object.keys(memoryCoupons).find(k => k.startsWith(`LIMIT|${sessionObj.appliedCoupon.toUpperCase()}|`));
                        if (matchKey) {
                            const limitParts = matchKey.split('|');
                            const code = limitParts[1];
                            const maxUses = parseInt(limitParts[2]);
                            const newUses = parseInt(limitParts[3]) + 1;
                            
                            const discVal = memoryCoupons[matchKey];
                            delete memoryCoupons[matchKey];
                            
                            if (newUses < maxUses) {
                                memoryCoupons[`LIMIT|${code}|${maxUses}|${newUses}`] = discVal;
                            }
                        }
                    }
                }
                
                // Check if this user was referred and reward the referrer
                await checkAndRewardReferral(targetUser, ctx);
                if (memoryPendingOrders[targetUser]) {
                    memoryPendingOrders[targetUser].status = 'Completed';
                    delete memoryPendingOrders[targetUser];
                }

                if (!memoryUserOrderHistory[targetUser]) memoryUserOrderHistory[targetUser] = [];
                memoryUserOrderHistory[targetUser].push({
                    packageName: 'AdsPower Accounts',
                    method: 'Manual Delivery',
                    status: 'Completed',
                    createdAt: new Date().toISOString()
                });

                // Post Real Completed Order to Group in Premium Format
                try {
                    let orderId = Math.floor(10000 + Math.random() * 90000);
                    let buyerName = 'User';
                    let pricePaid = 30;
                    let pName = '1 Account AdsPower';
                    let pMethod = 'bKash';

                    if (db.isConfigured()) {
                        const orderObj = await db.getOrderForUser(targetUser);
                        if (orderObj) {
                            orderId = orderObj.id || orderId;
                            buyerName = orderObj.name || buyerName;
                            pricePaid = orderObj.price_paid || orderObj.pricePaid || pricePaid;
                            pName = orderObj.package_name || pName;
                            pMethod = orderObj.method || pMethod;
                        }
                    } else if (memoryPendingOrders[targetUser]) {
                        const orderObj = memoryPendingOrders[targetUser];
                        buyerName = orderObj.name || buyerName;
                        pricePaid = orderObj.pricePaid || pricePaid;
                        pName = orderObj.packageName || pName;
                        pMethod = orderObj.method || pMethod;
                    }

                    // Format masked email with fixed @emalupe.com domain
                    const firstLetter = buyerName.substring(0, 2).toLowerCase();
                    const maskedEmail = `${firstLetter}***@emalupe.com`;

                    const accountsCount = pName.match(/\d+/) ? pName.match(/\d+/)[0] : '1';
                    const pkgDisplay = `ADSPOWER × ${accountsCount}`;

                    const realSaleMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                                         `╔════════════════════╗\n` +
                                         `**🛒 ADSPOWER ACCOUNT**\n` +
                                         `╚════════════════════╝\n\n` +
                                         `╭──────────────────╮\n` +
                                         `│ 🆔 ORDER \`#${orderId}\`\n` +
                                         `│ 📦 \`${pkgDisplay}\`\n` +
                                         `│ 💰 \`${pricePaid} TK\`\n` +
                                         `│ 💳 \`${pMethod.toUpperCase()}\`\n` +
                                         `╰──────────────────╯\n\n` +
                                         `╭──────────────────╮\n` +
                                         `│ 🔐 **CUSTOMER DATA**\n` +
                                         `╰──────────────────╯\n\n` +
                                         `> 👤 \`${buyerName}\`\n` +
                                         `> 📧 \`${maskedEmail}\`\n` +
                                         `> 🔑 \`••••••••\`\n\n` +
                                         `📡 STATUS → 🟢 **DELIVERED**\n\n` +
                                         `> 🚀 **ADSPOWER SELLER BD**`;

                    await ctx.telegram.sendMessage(parseInt(GROUP_ID), realSaleMsg, { parse_mode: 'Markdown' });
                } catch (err) {
                    console.error("Failed to post real completed order to group:", err.message);
                }

                try {
                    // Build custom buttons dynamically
                    const buttons = [];
                    parsedAccounts.forEach((acc, idx) => {
                        buttons.push([Markup.button.callback(`📧 Email #${idx + 1}: ${acc.email}`, `copy_email_${acc.email}`)]);
                        buttons.push([Markup.button.callback(`🔑 Pass #${idx + 1}: ${acc.pass}`, `copy_pass_${acc.pass}`)]);
                    });

                    buttons.push([Markup.button.callback('🔑 Get Login Code', `get_code_${targetUser}`)]);
                    buttons.push([Markup.button.callback('📦 AdsPower Details', 'details')]);

                    await ctx.telegram.sendMessage(
                        targetUser,
                        `🎉 *Congratulations on Your Purchase!* 💎\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `> *আপনার পেমেন্ট সফলভাবে ভেরিফাই ও কনফার্ম করা হয়েছে!*\n\n` +
                        `👇 নিচের বাটনগুলোতে ক্লিক করে আপনার ইমেইল ও পাসওয়ার্ড এক ক্লিকে কপি করে নিন:`,
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard(buttons)
                        }
                    );
                    return ctx.reply(`✅ Successfully Sent ${parsedAccounts.length} Custom Account(s) & Password(s) to User!`);
                } catch (err) {
                    return ctx.reply(`❌ ইউজারকে মেসেজ পাঠানো যায়নি।`);
                }
            }

            if (state === 'waiting_for_login_code' && text) {
                const loginCode = text.trim();
                await clearAdminSession(userId);

                if (db.isConfigured()) {
                    await db.updateOrderLoginCode(targetUser, loginCode);
                }

                try {
                    await ctx.telegram.sendMessage(
                        targetUser,
                        "🚨 *আপনার Login Code নিচে দেওয়া হলো:*\n\nবাটনে ক্লিক করে কোডটি চ্যাটে নিয়ে কপি করে নিন। লগইন সম্পন্ন হলে নিচের **Done** বাটনে ক্লিক করুন:",
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback(`⏳ Code: ${loginCode}`, `copy_code_${loginCode}`)],
                                [Markup.button.callback('✅ Done ❤️', 'login_done')]
                            ])
                        }
                    );
                    return ctx.reply(`✅ ইউজারের কাছে লগইন কোড সফলভাবে পাঠানো হয়েছে!`);
                } catch (err) {
                    return ctx.reply(`❌ ইউজারকে লগইন কোড পাঠানো যায়নি।`);
                }
            }
        }
    }

    const session = await getUserSession(userId);
    if (!session) return;

    if (session.waitingFor === 'user_custom_email_input' && text) {
        const customEmail = text.trim();
        await updateUserSession(userId, { customEmail: customEmail, waitingFor: null });
        await ctx.reply(`✅ ইমেইল সংরক্ষণ করা হয়েছে: \`${customEmail}\``, { parse_mode: 'Markdown' });
        return showPaymentSelectionScreen(ctx, userId);
    }

    if (session.waitingFor === 'coupon_code' && text) {
        const inputCode = text.trim().toUpperCase();
        await updateUserSession(userId, { waitingFor: null });

        if (inputCode === 'SYSTEM_MAINTENANCE_MODE' || inputCode === 'SYSTEM_NOTICE_ENABLED' || inputCode.startsWith('NOTICE_TEXT|')) {
            await ctx.reply(`❌ দুঃখিত! এই কুপন কোডটি সঠিক নয় বা এর মেয়াদ শেষ হয়ে গেছে।`);
            return showPaymentSelectionScreen(ctx, userId);
        }

        let coupon = null;
        if (db.isConfigured()) {
            const allCoupons = await db.getAllCoupons();
            if (allCoupons) {
                coupon = allCoupons.find(cp => cp.code === inputCode);
                if (!coupon) {
                    const match = allCoupons.find(cp => cp.code.startsWith(`LIMIT|${inputCode}|`));
                    if (match) {
                        const parts = match.code.split('|');
                        const maxUses = parseInt(parts[2]);
                        const currentUses = parseInt(parts[3]);
                        if (currentUses >= maxUses) {
                            await ctx.reply(`❌ কুপন কোডটির ব্যবহারের সর্বোচ্চ সীমা পার হয়ে গেছে!`);
                            return showPaymentSelectionScreen(ctx, userId);
                        }
                        coupon = { code: inputCode, discount_amount: match.discount_amount };
                    }
                }
            }
        } else {
            if (memoryCoupons[inputCode] !== undefined) {
                coupon = { code: inputCode, discount_amount: memoryCoupons[inputCode] };
            } else {
                const matchKey = Object.keys(memoryCoupons).find(k => k.startsWith(`LIMIT|${inputCode}|`));
                if (matchKey) {
                    const parts = matchKey.split('|');
                    const maxUses = parseInt(parts[2]);
                    const currentUses = parseInt(parts[3]);
                    if (currentUses >= maxUses) {
                        await ctx.reply(`❌ কুপন কোডটির ব্যবহারের সর্বোচ্চ সীমা পার হয়ে গেছে!`);
                        return showPaymentSelectionScreen(ctx, userId);
                    }
                    coupon = { code: inputCode, discount_amount: memoryCoupons[matchKey] };
                }
            }
        }

        if (coupon) {
            await updateUserSession(userId, {
                appliedCoupon: coupon.code,
                discount: coupon.discount_amount
            });
            await ctx.reply(`✅ কুপন সফলভাবে যুক্ত হয়েছে! আপনি *${coupon.discount_amount} TK* ডিসকাউন্ট পেয়েছেন।`, { parse_mode: 'Markdown' });
        } else {
            await ctx.reply(`❌ দুঃখিত! এই কুপন কোডটি সঠিক নয় বা এর মেয়াদ শেষ হয়ে গেছে।`);
        }
        return showPaymentSelectionScreen(ctx, userId);
    }

    if (session.waitingFor === 'support_message' && text) {
        await updateUserSession(userId, { waitingFor: null });

        try {
            await ctx.telegram.sendMessage(
                ADMIN_ID,
                `💬 *New Support Request!* 👤\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `• *From:* ${ctx.from.first_name || 'User'} (@${ctx.from.username || 'N/A'})\n` +
                `• *User ID:* \`${userId}\`\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `📝 *Message:* \n${text}`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✍️ Reply to User', `reply_support_${userId}`)]
                    ])
                }
            );
        } catch (e) {
            console.error("Failed to forward support message to admin:", e.message);
        }

        return ctx.reply("✅ আপনার বার্তাটি অ্যাডমিনের কাছে পাঠানো হয়েছে। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন, অ্যাডমিন উত্তর দিলে আপনি এখানে নোটিফিকেশন পাবেন।");
    }

    if (session.waitingFor === 'feedback_text' && text) {
        const rating = session.tempRating || '5';
        await updateUserSession(userId, { waitingFor: null, tempRating: null });

        const reviewText = text.trim() === '/skip' ? 'No comment' : text.trim();

        const ratingStars = '⭐'.repeat(parseInt(rating));
        const ratingNum = parseFloat(rating).toFixed(1);
        const buyerName = ctx.from.first_name || 'User';
        const usernameStr = ctx.from.username ? ` (@${ctx.from.username})` : '';

        // Escape variables for MarkdownV2 safety
        const buyerNameEscaped = escapeMarkdownV2(buyerName, false);
        const usernameStrEscaped = escapeMarkdownV2(usernameStr, false);
        const userIdEscaped = escapeMarkdownV2(userId, true);
        const ratingNumEscaped = escapeMarkdownV2(ratingNum, true);
        const reviewTextEscaped = escapeMarkdownV2(reviewText, false);

        const feedbackMsg = `> ⭐️ *CUSTOMER FEEDBACK RECEIVED*\n` +
                            `╔════════════════════╗\n` +
                            `  *🗣️ SHOP REVIEW*\n` +
                            `╚════════════════════╝\n` +
                            `╭──────────────────╮\n` +
                            `│ 👤 *Customer:* ${buyerNameEscaped}${usernameStrEscaped}\n` +
                            `│ 🆔 *User ID:* \`${userIdEscaped}\`\n` +
                            `│ 📊 *Rating:* ${ratingStars} \`${ratingNumEscaped}\`\n` +
                            `╰──────────────────╯\n\n` +
                            `*💬 FEEDBACK RECEIVED*\n\n` +
                            `> ${reviewTextEscaped}\n\n` +
                            `> 🚀 *ADSPOWER SELLER BD*`;

        try {
            await ctx.telegram.sendMessage(ADMIN_ID, feedbackMsg, { parse_mode: 'Markdown' });
            const groupFeedbackSent = await ctx.telegram.sendMessage(parseInt(GROUP_ID), feedbackMsg, {
                parse_mode: 'Markdown'
            });
            if (groupFeedbackSent && groupFeedbackSent.message_id) {
                await addAutoReactions(ctx.telegram, GROUP_ID, groupFeedbackSent.message_id);
            }
        } catch (e) {
            console.error("Failed to forward review feedback to admin/group:", e.message);
        }

        const botUsername = ctx.botInfo ? `@${ctx.botInfo.username}` : '';
        return ctx.reply(
            `❤️ আপনার মূল্যবান মতামত আমাদের সাথে শেয়ার করার জন্য ধন্যবাদ! ভালো থাকবেন। 🚀\n\n${botUsername}`,
            { parse_mode: 'Markdown' }
        );
    }

    const state = session.waitingFor;
    if (state === 'trx' || state === 'screenshot' || state === 'payoneer_details') {
        let proof = text;
        if (ctx.message && ctx.message.photo && ctx.message.photo.length > 0) {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            proof = "photo:" + photo.file_id;
        }
        if (!proof) {
            proof = "Details Provided";
        }
        await updateUserSession(userId, { proof, waitingFor: null });

        try { await ctx.deleteMessage(); } catch(e) {}

        return ctx.reply("✅ আপনার পেমেন্ট ইনফো গ্রহণ করা হয়েছে। নিচে কনফার্ম বাটনে ক্লিক করুন:", {
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Confirm Payment', 'final_confirm')]
            ])
        });
    }
});

bot.action(/^copy_email_(.+)$/, async (ctx) => {
    const email = ctx.match[1];
    await ctx.answerCbQuery("Email sent below to copy!");
    return ctx.reply(`📧 আপনার ইমেইল (কপি করতে চেপে ধরে রাখুন):\n\`${email}\``, { parse_mode: 'Markdown' });
});

bot.action(/^copy_pass_(.+)$/, async (ctx) => {
    const password = ctx.match[1];
    await ctx.answerCbQuery("Password sent below to copy!");
    return ctx.reply(`🔑 আপনার পাসওয়ার্ড (কপি করতে চেপে ধরে রাখুন):\n\`${password}\``, { parse_mode: 'Markdown' });
});

bot.action(/^copy_code_(.+)$/, async (ctx) => {
    const code = ctx.match[1];
    await ctx.answerCbQuery("Login Code sent below to copy!");
    return ctx.reply(`⏳ আপনার লগইন কোড (কপি করতে চেপে ধরে রাখুন):\n\`${code}\``, { parse_mode: 'Markdown' });
});

async function checkIfTrxIDExists(proof) {
    if (db.isConfigured()) {
        const exists = await db.checkIfProofExists(proof);
        return exists === true;
    }
    let found = false;
    Object.keys(memoryUserOrderHistory).forEach(uid => {
        memoryUserOrderHistory[uid].forEach(ord => {
            if (ord.proof === proof) {
                found = true;
            }
        });
    });
    return found;
}

bot.action('final_confirm', async (ctx) => {
    const user = ctx.from;
    const userId = user.id.toString();
    const session = await getUserSession(userId);
    const proof = session ? session.proof || 'N/A' : 'N/A';

    // Duplicate TrxID Check
    const isPhotoProof = proof.startsWith("photo:");
    if (!isPhotoProof && proof !== 'N/A' && proof !== 'Details Provided') {
        const isDuplicate = await checkIfTrxIDExists(proof);
        if (isDuplicate) {
            await ctx.answerCbQuery();
            return ctx.reply("❌ *দুঃখিত! এই TrxID-টি ইতিমধ্যে অন্য একটি অর্ডারে ব্যবহার করা হয়েছে।*\n\nঅনুগ্রহ করে সঠিক পেমেন্ট প্রুফ বা TrxID দিয়ে আবার ট্রাই করুন। কোনো সমস্যা হলে সাপোর্টে যোগাযোগ করুন।", { parse_mode: 'Markdown' });
        }
    }

    await ctx.answerCbQuery("Payment Submitted!");
    const method = session ? session.method || 'Unknown' : 'Unknown';
    const packageName = session ? session.packageName || '1 Account AdsPower' : '1 Account AdsPower';
    const price = session ? session.price || 30 : 30;
    const discount = session ? session.discount || 0 : 0;
    const finalPrice = Math.max(0, price - discount);

    if (db.isConfigured()) {
        await db.createOrder({
            userId,
            name: user.first_name || 'User',
            username: user.username || 'N/A',
            packageName: packageName,
            method,
            proof,
            pricePaid: finalPrice
        });
    }

    memoryPendingOrders[userId] = {
        name: user.first_name || 'User',
        username: user.username || 'N/A',
        userId: userId,
        method,
        proof,
        status: 'Pending Verification',
        packageName: packageName,
        pricePaid: finalPrice
    };

    if (!memoryUserOrderHistory[userId]) memoryUserOrderHistory[userId] = [];
    memoryUserOrderHistory[userId].push({
        packageName: packageName,
        method,
        status: 'Pending Verification',
        date: new Date().toLocaleString()
    });

    let proofText = `🚨 *NEW ORDER RECEIVED* 🚨\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📦 *Package:* \`${packageName}\`\n` +
                    `💳 *Payment Method:* \`${method}\`\n` +
                    `💰 *Price Paid:* *${finalPrice} TK*\n` +
                    (session.appliedCoupon ? `🎟️ *Coupon:* \`${session.appliedCoupon}\` (-${discount} TK)\n` : '') +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `👤 *Customer:* ${user.first_name || 'User'}\n` +
                    `🔗 *Username:* @${user.username || 'N/A'}\n` +
                    `🆔 *User ID:* \`${userId}\`\n` +
                    `📌 *Proof (TrxID/Details):* \`${proof}\``;

    const photoFileId = isPhotoProof ? proof.substring(6) : null;
    const displayProofText = isPhotoProof 
        ? proofText.replace(`\`${proof}\``, `\`[Screenshot Attached]\``)
        : proofText;

    const sendNotification = async (chatId) => {
        try {
            if (isPhotoProof) {
                await ctx.telegram.sendPhoto(chatId, photoFileId, { caption: displayProofText, parse_mode: 'Markdown' });
            } else {
                await ctx.telegram.sendMessage(chatId, displayProofText, { parse_mode: 'Markdown' });
            }
        } catch (err) {
            console.error(`Failed to send order notification to ${chatId}:`, err.message);
            try {
                await ctx.telegram.sendMessage(chatId, proofText, { parse_mode: 'Markdown' });
            } catch (fallbackErr) {
                console.error(`Fallback failed to send order notification to ${chatId}:`, fallbackErr.message);
            }
        }
    };

    await sendNotification(ADMIN_ID);
    await sendNotification(GROUP_ID);

    // Reset user session applied coupon and discount after placing order
    await updateUserSession(userId, { appliedCoupon: '', discount: 0 });

    return ctx.reply(
        `✅ *Payment Request Submitted!* ⏳\n\n` +
        `> আপনার পেমেন্ট ইনফরমেশন সফলভাবে জমা হয়েছে। অ্যাডমিন পেমেন্টটি ভেরিফাই করছেন।\n\n` +
        `🕒 **অনুগ্রহ করে ৫ মিনিট অপেক্ষা করুন।** অর্ডার সম্পূর্ণ হলে আপনাকে চ্যাটে জানানো হবে।\n\n` +
        `❌ যদি ৫ মিনিটের বেশি দেরি হয়, তবে অনুগ্রহ করে **Contact Support** অপশন ব্যবহার করে অ্যাডমিনের সাথে যোগাযোগ করুন। ❤️`,
        { parse_mode: 'Markdown' }
    );
});

// ================= ADMIN MENUS =================

async function showPendingOrdersMenu(ctx) {
    const orders = await getPendingOrders();

    if (!orders || orders.length === 0) {
        return ctx.reply("⭐ *Pending Orders:* বর্তমানে কোনো পেন্ডিং অর্ডার নেই।", { parse_mode: 'Markdown' });
    }

    let buttons = [];
    orders.forEach((ord) => {
        const name = ord.name || 'User';
        const method = ord.method || 'N/A';
        const id = ord.userId;
        buttons.push([Markup.button.callback(`📦 ${name} [ ${method} ]`, `view_order_${id}`)]);
    });

    return ctx.reply("⭐ *Select an Order to Check Details:*", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
}

bot.action(/^view_order_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    
    const targetUserId = ctx.match[1];
    const ord = await getOrderForUser(targetUserId);

    if (!ord) return ctx.reply("❌ অর্ডারটি পাওয়া যায়নি বা ইতিমধ্যে প্রসেস হয়ে গেছে।");

    const isPhotoProof = ord.proof && ord.proof.startsWith("photo:");
    const photoFileId = isPhotoProof ? ord.proof.substring(6) : null;

    // Fetch available stock items
    const allStock = await db.getAllStockAccounts();
    const availableStock = allStock.filter(i => i.available);

    let detailsMsg = `📋 *Order Details*\n\n` +
                     `👤 *Name:* ${ord.name}\n` +
                     `🔗 *Username:* @${ord.username}\n` +
                     `🆔 *User ID:* \`${ord.userId}\`\n` +
                     `💳 *Method:* ${ord.method}\n` +
                     `📦 *Package:* ${ord.packageName}\n` +
                     `📌 *Proof:* ${isPhotoProof ? '`[Screenshot Attached]`' : `\`${ord.proof}\``}\n\n` +
                     `📦 *Available Stock in Pool:* *${availableStock.length}* টি`;

    const inlineMarkup = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 Reserve Stock Account (${availableStock.length} Available)`, `reserve_stock_${targetUserId}`)],
        [Markup.button.callback('✍️ Manual Input Email/Pass', `start_custom_pass_${targetUserId}`)],
        [Markup.button.callback('❌ Reject Order', `start_reject_order_${targetUserId}`)]
    ]);

    try {
        if (isPhotoProof) {
            return await ctx.replyWithPhoto(photoFileId, {
                caption: detailsMsg,
                parse_mode: 'Markdown',
                ...inlineMarkup
            });
        } else {
            return await ctx.reply(detailsMsg, {
                parse_mode: 'Markdown',
                ...inlineMarkup
            });
        }
    } catch (e) {
        console.error("Failed to display order details with photo:", e.message);
        return ctx.reply(detailsMsg, {
            parse_mode: 'Markdown',
            ...inlineMarkup
        });
    }
});

bot.action(/^reserve_specific_stock_(.+)_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];
    const stockId = ctx.match[2];

    const stockData = await db.popSpecificStockAccount(stockId, targetUserId);

    if (!stockData) {
        return ctx.reply("⚠️ উক্ত স্টক অ্যাকাউন্টটি ইতিমধ্যে অন্য অর্ডারে ব্যবহৃত বা রিমুভ হয়ে গেছে!");
    }

    // Trigger Low Stock Alert check
    await checkLowStockAlert(ctx);

    // Save reserved account info into order details
    if (db.isConfigured()) {
        await db.updateOrderStatus(targetUserId, 'Pending 10-Day Setup', stockData, 'Reserved-Pass');
    } else {
        if (memoryPendingOrders[targetUserId]) {
            memoryPendingOrders[targetUserId].status = 'Pending 10-Day Setup';
            memoryPendingOrders[targetUserId].reservedAccount = stockData;
        }
    }

    let emailVal = stockData;
    let passVal = '10-Day Premium Active';
    if (stockData.includes(':')) {
        const parts = stockData.split(':');
        emailVal = parts[0].trim();
        passVal = parts[1].trim();
    }

    // Send instant 1-Tap Copy text box to Admin
    await ctx.reply(
        `📋 *Reserved Stock Credentials (1-Tap Copy):*\n\n` +
        `📧 *Email (কপি করতে ট্যাপ করুন):*\n\`${emailVal}\`\n\n` +
        `🔑 *Password (কপি করতে ট্যাপ করুন):*\n\`${passVal}\`\n\n` +
        `> 💡 *ক্লিক বা ট্যাপ করলেই ১-সেকেন্ডে টেক্সট কপি হয়ে যাবে।*`,
        { parse_mode: 'Markdown' }
    );

    const confirmMsg = `📥 *Stock Account Reserved for User!* \n` +
                       `━━━━━━━━━━━━━━━━━━\n` +
                       `👤 *Customer ID:* \`${targetUserId}\`\n` +
                       `📧 *Assigned Email:* \`${emailVal}\`\n` +
                       `🔑 *Assigned Pass:* \`${passVal}\`\n` +
                       `⏳ *Status:* 10-Day Premium Setup Required\n` +
                       `━━━━━━━━━━━━━━━━━━\n\n` +
                       `👉 *আপনার করণীয়:* AdsPower ক্লায়েন্টে উক্ত আইডিতে ১০ দিনের প্রিমিয়াম এক্সেস একটিভ করুন।\n\n` +
                       `এক্টিভেশন শেষ হলে নিচের **"✅ Done & Deliver to Customer"** বাটনে ১-ক্লিক করুন:`;

    return ctx.reply(confirmMsg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`📧 Copy Email: ${emailVal}`, `copy_email_${emailVal}`)],
            [Markup.button.callback(`🔑 Copy Pass: ${passVal}`, `copy_pass_${passVal}`)],
            [Markup.button.callback('✅ Done & 1-Click Deliver to Customer', `deliver_stock_${targetUserId}`)],
            [Markup.button.callback('❌ Reject / Cancel Order', `start_reject_order_${targetUserId}`)]
        ])
    });
});

bot.action(/^reserve_stock_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    const stockData = await db.popStockAccount(targetUserId);

    if (!stockData) {
        return ctx.reply(
            "⚠️ *স্টকে কোনো অব্যবহৃত অ্যাকাউন্ট খালি নেই!*\n\n" +
            "দয়া করে আগে স্টকে নতুন অ্যাকাউন্ট যোগ করুন অথবা ম্যানুয়ালি ইমেইল-পাসওয়ার্ড ইনপুট দিন:",
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('➕ Add to Stock Pool', 'add_stock_prompt')],
                    [Markup.button.callback('✍️ Manual Input Email/Pass', `start_custom_pass_${targetUserId}`)]
                ])
            }
        );
    }

    // Trigger Low Stock Alert check
    await checkLowStockAlert(ctx);

    // Save reserved account info into order details
    if (db.isConfigured()) {
        await db.updateOrderStatus(targetUserId, 'Pending 10-Day Setup', stockData, 'Reserved-Pass');
    } else {
        if (memoryPendingOrders[targetUserId]) {
            memoryPendingOrders[targetUserId].status = 'Pending 10-Day Setup';
            memoryPendingOrders[targetUserId].reservedAccount = stockData;
        }
    }

    let emailVal = stockData;
    let passVal = '10-Day Premium Active';
    if (stockData.includes(':')) {
        const parts = stockData.split(':');
        emailVal = parts[0].trim();
        passVal = parts[1].trim();
    }

    // Send instant 1-Tap Copy text box to Admin
    await ctx.reply(
        `📋 *Reserved Stock Credentials (1-Tap Copy):*\n\n` +
        `📧 *Email (কপি করতে ট্যাপ করুন):*\n\`${emailVal}\`\n\n` +
        `🔑 *Password (কপি করতে ট্যাপ করুন):*\n\`${passVal}\`\n\n` +
        `> 💡 *ক্লিক বা ট্যাপ করলেই ১-সেকেন্ডে টেক্সট কপি হয়ে যাবে।*`,
        { parse_mode: 'Markdown' }
    );

    const confirmMsg = `📥 *Stock Account Reserved for User!* \n` +
                       `━━━━━━━━━━━━━━━━━━\n` +
                       `👤 *Customer ID:* \`${targetUserId}\`\n` +
                       `📧 *Assigned Account:* \`${stockData}\`\n` +
                       `⏳ *Status:* 10-Day Premium Setup Required\n` +
                       `━━━━━━━━━━━━━━━━━━\n\n` +
                       `👉 *আপনার করণীয়:* AdsPower ক্লায়েন্টে উক্ত আইডিতে ১০ দিনের প্রিমিয়াম এক্সেস একটিভ করুন।\n\n` +
                       `এক্টিভেশন শেষ হলে নিচের **"✅ Done & Deliver to Customer"** বাটনে ১-ক্লিক করুন:`;
                       `━━━━━━━━━━━━━━━━━━\n\n` +
                       `👉 *আপনার করণীয়:* AdsPower ক্লায়েন্টে উক্ত আইডিতে ১০ দিনের প্রিমিয়াম এক্সেস একটিভ করুন।\n\n` +
                       `এক্টিভেশন শেষ হলে নিচের **"✅ Done & Deliver to Customer"** বাটনে ১-ক্লিক করুন:`;

    return ctx.reply(confirmMsg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Done & 1-Click Deliver to Customer', `deliver_stock_${targetUserId}`)],
            [Markup.button.callback('❌ Reject / Cancel Order', `start_reject_order_${targetUserId}`)]
        ])
    });
});

bot.action(/^deliver_stock_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    let customAccountData = null;
    if (db.isConfigured()) {
        const ord = await db.getOrderForUser(targetUserId) || (await db.getUserOrders(targetUserId) || []).find(o => o.status === 'Pending 10-Day Setup');
        if (ord) customAccountData = ord.custom_email;
        await db.updateOrderStatus(targetUserId, 'Completed', customAccountData || 'AdsPower Premium Account', 'Delivered');
    } else {
        if (memoryPendingOrders[targetUserId]) {
            customAccountData = memoryPendingOrders[targetUserId].reservedAccount;
            memoryPendingOrders[targetUserId].status = 'Completed';
            delete memoryPendingOrders[targetUserId];
        }
    }

    if (!customAccountData) {
        customAccountData = "AdsPower 10-Day Premium Account";
    }

    // Check referral reward
    await checkAndRewardReferral(targetUserId, ctx);

    if (!memoryUserOrderHistory[targetUserId]) memoryUserOrderHistory[targetUserId] = [];
    memoryUserOrderHistory[targetUserId].push({
        packageName: '10-Day Premium AdsPower Account',
        method: '1-Click Stock Delivery',
        status: 'Completed',
        createdAt: new Date().toISOString()
    });

    // Parse email & pass if format is email:pass
    let emailVal = customAccountData;
    let passVal = '10-Day Premium Active';
    if (customAccountData.includes(':')) {
        const parts = customAccountData.split(':');
        emailVal = parts[0].trim();
        passVal = parts[1].trim();
    }

    // Post Real Completed Order to Group
    try {
        const realSaleMsg = `🟢 **ORDER SUCCESSFUL (10-DAY PREMIUM)**\n\n` +
                             `╔════════════════════╗\n` +
                             `**🛒 ADSPOWER PREMIUM ACCOUNT**\n` +
                             `╚════════════════════╝\n\n` +
                             `📡 STATUS → 🟢 **DELIVERED WITH 10-DAY PREMIUM**\n\n` +
                             `> 🚀 **ADSPOWER SELLER BD**`;

        const sentReal = await ctx.telegram.sendMessage(parseInt(GROUP_ID), realSaleMsg, { parse_mode: 'Markdown' });
        if (sentReal && sentReal.message_id) {
            await addAutoReactions(ctx.telegram, GROUP_ID, sentReal.message_id);
        }
    } catch (err) {}

    // Send credentials to User
    try {
        await ctx.telegram.sendMessage(
            targetUserId,
            `🎉 *Congratulations on Your Purchase!* 💎\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `> *আপনার পেমেন্ট সফলভাবে ভেরিফাই হয়েছে এবং ১০ দিনের প্রিমিয়াম এক্সেস এক্টিভ করা হয়েছে!*\n\n` +
            `📧 *Email / Account:* \`${emailVal}\`\n` +
            `🔑 *Password:* \`${passVal}\`\n\n` +
            `👇 নিচের বাটনগুলোতে ক্লিক করে তথ্য এক ক্লিকে কপি করে নিন:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`📧 Copy Email: ${emailVal}`, `copy_email_${emailVal}`)],
                    [Markup.button.callback(`🔑 Copy Pass: ${passVal}`, `copy_pass_${passVal}`)],
                    [Markup.button.callback('🔑 Get Login Code', `get_code_${targetUserId}`)],
                    [Markup.button.callback('📦 AdsPower Details', 'details')]
                ])
            }
        );
        return ctx.reply(`✅ 10-Day Premium Account Successfully Delivered to Customer (${targetUserId})!`);
    } catch (err) {
        return ctx.reply(`❌ ইউজারকে মেসেজ পাঠানো যায়নি (ইউজার হয়তো বট ব্লক করেছেন)।`);
    }
});

bot.action(/^start_custom_pass_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_accounts',
        targetUserId: targetUserId
    });

    return ctx.reply(
        "📧 অনুগ্রহ করে অ্যাকাউন্ট(সমূহ) নিচের ফরম্যাটে লিখে পাঠান (প্রতি লাইনে একটি করে):\n\n" +
        "`email:password`"
    );
});

bot.action(/^start_reject_order_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_reject_reason',
        targetUserId: targetUserId
    });

    return ctx.reply("❌ অর্ডারটি রিজেক্ট করার কারণটি লিখে পাঠান (যেমন: আপনার TrxID মিলছে না):");
});

bot.action('download_sales_csv', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Generating sales report CSV...");

    try {
        let orders = [];
        if (db.isConfigured()) {
            orders = await db.getAllOrders();
        } else {
            // Memory fallback logic
            Object.keys(memoryUserOrderHistory).forEach(uid => {
                memoryUserOrderHistory[uid].forEach(ord => {
                    orders.push({
                        user_id: uid,
                        package_name: ord.packageName || 'Unknown Package',
                        method: ord.method || 'Unknown Method',
                        proof: ord.proof || 'N/A',
                        status: ord.status || 'Completed',
                        created_at: ord.createdAt || new Date().toISOString(),
                        price_paid: ord.pricePaid || 30
                    });
                });
            });
        }

        if (!orders || orders.length === 0) {
            return ctx.reply("❌ কোনো সেলস বা অর্ডারের রেকর্ড পাওয়া যায়নি।");
        }

        // Construct CSV
        let csvContent = "\ufeff"; // BOM for UTF-8 Excel support
        csvContent += "Order ID,Date (UTC),User ID,Package,Method,TrxID/Proof,Price Paid (TK),Status,Email,Password,Login Code\n";

        orders.forEach(ord => {
            const escape = (val) => {
                if (val === null || val === undefined) return "";
                const str = String(val).replace(/"/g, '""');
                return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
            };

            csvContent += `${escape(ord.id || 'N/A')},` +
                          `${escape(ord.created_at || ord.createdAt || 'N/A')},` +
                          `${escape(ord.user_id)},` +
                          `${escape(ord.package_name)},` +
                          `${escape(ord.method)},` +
                          `${escape(ord.proof)},` +
                          `${escape(ord.price_paid || ord.pricePaid || 0)},` +
                          `${escape(ord.status)},` +
                          `${escape(ord.custom_email || '')},` +
                          `${escape(ord.custom_pass || '')},` +
                          `${escape(ord.login_code || '')}\n`;
        });

        const csvBuffer = Buffer.from(csvContent, 'utf-8');
        return await ctx.replyWithDocument({ source: csvBuffer, filename: `sales_report_${new Date().toISOString().split('T')[0]}.csv` }, {
            caption: "📊 *AdsPower Bot Sales Report Backup CSV*\n\nআপনার সকল ট্রানজেকশন এবং সেলসের এক্সেল ফাইল ব্যাকআপ সফলভাবে জেনারেট করা হয়েছে।",
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error("Failed to generate sales CSV:", err.message);
        return ctx.reply(`❌ CSV রিপোর্ট জেনারেট করতে সমস্যা হয়েছে: ${err.message}`);
    }
});

async function showTotalUsersStats(ctx) {
    let usersList = null;
    if (db.isConfigured()) {
        usersList = await db.getAllUsers();
    }

    let totalCount = 0;
    let buttons = [];

    if (usersList !== null && usersList.length > 0) {
        totalCount = usersList.length;
        usersList.forEach((u, index) => {
            buttons.push([Markup.button.callback(`👤 User #${index + 1} (ID: ${u.user_id})`, `inspect_user_${u.user_id}`)]);
        });
    } else {
        totalCount = memoryAllStartedUsers.size;
        Array.from(memoryAllStartedUsers).forEach((id, index) => {
            buttons.push([Markup.button.callback(`👤 User #${index + 1} (ID: ${id})`, `inspect_user_${id}`)]);
        });
    }

    return ctx.reply(
        `⭐ *Total Bot Users Statistics*\n\n` +
        `🚀 মোট কতজন বট স্টার্ট করেছে: **${totalCount} জন**\n\n` +
        `নিচের তালিকা থেকে যেকোনো ইউজারের ওপর ক্লিক করে দেখতে পারেন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons.slice(0, 50))
        }
    );
}

bot.action(/^inspect_user_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    
    let userDetails = `👤 *User Details* 👤\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `• *User ID:* \`${id}\`\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `⚠️ Database lookup failed or fallback memory is in use.`;

    try {
        if (db.isConfigured()) {
            const users = await db.getAllUsers();
            const user = users ? users.find(u => String(u.user_id) === id) : null;
            if (user) {
                const orders = await db.getUserOrders(id);
                const totalOrders = orders ? orders.length : 0;
                const completedOrders = orders ? orders.filter(o => o.status === 'Completed').length : 0;
                
                userDetails = `👤 *User Details* 👤\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `• *Name:* ${user.first_name || 'N/A'}\n` +
                              `• *Username:* @${user.username || 'N/A'}\n` +
                              `• *User ID:* \`${user.user_id}\`\n` +
                              `• *Registered:* \`${user.created_at ? new Date(user.created_at).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }) : 'N/A'}\`\n` +
                              `• *Last Active:* \`${user.last_active ? new Date(user.last_active).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }) : 'N/A'}\`\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `🛍 *Order Stats:*\n` +
                              `• Total Orders: *${totalOrders}*\n` +
                              `• Completed Orders: *${completedOrders}*`;
            } else {
                userDetails = `👤 *User Details* 👤\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `• *User ID:* \`${id}\`\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `❌ User details not found in database.`;
            }
        } else {
            // Memory fallback stats
            const orders = memoryUserOrderHistory[id] || [];
            const totalOrders = orders.length;
            const completedOrders = orders.filter(o => o.status === 'Completed').length;
            
            userDetails = `👤 *User Details (Memory Fallback)* 👤\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `• *User ID:* \`${id}\`\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `🛍 *Order Stats:*\n` +
                          `• Total Orders: *${totalOrders}*\n` +
                          `• Completed Orders: *${completedOrders}*`;
        }
    } catch (err) {
        console.error("Error fetching user details in admin panel:", err.message);
    }
    
    return ctx.reply(userDetails, { parse_mode: 'Markdown' });
});

bot.action(/^get_code_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Login code request sent to Admin!");
    const user = ctx.from;
    const targetUserId = ctx.match[1];
    const email = await getLatestCompletedEmail(targetUserId);

    try {
        await ctx.telegram.sendMessage(
            ADMIN_ID, 
            `🔑 *Login Code Request from User!*\n\n` +
            `👤 *User:* ${user.first_name} (\`${targetUserId}\`)\n` +
            `📧 *Email:* \`${email}\`\n\n` +
            `দয়া করে এই ইউজারকে লগইন কোড প্রদান করুন।`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📤 Send Login Code', `send_code_admin_${targetUserId}`)]
                ])
            }
        );
    } catch (err) {}

    return ctx.reply("📤 অ্যাডমিনের কাছে কোডের অনুরোধ পাঠানো হয়েছে। অ্যাডমিন কোড দিলে আপনার কাছে মেসেজ চলে আসবে। দয়া করে অপেক্ষা করুন...");
});

bot.action(/^send_code_admin_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_login_code',
        targetUserId: targetUserId
    });

    return ctx.reply(`🔑 অনুগ্রহ করে ইউজার (ID: \`${targetUserId}\`) এর জন্য **Login Code** টি লিখে পাঠান:`, { parse_mode: 'Markdown' });
});

bot.action('login_done', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(
        `❤️ *Thank You for Purchasing from AdsPower Seller BD!*\n\n` +
        `আপনার প্রিমিয়াম পাস সফলভাবে অ্যাক্টিভ হয়েছে। আমাদের সেবা নেওয়ার জন্য আপনাকে আন্তরিক ধন্যবাদ! 🚀\n\n` +
        `⭐ *অনুগ্রহ করে আমাদের সার্ভিসটি রেটিং দিন:*`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('⭐ 1', 'rate_1'),
                    Markup.button.callback('⭐⭐ 2', 'rate_2'),
                    Markup.button.callback('⭐⭐⭐ 3', 'rate_3'),
                    Markup.button.callback('⭐⭐⭐⭐ 4', 'rate_4'),
                    Markup.button.callback('⭐⭐⭐⭐⭐ 5', 'rate_5')
                ]
            ])
        }
    );
});

bot.action(/^rate_(\d)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const rating = ctx.match[1];
    const userId = ctx.from.id.toString();

    await updateUserSession(userId, { tempRating: rating, waitingFor: 'feedback_text' });

    return ctx.reply(
        `✍️ আপনি **${rating} Star** রেটিং দিয়েছেন। ধন্যবাদ! \n\n` +
        `আমাদের সার্ভিস নিয়ে আপনার কোনো মতামত বা অনুভূতি থাকলে তা লিখে পাঠান (অথবা চাইলে সরাসরি /skip টাইপ করতে পারেন):`
    );
});

// Admin Coupon Management Menus
async function showCouponsMenu(ctx) {
    let coupons = [];
    if (db.isConfigured()) {
        coupons = await db.getAllCoupons();
    } else {
        coupons = Object.keys(memoryCoupons).map(code => ({ code, discount_amount: memoryCoupons[code] }));
    }

    let inlineButtons = [];
    if (coupons && coupons.length > 0) {
        coupons.forEach(cp => {
            if (cp.code === 'SYSTEM_MAINTENANCE_MODE' || cp.code === 'SYSTEM_NOTICE_ENABLED' || cp.code.startsWith('NOTICE_TEXT|')) return;
            inlineButtons.push([
                Markup.button.callback(`🎟️ ${cp.code} (-${cp.discount_amount} TK)`, 'noop'),
                Markup.button.callback('❌ Delete', `delete_coupon_${cp.code}`)
            ]);
        });
    }

    inlineButtons.push([Markup.button.callback('➕ Add Coupon', 'admin_add_coupon')]);

    return ctx.reply("🎟️ *Active Coupons Management Menu:*\n\nকুপন কোড ও ডিসকাউন্ট অ্যাড বা ডিলিট করুন:", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(inlineButtons)
    });
}

bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery();
});

bot.action('admin_add_coupon', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_coupon_code' });
    return ctx.reply("🎟️ অনুগ্রহ করে নতুন **কুপন কোডটি** লিখুন (যেমন: BD50):");
});

bot.action(/^delete_coupon_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery("Coupon Deleted!");
    const code = ctx.match[1].toUpperCase();

    if (db.isConfigured()) {
        await db.deleteCoupon(code);
    } else {
        delete memoryCoupons[code];
    }

    try { await ctx.deleteMessage(); } catch(e) {}
    return showCouponsMenu(ctx);
});

bot.action('force_join_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getForceJoinStatus();
    await setForceJoinStatus(!current);
    await ctx.answerCbQuery(`Force Join is now ${!current ? 'Enabled' : 'Disabled'}`);
    return showBotControlPanel(ctx);
});

bot.action('selling_hours_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getSellingHoursStatus();
    await setSellingHoursStatus(!current);
    await ctx.answerCbQuery(`Time Limits are now ${!current ? 'Enabled' : 'Disabled'}`);
    return showBotControlPanel(ctx);
});

bot.action('edit_refer_reward', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_refer_reward'
    });
    return ctx.reply("💰 কুপনের মাধ্যমে রেফারেলের জন্য নতুন কুপন বোনাস মূল্য (টাকায়) লিখে পাঠান (যেমন: 5):");
});

bot.action('stock_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const stock1 = await getPackageStockStatus('pkg_1');
    const stock3 = await getPackageStockStatus('pkg_3');
    const stock5 = await getPackageStockStatus('pkg_5');

    const stockText = `📦 *Stock Management Panel* 📦\n\n` +
                      `নিচের বাটনগুলো ক্লিক করে প্যাকেজের স্টক অন/অফ (In Stock / Out of Stock) করুন:\n\n` +
                      `• **1 Account:** ${stock1 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **3 Accounts:** ${stock3 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **5 Accounts:** ${stock5 ? '🟢 In Stock' : '🔴 Out of Stock'}`;

    return ctx.editMessageText(stockText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [
                Markup.button.callback(stock1 ? '🔴 Set 1 Acc Out of Stock' : '🟢 Set 1 Acc In Stock', 'toggle_stock_pkg_1'),
            ],
            [
                Markup.button.callback(stock3 ? '🔴 Set 3 Acc Out of Stock' : '🟢 Set 3 Acc In Stock', 'toggle_stock_pkg_3'),
            ],
            [
                Markup.button.callback(stock5 ? '🔴 Set 5 Acc Out of Stock' : '🟢 Set 5 Acc In Stock', 'toggle_stock_pkg_5'),
            ],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

bot.action(/^toggle_stock_(pkg_\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const pkgKey = ctx.match[1];
    const current = await getPackageStockStatus(pkgKey);
    await setPackageStockStatus(pkgKey, !current);
    await ctx.answerCbQuery(`Stock updated!`);
    
    // Smoothly redraw stock menu
    const stock1 = await getPackageStockStatus('pkg_1');
    const stock3 = await getPackageStockStatus('pkg_3');
    const stock5 = await getPackageStockStatus('pkg_5');

    const stockText = `📦 *Stock Management Panel* 📦\n\n` +
                      `নিচের বাটনগুলো ক্লিক করে প্যাকেজের স্টক অন/অফ (In Stock / Out of Stock) করুন:\n\n` +
                      `• **1 Account:** ${stock1 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **3 Accounts:** ${stock3 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **5 Accounts:** ${stock5 ? '🟢 In Stock' : '🔴 Out of Stock'}`;

    return ctx.editMessageText(stockText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [
                Markup.button.callback(stock1 ? '🔴 Set 1 Acc Out of Stock' : '🟢 Set 1 Acc In Stock', 'toggle_stock_pkg_1'),
            ],
            [
                Markup.button.callback(stock3 ? '🔴 Set 3 Acc Out of Stock' : '🟢 Set 3 Acc In Stock', 'toggle_stock_pkg_3'),
            ],
            [
                Markup.button.callback(stock5 ? '🔴 Set 5 Acc Out of Stock' : '🟢 Set 5 Acc In Stock', 'toggle_stock_pkg_5'),
            ],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

// Admin Management Action Handlers
bot.action('open_admin_mgmt_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showAdminManagementMenu(ctx);
});

bot.action('admin_back_to_main', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showBotControlPanel(ctx);
});

bot.action('admin_today_status', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const stats = await getSalesReportStats();
    const pendingOrders = (await db.getPendingOrders()) || [];
    const allUsers = (await db.getAllUsers()) || [];
    const bannedUsers = await db.getAllBannedUsers();
    const isMaintenance = await getMaintenanceMode();

    const statusMsg = 
        `📈 *Today's Overall Status Report*\n\n` +
        `• **Bot Mode:** ${isMaintenance ? '🔴 Maintenance ON' : '🟢 Operational ON'}\n` +
        `• **Today's Revenue:** *${stats.todayRevenue} TK*\n` +
        `• **This Month's Revenue:** *${stats.monthRevenue} TK*\n` +
        `• **Total Completed Orders:** *${stats.totalCount}*\n` +
        `• **Pending Orders Verification:** *${pendingOrders.length}*\n` +
        `• **Total Registered Users:** *${allUsers.length}*\n` +
        `• **Total Banned Users:** *${bannedUsers.length}*\n\n` +
        `⏱️ *Last Updated:* ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Status', 'admin_today_status')],
        [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
    ]);

    return ctx.editMessageText(statusMsg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('admin_user_status', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_user_status_id' });
    return ctx.reply("👤 *User Status Check*\n\nঅনুগ্রহ করে যে ইউজারের বিবরণ দেখতে চান তার **Telegram User ID** অথবা **Username** লিখুন (যেমন: `8929349073` বা `@username`):", { parse_mode: 'Markdown' });
});

bot.action('admin_update_joins', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_new_join_link' });
    return ctx.reply("📡 *Update Force Join Link*\n\nনতুন টেলিগ্রাম চ্যানেল/গ্রুপ জয়েন লিংক বা ইউজারনেম লিখে পাঠান:\n(যেমন: `https://t.me/AdsPowerSellerBDGroup` অথবা `@AdsPowerGroup`)", { parse_mode: 'Markdown' });
});

bot.action('admin_live_services', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const stock1 = await getPackageStockStatus('pkg_1');
    const stock3 = await getPackageStockStatus('pkg_3');
    const stock5 = await getPackageStockStatus('pkg_5');
    const isMaintenance = await getMaintenanceMode();
    const isSellingHours = await getSellingHoursStatus();

    const liveText = 
        `🛰️ *Live Bot Services Status*\n\n` +
        `• **Core System:** ${isMaintenance ? '🔴 Maintenance' : '🟢 Operational'}\n` +
        `• **Selling Schedule:** ${isSellingHours ? '🕒 11am-11pm Limit' : '⚡ 24 Hours Active'}\n` +
        `• **Package 1 Acc:** ${stock1 ? '🟢 Available' : '🔴 Out of Stock'}\n` +
        `• **Package 3 Acc:** ${stock3 ? '🟢 Available' : '🔴 Out of Stock'}\n` +
        `• **Package 5 Acc:** ${stock5 ? '🟢 Available' : '🔴 Out of Stock'}\n\n` +
        `কন্ট্রোল প্যানেল থেকে স্টক বা টাইমিং পরিবর্তন করতে পারবেন।`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📦 Manage Stock', 'stock_menu')],
        [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
    ]);

    return ctx.editMessageText(liveText, { parse_mode: 'Markdown', ...keyboard });
});

const CUSTOMIZABLE_ITEMS = {
    // User Bot Main Buttons & Screens
    'WELCOME': { name: '💎 Welcome Message (/start)', defaultMsg: 'স্বাগতম আমাদের শপে!', defaultLabel: 'Welcome Message' },
    'DETAILS': { name: '📦 AdsPower Details (Package Info Screen)', defaultMsg: 'AdsPower এন্টি-ডিটেক্ট ব্রাউজার প্যাকেজ বিবরণ:', defaultLabel: 'AdsPower Details' },
    'BUY_NOW': { name: '🛒 BUY NOW (Main Button & Options Title)', defaultMsg: 'AdsPower প্যাকেজসমূহ সিলেক্ট করুন:', defaultLabel: 'Buy Now' },
    'PROFILE': { name: '👤 PROFILE (Main Button & Screen Title)', defaultMsg: 'আপনার অ্যাকাউন্ট প্রোফাইল বিবরণ:', defaultLabel: 'My Profile' },
    'MY_ORDER': { name: '🛍 MY ORDER (Main Button & Screen Title)', defaultMsg: 'আপনার পূর্বের অর্ডারসমূহ:', defaultLabel: 'My Order' },
    'NOTICE': { name: '📢 OFFERS & NOTICE (Main Button & Notice Title)', defaultMsg: 'সাম্প্রতিক নোটিশ ও অফার:', defaultLabel: 'Offers & Notice' },
    'FAQ': { name: '❓ FAQ & HELP GUIDE (FAQ Screen Text)', defaultMsg: 'সাধারণ জিজ্ঞাসা ও সাহায্য নির্দেশিকা:', defaultLabel: 'FAQ & Help Guide' },
    'LEADERBOARD': { name: '🏆 LEADERBOARD (Leaderboard Screen Title)', defaultMsg: 'সর্বোচ্চ ক্রয়কারী গ্রাহকদের তালিকা:', defaultLabel: 'Leaderboard' },
    'SUPPORT': { name: '📞 SUPPORT (Contact Support Admin Username)', defaultMsg: 'এডমিন সাপোর্ট ইউজারনেম: @prime8088', defaultLabel: 'Contact Support' },
    'VERIFY_JOIN': { name: '🔄 VERIFY JOIN (Force Join Screen Title)', defaultMsg: 'গ্রুপে জয়েন করে ভেরিফাই করুন:', defaultLabel: 'Verify / Check Join' },
    'REF_BONUS': { name: '🎁 REFERRAL (Referral Reward Amount)', defaultMsg: '৩ টাকা ডিসকাউন্ট কুপন বোনাস', defaultLabel: 'Referral Bonus' },

    // Packages & Checkout Options
    'PKG_1': { name: '⚡ Package 1 (1 Account AdsPower)', defaultMsg: '1 Account AdsPower - 30 TK', defaultLabel: '1 Account AdsPower = 30 TK' },
    'PKG_3': { name: '🔥 Package 3 (3 Accounts AdsPower)', defaultMsg: '3 Accounts AdsPower - 80 TK', defaultLabel: '3 Accounts AdsPower = 80 TK' },
    'PKG_5': { name: '👑 Package 5 (5 Accounts AdsPower)', defaultMsg: '5 Accounts AdsPower - 135 TK', defaultLabel: '5 Accounts AdsPower = 135 TK' },
    'ACCOUNT_STOCK': { name: '📦 Account Type: Stock Pool', defaultMsg: 'আমাদের তৈরি করা রেডিমেড স্টক থেকে ইন্সট্যান্ট অ্যাকাউন্ট পাবেন।', defaultLabel: 'Get Account from Stock Pool' },
    'ACCOUNT_OWN_EMAIL': { name: '📧 Account Type: Own Email', defaultMsg: 'আপনার নিজের জিমেইল/ইমেইলে ১০ দিনের প্রিমিয়াম সুবিধা একটিভ করে নিবেন।', defaultLabel: 'Provide My Own Email' },
    'APPLY_COUPON': { name: '🎟️ Apply Coupon Code', defaultMsg: 'ডিসকাউন্ট পেতে কুপন কোড প্রবেশ করান।', defaultLabel: 'Apply Coupon Code' },

    // Navigation & Action Buttons
    'CANCEL_ORDER': { name: '❌ Cancel Pending Order', defaultMsg: 'পেন্ডিং অর্ডার বাতিল সংক্রান্ত মেসেজ', defaultLabel: 'Cancel Pending Order' },
    'CLEAR_ORDER': { name: '🗑 Clear History', defaultMsg: 'অর্ডার হিস্ট্রি সাফ করার নোটিশ', defaultLabel: 'Clear History' },
    'BACK_MENU': { name: '⬅️ Back to Menu', defaultMsg: 'প্রধান মেনুতে ফিরে আসার বোতাম', defaultLabel: 'Back to Menu' },
    'CLOSE_DETAILS': { name: '❌ Close Details', defaultMsg: 'বিবরণ বন্ধের বোতাম', defaultLabel: 'Close Details' },

    // Gateways
    'BKASH': { name: '🌸 PAYMENT: bKash Gateway Number', defaultMsg: '01864339154', defaultLabel: 'bKash Gateway' },
    'NAGAD': { name: '🍑 PAYMENT: Nagad Gateway Number', defaultMsg: '01864339154', defaultLabel: 'Nagad Gateway' },
    'BINANCE': { name: '🟡 PAYMENT: Binance Pay ID', defaultMsg: '955102483', defaultLabel: 'Binance Pay' },
    'PAYONEER': { name: '🔷 PAYMENT: Payoneer Email', defaultMsg: 'mithuchandra647@gmail.com', defaultLabel: 'Payoneer Email' },

    // Admin Control Panel Buttons & Actions
    'ADMIN_PENDING_ORDERS': { name: '📥 ADMIN: Pending Orders Menu', defaultMsg: 'পেন্ডিং অর্ডার এপ্রুভাল প্যানেল', defaultLabel: 'Pending Orders' },
    'ADMIN_TOTAL_USERS': { name: '👥 ADMIN: Total Users Stats', defaultMsg: 'বটের নিবন্ধিত কাস্টমার পরিসংখ্যান', defaultLabel: 'Total Bot Users' },
    'ADMIN_BROADCAST': { name: '📢 ADMIN: Broadcast Message', defaultMsg: 'ইউজারদের বাল্ক মেসেজ নোটিফিকেশন', defaultLabel: 'Broadcast' },
    'ADMIN_SALES_REPORT': { name: '📊 ADMIN: Sales Report', defaultMsg: 'বিক্রির বিবরণ ও সেলস রিপোর্ট', defaultLabel: 'Sales Report' },
    'ADMIN_COUPONS': { name: '🎟️ ADMIN: Discount Coupons', defaultMsg: 'ডিসকাউন্ট কুপন ম্যানেজমেন্ট', defaultLabel: 'Coupons' },
    'ADMIN_TODAY_STATUS': { name: '📈 ADMIN: Today All Status', defaultMsg: 'আজকের ওভারঅল স্ট্যাটাস রিপোর্ট', defaultLabel: 'Today All Status' },
    'ADMIN_USER_STATUS': { name: '👤 ADMIN: User Status Check', defaultMsg: 'ইউজার অ্যাকাউন্ট তথ্য ও ব্যালেন্স', defaultLabel: 'User Status Check' },
    'ADMIN_UPDATE_JOINS': { name: '📡 ADMIN: Update Joins', defaultMsg: 'চ্যানেল/গ্রুপ জয়েনিং লিংক আপডেট', defaultLabel: 'Update Joins' },
    'ADMIN_LIVE_SERVICES': { name: '🛰️ ADMIN: Live Services', defaultMsg: 'বট সার্ভিসের লাইভ মনিটরিং', defaultLabel: 'Live Services' },
    'ADMIN_BAN_USER': { name: '⛔ ADMIN: Ban User', defaultMsg: 'ইউজার ব্যান করার অ্যাকশন', defaultLabel: 'Ban User' },
    'ADMIN_UNBAN_USER': { name: '🔓 ADMIN: Unban User', defaultMsg: 'ইউজার আনব্যান করার অ্যাকশন', defaultLabel: 'Unban User' },
    'ADMIN_BAN_LIST': { name: '📜 ADMIN: Ban User List', defaultMsg: 'ব্যানড ইউজারের তালিকা প্যানেল', defaultLabel: 'Ban User List' },
    'ADMIN_ADD_BALANCE': { name: '➕ ADMIN: Add Balance', defaultMsg: 'ইউজার অ্যাকাউন্টে ব্যালেন্স যোগ', defaultLabel: 'Add Balance' },
    'ADMIN_REMOVE_BALANCE': { name: '➖ ADMIN: Remove Balance', defaultMsg: 'ইউজার অ্যাকাউন্ট থেকে ব্যালেন্স কর্তন', defaultLabel: 'Remove Balance' },
    'ADMIN_STOCK_MGMT': { name: '📦 ADMIN: Manage Stock', defaultMsg: 'প্যাকেজের স্টক ইন/আউট কন্ট্রোল', defaultLabel: 'Manage Stock' },
    'ADMIN_SEARCH': { name: '🔍 ADMIN: Search Order / User', defaultMsg: 'ইউজার বা অর্ডার সার্চ প্যানেল', defaultLabel: 'Search Order / User' },
    'ADMIN_VIP': { name: '👑 ADMIN: Top VIP Buyers', defaultMsg: 'টপ ভিআইপি ক্রেতাদের তালিকা', defaultLabel: 'Top VIP Buyers' },
    'ADMIN_BACKUP': { name: '💾 ADMIN: Full DB Backup', defaultMsg: 'ডাটাবেজ ব্যাকআপ ফাইল তৈরি', defaultLabel: 'Full DB Backup' }
};

async function showCustomizeItemCard(ctx, itemKey) {
    const item = CUSTOMIZABLE_ITEMS[itemKey] || { name: itemKey, defaultMsg: 'ডিফল্ট টেক্সট', defaultLabel: itemKey };
    
    let defaultVal = item.defaultMsg;
    if (['BKASH', 'NAGAD', 'BINANCE', 'PAYONEER'].includes(itemKey)) {
        defaultVal = await getWallet(itemKey.toLowerCase());
    }

    const label = await getCustomText(`LABEL_${itemKey}`, item.defaultLabel);
    const msg = await getCustomText(`MSG_${itemKey}`, defaultVal);
    const emojiId = await getCustomText(`EMOJIID_${itemKey}`, '');
    const emojiTag = await getItemEmojiTag(itemKey, '💡');

    const cardText = 
        `🛠️ <b>CUSTOMIZING: ${item.name}</b>\n` +
        `🏷️ <b>Key ID:</b> <code>${itemKey}</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🏷️ <b>Label (BN):</b> ${label}\n\n` +
        `📝 <b>Msg (BN):</b>\n` +
        `" ${emojiTag} ${msg} "\n\n` +
        `✨ <b>Premium Emoji ID:</b>\n` +
        `<code>${emojiId || 'Not Set (ডিফল্ট)'}</code> ${emojiTag}\n\n` +
        `ℹ️ <i>মেসেজের শুরুতে প্রিমিয়াম ইমোজি সংযুক্ত হচ্ছে।</i>\n\n` +
        `👇 <i>আপনি যা পরিবর্তন করতে চান তা নিচে থেকে সিলেক্ট করুন:</i>`;

    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🏷️ Edit Label', `edit_item_label_${itemKey}`),
            Markup.button.callback('📝 Edit Message', `edit_item_msg_${itemKey}`)
        ],
        [
            Markup.button.callback('✨ Edit Premium Emoji ID', `edit_item_emojiid_${itemKey}`)
        ],
        [
            Markup.button.callback('🔙 Back to Customization', 'admin_customize_texts')
        ]
    ]);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(cardText, { parse_mode: 'HTML', ...keyboard });
        } catch(e) {
            await ctx.reply(cardText, { parse_mode: 'HTML', ...keyboard });
        }
    } else {
        await ctx.reply(cardText, { parse_mode: 'HTML', ...keyboard });
    }
}

bot.action(/^admin_customize_texts(?:_page_(\d+))?$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const page = parseInt(ctx.match[1] || '1');
    const itemsPerPage = 8;
    const keys = Object.keys(CUSTOMIZABLE_ITEMS);
    const totalPages = Math.ceil(keys.length / itemsPerPage);
    const startIdx = (page - 1) * itemsPerPage;
    const currentKeys = keys.slice(startIdx, startIdx + itemsPerPage);

    const inlineButtons = currentKeys.map(k => [
        Markup.button.callback(CUSTOMIZABLE_ITEMS[k].name, `cust_card_${k}`)
    ]);

    const navRow = [];
    if (page > 1) {
        navRow.push(Markup.button.callback('⬅️ Previous Page', `admin_customize_texts_page_${page - 1}`));
    }
    if (page < totalPages) {
        navRow.push(Markup.button.callback('Next Page ➡️', `admin_customize_texts_page_${page + 1}`));
    }
    if (navRow.length > 0) {
        inlineButtons.push(navRow);
    }

    inlineButtons.push([Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]);

    const textMsg = `📝 *Customize Bot & Admin Buttons Panel* (Page ${page}/${totalPages})\n\n` +
                    `বটের মোট **${keys.length}টি বাটন ও ফিচার টাইটেলের** তালিকা নিচে দেওয়া হলো। যে বাটনটি কাস্টমাইজ করতে চান সেটিতে ক্লিক করুন:`;

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
        } catch(e) {
            await ctx.reply(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
        }
    } else {
        await ctx.reply(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
    }
});

bot.action(/^cust_card_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const itemKey = ctx.match[1];
    const adminId = ctx.from.id.toString();
    const item = CUSTOMIZABLE_ITEMS[itemKey] || { name: itemKey };
    await updateAdminSession(adminId, { step: `waiting_for_card_msg_${itemKey}` });
    return ctx.reply(
        `📝 *Edit Message for ${item.name}*\n\n` +
        `নতুন **Message / টেক্সট বিবরণ** সরাসরি লিখে বা পেস্ট করে পাঠান:\n` +
        `*(ব্লককোট >, বোল্ড, ইটালিক, লিঙ্ক এবং কাস্টম প্রিমিয়াম ইমোজিসহ যেভাবে পাঠাবেন, ইউজাররা হুবহু সেভাবেই দেখতে পাবে!)*`,
        { parse_mode: 'Markdown' }
    );
});

bot.action(/^edit_item_(label|msg|emojiid)_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const field = ctx.match[1];
    const itemKey = ctx.match[2];
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: `waiting_for_card_${field}_${itemKey}` });
    
    if (field === 'label') {
        return ctx.reply(`🏷️ *Edit Label for ${itemKey}*\n\nনতুন **Label / বাটন নাম** লিখে পাঠান:`, { parse_mode: 'Markdown' });
    } else if (field === 'msg') {
        return ctx.reply(`📝 *Edit Message for ${itemKey}*\n\nনতুন **Message / টেক্সট বিবরণ** লিখে পাঠান:`, { parse_mode: 'Markdown' });
    } else if (field === 'emojiid') {
        return ctx.reply(`✨ *Edit Premium Emoji ID for ${itemKey}*\n\nনতুন **Telegram Premium Emoji ID** লিখে পাঠান (যেমন: \`6206112371308500200\`):`, { parse_mode: 'Markdown' });
    }
});

bot.action('edit_welcome_msg', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_welcome_msg' });
    return ctx.reply("💎 *Edit Welcome Message*\n\nনতুন **Welcome Message** লিখে পাঠান (ইউজারের নাম দেখাতে `{name}` ব্যবহার করতে পারেন):", { parse_mode: 'Markdown' });
});

bot.action('edit_buy_now_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_buy_now_title' });
    return ctx.reply("🛒 *Edit Buy Now Title*\n\nনতুন **Buy Now/প্যাকেজ টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_profile_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_profile_title' });
    return ctx.reply("👤 *Edit Profile Title*\n\nনতুন **Profile টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_my_order_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_my_order_title' });
    return ctx.reply("🛍 *Edit My Order Title*\n\nনতুন **My Order টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_faq_text', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_faq_text' });
    return ctx.reply("❓ *Edit FAQ Text*\n\nনতুন **FAQ & Help Guide টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_leaderboard_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_leaderboard_title' });
    return ctx.reply("🏆 *Edit Leaderboard Title*\n\nনতুন **Leaderboard টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_support_username', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_support_username' });
    return ctx.reply("📞 *Edit Support Admin Username*\n\nনতুন **Admin Username** লিখে পাঠান (যেমন: `@prime8088`):", { parse_mode: 'Markdown' });
});

bot.action('admin_ban_user', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_ban_user_id' });
    return ctx.reply("⛔ *Ban User*\n\nযে ইউজারকে ব্যান করতে চান তার **Telegram User ID** লিখুন:", { parse_mode: 'Markdown' });
});

bot.action('admin_unban_user', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_unban_user_id' });
    return ctx.reply("🔓 *Unban User*\n\nযে ইউজারকে আনব্যান করতে চান তার **Telegram User ID** লিখুন:", { parse_mode: 'Markdown' });
});

bot.action('admin_ban_list', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const bannedList = await db.getAllBannedUsers();
    if (!bannedList || bannedList.length === 0) {
        const emptyMsg = `📜 *Banned Users List*\n\nবর্তমানে কোনো ইউজার ব্যান তালিকায় নেই। 🟢`;
        return ctx.editMessageText(emptyMsg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]])
        });
    }

    let listText = `📜 *Banned Users List (${bannedList.length})*\n\n`;
    const buttons = [];
    bannedList.forEach(id => {
        listText += `• User ID: \`${id}\`\n`;
        buttons.push([Markup.button.callback(`🔓 Unban User ${id}`, `unban_id_${id}`)]);
    });

    buttons.push([Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]);

    return ctx.editMessageText(listText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^ban_id_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const targetId = ctx.match[1];
    await db.banUser(targetId);
    await ctx.answerCbQuery(`User ${targetId} Banned!`);
    return ctx.reply(`⛔ ইউজার ID \`${targetId}\` কে সফলভাবে **ব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
});

bot.action(/^unban_id_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const targetId = ctx.match[1];
    await db.unbanUser(targetId);
    await ctx.answerCbQuery(`User ${targetId} Unbanned!`);
    return ctx.reply(`🔓 ইউজার ID \`${targetId}\` কে সফলভাবে **আনব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
});

bot.action('admin_add_balance', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_add_balance' });
    return ctx.reply("➕ *Add User Balance*\n\nইউজার ID এবং টাকার পরিমাণ স্পেস দিয়ে লিখে পাঠান:\n*(ফরম্যাট: `User_ID Amount` - যেমন: `8929349073 500`)*", { parse_mode: 'Markdown' });
});

bot.action('admin_remove_balance', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_remove_balance' });
    return ctx.reply("➖ *Remove User Balance*\n\nইউজার ID এবং টাকার পরিমাণ স্পেস দিয়ে লিখে পাঠান:\n*(ফরম্যাট: `User_ID Amount` - যেমন: `8929349073 100`)*", { parse_mode: 'Markdown' });
});

bot.action('admin_pending_orders', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showPendingOrdersMenu(ctx);
});

bot.action('admin_total_users', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showTotalUsersStats(ctx);
});

bot.action('admin_broadcast_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_broadcast' });
    return ctx.reply("📢 *Broadcast Message*\n\nআপনার ব্রডকাস্ট মেসেজটি (লেখা বা ছবি) পাঠান যা সকল ইউজারের কাছে একসাথে চলে যাবে:", { parse_mode: 'Markdown' });
});

bot.action('admin_coupons_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showCouponsMenu(ctx);
});

bot.action('admin_sales_report', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const stats = await getSalesReportStats();
    const reportText = 
        `📊 *AdsPower Bot Sales Report* 📊\n\n` +
        `• Total Completed Sales: *${stats.totalCount}*\n` +
        `• Total Revenue: *${stats.totalRevenue} TK*\n\n` +
        `• Today's Sales: *${stats.todayRevenue} TK*\n` +
        `• This Month's Sales: *${stats.monthRevenue} TK*\n\n` +
        `❤️ Keep hustling! Keep selling! 🚀`;
    return ctx.reply(reportText, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📥 Download CSV Report', 'download_sales_csv')],
            [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
        ])
    });
});

bot.action('admin_close', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Admin Panel Closed.");
    try {
        await ctx.deleteMessage();
    } catch(e) {}
});

async function runExpiryCheck(req, res) {
    try {
        if (!db.isConfigured()) {
            return res.status(200).json({ message: "Database not configured, skipping cron." });
        }
        
        const completedOrders = await db.getCompletedOrders();
        if (!completedOrders || completedOrders.length === 0) {
            return res.status(200).json({ status: "success", message: "No completed orders found." });
        }
        
        const now = new Date();
        let remindersSent = 0;
        
        for (const ord of completedOrders) {
            if (!ord.created_at || !ord.user_id) continue;
            
            const orderDate = new Date(ord.created_at);
            const diffTime = Math.abs(now - orderDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            // If it has been exactly 9 days (warning)
            if (diffDays === 9) {
                try {
                    await bot.telegram.sendMessage(
                        ord.user_id,
                        `⚠️ *AdsPower Package Expiry Reminder* ⚠️\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `প্রিয় গ্রাহক, আপনার ক্রয়কৃত প্যাকেজ \`${ord.package_name || 'AdsPower'}\` এর মেয়াদ আগামীকাল শেষ হতে যাচ্ছে।\n\n` +
                        `🛒 নির্বিঘ্ন সেবা বজায় রাখতে এখনই রিনিউ করতে /start এ যান! 🚀`,
                        { parse_mode: 'Markdown' }
                    );
                    remindersSent++;
                } catch (err) {
                    console.error(`Failed to send renewal reminder to ${ord.user_id}:`, err.message);
                }
            }
        }
        
        return res.status(200).json({ status: "success", remindersSent });
    } catch (err) {
        console.error("Cron expiry check error:", err.message);
        return res.status(500).json({ error: err.message });
    }
}

let lastWebhookSetTime = 0;

async function autoEnsureWebhook(req) {
    const now = Date.now();
    // Throttle re-verifying webhook to max once every 3 minutes unless forced
    if (now - lastWebhookSetTime < 180000) {
        return "cached_ok";
    }

    if (req && req.headers && req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1')) {
        try {
            await bot.telegram.setMyCommands([
                { command: 'start', description: 'Start the bot / প্রধান মেনু 🚀' }
            ]);
            const hostName = req.headers.host;
            const webhookUrl = `https://${hostName}/api/bot.js`;
            await bot.telegram.setWebhook(webhookUrl, {
                allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member']
            });
            lastWebhookSetTime = now;
            return `Webhook auto-healed to ${webhookUrl}`;
        } catch (setupErr) {
            console.error("Auto-webhook error:", setupErr.message);
            return `Webhook error: ${setupErr.message}`;
        }
    }
    return "not_applicable";
}

// Vercel Serverless Function Handler
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            if (update) {
                await bot.handleUpdate(update);
            }
            return res.status(200).json({ status: 'ok' });
        } catch (e) {
            console.error("Webhook handleUpdate error:", e.message);
            return res.status(200).json({ status: 'error', message: e.message });
        }
    } else {
        try {
            // Auto-heal webhook on any incoming GET or Cron ping
            const autoWebhookRes = await autoEnsureWebhook(req);

            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            if (url.searchParams.get('cron') === 'expiry_check') {
                return await runExpiryCheck(req, res);
            }
            if (url.searchParams.get('cron') === 'fake_sales') {
                const count = parseInt(url.searchParams.get('count') || '2');
                for (let i = 0; i < Math.min(count, 5); i++) {
                    await sendFakeSaleToGroup();
                    if (i < count - 1) await new Promise(r => setTimeout(r, 2000));
                }
                return res.status(200).json({ status: "success", message: `Fake sale triggered (${count} posts).`, autoWebhook: autoWebhookRes });
            }

            return res.status(200).json({
                message: 'AdsPower Bot is running successfully!',
                webhook: autoWebhookRes
            });
        } catch (err) {
            console.error("GET handler error:", err.message);
            return res.status(200).json({ message: 'AdsPower Bot is running successfully!' });
        }
    }
};

// Catch Telegraf errors to prevent process crash on network glitches
bot.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx ? ctx.updateType : 'unknown'}:`, err.message);
});

// Start persistent launch if run directly (VPS / Local Hosting) with auto-retry
async function launchWithRetry() {
    // Safety guard: Never launch long-polling or delete webhooks when running on Vercel environment
    if (process.env.VERCEL || process.env.VERCEL_ENV) {
        console.log("Vercel environment detected - Long-polling launch bypassed.");
        return;
    }

    try {
        try {
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            console.log("Cleared old webhook for long-polling mode.");
        } catch (wErr) {
            console.log("Webhook delete notice:", wErr.message);
        }

        // Start fake sales interval before bot.launch (which blocks until stop)
        setInterval(async () => {
            await sendFakeSaleToGroup();
        }, 30000);
        // Send initial fake sale right away on start
        sendFakeSaleToGroup().catch(e => console.error("Initial fake sale error:", e.message));

        console.log("Bot launching in persistent mode (Long-Polling)...");
        console.log("Notice: Long-polling temporarily overrides Vercel Webhook. Visit your Vercel URL to restore Webhook when done.");
        await bot.launch();
    } catch (err) {
        console.error("Bot launch failed (network timeout), retrying in 5 seconds...", err.message);
        setTimeout(launchWithRetry, 5000);
    }
}

try {
    const isDirectRun = (typeof require !== 'undefined' && require.main === module);
    if (isDirectRun || process.env.PERSISTENT === 'true') {
        launchWithRetry();
    }
} catch (e) {
    console.error("Failed to check direct run mode:", e.message);
}

