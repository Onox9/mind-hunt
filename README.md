# 🎯 MIND HUNT — version en ligne (multijoueur réel)

Jeu de chasse à l'homme **géolocalisé en temps réel** entre smartphones.
Salon à code 4–5 caractères, tirage secret des rôles, pings GPS, carte réelle **OpenStreetMap**,
et bouton **🧭 Maps** qui ouvre l'application de cartographie du téléphone (Google Maps / Plans).

---

## 🧱 Contenu du dossier

```
mindhunt-online/
├── server.js            # Express + Socket.io : salons, rôles, chronos, pings, captures
├── package.json         # "npm start" → node server.js
├── public/
│   ├── index.html       # interface (mobile-first)
│   ├── styles.css       # thème sombre tactique néon
│   ├── app.js           # client temps réel + carte + GPS
│   └── vendor/          # Leaflet 1.9.4 + socket.io client (aucun CDN externe)
├── Dockerfile · render.yaml · railway.json · fly.toml
└── README.md
```

Le serveur ne dépend d'**aucune clé API** et d'**aucune base de données** : tout l'état des parties
tient en mémoire (un salon disparaît quand tout le monde est parti).

---

## ▶️ 1. Tester tout de suite (aperçu Arena)

Le serveur tourne dans l'aperçu « Mind Hunt Online » : ouvre deux onglets (ou deux téléphones
sur le même réseau via l'URL de prévisualisation), crée un salon dans l'un, rejoins avec le code
dans l'autre. Choisis un **ping de 15 s** pour aller vite.

> ⚠️ L'aperçu Arena est éphémère. Pour jouer **vraiment** avec tes amis, déploie le dossier (section 2) :
> tu obtiendras une URL **HTTPS** stable, indispensable pour le GPS sur iPhone et Android.

## 🚀 2. Mettre en ligne (5 minutes, HTTPS gratuit)

### Option A — Render (le plus simple, gratuit)
1. Pousse ce dossier sur un dépôt GitHub (public ou privé).
2. [render.com](https://render.com) → **New ▸ Web Service** → connecte le dépôt.
3. Render détecte `package.json` : Build `npm install`, Start `npm start` (ou utilise `render.yaml`).
4. Attends 1–2 min → URL du type **`https://mind-hunt.onrender.com`** avec certificat TLS automatique.
5. Partage cette URL + ton code de salon. ✅ Le GPS fonctionnera car le site est en HTTPS.

> Le plan gratuit de Render met le service en veille après 15 min d'inactivité : la première
> connexion prend ~30 s. Pour une soirée de jeu, ouvre le site 1 min avant.

### Option B — Railway
1. [railway.app](https://railway.app) → **New Project ▸ Deploy from GitHub repo**.
2. Sélectionne le dépôt ; Railway lit `railway.json` et lance `node server.js`.
3. **Settings ▸ Networking ▸ Generate Domain** → URL HTTPS automatique.

### Option C — Fly.io (Docker, très proche des joueurs en Europe)
```bash
cd mindhunt-online
fly launch --copy-config --region cdg   # cdg = Paris
fly deploy
```
`fly.toml` force HTTPS et suspend la machine quand personne ne joue.

### Option D — Votre propre VPS (Node + Nginx + Let's Encrypt)
```bash
# sur le serveur
git clone <ton-depot> && cd mindhunt-online && npm install --omit=dev
pm2 start server.js --name mind-hunt
sudo certbot --nginx -d jeu.mondomaine.fr     # HTTPS
```
Nginx : proxy vers `http://127.0.0.1:3000` avec les en-têtes `Upgrade`/`Connection`
(nécessaires à Socket.io WebSocket — ou laisse Socket.io en polling, ça marche aussi).

Sans reverse proxy, tu peux aussi servir l'HTTPS directement :
```bash
HTTPS_KEY=/etc/letsencrypt/live/jeu/privkey.pem \
HTTPS_CERT=/etc/letsencrypt/live/jeu/fullchain.pem \
PORT=443 node server.js
```

## 📱 3. La demande d'autorisation de localisation

Le comportement est volontairement explicite, comme demandé :

| Moment | Ce qui se passe |
|---|---|
| **Rejoindre / créer un salon** | Une modale explique pourquoi la position exacte est nécessaire, puis le navigateur affiche sa demande native. Sur iPhone il faut choisir **« Autoriser pendant l'utilisation »** + **« Position exacte »**. |
| **Lancement de la partie** | L'hôte voit un avertissement listant les joueurs **sans GPS** et peut annuler le lancement. La demande est rejouée si l'autorisation manque. |
| **En jeu** | Un badge `GPS actif ± X m` confirme le partage ; le bouton **📍** dans la barre du haut re-teste/réaffiche la position. La carte se recentre sur toi (bouton **⌖**). |
| **Refus** | Le joueur peut quand même suivre la partie, mais son message d'alerte indique qu'il ne sera **ni localisé ni capturé**. |

La position est envoyée en continu (throttle natif du navigateur, précision haute) et **jamais**
transmise telle quelle aux cachés : seuls les chasseurs reçoivent les positions révélées **au moment du ping**.

## 🗺️ 4. La carte

- **Leaflet + tuiles OpenStreetMap** : rues réelles, zoom, déplacement, noms de quartiers.
- Point bleu pulsant = ta position, avec cercle de précision.
- Chasseurs : les autres chasseurs apparaissent en temps réel (rose).
- Cachés : ils voient les autres cachés (vert) et **aucun chasseur**.
- À chaque ping, les chasseurs voient les cachés apparaître en **rouge**, avec nom, distance et
  précision GPS, dans une fiche listant toutes les cibles.
- Clic sur **🧭 Maps** → itinéraire piéton vers la position exacte de la cible :
  - Android → `geo:` (Google Maps / Plans)
  - iPhone → Apple Plans (`maps.apple.com`)
  - Ordinateur → Google Maps
- Bouton **« Ouvrir la cible la plus proche »** pour choisir automatiquement.

## ⚔ 5. Règles et logique serveur

- L'hôte configure **soit** un nombre fixe de chasseurs, **soit** un effectif total (avec le nombre de
  chasseurs). Le serveur tire les rôles **aléatoirement** (Fisher–Yates) parmi les inscrits.
- Les inscrits non retenus (mode effectif total) sont **spectateurs**.
- **Chrono de ping autoritaire** : c'est le serveur qui déclenche les pings et calcule la fin de partie,
  pas les téléphones → impossible de tricher en modifiant l'horloge locale.
- **Captures vérifiées côté serveur** : distance Haversine ≤ **30 m** entre les deux GPS réels.
- **Anti-triche** : un client ne reçoit jamais la position d'un caché en dehors du ping, et un caché
  ne reçoit jamais la position d'un chasseur.
- **Reprise** : rechargement de page, écran verrouillé ou perte de réseau → reconnexion automatique
  dans la partie en cours (identifiant d'appareil en localStorage).
- Fin de partie : tous les cachés capturés (**chasseurs**) ou chrono écoulé avec au moins un survivant (**cachés**).

## 🔌 6. API temps réel (pour aller plus loin)

| Sens | Événement | Charge utile |
|---|---|---|
| client → serveur | `create` / `join` | `{ name, cid }` / `{ code, name, cid }` |
| client → serveur | `setSettings` | `{ ping, dur, roleMode, hunterCount, totalParticipants }` |
| client → serveur | `start` / `replay` / `kick` | — / — / `{ playerId }` |
| client → serveur | `pos` | `{ lat, lng, acc }` |
| client → serveur | `capture` | `{ targetId }` |
| serveur → client | `room` | état public filtré par joueur |
| serveur → client | `started` | `{ role, settings, startedAt, endsAt, summary }` |
| serveur → client | `ping` | chasseur : `{ targets:[{id,name,lat,lng,acc}] }` · caché : `{ exposed, self }` |
| serveur → client | `positions` | `{ team:[{id,name,lat,lng}] }` (alliés uniquement) |
| serveur → client | `captured` / `gameover` | résultat et classement |

Tout est dans `server.js` (~430 lignes commentées) : facile d'ajouter un mode « zone interdite »,
un score sur plusieurs manches ou une persistance Redis.

## 🔐 7. Vie privée & limites connues

- Aucune donnée n'est stockée : positions uniquement en mémoire, effacées à la fin du salon.
- Pas de compte, pas de cookie publicitaire, pas de tracker.
- Les salons sont **publics par code** : ne partage le code qu'avec ton groupe.
- Une seule instance Node = un seul serveur. Pour plusieurs instances, il faut un adaptateur
  Redis pour Socket.io (sinon les joueurs de deux instances ne se voient pas).
- OSM impose une attribution visible (déjà présente) et un usage raisonnable des tuiles : pour
  un usage intensif ou commercial, prends un fournisseur de tuiles (MapTiler, Stadia, Thunderforest).

## 🧪 8. Tests rapides

- `curl https://TON-URL/health` → `{"ok":true,...}`
- Deux navigateurs, ping 15 s : un ping doit révéler le caché au chasseur en ~15 s.
- Vérifie le refus GPS (icône cadenas du navigateur → Localisation → Bloquer) : le jeu signale
  le joueur sans position.
