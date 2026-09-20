import logging
import random
import string
import re
import html
import os
import io
import asyncio
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton, InputFile
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
    ConversationHandler
)

from config import BOT_TOKEN, ADMIN_ID, POLL_INTERVAL, DB_PATH
from mail_api import mail_api
import database as db
import parser as email_parser
from locales import get_string

logger = logging.getLogger(__name__)

WAITING_FOR_LOGIN_INPUT = 1
WAITING_FOR_CUSTOM_NAME = 2
WAITING_FOR_BAN_ID = 3
WAITING_FOR_UNBAN_ID = 4
WAITING_FOR_VIP_ID = 5
WAITING_FOR_SENDER_NUMBER = 6
WAITING_FOR_TRX_ID = 7
WAITING_FOR_BROADCAST_CONTENT = 8
WAITING_FOR_2FA_INPUT = 9


def safe_html(text: str) -> str:
    return html.escape(str(text or ""))

FIRST_NAMES = [
    "alex", "david", "sarah", "michael", "emily", "james", "daniel", "sophia",
    "oliver", "william", "emma", "lucas", "liam", "benjamin", "chloe", "ethan",
    "mason", "isabella", "henry", "samuel", "ryan", "nathan", "andrew", "joshua",
    "matthew", "jacob", "grace", "hannah", "logan", "jack", "noah", "aiden",
    "clara", "mia", "zoe", "ava", "leo", "adam", "kevin", "eric", "brian",
    "jason", "justin", "brandon", "dylan", "tyler"
]

LAST_NAMES = [
    "smith", "johnson", "brown", "davis", "wilson", "taylor", "clark", "miller",
    "white", "martin", "anderson", "thomas", "moore", "harris", "walker", "young",
    "king", "wright", "scott", "green", "baker", "adams", "nelson", "hill",
    "hall", "rivera", "campbell", "mitchell", "carter", "roberts", "parker", "evans"
]

KEYWORDS = ["dev", "tech", "work", "pro", "official", "net", "hub", "mail", "contact", "info"]

def generate_professional_username():
    while True:
        fn = random.choice(FIRST_NAMES)
        ln = random.choice(LAST_NAMES)
        kw = random.choice(KEYWORDS)
        num = random.randint(10, 999)
        
        style = random.choice([1, 2, 3])
        if style == 1:
            u = f"{fn}{ln[:4]}{num}"
        elif style == 2:
            u = f"{fn[:5]}{ln[:5]}{num}"
        else:
            u = f"{fn}{kw}{num}"
        
        u = re.sub(r'[^a-z0-9]', '', u.lower())
        if 4 <= len(u) <= 15:
            return u


def generate_random_string(length=8):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=length))

def generate_secure_password(length=12):
    chars = string.ascii_letters + string.digits
    return "Pass" + ''.join(random.choices(chars, k=length - 4))

def get_main_reply_keyboard(lang: str = "bn", user_id: int = None):
    b = lambda key: get_string(lang, key)
    rows = [
        [KeyboardButton(b("btn_create_custom"), api_kwargs={"style": "primary"})],
        [KeyboardButton(b("btn_create_random"), api_kwargs={"style": "success"})],
        [KeyboardButton(b("btn_2fa"), api_kwargs={"style": "primary"})],
        [KeyboardButton(b("btn_saved_mails"), api_kwargs={"style": "primary"}), KeyboardButton(b("btn_current_inbox"), api_kwargs={"style": "success"})],
        [KeyboardButton(b("btn_export_txt"), api_kwargs={"style": "primary"}), KeyboardButton(b("btn_login"), api_kwargs={"style": "primary"})],
        [KeyboardButton(b("btn_lang"), api_kwargs={"style": "primary"}), KeyboardButton(b("btn_profile"), api_kwargs={"style": "primary"}), KeyboardButton(b("btn_help"), api_kwargs={"style": "primary"})]
    ]
    if user_id and int(user_id) == ADMIN_ID:
        rows.append([KeyboardButton(b("btn_admin"), api_kwargs={"style": "danger"})])
    return ReplyKeyboardMarkup(rows, resize_keyboard=True)


def get_admin_reply_keyboard(lang: str = "bn"):
    rows = [
        [KeyboardButton("📊 Live Stats", api_kwargs={"style": "primary"}), KeyboardButton("📄 Export Users List", api_kwargs={"style": "primary"})],
        [KeyboardButton("🚫 Ban User", api_kwargs={"style": "danger"}), KeyboardButton("📋 Banned Users", api_kwargs={"style": "danger"})],
        [KeyboardButton("💳 Pending Payments", api_kwargs={"style": "success"}), KeyboardButton("📢 Broadcast", api_kwargs={"style": "primary"})],
        [KeyboardButton("👑 Toggle VIP", api_kwargs={"style": "success"}), KeyboardButton("💾 DB Backup", api_kwargs={"style": "primary"})],
        [KeyboardButton("🔙 Back to User Menu", api_kwargs={"style": "primary"})]
    ]
    return ReplyKeyboardMarkup(rows, resize_keyboard=True)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await db.register_user(user.id, user.username, user.first_name)
    lang = await db.get_user_language(user.id)
    if await db.is_user_banned(user.id):
        await update.message.reply_text(get_string(lang, "user_banned_notice"), parse_mode="HTML")
        return

    welcome_text = get_string(lang, "welcome", name=safe_html(user.first_name))
    await update.message.reply_text(
        welcome_text,
        parse_mode="HTML",
        reply_markup=get_main_reply_keyboard(lang, user.id)
    )

async def create_new_mail(update: Update, context: ContextTypes.DEFAULT_TYPE, custom_name: str = None):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    
    msg = None
    if update.callback_query:
        await update.callback_query.answer(get_string(lang, "creating_mail_toast"), show_alert=False)
    elif update.message:
        msg = await update.message.reply_text(get_string(lang, "creating_mail"), parse_mode="HTML")

    try:
        domains = await mail_api.get_domains()
        if not domains:
            err_msg = "❌ No active domains found."
            if msg: await msg.edit_text(err_msg)
            else: await context.bot.send_message(chat_id=user_id, text=err_msg)
            return

        selected_domain = domains[0]
        if custom_name:
            clean_name = re.sub(r'[^a-z0-9]', '', custom_name).lower()[:15]
            if len(clean_name) < 3:
                clean_name = f"{clean_name}{generate_random_string(4)}"
            full_email = f"{clean_name}@{selected_domain}"

        else:
            random_username = generate_professional_username()
            full_email = f"{random_username}@{selected_domain}"
            
        password = generate_secure_password(12)

        acc_data = await mail_api.create_account(full_email, password)
        account_id = acc_data.get("id", "")
        token = await mail_api.get_token(full_email, password)

        await db.save_account(
            telegram_id=user_id,
            email=full_email,
            password=password,
            token=token,
            account_id=account_id
        )

        response_text = get_string(lang, "mail_created_success", email=safe_html(full_email), password=safe_html(password))

        keyboard = [
            [
                InlineKeyboardButton("📥 Check Inbox", callback_data=f"inbox:{full_email}", api_kwargs={"style": "success"}),
                InlineKeyboardButton("🗂 Saved Mails", callback_data="list_saved", api_kwargs={"style": "primary"})
            ],
            [
                InlineKeyboardButton("🗑️ Delete Email", callback_data=f"del_acc:{full_email}", api_kwargs={"style": "danger"})
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        if msg:
            await msg.edit_text(response_text, parse_mode="HTML", reply_markup=reply_markup)
        else:
            await context.bot.send_message(chat_id=user_id, text=response_text, parse_mode="HTML", reply_markup=reply_markup)

    except Exception as e:
        logger.error(f"Error creating mail: {e}")
        if msg:
            await msg.edit_text(f"❌ Error: {safe_html(str(e))}")

async def start_custom_name_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_custom_name")
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_CUSTOM_NAME

async def process_custom_name_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    custom_name = update.message.text.strip()
    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help)', custom_name) or custom_name.startswith("/"):
        return await cancel_and_route_menu(update, context)
    await create_new_mail(update, context, custom_name=custom_name)
    return ConversationHandler.END

async def list_saved_mails(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    accounts = await db.get_user_accounts(user_id)
    active_acc = await db.get_active_account(user_id)
    active_email = active_acc["email"] if active_acc else None

    if not accounts:
        text = get_string(lang, "no_saved_mails")
        keyboard = [[InlineKeyboardButton("🚀 ➕ Create Random Mail", callback_data="cmd_create", api_kwargs={"style": "success"})]]
        reply_markup = InlineKeyboardMarkup(keyboard)
    else:
        text = get_string(lang, "saved_mails_title")
        keyboard = []
        for acc in accounts:
            email = acc["email"]
            exp_status, exp_dt = db.check_account_expiry_status(acc)
            if exp_status == "expired":
                status_badge = "[🔒 Expired]"
                status_text = "🔒 (Expired - Locked)"
            elif exp_status == "overdue_delete":
                status_badge = "[🗑️ Overdue]"
                status_text = "🗑️ (Overdue)"
            elif email == active_email:
                status_badge = "[🟢 Active]"
                status_text = "🟢 (Active)"
            else:
                status_badge = ""
                status_text = ""

            text += f"• <code>{safe_html(email)}</code> {status_text}\n"
            btn_label = f"📧 {email} {status_badge}".strip()
            style_type = "danger" if exp_status in ("expired", "overdue_delete") else ("success" if email == active_email else "primary")
            keyboard.append([InlineKeyboardButton(btn_label, callback_data=f"switch:{email}", api_kwargs={"style": style_type})])
        
        keyboard.append([
            InlineKeyboardButton("⚡ Create New", callback_data="cmd_create", api_kwargs={"style": "success"}),
            InlineKeyboardButton("🔐 Login Existing", callback_data="login_prompt", api_kwargs={"style": "primary"})
        ])
        keyboard.append([
            InlineKeyboardButton("🗑️ Delete All Accounts", callback_data="confirm_del_all", api_kwargs={"style": "danger"})
        ])
        keyboard.append([
            InlineKeyboardButton("🔙 Back to Main Menu", callback_data="back_main", api_kwargs={"style": "primary"})
        ])
        reply_markup = InlineKeyboardMarkup(keyboard)

    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=reply_markup)
    elif update.message:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=reply_markup)

async def switch_account_and_view_inbox(update: Update, context: ContextTypes.DEFAULT_TYPE, target_email: str):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    query = update.callback_query

    await db.set_active_account(user_id, target_email)
    acc = await db.get_account(user_id, target_email)

    if not acc:
        if query: await query.answer("Account not found!", show_alert=True)
        return

    # Check expiry status
    exp_status, exp_dt = db.check_account_expiry_status(acc)
    if exp_status == "overdue_delete":
        # Over 5 days late past expiry -> Delete permanently from DB & Supabase!
        await db.delete_saved_account(user_id, target_email)
        if acc.get("token") and acc.get("account_id"):
            try:
                await mail_api.delete_account(acc["token"], acc["account_id"])
            except Exception:
                pass
        
        del_msg = get_string(lang, "email_overdue_deleted_notice", email=safe_html(target_email))
        if query:
            await query.answer("🗑️ Email permanently deleted due to 5 days overdue payment!", show_alert=True)
            await query.message.reply_text(del_msg, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))
        else:
            await update.message.reply_text(del_msg, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))
        return

    elif exp_status == "expired":
        # Expired (within 5 days grace period) -> Lock inbox & hide messages!
        exp_str = exp_dt.strftime("%Y-%m-%d %H:%M:%S") if exp_dt else "N/A"
        lock_msg = get_string(lang, "email_expired_locked_notice", expires_at=exp_str)
        kb = [
            [InlineKeyboardButton("🎁 Renew / Extend 2 Months", callback_data=f"extend_mail:{target_email}", api_kwargs={"style": "success"})],
            [InlineKeyboardButton("🗂 Saved Mails", callback_data="list_saved", api_kwargs={"style": "primary"})],
            [InlineKeyboardButton("🗑️ Delete Email", callback_data=f"del_acc:{target_email}", api_kwargs={"style": "danger"})]
        ]
        if query:
            await query.answer("🔒 Inbox locked! Please extend validity to view messages.", show_alert=True)
            await query.message.reply_text(lock_msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
        else:
            await update.message.reply_text(lock_msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
        return

    token = acc.get("token")
    if not token:
        try:
            token = await mail_api.get_token(acc["email"], acc["password"])
            await db.update_account_token(user_id, acc["email"], token)
        except Exception:
            if query: await query.answer("Login failed!", show_alert=True)
            return

    try:
        messages = await mail_api.get_messages(token)
    except Exception as e:
        if str(e) == "UNAUTHORIZED":
            try:
                token = await mail_api.get_token(acc["email"], acc["password"])
                await db.update_account_token(user_id, acc["email"], token)
                messages = await mail_api.get_messages(token)
            except Exception:
                if query: await query.answer("Session expired!", show_alert=True)
                return
        else:
            messages = []

    if messages:
        await db.update_last_msg_id(user_id, target_email, messages[0].get("id"))

    if not messages:
        text = get_string(lang, "inbox_empty", email=safe_html(target_email))
        keyboard = [
            [
                InlineKeyboardButton("🔄 Refresh Inbox", callback_data=f"inbox:{target_email}", api_kwargs={"style": "success"}),
                InlineKeyboardButton("🎁 Extend 2 Months", callback_data=f"extend_mail:{target_email}", api_kwargs={"style": "primary"})
            ],
            [
                InlineKeyboardButton("🔑 Credentials", callback_data=f"show_creds:{target_email}", api_kwargs={"style": "primary"}),
                InlineKeyboardButton("🗂 Saved Mails", callback_data="list_saved", api_kwargs={"style": "primary"})
            ],
            [
                InlineKeyboardButton("🗑️ Delete Email", callback_data=f"del_acc:{target_email}", api_kwargs={"style": "danger"})
            ]
        ]
    else:
        text = get_string(lang, "inbox_title", email=safe_html(target_email), count=len(messages))
        keyboard = []
        for idx, m in enumerate(messages[:10], start=1):
            subject = m.get("subject", "No Subject")
            sender = m.get("from", {}).get("address", "Unknown Sender")
            created_at = m.get("createdAt", "")[:16].replace("T", " ")
            intro_preview = m.get("intro", "")
            msg_id = m.get("id")

            text += f"<b>{idx}.</b> 📩 <code>{safe_html(subject)}</code>\n"
            text += f"   👤 From: <code>{safe_html(sender)}</code> ({created_at})\n"

            # Check if OTP can be extracted from preview intro!
            preview_otps = email_parser.extract_otp_codes(intro_preview or subject)
            if preview_otps:
                otp_code = preview_otps[0]
                text += f"   ⚡ OTP: <code>{otp_code}</code>\n\n"
                keyboard.append([
                    InlineKeyboardButton(f"📖 #{idx} {subject[:18]}", callback_data=f"read:{target_email}:{msg_id}", api_kwargs={"style": "primary"}),
                    InlineKeyboardButton(f"📋 {otp_code}", api_kwargs={"copy_text": {"text": otp_code}, "style": "success"})
                ])
            else:
                text += "\n"
                button_label = f"📖 #{idx} {subject[:28]}"
                keyboard.append([InlineKeyboardButton(button_label, callback_data=f"read:{target_email}:{msg_id}", api_kwargs={"style": "primary"})])

        keyboard.append([
            InlineKeyboardButton("🔄 Refresh Inbox", callback_data=f"inbox:{target_email}", api_kwargs={"style": "success"}),
            InlineKeyboardButton("🎁 Extend 2 Months", callback_data=f"extend_mail:{target_email}", api_kwargs={"style": "primary"})
        ])
        keyboard.append([
            InlineKeyboardButton("🔑 Credentials", callback_data=f"show_creds:{target_email}", api_kwargs={"style": "primary"}),
            InlineKeyboardButton("🗂 Saved Mails", callback_data="list_saved", api_kwargs={"style": "primary"})
        ])
        keyboard.append([
            InlineKeyboardButton("🗑️ Delete Email", callback_data=f"del_acc:{target_email}", api_kwargs={"style": "danger"})
        ])

    reply_markup = InlineKeyboardMarkup(keyboard)
    if query:
        await query.answer()
        await query.message.edit_text(text, parse_mode="HTML", reply_markup=reply_markup)
    elif update.message:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=reply_markup)

async def read_full_message(update: Update, context: ContextTypes.DEFAULT_TYPE, email: str, msg_id: str):
    user_id = update.effective_user.id
    query = update.callback_query

    acc = await db.get_account(user_id, email)
    if not acc or not acc.get("token"):
        if query: await query.answer("Session error!", show_alert=True)
        return

    exp_status, exp_dt = db.check_account_expiry_status(acc)
    if exp_status != "active":
        if query: await query.answer("🔒 Message locked! Renew email validity to read messages.", show_alert=True)
        return

    await query.answer("Loading message...")

    try:
        msg_detail = await mail_api.get_message_detail(acc["token"], msg_id)
    except Exception as e:
        await query.message.edit_text(f"❌ Load error: {safe_html(str(e))}")
        return

    subject = msg_detail.get("subject", "No Subject")
    sender = msg_detail.get("from", {}).get("address", "Unknown")
    date_str = msg_detail.get("createdAt", "")[:19].replace("T", " ")
    
    intro_text = msg_detail.get("text", "")
    html_list = msg_detail.get("html", [])
    html_content = html_list[0] if html_list else ""
    
    clean_body = intro_text if intro_text else email_parser.clean_html_body(html_content)
    if not clean_body:
        clean_body = "(Empty Message Body)"

    display_body = clean_body[:2500] + ("...\n(Truncated)" if len(clean_body) > 2500 else "")

    otps = email_parser.extract_otp_codes(clean_body)
    urls = email_parser.extract_urls(clean_body if not html_content else html_content)

    formatted_text = (
        f"📖 <b>Email Details</b>\n\n"
        f"<blockquote>📌 <b>Subject:</b> <b>{safe_html(subject)}</b>\n"
        f"👤 <b>From:</b> <code>{safe_html(sender)}</code>\n"
        f"🕒 <b>Date:</b> <code>{safe_html(date_str)}</code></blockquote>\n\n"
        f"━━━━━━━━━━━━ <b>MESSAGE BODY</b> ━━━━━━━━━━━━\n"
        f"<blockquote>{safe_html(display_body)}</blockquote>\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
    )

    if otps:
        formatted_text += "⚡ <b>Extracted Verification / OTP Codes:</b>\n"
        for code in otps:
            formatted_text += f"🔑 <code>{safe_html(code)}</code> <i>(1-Tap Copy)</i>\n"
        formatted_text += "\n"

    if urls:
        formatted_text += "🔗 <b>Extracted Links:</b>\n"
        for u in urls:
            formatted_text += f"• {safe_html(u)}\n"

    keyboard = []
    if otps:
        keyboard.append([InlineKeyboardButton(f"📋 {otps[0]}", api_kwargs={"copy_text": {"text": otps[0]}, "style": "success"})])
    
    keyboard.append([
        InlineKeyboardButton("🔙 Back to Inbox", callback_data=f"inbox:{email}", api_kwargs={"style": "primary"}),
        InlineKeyboardButton("🗑️ Delete Msg", callback_data=f"del_msg:{email}:{msg_id}", api_kwargs={"style": "danger"})
    ])
    reply_markup = InlineKeyboardMarkup(keyboard)

    try:
        await query.message.edit_text(
            formatted_text,
            parse_mode="HTML",
            reply_markup=reply_markup,
            disable_web_page_preview=True
        )
    except Exception as e:
        logger.warning(f"HTML fallback used: {e}")
        plain_text = (
            f"📖 Email Details\n\n"
            f"Subject: {subject}\n"
            f"From: {sender}\n"
            f"Date: {date_str}\n\n"
            f"--- FULL BODY ---\n"
            f"{display_body}\n"
            f"-----------------\n\n"
        )
        if otps:
            plain_text += f"OTP Code: {', '.join(otps)}\n"
        if urls:
            plain_text += f"Links: {', '.join(urls)}\n"
            
        await query.message.edit_text(
            plain_text[:4000],
            parse_mode=None,
            reply_markup=reply_markup,
            disable_web_page_preview=True
        )

async def current_inbox_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    active_acc = await db.get_active_account(user_id)

    if not active_acc:
        await update.message.reply_text(
            get_string(lang, "no_saved_mails"),
            parse_mode="HTML",
            reply_markup=get_main_reply_keyboard(lang)
        )
        return

    await switch_account_and_view_inbox(update, context, active_acc["email"])

async def export_txt_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    accounts = await db.get_user_accounts(user_id)

    if not accounts:
        await update.message.reply_text("❌ No saved email accounts found to export.")
        return

    txt_content = "========================================\n"
    txt_content += "     MAIL.TM SAVED EMAIL ACCOUNTS\n"
    txt_content += "========================================\n\n"

    for idx, acc in enumerate(accounts, start=1):
        txt_content += f"{idx}. EMAIL: {acc['email']}\n"
        txt_content += f"   PASSWORD: {acc['password']}\n"
        txt_content += f"   CREATED AT: {acc.get('created_at', 'N/A')}\n"
        txt_content += "----------------------------------------\n"

    txt_bytes = io.BytesIO(txt_content.encode("utf-8"))
    txt_bytes.name = f"my_temp_mails_{user_id}.txt"

    await update.message.reply_document(
        document=InputFile(txt_bytes, filename=f"my_temp_mails_{user_id}.txt"),
        caption="📁 <b>Your exported temp email accounts & passwords file.</b>",
        parse_mode="HTML"
    )

async def toggle_language(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    current_lang = await db.get_user_language(user_id)
    new_lang = "en" if current_lang == "bn" else "bn"
    await db.set_user_language(user_id, new_lang)
    
    text = get_string(new_lang, "lang_switched")
    await update.message.reply_text(
        text,
        parse_mode="HTML",
        reply_markup=get_main_reply_keyboard(new_lang)
    )

async def my_profile_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user = update.effective_user
    lang = await db.get_user_language(user_id)
    
    u_details = await db.get_user_details(user_id)
    u_accounts = await db.get_user_accounts(user_id)
    u_claims = await db.get_user_payment_claims(user_id)

    joined_date = u_details.get("created_at", "N/A")[:10] if (u_details and u_details.get("created_at")) else "N/A"
    is_vip = u_details.get("is_vip", 0) == 1 if u_details else False
    user_status = "👑 VIP Member" if is_vip else "⭐ Standard Member"
    uname = f"@{user.username}" if (user and user.username) else safe_html(user.first_name if user else "User")

    total_mails = len(u_accounts)
    active_mails = 0
    expired_mails = 0

    for acc in u_accounts:
        st, _ = db.check_account_expiry_status(acc)
        if st == "active":
            active_mails += 1
        else:
            expired_mails += 1

    # Format claims history
    history_text = ""
    if u_claims:
        for idx, c in enumerate(u_claims[:5], start=1):
            c_amount = c.get("amount", 10)
            c_trx = safe_html(c.get("trx_id", "N/A"))
            c_status = c.get("status", "PENDING")
            
            if c_status == "APPROVED":
                status_icon = "✅ Approved"
            elif c_status == "REJECTED":
                status_icon = "❌ Rejected"
            elif c_status == "CANCELLED_BY_USER":
                status_icon = "🚫 Cancelled"
            else:
                status_icon = "⏳ Pending"
            
            history_text += f"  {idx}. <code>{c_trx}</code> | 💰 {c_amount} TK | {status_icon}\n"
    else:
        history_text = "  <i>(কোনো সাম্প্রতিক পেমেন্ট দাবি নেই / No recent claims)</i>\n"

    if lang == "bn":
        profile_msg = (
            f"👤 <b>আপনার ইউজার প্রোফাইল ও পেমেন্ট হিস্ট্রি</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
            f"<blockquote>👤 <b>User:</b> {uname} (ID: <code>{user_id}</code>)\n"
            f"🏅 <b>Status:</b> <b>{user_status}</b>\n"
            f"📅 <b>যোগদানের তারিখ:</b> <code>{joined_date}</code></blockquote>\n\n"
            f"📊 <b>ইমেইল অ্যাকাউন্ট পরিসংখ্যান:</b>\n"
            f"<blockquote>📧 <b>মোট ইমেইল:</b> <code>{total_mails}</code> টি\n"
            f"🟢 <b>সচল (Active):</b> <code>{active_mails}</code> টি\n"
            f"🔒 <b>মেয়াদ উত্তীর্ণ (Expired):</b> <code>{expired_mails}</code> টি</blockquote>\n\n"
            f"💳 <b>সাম্প্রতিক পেমেন্ট দাবি (TrxID History):</b>\n"
            f"<blockquote>{history_text}</blockquote>"
        )
    else:
        profile_msg = (
            f"👤 <b>Your Profile & Payment History</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
            f"<blockquote>👤 <b>User:</b> {uname} (ID: <code>{user_id}</code>)\n"
            f"🏅 <b>Status:</b> <b>{user_status}</b>\n"
            f"📅 <b>Joined Date:</b> <code>{joined_date}</code></blockquote>\n\n"
            f"📊 <b>Email Account Statistics:</b>\n"
            f"<blockquote>📧 <b>Total Emails:</b> <code>{total_mails}</code>\n"
            f"🟢 <b>Active:</b> <code>{active_mails}</code>\n"
            f"🔒 <b>Expired:</b> <code>{expired_mails}</code></blockquote>\n\n"
            f"💳 <b>Recent Payment Claims (TrxID History):</b>\n"
            f"<blockquote>{history_text}</blockquote>"
        )

    kb = [
        [InlineKeyboardButton("🗂 View Saved Mails", callback_data="list_saved", api_kwargs={"style": "success"})],
        [InlineKeyboardButton("🔙 Back to Main Menu", callback_data="back_main", api_kwargs={"style": "primary"})]
    ]

    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(profile_msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(profile_msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))

async def admin_broadcast_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return

    if not context.args:
        await update.message.reply_text("❌ Usage: `/broadcast <your announcement message>`", parse_mode="Markdown")
        return

    broadcast_text = " ".join(context.args)
    users = await db.get_all_users()
    
    success_count = 0
    failed_count = 0
    await update.message.reply_text(f"📢 Starting broadcast to {len(users)} users...")

    for u_id in users:
        try:
            await context.bot.send_message(
                chat_id=u_id,
                text=f"📢 <b>Announcement from Admin:</b>\n\n{safe_html(broadcast_text)}",
                parse_mode="HTML"
            )
            success_count += 1
            await asyncio.sleep(0.05)
        except Exception:
            failed_count += 1

    await update.message.reply_text(
        f"✅ Broadcast Completed!\n"
        f"• Delivered: {success_count}\n"
        f"• Failed/Blocked: {failed_count}"
    )

async def admin_backup_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return

    if os.path.exists(DB_PATH):
        with open(DB_PATH, "rb") as f:
            await update.message.reply_document(
                document=InputFile(f, filename="mail_bot_backup.db"),
                caption="💾 <b>Database Backup File</b>",
                parse_mode="HTML"
            )
    else:
        await update.message.reply_text("❌ Database file not found.")

async def admin_panel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "admin_panel_title")
    reply_markup = get_admin_reply_keyboard(lang)
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(text, parse_mode="HTML", reply_markup=reply_markup)
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=reply_markup)

async def admin_export_users_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return
    
    query = update.callback_query
    if query:
        await query.answer("Generating users list...", show_alert=False)

    users = await db.get_all_users_for_export()
    
    content = "=====================================================\n"
    content += "           TEMP MAIL BOT - ALL USERS LIST           \n"
    content += "=====================================================\n\n"
    content += f"Total Registered Users: {len(users)}\n"
    content += "-" * 75 + "\n"
    content += f"{'Telegram ID':<15} | {'Username':<20} | {'First Name':<20} | {'Status':<10}\n"
    content += "-" * 75 + "\n"

    for u in users:
        t_id = str(u.get("telegram_id", ""))
        uname = f"@{u.get('username')}" if u.get('username') else "No Username"
        fname = (u.get("first_name") or "N/A")[:18]
        status = "BANNED" if u.get("is_banned") == 1 else ("VIP" if u.get("is_vip") == 1 else "Active")
        content += f"{t_id:<15} | {uname:<20} | {fname:<20} | {status:<10}\n"

    file_bytes = content.encode("utf-8")
    bio = io.BytesIO(file_bytes)
    bio.name = "bot_users_list.txt"

    await context.bot.send_document(
        chat_id=user_id,
        document=InputFile(bio, filename="bot_users_list.txt"),
        caption=f"📄 <b>Total Users Export File</b>\nTotal Users: <b>{len(users)}</b>",
        parse_mode="HTML"
    )

async def admin_stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID and (update.callback_query is None or update.effective_user.id != ADMIN_ID):
        return

    lang = await db.get_user_language(user_id)
    stats = await db.get_admin_stats()
    text = get_string(
        lang,
        "admin_stats_text",
        total_users=stats["total_users"],
        new_users_today=stats["new_users_today"],
        total_accounts=stats["total_accounts"],
        today_accounts=stats.get("today_accounts", 0),
        banned_users=stats["banned_users"],
        vip_users=stats["vip_users"]
    )
    keyboard = [[InlineKeyboardButton("🔙 Back to Admin Panel", callback_data="admin_panel", api_kwargs={"style": "primary"})]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=reply_markup)
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=reply_markup)

async def show_banned_list_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return
    
    lang = await db.get_user_language(user_id)
    query = update.callback_query
    if query:
        await query.answer()

    banned_users = await db.get_banned_users_list()

    if not banned_users:
        text = get_string(lang, "no_banned_users")
        keyboard = [[InlineKeyboardButton("🔙 Back to Admin Panel", callback_data="admin_panel", api_kwargs={"style": "primary"})]]
        reply_markup = InlineKeyboardMarkup(keyboard)
    else:
        text = get_string(lang, "ban_list_title")
        keyboard = []
        for u in banned_users:
            u_id = u["telegram_id"]
            uname = f"@{u['username']}" if u.get("username") else f"ID: {u_id}"
            btn_label = f"🔓 Unban {uname}"
            keyboard.append([InlineKeyboardButton(btn_label, callback_data=f"do_unban:{u_id}", api_kwargs={"style": "danger"})])
        
        keyboard.append([InlineKeyboardButton("🔙 Back to Admin Panel", callback_data="admin_panel", api_kwargs={"style": "primary"})])
        reply_markup = InlineKeyboardMarkup(keyboard)

    if query:
        await query.message.edit_text(text, parse_mode="HTML", reply_markup=reply_markup)
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=reply_markup)

async def start_ban_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_ban")
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_BAN_ID

async def process_ban_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw_text = update.message.text.strip()
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END
    lang = await db.get_user_language(user_id)

    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin)', raw_text) or raw_text.startswith("/"):
        return await cancel_and_route_menu(update, context)

    target_user = await db.find_user_by_identifier(raw_text)
    if not target_user:
        await update.message.reply_text(get_string(lang, "user_not_found"), parse_mode="HTML")
        return WAITING_FOR_BAN_ID

    target_id = target_user["telegram_id"]
    uname = f"@{target_user['username']}" if target_user.get("username") else f"ID: {target_id}"
    await db.set_user_ban_status(target_id, True)

    succ_msg = get_string(lang, "banned_success", user_info=safe_html(uname))
    await update.message.reply_text(succ_msg, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))
    return ConversationHandler.END

async def start_unban_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_unban")
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_UNBAN_ID

async def process_unban_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw_text = update.message.text.strip()
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END
    lang = await db.get_user_language(user_id)

    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin)', raw_text) or raw_text.startswith("/"):
        return await cancel_and_route_menu(update, context)

    target_user = await db.find_user_by_identifier(raw_text)
    if not target_user:
        await update.message.reply_text(get_string(lang, "user_not_found"), parse_mode="HTML")
        return WAITING_FOR_UNBAN_ID

    target_id = target_user["telegram_id"]
    uname = f"@{target_user['username']}" if target_user.get("username") else f"ID: {target_id}"
    await db.set_user_ban_status(target_id, False)

    succ_msg = get_string(lang, "unbanned_success", user_info=safe_html(uname))
    await update.message.reply_text(succ_msg, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))
    return ConversationHandler.END

async def start_vip_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_vip")
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_VIP_ID

async def process_vip_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw_text = update.message.text.strip()
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END
    lang = await db.get_user_language(user_id)

    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin)', raw_text) or raw_text.startswith("/"):
        return await cancel_and_route_menu(update, context)

    target_user = await db.find_user_by_identifier(raw_text)
    if not target_user:
        await update.message.reply_text(get_string(lang, "user_not_found"), parse_mode="HTML")
        return WAITING_FOR_VIP_ID

    target_id = target_user["telegram_id"]
    uname = f"@{target_user['username']}" if target_user.get("username") else f"ID: {target_id}"
    new_status = await db.toggle_user_vip(target_id)
    status_text = "VIP Member" if new_status else "Regular Member"

    succ_msg = get_string(lang, "vip_toggled_success", user_info=safe_html(uname), status=status_text)
    await update.message.reply_text(succ_msg, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))
    return ConversationHandler.END

async def start_payment_submission_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if not query:
        return ConversationHandler.END
    
    parts = query.data.split(":", 1)
    target_email = parts[1] if len(parts) > 1 else ""
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    
    user_accs = await db.get_user_accounts(user_id)
    acc_count = len(user_accs)
    amount = 12 if acc_count > 1 else 10
    if acc_count > 1:
        target_email = "ALL"

    context.user_data["pay_target_email"] = target_email
    context.user_data["pay_amount"] = amount

    text = get_string(lang, "prompt_sender_number", amount=amount)
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    await query.answer()
    await query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_SENDER_NUMBER

async def process_sender_number_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    sender_number = update.message.text.strip()
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)

    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin)', sender_number) or sender_number.startswith("/"):
        return await cancel_and_route_menu(update, context)

    context.user_data["pay_sender_number"] = sender_number
    text = get_string(lang, "prompt_trx_id")
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_TRX_ID

async def process_trx_id_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    trx_id = update.message.text.strip()
    user_id = update.effective_user.id
    user = update.effective_user
    lang = await db.get_user_language(user_id)

    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin)', trx_id) or trx_id.startswith("/"):
        return await cancel_and_route_menu(update, context)

    target_email = context.user_data.get("pay_target_email", "")
    sender_number = context.user_data.get("pay_sender_number", "")
    amount = context.user_data.get("pay_amount", 10)

    claim_id = await db.create_payment_claim(user_id, target_email, sender_number, trx_id, amount=amount)

    succ_text = get_string(lang, "payment_submitted_success", email=safe_html(target_email), sender_number=safe_html(sender_number), trx_id=safe_html(trx_id), amount=amount)
    await update.message.reply_text(succ_text, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))

    # Send immediate notification to ADMIN
    uname = f"@{user.username}" if user.username else safe_html(user.first_name)
    admin_alert = get_string(
        "bn",
        "admin_new_claim_alert",
        user_info=uname,
        user_id=user_id,
        email=safe_html(target_email),
        sender_number=safe_html(sender_number),
        trx_id=safe_html(trx_id),
        amount=amount
    )
    admin_kb = [
        [
            InlineKeyboardButton(f"✅ Approve ({amount} TK - +2M)", callback_data=f"approve_pay:{claim_id}", api_kwargs={"style": "success"}),
            InlineKeyboardButton("❌ Reject Claim", callback_data=f"reject_pay:{claim_id}", api_kwargs={"style": "danger"})
        ]
    ]
    try:
        await context.bot.send_message(chat_id=ADMIN_ID, text=admin_alert, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(admin_kb))
    except Exception as e:
        logger.error(f"Failed to alert admin about payment claim: {e}")

    return ConversationHandler.END

async def start_broadcast_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END

    lang = await db.get_user_language(user_id)
    text = (
        "📢 <b>ব্রডকাস্ট মেসেজ পাঠাতে টাইপ করুন / মিডিয়ায় পাঠান</b>\n"
        "━━━━━━━━━━━━━━━━━━━━━━\n\n"
        "<blockquote>বটের সকল সক্রিয় ইউজারদের কাছে যেই নোটিফিকেশন পাঠাতে চান সেটি লিখুন বা কোনো ছবি/ডকুমেন্ট পাঠাইয়া দিন।\n"
        "<i>(এইচটিএমএল ফরম্যাটিং, ছবি ও টেক্সট গ্রহণযোগ্য)</i></blockquote>\n\n"
        "🚫 বাতিল করতে /cancel টাইপ করুন।"
    )
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_BROADCAST_CONTENT

async def process_broadcast_content(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return ConversationHandler.END

    msg = update.message
    if msg.text and (re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin)', msg.text) or msg.text.startswith("/")):
        return await cancel_and_route_menu(update, context)

    users = await db.get_all_users()
    total_users = len(users)

    status_msg = await update.message.reply_text(f"📢 <b>সকল {total_users}জন ইউজারের কাছে ব্রডকাস্ট পাঠানো হচ্ছে...</b>\n<i>অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।</i>", parse_mode="HTML")

    success_count = 0
    failed_count = 0

    for u_id in users:
        try:
            if msg.text:
                await context.bot.send_message(chat_id=u_id, text=msg.text, parse_mode="HTML", disable_web_page_preview=True)
            else:
                await context.bot.copy_message(chat_id=u_id, from_chat_id=msg.chat_id, message_id=msg.message_id)
            success_count += 1
            await asyncio.sleep(0.05)
        except Exception:
            failed_count += 1


    report_text = (
        f"🎉 <b>ব্রডকাস্ট সফলভাবে সম্পন্ন হয়েছে!</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"<blockquote>👥 <b>মোট ইউজার:</b> <code>{total_users}</code>\n"
        f"🟢 <b>সফলভাবে ডেলিভার্ড:</b> <code>{success_count}</code>\n"
        f"🔴 <b>ব্যর্থ/ব্লকড:</b> <code>{failed_count}</code></blockquote>"
    )
    await status_msg.edit_text(report_text, parse_mode="HTML")
    return ConversationHandler.END

async def admin_pending_payments_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return
    query = update.callback_query
    if query:
        await query.answer()

    claims = await db.get_pending_payment_claims()
    if not claims:
        text = "🎉 <b>No pending payment claims found!</b>"
        kb = [[InlineKeyboardButton("🔙 Back to Admin Panel", callback_data="admin_panel", api_kwargs={"style": "primary"})]]
        if query: await query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
        else: await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
        return

    text = f"💳 <b>Pending Payment Claims ({len(claims)} total):</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n"
    keyboard = []
    for c in claims[:10]:
        c_id = c["id"]
        u_id = c["telegram_id"]
        email = c["email"]
        num = c["sender_number"]
        trx = c["trx_id"]

        text += f"• <b>Claim #{c_id}</b> | User ID: <code>{u_id}</code>\n"
        text += f"  📧 Email: <code>{safe_html(email)}</code>\n"
        text += f"  📱 Sender Number: <code>{safe_html(num)}</code> | TrxID: <code>{safe_html(trx)}</code>\n\n"

        keyboard.append([
            InlineKeyboardButton(f"✅ Approve #{c_id}", callback_data=f"approve_pay:{c_id}", api_kwargs={"style": "success"}),
            InlineKeyboardButton(f"❌ Reject #{c_id}", callback_data=f"reject_pay:{c_id}", api_kwargs={"style": "danger"})
        ])
    
    keyboard.append([InlineKeyboardButton("🔙 Back to Admin Panel", callback_data="admin_panel", api_kwargs={"style": "primary"})])
    reply_markup = InlineKeyboardMarkup(keyboard)

    if query:
        await query.message.edit_text(text, parse_mode="HTML", reply_markup=reply_markup)
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=reply_markup)

async def approve_payment_callback(update: Update, context: ContextTypes.DEFAULT_TYPE, claim_id: int):
    query = update.callback_query
    success, claim = await db.approve_payment_claim(claim_id)
    if not success or not claim:
        if query: await query.answer("Claim not found or already processed!", show_alert=True)
        return

    if query:
        await query.answer("✅ Payment Approved & Extended +2 Months!", show_alert=True)
        try:
            await query.message.edit_text(
                f"✅ <b>Claim #{claim_id} Approved!</b>\n"
                f"📧 Email: <code>{safe_html(claim['email'])}</code>\n"
                f"👤 User ID: <code>{claim['telegram_id']}</code>\n"
                f"⏳ Validity extended for +2 Months (60 days)!",
                parse_mode="HTML"
            )
        except Exception:
            pass

    # Send push notification to user
    try:
        user_id = claim["telegram_id"]
        lang = await db.get_user_language(user_id)
        amount = claim.get("amount", 10)
        target_email = claim["email"]
        display_email = "All Mails (Combo)" if target_email == "ALL" else safe_html(target_email)
        user_msg = get_string(lang, "user_payment_approved_notice", email=display_email, amount=amount)
        cb_data = "list_saved" if target_email == "ALL" else f"inbox:{target_email}"
        kb = [[InlineKeyboardButton("📥 Check Inbox / Saved Mails", callback_data=cb_data, api_kwargs={"style": "success"})]]
        await context.bot.send_message(chat_id=user_id, text=user_msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    except Exception as e:
        logger.error(f"Failed to send approval notice to user: {e}")

async def reject_payment_callback(update: Update, context: ContextTypes.DEFAULT_TYPE, claim_id: int):
    query = update.callback_query
    success, claim = await db.reject_payment_claim(claim_id)
    if not success or not claim:
        if query: await query.answer("Claim not found or already processed!", show_alert=True)
        return

    if query:
        await query.answer("❌ Claim Rejected!", show_alert=True)
        try:
            await query.message.edit_text(
                f"❌ <b>Claim #{claim_id} Rejected!</b>\n"
                f"📧 Email: <code>{safe_html(claim['email'])}</code>\n"
                f"👤 User ID: <code>{claim['telegram_id']}</code>",
                parse_mode="HTML"
            )
        except Exception:
            pass

    # Send push notification to user
    try:
        user_id = claim["telegram_id"]
        lang = await db.get_user_language(user_id)
        user_msg = get_string(lang, "user_payment_rejected_notice", email=safe_html(claim["email"]), trx_id=safe_html(claim.get("trx_id", "")))
        await context.bot.send_message(chat_id=user_id, text=user_msg, parse_mode="HTML")
    except Exception as e:
        logger.error(f"Failed to send rejection notice to user: {e}")

async def auto_inbox_poller_task(app: Application):
    logger.info("Realtime background inbox poller started...")
    while True:
        try:
            # Clean up accounts overdue past 5 days grace period & check expiry warnings
            try:
                await db.cleanup_overdue_expired_accounts()
                await db.check_and_send_expiry_reminders(app.bot)
            except Exception as e:
                logger.error(f"Error in background maintenance tasks: {e}")

            active_accs = await db.get_all_active_accounts()
            for acc in active_accs:
                exp_status, _ = db.check_account_expiry_status(acc)
                if exp_status != "active":
                    continue

                u_id = acc["telegram_id"]
                email = acc["email"]
                token = acc["token"]
                last_msg_id = acc.get("last_msg_id")

                if not token:
                    continue

                try:
                    msgs = await mail_api.get_messages(token)
                    if msgs:
                        latest_msg = msgs[0]
                        latest_id = latest_msg.get("id")

                        if latest_id and latest_id != last_msg_id:
                            await db.update_last_msg_id(u_id, email, latest_id)

                            detail = await mail_api.get_message_detail(token, latest_id)
                            subject = detail.get("subject", "No Subject")
                            sender = detail.get("from", {}).get("address", "Unknown")
                            body_text = detail.get("text", "") or email_parser.clean_html_body(detail.get("html", [""])[0])
                            
                            otps = email_parser.extract_otp_codes(body_text)

                            lang = await db.get_user_language(u_id)
                            alert_msg = get_string(lang, "new_email_alert", email=safe_html(email), subject=safe_html(subject), sender=safe_html(sender))
                            
                            kb = []
                            if otps:
                                alert_msg += get_string(lang, "otp_alert", otp=safe_html(otps[0]))
                                kb.append([InlineKeyboardButton(f"📋 {otps[0]}", api_kwargs={"copy_text": {"text": otps[0]}, "style": "success"})])

                            kb.append([InlineKeyboardButton("📖 Read Email", callback_data=f"read:{email}:{latest_id}", api_kwargs={"style": "primary"})])
                            
                            await app.bot.send_message(
                                chat_id=u_id,
                                text=alert_msg,
                                parse_mode="HTML",
                                reply_markup=InlineKeyboardMarkup(kb)
                            )
                except Exception as ex:
                    logger.debug(f"Polling check error for {email}: {ex}")

        except Exception as e:
            logger.error(f"Error in background polling loop: {e}")

        await asyncio.sleep(POLL_INTERVAL)

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data

    if data == "cmd_create":
        await create_new_mail(update, context)
    elif data == "list_saved":
        await list_saved_mails(update, context)
    elif data.startswith("switch:"):
        target_email = data.split(":", 1)[1]
        await switch_account_and_view_inbox(update, context, target_email)
    elif data.startswith("inbox:"):
        target_email = data.split(":", 1)[1]
        await switch_account_and_view_inbox(update, context, target_email)
    elif data.startswith("read:"):
        parts = data.split(":", 2)
        email = parts[1]
        msg_id = parts[2]
        await read_full_message(update, context, email, msg_id)
    elif data.startswith("copy_otp:"):
        otp_code = data.split(":", 1)[1]
        await query.answer(f"✅ OTP Code: {otp_code}", show_alert=False)
        await query.message.reply_text(
            f"⚡ <b>OTP Code:</b> <code>{safe_html(otp_code)}</code>\n<i>(Tap code above to copy instantly!)</i>",
            parse_mode="HTML"
        )
    elif data == "confirm_del_all":
        kb = [
            [
                InlineKeyboardButton("🔴 Yes, Delete All", callback_data="do_del_all", api_kwargs={"style": "danger"}),
                InlineKeyboardButton("❌ Cancel", callback_data="list_saved", api_kwargs={"style": "primary"})
            ]
        ]
        await query.message.edit_text("⚠️ <b>Are you sure you want to delete ALL saved email accounts?</b>", parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    elif data == "do_del_all":
        user_id = update.effective_user.id
        await db.delete_all_user_accounts(user_id)
        await query.answer("All saved accounts deleted!", show_alert=True)
        await list_saved_mails(update, context)
    elif data.startswith("show_creds:"):
        email = data.split(":", 1)[1]
        user_id = update.effective_user.id
        acc = await db.get_account(user_id, email)
        if acc:
            exp_status, exp_dt = db.check_account_expiry_status(acc)
            if exp_status != "active":
                await query.answer("🔒 Credentials locked! Renew email validity to view details.", show_alert=True)
                return
            await query.answer()
            exp_str = acc.get("expires_at", "60 Days")
            free_used = acc.get("free_trial_used", 0)
            status_trial = "Already Used" if free_used == 1 else "Available (1-Time Free)"
            text = (
                f"🔑 <b>Credentials for <code>{safe_html(email)}</code></b>:\n\n"
                f"📧 Email: <code>{safe_html(acc['email'])}</code>\n"
                f"🔑 Password: <code>{safe_html(acc['password'])}</code>\n"
                f"⏳ Expiry Date: <code>{exp_str}</code>\n"
                f"🎁 2-Month Trial Status: <b>{status_trial}</b>\n\n"
                f"💡 <i>Tip: Tap email or password to copy!</i>"
            )
            kb = [
                [InlineKeyboardButton("🎁 Claim 2 Months Extension", callback_data=f"extend_mail:{email}", api_kwargs={"style": "success"})],
                [InlineKeyboardButton("🔙 Back to Inbox", callback_data=f"inbox:{email}", api_kwargs={"style": "primary"})]
            ]
            await query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    elif data.startswith("del_acc:"):
        email = data.split(":", 1)[1]
        user_id = update.effective_user.id
        acc = await db.get_account(user_id, email)
        if acc and acc.get("token") and acc.get("account_id"):
            try:
                await mail_api.delete_account(acc["token"], acc["account_id"])
            except Exception:
                pass
    elif data.startswith("extend_mail:"):
        email = data.split(":", 1)[1]
        user_id = update.effective_user.id
        lang = await db.get_user_language(user_id)
        
        success, res = await db.extend_email_validity_free(user_id, email)
        if success:
            await query.answer("🎉 Validity extended for 2 months!", show_alert=True)
            succ_msg = get_string(lang, "free_trial_extended_success", email=safe_html(email), expires_at=res)
            kb = [
                [InlineKeyboardButton("📥 Check Inbox", callback_data=f"inbox:{email}", api_kwargs={"style": "success"})],
                [InlineKeyboardButton("🗂 Saved Mails", callback_data="list_saved", api_kwargs={"style": "primary"})]
            ]
            await query.message.reply_text(succ_msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
        elif res == "already_used":
            await query.answer("⚠️ Free trial already used!", show_alert=True)
            user_accs = await db.get_user_accounts(user_id)
            acc_count = len(user_accs)
            if acc_count > 1:
                pay_msg = get_string(lang, "payment_notice_text_multi", count=acc_count)
            else:
                pay_msg = get_string(lang, "payment_notice_text_single")
            kb = [
                [InlineKeyboardButton("💳 Submit Payment Info", callback_data=f"start_pay_submit:{email}", api_kwargs={"style": "success"})],
                [InlineKeyboardButton("📩 Contact Admin", url="https://t.me/Mithu_BD", api_kwargs={"style": "primary"})],
                [InlineKeyboardButton("❌ Cancel & Back to Main Menu", callback_data="back_main", api_kwargs={"style": "primary"})]
            ]
            await query.message.reply_text(pay_msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
        else:
            await query.answer("❌ Account not found!", show_alert=True)
    elif data == "cancel_my_claim":
        user_id = update.effective_user.id
        await db.cancel_user_pending_claim(user_id)
        await query.answer("❌ Your pending payment claim has been cancelled!", show_alert=True)
        await list_saved_mails(update, context)
    elif data == "back_main":
        user_id = update.effective_user.id
        lang = await db.get_user_language(user_id)
        welcome_text = get_string(lang, "welcome", name=safe_html(update.effective_user.first_name))
        await query.answer()
        await query.message.reply_text(welcome_text, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))
    elif data == "admin_panel":
        await admin_panel_command(update, context)
    elif data == "admin_stats":
        await admin_stats_command(update, context)
    elif data == "admin_export_users":
        await admin_export_users_command(update, context)
    elif data == "admin_ban_list":
        await show_banned_list_command(update, context)
    elif data == "admin_pending_payments":
        await admin_pending_payments_command(update, context)
    elif data.startswith("approve_pay:"):
        claim_id = int(data.split(":", 1)[1])
        await approve_payment_callback(update, context, claim_id)
    elif data.startswith("reject_pay:"):
        claim_id = int(data.split(":", 1)[1])
        await reject_payment_callback(update, context, claim_id)
    elif data.startswith("do_unban:"):
        target_id = int(data.split(":", 1)[1])
        await db.set_user_ban_status(target_id, False)
        await query.answer("✅ User successfully unbanned!", show_alert=True)
        await show_banned_list_command(update, context)
    elif data == "admin_close":
        await query.answer("Admin panel closed.")
        try:
            await query.message.delete()
        except Exception:
            pass
    elif data == "admin_backup":
        await admin_backup_command(update, context)

async def cancel_prompt_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if query:
        user_id = update.effective_user.id
        lang = await db.get_user_language(user_id)
        await query.answer("Cancelled!")
        await query.message.reply_text("🚫 Operation cancelled.", reply_markup=get_main_reply_keyboard(lang, user_id))
    return ConversationHandler.END

async def start_login_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_login")
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_LOGIN_INPUT

async def cancel_and_route_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip() if update.message and update.message.text else ""
    if "Create Custom Mail" in text:
        return await start_custom_name_prompt(update, context)
    elif "Create Random Mail" in text:
        await create_new_mail(update, context)
    elif "Saved Mails" in text:
        await list_saved_mails(update, context)
    elif "Current Inbox" in text:
        await current_inbox_command(update, context)
    elif "Export TXT" in text:
        await export_txt_command(update, context)
    elif "Login Account" in text or "Restore Mail" in text:
        return await start_login_prompt(update, context)
    elif "2FA" in text or "2fa" in text:
        return await start_2fa_prompt(update, context)
    elif "Language" in text:
        await toggle_language(update, context)
    elif "Profile" in text or "profile" in text:
        await my_profile_command(update, context)
    elif "Help" in text:
        await help_command(update, context)
    elif "Admin" in text or "admin" in text:
        await admin_panel_command(update, context)
    elif text.startswith("/start"):
        await start_command(update, context)
    return ConversationHandler.END


async def start_2fa_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_2fa")
    kb = [[InlineKeyboardButton("❌ Cancel / Back", callback_data="cancel_prompt", api_kwargs={"style": "danger"})]]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
    return WAITING_FOR_2FA_INPUT

async def process_2fa_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        raw_input = update.message.text.strip()
        user_id = update.effective_user.id
        lang = await db.get_user_language(user_id)

        if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin|2FA)', raw_input) or raw_input.startswith("/"):
            return await cancel_and_route_menu(update, context)

        lines = [l.strip() for l in raw_input.splitlines() if l.strip()]
        if not lines:
            await update.message.reply_text("❌ Please enter a valid 2FA Secret Key.")
            return WAITING_FOR_2FA_INPUT

        results = []
        inline_buttons = []

        for idx, line in enumerate(lines, start=1):
            parts = line.split("|")
            secret = parts[0].strip()
            code = email_parser.generate_totp_code(secret)
            clean_sec = re.sub(r'[^A-Za-z2-7]', '', secret.upper())

            if code.startswith("ERROR"):
                results.append(f"<b>{idx}.</b> <code>{safe_html(clean_sec or secret)}</code> | ❌ <i>Invalid Secret</i>")
            else:
                results.append(f"<b>{idx}.</b> <code>{safe_html(clean_sec)}</code> | <code>{code}</code>")
                inline_buttons.append([
                    InlineKeyboardButton(f"📋 {code}", callback_data=f"copy_otp:{code}", api_kwargs={"style": "success"}),
                    InlineKeyboardButton(f"🔑 {clean_sec[:12]}", callback_data=f"copy_otp:{clean_sec}", api_kwargs={"style": "primary"})
                ])

        output_text = (
            "🔑 <b>2FA Authenticator Output</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
            "\n".join(results)
        )

        inline_buttons.append([InlineKeyboardButton("🔙 Back to Main Menu", callback_data="back_main", api_kwargs={"style": "primary"})])
        reply_markup = InlineKeyboardMarkup(inline_buttons)

        await update.message.reply_text(output_text, parse_mode="HTML", reply_markup=reply_markup)
    except Exception as e:
        logger.error(f"Error in process_2fa_input: {e}")
        await update.message.reply_text(f"❌ Error generating 2FA code: {safe_html(str(e))}")
    return ConversationHandler.END

async def fast_2fa_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        user_id = update.effective_user.id
        lang = await db.get_user_language(user_id)

        if not context.args:
            return await start_2fa_prompt(update, context)

        raw_input = " ".join(context.args).strip()
        lines = [l.strip() for l in raw_input.splitlines() if l.strip()]
        results = []
        inline_buttons = []

        for idx, line in enumerate(lines, start=1):
            parts = line.split("|")
            secret = parts[0].strip()
            code = email_parser.generate_totp_code(secret)
            clean_sec = re.sub(r'[^A-Za-z2-7]', '', secret.upper())

            if code.startswith("ERROR"):
                results.append(f"<b>{idx}.</b> <code>{safe_html(clean_sec or secret)}</code> | ❌ <i>Invalid Secret</i>")
            else:
                results.append(f"<b>{idx}.</b> <code>{safe_html(clean_sec)}</code> | <code>{code}</code>")
                inline_buttons.append([
                    InlineKeyboardButton(f"📋 {code}", callback_data=f"copy_otp:{code}", api_kwargs={"style": "success"}),
                    InlineKeyboardButton(f"🔑 {clean_sec[:12]}", callback_data=f"copy_otp:{clean_sec}", api_kwargs={"style": "primary"})
                ])

        output_text = (
            "🔑 <b>2FA Authenticator Output</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
            "\n".join(results)
        )
        inline_buttons.append([InlineKeyboardButton("🔙 Back to Main Menu", callback_data="back_main", api_kwargs={"style": "primary"})])
        reply_markup = InlineKeyboardMarkup(inline_buttons)

        await update.message.reply_text(output_text, parse_mode="HTML", reply_markup=reply_markup)
    except Exception as e:
        logger.error(f"Error in fast_2fa_command: {e}")
        await update.message.reply_text(f"❌ Error generating 2FA code: {safe_html(str(e))}")



async def process_login_input(update: Update, context: ContextTypes.DEFAULT_TYPE):

    raw_input = update.message.text.strip()
    user_id = update.effective_user.id

    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin)', raw_input) or raw_input.startswith("/"):
        return await cancel_and_route_menu(update, context)

    if ":" not in raw_input and " " not in raw_input:
        await update.message.reply_text("❌ Invalid format! Please enter <code>email : password</code>", parse_mode="HTML")
        return WAITING_FOR_LOGIN_INPUT

    parts = [p.strip() for p in re.split(r'[:\s]+', raw_input, maxsplit=1)]
    email = parts[0]
    password = parts[1] if len(parts) > 1 else ""

    status_msg = await update.message.reply_text("🔄 Verifying credentials...")

    try:
        token = await mail_api.get_token(email, password)
        headers = {"Authorization": f"Bearer {token}"}
        import httpx
        async with httpx.AsyncClient() as client:
            res = await client.get("https://api.mail.tm/me", headers=headers)
            acc_id = res.json().get("id", "") if res.status_code == 200 else ""

        await db.save_account(user_id, email, password, token, acc_id)
        
        await status_msg.edit_text(f"🎉 <b>Login Successful!</b>\n\nActive Email: <code>{safe_html(email)}</code>", parse_mode="HTML")
        await switch_account_and_view_inbox(update, context, email)
        return ConversationHandler.END

    except Exception as e:
        logger.error(f"Login failed: {e}")
        await status_msg.edit_text("❌ Login failed. Invalid email or password.", parse_mode="HTML")
        return WAITING_FOR_LOGIN_INPUT

async def cancel_flow(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    await update.message.reply_text("🚫 Cancelled.", reply_markup=get_main_reply_keyboard(lang, user_id))
    return ConversationHandler.END

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    help_text = get_string(lang, "help_text")
    await update.message.reply_text(help_text, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang, user_id))

async def back_to_user_menu_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    welcome_text = get_string(lang, "welcome", name=safe_html(update.effective_user.first_name))
    await update.message.reply_text(
        welcome_text,
        parse_mode="HTML",
        reply_markup=get_main_reply_keyboard(lang, user_id)
    )

async def direct_2fa_secret_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Direct handler for any pasted 2FA secret key in chat without prompt."""
    if not update.message or not update.message.text:
        return
    text = update.message.text.strip()
    clean_text = re.sub(r'[^A-Za-z2-7]', '', text.upper())
    if 15 <= len(clean_text) <= 64 and not text.startswith("/") and not re.search(r'(Create|Saved|Current|Export|Login|Restore|Language|Help|Admin|Profile|Cancel)', text, re.IGNORECASE):
        context.args = [text]
        return await fast_2fa_command(update, context)

def setup_bot_application(token: str) -> Application:
    from telegram.request import HTTPXRequest
    request = HTTPXRequest(connect_timeout=30.0, read_timeout=30.0)
    app = Application.builder().token(token).request(request).build()

    menu_fallback = MessageHandler(
        filters.Regex(".*(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help|Admin|Live Stats|Export Users List|Ban User|Banned Users|Pending Payments|Broadcast|Toggle VIP|DB Backup|Back to User Menu|2FA).*"),
        cancel_and_route_menu
    )

    totp_2fa_conv = ConversationHandler(
        entry_points=[
            CommandHandler("2fa", fast_2fa_command),
            MessageHandler(filters.Regex(".*2FA Authenticator.*"), start_2fa_prompt),
            CallbackQueryHandler(start_2fa_prompt, pattern="^start_2fa_prompt$")
        ],
        states={
            WAITING_FOR_2FA_INPUT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_2fa_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    login_conv = ConversationHandler(
        entry_points=[
            CommandHandler("login", start_login_prompt),
            MessageHandler(filters.Regex(".*(Login Account|Restore Mail).*"), start_login_prompt),
            CallbackQueryHandler(start_login_prompt, pattern="^login_prompt$")
        ],
        states={
            WAITING_FOR_LOGIN_INPUT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_login_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    custom_conv = ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(".*Create Custom Mail.*"), start_custom_name_prompt)
        ],
        states={
            WAITING_FOR_CUSTOM_NAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_custom_name_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    ban_conv = ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(".*Ban User.*"), start_ban_prompt),
            CallbackQueryHandler(start_ban_prompt, pattern="^admin_ban_prompt$")
        ],
        states={
            WAITING_FOR_BAN_ID: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_ban_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    unban_conv = ConversationHandler(
        entry_points=[
            CallbackQueryHandler(start_unban_prompt, pattern="^admin_unban_prompt$")
        ],
        states={
            WAITING_FOR_UNBAN_ID: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_unban_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    vip_conv = ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(".*Toggle VIP.*"), start_vip_prompt),
            CallbackQueryHandler(start_vip_prompt, pattern="^admin_vip_prompt$")
        ],
        states={
            WAITING_FOR_VIP_ID: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_vip_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    payment_conv = ConversationHandler(
        entry_points=[
            CallbackQueryHandler(start_payment_submission_prompt, pattern="^start_pay_submit:")
        ],
        states={
            WAITING_FOR_SENDER_NUMBER: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_sender_number_input)
            ],
            WAITING_FOR_TRX_ID: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_trx_id_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    broadcast_conv = ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(".*Broadcast.*"), start_broadcast_prompt),
            CallbackQueryHandler(start_broadcast_prompt, pattern="^admin_broadcast_prompt$")
        ],
        states={
            WAITING_FOR_BROADCAST_CONTENT: [
                MessageHandler(filters.ALL & ~filters.COMMAND, process_broadcast_content)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), CallbackQueryHandler(cancel_prompt_callback, pattern="^cancel_prompt$"), menu_fallback],
        per_message=False
    )

    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("admin", admin_panel_command))
    app.add_handler(CommandHandler("new", create_new_mail))
    app.add_handler(CommandHandler("myaccounts", list_saved_mails))
    app.add_handler(CommandHandler("inbox", current_inbox_command))
    app.add_handler(CommandHandler("stats", admin_stats_command))
    app.add_handler(CommandHandler("broadcast", admin_broadcast_command))
    app.add_handler(CommandHandler("backup", admin_backup_command))
    app.add_handler(CommandHandler("profile", my_profile_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("2fa", fast_2fa_command))

    app.add_handler(totp_2fa_conv)
    app.add_handler(login_conv)
    app.add_handler(custom_conv)
    app.add_handler(ban_conv)
    app.add_handler(unban_conv)
    app.add_handler(vip_conv)
    app.add_handler(payment_conv)
    app.add_handler(broadcast_conv)

    app.add_handler(MessageHandler(filters.Regex(".*(Admin Control|Admin Panel).*"), admin_panel_command))
    app.add_handler(MessageHandler(filters.Regex(".*Live Stats.*"), admin_stats_command))
    app.add_handler(MessageHandler(filters.Regex(".*Export Users List.*"), admin_export_users_command))
    app.add_handler(MessageHandler(filters.Regex(".*Banned Users.*"), show_banned_list_command))
    app.add_handler(MessageHandler(filters.Regex(".*Pending Payments.*"), admin_pending_payments_command))
    app.add_handler(MessageHandler(filters.Regex(".*DB Backup.*"), admin_backup_command))
    app.add_handler(MessageHandler(filters.Regex(".*Back to User Menu.*"), back_to_user_menu_command))

    app.add_handler(MessageHandler(filters.Regex(".*Create Random Mail.*"), create_new_mail))
    app.add_handler(MessageHandler(filters.Regex(".*Saved Mails.*"), list_saved_mails))
    app.add_handler(MessageHandler(filters.Regex(".*Current Inbox.*"), current_inbox_command))
    app.add_handler(MessageHandler(filters.Regex(".*Export TXT.*"), export_txt_command))
    app.add_handler(MessageHandler(filters.Regex(".*Language.*"), toggle_language))
    app.add_handler(MessageHandler(filters.Regex(".*(My Profile|Profile).*"), my_profile_command))
    app.add_handler(MessageHandler(filters.Regex(".*Help.*"), help_command))

    # Direct 2FA Secret Key Auto-Detector Handler
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, direct_2fa_secret_handler))
    app.add_handler(CallbackQueryHandler(handle_callback))

    return app


