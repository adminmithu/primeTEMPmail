import logging
import random
import string
import re
import html
import os
import io
import asyncio
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputFile
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
    fn = random.choice(FIRST_NAMES)
    ln = random.choice(LAST_NAMES)
    kw = random.choice(KEYWORDS)
    num = random.randint(10, 999)
    
    style = random.choice([1, 2, 3, 4, 5])
    if style == 1:
        return f"{fn}.{ln}{num}"       # e.g., alex.smith84
    elif style == 2:
        return f"{fn}_{ln}{num}"       # e.g., david_miller19
    elif style == 3:
        return f"{fn}{ln}{num}"         # e.g., sarahdavis502
    elif style == 4:
        return f"{fn}.{kw}{num}"       # e.g., michael.dev42
    else:
        return f"{fn}_{kw}{num}"       # e.g., emily_pro92

def generate_random_string(length=8):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=length))

def generate_secure_password(length=12):
    chars = string.ascii_letters + string.digits + "!@#$"
    return ''.join(random.choices(chars, k=length))

def get_main_reply_keyboard(lang: str = "bn"):
    from telegram import ReplyKeyboardMarkup, KeyboardButton
    b = lambda key: get_string(lang, key)
    keyboard = [
        [KeyboardButton(b("btn_create_custom"))],
        [KeyboardButton(b("btn_create_random"))],
        [KeyboardButton(b("btn_saved_mails")), KeyboardButton(b("btn_current_inbox"))],
        [KeyboardButton(b("btn_export_txt")), KeyboardButton(b("btn_login"))],
        [KeyboardButton(b("btn_lang")), KeyboardButton(b("btn_help"))]
    ]
    return ReplyKeyboardMarkup(keyboard, resize_keyboard=True)

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    lang = await db.get_user_language(user.id)
    welcome_text = get_string(lang, "welcome", name=safe_html(user.first_name))
    await update.message.reply_text(
        welcome_text,
        parse_mode="HTML",
        reply_markup=get_main_reply_keyboard(lang)
    )

async def create_new_mail(update: Update, context: ContextTypes.DEFAULT_TYPE, custom_name: str = None):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    
    msg = None
    if update.message:
        msg = await update.message.reply_text(get_string(lang, "creating_mail"))
    elif update.callback_query:
        await update.callback_query.answer()
        msg = await update.callback_query.message.edit_text(get_string(lang, "creating_mail"))

    try:
        domains = await mail_api.get_domains()
        if not domains:
            if msg: await msg.edit_text("❌ No active domains found.")
            return

        selected_domain = domains[0]
        if custom_name:
            clean_name = re.sub(r'[^a-zA-Z0-9._-]', '', custom_name).lower()[:25]
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
                InlineKeyboardButton("📥 Check Inbox", callback_data=f"inbox:{full_email}"),
                InlineKeyboardButton("🗂 Saved Mails", callback_data="list_saved")
            ],
            [
                InlineKeyboardButton("🗑 Delete Email", callback_data=f"del_acc:{full_email}")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        if msg:
            await msg.edit_text(response_text, parse_mode="HTML", reply_markup=reply_markup)

    except Exception as e:
        logger.error(f"Error creating mail: {e}")
        if msg:
            await msg.edit_text(f"❌ Error: {safe_html(str(e))}")

async def start_custom_name_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_custom_name")
    await update.message.reply_text(text, parse_mode="HTML")
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
        keyboard = [[InlineKeyboardButton("➕ Create Random Mail", callback_data="cmd_create")]]
        reply_markup = InlineKeyboardMarkup(keyboard)
    else:
        text = get_string(lang, "saved_mails_title")
        keyboard = []
        for acc in accounts:
            email = acc["email"]
            status = "🟢 (Active)" if email == active_email else ""
            text += f"• <code>{safe_html(email)}</code> {status}\n"
            keyboard.append([InlineKeyboardButton(f"📧 {email} {status}", callback_data=f"switch:{email}")])
        
        keyboard.append([
            InlineKeyboardButton("➕ Create New", callback_data="cmd_create"),
            InlineKeyboardButton("🔐 Login Existing", callback_data="login_prompt")
        ])
        keyboard.append([
            InlineKeyboardButton("🗑 Delete All Accounts", callback_data="confirm_del_all")
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
                InlineKeyboardButton("🔄 Refresh Inbox", callback_data=f"inbox:{target_email}"),
                InlineKeyboardButton("🗂 Saved List", callback_data="list_saved")
            ],
            [
                InlineKeyboardButton("🔑 Credentials", callback_data=f"show_creds:{target_email}"),
                InlineKeyboardButton("🗑 Delete Email", callback_data=f"del_acc:{target_email}")
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
                    InlineKeyboardButton(f"📩 #{idx} {subject[:22]}", callback_data=f"read:{target_email}:{msg_id}"),
                    InlineKeyboardButton(f"🔑 Copy OTP: {otp_code}", callback_data=f"copy_otp:{otp_code}")
                ])
            else:
                text += "\n"
                button_label = f"📩 #{idx} {subject[:28]}"
                keyboard.append([InlineKeyboardButton(button_label, callback_data=f"read:{target_email}:{msg_id}")])

        keyboard.append([
            InlineKeyboardButton("🔄 Refresh Inbox", callback_data=f"inbox:{target_email}"),
            InlineKeyboardButton("🗂 Saved List", callback_data="list_saved")
        ])
        keyboard.append([
            InlineKeyboardButton("🔑 Credentials", callback_data=f"show_creds:{target_email}"),
            InlineKeyboardButton("🗑 Delete Email", callback_data=f"del_acc:{target_email}")
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
    await query.answer("Loading message...")

    acc = await db.get_account(user_id, email)
    if not acc or not acc.get("token"):
        await query.message.edit_text("❌ Session error!")
        return

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

    keyboard = [
        [
            InlineKeyboardButton("🔙 Back to Inbox", callback_data=f"inbox:{email}"),
            InlineKeyboardButton("🗑 Delete Msg", callback_data=f"del_msg:{email}:{msg_id}")
        ]
    ]
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

async def admin_stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        return

    stats = await db.get_admin_stats()
    text = (
        f"👑 <b>Admin Dashboard Statistics</b>\n\n"
        f"👤 Total Bot Users: <b>{stats['total_users']}</b>\n"
        f"📧 Total Saved Mail Accounts: <b>{stats['total_accounts']}</b>"
    )
    await update.message.reply_text(text, parse_mode="HTML")

async def auto_inbox_poller_task(app: Application):
    logger.info("Realtime background inbox poller started...")
    while True:
        try:
            active_accs = await db.get_all_active_accounts()
            for acc in active_accs:
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
                            
                            if otps:
                                alert_msg += get_string(lang, "otp_alert", otp=safe_html(otps[0]))

                            kb = [[InlineKeyboardButton("📖 Read Email", callback_data=f"read:{email}:{latest_id}")]]
                            
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
        await query.answer(f"🔑 OTP Code: {otp_code}\n(Select & copy!)", show_alert=True)
    elif data == "confirm_del_all":
        kb = [
            [
                InlineKeyboardButton("✅ Yes, Delete All", callback_data="do_del_all"),
                InlineKeyboardButton("❌ Cancel", callback_data="list_saved")
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
            await query.answer()
            text = (
                f"🔑 <b>Credentials for <code>{safe_html(email)}</code></b>:\n\n"
                f"📧 Email: <code>{safe_html(acc['email'])}</code>\n"
                f"🔑 Password: <code>{safe_html(acc['password'])}</code>\n\n"
                f"💡 <i>Tip: Tap email or password to copy!</i>"
            )
            kb = [[InlineKeyboardButton("🔙 Back to Inbox", callback_data=f"inbox:{email}")]]
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
        await db.delete_saved_account(user_id, email)
        await query.answer("Email account deleted!", show_alert=True)
        await list_saved_mails(update, context)
    elif data.startswith("del_msg:"):
        parts = data.split(":", 2)
        email = parts[1]
        msg_id = parts[2]
        user_id = update.effective_user.id
        acc = await db.get_account(user_id, email)
        if acc and acc.get("token"):
            await mail_api.delete_message(acc["token"], msg_id)
            await query.answer("Message deleted!", show_alert=True)
            await switch_account_and_view_inbox(update, context, email)

async def start_login_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    text = get_string(lang, "prompt_login")
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.edit_text(text, parse_mode="HTML")
    else:
        await update.message.reply_text(text, parse_mode="HTML")
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
    elif "Language" in text:
        await toggle_language(update, context)
    elif "Help" in text:
        await help_command(update, context)
    elif text.startswith("/start"):
        await start_command(update, context)
    return ConversationHandler.END

async def process_login_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw_input = update.message.text.strip()
    user_id = update.effective_user.id

    if re.search(r'(Create Custom Mail|Create Random Mail|Saved Mails|Current Inbox|Export TXT|Login Account|Restore Mail|Language|Help)', raw_input) or raw_input.startswith("/"):
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
    await update.message.reply_text("🚫 Cancelled.", reply_markup=get_main_reply_keyboard(lang))
    return ConversationHandler.END

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = await db.get_user_language(user_id)
    help_text = get_string(lang, "help_text")
    await update.message.reply_text(help_text, parse_mode="HTML", reply_markup=get_main_reply_keyboard(lang))

def setup_bot_application(token: str) -> Application:
    from telegram.request import HTTPXRequest
    request = HTTPXRequest(connect_timeout=30.0, read_timeout=30.0)
    app = Application.builder().token(token).request(request).build()

    menu_fallback = MessageHandler(
        filters.Regex("^(✏️ Create Custom Mail|📧 Create Random Mail|🗂 Saved Mails|📥 Current Inbox|📁 Export TXT|🔐 Login Account|🔐 Restore Mail|🌐 Language / ভাষা|❓ Help)$"),
        cancel_and_route_menu
    )

    login_conv = ConversationHandler(
        entry_points=[
            CommandHandler("login", start_login_prompt),
            MessageHandler(filters.Regex("^(🔐 Login Account|🔐 Restore Mail)$"), start_login_prompt),
            CallbackQueryHandler(start_login_prompt, pattern="^login_prompt$")
        ],
        states={
            WAITING_FOR_LOGIN_INPUT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_login_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), menu_fallback]
    )

    custom_conv = ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex("^✏️ Create Custom Mail$"), start_custom_name_prompt)
        ],
        states={
            WAITING_FOR_CUSTOM_NAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_custom_name_input)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel_flow), menu_fallback]
    )

    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("new", create_new_mail))
    app.add_handler(CommandHandler("myaccounts", list_saved_mails))
    app.add_handler(CommandHandler("inbox", current_inbox_command))
    app.add_handler(CommandHandler("stats", admin_stats_command))
    app.add_handler(CommandHandler("broadcast", admin_broadcast_command))
    app.add_handler(CommandHandler("backup", admin_backup_command))
    app.add_handler(CommandHandler("help", help_command))

    app.add_handler(MessageHandler(filters.Regex("^📧 Create Random Mail$"), create_new_mail))
    app.add_handler(MessageHandler(filters.Regex("^🗂 Saved Mails$"), list_saved_mails))
    app.add_handler(MessageHandler(filters.Regex("^📥 Current Inbox$"), current_inbox_command))
    app.add_handler(MessageHandler(filters.Regex("^📁 Export TXT$"), export_txt_command))
    app.add_handler(MessageHandler(filters.Regex("^🌐 Language / ভাষা$"), toggle_language))
    app.add_handler(MessageHandler(filters.Regex("^❓ Help$"), help_command))

    app.add_handler(login_conv)
    app.add_handler(custom_conv)
    app.add_handler(CallbackQueryHandler(handle_callback))

    return app
