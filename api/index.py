import os
import sys
import asyncio
import logging
from fastapi import FastAPI, Request, Response
from telegram import Update
from telegram.ext import Application

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import BOT_TOKEN, ADMIN_ID
from database import init_db, get_all_active_accounts, update_last_msg_id, get_user_language
from mail_api import mail_api
import parser as email_parser
from locales import get_string
from bot import setup_bot_application, safe_html

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="PrimeTemp Mail Bot - Vercel Serverless")

ptb_app: Application = None

async def get_ptb_app() -> Application:
    global ptb_app
    if ptb_app is None:
        await init_db()
        ptb_app = setup_bot_application(BOT_TOKEN)
        await ptb_app.initialize()
    return ptb_app

@app.get("/")
async def root_index(request: Request):
    """Root route - Health Check and Auto Set Telegram Webhook."""
    base_url = str(request.base_url).rstrip('/')
    if base_url.startswith("http://") and "localhost" not in base_url and "127.0.0.1" not in base_url:
        base_url = "https://" + base_url[7:]
    webhook_url = f"{base_url}/api/webhook"
    
    bot_app = await get_ptb_app()
    webhook_set = False
    try:
        webhook_set = await bot_app.bot.set_webhook(webhook_url)
    except Exception as e:
        logger.error(f"Error setting webhook: {e}")

    return {
        "status": "online",
        "bot_name": "PrimeTemp Mail Bot",
        "webhook_url": webhook_url,
        "webhook_set_success": webhook_set
    }

@app.post("/api/webhook")
async def telegram_webhook(request: Request):
    """Telegram Webhook handler endpoint for Vercel Serverless."""
    bot_app = await get_ptb_app()
    try:
        data = await request.json()
        update = Update.de_json(data, bot_app.bot)
        await bot_app.process_update(update)
        return Response(status_code=200)
    except Exception as e:
        logger.error(f"Error handling webhook update: {e}")
        return Response(status_code=200)

@app.get("/api/cron")
async def vercel_cron_job():
    """Vercel Cron route - Triggered every minute to poll inboxes and send alerts."""
    bot_app = await get_ptb_app()
    logger.info("Executing Vercel Cron Email Poller Check...")
    
    alert_sent_count = 0
    try:
        active_accs = await get_all_active_accounts()
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
                        await update_last_msg_id(u_id, email, latest_id)

                        detail = await mail_api.get_message_detail(token, latest_id)
                        subject = detail.get("subject", "No Subject")
                        sender = detail.get("from", {}).get("address", "Unknown")
                        body_text = detail.get("text", "") or email_parser.clean_html_body(detail.get("html", [""])[0])
                        
                        otps = email_parser.extract_otp_codes(body_text)

                        lang = await get_user_language(u_id)
                        alert_msg = get_string(lang, "new_email_alert", email=safe_html(email), subject=safe_html(subject), sender=safe_html(sender))
                        
                        kb = []
                        if otps:
                            alert_msg += get_string(lang, "otp_alert", otp=safe_html(otps[0]))
                            kb.append([InlineKeyboardButton(f"📋 {otps[0]}", api_kwargs={"copy_text": {"text": otps[0]}, "style": "success"})])

                        kb.append([InlineKeyboardButton("📖 Read Email", callback_data=f"read:{email}:{latest_id}", api_kwargs={"style": "primary"})])
                        
                        await bot_app.bot.send_message(
                            chat_id=u_id,
                            text=alert_msg,
                            parse_mode="HTML",
                            reply_markup=InlineKeyboardMarkup(kb)
                        )
                        alert_sent_count += 1
            except Exception as ex:
                logger.debug(f"Cron check error for {email}: {ex}")

    except Exception as e:
        logger.error(f"Error in Vercel cron handler: {e}")

    return {"status": "ok", "alerts_sent": alert_sent_count}
