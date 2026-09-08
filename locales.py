# Localization strings for Bengali (bn) and English (en)

STRINGS = {
    "bn": {
        "welcome": (
            "👋 <b>হ্যালো {name}!</b>\n\n"
            "⚡ <b>PrimeTemp Mail Bot</b>-এ আপনাকে স্বাগতম! 🚀\n"
            "<i>ইনস্ট্যান্ট ইমেইল তৈরি করুন এবং ১-ক্লিকেই ইনবক্স দেখুন।</i>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "👇 <b>শুরু করতে নিচের বাটনগুলো ব্যবহার করুন:</b>"
        ),
        "help_text": (
            "❓ <b>PrimeTemp Mail Bot - ব্যবহার নির্দেশিকা ও সুবিধাসমূহ</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "✨ <b>প্রধান সুবিধাসমূহ:</b>\n"
            "• <b>1-Click Temp Mail</b>: ক্লিকেই নতুন ইনস্ট্যান্ট ইমেইল তৈরি।\n"
            "• <b>1-Click Inbox Switching</b>: তৈরি করা পুরনো ইমেইলে ১-ক্লিকেই ইনবক্স দেখুন।\n"
            "• <b>Realtime Auto-Notifier</b>: ইমেইল আসামাত্র স্বয়ংক্রিয় পুশ নোটিফিকেশন ও OTP কোড পাবেন।\n"
            "• <b>Custom Email Name</b>: পছন্দের নাম দিয়ে কাস্টম ইমেইল তৈরি।\n"
            "• <b>Export TXT</b>: সেভ থাকা ইমেইল তালিকা ফাইল আকারে ডাউনলোড।\n\n"
            "📌 <b>বাটনের সঠিক ব্যবহার:</b>\n"
            "1️⃣ <b>✏️ Create Custom Mail</b>: পছন্দের নামে কাস্টম ইমেইল খুলুন।\n"
            "2️⃣ <b>📧 Create Random Mail</b>: ইনস্ট্যান্ট র্যান্ডম ইমেইল খুলুন।\n"
            "3️⃣ <b>🗂 Saved Mails</b>: আপনার সেভ হওয়া সব ইমেলের ১-ক্লিক তালিকা।\n"
            "4️⃣ <b>📥 Current Inbox</b>: সচল ইমেইলের ইনবক্স রিফ্রেশ করে মেসেজ দেখুন।\n"
            "5️⃣ <b>📁 Export TXT</b>: সব ইমেইল ও পাসওয়ার্ড ফাইল ব্যাকআপ হিসেবে ডাউনলোড।\n"
            "6️⃣ <b>🔐 Login Account</b>: আগের তৈরি ইমেল ও পাসওয়ার্ড দিয়ে রিস্টোর করুন।\n"
            "7️⃣ <b>🌐 Language / ভাষা</b>: বটের ভাষা পরিবর্তন করুন।"
        ),
        "btn_create_custom": "✏️ Create Custom Mail",
        "btn_create_random": "📧 Create Random Mail",
        "btn_saved_mails": "🗂 Saved Mails",
        "btn_current_inbox": "📥 Current Inbox",
        "btn_login": "🔐 Login Account",
        "btn_export_txt": "📁 Export TXT",
        "btn_lang": "🌐 Language / ভাষা",
        "btn_help": "❓ Help",
        "creating_mail": "🔄 <b>নতুন ইমেইল অ্যাকাউন্ট তৈরি করা হচ্ছে...</b>\n<i>অনুগ্রহ করে ২ সেকেন্ড অপেক্ষা করুন।</i>",
        "mail_created_success": (
            "🎉 <b>নতুন ইমেইল সফলভাবে তৈরি হয়েছে!</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "📧 <b>Email Address:</b> <code>{email}</code>\n"
            "🔑 <b>Password:</b> <code>{password}</code>\n\n"
            "💡 <i>টিপস: ইমেইল বা পাসওয়ার্ডের ওপর ১-ট্যাপ করলেই কপি হয়ে যাবে!</i>\n"
        ),
        "saved_mails_title": "🗂 <b>আপনার সেভ করা ইমেইল একাউন্ট তালিকা:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n",
        "no_saved_mails": "🗂 <b>আপনার কোনো সেভ করা ইমেইল পাওয়া যায়নি!</b>\n\nনতুন ইমেইল তৈরি করতে <code>✏️ Create Custom Mail</code> বা <code>📧 Create Random Mail</code> বাটনে চাপুন।",
        "inbox_empty": (
            "📥 <b>Inbox for:</b> <code>{email}</code>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "📭 <i>ইনবক্স খালি! কোনো ইমেইল বার্তা পাওয়া যায়নি।</i>\n"
            "<i>(ওয়েবসাইটে ইমেইল দেওয়ার পর অটো-নোটিফিকেশনের জন্য অপেক্ষা করুন বা Refresh চাপুন)</i>"
        ),
        "inbox_title": "📥 <b>Inbox for:</b> <code>{email}</code>\n📊 Total Messages: <b>{count}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n",
        "new_email_alert": (
            "🔔 <b>নতুন ইমেইল বার্তা এসেছে!</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "📧 <b>To:</b> <code>{email}</code>\n"
            "📌 <b>Subject:</b> <b>{subject}</b>\n"
            "👤 <b>From:</b> <code>{sender}</code>\n\n"
        ),
        "otp_alert": "⚡ <b>Extracted Verification Code:</b> <code>{otp}</code> <i>(১-ট্যাপে কপি করুন)</i>\n",
        "prompt_custom_name": (
            "✏️ <b>কাস্টম ইমেইল তৈরি করুন</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "আপনার পছন্দের ইমেল ইউজারনেম টাইপ করুন।\n"
            "<i>(উদাহরণ: <code>mithubd</code> বা <code>prime_user</code>)</i>\n\n"
            "🚫 বাতিল করতে /cancel টাইপ করুন।"
        ),
        "prompt_login": (
            "🔐 <b>Account Restore / Login</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "আপনার পূর্বের তৈরি ইমেইল ও পাসওয়ার্ড প্রদান করুন।\n"
            "📝 <b>ফরম্যাট:</b> <code>email : password</code>\n"
            "<i>(উদাহরণ: <code>mithubd@uberip.com : Pass#9821</code>)</i>\n\n"
            "🚫 বাতিল করতে /cancel টাইপ করুন।"
        ),
        "lang_switched": "🌐 ভাষা পরিবর্তিত হয়ে <b>বাংলা</b> হয়েছে।",
    },
    "en": {
        "welcome": (
            "👋 <b>Hello {name}!</b>\n\n"
            "Welcome to ⚡ <b>PrimeTemp Mail Bot</b>! 🚀\n"
            "<i>Create instant temporary emails & check inbox with 1-click.</i>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "👇 <b>Use the menu buttons below to start:</b>"
        ),
        "help_text": (
            "❓ <b>PrimeTemp Mail Bot - User Guide & Features</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "✨ <b>Key Features:</b>\n"
            "• <b>1-Click Temp Mail</b>: Instant random email creation.\n"
            "• <b>1-Click Inbox Switching</b>: Easily switch between saved emails.\n"
            "• <b>Realtime Auto-Notifier</b>: Push notification & instant OTP copy on new emails.\n"
            "• <b>Custom Email Name</b>: Create emails with custom usernames.\n"
            "• <b>Export TXT</b>: Download saved accounts as a text file.\n\n"
            "📌 <b>Button Usage:</b>\n"
            "1️⃣ <b>✏️ Create Custom Mail</b>: Create email with custom username.\n"
            "2️⃣ <b>📧 Create Random Mail</b>: Instant random email.\n"
            "3️⃣ <b>🗂 Saved Mails</b>: 1-Click saved emails list.\n"
            "4️⃣ <b>📥 Current Inbox</b>: View and refresh active inbox.\n"
            "5️⃣ <b>📁 Export TXT</b>: Download TXT file backup.\n"
            "6️⃣ <b>🔐 Login Account</b>: Restore using email & password.\n"
            "7️⃣ <b>🌐 Language / ভাষা</b>: Change bot language."
        ),
        "btn_create_custom": "✏️ Create Custom Mail",
        "btn_create_random": "📧 Create Random Mail",
        "btn_saved_mails": "🗂 Saved Mails",
        "btn_current_inbox": "📥 Current Inbox",
        "btn_login": "🔐 Login Account",
        "btn_export_txt": "📁 Export TXT",
        "btn_lang": "🌐 Language / ভাষা",
        "btn_help": "❓ Help",
        "creating_mail": "🔄 <b>Creating new email account...</b>\n<i>Please wait a moment.</i>",
        "mail_created_success": (
            "🎉 <b>New Email Successfully Created!</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "📧 <b>Email Address:</b> <code>{email}</code>\n"
            "🔑 <b>Password:</b> <code>{password}</code>\n\n"
            "💡 <i>Tip: Tap email or password to copy!</i>\n"
        ),
        "saved_mails_title": "🗂 <b>Your Saved Email Accounts:</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n",
        "no_saved_mails": "🗂 <b>No saved email accounts found!</b>",
        "inbox_empty": (
            "📥 <b>Inbox for:</b> <code>{email}</code>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "📭 <i>Inbox is empty! No messages received yet.</i>"
        ),
        "inbox_title": "📥 <b>Inbox for:</b> <code>{email}</code>\n📊 Total Messages: <b>{count}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n",
        "new_email_alert": (
            "🔔 <b>New Email Received!</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "📧 <b>To:</b> <code>{email}</code>\n"
            "📌 <b>Subject:</b> <b>{subject}</b>\n"
            "👤 <b>From:</b> <code>{sender}</code>\n\n"
        ),
        "otp_alert": "⚡ <b>Extracted Verification Code:</b> <code>{otp}</code> <i>(1-Tap Copy)</i>\n",
        "prompt_custom_name": (
            "✏️ <b>Custom Email Creation</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "Type your desired username.\n"
            "<i>(Example: <code>mithubd</code>)</i>\n\n"
            "Type /cancel to abort."
        ),
        "prompt_login": (
            "🔐 <b>Account Restore / Login</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "Enter your email & password.\n"
            "📝 <b>Format:</b> <code>email : password</code>\n\n"
            "Type /cancel to abort."
        ),
        "lang_switched": "🌐 Language switched to <b>English</b>.",
    }
}

def get_string(lang: str, key: str, **kwargs) -> str:
    lang_dict = STRINGS.get(lang, STRINGS["bn"])
    template = lang_dict.get(key, STRINGS["bn"].get(key, ""))
    return template.format(**kwargs) if kwargs else template
