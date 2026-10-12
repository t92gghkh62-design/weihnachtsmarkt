# Altstadt-Weihnachtsmarkt

Team-Dashboard: Jeder abgeschlossene Termin baut den 3D-Weihnachtsmarkt weiter auf. Ziel: 300 Termine, danach gibt es für jeden weiteren Termin ein Bonus-Geschenk.

## Was drin ist
- `server.js` – kleiner Node-Server (Seite, Daten, Live-Updates an alle offenen Geräte)
- `index.html` – die Seite mit dem 3D-Markt (darf auch im Ordner `public/` liegen)
- `render.yaml` – Bauplan für Render (Webservice + Datenbank)

## Auf Render veröffentlichen
1. Diesen Ordner in ein GitHub-Repository hochladen.
2. Auf render.com: **New → Blueprint** → Repository wählen → **Apply**.
3. Render legt Webservice und Datenbank an. Nach dem ersten Deploy ist die Seite unter `https://altstadt-weihnachtsmarkt.onrender.com` (oder ähnlich) erreichbar.

## Einstellungen (Environment)
| Name | Bedeutung | Standard |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASS` | Login für die Verwaltung | XY / XY |
| `DATABASE_URL` | Postgres-Datenbank; ohne diese Angabe wird in `data/data.json` gespeichert | – |
| `SESSION_SECRET` | Schlüssel für die Anmeldung | wird erzeugt |

## Lokal starten
```
npm install
npm start
```
Dann http://localhost:3000 öffnen.
