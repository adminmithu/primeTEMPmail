# 📧 Mail.tm Telegram Temp Mail Bot

একটি পূর্ণাঙ্গ Telegram Bot যা [Mail.tm](https://mail.tm) REST API ব্যবহার করে ইনস্ট্যান্ট অস্থায়ী ইমেইল তৈরি, ১-ক্লিক ইনবক্স সুইচিং, অটোম্যাটিক OTP এক্সট্র্যাকশন এবং পাসওয়ার্ড দিয়ে অ্যাকাউন্ট রিস্টোর/লগইন করার সুবিধা দেয়।

---

## ✨ Features (মূল সুবিধাসমূহ)

1. **⚡ 1-Click Instant Email Generation**:
   - ১-ক্লিকে Mail.tm API থেকে সক্রিয় ডোমেইন নিয়ে একটি নতুন র‍্যান্ডম ইমেইল ও পাসওয়ার্ড তৈরি।
   - ইমেইল ও পাসওয়ার্ড ১-ট্যাপে কপি করার জন্য ফরম্যাট করা।

2. **🗂 1-Click Saved Inbox Switching**:
   - `🗂 Saved Mails` বাটনে চাপলে পূর্বের সব ইমেইল ইনলাইন বাটন হিসেবে আসবে।
   - যেকোনো ইমেইলে ১-ক্লিক করলে সাথে সাথে ঐ ইমেইলের ইনবক্সে রিডাইরেক্ট হবে।

3. **📥 Clean Inbox & Full Body Reader**:
   - ইনবক্সে প্রথমে শুধু ইমেইলের Subject/Title লিস্ট দেখাবে।
   - যেকোনো Title বাটনে ক্লিক করলে সেই মেসেজের ফুল বডি (Full Body) পড়তে পারবেন।

4. **⚡ Auto OTP & Link Extractor**:
   - ইমেইলের বডি থেকে ৪-৮ ডিজিটের OTP Verification Code এবং Verification Links অটোমেটিক এক্সট্র্যাক্ট করে ১-ট্যাপ কপি করার জন্য আলাদাভাবে তৈরি থাকবে।

5. **🔐 Account Login & Restore (`/login`)**:
   - পূর্বে তৈরি করা ইমেইল ও পাসওয়ার্ড প্রদান করে পরবর্তীতে যেকোনো দিন বটের ভেতরে অ্যাকাউন্ট রিস্টোর করে ইনবক্স চেক করার ব্যবস্থা।

---

## 📂 Project Structure

```
g:\mail.tm\
├── config.py           # Bot Token & API Settings
├── database.py         # SQLite DB for Users, Credentials & Session management
├── mail_api.py         # Async Mail.tm REST API Client
├── parser.py           # BeautifulSoup & Regex OTP / Link Extractor
├── bot.py              # Telegram Bot Handlers & Inline Keyboard UI
├── main.py             # App Launcher & Database Initializer
├── requirements.txt    # Python Dependencies
├── .env                # Bot Token Environment File
└── README.md           # Documentation & Setup Guide
```

---

## 🚀 How to Setup & Run (কিভাবে চালু করবেন)

### Step 1: Clone / Open Project Directory
```bash
g:
cd mail.tm
```

### Step 2: Set your Telegram Bot Token
1. Telegram-এ `@BotFather`-এ গিয়ে নতুন একটি বট তৈরি করুন (`/newbot`) এবং API Token টি কপি করুন।
2. প্রজেক্ট ফোল্ডারের `.env` ফাইলটি এডিট করে `BOT_TOKEN` বসিয়ে দিন:
   ```env
   BOT_TOKEN=7123456789:ABCdefGHIjklMNOpqrsTUVwxyZ
   ```

### Step 3: Install Dependencies
```bash
pip install -r requirements.txt
```

### Step 4: Run the Bot
```bash
python main.py
```

---

## 📱 Bot Commands

- `/start` - বটের মেইন মেনু ও বাটনসমূহ চালু করা।
- `📧 Create New Mail` / `/new` - ইনস্ট্যান্ট নতুন ইমেল তৈরি।
- `🗂 Saved Mails` / `/myaccounts` - আপনার সব সেভ থাকা ইমেইলের ১-ক্লিক তালিকা।
- `📥 Current Inbox` / `/inbox` - বর্তমান সচল ইমেইলের ইনবক্স দেখা।
- `🔐 Login Account` / `/login` - পুরনো ইমেইল ও পাসওয়ার্ড দিয়ে রিস্টোর করা।
- `❓ Help` / `/help` - ব্যবহারের নির্দেশনা।
