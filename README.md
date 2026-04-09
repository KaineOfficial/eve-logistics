````markdown
# Panel Project

Panel Project est un centre d'administration et d'informations pour les missions de JumpFreighter (JF).  
Il permet de suivre les commandes internes en cours et prépare une partie publique pour plus tard, façon Redfrog.  
Lien du panel public : [https://panel.tslc.ovh/](https://panel.tslc.ovh/)

## Fonctionnalités

- Connexion via EVE Online OAuth
- Dashboard des personnages avec informations de corporation et alliance
- Données avancées : wallet, skills, assets, contacts, notifications, contrats
- Version de l'application affichée dans le footer
- Interface stylée avec CSS centralisé

## Installation

1. Cloner le dépôt :
```bash
git clone https://github.com/KaineOfficial/eve-app /var/www/eve-app
cd /var/www/eve-app
````

2. Installer les dépendances :

```bash
npm install
```

3. Créer un fichier `.env` avec vos variables d'environnement :

```env
PORT=3000
SESSION_SECRET=ton_secret
CLIENT_ID=ton_client_id
CLIENT_SECRET=ton_client_secret
CALLBACK_URL=http://ton_domaine/callback
SCOPES=publicData
```

4. Lancer l'application avec PM2 :

```bash
pm2 start server.js --name eve-app
pm2 save
```

5. Déploiement automatique :
   Utiliser le script `deploy.sh` pour récupérer les dernières modifications, installer les dépendances et redémarrer l'application :

```bash
./deploy.sh
```

