<div align="center">

# 🎭 Mr. Schadenfreude

**A Gothic Multiplayer Social Deduction & Detective Web Game**

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-v4.7%2B-010101.svg)](https://socket.io/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey.svg)](https://expressjs.com/)
[![Render](https://img.shields.io/badge/Deploy%20on-Render-46E3B7.svg)](https://render.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

[🌟 Original Credits](#-original-credits--tribute) • [🎤 Vocal Cast](#-vocaloid-cast--voice-providers) • [🎮 Key Features](#-key-features) • [📜 Roles & Abilities](#-roles--abilities) • [🚀 Local Setup](#-getting-started) • [☁️ Deploy to Render](#-deployment-rendercom)

</div>

---

## 🌟 Original Credits & Tribute

> ### 🎵 Inspired by the Vocaloid Masterpiece: **「Mr. Schadenfreude / ミスター・シャーデンフロイデ」**
> This web game is an interactive fan-made tribute based on the gothic murder-mystery universe and storyline created by the legendary original team:
> 
> - **Music & Lyrics:** [Hitoshizuku-P (ひとしずく)](https://x.com/samorira9) × [Yama△ (やま△)](https://x.com/shoma1983) ([Official Website](https://hitoyamamusic.com/))
> - **Character Design & Illustration:** [Suzunosuke (鈴ノ助)](https://x.com/suzu3939)
> - **Video & Movie Production:** [TSO (とさお)](https://x.com/anarchylily)
> - **Official Channel:** [Hitoshizuku_Yamasankakkei YouTube Channel](https://www.youtube.com/channel/UC-S5N15Z6xR-v3D5b_vC75Q)
> - **Official Music Video:** [Watch "Mr. Schadenfreude" on YouTube](https://www.youtube.com/watch?v=ADy8Xlj0mBc)

---

### 🎤 Vocaloid Cast & Voice Providers

The vocalists whose character archetypes inspired the in-game villagers and abilities:

| Character | Role / Archetype | Voice Provider (Seiyuu / Artist) | Official Links |
| :--- | :--- | :--- | :--- |
| **Kagamine Rin & Len** (鏡音リン・レン) | Knight / Villagers | **Asami Shimoda** (下田麻美) | [X (Twitter)](https://x.com/shimoda_asami) |
| **Hatsune Miku** (初音ミク) | Village Inhabitant | **Saki Fujita** (藤田咲) | [YouTube Channel](https://www.youtube.com/channel/UC-oYjt27a8q-yRfHgJZQPhg) • [Official X](https://x.com/cfm_miku) |
| **Megurine Luka** (巡音ルカ) | Priest (Rahibe) | **Yuu Asakawa** (浅川悠) | [YouTube Channel](https://www.youtube.com/channel/UCyM7a2X8KzOq8v6K-K7Zq7A) • [X (Twitter)](https://x.com/Julia320) |
| **KAITO** | Mr. Schadenfreude / Master | **Naoto Fuuga** (風雅なおと) | [YouTube Channel](https://www.youtube.com/channel/UCqXF2fK0s5l6p_uU_aM7z_Q) • [X (Twitter)](https://x.com/fuganaoto) |
| **MEIKO** | Mortician (Undertaker) | **Meiko Haigo** (拝郷メイコ) | [YouTube Channel](https://www.youtube.com/channel/UC0U0g0i9bC5w2j8vX7lqZrg) • [X (Twitter)](https://x.com/meikohaigo) |
| **GUMI** (Megpoid) | Villager / Seeker | **Megumi Nakajima** (中島愛) | [YouTube Channel](https://www.youtube.com/channel/UC81h_6iVvYy-u6QG7O_vUbw) • [X (Twitter)](https://x.com/mamegu_staff) |
| **Camui Gackpo** (神威がくぽ) | Noble / Madman | **GACKT** | [YouTube Channel](https://www.youtube.com/channel/UCNGBRcUwu5IyvFsIr2P-q3w) • [X (Twitter)](https://x.com/GACKT) |

> *All original characters, lore, voice assets, art concepts, and musical themes belong to their respective creators and copyright owners (Crypton Future Media, Internet Co., Ltd., Yamaha). This project is open-source and created strictly for non-commercial community entertainment and artistic appreciation.*

---

## 📖 Story & Game Concept

In an isolated village shrouded in perpetual mist, **Mr. Schadenfreude**—the sinister puppet master—orchestrates nighttime assassinations from behind the scenes. Each night, he secretly pulls the strings of an unwitting **Puppet** chosen among the villagers.

As dawn breaks, the villagers must analyze **Forensic Autopsy Reports**, listen to the whispers of **Sacred Tarot Prophecies**, and debate during the trial to lynch the puppet and uncover the mastermind before the entire town is consumed by darkness.

---

## ✨ Key Features

- ⚡ **Real-Time Multiplayer:** Instant room synchronization, live lobbies, and synchronized countdown timers powered by **Socket.IO**.
- 🎭 **Dual Game Modes:**
  - **Classic Puppet Master:** Mr. Schadenfreude's identity is publicly known, commanding a secret puppet from the front.
  - **Secret Killer:** Mr. Schadenfreude hides among ordinary villagers—no one knows who the killer is.
- 🕯️ **Chaos Score & Backup Puppet:** When the village wrongly executes innocent citizens (2/2 Chaos), Mr. Schadenfreude earns the right to choose a replacement puppet!
- ⚰️ **Undertaker Autopsy Ledger:** The Mortician extracts forensic evidence from corpses (fabric traces, seating proximity, suspect pairs) and can stake out living suspects.
- 🃏 **Sacred Tarot Prophecies:** The Priest senses soul movements in the dark with a 1-night cooldown. Passing on a night preserves and carries over the charge to the next round.
- ⚔️ **Knight's Aegis & Challenge:** Protect an innocent villager each night or stake your blade to challenge the shadow directly.
- 🤖 **Smart Bot System:** Autonomous AI bots that vote, use night abilities, and mimic real player behavior to fill empty seats.
- 🔊 **Synthesized Gothic Audio:** Dynamic web-synthesizer engine providing church bells, Tarot chimes, whisper alerts, and tension soundscapes.
- 📱 **Fully Responsive UI:** Atmospheric gothic dark mode optimized for desktop, tablets, and mobile devices.

---

## 🎭 Roles & Abilities

| Role | Team | Night Ability & Lore |
| :--- | :---: | :--- |
| **🎩 Mr. Schadenfreude** | **Evil** | Secretly commands the Puppet each night to execute villagers. Can plant fabricated evidence (necklaces) to frame innocents. |
| **🪆 Puppet (Kukla)** | **Evil** | Retains original role abilities while executing night kill orders for their master. Appears innocent to the village. |
| **⚰️ Mortician (Undertaker)** | **Village** | Gathers forensic clues from victims (fabric, positioning) or conducts surveillance on living players to uncover shadow auras. |
| **🕯️ Priest (Rahibe)** | **Village** | Draws Sacred Tarot cards (1-night cooldown, carry-over enabled) to divine whether a suspect was active in the dark. |
| **⚔️ Knight (Şövalye)** | **Village** | Shields one living player per night from attacks, or challenges the shadow up to 2 times per game. |
| **🃏 Madman** | **Village** | An eccentric villager whose unpredictable intuition and chaotic murmurs can either save or mislead the town. |
| **🌾 Villager** | **Village** | Participates in daytime debates, analyzes clues, and votes during the trial to lynch suspects. |

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v16.0.0 or higher)
- npm or yarn

### Installation

1. **Clone the repository:**
```bash
git clone https://github.com/YOUR_USERNAME/mr-schadenfreude.git
cd mr-schadenfreude
```

2. **Install dependencies:**
```bash
npm install
```

3. **Start the development server:**
```bash
npm run dev
```
*(or `npm start` for production mode)*

4. **Open in browser:**
```
http://localhost:3000
```

---

## ☁️ Deployment (Render.com)

This application is ready for instant 1-click deployment on **Render Web Services**:

1. Sign in to [Render.com](https://render.com) and click **New + > Web Service**.
2. Connect your GitHub repository.
3. Use the following deployment configuration:
   - **Name:** `mr-schadenfreude` *(or your preferred name)*
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** `Free`
4. Click **Deploy Web Service**. Render will automatically launch your server within minutes!

---

## 🌐 Multilingual Support (i18n)

Switch between 6 supported languages in real time:
- 🇬🇧 **English** (`en`)
- 🇹🇷 **Türkçe** (`tr`)
- 🇯🇵 **日本語** (`ja`)
- 🇩🇪 **Deutsch** (`de`)
- 🇪🇸 **Español** (`es`)
- 🇫🇷 **Français** (`fr`)

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express, Socket.IO
- **Frontend:** Vanilla JavaScript (ES6+), Semantic HTML5, CSS3 Custom Properties (Gothic Design System)
- **Audio Engine:** Web Audio API & Synthesizer Sound Engine
- **Visuals:** HTML5 Canvas Ambient Particle Engine

---

## 📄 License

Distributed under the [MIT License](LICENSE).
